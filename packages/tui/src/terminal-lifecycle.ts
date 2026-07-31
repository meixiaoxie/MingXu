import { emitKeypressEvents } from "node:readline";

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const SYNCHRONIZED_OUTPUT_DISABLE = "\x1b[?2026l";
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

export interface TerminalCapabilities {
  readonly tty: boolean;
  readonly interactive: boolean;
  readonly rawMode: boolean;
  readonly controlSequences: boolean;
  readonly bracketedPaste: boolean;
  readonly synchronizedOutput: boolean;
  readonly resizeEvents: boolean;
  readonly windowsVirtualTerminal: boolean;
}

export interface TerminalLifecycleState {
  readonly entered: boolean;
  readonly rawMode: boolean;
  readonly bracketedPaste: boolean;
  readonly cursorHidden: boolean;
  readonly processHandlers: boolean;
}

export interface TerminalLifecycleOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly synchronizedOutput?: boolean;
}

export interface TerminalLifecycleHandlers {
  readonly onKeypress: (sequence: string, key: import("node:readline").Key) => void;
  readonly onResize: () => void;
  readonly onOutputError: (error: unknown) => void;
}

export interface TerminalProcessHandlers {
  readonly onSignal: (signal: NodeJS.Signals) => void;
  readonly onFatalError: (error: unknown, origin: "uncaughtException" | "unhandledRejection") => void;
}

type ProcessEventTarget = Pick<NodeJS.Process, "on" | "off">;
type EventListener = (...args: unknown[]) => void;

