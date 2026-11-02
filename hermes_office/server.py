from __future__ import annotations

import argparse
import html
import ipaddress
import json
import mimetypes
import os
import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

SECURITY_HEADERS = {
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def validate_bind(bind: str) -> str:
    try:
        address = ipaddress.ip_address(bind)
    except ValueError as error:
        raise ValueError("Hermes Office bind must be a loopback IP address") from error
    if not address.is_loopback:
        raise ValueError("Hermes Office refuses non-loopback bind addresses")
    return bind


def _content_security_policy(nonce: str | None = None) -> str:
    script_src = "script-src 'self'" + (f" 'nonce-{nonce}'" if nonce else "")
    return (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        f"{script_src}; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'none'"
    )


def create_handler(
    *,
    public_dir: Path,
    state_provider: Callable[[], dict[str, Any]],
    page_config: dict[str, Any] | None = None,
):
    root = public_dir.resolve()
    config = page_config or {}

    class HermesOfficeHandler(BaseHTTPRequestHandler):
        def version_string(self) -> str:
            return "HermesOffice"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _headers(
            self,
            status: int,
            content_type: str,
            length: int | None = None,
            *,
            no_store: bool = False,
            csp_nonce: str | None = None,
        ) -> None:
            self.send_response(status)
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.send_header("Content-Security-Policy", _content_security_policy(csp_nonce))
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "private, no-store" if no_store else "public, max-age=300")
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.end_headers()

        def _send(
            self,
            body: bytes,
            content_type: str,
            *,
            status: int = HTTPStatus.OK,
            no_store: bool = False,
            csp_nonce: str | None = None,
        ) -> None:
            self._headers(status, content_type, len(body), no_store=no_store, csp_nonce=csp_nonce)
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, payload: dict[str, Any], *, status: int = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self._send(body, "application/json; charset=utf-8", status=status, no_store=True)

        def _serve_file(self, relative: str) -> None:
            candidate = (root / relative).resolve()
            if root not in candidate.parents and candidate != root:
                self._json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)
                return
            if not candidate.is_file():
                self._json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)
                return
            body = candidate.read_bytes()
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            if candidate.name == "index.html":
                text = body.decode("utf-8")
                title = html.escape(str(config.get("title", "Kantor Internal Kanezza")), quote=True)
                nonce = secrets.token_urlsafe(24)
                config_script = (
                    f'<script nonce="{nonce}">window.KANTOR='
                    + json.dumps(config, ensure_ascii=False).replace("</", "<\\/")
                    + ";</script>"
                )
                text = text.replace('<script type="importmap">', f'<script type="importmap" nonce="{nonce}">')
                text = text.replace("{{TITLE}}", title).replace("{{CONFIG_SCRIPT}}", config_script)
                body = text.encode("utf-8")
                content_type = "text/html; charset=utf-8"
                self._send(body, content_type, no_store=True, csp_nonce=nonce)
                return
            self._send(body, content_type)

        def do_HEAD(self) -> None:
            self.do_GET()

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path in {"/", "/kerja", "/kerja/"}:
                self._serve_file("index.html")
                return
            if path == "/kerja/api/state":
                self._json(state_provider())
                return
            if path == "/kerja/api/ping":
                self._json({"app": "hermes-office", "status": "ok"})
                return
            if path.startswith("/kerja/assets/"):
                self._serve_file(path.removeprefix("/kerja/"))
                return
            self._json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:
            self._json({"error": "method_not_allowed"}, status=HTTPStatus.METHOD_NOT_ALLOWED)

        do_PUT = do_POST
        do_PATCH = do_POST
        do_DELETE = do_POST

    return HermesOfficeHandler


def run_server(
    *,
    bind: str,
    port: int,
    public_dir: Path,
    state_provider: Callable[[], dict[str, Any]],
    page_config: dict[str, Any],
) -> None:
    bind = validate_bind(bind)
    handler = create_handler(public_dir=public_dir, state_provider=state_provider, page_config=page_config)
    server = ThreadingHTTPServer((bind, port), handler)
    print(f"Hermes Office listening on http://{bind}:{port}/kerja", flush=True)
    server.serve_forever()
