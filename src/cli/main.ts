import { dirname, isAbsolute, resolve } from "node:path";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { AgentSession } from "../core/agent-session.js";
import type { PluginConfig, ResolvedAgentConfig } from "../config/config-schema.js";
import { resolveAgentConfig } from "../config/index.js";
import { loadConfig } from "../config/load-config.js";
import { loadCustomProviderModule } from "../models/custom-provider-loader.js";
import { ProviderRegistry } from "../models/provider-registry.js";
import { registerBuiltinProviders } from "../models/provider-catalog.js";
import { createRuntimeModelProvider } from "../models/model-runtime.js";
import { createRuntimeStreamFn } from "../models/request-builder.js";
import { PluginLoader, resolvePluginLoadRequest } from "../plugins/plugin-loader.js";
import { createLoadResourceTool } from "../tools/builtin/load-resource-tool.js";
import { createSpawnSubagentTool } from "../tools/builtin/spawn-subagent-tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Tool } from "../core/types.js";
import { parseArgs } from "./parse-args.js";
import { discoverCliConfig, getGlobalConfigPath, getProjectConfigPath, getUserConfigDir, setProjectTrust } from "./config-discovery.js";
import { JsonlAuditWriter } from "../audit/jsonl-audit-writer.js";
import type { EventSink } from "../events/event-sink.js";
import { NoopEventSink } from "../events/event-sink.js";
import { redactText } from "../redaction/redactor.js";
import { parseSecretRef } from "../redaction/secret-ref.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import { createInitConfig, renderInitConfig, type InitProfile } from "./init-config.js";
import { runDoctor } from "./doctor.js";
import { createProviderDebugLogger } from "./provider-debug.js";
import { InstructionLoader } from "../instructions/instruction-loader.js";
import { FileMemoryStore } from "../memory/file-memory-store.js";
import { ResourceLoader } from "../resources/resource-loader.js";
import { ResourceRegistry } from "../resources/resource-registry.js";
import type { ResourceVisibility } from "../resources/resource-types.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { AgentPresetRegistry } from "../presets/agent-preset-registry.js";
import { McpClientManager } from "../mcp/mcp-client-manager.js";
import type { McpServerConfig, McpToolPolicy, McpTransportKind } from "../mcp/mcp-client-manager.js";
import { SubagentManager, filterPresetTools } from "../subagents/subagent-manager.js";
import { assertSafeLocalPath } from "../safety/path-safety.js";
import type { InstructionLoaderOptions, InstructionRootConfig } from "../instructions/instruction-loader.js";
import type { AgentLoopResult } from "../core/types.js";
import { ExtensionManager } from "../extensions/extension-manager.js";
import { MINGXU_IDENTITY_PROMPT } from "./identity.js";
import { ChatInputController } from "./chat-input.js";
import { findChatCommand, formatChatHelp, suggestChatCommands } from "./chat-commands.js";
import { CliRuntimeProjection } from "./runtime-projection.js";
import type { CliRuntimeContext, CliRuntimeSnapshot, CliSessionRequest } from "./runtime-types.js";
import { CliTuiApp } from "./tui-app.js";
import { ProcessTerminal } from "@mingxu/tui";

export interface CliDependencies {
  run?: (
    config: ResolvedAgentConfig,
    prompt?: string,
    modelKey?: string,
    sessionId?: string,
  ) => Promise<string | void | AgentLoopResult>;
  listSessions?: (config: ResolvedAgentConfig) => Promise<string>;
  doctorProbe?: (config: ResolvedAgentConfig) => Promise<void>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdin?: NodeJS.ReadStream;
  terminalFactory?: (stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream) => ProcessTerminal;
  version?: string;
  debugProvider?: boolean;
}

const HELP_TEXT = `Usage: mingxu [options] [prompt]\n\nCommands:\n  init                    Create a starter config\n  chat [prompt]           Enter interactive chat mode\n  doctor                  Check config, env, plugins, session, and audit wiring\n  resume [sessionId]      Resume a saved session and continue with a new prompt\n  sessions                List recent sessions\n  extensions [action]     Inspect and manage installed extensions\n\nExtensions actions:\n  inspect <source>        Inspect an extension source without installing\n  add <source>            Install an extension as disabled by default\n  update <id> [source]    Update an installed extension\n  enable <id>             Enable an installed extension\n  disable <id>            Disable an installed extension\n  remove <id>             Remove a disabled extension\n  list                    List installed extensions\n  doctor                  Diagnose extension installation health\n  init <directory>        Create an extension skeleton\n\nOptions:\n  -c, --config <path>     JSON configuration file\n  -p, --prompt <text>     Prompt to send to the agent\n  -m, --model <name>      Named model from config.models\n      --continue          Resume the latest session in the current workspace\n      --yes               Skip confirmation for extension install/update\n      --force             Back up and overwrite an existing init config\n      --temporary         Apply enable/disable only for the current process\n      --scope <scope>     Target extension scope: user or project\n      --global            Write init output to the global config location\n      --project           Write init output to the project config location\n      --no-global-config  Ignore the global config layer\n      --trust-project     Trust the detected project config layer\n      --no-trust-project  Ignore the detected project config layer\n      --profile <name>    Init profile: minimal or secure-local\n      --plain             Disable ANSI styling in the interactive transcript\n      --online            Allow doctor to perform a live provider connectivity probe\n      --debug-provider    Print resolved provider config and request diagnostics to stderr\n  -h, --help              Show this help\n  -v, --version           Show the version\n`;

type MutableInstructionLoaderOptions = {
  systemPrompt?: string;
  managed?: InstructionRootConfig;
  user?: InstructionRootConfig;
  project?: InstructionRootConfig;
  local?: InstructionRootConfig;
  session?: InstructionRootConfig;
  autoLoadClaudeMd?: boolean;
  maxInstructionBytes?: number;
  maxTotalBytes?: number;
};

type McpToolPolicyInput = {
  riskLevel?: "low" | "high" | undefined;
  executionMode?: "sequential" | "parallel" | undefined;
};

