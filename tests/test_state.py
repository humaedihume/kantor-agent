import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from hermes_office.state import _readonly_connection, build_state


ROSTER = [
    {"profile": "default", "name": "Om Fit", "role": "Ketua"},
    {"profile": "product", "name": "Raka", "role": "Product Manager"},
    {"profile": "engineer", "name": "Dimas", "role": "Software Engineer"},
    {"profile": "qa", "name": "Naya", "role": "QA & Security"},
    {"profile": "ops", "name": "Bayu", "role": "DevOps"},
]


def make_state_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            profile_name TEXT,
            model TEXT,
            started_at REAL,
            ended_at REAL,
            last_activity_at REAL,
            last_activity_description TEXT,
            message_count INTEGER,
            tool_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            tool_names TEXT,
            title TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            tool_name TEXT,
            timestamp REAL,
            display_kind TEXT,
            display_metadata TEXT
        );
        CREATE TABLE async_delegations (
            delegation_id TEXT PRIMARY KEY,
            state TEXT,
            dispatched_at REAL,
            completed_at REAL,
            updated_at REAL,
            task_json TEXT,
            event_json TEXT,
            result_json TEXT
        );
        """
    )
    con.commit()
    con.close()


class BuildStateTests(unittest.TestCase):
    def test_maps_latest_default_session_to_om_fit_and_keeps_specialists_at_fixed_desks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "state.db"
            make_state_db(db)
            con = sqlite3.connect(db)
            con.execute(
                """INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "session-1",
                    "default",
                    "gpt-5.6-sol",
                    1_000.0,
                    None,
                    1_100.0,
                    "Menjalankan terminal",
                    4,
                    2,
                    100,
                    50,
                    json.dumps(["terminal", "read_file"]),
                    "Kantor internal",
                ),
            )
            con.commit()
            con.close()

            state = build_state(
                hermes_home=root,
                roster=ROSTER,
                now=1_120.0,
            )

            self.assertEqual(state["ketua"]["name"], "Om Fit")
            self.assertEqual(state["ketua"]["state"], "bekerja")
            self.assertEqual(state["ketua"]["activity"], "alat")
            self.assertEqual([member["name"] for member in state["team"]], ["Raka", "Dimas", "Naya", "Bayu"])
            self.assertTrue(all(member["state"] == "santai" for member in state["team"]))
            self.assertEqual(state["stats"]["active"], 1)

    def test_omits_private_session_and_delegation_text_from_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "state.db"
            make_state_db(db)
            con = sqlite3.connect(db)
            con.execute(
                """INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "session-secret",
                    "default",
                    "gpt-5.6-sol",
                    1_000.0,
                    None,
                    1_100.0,
                    "PRIVATE_ACTIVITY admin@example.com token=super-secret-value",
                    2,
                    1,
                    10,
                    5,
                    json.dumps(["browser_exec"]),
                    "PRIVATE_SESSION_TITLE",
                ),
            )
            con.execute(
                """INSERT INTO async_delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "delegation-private",
                    "running",
                    1_000.0,
                    None,
                    1_100.0,
                    json.dumps({"goal": "PRIVATE_DELEGATION_GOAL", "role": "secret-role"}),
                    json.dumps({"goal": "PRIVATE_EVENT_GOAL"}),
                    None,
                ),
            )
            con.commit()
            con.close()

            state = build_state(hermes_home=root, roster=ROSTER, now=1_120.0)
            serialized = json.dumps(state)

            for private_value in (
                "PRIVATE_ACTIVITY",
                "admin@example.com",
                "super-secret-value",
                "PRIVATE_SESSION_TITLE",
                "PRIVATE_DELEGATION_GOAL",
                "PRIVATE_EVENT_GOAL",
                "secret-role",
            ):
                self.assertNotIn(private_value, serialized)
            self.assertEqual(state["ketua"]["last"][0]["text"], "Menggunakan WebFetch")
            self.assertEqual(state["freelancers"][0]["run"]["task"], "Delegasi aktif")

    def test_maps_running_delegation_to_deterministic_freelancer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "state.db"
            make_state_db(db)
            con = sqlite3.connect(db)
            con.execute(
                """INSERT INTO async_delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "delegation-abc",
                    "running",
                    1_000.0,
                    None,
                    1_100.0,
                    json.dumps({"goal": "Audit deployment staging", "role": "qa"}),
                    json.dumps({"status": "running", "goal": "Audit deployment staging"}),
                    None,
                ),
            )
            con.commit()
            con.close()

            first = build_state(hermes_home=root, roster=ROSTER, now=1_120.0)
            second = build_state(hermes_home=root, roster=ROSTER, now=1_121.0)

            self.assertEqual(len(first["freelancers"]), 1)
            freelancer = first["freelancers"][0]
            self.assertEqual(freelancer["name"], second["freelancers"][0]["name"])
            self.assertEqual(freelancer["state"], "bekerja")
            self.assertEqual(freelancer["run"]["task"], "Delegasi aktif")
            self.assertEqual(first["stats"]["freelancers"], 1)
            self.assertEqual(first["stats"]["active"], 1)

    def test_maps_hermes_tool_names_to_office_animation_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "state.db"
            make_state_db(db)
            con = sqlite3.connect(db)
            con.execute(
                """INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "session-tools",
                    "default",
                    "gpt-5.6-sol",
                    1_000.0,
                    None,
                    1_100.0,
                    "Membaca konfigurasi",
                    3,
                    2,
                    30,
                    10,
                    json.dumps(["terminal", "read_file"]),
                    "Inspect config",
                ),
            )
            con.commit()
            con.close()

            state = build_state(hermes_home=root, roster=ROSTER, now=1_120.0)

            self.assertEqual(state["ketua"]["last"][0]["tool"], "Read")

    def test_uses_latest_message_tool_when_session_tool_names_is_opaque(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / "state.db"
            make_state_db(db)
            con = sqlite3.connect(db)
            con.execute(
                """INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "session-opaque",
                    "default",
                    "gpt-5.6-sol",
                    1_000.0,
                    None,
                    1_100.0,
                    "Membaca file",
                    3,
                    1,
                    10,
                    5,
                    "28549bbe7310b900a0688891455b0bb16da9b3a8ffca144a74910018114ac44d",
                    "Inspect",
                ),
            )
            con.execute(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1, "session-opaque", "tool", "read_file", 1_100.0, "tool", None),
            )
            con.commit()
            con.close()

            state = build_state(hermes_home=root, roster=ROSTER, now=1_120.0)

            self.assertEqual(state["ketua"]["last"][0]["tool"], "Read")

    def test_uses_configured_project_and_spare_desks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_state_db(root / "state.db")

            state = build_state(
                hermes_home=root,
                roster=ROSTER,
                now=1_120.0,
                project="Kantor Uji",
                spare_desks=7,
            )

            self.assertEqual(state["project"], "Kantor Uji")
            self.assertEqual(state["spare_desks"], 7)

    def test_readonly_connection_rejects_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "state.db"
            make_state_db(db)

            con = _readonly_connection(db)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    con.execute("CREATE TABLE forbidden (id INTEGER)")
            finally:
                con.close()


if __name__ == "__main__":
    unittest.main()
