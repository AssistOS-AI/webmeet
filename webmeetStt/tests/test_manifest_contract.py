import json
import os
import pathlib
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ManifestContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest_path = pathlib.Path(__file__).resolve().parents[1] / "manifest.json"
        cls.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def test_private_bridge_contract(self):
        self.assertEqual(
            self.manifest.get("network"),
            {
                "mode": "bridge",
                "attachments": [{"name": "webmeet", "primary": True}],
            },
        )

    def test_stt_has_no_browser_service_or_outer_publication_field(self):
        self.assertNotIn("httpServices", self.manifest)
        serialized = json.dumps(self.manifest)
        self.assertNotIn("additionalServerPort", serialized)
        self.assertNotIn("edgePorts", serialized)
        self.assertNotIn("network.aliases", serialized)

    def test_readiness_uses_an_in_container_health_probe_without_a_port_mapping(self):
        self.assertEqual(
            self.manifest.get("health", {}).get("readiness", {}).get("script"),
            "healthcheck.sh",
        )
        for profile in self.manifest.get("profiles", {}).values():
            self.assertNotIn("ports", profile)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == "/healthz" else 404)
                self.end_headers()

            def log_message(self, _format, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = {
                **os.environ,
                "WEBMEET_STT_PORT": str(server.server_address[1]),
            }
            script = pathlib.Path(__file__).resolve().parents[1] / "healthcheck.sh"
            subprocess.run(["sh", str(script)], env=env, check=True, timeout=5)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
