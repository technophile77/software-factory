import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import update_open_prs as u  # noqa: E402

REPO = "owner/repo"


def pr(number, labels=(), fork=False, sha="h1"):
    return {
        "number": number,
        "head": {"sha": sha, "ref": f"b{number}", "repo": {"full_name": "other/repo" if fork else REPO}},
        "labels": [{"name": n} for n in labels],
    }


class FakeGitHub(u.GitHub):
    """Answers API calls from a table and records the calls."""

    def __init__(self, routes, update_token=None):
        super().__init__(REPO, "t", update_token)
        self.routes = routes
        self.calls = []

    def request(self, method, path, body=None, token=None):
        self.calls.append((method, path, body, token or self.token))
        answer = self.routes[(method, path)]
        if isinstance(answer, list):
            answer = answer.pop(0)
        return answer

    def made(self, method, path):
        return [c for c in self.calls if c[:2] == (method, path)]


LABEL_PATH = f"/issues/1/labels/{u.LABEL}"


class Process(unittest.TestCase):
    def test_fork_is_skipped_without_api_calls(self):
        gh = FakeGitHub({})
        self.assertEqual(u.process(gh, pr(1, fork=True), "main"), "skipped: fork")
        self.assertEqual(gh.calls, [])

    def test_deleted_fork_is_skipped(self):
        p = pr(1)
        p["head"]["repo"] = None
        self.assertEqual(u.process(FakeGitHub({}), p, "main"), "skipped: fork")

    def test_current_branch_is_left_alone(self):
        gh = FakeGitHub({("GET", "/compare/main...h1"): (200, {"behind_by": 0})})
        self.assertEqual(u.process(gh, pr(1), "main"), "current")
        self.assertEqual(len(gh.calls), 1)

    def test_current_branch_loses_stale_label(self):
        gh = FakeGitHub({
            ("GET", "/compare/main...h1"): (200, {"behind_by": 0}),
            ("DELETE", LABEL_PATH): (200, []),
        })
        self.assertEqual(u.process(gh, pr(1, labels=[u.LABEL]), "main"), "current")
        self.assertEqual(len(gh.made("DELETE", LABEL_PATH)), 1)

    def test_behind_branch_is_updated_with_expected_sha_and_update_token(self):
        gh = FakeGitHub({
            ("GET", "/compare/main...h1"): (200, {"behind_by": 2}),
            ("PUT", "/pulls/1/update-branch"): (202, {}),
        }, update_token="u")
        self.assertEqual(u.process(gh, pr(1), "main"), "updated")
        (call,) = gh.made("PUT", "/pulls/1/update-branch")
        self.assertEqual(call[2], {"expected_head_sha": "h1"})
        self.assertEqual(call[3], "u")

    def test_without_update_token_the_workflow_token_is_used(self):
        gh = FakeGitHub({
            ("GET", "/compare/main...h1"): (200, {"behind_by": 1}),
            ("PUT", "/pulls/1/update-branch"): (202, {}),
        })
        u.process(gh, pr(1), "main")
        self.assertEqual(gh.made("PUT", "/pulls/1/update-branch")[0][3], "t")

    def test_updated_branch_loses_label(self):
        gh = FakeGitHub({
            ("GET", "/compare/main...h1"): (200, {"behind_by": 1}),
            ("PUT", "/pulls/1/update-branch"): (202, {}),
            ("DELETE", LABEL_PATH): (404, None),
        })
        self.assertEqual(u.process(gh, pr(1, labels=[u.LABEL]), "main"), "updated")

    def conflict_routes(self, mergeable):
        return {
            ("GET", "/compare/main...h1"): (200, {"behind_by": 1}),
            ("PUT", "/pulls/1/update-branch"): (422, {"message": "merge conflict"}),
            ("GET", "/pulls/1"): [(200, {"mergeable": m}) for m in mergeable],
            ("POST", "/issues/1/labels"): (200, []),
            ("POST", "/issues/1/comments"): (201, {}),
        }

    def test_conflict_is_labelled_and_commented_once(self):
        gh = FakeGitHub(self.conflict_routes([False]))
        self.assertEqual(u.process(gh, pr(1), "main"), "conflict")
        self.assertEqual(gh.made("POST", "/issues/1/labels")[0][2], {"labels": [u.LABEL]})
        self.assertIn("ADR 0013", gh.made("POST", "/issues/1/comments")[0][2]["body"])

    def test_known_conflict_is_not_commented_again(self):
        gh = FakeGitHub(self.conflict_routes([False]))
        self.assertEqual(u.process(gh, pr(1, labels=[u.LABEL]), "main"), "conflict")
        self.assertEqual(gh.made("POST", "/issues/1/comments"), [])
        self.assertEqual(gh.made("POST", "/issues/1/labels"), [])

    @mock.patch("time.sleep")
    def test_waits_for_github_to_compute_mergeable(self, sleep):
        gh = FakeGitHub(self.conflict_routes([None, None, False]))
        self.assertEqual(u.process(gh, pr(1), "main"), "conflict")
        self.assertEqual(sleep.call_count, 2)

    def test_head_moved_is_skipped_not_flagged(self):
        gh = FakeGitHub(self.conflict_routes([True]))
        self.assertTrue(u.process(gh, pr(1), "main").startswith("skipped: head moved"))
        self.assertEqual(gh.made("POST", "/issues/1/labels"), [])

    @mock.patch("time.sleep")
    def test_unknown_mergeable_is_an_error(self, _):
        gh = FakeGitHub(self.conflict_routes([None] * 5))
        with self.assertRaises(RuntimeError):
            u.process(gh, pr(1), "main")
        self.assertEqual(gh.made("POST", "/issues/1/labels"), [])

    def test_permission_error_is_an_error(self):
        gh = FakeGitHub({
            ("GET", "/compare/main...h1"): (200, {"behind_by": 1}),
            ("PUT", "/pulls/1/update-branch"): (403, {"message": "denied"}),
        })
        with self.assertRaises(RuntimeError):
            u.process(gh, pr(1), "main")


class OpenPrs(unittest.TestCase):
    def test_pages_until_a_short_page(self):
        full = [pr(i) for i in range(100)]
        gh = FakeGitHub({
            ("GET", "/pulls?state=open&base=main&per_page=100&page=1"): (200, full),
            ("GET", "/pulls?state=open&base=main&per_page=100&page=2"): (200, [pr(100)]),
        })
        self.assertEqual(len(gh.open_prs("main")), 101)


class Main(unittest.TestCase):
    def test_one_failure_does_not_stop_the_others_and_fails_the_job(self):
        routes = {
            ("GET", "/pulls?state=open&base=main&per_page=100&page=1"): (200, [pr(1), pr(2, sha="h2")]),
            ("GET", "/compare/main...h1"): (500, None),
            ("GET", "/compare/main...h2"): (200, {"behind_by": 1}),
            ("PUT", "/pulls/2/update-branch"): (202, {}),
        }
        fake = FakeGitHub(routes)
        env = {"GITHUB_REPOSITORY": REPO, "GITHUB_TOKEN": "t"}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(u, "GitHub", return_value=fake), redirect_stdout(out):
            self.assertEqual(u.main(), 1)
        self.assertIn("#2 b2: updated", out.getvalue())
        self.assertIn("UPDATE_TOKEN is not set", out.getvalue())


if __name__ == "__main__":
    unittest.main()
