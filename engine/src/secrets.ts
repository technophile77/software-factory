import { CREDENTIAL_SERVICE } from "./constants";
import type { CredentialApi } from "./os/ffi";

/**
 * Secrets live in the OS credential store under the factory's own service
 * name (SR-20, OQ-7). Only these names exist, so nothing from a manifest or
 * a request can make the engine read an arbitrary item of the owner's.
 */
export const MODEL_CREDENTIAL = "model-credential";
const FACTORY_TOKEN_RE = /^factory-token\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_SECRET_BYTES = 2048;

export function factoryTokenName(project: string): string {
  const name = `factory-token/${project}`;
  if (!FACTORY_TOKEN_RE.test(name)) throw new SecretError("That project name can't name a factory token.");
  return name;
}

export function isSecretName(name: string): boolean {
  return name === MODEL_CREDENTIAL || FACTORY_TOKEN_RE.test(name);
}

export class SecretError extends Error {
  override name = "SecretError";
}

export interface CredentialStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

function check(name: string): void {
  if (!isSecretName(name)) throw new SecretError("Not a factory secret name.");
}

function checkValue(value: string): void {
  // Tokens and keys are one printable line; anything else is a paste mistake
  // that would otherwise be stored and sent as a header later.
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES || !/^[\x21-\x7e]+$/.test(value)) {
    throw new SecretError("A secret must be one line of printable ASCII, without spaces, up to 2 KB.");
  }
}

/** The OS store, through the FFI module's CredentialApi. Every failure is closed. */
export class OsCredentialStore implements CredentialStore {
  constructor(private readonly api: () => CredentialApi) {}

  async get(name: string): Promise<string | null> {
    check(name);
    let raw: Buffer | null;
    try {
      raw = this.api().read(CREDENTIAL_SERVICE, name);
    } catch {
      throw new SecretError("The OS credential store couldn't be read.");
    }
    if (raw === null) return null;
    const value = raw.toString("utf8");
    raw.fill(0);
    try {
      checkValue(value);
    } catch {
      throw new SecretError("The stored secret is malformed; store it again.");
    }
    return value;
  }

  async set(name: string, value: string): Promise<void> {
    check(name);
    checkValue(value);
    const buf = Buffer.from(value, "utf8");
    try {
      this.api().write(CREDENTIAL_SERVICE, name, buf);
    } catch {
      throw new SecretError("The OS credential store refused the secret.");
    } finally {
      buf.fill(0);
    }
  }

  async delete(name: string): Promise<boolean> {
    check(name);
    try {
      return this.api().remove(CREDENTIAL_SERVICE, name);
    } catch {
      throw new SecretError("The OS credential store couldn't remove the secret.");
    }
  }
}

/** For tests and for driving the engine without an OS store. */
export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }
  async get(name: string) {
    check(name);
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string) {
    check(name);
    checkValue(value);
    this.values.set(name, value);
  }
  async delete(name: string) {
    check(name);
    return this.values.delete(name);
  }
}
