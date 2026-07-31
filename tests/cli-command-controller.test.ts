import { describe, expect, it, vi } from "vitest";

import { CHAT_COMMANDS, formatChatHelp, suggestChatCommands } from "../src/cli/chat-commands.js";
import { CommandController } from "../src/cli/command-controller.js";

describe("R5 CommandController", () => {
  it("keeps registry, help, completion, aliases, and dispatch aligned", async () => {
    const controller = new CommandController(CHAT_COMMANDS);
    const handled: string[] = [];
    for (const command of CHAT_COMMANDS) {
      controller.register(command.name, ({ name, args }) => {
        handled.push(`${name}:${args}`);
      });
    }

    expect(() => controller.validate()).not.toThrow();
    expect(controller.commands).toEqual(CHAT_COMMANDS);
    expect(controller.help()).toBe(formatChatHelp());
    expect(controller.suggestions("/e")).toEqual(suggestChatCommands("/e"));

    for (const command of CHAT_COMMANDS) {
      await expect(controller.dispatch(`${command.usage.split(" ")[0]} value`)).resolves.toMatchObject({
        status: "handled",
        command,
      });
    }
    await expect(controller.dispatch("/? alias-value")).resolves.toMatchObject({
      status: "handled",
      command: CHAT_COMMANDS[0],
    });
    expect(handled).toContain("help:alias-value");
    expect(handled).toHaveLength(CHAT_COMMANDS.length + 1);
  });

  it("reports invalid, unknown, unavailable, and rejected async commands", async () => {
    const unavailable = new CommandController(CHAT_COMMANDS);
    await expect(unavailable.dispatch("plain text")).resolves.toEqual({ status: "invalid" });
    await expect(unavailable.dispatch("/does-not-exist")).resolves.toEqual({ status: "unknown" });
    await expect(unavailable.dispatch("/help")).resolves.toMatchObject({
      status: "error",
      error: "Command is not available: /help",
    });
    expect(() => unavailable.validate()).toThrow("Missing command handlers");

    const controller = new CommandController([{ name: "async", aliases: [], usage: "/async", description: "test" }]);
    const handler = vi.fn(async () => {
      throw new Error("async failure");
    });
    controller.register("async", handler);
    await expect(controller.dispatch("/async")).resolves.toMatchObject({ status: "error", error: "async failure" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects duplicate names, aliases, and handler registration", () => {
    expect(() => new CommandController([
      { name: "one", aliases: ["shared"], usage: "/one", description: "one" },
      { name: "shared", aliases: [], usage: "/shared", description: "shared" },
    ])).toThrow("Duplicate command name or alias: shared");

    const controller = new CommandController(CHAT_COMMANDS);
    controller.register("help", () => undefined);
    expect(() => controller.register("help", () => undefined)).toThrow("already registered");
    expect(() => controller.register("?", () => undefined)).toThrow("unknown or aliased");
  });
});
