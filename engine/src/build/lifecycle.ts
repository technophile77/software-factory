import { Machine, replay, type Actor, type MachineSpec } from "../machine/machine";

/**
 * A feature's build, stages 5 to 9 (F-015), from the readiness gate's sign-off
 * to the owner's merge. Stage 6 reruns and fix cycles are loops here; the
 * failure table's counts are engine code (H-0197), not states.
 */
export const BUILD_STATES = [
  "waiting_dependency",
  "developer",
  "test_engineer",
  "merging",
  "resolving",
  "merging_main",
  "testing",
  "classifying",
  "fixing_product",
  "fixing_tests",
  "code_review",
  "validation",
  "opening_pr",
  "ci_wait",
  "pr_ready",
  "blocked",
  "closed",
  "cancelled",
] as const;
export type BuildState = (typeof BUILD_STATES)[number];

export const BUILD_ACTIONS = [
  "dependencies_merged",
  "done",
  "failed",
  "branches_merged",
  "conflict",
  "passed",
  "tests_failed",
  "rerun",
  "escalate",
  "product_code",
  "test_code",
  "clean",
  "blocking_finding",
  "pass",
  "fail_product",
  "fail_tests",
  "needs_human",
  "opened",
  "refused",
  "green",
  "red",
  "changes",
  "owner_merged",
  "owner_closed",
  "engine_merged",
  "auto_held",
  "retest",
  "to_developer",
  "to_test_engineer",
  "to_code_review",
  "to_validation",
  "to_pull_request",
  "rerun_developer",
  "rerun_test_engineer",
  "remerge",
  "resolved",
  "main_moved",
  "resolve",
] as const;
export type BuildAction = (typeof BUILD_ACTIONS)[number];

/** F-015 FR-27: `closed` means the PR merged; `cancelled`, that it was closed without merging. */
export type BuildFinal = "closed" | "cancelled";

const TEXT = `
waiting_dependency 'dependencies_merged' -> developer;

developer 'done' -> test_engineer;
developer 'failed' -> blocked;
test_engineer 'done' -> merging;
test_engineer 'failed' -> blocked;

merging 'branches_merged' -> testing;
merging 'conflict' -> resolving;
merging 'escalate' -> blocked;
merging 'failed' -> blocked;

resolving 'done' -> resolving;
resolving 'remerge' -> merging;
resolving 'resolved' -> testing;
resolving 'escalate' -> blocked;
resolving 'failed' -> blocked;

merging_main 'branches_merged' -> testing;
merging_main 'conflict' -> resolving;
merging_main 'escalate' -> blocked;
merging_main 'failed' -> blocked;

testing 'passed' -> code_review;
testing 'tests_failed' -> classifying;
testing 'rerun' -> testing;
testing 'escalate' -> blocked;

classifying 'product_code' -> fixing_product;
classifying 'test_code' -> fixing_tests;
classifying 'rerun' -> testing;
classifying 'escalate' -> blocked;
classifying 'failed' -> blocked;

fixing_product 'done' -> testing;
fixing_product 'failed' -> blocked;
fixing_tests 'done' -> testing;
fixing_tests 'failed' -> blocked;

code_review 'clean' -> validation;
code_review 'blocking_finding' -> fixing_product;
code_review 'failed' -> blocked;

validation 'pass' -> opening_pr;
validation 'fail_product' -> fixing_product;
validation 'fail_tests' -> fixing_tests;
validation 'needs_human' -> blocked;
validation 'failed' -> blocked;

opening_pr 'opened' -> ci_wait;
opening_pr 'refused' -> blocked;
opening_pr 'main_moved' -> merging_main;
ci_wait 'green' -> pr_ready;
ci_wait 'red' -> classifying;
ci_wait 'refused' -> blocked;
ci_wait 'main_moved' -> merging_main;

pr_ready 'changes' -> fixing_product;
pr_ready 'owner_merged' -> closed;
pr_ready 'engine_merged' -> closed;
pr_ready 'auto_held' -> pr_ready;
pr_ready 'owner_closed' -> cancelled;
pr_ready 'main_moved' -> merging_main;

blocked 'rerun_developer' -> developer;
blocked 'rerun_test_engineer' -> test_engineer;
blocked 'remerge' -> merging;
blocked 'resolve' -> resolving;
blocked 'main_moved' -> merging_main;
blocked 'retest' -> testing;
blocked 'to_developer' -> fixing_product;
blocked 'to_test_engineer' -> fixing_tests;
blocked 'to_code_review' -> code_review;
blocked 'to_validation' -> validation;
blocked 'to_pull_request' -> opening_pr;
blocked 'owner_closed' -> cancelled;
`;

const role = (r: string): Actor => ({ kind: "role", role: r });
const engine = (does: string): Actor => ({ kind: "engine", does });

export const BUILD_MACHINE: MachineSpec<BuildState, BuildAction, BuildFinal> = {
  name: "build",
  text: TEXT,
  start: "waiting_dependency",
  states: BUILD_STATES,
  actions: BUILD_ACTIONS,
  final: ["closed", "cancelled"],
  actors: {
    waiting_dependency: engine("checks each same-project dependency's PR until it merges (FR-16)"),
    developer: role("software-developer"),
    test_engineer: role("test-engineer"),
    merging: engine("merges the dev and test branches into the feature branch (FR-5)"),
    resolving: engine("hands each conflicted file to the developer or test engineer who owns it, then checks no conflict marker is left (ADR 0013)"),
    merging_main: engine("merges main into the feature branch after main moved (ADR 0013)"),
    testing: engine("runs the repo's test command and reads its results (FR-6)"),
    classifying: role("orchestrator"),
    fixing_product: role("software-developer"),
    fixing_tests: role("test-engineer"),
    code_review: role("security-reviewer"),
    validation: role("validation-judge"),
    opening_pr: engine("pushes the feature branch and opens a draft PR (FR-10)"),
    ci_wait: engine("reads the required checks on the pushed head (FR-10, SR-11)"),
    pr_ready: { kind: "owner", waitsOn: "the feature's pull request, merged or closed in GitHub" },
    blocked: { kind: "owner", waitsOn: "the Testing, Decision or Security item the build filed" },
  },
};

/** Which `workflow.yaml` stage each build state is in, for the feature's `stage` entry. */
export const STAGE_OF: Readonly<Record<BuildState, string>> = {
  waiting_dependency: "build_and_test_prep",
  developer: "build_and_test_prep",
  test_engineer: "build_and_test_prep",
  merging: "build_and_test_prep",
  resolving: "build_and_test_prep",
  merging_main: "build_and_test_prep",
  testing: "orchestrator_review",
  classifying: "orchestrator_review",
  fixing_product: "orchestrator_review",
  fixing_tests: "orchestrator_review",
  code_review: "code_review",
  validation: "validation",
  opening_pr: "pull_request",
  ci_wait: "pull_request",
  pr_ready: "pull_request",
  blocked: "blocked",
  closed: "pull_request",
  cancelled: "pull_request",
};

const STAGES = new Set(Object.values(STAGE_OF));

/** Whether a feature's `stage` is one the build owns. */
export function isBuildStage(stage: string): boolean {
  return STAGES.has(stage);
}

export function isBuildAction(a: string): a is BuildAction {
  return (BUILD_ACTIONS as readonly string[]).includes(a);
}

export type BuildMachine = Machine<BuildState, BuildAction, BuildFinal>;

export function buildMachine(actions: readonly string[]): ReturnType<typeof replay<BuildState, BuildAction, BuildFinal>> {
  return replay(BUILD_MACHINE, actions);
}
