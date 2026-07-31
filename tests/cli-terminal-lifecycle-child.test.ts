import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import headless from "@xterm/headless";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const tuiEntry = pathToFileURL(join(projectRoot, "packages", "tui", "dist", "index.js")).href;

interface ChildResult {
  readonly event: string;
  readonly writes: string;
  readonly rawMode: readonly boolean[];
}

interface HeadlessTerminal {
  write(data: string, callback: () => void): void;
  readonly modes: { readonly bracketedPasteMode: boolean };
}

function runLifecycleChild(event: string): Promise<ChildResult> {
  const script = `
    import { EventEmitter } from "node:events";
    import { TerminalLifecycle } from ${JSON.stringify(tuiEntry)};

    const event = process.argv[1];
    const writes = [];
    const rawMode = [];
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      resume() {},
      setRawMode(enabled) { rawMode.push(enabled); },
    });
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 24,
      write(value) { writes.push(String(value)); return true; },
    });
    const lifecycle = new TerminalLifecycle(input, output);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const result = JSON.stringify({ event, writes: writes.join(""), rawMode });
      process.stdout.write(result + "\\n", () => process.exit(0));
    };
    lifecycle.enter({ onKeypress() {}, onResize() {}, onOutputError() {} });
    lifecycle.hideCursor();
    lifecycle.bindProcessHandlers({ onSignal: finish, onFatalError: finish });

    if (event === "uncaughtException") setImmediate(() => { throw new Error("child failure"); });
    else if (event === "unhandledRejection") Promise.reject(new Error("child rejection"));
    else process.emit(event);
    setTimeout(() => process.exit(2), 2_000).unref();
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, event], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Lifecycle child exited ${exitCode}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()) as ChildResult);
    });
  });
}

async function replayTerminal(writes: string): Promise<HeadlessTerminal> {
  const terminalModule = headless as unknown as {
    Terminal: new (options: Record<string, unknown>) => HeadlessTerminal;
  };
  const terminal = new terminalModule.Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  await new Promise<void>((resolve) => terminal.write(writes, resolve));
  return terminal;
}

describe("terminal lifecycle child process", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"])(
    "leaves a headless terminal restored after %s",
    async (event) => {
      const result = await runLifecycleChild(event);

      expect(result.event).toBe(event);
      expect(result.rawMode).toEqual([true, false]);
      expect(result.writes).toContain("\x1b[?2004h\x1b[?25l");
      expect(result.writes.endsWith("\x1b[?2026l\x1b[?2004l\x1b[?25h")).toBe(true);
      const terminal = await replayTerminal(result.writes);
      expect(terminal.modes.bracketedPasteMode).toBe(false);
    },
  );
});
