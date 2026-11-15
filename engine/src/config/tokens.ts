import { factoryOwnerTokenName, factoryTokenName, type CredentialStore } from "../secrets";

/**
 * A project's GitHub tokens (F-015 FR-19): the default one, and one per
 * owner whose repos the default can't reach. Only owners the project's repos
 * have are looked up, so nothing in a manifest can name another store item.
 */
export class ProjectTokens {
  private constructor(readonly project: string, readonly fallback: string | null, private readonly byOwner: ReadonlyMap<string, string>) {}

  static async load(store: CredentialStore, project: string, owners: readonly string[]): Promise<ProjectTokens> {
    const fallback = await store.get(factoryTokenName(project));
    const byOwner = new Map<string, string>();
    for (const owner of new Set(owners.map((o) => o.toLowerCase()))) {
      const t = await store.get(factoryOwnerTokenName(project, owner));
      if (t) byOwner.set(owner, t);
    }
    return new ProjectTokens(project, fallback, byOwner);
  }

  /** For tests and projects driven without a store. */
  static of(project: string, fallback: string | null, byOwner: Record<string, string> = {}): ProjectTokens {
    return new ProjectTokens(project, fallback, new Map(Object.entries(byOwner).map(([k, v]) => [k.toLowerCase(), v])));
  }

  for(owner: string): string | null {
    return this.byOwner.get(owner.toLowerCase()) ?? this.fallback;
  }

  /** The store name `for(owner)` reads, for messages; never the value. */
  nameFor(owner: string): string {
    return this.byOwner.has(owner.toLowerCase()) ? factoryOwnerTokenName(this.project, owner) : factoryTokenName(this.project);
  }

  hasOwn(owner: string): boolean {
    return this.byOwner.has(owner.toLowerCase());
  }
}
