"""Docs checks for the factory repo's CI.

Catches the mistakes that silently break agents: a renamed doc that other
docs still link to, invalid workflow YAML, or an agent/skill file missing the
frontmatter Claude Code needs to load it.
"""
import glob
import os
import re
import sys

import yaml

errors = []


def project_files(pattern):
    # Third-party packages ship their own docs with links we don't control.
    return [p for p in glob.glob(pattern, recursive=True) if "node_modules" not in p.split(os.sep)]


for path in project_files("**/*.md"):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for target in re.findall(r"\]\(([^)#\s]+)", text):
        if re.match(r"[a-z]+:", target):
            continue
        resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
        if not os.path.exists(resolved):
            errors.append(f"{path}: broken link to {target}")

for path in project_files("**/*.y*ml") + project_files(".github/**/*.y*ml"):
    try:
        with open(path, encoding="utf-8") as f:
            yaml.safe_load(f)
    except yaml.YAMLError as e:
        errors.append(f"{path}: invalid YAML: {e}")

for path in glob.glob("agents/*/AGENT.md") + glob.glob("skills/*/SKILL.md"):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    match = re.match(r"---\n(.*?)\n---\n", text, re.S)
    meta = yaml.safe_load(match.group(1)) if match else None
    if not isinstance(meta, dict) or not meta.get("name") or not meta.get("description"):
        errors.append(f"{path}: frontmatter needs name and description")

print("\n".join(errors) or "All docs checks passed.")
sys.exit(1 if errors else 0)
