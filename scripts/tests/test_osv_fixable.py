import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import osv_fixable as of  # noqa: E402


def vuln(vid, pkg, fixed=None, eco="Debian:13"):
    events = [{"introduced": "0"}] + ([{"fixed": fixed}] if fixed else [])
    return {"id": vid, "affected": [{"package": {"name": pkg, "ecosystem": eco}, "ranges": [{"type": "ECOSYSTEM", "events": events}]}]}


def report(*pkgs):
    return {"results": [{"source": {"path": "img", "type": "docker"}, "packages": list(pkgs)}]}


def pkg(name, vulns, source=None):
    info = {"name": name, "version": "1.0", "ecosystem": "Debian:13"}
    if source:
        info["os_package_name"] = source
    return {"package": info, "vulnerabilities": vulns}


class Classify(unittest.TestCase):
    def test_fix_for_this_package_counts(self):
        fixable, unfixed = of.classify(report(pkg("zlib1g", [vuln("CVE-1", "zlib", "1.3.1-2")], source="zlib")))
        self.assertEqual([r[0] for r in fixable], ["CVE-1"])
        self.assertEqual(unfixed, [])

    def test_no_fixed_event_is_unfixed(self):
        fixable, unfixed = of.classify(report(pkg("libc6", [vuln("CVE-2", "glibc")], source="glibc")))
        self.assertEqual(fixable, [])
        self.assertEqual([r[0] for r in unfixed], ["CVE-2"])

    def test_fix_for_another_package_or_ecosystem_does_not_count(self):
        v = vuln("CVE-3", "other", "2.0")
        v["affected"].append({"package": {"name": "tar", "ecosystem": "Alpine:v3.20"}, "ranges": [{"events": [{"fixed": "9"}]}]})
        fixable, unfixed = of.classify(report(pkg("tar", [v])))
        self.assertEqual(fixable, [])
        self.assertEqual(len(unfixed), 1)

    def test_name_used_when_no_source_name(self):
        fixable, _ = of.classify(report(pkg("tar", [vuln("CVE-4", "tar", "1.36")])))
        self.assertEqual(len(fixable), 1)


class Main(unittest.TestCase):
    def run_main(self, data):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(data, f)
        try:
            return of.main(f.name)
        finally:
            os.unlink(f.name)

    def test_exit_codes(self):
        self.assertEqual(self.run_main(report(pkg("libc6", [vuln("CVE-2", "glibc")], source="glibc"))), 0)
        self.assertEqual(self.run_main(report(pkg("zlib1g", [vuln("CVE-1", "zlib", "1")], source="zlib"))), 1)
        self.assertEqual(self.run_main({"results": []}), 0)


if __name__ == "__main__":
    unittest.main()
