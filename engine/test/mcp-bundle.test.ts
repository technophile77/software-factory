import { build } from "esbuild";
import * as path from "node:path";
import { expect, test } from "vitest";

// ADR 0029: the MCP mode is retired, so nothing from the MCP SDK may reach engine.js.
test("engine.js bundles nothing from the MCP SDK", async () => {
  const root = path.resolve(__dirname, "..");
  const out = await build({
    entryPoints: [path.join(root, "src/cli.ts")], bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["koffi", "@anthropic-ai/claude-agent-sdk"], write: false, metafile: true, logLevel: "silent",
  });
  expect(Object.keys(out.metafile.inputs).filter((p) => p.includes("@modelcontextprotocol"))).toEqual([]);
}, 60_000);
