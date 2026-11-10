"""F-006 (advisor) acceptance tests for the manifest checker: Role policy v2.3.

Written by the test engineer from F-006 spec v5 (FR-6, FR-7, SR-7, A-3) and
interface-contracts.md Role policy v2.3 (H-0061). They add to the nine
H-0061 tests in test_acceptance.py (`RolePolicyV23`) only what those don't
cover: the rules in each repo's effective policy, repo overrides that try to
widen the advisor, the "can't show it is inside" glob rule, the shell rule
(FR-7), and the request rule's exact spelling.

Run: python3 -m unittest discover -s plugins/software-factory/skills/onboard-repo/tests -p 'test_acceptance_f006.py' -v
The property test prints its seed; set F006_POLICY_SEED to replay one.
"""
import os
import random
import string
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_acceptance as oa  # noqa: E402  (shared harness; nothing in it is edited)

fc = oa.fc


class PolicyBase(oa.Base):
    manifest = oa.FR07RolePolicy.manifest
    validate = oa.FR07RolePolicy.validate
    assertRejected = oa.FR07RolePolicy.assertRejected
    assertAccepted = oa.FR07RolePolicy.assertAccepted

    def advisor(self, data):
        return data["policy"]["roles"]["advisor"]

    def analyst(self, data):
        return data["policy"]["roles"]["requirements-analyst"]

    def override(self, data, role, repo=0):
        return data["repos"][repo].setdefault("policy", {}).setdefault("roles", {}).setdefault(role, {})


class F006AdvisorRepoOverrides(PolicyBase):
    """Role policy v2.3: the advisor rules "hold in the project policy and in
    each repo's effective policy"; "A repo override may not add tools"."""

    def test_fr6_override_cannot_give_the_advisor_a_write_shell_or_web_tool(self):
        for tool in ("Edit", "Write", "Bash", "WebFetch", "WebSearch"):
            with self.subTest(tool=tool):
                data = self.manifest()
                self.override(data, "advisor")["tools"] = {"allow": oa.ADVISOR_TOOLS + [tool]}
                self.assertRejected(data, f"repo override gives the advisor {tool}")

    def test_fr7_no_shell_even_as_the_only_tool(self):
        # FR-7/SR-9: no shell until its own Security decision, in any form.
        for tools in (["Bash"], ["Read", "Bash"], ["Bash", "Skill"]):
            with self.subTest(tools=tools):
                data = self.manifest()
                self.advisor(data)["tools"]["allow"] = tools
                self.assertRejected(data, f"advisor tools {tools}")

    def test_fr7_no_shell_or_interpreter_in_commands(self):
        for cmd in ("bash", "sh", "python3", "env", "git"):
            for where in ("project", "repo override"):
                with self.subTest(cmd=cmd, where=where):
                    data = self.manifest()
                    if where == "project":
                        self.advisor(data)["commands"] = {"allow": [cmd]}
                    else:
                        self.override(data, "advisor")["commands"] = {"allow": [cmd]}
                    self.assertRejected(data, f"advisor commands {cmd} in {where}")

    def test_sr7_web_reader_shape_refused_for_the_advisor(self):
        # The open-web rule fits a role with WebFetch/WebSearch alone. The
        # advisor reaches the web only through the web reader (SR-1).
        data = self.manifest()
        adv = self.advisor(data)
        adv["tools"]["allow"] = ["WebFetch", "WebSearch"]
        adv["read"]["allow"] = []
        adv["network"]["allow"] = ["*"]
        self.assertRejected(data, "advisor shaped like the web reader")

    def test_sr7_override_cannot_widen_advisor_reads_past_the_analyst(self):
        data = self.manifest()
        self.analyst(data)["read"]["allow"] = ["docs/**", "src/**"]
        self.advisor(data)["read"]["allow"] = ["docs/**"]
        self.assertAccepted(data, "advisor narrower than the analyst")
        for glob in ("**", "test/**", ".factory/**", "secrets/**"):
            with self.subTest(glob=glob):
                self.override(data, "advisor")["read"] = {"allow": [glob]}
                self.assertRejected(data, f"repo override lets the advisor read {glob}")

    def test_sr7_analyst_override_deny_must_reach_the_advisor_in_that_repo(self):
        data = self.manifest()
        self.override(data, "requirements-analyst")["read"] = {"deny": ["private/**"]}
        self.assertRejected(data, "analyst denied private/** in a repo, advisor not")
        self.override(data, "advisor")["read"] = {"deny": ["private/**"]}
        self.assertAccepted(data, "advisor denied it in that repo too")
        # And the effective policy shows it.
        eff = fc.effective_policy(data, data["repos"][0]["name"])
        self.assertIn("private/**", eff["advisor"]["read"]["deny"])
        for path in oa.ADVISOR_EXTRA_DENY:
            self.assertIn(path, eff["advisor"]["read"]["deny"])

    def test_sr7_project_advisor_checked_on_its_own(self):
        # A deny added back only in every repo override doesn't excuse the
        # project rule: a later repo without an override would get it as is.
        for path in oa.ADVISOR_EXTRA_DENY:
            with self.subTest(path=path):
                data = self.manifest()
                self.advisor(data)["read"]["deny"].remove(path)
                for i in range(len(data["repos"])):
                    self.override(data, "advisor", i).setdefault("read", {}).setdefault("deny", []).append(path)
                self.assertRejected(data, f"project advisor lacks {path}")

    def test_sr7_advisor_with_read_tools_needs_a_read_glob(self):
        data = self.manifest()
        self.advisor(data)["read"]["allow"] = []
        self.assertRejected(data, "advisor with Read but no read glob")


