import json
import subprocess
import unittest
from pathlib import Path

from hermes_office.__main__ import validate_roster


ROOT = Path(__file__).parents[1]


class GenderContractTests(unittest.TestCase):
    def test_accepts_only_explicit_male_or_female_gender(self):
        roster = [
            {"profile": "default", "name": "Om Fit", "role": "Ketua", "gender": "male"},
            {"profile": "product", "name": "Raka", "role": "Product", "gender": "male"},
            {"profile": "engineer", "name": "Dimas", "role": "Engineer", "gender": "male"},
            {"profile": "qa", "name": "Naya", "role": "QA", "gender": "female"},
            {"profile": "ops", "name": "Bayu", "role": "Ops", "gender": "male"},
        ]

        self.assertEqual(validate_roster(roster), roster)

        for invalid in ("neutral", "unknown", "", None):
            candidate = [dict(roster[0], gender=invalid)]
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    validate_roster(candidate)

        with self.assertRaises(ValueError):
            validate_roster(roster[:2])
        with self.assertRaises(ValueError):
            validate_roster([roster[1], roster[0], *roster[2:]])

    def test_deployed_roster_declares_gender_for_every_permanent_character(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        genders = {member["name"]: member["gender"] for member in config["roster"]}

        self.assertEqual(
            genders,
            {
                "Om Fit": "male",
                "Raka": "male",
                "Dimas": "male",
                "Naya": "female",
                "Bayu": "male",
            },
        )

    def test_gender_changes_hair_and_outfit_and_maps_every_freelancer(self):
        script = """
          import { genderedLook, freelancerGender } from './public/assets/character-gender.js';
          const base = { shirt: '#123456', hair: '#111111' };
          const male = genderedLook(base, 'male', 7);
          const female = genderedLook(base, 'female', 7);
          if (male.gender !== 'male' || female.gender !== 'female') process.exit(10);
          if (male.hairStyle === female.hairStyle) process.exit(11);
          if (male.outfit === female.outfit) process.exit(12);
          const expected = { Ayu:'female', Fajar:'male', Maya:'female', Yoga:'male', Reza:'male', Sinta:'female', Eko:'male', Tania:'female' };
          for (const [name, gender] of Object.entries(expected)) {
            if (freelancerGender(name) !== gender) process.exit(13);
          }
        """
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
