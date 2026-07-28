import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/main.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

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

  it("runs the agent loop end to end with Anthropic-style responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingxu-cli-"));
    const configPath = join(root, "mingxu.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        model: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          apiKey: "test-key",
        },
      }),
      "utf8",
    );

    const responses = [
      {
        content: [
          { type: "text", text: "I will call a tool." },
          { type: "tool_use", id: "call-1", name: "echo", input: { message: "hello" } },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "final answer" }],
        stop_reason: "end",
      },
    ];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { messages: unknown[]; tools?: Array<{ name: string }> };
      if (fetchMock.mock.calls.length === 1) {
        expect(request.messages).toEqual([{ role: "user", content: "Say hello" }]);
        expect(request.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["echo", "readFile"]));
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return responses.shift();
        },
      };
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(
      main(["--config", configPath, "Say hello"], { stdout, stderr }),
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stdout.write).toHaveBeenCalledWith("final answer\n");
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