export async function main(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const createTerminal = dependencies.terminalFactory
    ?? ((terminalStdin: NodeJS.ReadStream, terminalStdout: NodeJS.WriteStream) => new ProcessTerminal(terminalStdin, terminalStdout));

  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }
    if (args.version) {
      stdout.write(`${dependencies.version ?? "development"}\n`);
      return 0;
    }
    if (args.command === "init") {
      const initPath = args.initScope === "global" ? getGlobalConfigPath() : args.configPath;
      const result = await initializeConfig(initPath, args.profile ?? "minimal", args.force ?? false);
      stdout.write(`${result}\n`);
      return 0;
    }
    if (args.command === "extensions" && args.commandTarget === "init") {
      const targetDir = args.commandArgs?.[0] ?? args.prompt ?? resolve(process.cwd(), "sample-extension");
      const manager = new ExtensionManager({
        userRoot: getUserConfigDir(),
        projectRoot: resolve(process.cwd(), ".mingxu"),
      });
      const result = await manager.initSkeleton(targetDir, args.commandArgs?.[1] ?? "sample-extension");
      stdout.write(`${result}\n`);
      return 0;
    }

    const configDiscovery = args.configProvided
      ? {
          config: await loadConfig(args.configPath),
          sources: [{ kind: "explicit" as const, path: resolve(args.configPath) }],
          projectTrusted: true,
        }
      : await discoverCliConfig({
          cwd: process.cwd(),
          noGlobalConfig: args.noGlobalConfig ?? false,
          trustProject: args.trustProject ?? false,
          noTrustProject: args.noTrustProject ?? false,
        });

    if (!configDiscovery) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runFirstLaunchWizard(stdout);
        return 0;
      }
      throw new Error(`No configuration found. Run "mingxu init --global"`);
    }

    const config = configDiscovery.config;
    const configFilePath = args.configProvided
      ? args.configPath
      : (configDiscovery.sources.at(-1)?.path ?? process.cwd());
    const continueSessionId = args.continueMode
      ? await resolveContinueSessionId(config, configFilePath)
      : undefined;
    const run = dependencies.run ?? createDefaultRunner(
      configFilePath,
      stderr,
      args.debugProvider ?? dependencies.debugProvider ?? false,
      configDiscovery.projectTrusted,
    );
    const listSessions = dependencies.listSessions ?? createSessionLister(configFilePath);

    if (args.command === "sessions") {
      const result = await listSessions(config);
      stdout.write(`${result}\n`);
      return 0;
    }

    if (args.command === "doctor") {
      const result = await runDoctor({
        config,
        configPath: configFilePath,
        online: args.online ?? false,
      }, {
        ...(dependencies.doctorProbe !== undefined ? { fetchProbe: dependencies.doctorProbe } : {}),
      });
      stdout.write(`${result.output}\n`);
      return result.ok ? 0 : 1;
    }

    if (args.command === "extensions") {
      const result = await handleExtensionsCommand({
        args,
        config,
        configFilePath,
        projectTrusted: configDiscovery.projectTrusted,
      });
      stdout.write(`${result.output}\n`);
      return result.exitCode;
    }

    const interactiveTerminal = supportsInteractiveTui(stdin, stdout);
    const stdinPrompt = !interactiveTerminal
      && !isTTYStream(stdin)
      && args.prompt === undefined
      && shouldReadStdinPrompt(args.command)
      ? await readStdinPrompt(stdin)
      : undefined;
    const effectivePrompt = args.prompt ?? stdinPrompt?.trim();
    const resumeSessionId = args.command === "resume"
      ? (args.commandTarget ?? continueSessionId)
      : continueSessionId;

    if (args.continueMode && resumeSessionId === undefined) {
      stderr.write("No saved sessions were found for --continue. Start a session first, or use /new for a fresh chat.\n");
      return 1;
    }

    if (
      interactiveTerminal
      && (
        args.command === "chat"
        || (args.command === "resume" && !args.prompt)
        || (args.command === undefined && !args.prompt)
        || (args.continueMode && !args.prompt)
      )
    ) {
      const chatResult = await runChatLoop({
        config,
        configFilePath,
        run,
        listSessions,
        stdout,
        stderr,
        stdin,
        terminalOutput: stdout as NodeJS.WriteStream,
        projectTrusted: configDiscovery.projectTrusted,
        configSources: configDiscovery.sources,
        createTerminal,
        ...(args.plain ? { plain: true } : {}),
        ...(args.model !== undefined ? { modelKey: args.model } : {}),
        ...(args.prompt !== undefined ? { initialPrompt: args.prompt } : {}),
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      });
      if (chatResult.exitCode !== 0) {
        return chatResult.exitCode;
      }
      return 0;
    }

    if (args.command === "resume" && args.commandTarget === undefined && resumeSessionId === undefined) {
      stderr.write("resume without a session id requires an interactive terminal. Pass <sessionId> when stdin/stdout are redirected.\n");
      return 1;
    }

    if (shouldUseOneShotFallback(args.command, effectivePrompt)) {
      const result = await run(
        config,
        effectivePrompt,
        args.model,
        resumeSessionId,
      );
      const normalizedResult = normalizeRunResult(result);
      if (normalizedResult !== undefined) stdout.write(`${normalizedResult.content}\n`);
      return 0;
    }

    stderr.write(`${formatNonInteractivePromptError(args.command)}\n`);
    return 1;
  } catch (error) {
    if (isBrokenPipeError(error)) {
      return 0;
    }
    const message = redactText(error instanceof Error ? error.message : String(error));
    try {
      stderr.write(`Error: ${message}\n`);
    } catch (writeError) {
      if (isBrokenPipeError(writeError)) {
        return 0;
      }
      throw writeError;
    }
    return 1;
  }
}

function shouldReadStdinPrompt(command: string | undefined): boolean {
  return command === "chat" || command === "resume" || command === undefined;
}

function shouldUseOneShotFallback(command: string | undefined, prompt: string | undefined): boolean {
  if (prompt === undefined || prompt.trim().length === 0) {
    return false;
  }
  return command === undefined || command === "chat" || command === "resume";
}

function formatNonInteractivePromptError(command: string | undefined): string {
  switch (command) {
    case "chat":
      return "chat mode requires a compatible interactive terminal or a prompt. Pipe text in or pass --prompt.";
    case "resume":
      return "resume requires a compatible interactive terminal or a prompt. Pipe text in or pass --prompt.";
    default:
      return "No prompt was provided. Pipe text in, pass --prompt, or run mingxu in an interactive terminal.";
  }
}

function isTTYStream(stream: Pick<NodeJS.WriteStream, "write"> | NodeJS.ReadStream): boolean {
  return Boolean((stream as NodeJS.WriteStream).isTTY);
}

function supportsInteractiveTui(
  stdin: NodeJS.ReadStream,
  stdout: Pick<NodeJS.WriteStream, "write">,
): boolean {
  return isTTYStream(stdin)
    && isTTYStream(stdout)
    && typeof stdin.setRawMode === "function"
    && process.env.TERM?.toLowerCase() !== "dumb";
}

async function resolveContinueSessionId(
  config: ResolvedAgentConfig,
  configFilePath: string,
): Promise<string | undefined> {
  const sessionStore = await createSessionStore(config, configFilePath);
  if (!sessionStore) {
    return undefined;
  }
  const recentSessions = await sessionStore.listRecentSessions(1);
  return recentSessions[0]?.sessionId;
}

async function readStdinPrompt(stdin: NodeJS.ReadStream): Promise<string | undefined> {
  if (stdin.isTTY) {
    return undefined;
  }
  stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += chunk;
  }
  return buffer.length > 0 ? buffer : undefined;
}

function normalizeRunResult(result: string | void | AgentLoopResult | undefined): AgentLoopResult | undefined {
  if (result === undefined) {
    return undefined;
  }
  if (typeof result === "string") {
    return {
      content: result,
      messages: [],
      iterations: 0,
      terminationReason: "completed",
    };
  }
  if (typeof result === "object" && result !== null && "content" in result && typeof (result as { content?: unknown }).content === "string") {
    return result as AgentLoopResult;
  }
  return undefined;
}

async function runChatLoop(options: {
  config: ResolvedAgentConfig;
  configFilePath: string;
  run: NonNullable<CliDependencies["run"]>;
  listSessions: NonNullable<CliDependencies["listSessions"]>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin: NodeJS.ReadStream;
  terminalOutput: NodeJS.WriteStream;
  projectTrusted: boolean;
  configSources: readonly { kind: "explicit" | "global" | "project"; path: string }[];
  createTerminal: (stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream) => ProcessTerminal;
  plain?: boolean;
  modelKey?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
}): Promise<{ exitCode: number }> {
  void options.run;
  void options.listSessions;
  let app: CliTuiApp | undefined;
  const runtime = await createCliRuntimeContext({
    config: options.config,
    configFilePath: options.configFilePath,
    stderr: options.stderr,
    projectTrusted: options.projectTrusted,
    configSources: options.configSources,
    approvalHandler: (prompt) => app?.openApproval(prompt),
    principalId: "local-user",
    interactive: true,
  });
  let currentModelKey = options.modelKey;
  let currentSessionId = options.resumeSessionId;
  try {
    options.stdout.write("mingxu chat. Type /help for commands.\n");
    const session = runtime.createSession({
      ...(currentModelKey !== undefined ? { modelKey: currentModelKey } : {}),
      ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
      interactive: true,
      approvalHandler: (prompt) => app?.openApproval(prompt),
    });
    app = new CliTuiApp({
      runtime,
      terminal: options.createTerminal(options.stdin, options.terminalOutput),
      session,
      ...(options.plain ? { plain: true } : {}),
      ...(currentModelKey !== undefined ? { modelKey: currentModelKey } : {}),
      ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
    });
    const exitCode = await app.start(options.initialPrompt?.trim());
    if (app.currentModelKey) {
      currentModelKey = app.currentModelKey;
    }
    if (app.currentSessionId) {
      currentSessionId = app.currentSessionId;
    }
    return { exitCode };
  } finally {
    await runtime.close();
  }
}

