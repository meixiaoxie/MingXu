import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/main.js";
import { MINGXU_IDENTITY_PROMPT } from "../src/cli/identity.js";
import { JsonlSessionStore } from "../src/session/jsonl-session-store.js";
import type { ProcessTerminal } from "@mingxu/tui";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createStreamResponse(payload: string, status = 200) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  };
}

function createOpenAiSseResponse(text: string, finishReason = "stop") {
  return createStreamResponse(`data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: finishReason }],
  })}\n\ndata: [DONE]\n\n`);
}

function createAnthropicSseResponse(text: string, stopReason = "end_turn") {
  return createStreamResponse([
    `data: ${JSON.stringify({ type: "message_start" })}\n\n`,
    `data: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason },
    })}\n\n`,
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join(""));
}

function expectManagedSystemPrompt(system: unknown, ...fragments: string[]): void {
  expect(typeof system).toBe("string");
  const systemPrompt = system as string;
  expect(systemPrompt).toContain(MINGXU_IDENTITY_PROMPT);
  for (const fragment of fragments) {
    expect(systemPrompt).toContain(fragment);
  }
}

async function writeConfigFile(config: unknown) {
  const root = await mkdtemp(join(tmpdir(), "mingxu-cli-"));
  const configPath = join(root, "mingxu.config.json");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return { root, configPath };
}

function createPipedStdin(text: string): NodeJS.ReadStream {
  return {
    isTTY: false,
    setEncoding: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  } as unknown as NodeJS.ReadStream;
}

function createEmptyPipedStdin(): NodeJS.ReadStream {
  return {
    isTTY: false,
    setEncoding: vi.fn(),
    async *[Symbol.asyncIterator]() {
      return;
    },
  } as unknown as NodeJS.ReadStream;
}

function createInteractiveTerminal() {
  const keyListeners: Array<(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void> = [];
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    size: { columns: 80, rows: 24 },
    enterRawMode: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    restore: vi.fn(),
    render: vi.fn(),
    onKeypress(listener: (input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void) {
      keyListeners.push(listener);
      resolveReady?.();
      resolveReady = undefined;
      return () => {
        const index = keyListeners.indexOf(listener);
        if (index >= 0) keyListeners.splice(index, 1);
      };
    },
    onResize() {
      return () => undefined;
    },
    emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) {
      for (const listener of keyListeners) {
        listener(input);
      }
    },
    ready,
  } as unknown as ProcessTerminal & {
    emit(input: { sequence: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void;
    ready: Promise<void>;
  };
}

describe("mingxu CLI", () => {
  it("prints help and version information", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(main(["--help"], { stdout, stderr, version: "0.1.0" })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Usage: mingxu"));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("--model <name>"));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("--force"));
    expect(stderr.write).not.toHaveBeenCalled();

    stdout.write.mockClear();
    await expect(main(["--version"], { stdout, stderr, version: "0.1.0" })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith("0.1.0\n");
  });

  it("loads named models and forwards the resolved config to a custom runner", async () => {
    const { root, configPath } = await writeConfigFile({
      systemPrompt: "Be concise",
      defaultModel: "selected",
      models: {
        selected: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const run = vi.fn(async (config, prompt?: string, modelKey?: string) => {
        expect(config).toMatchObject({
          name: "mingxu",
          defaultModel: "selected",
          model: { provider: "anthropic", model: "claude-sonnet-5" },
          models: { selected: { provider: "anthropic", model: "claude-sonnet-5" } },
          maxIterations: 10,
          plugins: [],
        });
        expect(prompt).toBe("Say hello");
        expect(modelKey).toBeUndefined();
        return "mocked result";
      });
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };

      await expect(
        main(["--config", configPath, "Say hello"], { run, stdout, stderr }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("mocked result\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("TTY chat mode enters raw terminal mode and exits cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-tty-"));
    const configPath = join(root, "mingxu.config.json");
    const providerPath = join(root, "providers.mjs");

    await writeFile(providerPath, `
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      export function register(registry) {
        registry.register({
          provider: "local-test",
          capabilities: {
            supportsTools: true,
            supportsStreaming: false,
            supportsImages: false,
            supportsStructuredOutput: false,
            supportsRefusal: false,
            supportsFallback: false,
            supportsEffort: false,
            supportsPromptCaching: false,
            supportsMidConversationSystem: false,
            maxContext: 1000,
            maxOutput: 100,
          },
          create() {
            return {
              provider: "local-test",
              capabilities: this.capabilities,
              async generate() {
                globalThis.__mingxuTtyPromptStarted?.();
                await delay(25);
                return { text: "TTY reply", toolCalls: [] };
              },
            };
          },
        });
      }
    `, "utf8");
    await writeFile(configPath, JSON.stringify({
      defaultModel: "local",
      models: {
        local: { provider: "local-test", model: "local-model" },
      },
      customProviders: {
        module: "./providers.mjs",
      },
    }), "utf8");

    const terminal = createInteractiveTerminal();
    const stdout = { write: vi.fn(), isTTY: true };
    const stderr = { write: vi.fn(), isTTY: true };
    const stdin = { isTTY: true } as unknown as NodeJS.ReadStream;

    try {
      const promptStarted = new Promise<void>((resolve) => {
        (globalThis as { __mingxuTtyPromptStarted?: () => void }).__mingxuTtyPromptStarted = resolve;
      });
      const exitPromise = main(["--config", configPath, "chat", "Hello TTY"], {
        stdout,
        stderr,
        stdin,
        terminalFactory: () => terminal,
      });

      await terminal.ready;
      await promptStarted;
      terminal.emit({ sequence: "", name: "d", ctrl: true });
      terminal.emit({ sequence: "", name: "d", ctrl: true });

      await expect(exitPromise).resolves.toBe(0);
      expect(terminal.enterRawMode).toHaveBeenCalledOnce();
      expect(terminal.hideCursor).toHaveBeenCalledOnce();
      expect(terminal.showCursor).toHaveBeenCalledOnce();
      expect(terminal.restore).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("mingxu chat. Type /help for commands."));
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { __mingxuTtyPromptStarted?: () => void }).__mingxuTtyPromptStarted;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chat 命令在非 TTY 下会走一次性管道输入", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "selected",
      models: {
        selected: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const run = vi.fn(async (_config, prompt?: string) => {
        expect(prompt).toBe("Pipe prompt");
        return "pipe reply";
      });
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createPipedStdin("Pipe prompt\n");

      await expect(
        main(["--config", configPath, "chat"], { run, stdout, stderr, stdin }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("pipe reply\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("直接启动在非 TTY 管道输入下会自动退回一次性执行", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "selected",
      models: {
        selected: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const run = vi.fn(async (_config, prompt?: string) => {
        expect(prompt).toBe("Direct prompt");
        return "direct reply";
      });
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createPipedStdin("Direct prompt\n");

      await expect(
        main(["--config", configPath], { run, stdout, stderr, stdin }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("direct reply\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes an explicit model key through to a custom runner", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "primary-key" },
        backup: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "backup-key" },
      },
    });

    try {
      const run = vi.fn(async (_config, prompt?: string, modelKey?: string) => {
        expect(prompt).toBe("Say hello");
        expect(modelKey).toBe("backup");
        return "backup result";
      });
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };

      await expect(
        main(["--config", configPath, "--model", "backup", "Say hello"], { run, stdout, stderr }),
      ).resolves.toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("backup result\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an explicit model key when running the default provider pipeline", async () => {
    const { root, configPath } = await writeConfigFile({
      systemPrompt: "Be concise",
      defaultModel: "ignored",
      models: {
        ignored: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "ignored-key" },
        selected: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "selected-key" },
      },
    });
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { model?: string; system?: unknown; messages?: Array<{ role?: string; content?: string }> };
      expect(body).toMatchObject({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "Say hello" }],
      });
      expectManagedSystemPrompt(body.system, "Be concise");
      return createAnthropicSseResponse("selected answer");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(
        main(["--config", configPath, "--model", "selected", "Say hello"], { stdout, stderr }),
      ).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("selected answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing and unknown --model values", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(main(["--model"], { stdout, stderr })).resolves.toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Missing value for --model"));

    stderr.write.mockClear();
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });
    try {
      await expect(
        main(["--config", configPath, "--model", "missing", "Say hello"], { stdout, stderr }),
      ).resolves.toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Unknown model key: missing"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges a provider entry into the selected built-in model", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "chat",
      models: { chat: { provider: "openai", model: "gpt-test" } },
      providers: { openai: { apiKey: "test-key", baseUrl: "https://gateway.example.test/v1" } },
    });
    const fetchMock = vi.fn(async (url: string, init: { body?: string }) => {
      expect(url).toBe("https://gateway.example.test/v1/chat/completions");
      const body = JSON.parse(init.body ?? "{}") as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      expect(body).toMatchObject({ model: "gpt-test" });
      expect(body.messages?.[0]?.role).toBe("system");
      expectManagedSystemPrompt(body.messages?.[0]?.content);
      return createOpenAiSseResponse("gateway answer");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("gateway answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a configured built-in alias through the default pipeline", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "chat",
      models: { chat: { provider: "work-openai", model: "gpt-test", apiKey: "test-key" } },
      providers: { "work-openai": "openai" },
    });
    const fetchMock = vi.fn(async () => createOpenAiSseResponse("alias answer"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("alias answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists recent sessions through the sessions command", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const listSessions = vi.fn(async () => "session-1\tactive\t2026-07-28T00:00:00.000Z\tsucceeded");

      await expect(main(["--config", configPath, "sessions"], { stdout, stderr, listSessions })).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("session-1\tactive\t2026-07-28T00:00:00.000Z\tsucceeded\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes resume session id into the runner", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const run = vi.fn(async (_config, prompt?: string, modelKey?: string, sessionId?: string) => {
        expect(prompt).toBe("Continue work");
        expect(modelKey).toBeUndefined();
        expect(sessionId).toBe("session-123");
        return "resumed";
      });

      await expect(main(["--config", configPath, "resume", "session-123", "--prompt", "Continue work"], { stdout, stderr, run })).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("resumed\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resume 在非 TTY 管道输入下也能继续会话", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createPipedStdin("Continue work\n");
      const run = vi.fn(async (_config, prompt?: string, modelKey?: string, sessionId?: string) => {
        expect(prompt).toBe("Continue work");
        expect(modelKey).toBeUndefined();
        expect(sessionId).toBe("session-123");
        return "resumed";
      });

      await expect(
        main(["--config", configPath, "resume", "session-123"], { stdout, stderr, run, stdin }),
      ).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("resumed\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resume 在非 TTY 且缺少 session id 时会明确失败", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createPipedStdin("Continue work\n");
      const run = vi.fn();

      await expect(
        main(["--config", configPath, "resume"], { stdout, stderr, run, stdin }),
      ).resolves.toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("requires an interactive terminal"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--continue 在非 TTY 下会自动接上最近一次会话", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      session: {
        enabled: true,
        dir: "sessions",
        save: true,
      },
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const store = new JsonlSessionStore(join(root, "sessions"));
      const document = await store.createSession({ title: "latest" });
      await store.saveSession(document, document.revision);

      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createPipedStdin("Continue work\n");
      const run = vi.fn(async (_config, prompt?: string, modelKey?: string, sessionId?: string) => {
        expect(prompt).toBe("Continue work");
        expect(modelKey).toBeUndefined();
        expect(sessionId).toBe(document.session.sessionId);
        return "continued";
      });

      await expect(
        main(["--config", configPath, "--continue"], { stdout, stderr, run, stdin }),
      ).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("continued\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--continue 在没有可恢复会话时会明确失败", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      session: {
        enabled: true,
        dir: "sessions",
        save: true,
      },
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createEmptyPipedStdin();
      const run = vi.fn();

      await expect(
        main(["--config", configPath, "--continue"], { stdout, stderr, run, stdin }),
      ).resolves.toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("No saved sessions were found for --continue"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stdout 被重定向且没有 prompt 时会明确失败", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createEmptyPipedStdin();

      await expect(
        main(["--config", configPath], { stdout, stderr, stdin }),
      ).resolves.toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("No prompt was provided"));
      expect(stdout.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a starter config with init --profile minimal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-init-minimal-"));
    const configPath = join(root, "mingxu.config.json");

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["init", "--config", configPath, "--profile", "minimal"], { stdout, stderr })).resolves.toBe(0);
      const created = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(created.defaultModel).toBe("primary");
      expect(created.plugins).toEqual([]);
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Created"));
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a secure-local config with audit and session defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-init-secure-"));
    const configPath = join(root, "mingxu.config.json");

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["init", "--config", configPath, "--profile", "secure-local"], { stdout, stderr })).resolves.toBe(0);
      const created = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
      expect(created.audit?.enabled).toBe(true);
      expect(created.session?.enabled).toBe(true);
      expect(created.runtime?.limits?.maxDurationMs).toBe(60000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing config during init", async () => {
    const { root, configPath } = await writeConfigFile({ existing: true });

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["init", "--config", configPath], { stdout, stderr })).resolves.toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Config file already exists"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("init --force backs up an existing config and preserves sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-init-force-"));
    const configPath = join(root, "mingxu.config.json");
    const sessionDir = join(root, ".mingxu", "sessions");
    const sessionPath = join(sessionDir, "session-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ existing: true }, null, 2), "utf8");
    await writeFile(sessionPath, "{\"sessionId\":\"session-1\"}\n", "utf8");

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["init", "--config", configPath, "--profile", "secure-local", "--force"], { stdout, stderr })).resolves.toBe(0);

      const created = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(created.session).toMatchObject({ enabled: true, save: true });
      expect(created.audit).toMatchObject({ enabled: true });

      const files = await readdir(root);
      const backupName = files.find((name) => name.startsWith("mingxu.config.json.bak-"));
      expect(backupName).toBeDefined();
      const backup = JSON.parse(await readFile(join(root, backupName!), "utf8")) as Record<string, unknown>;
      expect(backup).toEqual({ existing: true });

      const sessionFiles = await readdir(sessionDir);
      expect(sessionFiles).toContain("session-1.jsonl");
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Backup saved to"));
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats stdout EPIPE as a clean exit", async () => {
    const stdout = {
      write: vi.fn(() => {
        const error = new Error("broken pipe") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        throw error;
      }),
    };
    const stderr = { write: vi.fn() };

    await expect(main(["--help"], { stdout, stderr, version: "0.1.0" })).resolves.toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("treats stderr EPIPE as a clean exit", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
    });

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = {
        write: vi.fn(() => {
          const error = new Error("broken pipe") as NodeJS.ErrnoException;
          error.code = "EPIPE";
          throw error;
        }),
      };
      const stdin = createEmptyPipedStdin();

      await expect(main(["--config", configPath], { stdout, stderr, stdin })).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs doctor offline and reports local checks without touching the network", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "env:ANTHROPIC_API_KEY" },
      },
      session: { enabled: true, dir: ".mingxu/sessions" },
      audit: { enabled: true, file: ".mingxu/audit/runtime.jsonl" },
      plugins: [],
    });
    vi.stubGlobal("fetch", vi.fn(async () => createResponse({} as never)) as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const exitCode = await main(["doctor", "--config", configPath], { stdout, stderr });
      expect(exitCode).toBe(1);
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("FAIL secret:primary"));
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("WARN online"));
      expect(stderr.write).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs doctor --online only when explicitly enabled", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "env:ANTHROPIC_API_KEY" },
      },
      plugins: [],
    });
    process.env.ANTHROPIC_API_KEY = "test-key";

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const doctorProbe = vi.fn(async () => {});
      const exitCode = await main(["doctor", "--config", configPath, "--online"], { stdout, stderr, doctorProbe });
      expect(exitCode).toBe(0);
      expect(doctorProbe).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("PASS provider"));
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("WARN online"));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints provider diagnostics only when --debug-provider is enabled", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "test-key" },
      },
      plugins: [],
    });
    const fetchMock = vi.fn(async () => createOpenAiSseResponse("deepseek-live-ok"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const exitCode = await main(["--config", configPath, "--debug-provider", "Reply with exactly: deepseek-live-ok"], { stdout, stderr });
      expect(exitCode).toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("deepseek-live-ok\n");
      expect(stderr.write.mock.calls.some((call) => String(call[0]).includes("cli.selection"))).toBe(true);
      expect(stderr.write.mock.calls.some((call) => String(call[0]).includes("request-builder.model-request"))).toBe(true);
      expect(stderr.write.mock.calls.some((call) => String(call[0]).includes("https://api.deepseek.com/chat/completions"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps provider diagnostics off by default", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: {
        primary: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "test-key" },
      },
      plugins: [],
    });
    const fetchMock = vi.fn(async () => createOpenAiSseResponse("deepseek-live-ok"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const exitCode = await main(["--config", configPath, "Reply with exactly: deepseek-live-ok"], { stdout, stderr });
      expect(exitCode).toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("deepseek-live-ok\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast for blocked plugins declared in config", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-plugin-blocked-"));
    const pluginRoot = join(root, "plugins");
    const configPath = join(root, "mingxu.config.json");
    const pluginPath = join(pluginRoot, "blocked-plugin.mjs");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(pluginPath, `
      export default {
        name: "blocked-plugin",
        manifest: { name: "blocked-plugin", version: "1.0.0", kind: "tool" },
        async setup() {
          throw new Error("should never load");
        },
      };
    `, "utf8");
    await writeFile(configPath, JSON.stringify({
      defaultModel: "primary",
      models: {
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
      },
      plugins: [{ path: "./plugins/blocked-plugin.mjs", trust: "blocked" }],
    }), "utf8");

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const exitCode = await main(["--config", configPath, "Say hello"], { stdout, stderr });
      expect(exitCode).toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Plugin is blocked by configuration"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a custom provider module before creating the selected adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-custom-provider-"));
    const configPath = join(root, "mingxu.config.json");
    const modulePath = join(root, "providers.mjs");
    const moduleSource = `
      export function register(registry) {
        registry.register({
          provider: "local-test",
          capabilities: {
            supportsTools: true,
            supportsStreaming: false,
            supportsImages: false,
            supportsStructuredOutput: false,
            supportsRefusal: false,
            supportsFallback: false,
            supportsEffort: false,
            supportsPromptCaching: false,
            supportsMidConversationSystem: false,
            maxContext: 1000,
            maxOutput: 100,
          },
          create() {
            return {
              provider: "local-test",
              capabilities: this.capabilities,
              async generate() { return { text: "custom answer", toolCalls: [] }; },
            };
          },
        });
      }
    `;
    await writeFile(modulePath, moduleSource, "utf8");
    await writeFile(configPath, JSON.stringify({
      defaultModel: "local",
      models: { local: { provider: "local-test", model: "local-model" } },
      customProviders: { module: "./providers.mjs" },
    }), "utf8");

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("custom answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports custom provider module loading failures", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "local",
      models: { local: { provider: "local-test", model: "local-model" } },
      customProviders: { module: "./missing-provider.mjs" },
    });

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("Unable to import custom provider module"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid default-model and provider references during config loading", async () => {
    const invalidConfigs = [
      {
        defaultModel: "missing",
        models: { primary: { provider: "anthropic", model: "claude-sonnet-5" } },
      },
      {
        defaultModel: "primary",
        models: { primary: { provider: "not-installed", model: "unknown-model" } },
      },
    ];

    for (const invalidConfig of invalidConfigs) {
      const { root, configPath } = await writeConfigFile(invalidConfig);
      try {
        const stdout = { write: vi.fn() };
        const stderr = { write: vi.fn() };
        await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(1);
        expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Error: Invalid config file"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("reports unknown CLI model keys at runtime", async () => {
    const { root, configPath } = await writeConfigFile({
      defaultModel: "primary",
      models: { primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" } },
    });

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(
        main(["--config", configPath, "--model", "missing", "Say hello"], { stdout, stderr }),
      ).resolves.toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Unknown model key: missing"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy single-model config operational", async () => {
    const { root, configPath } = await writeConfigFile({
      model: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
    });
    const fetchMock = vi.fn(async () => createAnthropicSseResponse("legacy answer"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("legacy answer\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams long outputs to stdout while keeping tool logs on stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-streaming-"));
    const configPath = join(root, "mingxu.config.json");
    const providerPath = join(root, "providers.mjs");
    const pluginPath = join(root, "stream-tools.mjs");
    const pluginSource = [
      "const markdownOutput = [",
      "  '## Markdown tool output',",
      "  '',",
      "  '```markdown',",
      "  ' - alpha',",
      "  ' - beta',",
      "  '```',",
      "  '',",
      "  'Command: pnpm test',",
      "].join('\\n');",
      "const diffOutput = [",
      "  '```diff',",
      "  '+ added line',",
      "  '- removed line',",
      "  '```',",
      "].join('\\n');",
      "export default {",
      "  name: 'stream-tools',",
      "  manifest: {",
      "    apiVersion: 'mingxu/plugin-v1',",
      "    id: 'stream-tools',",
      "    name: 'stream-tools',",
      "    version: '1.0.0',",
      "    kind: 'tool',",
      "    adapterId: 'mingxu-native',",
      "    entry: 'index.js',",
      "    contributions: [",
      "      { kind: 'tool', name: 'markdown-tool', description: 'Return markdown output.' },",
      "      { kind: 'tool', name: 'diff-tool', description: 'Return diff output.' },",
      "    ],",
      "  },",
      "  async setup(context) {",
      "    context.registerTool({",
      "      name: 'markdown-tool',",
      "      description: 'Return markdown output.',",
      "      inputSchema: { type: 'object' },",
      "      executionMode: 'parallel',",
      "      async execute() {",
      "        return markdownOutput;",
      "      },",
      "    });",
      "    context.registerTool({",
      "      name: 'diff-tool',",
      "      description: 'Return diff output.',",
      "      inputSchema: { type: 'object' },",
      "      executionMode: 'parallel',",
      "      async execute() {",
      "        return diffOutput;",
      "      },",
      "    });",
      "  },",
      "};",
    ].join("\n");
    const providerSource = [
      "let callCount = 0;",
      "export function register(registry) {",
      "  registry.register({",
      "    provider: 'streaming-test',",
      "    capabilities: {",
      "      supportsTools: true,",
      "      supportsStreaming: true,",
      "      supportsImages: false,",
      "      supportsStructuredOutput: false,",
      "      supportsRefusal: false,",
      "      supportsFallback: false,",
      "      supportsEffort: false,",
      "      supportsPromptCaching: false,",
      "      supportsMidConversationSystem: false,",
      "      maxContext: 1000,",
      "      maxOutput: 100,",
      "    },",
      "    create() {",
      "      return {",
      "        provider: 'streaming-test',",
      "        capabilities: this.capabilities,",
      "        async *stream(request) {",
      "          callCount += 1;",
      "          if (callCount === 1) {",
      "            yield { type: 'start', request };",
      "            for (let index = 0; index < 220; index += 1) {",
      "              yield { type: 'delta', text: `chunk-${String(index).padStart(3, '0')} ` };",
      "            }",
      "            yield { type: 'tool_call', toolCall: { id: 'tool-markdown', name: 'markdown-tool', input: { view: 'markdown' } } };",
      "            yield { type: 'tool_call', toolCall: { id: 'tool-diff', name: 'diff-tool', input: { view: 'diff' } } };",
      "            yield { type: 'end', response: { text: '', toolCalls: [] } };",
      "            return;",
      "          }",
      "          const toolText = request.messages",
      "            .filter((message) => message.role === 'tool')",
      "            .map((message) => message.content)",
      "            .join('\\n\\n');",
      "          yield { type: 'start', request };",
      "          if (toolText) {",
      "            yield { type: 'delta', text: toolText };",
      "          }",
      "          yield { type: 'end', response: { text: toolText, toolCalls: [] } };",
      "        },",
      "      };",
      "    },",
      "  });",
      "}",
    ].join("\n");
    await mkdir(root, { recursive: true });
    await writeFile(providerPath, providerSource, "utf8");
    await writeFile(pluginPath, pluginSource, "utf8");
    await writeFile(configPath, JSON.stringify({
      defaultModel: "stream",
      models: {
        stream: { provider: "streaming-test", model: "stream-model" },
      },
      customProviders: {
        module: "./providers.mjs",
      },
      plugins: [
        { path: "./stream-tools.mjs", trust: "trusted_local", kind: "tool", manifest: "stream-tools" },
      ],
    }), "utf8");

    try {
      const stdout = { write: vi.fn(), isTTY: false };
      const stderr = { write: vi.fn() };
      const stdin = createEmptyPipedStdin();

      await expect(main(["--config", configPath, "Stream me"], { stdout, stderr, stdin })).resolves.toBe(0);

      const stdoutText = stdout.write.mock.calls.map((call) => String(call[0])).join("");
      const stderrText = stderr.write.mock.calls.map((call) => String(call[0])).join("");
      expect(stdoutText).toContain("Markdown tool output");
      expect(stdoutText).toContain("Command: pnpm test");
      expect(stdoutText).toContain("added line");
      expect(stderrText).toContain("[plugin] Loading ./stream-tools.mjs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
