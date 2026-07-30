const manifest = {
  apiVersion: "mingxu/plugin-v1",
  id: "mingxu-coding-tools",
  name: "MingXu Coding Tools",
  version: "0.4.0",
  kind: "tool",
  adapterId: "mingxu-native",
  entry: "index.js",
  description: "Official coding tools plugin skeleton for workspace-scoped file and command actions.",
  permissions: {
    files: "write",
    commands: "allow",
    network: "none",
  },
  contributions: [
    { kind: "tool", name: "read", description: "Read a workspace file without changing it." },
    { kind: "tool", name: "list", description: "List files and directories inside the workspace." },
    { kind: "tool", name: "search", description: "Search text inside workspace files." },
    { kind: "tool", name: "write", description: "Write a new workspace file." },
    { kind: "tool", name: "edit", description: "Edit an existing workspace file." },
    { kind: "tool", name: "command", description: "Run a workspace-scoped command with explicit argv." },
  ],
};

function createTool(name, description, governance, riskLevel = "low") {
  return {
    name,
    description,
    inputSchema: { type: "object" },
    kind: governance.kind === "command" ? "command" : "file",
    riskLevel,
    policyRootDirectory: "workspace",
    governance,
    async execute() {
      throw new Error(`coding-tools skeleton: ${name} is not implemented yet`);
    },
  };
}

const toolDefinitions = [
  createTool("read", "Read a workspace file without changing it.", {
    kind: "file",
    action: "read",
    rootDirectory: "workspace",
    pathField: "path",
  }),
  createTool("list", "List files and directories inside the workspace.", {
    kind: "file",
    action: "read",
    rootDirectory: "workspace",
    pathField: "path",
  }),
  createTool("search", "Search text inside workspace files.", {
    kind: "file",
    action: "read",
    rootDirectory: "workspace",
    pathField: "path",
  }),
  createTool("write", "Write a new workspace file.", {
    kind: "file",
    action: "write",
    rootDirectory: "workspace",
    pathField: "path",
  }, "high"),
  createTool("edit", "Edit an existing workspace file.", {
    kind: "file",
    action: "write",
    rootDirectory: "workspace",
    pathField: "path",
  }, "high"),
  createTool("command", "Run a workspace-scoped command with explicit argv.", {
    kind: "command",
    action: "exec",
    argvField: "argv",
    cwdField: "cwd",
    envFields: ["PATH"],
    timeoutMsField: "timeoutMs",
    maxOutputBytesField: "maxOutputBytes",
  }, "high"),
];

export { manifest };
export default {
  name: manifest.name,
  manifest,
  async setup(context) {
    for (const tool of toolDefinitions) {
      context.registerTool(tool);
    }
  },
};
