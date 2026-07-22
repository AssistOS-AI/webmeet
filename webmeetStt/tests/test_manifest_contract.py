import json
import pathlib
import unittest


class ManifestContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest_path = pathlib.Path(__file__).resolve().parents[1] / "manifest.json"
        cls.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def test_v5_private_bridge_contract(self):
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


if __name__ == "__main__":
    unittest.main()
