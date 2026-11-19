import { z } from "zod";

/**
 * Factory lease v1.0 (F-023 FR-7): `lease.json` at the top of a project's
 * factory/state. Which factory serves the project, by a random id, and when
 * it took and last renewed the lease. Nothing about the PC, user or paths
 * (SR-3): factory/state may be pushed to GitHub.
 */
export const FACTORY_LEASE_SCHEMA = "factory-lease/1.0";

export const factoryLease = z.strictObject({
  schema: z.literal(FACTORY_LEASE_SCHEMA),
  factory: z.string().regex(/^[0-9a-f]{32}$/),
  started: z.string().max(40),
  renewed: z.string().max(40),
});

export type FactoryLease = z.infer<typeof factoryLease>;
