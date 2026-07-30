export const CODING_TOOL_NAMES = ["read", "list", "search", "write", "edit", "command"] as const;

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

export interface CodingToolGovernance {
  readonly kind: "file" | "command";
  readonly action: "read" | "write" | "exec";
  readonly rootDirectory?: string;
  readonly pathField?: string;
  readonly argvField?: string;
  readonly cwdField?: string;
  readonly envFields?: readonly string[];
  readonly timeoutMsField?: string;
  readonly maxOutputBytesField?: string;
}

export interface CodingToolContribution {
  readonly kind: "tool";
  readonly name: CodingToolName;
  readonly description: string;
}

export interface CodingToolsManifestV1 {
  readonly apiVersion: "mingxu/plugin-v1";
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "tool";
  readonly entry: string;
  readonly description: string;
  readonly permissions: {
    readonly files: "read" | "write";
    readonly commands: "allow";
    readonly network: "none";
  };
  readonly contributions: readonly CodingToolContribution[];
}

export interface CodingToolEntry {
  readonly name: CodingToolName;
  readonly description: string;
  readonly governance: CodingToolGovernance;
}

export const codingToolEntries: Record<CodingToolName, CodingToolEntry> = {
  read: {
    name: "read",
    description: "Read a workspace file without changing it.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  list: {
    name: "list",
    description: "List files and directories inside the workspace.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  search: {
    name: "search",
    description: "Search text inside workspace files.",
    governance: {
      kind: "file",
      action: "read",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  write: {
    name: "write",
    description: "Write a new workspace file.",
    governance: {
      kind: "file",
      action: "write",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  edit: {
    name: "edit",
    description: "Edit an existing workspace file.",
    governance: {
      kind: "file",
      action: "write",
      rootDirectory: "workspace",
      pathField: "path",
    },
  },
  command: {
    name: "command",
    description: "Run a workspace-scoped command with explicit argv.",
    governance: {
      kind: "command",
      action: "exec",
      argvField: "argv",
      cwdField: "cwd",
      envFields: ["PATH"],
      timeoutMsField: "timeoutMs",
      maxOutputBytesField: "maxOutputBytes",
    },
  },
};

export const codingToolsManifest: CodingToolsManifestV1 = {
  apiVersion: "mingxu/plugin-v1",
  id: "mingxu-coding-tools",
  name: "MingXu Coding Tools",
  version: "0.4.0",
  kind: "tool",
  entry: "dist/index.js",
  description: "Official coding tools plugin skeleton for workspace-scoped file and command actions.",
  permissions: {
    files: "write",
    commands: "allow",
    network: "none",
  },
  contributions: CODING_TOOL_NAMES.map((name) => ({
    kind: "tool",
    name,
    description: codingToolEntries[name].description,
  })),
};
