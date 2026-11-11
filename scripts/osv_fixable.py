"""Fails engine CI on image CVEs that have a fix (owner decision 2026-11-11).

Reads OSV-Scanner's JSON output. A vulnerability counts as fixable when its
OSV record gives a fixed version for the affected package, the same test
OSV-Scanner's own "Fix Available" column uses. Unfixed ones are listed but
don't fail the run; the weekly scan catches them once a fix ships.

Usage: osv_fixable.py <osv-scanner JSON file>
"""
import json
import sys


def eco_base(e):
    return (e or "").split(":", 1)[0]


def fixed_versions(vuln, name, ecosystem):
    out = []
    for a in vuln.get("affected") or []:
        p = a.get("package") or {}
        if p.get("name") != name or eco_base(p.get("ecosystem")) != eco_base(ecosystem):
            continue
        for r in a.get("ranges") or []:
            for e in r.get("events") or []:
                if e.get("fixed"):
                    out.append(e["fixed"])
    return out


def classify(report):
    fixable, unfixed = [], []
    for source in report.get("results") or []:
        for pv in source.get("packages") or []:
            pkg = pv.get("package") or {}
            # Image scans name the OS source package; the record is filed under it.
            name = pkg.get("os_package_name") or pkg.get("name")
            for v in pv.get("vulnerabilities") or []:
                row = (v.get("id"), pkg.get("name"), pkg.get("version"))
                fixes = fixed_versions(v, name, pkg.get("ecosystem")) or (
                    fixed_versions(v, pkg.get("name"), pkg.get("ecosystem")) if name != pkg.get("name") else [])
                (fixable if fixes else unfixed).append(row + (", ".join(sorted(set(fixes))),))
    return fixable, unfixed


def main(path):
    with open(path, encoding="utf-8") as f:
        fixable, unfixed = classify(json.load(f))
    print(f"{len(unfixed)} known vulnerabilities with no fix yet (listed, not blocking).")
    for vid, name, ver, _ in sorted(unfixed):
        print(f"  unfixed  {vid}  {name} {ver}")
    if fixable:
        print(f"{len(fixable)} vulnerabilities have a fix; update the base image pin:")
        for vid, name, ver, fix in sorted(fixable):
            print(f"  FIXABLE  {vid}  {name} {ver} -> {fix}")
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
