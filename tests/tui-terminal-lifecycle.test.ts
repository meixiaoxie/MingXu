import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ProcessTerminal, TerminalLifecycle, detectTerminalCapabilities } from "@mingxu/tui";

function createStreams(options: {
  readonly inputTTY?: boolean;
  readonly outputTTY?: boolean;
  readonly rawMode?: boolean;
  readonly write?: (value: string) => boolean;
} = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: options.inputTTY ?? true,
    resume: vi.fn(),
    pause: vi.fn(),
    isPaused: vi.fn(() => true),
    ...(options.rawMode === false ? {} : { setRawMode: vi.fn() }),
  }) as unknown as NodeJS.ReadStream;
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: options.outputTTY ?? true,
    columns: 80,
    rows: 24,
    write: vi.fn((value: string) => {
      writes.push(String(value));
      return options.write?.(String(value)) ?? true;
    }),
  }) as unknown as NodeJS.WriteStream;
  return { input, output, writes };
}

const handlers = {
  onKeypress: () => undefined,
  onResize: () => undefined,
  onOutputError: () => undefined,
};

describe("TerminalLifecycle", () => {
  it("enters and restores terminal state idempotently", () => {
    const { input, output, writes } = createStreams();
    const lifecycle = new TerminalLifecycle(input, output);

    expect(lifecycle.enter(handlers)).toBe(true);
    expect(lifecycle.enter(handlers)).toBe(true);
    lifecycle.hideCursor();
    expect(lifecycle.state).toMatchObject({
      entered: true,
      rawMode: true,
      bracketedPaste: true,
      cursorHidden: true,
    });

    lifecycle.restore();
    lifecycle.restore();

    expect((input.setRawMode as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false]]);
    expect((input as unknown as EventEmitter).listenerCount("keypress")).toBe(0);
    expect((input as unknown as EventEmitter).listenerCount("data")).toBe(0);
    expect((input as unknown as EventEmitter).listenerCount("newListener")).toBe(0);
    expect(input.pause).toHaveBeenCalledOnce();
    expect((output as unknown as EventEmitter).listenerCount("resize")).toBe(0);
    expect((output as unknown as EventEmitter).listenerCount("error")).toBe(0);
    expect(writes.join("")).toContain("\x1b[?2004h\x1b[?25l");
    expect(writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
    expect(lifecycle.state).toEqual({
      entered: false,
      rawMode: false,
      bracketedPaste: false,
      cursorHidden: false,
      processHandlers: false,
    });
  });

  it("does not retain readline listeners across repeated sessions", () => {
    const { input, output } = createStreams();
    const lifecycle = new TerminalLifecycle(input, output);

    for (let index = 0; index < 3; index += 1) {
      expect(lifecycle.enter(handlers)).toBe(true);
      lifecycle.restore();
      expect((input as unknown as EventEmitter).listenerCount("keypress")).toBe(0);
      expect((input as unknown as EventEmitter).listenerCount("data")).toBe(0);
      expect((input as unknown as EventEmitter).listenerCount("newListener")).toBe(0);
    }

    expect((input.setRawMode as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [true], [false],
      [true], [false],
      [true], [false],
    ]);
    expect(input.pause).toHaveBeenCalledTimes(3);
  });

  it("recovers when raw mode setup only completes partially", () => {
    const { input, output } = createStreams();
    const setRawMode = vi.fn((enabled: boolean) => {
      if (enabled) throw new Error("raw mode failed");
    });
    Object.assign(input, { setRawMode });
    const lifecycle = new TerminalLifecycle(input, output);

    expect(() => lifecycle.enter(handlers)).toThrow("raw mode failed");
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect((input as unknown as EventEmitter).listenerCount("keypress")).toBe(0);
    expect((input as unknown as EventEmitter).listenerCount("data")).toBe(0);
    expect((input as unknown as EventEmitter).listenerCount("newListener")).toBe(0);
    expect(lifecycle.state.entered).toBe(false);
    expect(() => lifecycle.restore()).not.toThrow();
  });

  it("recovers listeners and raw mode when bracketed paste setup throws EPIPE", () => {
    const brokenPipe = new Error("broken pipe") as NodeJS.ErrnoException;
    brokenPipe.code = "EPIPE";
    let failed = false;
    const { input, output } = createStreams({
      write: (value) => {
        if (!failed && value === "\x1b[?2004h") {
          failed = true;
          throw brokenPipe;
        }
        return true;
      },
    });
    const lifecycle = new TerminalLifecycle(input, output);

    expect(() => lifecycle.enter(handlers)).toThrow(brokenPipe);
    expect((input.setRawMode as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false]]);
    expect((input as unknown as EventEmitter).listenerCount("keypress")).toBe(0);
    expect((input as unknown as EventEmitter).listenerCount("data")).toBe(0);
    expect((output as unknown as EventEmitter).listenerCount("resize")).toBe(0);
    expect((output as unknown as EventEmitter).listenerCount("error")).toBe(0);
  });

  it("detects Windows VT support consistently with control-sequence support", () => {
    const supported = createStreams();
    const dumb = createStreams();

    expect(detectTerminalCapabilities(supported.input, supported.output, {
      env: { TERM: "xterm-256color" },
      platform: "win32",
    })).toMatchObject({ windowsVirtualTerminal: true, interactive: true });
    expect(detectTerminalCapabilities(dumb.input, dumb.output, {
      env: { TERM: "dumb" },
      platform: "win32",
    })).toMatchObject({ windowsVirtualTerminal: false, interactive: false });
  });

  it("detects stable downgrade modes without emitting control sequences", () => {
    const dumb = createStreams();
    const noRaw = createStreams({ rawMode: false });
    const piped = createStreams({ inputTTY: false, outputTTY: false });

    expect(detectTerminalCapabilities(dumb.input, dumb.output, { env: { TERM: "dumb" } })).toMatchObject({
      tty: true,
      interactive: false,
      controlSequences: false,
    });
    expect(detectTerminalCapabilities(noRaw.input, noRaw.output)).toMatchObject({
      tty: true,
      interactive: false,
      rawMode: false,
    });
    expect(detectTerminalCapabilities(piped.input, piped.output)).toMatchObject({
      tty: false,
      interactive: false,
    });

    const terminal = new ProcessTerminal(dumb.input, dumb.output, { env: { TERM: "dumb" } });
    expect(terminal.enterRawMode()).toBe(false);
    terminal.hideCursor();
    terminal.render(["plain fallback"]);
    terminal.restore();
    expect(dumb.writes.join("")).toBe("plain fallback\n");
  });

  it("removes synchronized-output markers when that capability is disabled", () => {
    const { input, output, writes } = createStreams();
    const terminal = new ProcessTerminal(input, output, { synchronizedOutput: false });
    terminal.enterRawMode();
    terminal.render(["frame"], { full: true });
    terminal.restore();

    const outputText = writes.join("");
    expect(outputText).toContain("frame");
    expect(outputText).not.toContain("\x1b[?2026h");
    expect(outputText).not.toContain("\x1b[?2026l");
    expect(outputText).toContain("\x1b[?2004l");
  });

  it.each([
    ["SIGINT", "signal"],
    ["SIGTERM", "signal"],
    ["SIGHUP", "signal"],
    ["uncaughtException", "fatal"],
    ["unhandledRejection", "fatal"],
  ] as const)("restores before dispatching %s and removes all process listeners", (event, kind) => {
    const { input, output, writes } = createStreams();
    const processTarget = new EventEmitter();
    const lifecycle = new TerminalLifecycle(input, output);
    const onSignal = vi.fn();
    const onFatalError = vi.fn();
    lifecycle.enter(handlers);
    lifecycle.hideCursor();
    lifecycle.bindProcessHandlers({ onSignal, onFatalError }, processTarget as unknown as Pick<NodeJS.Process, "on" | "off">);

    if (event === "uncaughtException") processTarget.emit(event, new Error("boom"));
    else if (event === "unhandledRejection") processTarget.emit(event, new Error("rejected"), Promise.resolve());
    else processTarget.emit(event);

    expect(writes.at(-1)).toBe("\x1b[?2026l\x1b[?2004l\x1b[?25h");
    expect((input.setRawMode as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(false);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
      expect(processTarget.listenerCount(name)).toBe(0);
    }
    if (kind === "signal") expect(onSignal).toHaveBeenCalledWith(event);
    else expect(onFatalError).toHaveBeenCalledOnce();
  });
});
