/**
 * F-026 SR-11 (H-0291): renders every CI template with fixture params into a
 * folder, so the factory's own CI can run actionlint and zizmor on exactly
 * what the engine would propose.
 *
 *   npm run render-ci-templates -- <folder>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseRequest } from "../src/ci/request";
import { renderWorkflow } from "../src/ci/render";

const python = { language: "python", version: "3.12" };
const node = { language: "node", version: "22" };

/** One request per template and option the catalog offers. */
export const FIXTURES: unknown[] = [
  { repo: "r", job: "contract", action: "add", template: "test-command", params: { runtime: python, setup: [["python", "-m", "pip", "install", "--require-hashes", "-r", "requirements-dev.txt"]], run: ["python", "-m", "pytest", "-m", "contract"] }, reason: "fixture" },
  { repo: "r", job: "fuzz", action: "add", template: "test-command", params: { runtime: python, run: ["python", "-m", "pytest", "tests/fuzz", "-k", "it's quoted"], schedule: true, timeout_minutes: 90 }, reason: "fixture" },
  { repo: "r", job: "unit-node", action: "add", template: "test-command", params: { runtime: node, setup: [["npm", "ci"]], run: ["npm", "test"] }, reason: "fixture" },
  { repo: "r", job: "coverage", action: "add", template: "coverage", params: { runtime: python, run: ["python", "-m", "pytest", "--cov=pkg", "--cov-report=xml"], report: "coverage.xml", min_percent: 80 }, reason: "fixture" },
  { repo: "r", job: "secrets", action: "add", template: "gitleaks", params: {}, reason: "fixture" },
  { repo: "r", job: "sast", action: "add", template: "semgrep", params: { configs: ["p/default", "rules/extra.yml"] }, reason: "fixture" },
  { repo: "r", job: "deps", action: "add", template: "osv-scanner", params: {}, reason: "fixture" },
  { repo: "r", job: "deps-lock", action: "add", template: "osv-scanner", params: { lockfiles: ["requirements.txt"], schedule: false }, reason: "fixture" },
];

export function renderFixtures(dir: string): string[] {
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  return FIXTURES.map((raw) => {
    const q = parseRequest(raw);
    if (!q.ok || q.request.action === "remove") throw new Error(`fixture refused: ${q.ok ? "remove" : q.error}`);
    const out = renderWorkflow(q.request);
    fs.writeFileSync(path.join(dir, out.path), out.content);
    return out.path;
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: render-ci-templates <folder>");
  for (const f of renderFixtures(dir)) process.stdout.write(`${f}\n`);
}
