import { Machine, type Actor, type MachineSpec } from "./machine/machine";

export const PROJECT_STATES = ["found", "needs_setup", "refused", "running", "stopping", "removed"] as const;
export type ProjectLife = (typeof PROJECT_STATES)[number];
export const PROJECT_ACTIONS = ["needs_setup", "refused", "ready", "failed", "stop", "stopped", "remove"] as const;
export type ProjectLifeAction = (typeof PROJECT_ACTIONS)[number];

/**
 * F-023 AC-13: one project file's life in the engine. A changed file, or a
 * setup step met, ends this life (removed) and starts a new one at found, so
 * every check runs again from the top.
 */
const TEXT = `
found 'needs_setup' -> needs_setup;
found 'refused' -> refused;
found 'ready' -> running;
needs_setup 'remove' -> removed;
refused 'remove' -> removed;
running 'failed' -> refused;
running 'stop' -> stopping;
stopping 'stopped' -> removed;
`;

const engine = (does: string): Actor => ({ kind: "engine", does });

export const PROJECT_MACHINE: MachineSpec<ProjectLife, ProjectLifeAction, "removed"> = {
  name: "project",
  text: TEXT,
  start: "found",
  states: PROJECT_STATES,
  actions: PROJECT_ACTIONS,
  final: ["removed"],
  actors: {
    found: engine("checks the project file, the clone, the token, the pin and the manifest (FR-2, FR-5)"),
    needs_setup: { kind: "owner", waitsOn: "the setup step the engine shows: clone, token or confirm (FR-5)" },
    refused: { kind: "owner", waitsOn: "a fix to the project file or the config repo's main, or the Security item filed" },
    running: engine("runs the project's features and inbox until its file is removed or changed (FR-4)"),
    stopping: engine("ends the project's sessions after their current commit and closes its channel (FR-4)"),
  },
};

export type ProjectMachine = Machine<ProjectLife, ProjectLifeAction, "removed">;

export const projectMachine = (): ProjectMachine => new Machine(PROJECT_MACHINE);