async function runFirstLaunchWizard(stdout: Pick<NodeJS.WriteStream, "write">): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const provider = (await rl.question("Provider [anthropic]: ")).trim() || "anthropic";
    const model = (await rl.question("Model id [claude-sonnet-5]: ")).trim() || "claude-sonnet-5";
    const apiKeyEnv = (await rl.question(`Environment variable [${defaultApiKeyEnv(provider)}]: `)).trim() || defaultApiKeyEnv(provider);
    const profile = {
      name: "mingxu",
      systemPrompt: MINGXU_IDENTITY_PROMPT,
      defaultModel: "primary",
      models: {
        primary: {
          provider,
          model,
          apiKey: `env:${apiKeyEnv}`,
        },
      },
      maxIterations: 10,
      plugins: [],
      session: {
        enabled: true,
        dir: ".mingxu/sessions",
        save: true,
      },
      audit: {
        enabled: true,
        file: ".mingxu/audit/runtime.jsonl",
      },
    };
    resolveAgentConfig(profile);
    const configPath = getGlobalConfigPath();
    await writeFile(configPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    stdout.write(`Wrote starter config to ${configPath}\n`);
    return configPath;
  } finally {
    rl.close();
  }
}

function defaultApiKeyEnv(provider: string): string {
  const normalized = provider.replace(/[^a-zA-Z0-9]/gu, "_").toUpperCase();
  return `${normalized || "PROVIDER"}_API_KEY`;
}

