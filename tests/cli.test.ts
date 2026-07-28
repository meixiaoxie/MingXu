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

  it("loads config and forwards it to a custom runner", async () => {
    const { root, configPath } = await writeConfigFile({
      systemPrompt: "Be concise",
      model: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "test-key",
      },
    });

    try {
      const run = vi.fn(async (config, prompt?: string) => {
        expect(config).toMatchObject({
          name: "mingxu",
          systemPrompt: "Be concise",
          maxIterations: 10,
          plugins: [],
          model: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            apiKey: "test-key",
          },
        });
        expect(prompt).toBe("Say hello");
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

  it("runs the default Anthropic-backed runner end to end", async () => {
    const { root, configPath } = await writeConfigFile({
      systemPrompt: "Be concise",
      model: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "test-key",
      },
    });

    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}")).toMatchObject({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: "Be concise",
        messages: [{ role: "user", content: "Say hello" }],
      });
      return createResponse({
        content: [{ type: "text", text: "final answer" }],
        stop_reason: "end_turn",
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };

      await expect(
        main(["--config", configPath, "Say hello"], { stdout, stderr }),
      ).resolves.toBe(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(stdout.write).toHaveBeenCalledWith("final answer\n");
      expect(stderr.write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
