import unittest
from pathlib import Path


class FrontendContractTests(unittest.TestCase):
    def test_frontend_accepts_hermes_office_api_identity(self):
        source = (Path(__file__).parents[1] / "public" / "assets" / "kantor.js").read_text(encoding="utf-8")
        self.assertIn("d.app !== 'hermes-office'", source)


if __name__ == "__main__":
    unittest.main()
