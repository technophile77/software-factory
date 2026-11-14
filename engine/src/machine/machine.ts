import { from } from "jssm";

/**
 * F-019 FR-2: who moves a non-final state on. A state nobody acts in is how
 * the increment 3 trial stalled, so every machine names one per state.
 */
export type Actor =
  | { kind: "engine"; does: string }
  | { kind: "role"; role: string }
  | { kind: "owner"; waitsOn: string };

/**
 * One machine as the engine sees it (ADR 0031). `text` is a constant jssm
 * definition; `states` and `actions` are the `as const` unions engine code
 * uses, and a test checks they match what jssm parsed from `text`.
 */
export interface MachineSpec<S extends string, A extends string, F extends S> {
  readonly name: string;
  readonly text: string;
  readonly start: S;
  readonly states: readonly S[];
  readonly actions: readonly A[];
  readonly final: readonly F[];
  readonly actors: Readonly<Record<Exclude<S, F>, Actor>>;
}

type AnySpec = MachineSpec<string, string, string>;

/** The only place engine code reaches jssm: typed states and actions in, booleans out. */
export class Machine<S extends string, A extends string, F extends S> {
  private readonly m: ReturnType<typeof from>;

  constructor(readonly spec: MachineSpec<S, A, F>) {
    this.m = from(spec.text);
  }

  state(): S {
    return this.m.state() as S;
  }

  can(action: A): boolean {
    return (this.m.actions(this.m.state()) as string[]).includes(action);
  }

  /** False when the current state has no such action; the state is then unchanged. */
  act(action: A): boolean {
    if (!this.can(action)) return false;
    return this.m.action(action);
  }

  isFinal(): boolean {
    return (this.spec.final as readonly string[]).includes(this.state());
  }

  actor(): Actor | null {
    return this.isFinal() ? null : this.spec.actors[this.state() as Exclude<S, F>];
  }
}

/**
 * Replays recorded actions from the start state. Stops at the first action
 * the machine refuses and reports it, so the caller can pause the feature
 * there (F-019 FR-6) instead of guessing a state.
 */
export function replay<S extends string, A extends string, F extends S>(
  spec: MachineSpec<S, A, F>,
  actions: readonly string[],
): { machine: Machine<S, A, F>; refused: { index: number; action: string; state: S } | null } {
  const machine = new Machine(spec);
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (!(spec.actions as readonly string[]).includes(a) || !machine.act(a as A)) {
      return { machine, refused: { index: i, action: a, state: machine.state() } };
    }
  }
  return { machine, refused: null };
}

/**
 * F-019 FR-3 and FR-7 for one machine: every problem found, each naming the
 * machine and state. Empty means no state is a dead end.
 */
export function liveness(spec: AnySpec): string[] {
  const out: string[] = [];
  const say = (msg: string) => out.push(`${spec.name}: ${msg}`);
  let m: ReturnType<typeof from>;
  try {
    m = from(spec.text);
  } catch (e) {
    return [`${spec.name}: definition doesn't parse: ${(e as Error).message}`];
  }
  const parsed = m.states() as string[];
  const parsedActions = m.list_actions() as string[];
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (!same(parsed, spec.states)) say(`states differ from the typed union: jssm has [${[...parsed].sort().join(", ")}], the union has [${[...spec.states].sort().join(", ")}]`);
  if (!same(parsedActions, spec.actions)) say(`actions differ from the typed union: jssm has [${[...parsedActions].sort().join(", ")}], the union has [${[...spec.actions].sort().join(", ")}]`);
  if (m.state() !== spec.start) say(`starts in ${m.state()}, not ${spec.start}`);
  const final = new Set(spec.final);
  const actors = spec.actors as Record<string, Actor | undefined>;
  for (const s of parsed) {
    const exits = m.list_exits(s) as string[];
    if (final.has(s)) {
      if (exits.length > 0) say(`final state ${s} has exits`);
      if (actors[s]) say(`final state ${s} names an actor`);
      continue;
    }
    if (exits.length === 0) say(`state ${s} is not final but has no exits`);
    if (!actors[s]) say(`state ${s} names no actor`);
  }
  for (const s of Object.keys(actors)) if (!parsed.includes(s)) say(`actor named for unknown state ${s}`);
  // Reachability from the start state, and a way out to a final state from every state.
  const seen = new Set<string>([spec.start]);
  const queue = [spec.start];
  while (queue.length) for (const n of m.list_exits(queue.shift()!) as string[]) if (!seen.has(n)) (seen.add(n), queue.push(n));
  for (const s of parsed) if (!seen.has(s)) say(`state ${s} can't be entered from ${spec.start}`);
  const canFinish = new Set<string>(spec.final);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of parsed) if (!canFinish.has(s) && (m.list_exits(s) as string[]).some((n) => canFinish.has(n))) (canFinish.add(s), (grew = true));
  }
  for (const s of parsed) if (!canFinish.has(s)) say(`state ${s} can never reach a final state`);
  return out;
}
