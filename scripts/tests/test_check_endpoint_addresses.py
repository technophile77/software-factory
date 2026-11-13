"""Tests for the H-0137 endpoint address check in check_placeholders.py."""
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import check_placeholders as cp  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "check_placeholders.py")
DOC = "docs/notes.md"


def private_ipv4(rng):
    kind = rng.choice(["a", "b", "c"])
    o = lambda: rng.randint(0, 255)  # noqa: E731
    if kind == "a":
        return f"10.{o()}.{o()}.{o()}"
    if kind == "b":
        return f"172.{rng.randint(16, 31)}.{o()}.{o()}"
    return f"192.168.{o()}.{o()}"


def public_ipv4(rng):
    while True:
        a, b = rng.randint(1, 223), rng.randint(0, 255)
        if a in (10, 127) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or (a == 169 and b == 254):
            continue
        return f"{a}.{b}.{rng.randint(0, 255)}.{rng.randint(0, 255)}"


class Addresses(unittest.TestCase):
    def flagged(self, text, path=DOC):
        return bool(cp.check_addresses(path, text + "\n"))

    def test_private_ipv4_flagged(self):
        for a in ("10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.9.9", "192.168.1.20", "192.168.0.0"):
            self.assertTrue(self.flagged(f"server at {a}"), a)
            self.assertTrue(self.flagged(f"url: http://{a}:8080/v1"), a)

    def test_non_private_ipv4_passes(self):
        for a in ("172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1", "11.0.0.1", "8.8.8.8",
                  "192.0.2.10", "127.0.0.1", "169.254.169.254", "10.0.0", "10.0.0.256", "1.10.0.0.1"):
            self.assertFalse(self.flagged(f"host {a} here"), a)

    def test_ipv6_ula_flagged(self):
        for a in ("fd12:3456:789a::1", "fc00::1", "FD00:abcd::5", "[fdaa::10]:8080"):
            self.assertTrue(self.flagged(f"addr {a}"), a)

    def test_non_ula_ipv6_and_hex_pass(self):
        for a in ("2001:db8::1", "fe80::1", "::1", "fb00::1", "fe00::1", "abcfd12:3456::1", "deadbeefcafe"):
            self.assertFalse(self.flagged(f"addr {a}"), a)

    def test_local_hosts_flagged(self):
        for t in ("http://llm-box.local:8080", "https://box.local/v1", "base_url: http://a.b.local",
                  "llm-box.local:8080", "ssh me@box.local", "curl box.local/health", "HTTP://BOX.LOCAL:1"):
            self.assertTrue(self.flagged(t), t)

    def test_file_names_and_identifiers_pass(self):
        for t in ("see factory-projects.local.yaml", "see `factory-endpoints.local.yaml`", "/factory-endpoints.local.yaml",
                  "CLAUDE.local.md", ".claude/settings.local.json", "settings.providers.local: true",
                  "http://localhost:8080", "http://example.localhost:8080", "box.localdomain:80", "the .local suffix"):
            self.assertFalse(self.flagged(t), t)

    def test_allow_list_respected(self):
        text = "BLOCKED = 192.168.0.0/16 and http://box.local:8080 and fd00::1\n"
        self.assertTrue(cp.check_addresses(DOC, text))
        self.assertEqual(cp.check_addresses("engine/src/proxy/rules.ts", text), [])
        self.assertEqual(cp.check_addresses("engine/test/proxy.test.ts", text), [])
        # Files are listed one by one (Gate 2 L8): a new file beside an allowed one is checked.
        self.assertTrue(cp.check_addresses("engine/test/acceptance/x.test.ts", text))
        self.assertTrue(cp.check_addresses("engine/src/proxy/new-file.ts", text))
        self.assertTrue(cp.check_addresses("engine/test/new.test.ts", text))
        self.assertTrue(cp.check_addresses("engine/src/other.ts", text))
        self.assertTrue(cp.check_addresses("engine/testing/x.ts", text))

    def test_reports_path_and_line(self):
        errors = cp.check_addresses(DOC, "fine\nhttp://10.1.2.3:80\n")
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].startswith(f"{DOC}:2:"))

    def test_stochastic_private_vs_public(self):
        rng = random.Random(1337)
        words = ["server", "at", "url:", "http://", "(", "\"", "see", "port", "=", "-", "x"]
        for _ in range(500):
            def around(ip):
                pre = " ".join(rng.choices(words, k=rng.randint(0, 4)))
                post = rng.choice(["", ":8080", "/v1", ")", ",", ".", "/16"])
                return f"{pre} {ip}{post} tail"
            self.assertTrue(self.flagged(around(private_ipv4(rng))))
            ip = public_ipv4(rng)
            self.assertFalse(self.flagged(around(ip)), ip)


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

    def test_tracked_endpoints_file_fails_anywhere(self):
        for path in ("factory-endpoints.local.yaml", "sub/factory-endpoints.local.yaml"):
            r = self.run_in({path: "endpoints: []\n"})
            self.assertEqual(r.returncode, 1, path)
            self.assertIn("endpoints file must never be tracked", r.stdout)

    def test_owner_address_in_tracked_file_fails(self):
        r = self.run_in({"docs/a.md": "base_url: http://mybox.local:8080\n"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("docs/a.md:1", r.stdout)
        r = self.run_in({"docs/a.md": "base_url: http://192.168.1.50:8080\n"})
        self.assertEqual(r.returncode, 1)

    def test_allow_listed_and_filename_mentions_pass(self):
        r = self.run_in({
            "engine/src/proxy/rules.ts": '"192.168.0.0/16", "fc00::/7"\n',
            "engine/test/proxy.test.ts": 'url("http://10.0.0.1:80")\n',
            "docs/a.md": "Put endpoints in factory-endpoints.local.yaml, not factory-projects.local.yaml.\n",
        })
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main()
