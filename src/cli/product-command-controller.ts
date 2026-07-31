import { CHAT_COMMANDS } from "./chat-commands.js";
import { CommandController } from "./command-controller.js";
import type { ProductScreen } from "./product-screen.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

export function createProductCommandController(options: {
  readonly adapter: RuntimeAdapter;
  readonly screen: ProductScreen;
  readonly exit: () => void;
  readonly requestRender: () => void;
}): CommandController {
  const controller = new CommandController(CHAT_COMMANDS);
  controller.register("help", () => options.screen.openHelp(controller.help().split("\n")));
  controller.register("status", () => options.screen.openStatus());
  controller.register("model", async ({ args }) => {
    if (args) {
      await options.adapter.switchSession({ modelKey: args });
      options.screen.closePanels();
    } else options.screen.openModels();
  });
  controller.register("tools", () => options.screen.openText("tools", (options.adapter.session.state.tools ?? []).map((tool) => tool.name)));
  controller.register("context", () => options.screen.openContext());
  controller.register("extensions", () => options.screen.openExtensions());
  controller.register("agents", () => options.screen.openAgents());
  controller.register("audit", () => options.screen.openAudit());
  controller.register("trust", () => options.screen.openTrust());
  controller.register("preset", () => options.screen.openPresets());
  controller.register("compact", () => options.adapter.addStatus("compact", ["Conversation compaction is managed by the runtime."]));
  controller.register("steer", ({ args }) => {
    if (!args) options.adapter.addStatus("steer", ["Usage: /steer [text]"]);
    else {
      options.adapter.steer(args);
      options.adapter.addStatus("steer", ["Queued steering instruction for the next model turn."]);
    }
  });
  controller.register("session", () => options.screen.openStatus());
  controller.register("sessions", () => options.screen.openSessions());
  controller.register("resume", async ({ args }) => {
    if (args) {
      await options.adapter.switchSession({ sessionId: args });
      options.screen.closePanels();
    } else options.screen.openSessions();
  });
  controller.register("new", async () => {
    await options.adapter.switchSession({});
    options.screen.closePanels();
  });
  controller.register("clear", () => {
    options.adapter.clearPresentation();
    options.screen.showWelcome();
    options.requestRender();
  });
  controller.register("exit", options.exit);
  controller.validate();
  return controller;
}