export class TerminalLifecycle {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly capabilities: TerminalCapabilities;
  #entered = false;
  #rawModeAttempted = false;
  #rawMode = false;
  #bracketedPaste = false;
  #cursorHidden = false;
  #keypressHandler: ((sequence: string, key: import("node:readline").Key) => void) | undefined;
  #resizeHandler: (() => void) | undefined;
  #outputErrorHandler: ((error: unknown) => void) | undefined;
  #processCleanup: (() => void) | undefined;
  #readlineListeners: Array<{ readonly event: "data" | "newListener"; readonly listener: EventListener }> = [];
  #inputWasPaused = false;
  #outputFailed = false;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream, options: TerminalLifecycleOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.capabilities = detectTerminalCapabilities(input, output, options);
  }

  get state(): TerminalLifecycleState {
    return {
      entered: this.#entered,
      rawMode: this.#rawMode,
      bracketedPaste: this.#bracketedPaste,
      cursorHidden: this.#cursorHidden,
      processHandlers: this.#processCleanup !== undefined,
    };
  }

  enter(handlers: TerminalLifecycleHandlers): boolean {
    if (this.#entered) return true;
    if (!this.capabilities.interactive) return false;

    this.#entered = true;
    this.#outputFailed = false;
    try {
      const dataListeners = new Set(this.#input.rawListeners("data") as EventListener[]);
      const newListenerListeners = new Set(this.#input.rawListeners("newListener") as EventListener[]);
      this.#inputWasPaused = typeof this.#input.isPaused === "function" && this.#input.isPaused();
      emitKeypressEvents(this.#input);
      this.#captureReadlineListeners("newListener", newListenerListeners);
      this.#rawModeAttempted = true;
      this.#input.setRawMode?.(true);
      this.#rawMode = true;
      this.#input.resume();

      this.#keypressHandler = handlers.onKeypress;
      this.#input.on("keypress", this.#keypressHandler);
      this.#captureReadlineListeners("data", dataListeners);
      if (this.capabilities.resizeEvents) {
        this.#resizeHandler = handlers.onResize;
        this.#output.on("resize", this.#resizeHandler);
      }
      this.#outputErrorHandler = (error) => {
        this.#outputFailed = true;
        handlers.onOutputError(error);
      };
      this.#output.on("error", this.#outputErrorHandler);

      if (this.capabilities.bracketedPaste) {
        this.#bracketedPaste = true;
        this.#write(BRACKETED_PASTE_ENABLE);
      }
      return true;
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  bindProcessHandlers(
    handlers: TerminalProcessHandlers,
    target: ProcessEventTarget = process,
  ): () => void {
    this.#processCleanup?.();
    let active = true;
    const settle = (callback: () => void): void => {
      if (!active) return;
      this.restore();
      callback();
    };
    const onSigint = () => settle(() => handlers.onSignal("SIGINT"));
    const onSigterm = () => settle(() => handlers.onSignal("SIGTERM"));
    const onSighup = () => settle(() => handlers.onSignal("SIGHUP"));
    const onUncaughtException = (error: unknown) => settle(() => handlers.onFatalError(error, "uncaughtException"));
    const onUnhandledRejection = (reason: unknown) => settle(() => handlers.onFatalError(reason, "unhandledRejection"));
    const cleanup = (): void => {
      if (!active) return;
      active = false;
      safeCall(() => target.off("SIGINT", onSigint));
      safeCall(() => target.off("SIGTERM", onSigterm));
      safeCall(() => target.off("SIGHUP", onSighup));
      safeCall(() => target.off("uncaughtException", onUncaughtException));
      safeCall(() => target.off("unhandledRejection", onUnhandledRejection));
      if (this.#processCleanup === cleanup) this.#processCleanup = undefined;
    };

    this.#processCleanup = cleanup;
    try {
      target.on("SIGINT", onSigint);
      target.on("SIGTERM", onSigterm);
      target.on("SIGHUP", onSighup);
      target.on("uncaughtException", onUncaughtException);
      target.on("unhandledRejection", onUnhandledRejection);
    } catch (error) {
      cleanup();
      throw error;
    }
    return cleanup;
  }

  restore(): void {
    const shouldRestoreControlState = this.#entered || this.#bracketedPaste || this.#cursorHidden;
    const cleanupProcess = this.#processCleanup;
    this.#processCleanup = undefined;
    const keypressHandler = this.#keypressHandler;
    const resizeHandler = this.#resizeHandler;
    const outputErrorHandler = this.#outputErrorHandler;
    const readlineListeners = this.#readlineListeners;
    const rawModeAttempted = this.#rawModeAttempted;
    const bracketedPaste = this.#bracketedPaste;
    const inputWasPaused = this.#inputWasPaused;
    const outputFailed = this.#outputFailed;

    this.#entered = false;
    this.#keypressHandler = undefined;
    this.#resizeHandler = undefined;
    this.#outputErrorHandler = undefined;
    this.#readlineListeners = [];
    this.#rawModeAttempted = false;
    this.#rawMode = false;
    this.#bracketedPaste = false;
    this.#cursorHidden = false;
    this.#inputWasPaused = false;

    safeCall(() => cleanupProcess?.());
    if (keypressHandler) safeCall(() => this.#input.off("keypress", keypressHandler));
    for (const { event, listener } of readlineListeners) safeCall(() => this.#input.off(event, listener));
    if (resizeHandler) safeCall(() => this.#output.off("resize", resizeHandler));
    if (outputErrorHandler) safeCall(() => this.#output.off("error", outputErrorHandler));
    if (rawModeAttempted) safeCall(() => this.#input.setRawMode?.(false));
    if (inputWasPaused) safeCall(() => this.#input.pause());

    if (this.capabilities.controlSequences && shouldRestoreControlState && !outputFailed) {
      const control = [
        ...(this.capabilities.synchronizedOutput ? [SYNCHRONIZED_OUTPUT_DISABLE] : []),
        ...(bracketedPaste ? [BRACKETED_PASTE_DISABLE] : []),
        SHOW_CURSOR,
      ].join("");
      safeCall(() => this.#write(control));
    }
  }

  write(value: string): void {
    this.#write(value);
  }

  writeFrame(value: string): void {
    this.#write(this.capabilities.synchronizedOutput ? value : stripSynchronizedOutput(value));
  }

  hideCursor(): void {
    if (!this.capabilities.controlSequences) return;
    this.#cursorHidden = true;
    this.#write(HIDE_CURSOR);
  }

  showCursor(): void {
    if (!this.capabilities.controlSequences) return;
    this.#cursorHidden = false;
    this.#write(SHOW_CURSOR);
  }

  #captureReadlineListeners(
    event: "data" | "newListener",
    existing: ReadonlySet<EventListener>,
  ): void {
    for (const listener of this.#input.rawListeners(event) as EventListener[]) {
      if (!existing.has(listener)) this.#readlineListeners.push({ event, listener });
    }
  }

  #write(value: string): void {
    try {
      this.#output.write(value);
    } catch (error) {
      this.#outputFailed = true;
      throw error;
    }
  }
}

export function detectTerminalCapabilities(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  options: TerminalLifecycleOptions = {},
): TerminalCapabilities {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tty = Boolean(input.isTTY && output.isTTY);
  const rawMode = tty && typeof input.setRawMode === "function";
  const controlSequences = tty && env.TERM?.toLowerCase() !== "dumb";
  const windowsVirtualTerminal = platform !== "win32" || controlSequences;
  const interactive = rawMode && controlSequences && windowsVirtualTerminal;
  return {
    tty,
    interactive,
    rawMode,
    controlSequences,
    bracketedPaste: interactive,
    synchronizedOutput: controlSequences && options.synchronizedOutput !== false,
    resizeEvents: interactive && typeof output.on === "function" && typeof output.off === "function",
    windowsVirtualTerminal,
  };
}

function stripSynchronizedOutput(value: string): string {
  return value.replaceAll("\x1b[?2026h", "").replaceAll("\x1b[?2026l", "");
}

function safeCall(callback: () => unknown): void {
  try {
    callback();
  } catch {
    // Restoration is best-effort and must stay idempotent after partial setup or EPIPE.
  }
}
