"""Merge main into every open same-repo PR that is behind it (H-0115).

Runs from `.github/workflows/keep-prs-mergeable.yml` after each push to main,
so keeping PRs current is done by a tool instead of an agent (owner rule,
2026-11-13). GitHub does the merge server-side (the update-branch API), so no
PR code is checked out or run here. It merges and never rebases (ADR 0013).

A PR whose merge conflicts gets the `merge-conflict` label and, the first time,
a comment. Resolving it is left to an agent or the owner. The label comes off
on the first run that finds the PR current or updates it cleanly.

Standard library only, so the job installs nothing.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
LABEL = "merge-conflict"
COMMENT = (
    "This branch has merge conflicts with `{base}`, so it was not updated "
    "automatically. Merge `{base}` into it and resolve the conflicts "
    "(ADR 0013: merge, don't rebase). This label comes off on the next push "
    "to `{base}` after the branch merges cleanly."
)


class GitHub:
    def __init__(self, repo, token, update_token):
        self.repo = repo
        self.token = token
        # A separate token for the update itself: pushes made with the
        # workflow's GITHUB_TOKEN start no workflow, so the PR's checks would
        # not run on the new head.
        self.update_token = update_token or token

    def request(self, method, path, body=None, token=None):
        req = urllib.request.Request(
            f"{API}/repos/{self.repo}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token or self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw) if raw else None
            except ValueError:
                return e.code, None

    def check(self, method, path, body=None):
        status, data = self.request(method, path, body)
        if status >= 300:
            raise RuntimeError(f"{method} {path}: HTTP {status}")
        return data

    def open_prs(self, base):
        prs, page = [], 1
        while True:
            batch = self.check("GET", f"/pulls?state=open&base={base}&per_page=100&page={page}")
            prs += batch
            if len(batch) < 100:
                return prs
            page += 1

    def behind_by(self, base, head_sha):
        return self.check("GET", f"/compare/{base}...{head_sha}")["behind_by"]

    def update_branch(self, number, head_sha):
        status, _ = self.request(
            "PUT", f"/pulls/{number}/update-branch",
            {"expected_head_sha": head_sha}, token=self.update_token,
        )
        return status

    def mergeable(self, number, tries=5, wait=3):
        # GitHub computes this in the background; null means not ready yet.
        for i in range(tries):
            value = self.check("GET", f"/pulls/{number}").get("mergeable")
            if value is not None:
                return value
            if i < tries - 1:
                time.sleep(wait)
        return None

    def add_label(self, number):
        self.check("POST", f"/issues/{number}/labels", {"labels": [LABEL]})

    def remove_label(self, number):
        status, _ = self.request("DELETE", f"/issues/{number}/labels/{LABEL}")
        if status not in (200, 404):
            raise RuntimeError(f"removing label from #{number}: HTTP {status}")

    def comment(self, number, text):
        self.check("POST", f"/issues/{number}/comments", {"body": text})


def process(gh, pr, base):
    """Bring one PR up to date. Returns a short outcome for the job log."""
    number = pr["number"]
    if (pr["head"].get("repo") or {}).get("full_name") != gh.repo:
        # Fork branches are not ours to push to.
        return "skipped: fork"
    head_sha = pr["head"]["sha"]
    labelled = any(lbl["name"] == LABEL for lbl in pr.get("labels", []))

    if gh.behind_by(base, head_sha) == 0:
        if labelled:
            gh.remove_label(number)
        return "current"

    status = gh.update_branch(number, head_sha)
    if status == 202:
        if labelled:
            gh.remove_label(number)
        return "updated"
    if status != 422:
        raise RuntimeError(f"update-branch #{number}: HTTP {status}")

    # 422 covers both a conflict and a head that moved since we listed it, so
    # ask GitHub whether the branch merges rather than parse the message.
    mergeable = gh.mergeable(number)
    if mergeable is False:
        if not labelled:
            gh.add_label(number)
            gh.comment(number, COMMENT.format(base=base))
        return "conflict"
    if mergeable is True:
        return "skipped: head moved during the run; the next push to main retries"
    raise RuntimeError(f"#{number}: GitHub has not worked out whether it merges")


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    base = os.environ.get("BASE_BRANCH", "main")
    gh = GitHub(repo, os.environ["GITHUB_TOKEN"], os.environ.get("UPDATE_TOKEN"))
    if not os.environ.get("UPDATE_TOKEN"):
        print("::warning::UPDATE_TOKEN is not set. Branches are updated with "
              "GITHUB_TOKEN, so their checks will not run on the new head.")

    failed = False
    for pr in gh.open_prs(base):
        # One PR's failure must not stop the others from being updated.
        try:
            outcome = process(gh, pr, base)
        except RuntimeError as e:
            failed = True
            outcome = f"error: {e}"
            print(f"::error::#{pr['number']}: {e}")
        print(f"#{pr['number']} {pr['head']['ref']}: {outcome}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
