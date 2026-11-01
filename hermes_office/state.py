from __future__ import annotations

import json
import hashlib
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

COLORS = ["#6a55c9", "#3f6fd1", "#2f9a6d", "#c2417a", "#d9772f"]
ACTIVE_WINDOW_SECONDS = 90
FREELANCER_NAMES = ["Ayu", "Fajar", "Maya", "Yoga", "Reza", "Sinta", "Eko", "Tania"]
TOOL_DISPLAY = {
    "terminal": "Bash",
    "execute_code": "Bash",
    "read_file": "Read",
    "search_files": "Grep",
    "web_search": "WebSearch",
    "web_extract": "WebFetch",
    "browser_exec": "WebFetch",
    "write_file": "Write",
    "patch": "Edit",
    "delegate_task": "Agent",
    "clarify": "AskUserQuestion",
    "todo_list": "TodoWrite",
}

def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat().replace("+00:00", "Z")


def _profile_home(hermes_home: Path, profile: str) -> Path:
    return hermes_home if profile == "default" else hermes_home / "profiles" / profile


def _readonly_connection(db: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
    con.execute("PRAGMA query_only=ON")
    con.row_factory = sqlite3.Row
    return con


def _latest_session(home: Path) -> dict[str, Any] | None:
    db = home / "state.db"
    if not db.is_file():
        return None
    con = _readonly_connection(db)
    base_query = """
        SELECT id, model, started_at, ended_at, last_activity_at,
               message_count, tool_call_count, input_tokens, output_tokens,
               tool_names
          FROM sessions
    """
    try:
        try:
            row = con.execute(
                base_query
                + """
                 WHERE COALESCE(archived, 0) = 0
                 ORDER BY COALESCE(last_activity_at, started_at) DESC
                 LIMIT 1
                """
            ).fetchone()
        except sqlite3.OperationalError:
            row = con.execute(
                base_query
                + """
                 ORDER BY COALESCE(last_activity_at, started_at) DESC
                 LIMIT 1
                """
            ).fetchone()
    except sqlite3.OperationalError:
        con.close()
        return None
    if not row:
        con.close()
        return None
    session = dict(row)
    try:
        try:
            tool_row = con.execute(
                """
                SELECT tool_name
                  FROM messages
                 WHERE session_id = ? AND tool_name IS NOT NULL AND tool_name != ''
                 ORDER BY timestamp DESC, id DESC
                 LIMIT 1
                """,
                (session["id"],),
            ).fetchone()
            session["last_tool_name"] = tool_row[0] if tool_row else None
        except sqlite3.OperationalError:
            session["last_tool_name"] = None
    finally:
        con.close()
    return session


def _delegations(home: Path) -> list[dict[str, Any]]:
    db = home / "state.db"
    if not db.is_file():
        return []
    con = _readonly_connection(db)
    try:
        rows = con.execute(
            """
            SELECT delegation_id, state, dispatched_at, completed_at, updated_at
              FROM async_delegations
             ORDER BY updated_at DESC
             LIMIT 40
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()
    return [dict(row) for row in rows]


def _freelancer_name(delegation_id: str) -> str:
    digest = hashlib.sha256(delegation_id.encode("utf-8")).digest()
    return FREELANCER_NAMES[int.from_bytes(digest[:2], "big") % len(FREELANCER_NAMES)]


def _freelancers(home: Path, now: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    freelancers = []
    history = []
    active_states = {"pending", "dispatched", "running", "in_progress"}
    for row in _delegations(home):
        name = _freelancer_name(row["delegation_id"])
        started = float(row.get("dispatched_at") or row.get("updated_at") or now)
        ended_value = row.get("completed_at")
        ended = float(ended_value) if ended_value else None
        status = str(row.get("state") or "pending")
        is_active = status in active_states
        run_status = "bekerja" if is_active else "selesai" if status == "completed" else "terhenti"
        task_label = "Delegasi aktif" if is_active else "Delegasi selesai" if status == "completed" else "Delegasi terhenti"
        run = {
            "id": row["delegation_id"],
            "agent_type": "freelancer",
            "task": task_label,
            "status": run_status,
            "reason": None if status != "error" else "error",
            "segment": 1,
            "started": _iso(started),
            "ended": _iso(ended) if ended else None,
            "updated": _iso(float(row.get("updated_at") or started)),
            "last": [{
                "t": _iso(float(row.get("updated_at") or started)),
                "who": f"fl-{row['delegation_id']}",
                "name": f"Freelancer · {name}",
                "color": "#0f8fa3",
                "kind": "tool",
                "text": task_label,
                "tool": "Agent",
            }],
            "files": [],
            "tools": 0,
            "tokens": 0,
        }
        history.append({
            "id": row["delegation_id"], "who": f"fl-{row['delegation_id']}",
            "name": name, "label": f"Freelancer · {name}", "color": "#0f8fa3",
            "kind": "freelancer", "agent_type": "freelancer", "task": task_label,
            "status": run_status, "started": _iso(started),
            "ended": _iso(ended) if ended else None, "tools": 0,
        })
        if is_active:
            freelancers.append({
                "key": f"fl-{row['delegation_id']}", "name": name,
                "label": f"Freelancer · {name}", "color": "#0f8fa3",
                "kind": "freelancer", "slot": len(freelancers),
                "desk": len(freelancers) if len(freelancers) < 4 else None,
                "state": "bekerja", "run": run,
            })
    return freelancers, history


def _activity(session: dict[str, Any], now: float) -> tuple[str, str | None]:
    last = session.get("last_activity_at") or session.get("started_at") or 0
    if session.get("ended_at") is None and now - float(last) <= ACTIVE_WINDOW_SECONDS:
        return "bekerja", "alat" if int(session.get("tool_call_count") or 0) else "aktif"
    if session.get("ended_at") is not None and now - float(last) <= 60:
        return "selesai", None
    return "santai", None


def _event(session: dict[str, Any], name: str, color: str) -> dict[str, Any]:
    timestamp = float(session.get("last_activity_at") or session.get("started_at") or 0)
    tool_name = session.get("last_tool_name")
    if not tool_name:
        try:
            tools = json.loads(session.get("tool_names") or "[]")
        except (TypeError, json.JSONDecodeError):
            tools = []
        tool_name = tools[-1] if isinstance(tools, list) and tools else None
    tool = TOOL_DISPLAY.get(tool_name, tool_name)
    return {
        "t": _iso(timestamp),
        "who": name.lower().replace(" ", "-"),
        "name": name,
        "color": color,
        "kind": "tool" if tool else "text",
        "text": f"Menggunakan {tool}" if tool else "Aktivitas Hermes",
        "tool": tool,
    }


def _run(session: dict[str, Any], profile: str, role: str, now: float) -> dict[str, Any]:
    state, _ = _activity(session, now)
    updated = float(session.get("last_activity_at") or session.get("started_at") or now)
    ended = session.get("ended_at")
    color = COLORS[0]
    event = _event(session, profile, color)
    return {
        "id": session["id"],
        "agent_type": role,
        "task": f"Sesi {role}",
        "status": state,
        "reason": None,
        "segment": 1,
        "started": _iso(float(session.get("started_at") or updated)),
        "ended": _iso(float(ended)) if ended else None,
        "updated": _iso(updated),
        "last": [event],
        "files": [],
        "tools": int(session.get("tool_call_count") or 0),
        "tokens": int(session.get("input_tokens") or 0) + int(session.get("output_tokens") or 0),
    }


def build_state(
    *,
    hermes_home: Path,
    roster: list[dict[str, str]],
    now: float,
    project: str = "Kantor Internal Kanezza",
    spare_desks: int = 4,
) -> dict[str, Any]:
    leader = roster[0]
    leader_session = _latest_session(_profile_home(hermes_home, leader["profile"]))
    if leader_session:
        leader_state, activity = _activity(leader_session, now)
        event = _event(leader_session, leader["name"], COLORS[0])
        ketua = {
            "key": "ketua",
            "name": leader["name"],
            "label": leader["name"],
            "role": leader["role"],
            "kind": "ketua",
            "color": COLORS[0],
            "state": leader_state,
            "activity": activity,
            "session": leader_session["id"][:8],
            "updated": event["t"],
            "last": [event],
            "tools": int(leader_session.get("tool_call_count") or 0),
            "tokens": int(leader_session.get("input_tokens") or 0) + int(leader_session.get("output_tokens") or 0),
            "waiting_on": 0,
            "other_sessions": 0,
            "sessions": 1,
            "todos": None,
        }
    else:
        ketua = {
            "key": "ketua", "name": leader["name"], "label": leader["name"],
            "role": leader["role"], "kind": "ketua", "color": COLORS[0],
            "state": "santai", "activity": None, "session": None, "updated": None,
            "last": [], "tools": 0, "tokens": 0, "waiting_on": 0,
            "other_sessions": 0, "sessions": 0, "todos": None,
        }

    team = []
    active = 1 if ketua["state"] == "bekerja" else 0
    for index, member in enumerate(roster[1:]):
        session = _latest_session(_profile_home(hermes_home, member["profile"]))
        state = "santai"
        run = None
        if session:
            state, _ = _activity(session, now)
            run = _run(session, member["name"], member["role"], now)
            if state == "bekerja":
                active += 1
        team.append({
            "key": f"tim-{index}",
            "name": member["name"],
            "label": member["name"],
            "role": member["role"],
            "profile": member["profile"],
            "color": COLORS[index + 1],
            "kind": "tim",
            "slot": index,
            "desk": index,
            "state": state,
            "run": run,
        })

    freelancers, history = _freelancers(hermes_home, now)
    active += len(freelancers)
    feed = ketua["last"][:]
    for freelancer in freelancers:
        feed.extend(freelancer["run"]["last"])
    feed.sort(key=lambda event: event["t"], reverse=True)
    return {
        "app": "hermes-office",
        "version": "0.1.0",
        "now": _iso(now),
        "project": project,
        "names": "|".join(item["name"] for item in roster),
        "transcripts": True,
        "ketua": ketua,
        "team": team,
        "freelancers": freelancers,
        "feed": feed,
        "runs": history,
        "stats": {"active": active, "freelancers": len(freelancers), "total": len(history), "recent_starts": [item["started"] for item in history], "sessions_active": active},
        "spare_desks": spare_desks,
        "public_url": None,
    }
