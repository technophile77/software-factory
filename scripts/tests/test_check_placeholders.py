import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import check_placeholders as cp  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "check_placeholders.py")


class CheckText(unittest.TestCase):
    def test_template_owner_keys_must_be_placeholders(self):
        self.assertEqual(cp.check_text("x/templates/m.yaml", "#   github_id: <numeric id>\n"), [])
        self.assertTrue(cp.check_text("x/templates/m.yaml", "  github_id: 1000001\n"))
        self.assertTrue(cp.check_text("x/templates/m.yaml", "  oauth_client_id: Iv1.example\n"))

    def test_fixture_values_must_be_listed_examples(self):
        self.assertEqual(cp.check_text("e/test/a.ts", "owner:\n  github_id: 1000001\n  oauth_client_id: Iv1.example\n"), [])
        self.assertTrue(cp.check_text("e/test/a.ts", "  github_id: 58123094\n"))
        self.assertTrue(cp.check_text("e/test/a.ts", '  oauth_client_id: "Iv1.realowner"\n'))
        self.assertTrue(cp.check_text("e/test/a.ts", "  - { login: alexreal, id: 3003 }\n"))
        self.assertTrue(cp.check_text("e/test/a.ts", "export const OWNER_ID = 58123094;\n"))

    def test_values_built_by_code_pass(self):
        ok = (
            "`github_id: ${p.ownerId}`\n"
            't.replace(/github_id: \\d+/, "x")\n'
            "{ github_id: OWNER_ID, oauth_client_id: CLIENT_ID }\n"
            "[{ login: p.repoOwner, id: p.repoOwnerId }]\n"
        )
        self.assertEqual(cp.check_text("e/test/a.ts", ok), [])

    def test_owner_keys_outside_fixtures_are_not_checked(self):
        self.assertEqual(cp.check_text("e/src/manifest.ts", "owner: { github_id: number }\n"), [])

    def test_client_id_shapes_anywhere(self):
        self.assertTrue(cp.check_text("docs/a.md", "client Iv1.0123456789abcdef here\n"))
        self.assertTrue(cp.check_text("docs/a.md", "client Ov23liABCDEFGHIJ1234 here\n"))

    def test_emails(self):
        for ok in ("noreply@anthropic.com", "t@example.invalid", "a@example.org", "git@github.com", "x@evil.example"):
            self.assertEqual(cp.check_text("docs/a.md", ok + "\n"), [], ok)
        self.assertTrue(cp.check_text("docs/a.md", "someone@gmail.com\n"))


class WholeRepo(unittest.TestCase):
    def run_in(self, files):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True)
            for name, text in files.items():
                p = os.path.join(d, name)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(text)
            subprocess.run(["git", "-C", d, "add", "-A"], check=True)
            return subprocess.run([sys.executable, os.path.abspath(SCRIPT)], cwd=d, capture_output=True, text=True)

    def test_tracked_paths_file_fails(self):
        r = self.run_in({"factory-projects.local.yaml": "projects: []\n"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("never be tracked", r.stdout)

    def test_clean_tree_passes(self):
        r = self.run_in({"README.md": "hello\n"})
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main()
