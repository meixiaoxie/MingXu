import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/main.js";

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

async function writeConfigFile(config: unknown) {
  const root = await mkdtemp(join(tmpdir(), "mingxu-cli-"));
  const configPath = join(root, "mingxu.config.json");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return { root, configPath };
}

describe("mingxu CLI", () => {
  it("prints help and version information", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(main(["--help"], { stdout, stderr, version: "0.1.0" })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Usage: mingxu"));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("--model <name>"));
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
      expect(JSON.parse(init.body ?? "{}")).toMatchObject({
        model: "claude-sonnet-5",
        system: "Be concise",
        messages: [{ role: "user", content: "Say hello" }],
      });
      return createResponse({
        content: [{ type: "text", text: "selected answer" }],
        stop_reason: "end_turn",
      });
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
      expect(JSON.parse(init.body ?? "{}")).toMatchObject({ model: "gpt-test" });
      return createResponse({ choices: [{ message: { content: "gateway answer" } }] });
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
    const fetchMock = vi.fn(async () => createResponse({
      choices: [{ message: { content: "alias answer" } }],
    }));
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
    const fetchMock = vi.fn(async () => createResponse({
      choices: [{ message: { content: "deepseek-live-ok" } }],
    }));
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
    const fetchMock = vi.fn(async () => createResponse({
      choices: [{ message: { content: "deepseek-live-ok" } }],
    }));
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
    const fetchMock = vi.fn(async () => createResponse({
      content: [{ type: "text", text: "legacy answer" }],
      stop_reason: "end_turn",
    }));
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
});