function createDefaultRunner(
  configFilePath: string,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
  debugProvider = false,
  projectTrusted = false,
): NonNullable<CliDependencies["run"]> {
  return async (config, prompt, modelKey, sessionId) => {
    const providerDebug = createProviderDebugLogger({
      enabled: debugProvider || process.env.MINGXU_DEBUG_PROVIDER === "1",
      sink: stderr,
    });
    const agentPrompt = prompt?.trim();
    if (!agentPrompt) {
      throw new Error("A prompt is required");
    }

    const configDir = dirname(resolve(configFilePath));
    const eventSink = createEventSink(config, configDir);
    const userHome = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
    const sessionDirectory = resolveSessionDirectory(config, configFilePath);
    const instructionPrompt = await new InstructionLoader(
      resolveInstructionLoaderOptions(config, configDir, userHome, sessionDirectory),
    ).build();
    const secretRefs = collectSecretRefs(config);
    const sessionStore = await createSessionStore(config, configFilePath, sessionId);
    const memoryManager = createConfiguredMemoryManager(config, configDir, userHome);
    const resourceRegistry = new ResourceRegistry();
    const resourceLoader = new ResourceLoader({
      registry: resourceRegistry,
      eventSink,
      ...(sessionId !== undefined ? { sessionId } : {}),
      runId: "cli",
    });
    const skillRegistry = new SkillRegistry();
    await loadConfiguredSkills(skillRegistry, resourceRegistry, config, configDir);
    const presetRegistry = new AgentPresetRegistry();
    loadConfiguredPresets(presetRegistry, config);

    const toolRegistry = new ToolRegistry();

    const providerRegistry = registerBuiltinProviders(new ProviderRegistry(), config.providerAliases);
    if (config.customProviderModule !== undefined) {
      await loadCustomProviderModule({
        modulePath: config.customProviderModule,
        configFilePath,
        registry: providerRegistry,
      });
    }
    for (const provider of Object.values(config.customProviders)) {
      await loadCustomProviderModule({
        modulePath: provider.module,
        configFilePath,
        registry: providerRegistry,
      });
    }

    const mcpManager = new McpClientManager({
      toolRegistry,
      resourceRegistry,
      eventSink,
      ...(sessionId !== undefined ? { sessionId } : {}),
      runId: "cli",
    });
    for (const [name, mcpServer] of Object.entries(config.mcpServers ?? {})) {
      mcpManager.registerServer(name, normalizeMcpServerConfig(mcpServer));
    }

    try {
      await mcpManager.connectAll();

      const pluginLoader = new PluginLoader({
        registerTool: (tool: Tool) => {
          toolRegistry.register(tool);
        },
        unregisterTool: (name: string) => toolRegistry.unregister(name),
        eventSink,
      });
      for (const plugin of config.plugins) {
        const pluginSource = await resolvePluginLoadRequest({
          path: plugin.path,
          trust: plugin.trust,
          configFilePath,
        });
        reportPluginLoad(stderr, plugin, pluginSource.resolvedPath);
        await pluginLoader.load({
          path: plugin.path,
          trust: plugin.trust,
          configFilePath,
          ...(plugin.kind !== undefined ? { kind: plugin.kind } : {}),
          ...(plugin.manifest !== undefined ? { manifest: plugin.manifest } : {}),
        });
      }

      const extensionManager = new ExtensionManager({
        userRoot: getUserConfigDir(),
        projectRoot: resolve(dirname(resolve(configFilePath)), ".mingxu"),
        projectTrusted,
      });
      await extensionManager.loadEnabledExtensions(pluginLoader, projectTrusted ? undefined : "user");

      const { selection, adapter } = providerRegistry.createFromConfig(config, modelKey, {
        debug: providerDebug,
      });
      providerDebug.log("cli.selection", {
        requestedModelKey: modelKey,
        selectedModelKey: selection.modelKey,
        adapterProvider: adapter.provider,
        model: selection.model,
        provider: selection.provider,
      });

      const runtimeModel = createRuntimeModelProvider(adapter, selection.model, providerDebug);
      const runtimeStreamFn = createRuntimeStreamFn(adapter, selection.model, providerDebug);
      const selectedPreset = config.defaultPreset !== undefined ? presetRegistry.get(config.defaultPreset) : undefined;
      if (config.defaultPreset !== undefined && !selectedPreset) {
        throw new Error(`Unknown default preset: ${config.defaultPreset}`);
      }

      const subagentManager = new SubagentManager({
        presets: presetRegistry,
        createSession: ({ preset, sessionId: childSessionId }) => new AgentSession({
          model: runtimeModel,
          streamFn: runtimeStreamFn,
          tools: filterPresetTools(preset, toolRegistry.list()),
          ...(preset.systemPrompt !== undefined
            ? { systemPrompt: combinePrompts(instructionPrompt, preset.systemPrompt) }
            : { systemPrompt: instructionPrompt }),
          maxIterations: preset.maxIterations ?? config.maxIterations,
          ...(sessionStore !== undefined ? { sessionStore } : {}),
          sessionId: childSessionId,
          memoryManager,
          eventSink,
          audit: {
            ...(config.audit?.failClosedForHighRisk !== undefined
              ? { failClosedForHighRisk: config.audit.failClosedForHighRisk }
              : {}),
          },
          secretRefs,
        }),
        ...(config.subagents !== undefined ? config.subagents : {}),
      });
      if (config.subagents?.enabled === true && (presetRegistry.list().length > 0 || config.defaultPreset !== undefined)) {
        toolRegistry.register(createSpawnSubagentTool({
          manager: subagentManager,
          ...(config.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
        }));
      }

      const runtimeTools = [...toolRegistry.list()];
      if (resourceRegistry.list().length > 0) {
        runtimeTools.push(createLoadResourceTool({ resourceLoader }));
      }
      const sessionTools = selectedPreset ? filterPresetTools(selectedPreset, runtimeTools) : runtimeTools;
      const sessionSystemPrompt = combinePrompts(instructionPrompt, selectedPreset?.systemPrompt);
      const session = new AgentSession({
        model: runtimeModel,
        streamFn: runtimeStreamFn,
        tools: sessionTools,
        ...(sessionSystemPrompt ? { systemPrompt: sessionSystemPrompt } : {}),
        maxIterations: selectedPreset?.maxIterations ?? config.maxIterations,
        ...(sessionStore !== undefined ? { sessionStore } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        memoryManager,
        eventSink,
        audit: {
          ...(config.audit?.failClosedForHighRisk !== undefined
            ? { failClosedForHighRisk: config.audit.failClosedForHighRisk }
            : {}),
        },
        secretRefs,
      });

      const result = await session.prompt(agentPrompt);
      return result;
    } finally {
      await mcpManager.close();
      await eventSink.flush?.();
      await eventSink.close?.();
    }
  };
}

async function createCliRuntimeContext(options: {
  readonly config: ResolvedAgentConfig;
  readonly configFilePath: string;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly debugProvider?: boolean;
  readonly projectTrusted?: boolean;
  readonly configSources?: readonly { kind: "explicit" | "global" | "project"; path: string }[];
  readonly approvalHandler?: import("../approval/types.js").ApprovalHandler;
  readonly principalId?: string;
  readonly interactive?: boolean;
}): Promise<CliRuntimeContext> {
  const providerDebug = createProviderDebugLogger({
    enabled: options.debugProvider || process.env.MINGXU_DEBUG_PROVIDER === "1",
    sink: options.stderr,
  });

  const configDir = dirname(resolve(options.configFilePath));
  const eventSink = createEventSink(options.config, configDir);
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  const sessionDirectory = resolveSessionDirectory(options.config, options.configFilePath);
  const instructionPrompt = await new InstructionLoader(
    resolveInstructionLoaderOptions(options.config, configDir, userHome, sessionDirectory),
  ).build();
  const secretRefs = collectSecretRefs(options.config);
  const sessionStore = await createSessionStore(options.config, options.configFilePath);
  const memoryManager = createConfiguredMemoryManager(options.config, configDir, userHome);
  const resourceRegistry = new ResourceRegistry();
  const skillRegistry = new SkillRegistry();
  await loadConfiguredSkills(skillRegistry, resourceRegistry, options.config, configDir);
  const presetRegistry = new AgentPresetRegistry();
  loadConfiguredPresets(presetRegistry, options.config);

  const toolRegistry = new ToolRegistry();

  const providerRegistry = registerBuiltinProviders(new ProviderRegistry(), options.config.providerAliases);
  if (options.config.customProviderModule !== undefined) {
    await loadCustomProviderModule({
      modulePath: options.config.customProviderModule,
      configFilePath: options.configFilePath,
      registry: providerRegistry,
    });
  }
  for (const provider of Object.values(options.config.customProviders)) {
    await loadCustomProviderModule({
      modulePath: provider.module,
      configFilePath: options.configFilePath,
      registry: providerRegistry,
    });
  }

  const mcpManager = new McpClientManager({
    toolRegistry,
    resourceRegistry,
    eventSink,
    runId: "cli",
  });
  for (const [name, mcpServer] of Object.entries(options.config.mcpServers ?? {})) {
    mcpManager.registerServer(name, normalizeMcpServerConfig(mcpServer));
  }
  await mcpManager.connectAll();

  const pluginLoader = new PluginLoader({
    registerTool: (tool: Tool) => {
      toolRegistry.register(tool);
    },
    unregisterTool: (name: string) => toolRegistry.unregister(name),
    eventSink,
  });
  for (const plugin of options.config.plugins) {
    const pluginSource = await resolvePluginLoadRequest({
      path: plugin.path,
      trust: plugin.trust,
      configFilePath: options.configFilePath,
    });
    reportPluginLoad(options.stderr, plugin, pluginSource.resolvedPath);
    await pluginLoader.load({
      path: plugin.path,
      trust: plugin.trust,
      configFilePath: options.configFilePath,
      ...(plugin.kind !== undefined ? { kind: plugin.kind } : {}),
      ...(plugin.manifest !== undefined ? { manifest: plugin.manifest } : {}),
    });
  }

  const extensionManager = new ExtensionManager({
    userRoot: getUserConfigDir(),
    projectRoot: resolve(configDir, ".mingxu"),
    projectTrusted: options.projectTrusted ?? false,
  });
  await extensionManager.loadEnabledExtensions(pluginLoader, options.projectTrusted ? undefined : "user");

  const selectedDefaultPreset = options.config.defaultPreset !== undefined
    ? presetRegistry.get(options.config.defaultPreset)
    : undefined;
  if (options.config.defaultPreset !== undefined && !selectedDefaultPreset) {
    throw new Error(`Unknown default preset: ${options.config.defaultPreset}`);
  }

  let runtimeContext: CliRuntimeContext | undefined;
  const subagentManager = new SubagentManager({
    presets: presetRegistry,
    createSession: ({ preset, sessionId: childSessionId }) => {
      if (!runtimeContext) {
        throw new Error("Subagent runtime is not ready");
      }
      return runtimeContext.createSession({
        sessionId: childSessionId,
        preset,
        interactive: true,
        ...(preset.modelKey !== undefined ? { modelKey: preset.modelKey } : {}),
      });
    },
    ...(options.config.subagents !== undefined ? options.config.subagents : {}),
  });
  if (options.config.subagents?.enabled === true && (presetRegistry.list().length > 0 || options.config.defaultPreset !== undefined)) {
    toolRegistry.register(createSpawnSubagentTool({
      manager: subagentManager,
      ...(options.config.defaultPreset !== undefined ? { defaultPreset: options.config.defaultPreset } : {}),
    }));
  }

  const createSession = (request: CliSessionRequest = {}): AgentSession => {
    const preset = request.preset ?? selectedDefaultPreset;
    const modelKey = request.modelKey ?? preset?.modelKey ?? options.config.defaultModel;
    const { selection, adapter } = providerRegistry.createFromConfig(options.config, modelKey, {
      debug: providerDebug,
    });
    providerDebug.log("cli.selection", {
      requestedModelKey: modelKey,
      selectedModelKey: selection.modelKey,
      adapterProvider: adapter.provider,
      model: selection.model,
      provider: selection.provider,
    });

    const runtimeModel = createRuntimeModelProvider(adapter, selection.model, providerDebug);
    const runtimeStreamFn = createRuntimeStreamFn(adapter, selection.model, providerDebug);
    const resourceLoader = new ResourceLoader({
      registry: resourceRegistry,
      eventSink,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      runId: "cli",
      ...(options.config.resources?.maxResourceBytes !== undefined ? { maxResourceBytes: options.config.resources.maxResourceBytes } : {}),
      ...(options.config.resources?.maxRunBytes !== undefined ? { maxRunBytes: options.config.resources.maxRunBytes } : {}),
    });
    const runtimeTools = [...toolRegistry.list()];
    if (resourceRegistry.list().length > 0) {
      runtimeTools.push(createLoadResourceTool({ resourceLoader }));
    }
    const sessionTools = preset ? filterPresetTools(preset, runtimeTools) : runtimeTools;
    const sessionSystemPrompt = combinePrompts(instructionPrompt, preset?.systemPrompt);

    return new AgentSession({
      model: runtimeModel,
      streamFn: runtimeStreamFn,
      tools: sessionTools,
      ...(sessionSystemPrompt ? { systemPrompt: sessionSystemPrompt } : {}),
      maxIterations: preset?.maxIterations ?? options.config.maxIterations,
      ...(sessionStore !== undefined ? { sessionStore } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.approvalHandler !== undefined || options.approvalHandler !== undefined
        ? { approvalHandler: request.approvalHandler ?? options.approvalHandler }
        : {}),
      ...(request.principalId !== undefined || options.principalId !== undefined
        ? { principalId: request.principalId ?? options.principalId }
        : {}),
      ...(request.interactive !== undefined || options.interactive !== undefined
        ? { interactive: request.interactive ?? options.interactive }
        : {}),
      memoryManager,
      eventSink,
      audit: {
        ...(options.config.audit?.failClosedForHighRisk !== undefined
          ? { failClosedForHighRisk: options.config.audit.failClosedForHighRisk }
          : {}),
      },
      secretRefs,
    });
  };

  const resolvedRuntimeContext: CliRuntimeContext = {
    createSession,
    listSessions: async () => {
      if (!sessionStore) {
        return "Session storage is not enabled.";
      }
      const sessions = await sessionStore.listRecentSessions();
      if (sessions.length === 0) {
        return "No saved sessions.";
      }
      return sessions
        .map((session) => `${session.sessionId}\t${session.state}\t${session.updatedAt}${session.lastRunState ? `\t${session.lastRunState}` : ""}`)
        .join("\n");
    },
    listRecentSessions: async (limit = 10) => {
      if (!sessionStore) {
        return [];
      }
      return sessionStore.listRecentSessions(limit);
    },
    snapshot: async () => ({
      configFilePath: options.configFilePath,
      projectTrusted: options.projectTrusted ?? false,
      configSources: options.configSources ?? [],
      defaultModel: options.config.defaultModel,
      models: Object.entries(options.config.models).map(([key, model]) => ({
        key,
        provider: model.provider,
        model: model.model,
      })),
      sessions: sessionStore ? await sessionStore.listRecentSessions(10) : [],
      resources: resourceRegistry.list(),
      skills: skillRegistry.list(),
      presets: presetRegistry.list(),
      extensions: await extensionManager.list(),
      mcpServers: mcpManager.listServers().map((name) => ({
        name,
        transport: options.config.mcpServers?.[name]?.transport ?? "stdio",
        connected: mcpManager.listConnectedServers().includes(name),
      })),
      subagents: subagentManager.snapshot(),
      audit: {
        enabled: options.config.audit?.enabled ?? false,
        ...(options.config.audit?.file !== undefined ? { file: options.config.audit.file } : {}),
        healthy: eventSink.isHealthy?.() ?? true,
        failClosedForHighRisk: options.config.audit?.failClosedForHighRisk ?? false,
      },
      instructions: {
        systemPrompt: options.config.systemPrompt,
        autoLoadClaudeMd: options.config.instructions?.autoLoadClaudeMd,
        managed: summarizeInstructionScope(options.config.instructions?.managed),
        user: summarizeInstructionScope(options.config.instructions?.user),
        project: summarizeInstructionScope(options.config.instructions?.project),
        local: summarizeInstructionScope(options.config.instructions?.local),
        session: summarizeInstructionScope(options.config.instructions?.session),
      },
    }),
    cancelSubagents: (request) => subagentManager.cancel(request),
    close: async () => {
      await mcpManager.close();
      await eventSink.flush?.();
      await eventSink.close?.();
    },
  };

  runtimeContext = resolvedRuntimeContext;
  return resolvedRuntimeContext;
}

async function handleChatCommand(options: {
  readonly runtime: CliRuntimeContext;
  readonly controller: ChatInputController;
  readonly config: ResolvedAgentConfig;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly currentModelKey?: string;
  readonly currentSessionId?: string;
  readonly currentSession: AgentSession;
  readonly setCurrentModelKey: (value: string | undefined) => void;
  readonly setCurrentSessionId: (value: string | undefined) => void;
  readonly setCurrentSession: (session: AgentSession) => void;
  readonly command: string;
}): Promise<{ exit: boolean }> {
  const parsed = parseSlashCommand(options.command);
  if (!parsed) {
    options.stderr.write(`Error: Unknown command ${redactText(options.command)}\n`);
    return { exit: false };
  }

  const command = findChatCommand(parsed.name);
  const commandName = command?.name ?? parsed.name;

  switch (commandName) {
    case "help":
      options.stdout.write(`${formatChatHelp()}\n`);
      return { exit: false };
    case "status": {
      const tools = options.currentSession.options.tools ?? [];
      options.stdout.write(
        [
          `session: ${options.currentSessionId ?? "new"}`,
          `model: ${options.currentModelKey ?? options.config.defaultModel}`,
          `tools: ${tools.length}`,
        ].join("\n") + "\n",
      );
      return { exit: false };
    }
    case "model": {
      const modelKeys = Object.keys(options.config.models);
      if (parsed.args) {
        if (!options.config.models[parsed.args]) {
          options.stderr.write(`Error: Unknown model key: ${redactText(parsed.args)}\n`);
          return { exit: false };
        }
        options.setCurrentModelKey(parsed.args);
        options.setCurrentSession(options.runtime.createSession({
          modelKey: parsed.args,
          ...(options.currentSessionId !== undefined ? { sessionId: options.currentSessionId } : {}),
        }));
        options.stdout.write(`Model set to ${parsed.args}.\n`);
        return { exit: false };
      }

      options.stdout.write(
        ["Available models:", ...modelKeys.map((key, index) => `${index + 1}. ${key}`)].join("\n") + "\n",
      );
      const selection = (await options.controller.readLine("Select model> "))?.trim();
      if (!selection) {
        return { exit: false };
      }
      const chosen = resolveIndexedChoice(selection, modelKeys) ?? selection;
      if (!options.config.models[chosen]) {
        options.stderr.write(`Error: Unknown model key: ${redactText(chosen)}\n`);
        return { exit: false };
      }
      options.setCurrentModelKey(chosen);
      options.setCurrentSession(options.runtime.createSession({
        modelKey: chosen,
        ...(options.currentSessionId !== undefined ? { sessionId: options.currentSessionId } : {}),
      }));
      options.stdout.write(`Model set to ${chosen}.\n`);
      return { exit: false };
    }
    case "tools": {
      const activeTools = options.currentSession.options.tools ?? [];
      options.stdout.write(
        activeTools.length > 0
          ? activeTools.map((tool) => `${tool.name}\t${tool.description}`).join("\n") + "\n"
          : "No tools are currently registered.\n",
      );
      return { exit: false };
    }
    case "context": {
      const systemPrompt = options.currentSession.options.systemPrompt?.trim();
      const summary = [
        `session: ${options.currentSessionId ?? "new"}`,
        `model: ${options.currentModelKey ?? options.config.defaultModel}`,
        `systemPrompt: ${systemPrompt ? `${systemPrompt.length} chars` : "none"}`,
        `memory: ${Object.keys(options.config.memory ?? {}).length > 0 ? "configured" : "default scopes"}`,
        `instructions: ${options.config.instructions ? "configured" : "defaults"}`,
      ];
      options.stdout.write(`${summary.join("\n")}\n`);
      return { exit: false };
    }
    case "extensions": {
      const lines = [
        `plugins: ${(options.config.plugins ?? []).length}`,
        `mcpServers: ${Object.keys(options.config.mcpServers ?? {}).length}`,
        `skills: ${options.config.skills?.dirs?.length ?? 0}`,
        `presets: ${Object.keys(options.config.presets ?? {}).length}`,
        `defaultPreset: ${options.config.defaultPreset ?? "none"}`,
      ];
      options.stdout.write(`${lines.join("\n")}\n`);
      return { exit: false };
    }
    case "agents": {
      const subagents = options.config.subagents ?? {};
      options.stdout.write(
        [
          `enabled: ${subagents.enabled ?? false}`,
          `maxDepth: ${subagents.maxDepth ?? 3}`,
          `maxConcurrentSubagents: ${subagents.maxConcurrentSubagents ?? 4}`,
        ].join("\n") + "\n",
      );
      return { exit: false };
    }
    case "audit": {
      const audit = options.config.audit;
      options.stdout.write(
        [
          `enabled: ${audit?.enabled ?? false}`,
          `file: ${audit?.file ?? "none"}`,
          `failClosedForHighRisk: ${audit?.failClosedForHighRisk ?? false}`,
        ].join("\n") + "\n",
      );
      return { exit: false };
    }
    case "trust":
      options.stdout.write("Project trust is handled during config discovery for the current workspace.\n");
      return { exit: false };
    case "preset": {
      const presets = Object.keys(options.config.presets ?? {});
      options.stdout.write(
        presets.length > 0
          ? [`default: ${options.config.defaultPreset ?? "none"}`, ...presets.map((preset, index) => `${index + 1}. ${preset}`)].join("\n") + "\n"
          : "No presets are configured.\n",
      );
      return { exit: false };
    }
    case "compact": {
      options.stdout.write("Conversation compaction is managed automatically by the runtime.\n");
      return { exit: false };
    }
    case "steer": {
      if (!parsed.args) {
        options.stdout.write("Usage: /steer [text]\n");
        return { exit: false };
      }
      options.currentSession.steer(parsed.args);
      options.stdout.write("Queued steering instruction for the next model turn.\n");
      return { exit: false };
    }
    case "session":
      options.stdout.write(`${options.currentSessionId ?? "no active session"}\n`);
      return { exit: false };
    case "sessions":
      options.stdout.write(`${await options.runtime.listSessions()}\n`);
      return { exit: false };
    case "resume": {
      if (parsed.args) {
        options.setCurrentSessionId(parsed.args);
        options.setCurrentSession(options.runtime.createSession({
          ...(options.currentModelKey !== undefined ? { modelKey: options.currentModelKey } : {}),
          sessionId: parsed.args,
        }));
        options.stdout.write(`Resuming ${parsed.args}.\n`);
        return { exit: false };
      }

      const recentSessions = await options.runtime.listRecentSessions(10);
      if (recentSessions.length === 0) {
        options.stdout.write("No saved sessions.\n");
        return { exit: false };
      }
      options.stdout.write(
        ["Recent sessions:", ...recentSessions.map((session, index) => `${index + 1}. ${session.sessionId}\t${session.updatedAt}\t${session.state}`)].join("\n") + "\n",
      );
      const selection = (await options.controller.readLine("Select session> "))?.trim();
      if (!selection) {
        return { exit: false };
      }
      const sessionIds = recentSessions.map((session) => session.sessionId);
      const chosen = resolveIndexedChoice(selection, sessionIds) ?? selection;
      options.setCurrentSessionId(chosen);
      options.setCurrentSession(options.runtime.createSession({
        ...(options.currentModelKey !== undefined ? { modelKey: options.currentModelKey } : {}),
        sessionId: chosen,
      }));
      options.stdout.write(`Resuming ${chosen}.\n`);
      return { exit: false };
    }
    case "new":
      options.setCurrentSessionId(undefined);
      options.setCurrentSession(options.runtime.createSession({
        ...(options.currentModelKey !== undefined ? { modelKey: options.currentModelKey } : {}),
      }));
      options.stdout.write("Started a new session.\n");
      return { exit: false };
    case "clear":
      options.stdout.write("\u001b[2J\u001b[0f");
      return { exit: false };
    case "exit":
    case "quit":
      return { exit: true };
    default: {
      const suggestions = suggestChatCommands(parsed.name);
      if (suggestions.length > 0) {
        options.stderr.write(`Error: Unknown command /${parsed.name}. Did you mean ${suggestions.map((command) => `/${command.name}`).join(", ")}?\n`);
      } else {
        options.stderr.write(`Error: Unknown command /${parsed.name}\n`);
      }
      return { exit: false };
    }
  }
}

function parseSlashCommand(raw: string): { name: string; args: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const body = trimmed.slice(1).trim();
  if (!body) {
    return undefined;
  }
  const firstSpace = body.indexOf(" ");
  return {
    name: (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim(),
    args: firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim(),
  };
}

function resolveIndexedChoice(choice: string, values: readonly string[]): string | undefined {
  const index = Number.parseInt(choice, 10);
  if (Number.isInteger(index) && index >= 1 && index <= values.length) {
    return values[index - 1];
  }
  return undefined;
}

export async function runChatPrompt(options: {
  readonly session: AgentSession;
  readonly prompt: string;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<{ sessionId?: string } | undefined> {
  let messageActive = false;
  let messageHadText = false;
  const projection = new CliRuntimeProjection();
  const unsubscribe = options.session.subscribe((event) => {
    const result = projection.applyAgentEvent(event);
    if (!result.changed) {
      return;
    }
    for (const appliedEvent of result.appliedEvents) {
      if (appliedEvent.type === "message_start") {
        messageActive = true;
        messageHadText = false;
        continue;
      }
      if (appliedEvent.type === "message_update") {
        const delta = appliedEvent.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          options.stdout.write(delta.text);
          messageHadText = true;
        }
        continue;
      }
      if (appliedEvent.type === "tool_execution_start") {
        if (messageActive && messageHadText) {
          options.stdout.write("\n");
        }
        messageActive = false;
        messageHadText = false;
        options.stderr.write(`[tool] ${appliedEvent.toolCall.name}\n`);
        continue;
      }
      if (appliedEvent.type === "tool_execution_end") {
        options.stderr.write(`[tool] ${appliedEvent.toolCall.name} done\n`);
        continue;
      }
      if (appliedEvent.type === "error") {
        if (messageHadText) {
          options.stdout.write("\n");
        }
        const error = appliedEvent.error as unknown;
        const message = redactText(error instanceof Error ? error.message : String(error));
        options.stderr.write(`Error: ${message}\n`);
      }
    }
  });

  const handleSigint = () => {
    options.session.abort("Interrupted by user");
  };
  process.once("SIGINT", handleSigint);

  try {
    const result = await options.session.prompt(options.prompt);
    if (!messageHadText && result.content) {
      options.stdout.write(`${result.content}\n`);
    } else if (messageHadText) {
      options.stdout.write("\n");
    }
    return result.sessionId ? { sessionId: result.sessionId } : {};
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    options.stderr.write(`Error: ${message}\n`);
    return undefined;
  } finally {
    process.off("SIGINT", handleSigint);
    unsubscribe();
  }
}

function createSessionLister(configFilePath: string): NonNullable<CliDependencies["listSessions"]> {
  return async (config) => {
    const sessionStore = await createSessionStore(config, configFilePath);
    if (!sessionStore) {
      return "Session storage is not enabled.";
    }
    const sessions = await sessionStore.listRecentSessions();
    if (sessions.length === 0) {
      return "No saved sessions.";
    }
    return sessions
      .map((session) => `${session.sessionId}\t${session.state}\t${session.updatedAt}${session.lastRunState ? `\t${session.lastRunState}` : ""}`)
      .join("\n");
  };
}

function createEventSink(config: ResolvedAgentConfig, configDir: string): EventSink {
  if (!config.audit?.enabled || !config.audit.file) {
    return new NoopEventSink();
  }
  return new JsonlAuditWriter(resolveConfiguredPath(configDir, config.audit.file, "Audit file"), {
    ...(config.audit.maxBytes !== undefined ? { maxBytes: config.audit.maxBytes } : {}),
    ...(config.audit.maxFiles !== undefined ? { maxFiles: config.audit.maxFiles } : {}),
    ...(config.audit.failClosedForHighRisk !== undefined
      ? { failClosedForHighRisk: config.audit.failClosedForHighRisk }
      : {}),
  });
}

function collectSecretRefs(config: ResolvedAgentConfig): Readonly<Record<string, { kind: "env"; name: string }>> {
  if (config.secrets?.allowEnv === false) {
    return {};
  }
  const refs: Record<string, { kind: "env"; name: string }> = {};
  for (const [modelName, model] of Object.entries(config.models)) {
    if (typeof model.apiKey !== "string") continue;
    const ref = parseSecretRef(model.apiKey);
    if (ref) {
      refs[`models.${modelName}.apiKey`] = ref;
    }
  }
  return refs;
}

async function createSessionStore(
  config: ResolvedAgentConfig,
  configFilePath: string,
  sessionId?: string,
): Promise<JsonlSessionStore | undefined> {
  const sessionDirectory = resolveSessionDirectory(config, configFilePath);
  const sessionEnabled = config.session?.enabled ?? config.session?.save ?? config.sessionFile !== undefined;
  if (!sessionEnabled || !sessionDirectory) {
    return undefined;
  }
  const store = new JsonlSessionStore(sessionDirectory);
  await store.recoverInterruptedRuns();
  if (sessionId) {
    await store.getRequiredSession(sessionId);
  }
  return store;
}

function resolveSessionDirectory(
  config: ResolvedAgentConfig,
  configFilePath: string,
): string | undefined {
  if (config.session?.dir !== undefined) {
    return resolveConfiguredPath(dirname(resolve(configFilePath)), config.session.dir, "Session directory");
  }
  if (config.sessionFile !== undefined) {
    return dirname(resolveSessionFilePath(configFilePath, config.sessionFile));
  }
  return undefined;
}

function resolveSessionFilePath(configFilePath: string, sessionFile: string): string {
  return resolve(dirname(configFilePath), sessionFile);
}

function resolveInstructionLoaderOptions(
  config: ResolvedAgentConfig,
  configDir: string,
  userHome: string,
  sessionDirectory?: string,
): InstructionLoaderOptions {
  const managedRoot = assertSafeLocalPath(getManagedInstructionRoot(userHome), "Managed instruction root");
  const userRoot = assertSafeLocalPath(getUserInstructionRoot(userHome), "User instruction root");
  const projectRoot = configDir;
  const localFile = resolve(configDir, "MINGXU.local.md");
  const sessionFile = sessionDirectory !== undefined ? resolve(sessionDirectory, "MINGXU.md") : undefined;
  const instructions = config.instructions ?? {};

  const options: MutableInstructionLoaderOptions = {};
  options.systemPrompt = config.systemPrompt !== undefined
    ? combinePrompts(MINGXU_IDENTITY_PROMPT, config.systemPrompt)
    : MINGXU_IDENTITY_PROMPT;

  const managed = mergeInstructionRootConfig({ dir: managedRoot }, instructions.managed);
  if (managed !== undefined) options.managed = managed;

  const user = mergeInstructionRootConfig({ dir: userRoot }, instructions.user);
  if (user !== undefined) options.user = user;

  const project = mergeInstructionRootConfig({ dir: projectRoot }, instructions.project);
  if (project !== undefined) options.project = project;

  const local = mergeInstructionRootConfig({ file: localFile }, instructions.local);
  if (local !== undefined) options.local = local;

  const session = mergeInstructionRootConfig(
    sessionFile !== undefined ? { file: sessionFile } : undefined,
    instructions.session,
  );
  if (session !== undefined) options.session = session;

  if (instructions.autoLoadClaudeMd !== undefined) options.autoLoadClaudeMd = instructions.autoLoadClaudeMd;
  if (instructions.maxInstructionBytes !== undefined) options.maxInstructionBytes = instructions.maxInstructionBytes;
  if (instructions.maxTotalBytes !== undefined) options.maxTotalBytes = instructions.maxTotalBytes;

  return options;
}

function mergeInstructionRootConfig(
  base: { dir?: string | undefined; file?: string | undefined; files?: readonly string[] | undefined } | undefined,
  override: { dir?: string | undefined; file?: string | undefined; files?: readonly string[] | undefined } | undefined,
): InstructionRootConfig | undefined {
  if (!base && !override) return undefined;
  const merged: InstructionRootConfig = {
    ...(base?.dir !== undefined ? { dir: base.dir } : {}),
    ...(override?.dir !== undefined ? { dir: override.dir } : {}),
    ...(base?.file !== undefined ? { file: base.file } : {}),
    ...(override?.file !== undefined ? { file: override.file } : {}),
    ...(base?.files !== undefined || override?.files !== undefined
      ? { files: [...new Set([...(base?.files ?? []), ...(override?.files ?? [])])] }
      : {}),
  };
  return merged;
}

function summarizeInstructionScope(scope: { dir?: string | undefined; file?: string | undefined; files?: readonly string[] | undefined } | undefined): string[] | undefined {
  if (!scope) {
    return undefined;
  }
  const values = [
    ...(scope.dir ? [scope.dir] : []),
    ...(scope.file ? [scope.file] : []),
    ...(scope.files ?? []),
  ];
  return values.length > 0 ? values : undefined;
}

function createConfiguredMemoryManager(
  config: ResolvedAgentConfig,
  configDir: string,
  userHome: string,
): FileMemoryStore {
  const memoryConfig = config.memory ?? {};
  const defaults = {
    managed: getManagedMemoryRoot(userHome),
    user: getUserMemoryRoot(userHome),
    project: configDir,
    local: resolve(configDir, ".mingxu", "memory"),
  } as const;
  const readonlyScopes = new Set<"managed" | "user" | "project" | "local">(["managed"]);

  for (const scope of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const scopeConfig = memoryConfig[scope];
    if (scopeConfig?.readOnly) {
      readonlyScopes.add(scope);
    }
  }

  const store = new FileMemoryStore({}, { readonlyScopes: [...readonlyScopes] });

  for (const scope of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const scopeConfig = memoryConfig[scope];
    const resolvedDir = scopeConfig?.dir !== undefined
      ? resolveConfiguredPath(configDir, scopeConfig.dir, `Memory scope ${scope}`)
      : assertSafeLocalPath(defaults[scope], `Memory scope ${scope}`);
    store.addScope(scope, resolvedDir);
  }

  return store;
}

async function loadConfiguredSkills(
  skillRegistry: SkillRegistry,
  resourceRegistry: ResourceRegistry,
  config: ResolvedAgentConfig,
  configDir: string,
): Promise<void> {
  for (const dir of config.skills?.dirs ?? []) {
    const resolvedDir = resolveConfiguredPath(configDir, dir, "Skill directory");
    const skills = await skillRegistry.loadDirectory(resolvedDir);
    for (const skill of skills) {
      if (!resourceRegistry.has("skill", skill.name)) {
        resourceRegistry.register({
          kind: "skill",
          name: skill.name,
          visibility: skill.visibility,
          description: skill.description,
          source: "local_file",
          path: skill.entryPath,
          metadata: {
            skillName: skill.name,
            version: skill.version,
            manifestPath: skill.manifestPath,
          },
        });
      }
      for (const resource of skill.resources) {
        if (!resourceRegistry.has(resource.kind, resource.name)) {
          resourceRegistry.register(resource);
        }
      }
    }
  }
}

function loadConfiguredPresets(
  presetRegistry: AgentPresetRegistry,
  config: ResolvedAgentConfig,
): void {
  for (const preset of Object.values(config.presets ?? {})) {
    presetRegistry.register(preset);
  }
}

function combinePrompts(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n---\n\n");
}

function resolveConfiguredPath(baseDir: string, input: string, label: string): string {
  const candidate = isAbsolute(input) ? input : resolve(baseDir, input);
  return assertSafeLocalPath(candidate, label);
}

function getManagedInstructionRoot(userHome: string): string {
  return process.env.MINGXU_SYSTEM_CONFIG_DIR
    ?? (process.platform === "win32"
      ? resolve(process.env.ProgramData ?? userHome, "mingxu")
      : "/etc/mingxu");
}

function getUserInstructionRoot(userHome: string): string {
  return process.env.MINGXU_USER_CONFIG_DIR
    ?? (process.platform === "win32"
      ? resolve(process.env.APPDATA ?? userHome, "mingxu")
      : resolve(userHome, ".config", "mingxu"));
}

function getManagedMemoryRoot(userHome: string): string {
  return process.env.MINGXU_SYSTEM_MEMORY_DIR
    ?? (process.platform === "win32"
      ? resolve(process.env.ProgramData ?? userHome, "mingxu", "memory")
      : "/var/lib/mingxu");
}

function getUserMemoryRoot(userHome: string): string {
  return process.env.MINGXU_USER_MEMORY_DIR
    ?? (process.platform === "win32"
      ? resolve(process.env.APPDATA ?? userHome, "mingxu", "memory")
      : resolve(userHome, ".config", "mingxu", "memory"));
}

function normalizeMcpServerConfig(config: {
  transport: McpTransportKind;
  command?: string | undefined;
  args?: readonly string[] | undefined;
  cwd?: string | undefined;
  url?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  tools?: Readonly<Record<string, McpToolPolicyInput>> | undefined;
  visibility?: ResourceVisibility | undefined;
}): McpServerConfig {
  return {
    transport: config.transport,
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.tools !== undefined ? { tools: normalizeMcpToolPolicies(config.tools) } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
}

function normalizeMcpToolPolicies(
  tools: Readonly<Record<string, McpToolPolicyInput>>,
): Readonly<Record<string, McpToolPolicy>> {
  const normalized: Record<string, McpToolPolicy> = {};
  for (const [name, policy] of Object.entries(tools)) {
    normalized[name] = {
      ...(policy.riskLevel !== undefined ? { riskLevel: policy.riskLevel } : {}),
      ...(policy.executionMode !== undefined ? { executionMode: policy.executionMode } : {}),
    };
  }
  return normalized;
}

function reportPluginLoad(
  stderr: Pick<NodeJS.WriteStream, "write">,
  plugin: PluginConfig,
  resolvedPath: string,
): void {
  stderr.write(
    `[plugin] Loading ${plugin.path} -> ${resolvedPath} (trust: ${plugin.trust}). Loading a plugin executes third-party code; only load local code you have reviewed and trust.\n`,
  );
}

interface ExtensionCommandResult {
  readonly output: string;
  readonly exitCode: number;
}

async function handleExtensionsCommand(options: {
  readonly args: import("./parse-args.js").CliArguments;
  readonly config: ResolvedAgentConfig;
  readonly configFilePath: string;
  readonly projectTrusted: boolean;
}): Promise<ExtensionCommandResult> {
  const command = options.args.commandTarget ?? "list";
  const manager = new ExtensionManager({
    userRoot: getUserConfigDir(),
    projectRoot: resolve(dirname(resolve(options.configFilePath)), ".mingxu"),
    projectTrusted: options.projectTrusted,
  });
  const scope = options.args.scope ?? "user";
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  switch (command) {
    case "list": {
      const records = await manager.list();
      if (records.length === 0) {
        return { output: "No extensions are installed.", exitCode: 0 };
      }
      return {
        output: records.map((record) => [
          `${record.id}\t${record.version}\t${record.scope}\t${record.enabled ? "enabled" : "disabled"}`,
          `adapter: ${record.adapterId}`,
          `source: ${record.source.kind}:${record.source.locator}`,
          `entry: ${record.entryPath}`,
          `health: ${record.health}`,
        ].join("\n")).join("\n\n"),
        exitCode: 0,
      };
    }
    case "inspect": {
      const source = options.args.commandArgs?.[0];
      if (!source) {
        throw new Error("extensions inspect requires a source path, tarball, npm spec, or git URL");
      }
      const result = await manager.inspect(source);
      return {
        output: [
          `adapter: ${result.adapterId}`,
          `id: ${result.manifest.id}`,
          `name: ${result.manifest.name}`,
          `version: ${result.manifest.version}`,
          `kind: ${result.manifest.kind}`,
          `permissions: ${JSON.stringify(result.manifest.permissions ?? {})}`,
          `contributions: ${result.manifest.contributions.map((contribution: { readonly name: string }) => contribution.name).join(", ") || "(none)"}`,
          `entry: ${result.entryPath}`,
          `manifestHash: ${result.manifestHash}`,
          `sha256: ${result.sha256}`,
          `source: ${result.source.kind}:${result.source.locator}`,
          ...(result.upstreamId !== undefined ? [`upstreamId: ${result.upstreamId}`] : []),
          ...(result.upstreamVersion !== undefined ? [`upstreamVersion: ${result.upstreamVersion}`] : []),
          ...(result.capabilities !== undefined ? [`capabilities: ${result.capabilities.join(", ")}`] : []),
          ...(result.unsupportedCapabilities !== undefined ? [`unsupportedCapabilities: ${result.unsupportedCapabilities.join(", ") || "(none)"}`] : []),
        ].join("\n"),
        exitCode: 0,
      };
    }
    case "add": {
      const source = options.args.commandArgs?.[0];
      if (!source) {
        throw new Error("extensions add requires a source path, tarball, npm spec, or git URL");
      }
      if (!isInteractive && !options.args.yes) {
        throw new Error("Non-interactive extension installation requires --yes");
      }
      if (isInteractive && !options.args.yes) {
        const confirmed = await confirmExtensionInstall(source, scope);
        if (!confirmed) {
          return { output: "Cancelled.", exitCode: 1 };
        }
      }
      const result = await manager.install({ source, scope, yes: true });
      return {
        output: [
          `Installed ${result.record.id}`,
          `scope: ${result.record.scope}`,
          `enabled: ${result.record.enabled}`,
          `adapter: ${result.record.adapterId}`,
          `source: ${result.record.source.kind}:${result.record.source.locator}`,
        ].join("\n"),
        exitCode: 0,
      };
    }
    case "update": {
      const id = options.args.commandArgs?.[0];
      if (!id) {
        throw new Error("extensions update requires an extension id");
      }
      const source = options.args.commandArgs?.[1];
      if (!isInteractive && !options.args.yes) {
        throw new Error("Non-interactive extension installation requires --yes");
      }
      if (isInteractive && !options.args.yes) {
        const confirmed = await confirmExtensionInstall(source ?? id, scope);
        if (!confirmed) {
          return { output: "Cancelled.", exitCode: 1 };
        }
      }
      const result = await manager.update({
        id,
        scope,
        ...(source !== undefined ? { source } : {}),
        yes: true,
      });
      return {
        output: [
          `Updated ${result.record.id}`,
          `scope: ${result.record.scope}`,
          `enabled: ${result.record.enabled}`,
          `adapter: ${result.record.adapterId}`,
          `source: ${result.record.source.kind}:${result.record.source.locator}`,
        ].join("\n"),
        exitCode: 0,
      };
    }
    case "enable":
    case "disable":
    case "remove": {
      const id = options.args.commandArgs?.[0];
      if (!id) {
        throw new Error(`extensions ${command} requires an extension id`);
      }
      const resolvedScope = await resolveExtensionScope(manager, id, scope);
      if (!resolvedScope) {
        throw new Error(`Extension not found: ${id}`);
      }
      const toggleOptions = options.args.temporary === true ? { temporary: true } : {};
      if (command === "enable") {
        await manager.enable(id, resolvedScope, toggleOptions);
      } else if (command === "disable") {
        await manager.disable(id, resolvedScope, toggleOptions);
      } else {
        await manager.remove(id, resolvedScope);
      }
      return {
        output: `${options.args.temporary ? "temporarily " : ""}${command}d ${id} in ${resolvedScope} scope.`,
        exitCode: 0,
      };
    }
    case "doctor":
      return {
        output: await manager.doctor(),
        exitCode: 0,
      };
    default:
      throw new Error(`Unknown extensions command: ${command}`);
  }
}

async function resolveExtensionScope(
  manager: ExtensionManager,
  id: string,
  preferredScope: "user" | "project",
): Promise<"user" | "project" | undefined> {
  const preferred = (await manager.listInstalledRecords(preferredScope)).find((record) => record.id === id);
  if (preferred) return preferredScope;
  const fallbackScope = preferredScope === "user" ? "project" : "user";
  const fallback = (await manager.listInstalledRecords(fallbackScope)).find((record) => record.id === id);
  return fallback ? fallbackScope : undefined;
}

async function confirmExtensionInstall(source: string, scope: "user" | "project"): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Install ${source} into ${scope} scope? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function initializeConfig(configPath: string, profile: InitProfile, force = false): Promise<string> {
  const resolvedPath = resolve(configPath);
  const config = createInitConfig(profile);
  resolveAgentConfig(config);

  if (!force) {
    try {
      await access(resolvedPath);
      throw new Error(`Config file already exists: ${resolvedPath}. Remove it first or choose a different --config path.`);
    } catch (error) {
      if (!isNodeMissingFileError(error)) {
        throw error;
      }
    }

    await writeFile(resolvedPath, renderInitConfig(profile), "utf8");
    return `Created ${resolvedPath} using the ${profile} profile.`;
  }

  const backupPath = await backupExistingConfigFile(resolvedPath);
  try {
    await writeFile(resolvedPath, renderInitConfig(profile), "utf8");
  } catch (error) {
    if (backupPath !== undefined) {
      await rm(resolvedPath, { force: true }).catch(() => undefined);
      await rename(backupPath, resolvedPath).catch(() => undefined);
    }
    throw error;
  }

  return `${backupPath ? "Updated" : "Created"} ${resolvedPath} using the ${profile} profile.${backupPath ? ` Backup saved to ${backupPath}.` : ""}`;
}

function isNodeMissingFileError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}

async function backupExistingConfigFile(resolvedPath: string): Promise<string | undefined> {
  try {
    const existing = await stat(resolvedPath);
    if (!existing.isFile()) {
      throw new Error(`Config path already exists but is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    if (isNodeMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const backupPath = `${resolvedPath}.bak-${process.pid}-${Date.now()}`;
  await rm(backupPath, { force: true }).catch(() => undefined);
  await rename(resolvedPath, backupPath);
  return backupPath;
}

function isBrokenPipeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "EPIPE";
}