class F006AdvisorGlobsInside(PolicyBase):
    """Role policy v2.3: "Each glob in its read.allow must be one of the
    analyst's, or sit under an analyst glob ** or <path>/**; the checker
    refuses any it can't show is inside"."""

    def with_analyst(self, analyst_globs, advisor_globs):
        data = self.manifest()
        self.analyst(data)["read"]["allow"] = analyst_globs
        self.advisor(data)["read"]["allow"] = advisor_globs
        return data

    def test_inside_globs_accepted(self):
        for adv in (["docs/**"], ["docs/features/**"], ["docs/a.md"], ["docs/*.md"], ["docs/**/x.md"],
                    ["README.md"], ["docs/**", "README.md"]):
            with self.subTest(advisor=adv):
                self.assertAccepted(self.with_analyst(["docs/**", "README.md"], adv), f"advisor {adv}")

    def test_globs_it_cannot_show_inside_refused(self):
        for adv in (["doc*/**"], ["?ocs/**"], ["*/**"], ["**/docs/**"], ["docsx/**"], ["doc/**"],
                    ["README*"], ["README.md/../src/**"], ["*.md"], ["docs/**", "src/x.py"]):
            with self.subTest(advisor=adv):
                self.assertRejected(self.with_analyst(["docs/**", "README.md"], adv), f"advisor {adv}")

    def test_property_random_globs_outside_the_analyst_refused(self):
        """Stdlib-random property check: a glob whose first segment differs
        from every analyst path is never accepted. Seed printed for replay."""
        seed = int(os.environ.get("F006_POLICY_SEED", random.randrange(2 ** 32)))
        print(f"\n[F006_POLICY_SEED={seed}]", file=sys.stderr)
        rng = random.Random(seed)
        alphabet = string.ascii_lowercase + string.digits + "-_"
        for n in range(100):
            first = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 10)))
            if first in ("docs", "src"):
                continue
            tail = rng.choice(["/**", "/*.md", "/a/b.py", "", "/**/x"])
            glob = first + tail
            with self.subTest(n=n, glob=glob, seed=seed):
                self.assertRejected(self.with_analyst(["docs/**", "src/**"], [glob]),
                                    f"seed {seed}: advisor glob {glob}")


class F006MayRequestSpelling(PolicyBase):
    """Role policy v2.3 Requests: "it may list only requirements-analyst and
    orchestrator"; SR-3: the request rule starts closed."""

    def test_near_miss_role_names_refused(self):
        for value in (["Orchestrator"], ["orchestrator "], [" requirements-analyst"], ["requirements_analyst"],
                      ["analyst"], ["*"], ["all"], [None], [["orchestrator"]], {"orchestrator": True}, None, True):
            with self.subTest(value=value):
                data = self.manifest()
                self.advisor(data)["may_request"] = value
                self.assertRejected(data, f"may_request {value!r}")

    def test_template_requesters_are_exactly_the_two_callers(self):
        # FR-2: only the analyst and the orchestrator; nobody else.
        adv = self.advisor(self.manifest())
        self.assertEqual(sorted(adv["may_request"]), sorted(oa.ADVISOR_REQUESTERS))


if __name__ == "__main__":
    unittest.main()
