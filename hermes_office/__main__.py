from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from .server import run_server
from .state import build_state


def validate_roster(roster):
    expected_profiles = ["default", "product", "engineer", "qa", "ops"]
    if not isinstance(roster, list) or len(roster) != len(expected_profiles):
        raise ValueError("roster must contain exactly five permanent profiles")
    if [member.get("profile") for member in roster if isinstance(member, dict)] != expected_profiles:
        raise ValueError("roster profiles must be ordered as default, product, engineer, qa, ops")
    for member in roster:
        if member.get("gender") not in {"male", "female"}:
            raise ValueError("every roster member must declare gender as male or female")
    return roster


def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes Office web dashboard")
    parser.add_argument("--config", type=Path, default=Path("config.json"))
    parser.add_argument("--bind")
    parser.add_argument("--port", type=int)
    parser.add_argument("--hermes-home", type=Path)
    parser.add_argument("--public-dir", type=Path)
    args = parser.parse_args()

    config_path = args.config.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    project_root = config_path.parent
    hermes_home = (args.hermes_home or Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))).resolve()
    public_dir = (args.public_dir or project_root / "public").resolve()
    bind = args.bind or config.get("bind", "127.0.0.1")
    port = args.port or int(config.get("port", 8788))
    roster = validate_roster(config["roster"])

    page_config = {
        "title": config["title"],
        "ketua": roster[0]["name"],
        "team": [member["name"] for member in roster[1:]],
        "roles": [member["role"] for member in roster],
        "genders": [member["gender"] for member in roster],
        "colors": config["colors"],
        "spare_desks": int(config.get("spare_desks", 4)),
    }

    def state_provider():
        return build_state(
            hermes_home=hermes_home,
            roster=roster,
            now=time.time(),
            project=config["title"],
            spare_desks=int(config.get("spare_desks", 4)),
        )

    run_server(
        bind=bind,
        port=port,
        public_dir=public_dir,
        state_provider=state_provider,
        page_config=page_config,
    )


if __name__ == "__main__":
    main()
