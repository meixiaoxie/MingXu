import { AgentSession } from "../core/agent-session.js";
import type { PluginConfig, ResolvedAgentConfig } from "../config/config-schema.js";
import { resolveAgentConfig } from "../config/index.js";
import { loadConfig } from "../config/load-config.js";
import { loadCustomProviderModule } from "../models/custom-provider-loader.js";
import { ProviderRegistry } from "../models/provider-registry.js";
import { registerBuiltinProviders } from "../models/provider-catalog.js";
import { createRuntimeModelProvider } from "../models/model-runtime.js";
import { PluginLoader, resolvePluginLoadRequest } from "../plugins/plugin-loader.js";
import { echoTool } from "../tools/builtin/echo-tool.js";
import { readFileTool } from "../tools/builtin/read-file-tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { parseArgs } from "./parse-args.js";
import { JsonlAuditWriter } from "../audit/jsonl-audit-writer.js";
import type { EventSink } from "../events/event-sink.js";
import { NoopEventSink } from "../events/event-sink.js";
import { redactText, redactValue } from "../redaction/redactor.js";
import { parseSecretRef } from "../redaction/secret-ref.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import { dirname, resolve } from "node:path";
import { access, writeFile } from "node:fs/promises";
import { createInitConfig, renderInitConfig, type InitProfile } from "./init-config.js";
import { runDoctor } from "./doctor.js";
import { createProviderDebugLogger } from "./provider-debug.js";

export interface CliDependencies {
  run?: (
    config: ResolvedAgentConfig,
    prompt?: string,
    modelKey?: string,
    sessionId?: string,
  ) => Promise<string | void>;
  listSessions?: (config: ResolvedAgentConfig) => Promise<string>;
  doctorProbe?: (config: ResolvedAgentConfig) => Promise<void>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  version?: string;
  debugProvider?: boolean;
}

const HELP_TEXT = `Usage: mingxu [options] [prompt]\n\nCommands:\n  init                    Create a starter mingxu.config.json in the current directory\n  doctor                  Check config, env, plugins, session, and audit wiring\n  resume [sessionId]      Resume a saved session and continue with a new prompt\n  sessions                List recent sessions\n\nOptions:\n  -c, --config <path>  JSON configuration file\n  -p, --prompt <text>  Prompt to send to the agent\n  -m, --model <name>   Named model from config.models\n      --profile <name> Init profile: minimal or secure-local\n      --online         Allow doctor to perform a live provider connectivity probe\n      --debug-provider Print resolved provider config and request diagnostics to stderr\n  -h, --help           Show this help\n  -v, --version        Show the version\n`;

export async function main(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

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
      const result = await initializeConfig(args.configPath, args.profile ?? "minimal");
      stdout.write(`${result}\n`);
      return 0;
    }

    const config = await loadConfig(args.configPath);
    const run = dependencies.run ?? createDefaultRunner(
      args.configPath,
      stderr,
      args.debugProvider ?? dependencies.debugProvider ?? false,
    );
    const listSessions = dependencies.listSessions ?? createSessionLister(args.configPath);
    if (args.command === "sessions") {
      const result = await listSessions(config);
      stdout.write(`${result}\n`);
      return 0;
    }
    if (args.command === "doctor") {
      const result = await runDoctor({
        config,
        configPath: args.configPath,
        online: args.online ?? false,
      }, {
        ...(dependencies.doctorProbe !== undefined ? { fetchProbe: dependencies.doctorProbe } : {}),
      });
      stdout.write(`${result.output}\n`);
      return result.ok ? 0 : 1;
    }
    const result = await run(
      config,
      args.prompt,
      args.model,
      args.command === "resume" ? args.commandTarget : undefined,
    );
    if (result !== undefined) stdout.write(`${result}\n`);
    return 0;
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

function createDefaultRunner(
  configFilePath: string,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
  debugProvider = false,
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

    const eventSink = createEventSink(config);
    const secretRefs = collectSecretRefs(config);
    const sessionStore = await createSessionStore(config, configFilePath, sessionId);

    // Startup order is intentional: aliases may only target shipped providers,
    // while custom modules add real providers before the selected model is created.
    const providerRegistry = registerBuiltinProviders(
      new ProviderRegistry(),
      config.providerAliases,
    );
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

    const { adapter, selection } = providerRegistry.createFromConfig(config, modelKey, {
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

    // Built-in and plugin tools share one registry so duplicate names are caught
    // during startup and the Agent receives one complete tool list.
    const toolRegistry = new ToolRegistry([echoTool, readFileTool]);
    const pluginLoader = new PluginLoader({
      registerTool: (tool) => {
        toolRegistry.register(tool);
      },
      unregisterTool: (name) => toolRegistry.unregister(name),
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

    const session = new AgentSession({
      model: runtimeModel,
      tools: [...toolRegistry.list()],
      ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
      maxIterations: config.maxIterations,
      ...(sessionStore !== undefined ? { sessionStore } : {}),
    });
    const result = await session.prompt(agentPrompt);
    await eventSink.flush?.();
    await eventSink.close?.();
    return result.content;
  };
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

function createEventSink(config: ResolvedAgentConfig): EventSink {
  if (!config.audit?.enabled || !config.audit.file) {
    return new NoopEventSink();
  }
  return new JsonlAuditWriter(config.audit.file, {
    ...(config.audit.maxBytes !== undefined ? { maxBytes: config.audit.maxBytes } : {}),
    ...(config.audit.maxFiles !== undefined ? { maxFiles: config.audit.maxFiles } : {}),
    ...(config.audit.failClosedForHighRisk !== undefined
      ? { failClosedForHighRisk: config.audit.failClosedForHighRisk }
      : {}),
  });
}

async function createSessionStore(
  config: ResolvedAgentConfig,
  configFilePath: string,
  sessionId?: string,
): Promise<JsonlSessionStore | undefined> {
  const sessionDirectory = config.session?.dir
    ?? (config.sessionFile !== undefined ? dirname(resolveSessionFilePath(configFilePath, config.sessionFile)) : undefined);
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

function resolveSessionFilePath(configFilePath: string, sessionFile: string): string {
  return resolve(dirname(configFilePath), sessionFile);
}

function collectSecretRefs(config: ResolvedAgentConfig): Readonly<Record<string, { kind: "env"; name: string }>> {
  if (config.secrets?.allowEnv === false) {
    return {};
  }
  const refs: Record<string, { kind: "env"; name: string }> = {};
  for (const [modelName, model] of Object.entries(config.models)) {
    if (typeof model.apiKey === "string") {
      const ref = parseSecretRef(model.apiKey);
      if (ref) {
        refs[`models.${modelName}.apiKey`] = ref;
      }
    }
  }
  return refs;
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

async function initializeConfig(configPath: string, profile: InitProfile): Promise<string> {
  const resolvedPath = resolve(configPath);
  try {
    await access(resolvedPath);
    throw new Error(`Config file already exists: ${resolvedPath}. Remove it first or choose a different --config path.`);
  } catch (error) {
    if (!isNodeMissingFileError(error)) {
      throw error;
    }
  }

  const config = createInitConfig(profile);
  resolveAgentConfig(config);
  await writeFile(resolvedPath, renderInitConfig(profile), "utf8");
  return `Created ${resolvedPath} using the ${profile} profile.`;
}

function isNodeMissingFileError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}
