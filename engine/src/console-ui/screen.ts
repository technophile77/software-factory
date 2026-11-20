/**
 * F-024 (ADR 0035): draws the console model with Ink. Ink is ES modules only,
 * so this file is bundled on its own as dist/console.mjs and loaded by the
 * CommonJS engine with import() (SR-4). It holds no console logic: layout
 * comes from ConsoleModel.frame(), keys go to ConsoleModel.key().
 */
import { Box, Text, render, useInput, useStdout } from "ink";
import { createElement as h, useEffect, useState } from "react";
import { type ConsoleModel, PANE_COLS } from "../terminal/console-model";

export interface ScreenOptions {
  ascii: boolean;
  marker: string;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Tests draw into a fake terminal: no alternate screen, every frame written whole. */
  alternateScreen?: boolean;
  debug?: boolean;
}

const MIN = { cols: 60, rows: 16 };

function Screen({ model, o }: { model: ConsoleModel; o: ScreenOptions }) {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [, redraw] = useState(0);
  useEffect(() => model.onChange(() => redraw((n) => n + 1)), [model]);
  useEffect(() => {
    // FR-3: the layout follows the terminal's size as it changes.
    const size = () => model.resize(stdout.columns || 80, stdout.rows || 24);
    size();
    stdout.on("resize", size);
    return () => {
      stdout.off("resize", size);
    };
  }, [stdout, model]);
  useInput((input, key) => model.key(input, key));
  const f = model.frame(o.marker);
  if (f.tooSmall) return h(Text, null, `Make the window at least ${MIN.cols} by ${MIN.rows}`);
  const border = o.ascii ? "classic" : "single";
  const cols = model.cols;
  return h(
    Box,
    { flexDirection: "column", width: cols, height: model.rows },
    h(Text, { inverse: true, wrap: "truncate-end" }, ` ${f.title}`.padEnd(cols)),
    h(Box, { height: 1 }, ...f.tabs.map((t) => h(Text, { key: t.label, inverse: t.selected, wrap: "truncate-end" }, ` ${t.label} `))),
    h(
      Box,
      { flexDirection: f.pane.side ? "row" : "column", flexGrow: 1, width: cols },
      h(
        Box,
        { borderStyle: border, flexDirection: "column", flexGrow: 1 },
        h(Text, { bold: true, wrap: "truncate-end" }, f.windowTitle),
        ...f.lines.map((l, i) => h(Text, { key: i, wrap: "truncate-end" }, l || " ")),
      ),
      // FR-15: the side pane, a column on wide terminals and a strip under the window on narrow ones.
      h(
        Box,
        f.pane.side
          ? { borderStyle: border, flexDirection: "column", width: PANE_COLS, flexShrink: 0 }
          : { borderStyle: border, flexDirection: "column", height: f.pane.lines.length + 2, flexShrink: 0 },
        ...f.pane.lines.map((l, i) => h(Text, { key: i, wrap: "truncate-end", bold: f.pane.side && /^(Features|Agents) \(/.test(l) }, l || " ")),
      ),
    ),
    h(
      Box,
      { borderStyle: border, flexDirection: "column", width: cols, height: 4 },
      h(Text, { wrap: "truncate-start" }, f.prompt ? `${f.prompt}${f.input}_` : " "),
      h(Text, { dimColor: true, wrap: "truncate-end" }, f.hints),
    ),
  );
}

export function mount(model: ConsoleModel, o: ScreenOptions): { unmount(): void } {
  const app = render(h(Screen, { model, o }), {
    stdout: o.stdout ?? process.stdout,
    stdin: o.stdin ?? process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: o.alternateScreen ?? true,
    ...(o.debug ? { debug: true } : {}),
  });
  return { unmount: () => app.unmount() };
}
