import { build } from "esbuild";
import * as path from "node:path";
import { expect, test } from "vitest";

// H-0174 condition 2: only the MCP SDK's stdio server is bundled. Its HTTP
// transports and OAuth pull in these packages; none may reach engine.js.
const BANNED = ["express", "hono", "cors", "jose"];

test("engine.js bundles none of the MCP SDK's web server or auth packages", async () => {
  const root = path.resolve(__dirname, "..");
  const out = await build({
    entryPoints: [path.join(root, "src/cli.ts")], bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["koffi", "@anthropic-ai/claude-agent-sdk"], write: false, metafile: true, logLevel: "silent",
  });
  const inputs = Object.keys(out.metafile.inputs);
  expect(inputs.some((p) => p.includes("@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))).toBe(true);
  const bad = inputs.filter((p) => BANNED.some((b) => new RegExp(`node_modules/(@[^/]+/)?${b}/`).test(p))
    || /@modelcontextprotocol\/sdk\/dist\/[^/]+\/(server\/(sse|streamableHttp|express|auth)|client\/)/.test(p));
  expect(bad).toEqual([]);
}, 60_000);
