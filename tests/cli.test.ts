import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        primary: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
        backup: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "backup-key" },
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

  it("uses defaultModel when running the default provider pipeline", async () => {
    const { root, configPath } = await writeConfigFile({
      systemPrompt: "Be concise",
      defaultModel: "selected",
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
      await expect(main(["--config", configPath, "Say hello"], { stdout, stderr })).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(stdout.write).toHaveBeenCalledWith("selected answer\n");
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
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy single-model config selectable through the normalized default key", async () => {
    const { root, configPath } = await writeConfigFile({
      model: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test-key" },
    });
    const fetchMock = vi.fn(async () => createResponse({
      content: [{ type: "text", text: "legacy override answer" }],
      stop_reason: "end_turn",
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(
        main(["--config", configPath, "--model", "default", "Say hello"], { stdout, stderr }),
      ).resolves.toBe(0);
      expect(stdout.write).toHaveBeenCalledWith("legacy override answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
