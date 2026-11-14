"""The onboard-repo skill's gitleaks pins equal the engine's (ADR 0020, F-003 AC-24, H-0147).

Both download the same reviewed release (F-007 Security and Testability Review component review 5), so a
pin bumped in one place and not the other fails here.
"""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, "engine", "src", "constants.ts")
SKILL_PINS = os.path.join(ROOT, "plugins", "software-factory", "skills", "onboard-repo", "scripts", "gitleaks-pins.json")
SKILL_REQS = os.path.join(ROOT, "plugins", "software-factory", "skills", "onboard-repo", "scripts", "requirements-tools.txt")
CI_FILES = [
    os.path.join(ROOT, ".github", "workflows", "workflow-audit.yml"),
    os.path.join(ROOT, "plugins", "software-factory", "skills", "onboard-repo", "templates", "ci-workflow.yml"),
]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class GitleaksPins(unittest.TestCase):
    def test_version_and_binary_hashes_match_the_engine(self):
        src = read(ENGINE)
        version = re.search(r'GITLEAKS_VERSION = "([^"]+)"', src).group(1)
        block = src.split("GITLEAKS_BINARY_SHA256")[1].split("};")[0]
        engine = dict(re.findall(r'"([a-z0-9]+-[a-z0-9]+)": "([0-9a-f]{64})"', block))
        pins = json.loads(read(SKILL_PINS))
        self.assertEqual(pins["version"], version)
        self.assertEqual({k: v["binary_sha256"] for k, v in pins["platforms"].items()}, engine)
        for key, pin in pins["platforms"].items():
            self.assertIn(f"_{version}_", pin["asset"], key)
            self.assertRegex(pin["archive_sha256"], r"^[0-9a-f]{64}$")


class ZizmorPins(unittest.TestCase):
    def test_ci_installs_a_wheel_the_skill_pins(self):
        reqs = read(SKILL_REQS)
        version = re.search(r"^zizmor==(\S+)", reqs, re.M).group(1)
        hashes = set(re.findall(r"sha256:([0-9a-f]{64})", reqs.split("zizmor==")[1]))
        for path in CI_FILES:
            m = re.search(r"zizmor==(\S+) --hash=sha256:([0-9a-f]{64})", read(path))
            self.assertIsNotNone(m, path)
            self.assertEqual(m.group(1), version, path)
            self.assertIn(m.group(2), hashes, path)


if __name__ == "__main__":
    unittest.main()
