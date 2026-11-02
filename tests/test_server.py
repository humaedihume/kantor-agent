import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from hermes_office.server import create_handler, validate_bind


class ServerTests(unittest.TestCase):
    def test_serves_state_json_with_security_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            public.mkdir()
            (public / "index.html").write_text("<h1>Office</h1>", encoding="utf-8")

            def state_provider():
                return {"app": "hermes-office", "team": []}

            handler = create_handler(public_dir=public, state_provider=state_provider)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/kerja/api/state"
                with urllib.request.urlopen(url) as response:
                    payload = json.load(response)
                    headers = response.headers
                self.assertEqual(payload["app"], "hermes-office")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
                self.assertEqual(headers["Cache-Control"], "private, no-store")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_generated_html_escapes_title_uses_nonce_and_is_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            public = Path(tmp) / "public"
            public.mkdir()
            (public / "index.html").write_text(
                "<title>{{TITLE}}</title><script type=\"importmap\">{}</script>{{CONFIG_SCRIPT}}",
                encoding="utf-8",
            )
            handler = create_handler(
                public_dir=public,
                state_provider=lambda: {"app": "hermes-office"},
                page_config={"title": "</title><script>PRIVATE_XSS</script>"},
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/kerja"
                with urllib.request.urlopen(url) as response:
                    body = response.read().decode("utf-8")
                    headers = response.headers
                self.assertNotIn("<script>PRIVATE_XSS</script>", body)
                self.assertIn("&lt;script&gt;PRIVATE_XSS&lt;/script&gt;", body)
                self.assertEqual(headers["Cache-Control"], "private, no-store")
                script_policy = headers["Content-Security-Policy"].split("script-src", 1)[1].split(";", 1)[0]
                self.assertNotIn("'unsafe-inline'", script_policy)
                self.assertIn("'nonce-", script_policy)
                self.assertNotIn("Python/", headers["Server"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_rejects_non_loopback_bind_addresses(self):
        self.assertEqual(validate_bind("127.0.0.1"), "127.0.0.1")
        self.assertEqual(validate_bind("::1"), "::1")
        for unsafe in ("0.0.0.0", "::", "192.0.2.10", "localhost"):
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(ValueError):
                    validate_bind(unsafe)


if __name__ == "__main__":
    unittest.main()
