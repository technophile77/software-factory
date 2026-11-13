import { it } from "vitest";
import { buildEngine } from "./support/mcp-harness";
import { McpWorld } from "./support/mcp-world";
import { question } from "./support/mcp-fake-engine";
it("smoke", async () => {
  const b = await buildEngine();
  const w = await McpWorld.create(b);
  w.engine.addFeature("F-1", "t", [question("Q1"), question("Q2", "deferred")]);
  const tools = await w.mcp.client.listTools();
  console.log(JSON.stringify(tools.tools.map(t => [t.name, t.annotations])));
  for (const [t, a] of [["status", {}], ["list", {}], ["open", {feature: "F-1"}], ["approval", {feature: "F-1", wait_s: 0}], ["next", {feature: "F-1"}],
     ["reply", {feature: "F-1", item: "Q1", revision: 0, status: "open", kind: "answer", text: "x"}], ["state", {feature: "F-1", item: "Q1"}],
     ["next", {feature: "F-2"}], ["reply", {feature: "F-1", item: "Q1", revision: 0, status: "open", kind: 5, text: "x"}],
     ["close", {feature: "F-1"}]] as const) {
    const r = await w.call(t, a as any);
    console.log(t, r.isError, r.text.slice(0, 1500));
  }
  console.log(w.engine.methods());
  await w.cleanup();
});
