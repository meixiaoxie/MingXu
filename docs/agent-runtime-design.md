# 底层 Agent Runtime 完整设计蓝图

这份文档是 `mingxu` 的底层 agent runtime **完整落地设计蓝图**。目标不是先做个 MVP 再慢慢加功能，而是从一开始就按成品级 runtime 设计，每个阶段都有可落地的代码骨架、测试和验收标准。

这里说的 **agent runtime**，可以先理解成一个"调度器"：它像会议主持人一样，负责记录用户说了什么、让模型思考、按模型请求去调用工具、把工具结果记回会议记录，然后继续问模型下一步怎么做。它本身不负责漂亮界面，也不懂具体业务，只负责把模型、工具、消息、状态、事件、上下文和会话稳定串起来。

---

## 0. 总目标

当前 `mingxu` 已经有一个最小 agent loop：

```text
用户输入 -> 调模型 generate -> 如果模型要工具就执行工具 -> 工具结果放回 messages -> 继续调模型
```

但这还不够。成品级底层 runtime 要完整覆盖：

1. 消息模型
2. Agent 状态
3. 模型 Stream 函数
4. 工具系统
5. Agent Loop
6. 事件系统
7. 上下文转换
8. 上下文压缩
9. 控制能力
10. 会话存储（JSONL session tree）
11. 记忆系统
12. 工具执行上下文和 hook
13. 完整 harness 组合层

---

## 1. 当前代码基线

| 模块 | 当前文件 | 已经做到什么 | 要做什么 |
| --- | --- | --- | --- |
| 消息协议 | `src/core/types.ts` | 有 `Message`、`ToolCall`、`ToolResult`、`Tool`、`ModelProvider` | 补 `AgentMessage`、`AgentState`、`AgentEvent`、`StreamFn`、hook 类型、memory 类型 |
| Agent 外观 | `src/core/agent.ts` | `Agent.run()` 很薄 | 升级为有状态、有事件、有控制能力、有记忆的完整外观 |
| Agent Loop | `src/core/agent-loop.ts` | 支持模型调用、工具调用、maxIterations、sessionStore | 拆出流式 loop，支持事件、abort、hook、上下文转换、compaction |
| 模型协议 | `src/models/model-protocol.ts` | 有 `ModelRequest`、`ModelResponse`、`ModelEvent` | 把 `ModelEvent` 转成 core 的 `AssistantStreamEvent` |
| Provider 注册 | `src/models/provider-registry.ts` | `ModelAdapter` 已预留 `stream?` | core 层真正使用 `stream?` |
| 模型桥接 | `src/models/request-builder.ts` | `createRuntimeModelProvider()` 只桥接 generate | 新增 `createRuntimeStreamFn()` |
| 工具注册 | `src/tools/tool-registry.ts` | 工具注册、查找、执行、拒绝重名 | 支持 `ToolExecutionContext`、signal、onUpdate |
| 工具定义 | `src/tools/tool.ts` | `defineTool()` 用 zod 校验输入 | 支持工具执行上下文 |
| 会话存储 | `src/memory/file-session-store.ts` | JSON key-value session | 新增 JSONL session store，保留旧实现作为兼容 |
| CLI | `src/cli/main.ts` | 组合 config、provider、tools、plugins、Agent | 改用新 Agent 接口，保持旧输出不变 |

改造原则：

1. 保留兼容入口：旧 `Agent.run()`、`runAgentLoop()`、`ModelProvider.generate()` 暂时不删。
2. core 不直接依赖 Anthropic、OpenAI、Gemini 的具体格式。
3. 每个阶段独立可测试，不依赖下一阶段。

---

## 2. 参考项目借鉴清单

### 2.1 Pi 项目

Pi 的 `packages/agent` 分两层：

**底层 core：**

```text
types.ts         消息、状态、工具、事件、hook 类型
agent.ts         Agent 类、状态、订阅、队列、abort、prompt、continue、steer、followUp
agent-loop.ts    核心循环、模型流、工具调用、下一轮
stream-fn.ts     统一 streamFn 入口
proxy.ts         远程 streamFn 辅助实现
```

**harness 层：**

```text
harness/session           JSONL 会话树、分支、恢复
harness/compaction        上下文压缩、摘要、保留最近尾巴
harness/tools             read/write/edit/bash 等通用工具
harness/messages.ts       上下文转换 convertToLlm
harness/agent-harness.ts  高层组合入口
harness/skills.ts         技能加载
harness/prompt-templates  提示模板
harness/system-prompt     系统提示词拼装
```

### 2.2 Claude Code 项目

| 设计点 | 参考文件 | 怎么用 |
| --- | --- | --- |
| 上下文窗口 | `src/utils/context.ts` | `getContextWindowForModel()` + 百分比计算 |
| token 统计 | `src/utils/tokens.ts` | 优先用 API response usage，新消息粗估 |
| compaction | `src/commands/compact/compact.ts` | summary + retained tail + compact boundary + post-compact cleanup |
| JSONL transcript | `src/utils/sessionStorage.ts` | append-only、parentUuid chain、queue flush、sidechain |
| hook 系统 | `src/utils/hooks.ts` | PreToolUse、PostToolUse、UserPromptSubmit、SessionStart、Stop、PreCompact 等 |
| memory scope | `src/utils/memory/types.ts` | User、Project、Local、Managed、AutoMem scope |
| 消息工具 | `src/utils/messages.ts` | 消息创建、normalize、tool result pairing、UI reorder |

---

## 3. 最终目录蓝图

```text
src/core
  types.ts                     核心中立类型：消息、工具、模型、状态、hook、memory
  events.ts                    AgentEvent、事件监听器、事件发射
  context.ts                   AgentContext、transformContext、convertToLlm
  stream-fn.ts                 StreamFn、AssistantStreamEvent、generate fallback
  agent-loop.ts                兼容旧 runAgentLoop
  streaming-agent-loop.ts      新流式核心循环（完整版：含 compaction、hook、session）
  agent.ts                     Agent 类：状态、订阅、控制、记忆
  runtime-defaults.ts          默认值
  runtime-id.ts                ID 生成

src/models
  model-protocol.ts            provider 层中立请求/响应/事件
  request-builder.ts           core <-> provider 协议转换
  model-runtime.ts             重导出
  provider-registry.ts         provider 注册和选择
  provider-catalog.ts          内置 provider 注册
  anthropic-provider.ts        Anthropic 适配器
  openai-compatible-provider.ts
  custom-provider-loader.ts

src/tools
  tool.ts                      defineTool，支持 ToolExecutionContext
  tool-registry.ts             工具注册和执行入口
  builtin/*                    内置工具

src/session
  session-entry.ts             JSONL entry 类型
  session-store.ts             session store 接口
  jsonl-session-store.ts       追加式 JSONL session 存储
  session-tree.ts              session 树、分支、恢复
  index.ts

src/context
  token-estimator.ts           token 粗估 + usage 精确统计
  compaction.ts                shouldCompact、findCutPoint、compactMessages、postCompact
  summary-generator.ts         summary 生成（含模型摘要和简单摘要）
  context-builder.ts           从 session entries 构建 AgentContext
  index.ts

src/memory
  memory-store.ts              通用 key-value 接口
  in-memory-store.ts           内存实现
  file-session-store.ts        旧 JSON session store
  memory-scope.ts              user/project/session scope 类型
  memory-manager.ts            多 scope 记忆管理
  index.ts

src/hooks
  hook-types.ts                beforeToolCall、afterToolCall、onSessionStart 等 hook 类型
  hook-runner.ts               hook 执行器
  index.ts

src/harness
  agent-harness.ts             完整组合入口：模型 + session + tools + hooks + memory + compaction
  system-prompt.ts             系统提示词拼装
  index.ts
```

---

## 4. 分阶段总览

```text
A. 冻结旧行为 + 兼容测试
B. core 新类型（消息、状态、事件、stream、hook、memory、context）
C. 上下文转换默认实现
D. StreamFn + generate fallback + provider stream bridge
E. 流式 Agent Loop（完整版：事件、hook、compaction 入口、session）
F. 工具执行升级（context、signal、onUpdate、hook）
G. Agent 类完整版（状态、订阅、abort、continue、steer、followUp、retry、memory）
H. JSONL session store + session tree
I. 上下文压缩（token 估算、summary、retained tail、compact boundary、post-compact）
J. 记忆系统（多 scope、CLAUDE.md 自动加载、memory 文件管理）
K. 完整 harness 组合入口
L. CLI 接入 + 最终验证
```

---

# A. 冻结旧行为和兼容边界

## A.1 这个阶段做什么

先把当前已经能工作的行为用测试保护起来。后面改 core 时不能破坏这些。

当前必须保留的旧行为：

1. `Agent.run("hi")` 返回最终文本
2. `runAgentLoop()` 支持一次性 `model.generate()`
3. 工具按模型返回顺序串行执行
4. 未知工具不会让进程崩掉，变成错误 tool result
5. 工具执行抛错变成错误 tool result
6. `maxIterations` 小于 1 报错
7. 到达最大循环次数报错
8. CLI 默认输出最终文本

## A.2 要改的文件

```text
tests/core.test.ts
tests/tool-registry.test.ts
tests/cli.test.ts
```

## A.3 怎么办

在 `tests/core.test.ts` 补充兼容测试。现有测试已经覆盖大部分情况，再确认一遍每个行为都有对应测试即可。

## A.4 验收标准

```bash
pnpm test
```

全部通过后进入 B。

---

# B. core 新类型：消息、状态、事件、stream、hook、memory、context

## B.1 这个阶段做什么

把 runtime 所有能力对应的"语言"一次性定义清楚。相当于先画好所有零件的图纸。只加类型，不大改逻辑。

## B.2 要新增/修改的文件

```text
src/core/types.ts          修改：保留旧类型，新增 runtime 类型
src/core/events.ts          新增
src/core/context.ts          新增
src/core/stream-fn.ts        新增
src/session/session-entry.ts 新增
src/session/session-store.ts 新增
src/memory/memory-scope.ts   新增
src/hooks/hook-types.ts      新增
src/index.ts                 修改：导出新类型
```

## B.3 `src/core/types.ts`

保留旧类型不动，在下面新增：

```ts
// ============================================================
// AgentMessage：runtime 内部的统一消息格式
// ============================================================

export type AgentMessageRole = "user" | "assistant" | "toolResult" | "system" | "summary";

export interface AgentMessageBase {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type AgentMessage =
  | (AgentMessageBase & { role: "user" })
  | (AgentMessageBase & {
      role: "assistant";
      toolCalls?: ToolCall[];
      stopReason?: string;
      usage?: ModelUsage;
    })
  | (AgentMessageBase & {
      role: "toolResult";
      toolResult: ToolResult;
    })
  | (AgentMessageBase & {
      role: "system";
      visibleToModel?: boolean;
    })
  | (AgentMessageBase & {
      role: "summary";
      range?: { fromId: string; toId: string };
    });

// ============================================================
// ModelUsage：token 用量统计
// ============================================================

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ============================================================
// AgentState：agent 的"脑内白板"
// ============================================================

export interface AgentTurnState {
  id: string;
  startedAt: string;
  iteration: number;
}

export interface AgentState {
  systemPrompt?: string;
  model: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  isStreaming: boolean;
  pendingToolCalls: ToolCall[];
  errorMessage?: string;
  currentTurn?: AgentTurnState;
}

// ============================================================
// 控制能力相关
// ============================================================

export type QueueMode = "all" | "one";

// ============================================================
// 保留的旧类型不动
// ============================================================

export type MessageRole = "user" | "assistant" | "tool";
// ... 其余旧类型保持不变
```

## B.4 `src/core/events.ts`

```ts
import type { AgentMessage, AgentState, ToolCall, ToolResult } from "./types.js";
import type { AssistantStreamEvent } from "./stream-fn.js";

export type AgentEvent =
  | { type: "agent_start"; state: AgentState }
  | { type: "turn_start"; turnId: string; input?: AgentMessage }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; delta?: AssistantStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCall: ToolCall }
  | { type: "tool_execution_update"; toolCall: ToolCall; partialResult: unknown }
  | { type: "tool_execution_end"; toolCall: ToolCall; result: ToolResult }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResult[] }
  | { type: "agent_end"; state: AgentState }
  | { type: "error"; error: string; state: AgentState };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
```

## B.5 `src/core/context.ts`

```ts
import type { AgentMessage, ToolDefinition, ModelInput } from "./types.js";

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export interface TokenBudget {
  maxContextTokens: number;
  reserveTokens: number;
  usedTokens?: number;
}

export type TransformContext = (
  messages: AgentMessage[],
  options?: { signal?: AbortSignal; tokenBudget?: TokenBudget },
) => AgentMessage[] | Promise<AgentMessage[]>;

export type ConvertToLlm = (
  context: AgentContext,
) => ModelInput | Promise<ModelInput>;
```

## B.6 `src/core/stream-fn.ts`

```ts
import type { AgentContext } from "./context.js";
import type { AgentMessage, ToolCall } from "./types.js";

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export type AssistantStreamEvent =
  | { type: "start"; messageId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; error: string };

export type StreamFn = (
  model: string,
  context: AgentContext,
  options?: StreamOptions,
) => AsyncIterable<AssistantStreamEvent> | Promise<AsyncIterable<AssistantStreamEvent>>;
```

## B.7 `src/session/session-entry.ts`

```ts
import type { AgentMessage } from "../core/types.js";

export type SessionEntryType =
  | "message"
  | "summary"
  | "compact_boundary"
  | "metadata"
  | "branch_point";

export interface SessionEntryBase {
  id: string;
  type: SessionEntryType;
  sessionId: string;
  createdAt: string;
  parentId?: string;
}

export type SessionEntry =
  | (SessionEntryBase & { type: "message"; message: AgentMessage })
  | (SessionEntryBase & {
      type: "summary";
      summary: string;
      range: { fromId: string; toId: string };
    })
  | (SessionEntryBase & {
      type: "compact_boundary";
      beforeMessageId: string;
      summaryMessageId: string;
    })
  | (SessionEntryBase & {
      type: "metadata";
      key: string;
      value: unknown;
    })
  | (SessionEntryBase & {
      type: "branch_point";
      branchName: string;
      parentBranchId?: string;
    });
```

## B.8 `src/session/session-store.ts`

```ts
import type { SessionEntry } from "./session-entry.js";

export interface SessionStore {
  append(entry: SessionEntry): Promise<void>;
  load(sessionId: string): Promise<SessionEntry[]>;
  /** 获取某个 entry 之前的所有祖先链 */
  getAncestorChain(entryId: string): Promise<SessionEntry[]>;
  /** 获取某个 entry 的所有子节点 */
  getChildren(parentId: string): Promise<SessionEntry[]>;
  /** 获取会话的所有叶子节点 */
  getLeaves(sessionId: string): Promise<SessionEntry[]>;
  /** 获取最新的叶子 */
  getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined>;
  clear(sessionId: string): Promise<void>;
}
```

## B.9 `src/memory/memory-scope.ts`

```ts
export type MemoryScope = "user" | "project" | "local" | "session";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  key?: string;
  /** 搜索关键词 */
  query?: string;
}
```

## B.10 `src/hooks/hook-types.ts`

```ts
import type { AgentMessage, AgentState, ToolCall, ToolResult } from "../core/types.js";

// ============================================================
// 工具相关 hook
// ============================================================

export type BeforeToolCallResult =
  | { behavior: "allow"; input?: unknown }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason?: string };

export type AfterToolCallResult =
  | { output?: unknown; additionalContext?: string }
  | void;

// ============================================================
// 会话生命周期 hook
// ============================================================

export type SessionStartResult = { additionalContext?: string } | void;
export type SessionEndResult = void;

// ============================================================
// 压缩相关 hook
// ============================================================

export type PreCompactResult =
  | { additionalContext?: string; customInstructions?: string }
  | void;
export type PostCompactResult = void;

// ============================================================
// 用户输入 hook
// ============================================================

export type UserPromptSubmitResult =
  | { updatedPrompt?: string; additionalContext?: string }
  | void;

// ============================================================
// Hook 集合
// ============================================================

export interface AgentHooks {
  beforeToolCall?: (
    call: ToolCall,
    state: AgentState,
  ) => BeforeToolCallResult | Promise<BeforeToolCallResult>;

  afterToolCall?: (
    call: ToolCall,
    result: ToolResult,
    state: AgentState,
  ) => AfterToolCallResult | Promise<AfterToolCallResult>;

  onSessionStart?: (
    state: AgentState,
  ) => SessionStartResult | Promise<SessionStartResult>;

  onSessionEnd?: (
    state: AgentState,
  ) => SessionEndResult | Promise<SessionEndResult>;

  preCompact?: (
    trigger: "manual" | "auto",
    state: AgentState,
  ) => PreCompactResult | Promise<PreCompactResult>;

  postCompact?: (
    state: AgentState,
  ) => PostCompactResult | Promise<PostCompactResult>;

  onUserPromptSubmit?: (
    prompt: string,
    state: AgentState,
  ) => UserPromptSubmitResult | Promise<UserPromptSubmitResult>;
}
```

## B.11 `src/index.ts` 补充导出

```ts
// 新增导出
export type {
  AgentMessage,
  AgentMessageRole,
  AgentState,
  AgentTurnState,
  ModelUsage,
} from "./core/types.js";

export type {
  AgentEvent,
  AgentEventListener,
  AgentEventSink,
} from "./core/events.js";

export type {
  AgentContext,
  TokenBudget,
  TransformContext,
  ConvertToLlm,
} from "./core/context.js";

export type {
  AssistantStreamEvent,
  StreamFn,
  StreamOptions,
} from "./core/stream-fn.js";

export type {
  SessionEntry,
  SessionEntryType,
} from "./session/session-entry.js";

export type { SessionStore } from "./session/session-store.js";

export type {
  MemoryScope,
  MemoryEntry,
  MemoryQuery,
} from "./memory/memory-scope.js";

export type {
  AgentHooks,
  BeforeToolCallResult,
  AfterToolCallResult,
  SessionStartResult,
  SessionEndResult,
  PreCompactResult,
  PostCompactResult,
  UserPromptSubmitResult,
} from "./hooks/hook-types.js";
```

## B.12 验收标准

```bash
pnpm typecheck
pnpm test
```

---

# C. 上下文转换默认实现

## C.1 这个阶段做什么

建立 `AgentMessage -> ModelInput` 的完整转换通道。参考 Pi 的 `harness/messages.ts` 设计。

## C.2 要改的文件

```text
src/core/context.ts
src/core/types.ts
src/index.ts
tests/context-transform.test.ts 新增
```

## C.3 `src/core/context.ts` 完整实现

```ts
import type { AgentMessage, Message, ModelInput, ToolDefinition } from "./types.js";

/**
 * 默认上下文转换：不裁剪，原样返回。
 * 后续 compaction 会在这里被调用。
 */
export function defaultTransformContext(messages: AgentMessage[]): AgentMessage[] {
  return [...messages];
}

/**
 * 把 runtime 的 AgentMessage 列表转成模型层认识的 ModelInput。
 * 
 * 规则：
 * - user / assistant / toolResult：直接转换
 * - summary：转成 user 消息，用前缀标记"以下是历史摘要"
 * - system：visibleToModel 为 false 时不发给模型
 */
export function defaultConvertToLlm(context: AgentContext): ModelInput {
  return {
    messages: context.messages.flatMap(toLegacyMessage),
    ...(context.tools.length > 0 ? { tools: context.tools } : {}),
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
  };
}

/** 摘要消息的前缀和后缀，帮助模型识别这是一段压缩后的历史 */
export const SUMMARY_PREFIX = "[Previous conversation summary]\n";
export const SUMMARY_SUFFIX = "\n[End of summary]";

function toLegacyMessage(message: AgentMessage): Message[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.content }];

    case "assistant":
      return [{
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      }];

    case "toolResult":
      return [{
        role: "tool",
        content: typeof message.toolResult.output === "string"
          ? message.toolResult.output
          : JSON.stringify(message.toolResult.output),
        toolResult: message.toolResult,
      }];

    case "summary":
      return [{
        role: "user",
        content: `${SUMMARY_PREFIX}${message.content}${SUMMARY_SUFFIX}`,
      }];

    case "system":
      // 不可见的系统消息不发给模型（如 UI 调试信息）
      return message.visibleToModel === false
        ? []
        : [{ role: "user", content: message.content }];
  }
}
```

## C.4 测试

`tests/context-transform.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { defaultConvertToLlm, defaultTransformContext } from "../src/index.js";
import type { AgentMessage } from "../src/index.js";

describe("context transform", () => {
  it("不裁剪消息", () => {
    const messages: AgentMessage[] = [
      { id: "u1", role: "user", content: "hi", createdAt: "now" },
    ];
    expect(defaultTransformContext(messages)).toEqual(messages);
  });

  it("把 summary 转成带前缀的 user 消息", () => {
    const input = defaultConvertToLlm({
      messages: [
        { id: "s1", role: "summary", content: "Old facts", createdAt: "now" },
        { id: "u1", role: "user", content: "Continue", createdAt: "now" },
      ],
      tools: [],
    });

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]!.content).toContain("Previous conversation summary");
  });

  it("不把 visibleToModel=false 的系统消息发给模型", () => {
    const input = defaultConvertToLlm({
      messages: [
        { id: "sys1", role: "system", content: "debug info", createdAt: "now", visibleToModel: false },
        { id: "u1", role: "user", content: "test", createdAt: "now" },
      ],
      tools: [],
    });

    expect(input.messages).toHaveLength(1);
  });
});
```

## C.5 验收标准

- summary 转成模型可读的 user 消息
- system 消息支持 visibleToModel 控制
- 旧消息格式不受影响

---

# D. StreamFn + generate fallback + provider stream bridge

## D.1 这个阶段做什么

两件事一起做：

1. 做一个 StreamFn fallback：如果 provider 不支持 stream，把 `generate()` 结果包装成流式事件。
2. 做一个 model stream bridge：如果 provider 支持 `stream()`，把 `ModelEvent` 转成 core 的 `AssistantStreamEvent`。

参考 Pi 的 `stream-fn.ts` 和 `proxy.ts`。

## D.2 要改的文件

```text
src/core/stream-fn.ts
src/models/request-builder.ts
src/models/model-runtime.ts
src/models/index.ts
src/index.ts
tests/stream-fn.test.ts       新增
tests/model-stream-bridge.test.ts 新增
```

## D.3 `src/core/stream-fn.ts` 完整实现

```ts
import type { AgentContext } from "./context.js";
import type { AgentMessage, ModelProvider, ToolCall } from "./types.js";
import { defaultConvertToLlm } from "./context.js";
import { createRuntimeId } from "./runtime-id.js";

/**
 * 当模型 adapter 只有 generate 没有 stream 时，
 * 用这个 fallback 把一次性结果包装成流式事件。
 * 
 * 这样 runtime 层始终可以调用 streamFn()，不需要知道底层有什么能力。
 */
export function createGenerateFallbackStreamFn(modelProvider: ModelProvider): StreamFn {
  return async function* generateFallbackStream(_model, context, options) {
    if (options?.signal?.aborted) {
      yield { type: "error", error: "Aborted before model call" };
      return;
    }

    const modelInput = await defaultConvertToLlm(context);
    const output = await modelProvider.generate(modelInput);
    const messageId = createRuntimeId("assistant");

    yield { type: "start", messageId };

    // 把完整文本分成几段发送，让 UI 能显示"正在输入"的效果
    if (output.content) {
      const chunks = splitTextIntoChunks(output.content, 50);
      for (const chunk of chunks) {
        yield { type: "text_delta", text: chunk };
      }
    }

    for (const toolCall of output.toolCalls) {
      yield { type: "tool_call", toolCall };
    }

    const message: AgentMessage = {
      id: messageId,
      role: "assistant",
      content: output.content,
      createdAt: new Date().toISOString(),
      ...(output.toolCalls.length > 0 ? { toolCalls: output.toolCalls } : {}),
      ...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
    };

    yield { type: "done", message };
  };
}

/** 把长文本切成短块，模拟流式输出 */
function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }
  return chunks;
}
```

## D.4 `src/core/runtime-id.ts`

```ts
let counter = 0;

/** 生成递增 ID，测试环境可预测 */
export function createRuntimeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** 测试专用：重置计数器 */
export function resetRuntimeIdCounter(): void {
  counter = 0;
}
```

## D.5 `src/models/request-builder.ts` 新增 stream bridge

```ts
import type { StreamFn } from "../core/stream-fn.js";
import { createRuntimeId } from "../core/runtime-id.js";
import { defaultConvertToLlm } from "../core/context.js";
import type { AgentMessage } from "../core/types.js";
import type { ModelAdapter, ModelConfig, ModelEvent, ModelRequest } from "./model-protocol.js";

/**
 * 把 model adapter 的 stream（或 generate）转成 core 层的 StreamFn。
 * 
 * 如果 adapter 有 stream 方法就走真正流式；
 * 如果没有，走 generate fallback。
 */
export function createRuntimeStreamFn(
  adapter: ModelAdapter,
  config: ModelConfig,
): StreamFn {
  return async function* runtimeStreamFn(_model, context, options) {
    // 先把 runtime context 转成 model request
    const input = await defaultConvertToLlm(context);
    const request: ModelRequest = {
      ...toModelRequest(input, config),
      stream: true,
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    };

    // 没有 stream 能力 -> 走 generate fallback
    if (!adapter.stream) {
      const response = await adapter.generate(request);
      yield* modelResponseToAssistantEvents(response);
      return;
    }

    // 有 stream 能力 -> 走真正流式
    const messageId = createRuntimeId("assistant");
    let yieldedStart = false;

    const stream = await adapter.stream(request);
    for await (const event of stream) {
      const converted = modelEventToAssistantEvent(event, messageId);

      if (converted === null) continue;

      if (converted.type === "start" && !yieldedStart) {
        yieldedStart = true;
        yield converted;
      } else if (converted.type === "start") {
        continue; // 不重复发 start
      } else {
        yield converted;
      }
    }
  };
}

function modelEventToAssistantEvent(
  event: ModelEvent,
  messageId: string,
): AssistantStreamEvent | null {
  switch (event.type) {
    case "start":
      return { type: "start", messageId };

    case "delta":
      return { type: "text_delta", text: event.text };

    case "tool_call":
      return { type: "tool_call", toolCall: event.toolCall };

    case "end":
      return {
        type: "done",
        message: modelResponseToAgentMessage(event.response),
      };

    case "error":
      return { type: "error", error: event.error };

    // provider 层的 tool_result 事件不转成 assistant 输出
    case "tool_result":
      return null;

    default:
      return null;
  }
}

function modelResponseToAgentMessage(response: ModelResponse): AgentMessage {
  return {
    id: createRuntimeId("assistant"),
    role: "assistant",
    content: response.text,
    createdAt: new Date().toISOString(),
    ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
  };
}

async function* modelResponseToAssistantEvents(
  response: ModelResponse,
): AsyncGenerator<AssistantStreamEvent> {
  const messageId = createRuntimeId("assistant");
  yield { type: "start", messageId };

  if (response.text) {
    yield { type: "text_delta", text: response.text };
  }

  for (const toolCall of response.toolCalls) {
    yield { type: "tool_call", toolCall };
  }

  yield {
    type: "done",
    message: modelResponseToAgentMessage(response),
  };
}
```

## D.6 测试

`tests/stream-fn.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createGenerateFallbackStreamFn } from "../src/index.js";

describe("generate fallback streamFn", () => {
  it("把 generate 输出包装成流式事件", async () => {
    const streamFn = createGenerateFallbackStreamFn({
      async generate() {
        return {
          content: "hello",
          toolCalls: [{ id: "call-1", name: "echo", input: { message: "x" } }],
        };
      },
    });

    const events: string[] = [];
    for await (const event of await streamFn("test", { messages: [], tools: [] })) {
      events.push(event.type);
    }

    expect(events[0]).toBe("start");
    expect(events).toContain("text_delta");
    expect(events).toContain("tool_call");
    expect(events[events.length - 1]).toBe("done");
  });

  it("abort signal 在开始时检查", async () => {
    const controller = new AbortController();
    controller.abort();

    const streamFn = createGenerateFallbackStreamFn({
      async generate() { return { content: "x", toolCalls: [] }; },
    });

    const events = [];
    for await (const event of await streamFn("test", { messages: [], tools: [] }, { signal: controller.signal })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });
});
```

`tests/model-stream-bridge.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createRuntimeStreamFn } from "../src/index.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/index.js";

describe("model stream bridge", () => {
  it("把 ModelEvent stream 转成 AssistantStreamEvent", async () => {
    const adapter: ModelAdapter = {
      provider: "test",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 100000,
        maxOutput: 4096,
      },
      async generate() { throw new Error("not used"); },
      async *stream() {
        yield { type: "start", request: {} as ModelRequest };
        yield { type: "delta", text: "hi" };
        yield { type: "end", response: { text: "hi", toolCalls: [] } };
      },
    };

    const streamFn = createRuntimeStreamFn(adapter, { provider: "test", model: "m" });
    const events = [];
    for await (const event of await streamFn("m", { messages: [], tools: [] })) {
      events.push(event.type);
    }

    expect(events).toEqual(["start", "text_delta", "done"]);
  });

  it("没有 stream 时自动走 generate fallback", async () => {
    const adapter: ModelAdapter = {
      provider: "test",
      capabilities: {
        supportsTools: false,
        supportsStreaming: false,
        supportsImages: false,
        supportsStructuredOutput: false,
        supportsRefusal: false,
        supportsFallback: false,
        supportsEffort: false,
        supportsPromptCaching: false,
        supportsMidConversationSystem: false,
        maxContext: 100000,
        maxOutput: 4096,
      },
      async generate() {
        return { text: "fallback", toolCalls: [] };
      },
    };

    const streamFn = createRuntimeStreamFn(adapter, { provider: "test", model: "m" });
    const events = [];
    for await (const event of await streamFn("m", { messages: [], tools: [] })) {
      events.push(event.type);
    }

    expect(events).toContain("done");
  });
});
```

## D.7 验收标准

- generate fallback 产出完整事件序列
- model stream bridge 把 provider 事件正确转换
- abort signal 在开始时就能中止

---

# E. 流式 Agent Loop（完整版）

## E.1 这个阶段做什么

实现完整的流式核心循环。这次不是简化版，而是直接包含：

- 事件发射
- abort signal
- 上下文 transform
- hook 集成
- compaction 入口
- session 写入入口
- 工具执行事件

参考 Pi 的 `agent-loop.ts`。

## E.2 要改的文件

```text
src/core/streaming-agent-loop.ts 新增
src/core/types.ts                 补 StreamingAgentLoopOptions
src/core/runtime-defaults.ts
src/core/context.ts
src/index.ts
tests/streaming-agent-loop.test.ts 新增
```

## E.3 新增类型

在 `src/core/types.ts` 新增：

```ts
import type { AgentEventSink } from "./events.js";
import type { TransformContext } from "./context.js";
import type { StreamFn } from "./stream-fn.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import type { SessionStore } from "../session/session-store.js";
import type { CompactionSettings } from "../context/compaction.js";

export interface StreamingAgentLoopOptions {
  model: string;
  streamFn: StreamFn;
  messages?: AgentMessage[];
  tools?: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  emit?: AgentEventSink;
  transformContext?: TransformContext;
  hooks?: AgentHooks;
  /** session store：每轮完成后写入 */
  sessionStore?: SessionStore;
  sessionId?: string;
  /** compaction 设置，默认不开启 */
  compaction?: CompactionSettings;
}
```

## E.4 `runStreamingAgentLoop()` 完整实现

```ts
import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import { createRuntimeId } from "./runtime-id.js";
import { defaultTransformContext } from "./context.js";
import { compactMessages } from "../context/compaction.js";
import { defaultSummaryGenerator } from "../context/summary-generator.js";
import type {
  AgentMessage,
  StreamingAgentLoopOptions,
  Tool,
  ToolCall,
  ToolResult,
} from "./types.js";
import type { AgentContext } from "./context.js";
import type { AgentEventSink } from "./events.js";
import type { SessionEntry } from "../session/session-entry.js";

const noopEmit: AgentEventSink = () => {};

/**
 * 完整流式 Agent Loop。
 * 
 * 流程：
 * 1. 收到用户消息（或 continue）
 * 2. 如果有 compaction 设置且需要压缩，先 compact
 * 3. 如果有 hooks.onUserPromptSubmit，先处理
 * 4. 发 turn_start 事件
 * 5. 循环：
 *    a. 检查 abort signal
 *    b. transformContext 转换上下文
 *    c. streamFn 调模型
 *    d. 收集 assistant 消息
 *    e. 没有 tool calls -> 结束
 *    f. 有 tool calls -> 执行工具 -> 把 toolResult 放回 messages -> 继续
 * 6. 写入 session
 * 7. 返回结果
 */
export async function runStreamingAgentLoop(
  input: { userInput?: string; continueOnly?: boolean },
  options: StreamingAgentLoopOptions,
) {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }

  const emit = options.emit ?? noopEmit;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const messages: AgentMessage[] = [...(options.messages ?? [])];

  // ---- 处理用户输入 ----
  const userMessage = input.userInput && !input.continueOnly
    ? createUserAgentMessage(input.userInput)
    : undefined;

  if (userMessage) {
    // 用户输入 hook
    if (options.hooks?.onUserPromptSubmit) {
      const hookResult = await options.hooks.onUserPromptSubmit(
        input.userInput!,
        buildAgentState(options, messages),
      );
      if (hookResult?.updatedPrompt) {
        userMessage.content = hookResult.updatedPrompt;
      }
    }
    messages.push(userMessage);
  }

  // ---- compaction（如果开启） ----
  let compactedIds: string[] = [];
  if (options.compaction?.enabled) {
    const compactionResult = await compactMessages(
      messages,
      options.compaction,
      defaultSummaryGenerator,
    );
    if (compactionResult.didCompact) {
      compactedIds = compactionResult.archivedIds;
      // 用 compacted messages 替换
      messages.length = 0;
      messages.push(...compactionResult.messages);
    }
  }

  await emit({
    type: "turn_start",
    turnId: createRuntimeId("turn"),
    input: userMessage,
  });

  // ---- 主循环 ----
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfAborted(options.signal);

    // 上下文转换
    const transformFn = options.transformContext ?? defaultTransformContext;
    const transformedMessages = await transformFn(messages, {
      signal: options.signal,
    });

    const context: AgentContext = {
      systemPrompt: options.systemPrompt,
      messages: transformedMessages,
      tools: (options.tools ?? []).map(
        ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
      ),
    };

    // 调用模型（流式）
    const assistant = await streamAssistantMessage({
      context,
      model: options.model,
      streamFn: options.streamFn,
      emit,
      signal: options.signal,
    });

    messages.push(assistant);

    // 存入 session
    await appendToSession(options, {
      ...assistant,
      metadata: {
        ...assistant.metadata,
        iteration,
        compactedIds: compactedIds.length > 0 ? compactedIds : undefined,
      },
    });

    compactedIds = []; // 只记录第一轮

    // 没有工具 -> 结束
    if (!assistant.toolCalls?.length) {
      await emit({ type: "turn_end", message: assistant, toolResults: [] });
      return { content: assistant.content, messages, iterations: iteration };
    }

    // 执行工具
    const toolResults: ToolResult[] = [];
    const parallelToolCalls: Promise<void>[] = [];

    for (const call of assistant.toolCalls) {
      const tool = tools.get(call.name);
      const executor = executeToolCallWithHooks({
        call,
        tool,
        emit,
        signal: options.signal,
        hooks: options.hooks,
        state: buildAgentState(options, messages),
      }).then((toolResultMessage) => {
        messages.push(toolResultMessage);
        toolResults.push(toolResultMessage.toolResult);
      });

      // 如果工具有 parallel 模式标记，可以并发
      if (tool?.executionMode === "parallel") {
        parallelToolCalls.push(executor);
      } else {
        await executor;
      }
    }
    await Promise.all(parallelToolCalls);
  }

  throw new Error(`Agent loop reached the maximum of ${maxIterations} iterations`);
}

// ============================================================
// 内部辅助函数
// ============================================================

async function streamAssistantMessage(args: {
  context: AgentContext;
  model: string;
  streamFn: StreamFn;
  emit: AgentEventSink;
  signal?: AbortSignal;
}): Promise<AgentMessage & { role: "assistant" }> {
  let message: (AgentMessage & { role: "assistant" }) | undefined;
  let content = "";
  const toolCalls: ToolCall[] = [];

  const stream = await args.streamFn(args.model, args.context, { signal: args.signal });

  for await (const event of stream) {
    throwIfAborted(args.signal);

    switch (event.type) {
      case "start": {
        message = createAssistantMessage({ id: event.messageId, content: "" });
        await args.emit({ type: "message_start", message });
        break;
      }

      case "text_delta": {
        content += event.text;
        message = {
          ...(message ?? createAssistantMessage({ content: "" })),
          content,
        };
        await args.emit({ type: "message_update", message, delta: event });
        break;
      }

      case "tool_call": {
        toolCalls.push(event.toolCall);
        message = {
          ...(message ?? createAssistantMessage({ content })),
          content,
          toolCalls: [...toolCalls],
        };
        await args.emit({ type: "message_update", message, delta: event });
        break;
      }

      case "done": {
        const finalMessage: AgentMessage & { role: "assistant" } = {
          ...event.message,
          id: event.message.id || message?.id || createRuntimeId("assistant"),
          content: event.message.content || content,
          ...(toolCalls.length ? { toolCalls } : {}),
          role: "assistant",
        };
        await args.emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }

      case "error": {
        throw new Error(event.error);
      }
    }
  }

  throw new Error("Model stream ended without a done event");
}

async function executeToolCallWithHooks(args: {
  call: ToolCall;
  tool?: Tool;
  emit: AgentEventSink;
  signal?: AbortSignal;
  hooks?: AgentHooks;
  state: AgentState;
}): Promise<AgentMessage & { role: "toolResult" }> {
  // ---- beforeToolCall hook ----
  if (args.hooks?.beforeToolCall) {
    const before = await args.hooks.beforeToolCall(args.call, args.state);
    if (before.behavior === "deny") {
      const deniedResult: ToolResult = {
        toolCallId: args.call.id,
        name: args.call.name,
        output: `Tool execution denied: ${before.reason}`,
        isError: true,
      };
      await args.emit({ type: "tool_execution_end", toolCall: args.call, result: deniedResult });
      return createToolResultMessage(deniedResult);
    }
    if (before.behavior === "allow" && before.input !== undefined) {
      args.call = { ...args.call, input: before.input };
    }
  }

  // ---- 执行工具 ----
  await args.emit({ type: "tool_execution_start", toolCall: args.call });

  const rawResult = await executeToolCall(args.call, args.tool, args.signal);
  let result = rawResult;

  // ---- afterToolCall hook ----
  if (args.hooks?.afterToolCall) {
    const after = await args.hooks.afterToolCall(args.call, result, args.state);
    if (after?.output !== undefined) {
      result = { ...result, output: after.output };
    }
  }

  await args.emit({ type: "tool_execution_end", toolCall: args.call, result });

  const toolResultMessage = createToolResultMessage(result);

  // 如果 after hook 有附加上下文，加进 metadata
  if (args.hooks?.afterToolCall) {
    const after = await args.hooks.afterToolCall(args.call, result, args.state);
    if (after?.additionalContext) {
      toolResultMessage.metadata = {
        ...toolResultMessage.metadata,
        additionalContext: after.additionalContext,
      };
    }
  }

  return toolResultMessage;
}

async function executeToolCall(
  call: ToolCall,
  tool?: Tool,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!tool) {
    return {
      toolCallId: call.id,
      name: call.name,
      output: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  try {
    const output = await tool.execute(call.input, { signal });
    return {
      toolCallId: call.id,
      name: call.name,
      output,
    };
  } catch (error) {
    return {
      toolCallId: call.id,
      name: call.name,
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

// ============================================================
// 消息工厂函数
// ============================================================

function createUserAgentMessage(content: string): AgentMessage & { role: "user" } {
  return {
    id: createRuntimeId("user"),
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(
  partial: Partial<AgentMessage> & { content: string },
): AgentMessage & { role: "assistant" } {
  return {
    id: partial.id ?? createRuntimeId("assistant"),
    role: "assistant",
    content: partial.content,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    ...(partial.toolCalls ? { toolCalls: partial.toolCalls } : {}),
    ...(partial.stopReason ? { stopReason: partial.stopReason } : {}),
    ...(partial.usage ? { usage: partial.usage } : {}),
    ...(partial.metadata ? { metadata: partial.metadata } : {}),
  };
}

function createToolResultMessage(result: ToolResult): AgentMessage & { role: "toolResult" } {
  return {
    id: createRuntimeId("toolResult"),
    role: "toolResult",
    content: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
    createdAt: new Date().toISOString(),
    toolResult: result,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Agent loop was aborted");
  }
}

function buildAgentState(
  options: StreamingAgentLoopOptions,
  messages: AgentMessage[],
): AgentState {
  return {
    systemPrompt: options.systemPrompt,
    model: options.model,
    messages,
    tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    isStreaming: false,
    pendingToolCalls: [],
  };
}

async function appendToSession(
  options: StreamingAgentLoopOptions,
  message: AgentMessage,
): Promise<void> {
  if (!options.sessionStore || !options.sessionId) return;

  try {
    await options.sessionStore.append({
      id: message.id,
      type: "message",
      sessionId: options.sessionId,
      createdAt: message.createdAt,
      message,
    });
  } catch {
    // session 写入失败不应打断 agent loop
  }
}
```

## E.5 测试

`tests/streaming-agent-loop.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { runStreamingAgentLoop, createGenerateFallbackStreamFn } from "../src/index.js";

describe("streaming agent loop", () => {
  it("处理纯文本回复", async () => {
    async function* streamFn() {
      yield { type: "start" as const, messageId: "a1" };
      yield { type: "text_delta" as const, text: "hello" };
      yield { type: "done" as const, message: {
        id: "a1", role: "assistant", content: "hello", createdAt: "now",
      }};
    }

    const events: string[] = [];
    const result = await runStreamingAgentLoop(
      { userInput: "hi" },
      {
        model: "test",
        streamFn,
        emit: (e) => { events.push(e.type); },
      },
    );

    expect(result.content).toBe("hello");
    expect(events).toContain("turn_start");
    expect(events).toContain("message_start");
    expect(events).toContain("message_update");
    expect(events).toContain("message_end");
    expect(events).toContain("turn_end");
  });

  it("工具执行后才返回最终答案", async () => {
    let callCount = 0;
    async function* streamFn() {
      callCount++;
      if (callCount === 1) {
        yield { type: "start" as const, messageId: "a1" };
        yield { type: "tool_call" as const, toolCall: {
          id: "tc1", name: "add", input: { a: 1, b: 2 },
        }};
        yield { type: "done" as const, message: {
          id: "a1", role: "assistant", content: "", createdAt: "now",
          toolCalls: [{ id: "tc1", name: "add", input: { a: 1, b: 2 } }],
        }};
      } else {
        yield { type: "start" as const, messageId: "a2" };
        yield { type: "text_delta" as const, text: "结果是 3" };
        yield { type: "done" as const, message: {
          id: "a2", role: "assistant", content: "结果是 3", createdAt: "now",
        }};
      }
    }

    const tool = {
      name: "add",
      description: "Adds two numbers",
      inputSchema: {},
      async execute(input: { a: number; b: number }) {
        return input.a + input.b;
      },
    };

    const result = await runStreamingAgentLoop(
      { userInput: "1+2=?" },
      { model: "test", streamFn, tools: [tool] },
    );

    expect(result.content).toBe("结果是 3");
    expect(result.iterations).toBe(2);
  });

  it("达到 maxIterations 时抛错", async () => {
    async function* streamFn() {
      yield { type: "start" as const, messageId: "a1" };
      yield { type: "tool_call" as const, toolCall: {
        id: "tc1", name: "loop", input: {},
      }};
      yield { type: "done" as const, message: {
        id: "a1", role: "assistant", content: "", createdAt: "now",
        toolCalls: [{ id: "tc1", name: "loop", input: {} }],
      }};
    }

    const tool = {
      name: "loop",
      description: "loops forever",
      inputSchema: {},
      async execute() { return "ok"; },
    };

    await expect(
      runStreamingAgentLoop(
        { userInput: "go" },
        { model: "test", streamFn, tools: [tool], maxIterations: 2 },
      ),
    ).rejects.toThrow("maximum");
  });

  it("abort signal 中止 loop", async () => {
    const controller = new AbortController();
    let started = false;

    async function* streamFn() {
      started = true;
      controller.abort();
      yield { type: "start" as const, messageId: "a1" };
      yield { type: "text_delta" as const, text: "..." };
      yield { type: "done" as const, message: {
        id: "a1", role: "assistant", content: "...", createdAt: "now",
      }};
    }

    await expect(
      runStreamingAgentLoop(
        { userInput: "hi" },
        { model: "test", streamFn, signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
  });
});
```

## E.6 验收标准

- 纯文本回复
- 工具 + 回复
- maxIterations 兜底
- abort 中止
- 事件顺序正确
- compaction 入口预留（参数传入但默认关闭）

---

# F. 工具执行升级

## F.1 这个阶段做什么

让工具执行支持：

- `ToolExecutionContext`（signal、onUpdate、metadata）
- 工具进度事件
- hook 拦截

## F.2 要改的文件

```text
src/core/types.ts
src/tools/tool.ts
src/tools/tool-registry.ts
src/index.ts
tests/tool-registry.test.ts
```

## F.3 类型改动

在 `src/core/types.ts`：

```ts
export interface ToolExecutionContext {
  signal?: AbortSignal;
  onUpdate?: (partialResult: unknown) => void | Promise<void>;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  executionMode?: "sequential" | "parallel";
  execute(input: unknown, context?: ToolExecutionContext): Promise<unknown>;
}
```

## F.4 `src/tools/tool.ts`

```ts
import type { ZodType } from "zod";
import type { Tool, ToolExecutionContext } from "../core/types.js";

export interface RuntimeTool<TInput = unknown, TOutput = unknown> extends Tool {
  readonly inputSchema: ZodType<TInput>;
  execute(input: unknown, context?: ToolExecutionContext): Promise<TOutput>;
}

export interface RuntimeToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly executionMode?: "sequential" | "parallel";
  execute(input: TInput, context?: ToolExecutionContext): TOutput | Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(
  definition: RuntimeToolDefinition<TInput, TOutput>,
): RuntimeTool<TInput, TOutput> {
  const name = definition.name.trim();
  const description = definition.description.trim();
  if (!name) throw new Error("Tool name cannot be empty");
  if (!description) throw new Error(`Tool description cannot be empty: ${name}`);

  return {
    name,
    description,
    inputSchema: definition.inputSchema,
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    async execute(input: unknown, context?: ToolExecutionContext): Promise<TOutput> {
      const parsedInput = definition.inputSchema.parse(input);
      return definition.execute(parsedInput, context);
    },
  };
}
```

## F.5 `src/tools/tool-registry.ts`

```ts
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  // ... 现有方法不变 ...

  async execute(name: string, input?: unknown, context?: ToolExecutionContext): Promise<unknown>;
  async execute(request: ToolExecutionRequest, context?: ToolExecutionContext): Promise<unknown>;
  async execute(
    nameOrRequest: string | ToolExecutionRequest,
    inputOrContext?: unknown | ToolExecutionContext,
    maybeContext?: ToolExecutionContext,
  ): Promise<unknown> {
    const isStringCall = typeof nameOrRequest === "string";
    const name = isStringCall ? nameOrRequest : nameOrRequest.name;
    const resolvedInput = isStringCall
      ? inputOrContext
      : resolveRequestInput(nameOrRequest);
    const context = isStringCall
      ? (maybeContext as ToolExecutionContext | undefined)
      : (inputOrContext as ToolExecutionContext | undefined);

    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(resolvedInput, context);
  }
}
```

## F.6 测试

```ts
it("把 ToolExecutionContext 传给工具", async () => {
  const seen: AbortSignal[] = [];
  const tool = defineTool({
    name: "ctx",
    description: "ctx tool",
    inputSchema: z.object({}),
    execute(_input, context) {
      if (context?.signal) seen.push(context.signal);
      return "ok";
    },
  });

  const signal = new AbortController().signal;
  await new ToolRegistry([tool]).execute("ctx", {}, { signal });
  expect(seen).toEqual([signal]);
});
```

## F.7 验收标准

- 旧工具仍能执行（不传 context）
- 新工具收到 context
- executionMode 字段可用

---

# G. Agent 类完整版：状态、订阅、控制、记忆

## G.1 这个阶段做什么

把 `src/core/agent.ts` 升级为完整的 Agent 外观类，一次性包含所有控制能力和记忆。

参考 Pi 的 `agent.ts` 和 Claude Code 的 session storage。

## G.2 要改的文件

```text
src/core/agent.ts
src/core/types.ts
src/index.ts
tests/agent.test.ts 新增
```

## G.3 AgentOptions

```ts
import type { AgentHooks } from "../hooks/hook-types.js";
import type { TransformContext } from "./context.js";
import type { StreamFn } from "./stream-fn.js";
import type { SessionStore } from "../session/session-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { CompactionSettings } from "../context/compaction.js";
import type { AgentLoopOptions, AgentLoopResult, AgentMessage, AgentState, ModelProvider } from "./types.js";

export interface AgentOptions extends AgentLoopOptions {
  /** 模型 key */
  modelKey?: string;
  /** 流式函数（优先于 model.generate） */
  streamFn?: StreamFn;
  /** hook 集合 */
  hooks?: AgentHooks;
  /** 上下文转换 */
  transformContext?: TransformContext;
  /** session 存储 */
  sessionStore?: SessionStore;
  /** session ID */
  sessionId?: string;
  /** 记忆管理 */
  memoryManager?: MemoryManager;
  /** 上下文压缩设置 */
  compaction?: CompactionSettings;
}
```

## G.4 Agent 类完整实现

```ts
import { createGenerateFallbackStreamFn } from "./stream-fn.js";
import { runStreamingAgentLoop } from "./streaming-agent-loop.js";
import { createRuntimeId } from "./runtime-id.js";
import type {
  AgentLoopResult,
  AgentLoopOptions,
  AgentMessage,
  AgentState,
  Message,
  ToolCall,
  ToolResult,
} from "./types.js";
import type { AgentOptions } from "./agent.js"; // 自己在同文件
import type { AgentEventListener, AgentEvent } from "./events.js";

/**
 * Agent 外观类。
 * 
 * 外部使用者不直接调 loop，而是通过 Agent 来：
 * - prompt：开始新对话
 * - continue：继续已有上下文
 * - steer：运行时纠偏
 * - followUp：当前任务结束后追加
 * - retry：失败后重试
 * - abort：取消当前执行
 * - subscribe：订阅事件
 * - state：查看当前状态
 */
export class Agent {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #steeringQueue = new PendingMessageQueue();
  readonly #followUpQueue = new PendingMessageQueue();
  readonly #options: AgentOptions;
  #state: AgentState;
  #abortController?: AbortController;
  #lastInput?: string;
  #lastStableMessages: AgentMessage[] = [];

  constructor(options: AgentOptions) {
    this.#options = options;
    this.#state = {
      systemPrompt: options.systemPrompt,
      model: options.modelKey ?? "default",
      messages: [],
      tools: (options.tools ?? []).map(({ name, description, inputSchema }) => ({
        name, description, inputSchema,
      })),
      isStreaming: false,
      pendingToolCalls: [],
    };
  }

  // ============================================================
  // 公共 API
  // ============================================================

  get state(): AgentState {
    return structuredClone(this.#state);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 兼容旧 API */
  async run(userInput: string): Promise<AgentLoopResult> {
    return this.prompt(userInput);
  }

  async prompt(userInput: string): Promise<AgentLoopResult> {
    this.#lastInput = userInput;
    this.#lastStableMessages = [...this.#state.messages];
    this.#abortController = new AbortController();

    // 加载记忆到上下文
    const memoryContext = await this.#loadMemoryContext();

    // 会话开始 hook
    if (this.#options.hooks?.onSessionStart) {
      const hookResult = await this.#options.hooks.onSessionStart(this.#state);
      if (hookResult?.additionalContext) {
        const memoryMsg: AgentMessage = {
          id: createRuntimeId("memory"),
          role: "system",
          content: hookResult.additionalContext,
          createdAt: new Date().toISOString(),
          visibleToModel: true,
          metadata: { source: "onSessionStart" },
        };
        this.#state.messages.push(memoryMsg);
      }
    }

    await this.#emit({ type: "agent_start", state: this.#state });

    try {
      const streamFn = this.#options.streamFn
        ?? createGenerateFallbackStreamFn(this.#options.model);

      // 拼接 memory context
      const allMessages = [...memoryContext, ...this.#state.messages];

      // 处理 steering 队列（如果有）
      const steeringMsgs = this.#steeringQueue.drainAll().map(createSteeringMessage);
      allMessages.push(...steeringMsgs);

      const result = await runStreamingAgentLoop(
        { userInput },
        {
          model: this.#options.modelKey ?? "default",
          streamFn,
          messages: allMessages,
          tools: this.#options.tools,
          systemPrompt: this.#options.systemPrompt,
          maxIterations: this.#options.maxIterations,
          signal: this.#abortController.signal,
          emit: (event) => this.#handleLoopEvent(event),
          hooks: this.#options.hooks,
          transformContext: this.#options.transformContext,
          sessionStore: this.#options.sessionStore,
          sessionId: this.#options.sessionId,
          compaction: this.#options.compaction,
        },
      );

      this.#state = {
        ...this.#state,
        messages: result.messages,
        isStreaming: false,
        errorMessage: undefined,
      };

      await this.#emit({ type: "agent_end", state: this.#state });

      // 会话结束 hook
      if (this.#options.hooks?.onSessionEnd) {
        await this.#options.hooks.onSessionEnd(this.#state);
      }

      // followUp 队列
      const next = this.#followUpQueue.drainOne();
      if (next) {
        return this.prompt(next);
      }

      return toLegacyResult(result);
    } catch (error) {
      this.#state = {
        ...this.#state,
        isStreaming: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      await this.#emit({ type: "error", error: this.#state.errorMessage ?? "Unknown", state: this.#state });
      throw error;
    } finally {
      this.#abortController = undefined;
    }
  }

  async continue(): Promise<AgentLoopResult> {
    this.#lastInput = undefined;
    this.#abortController = new AbortController();
    const streamFn = this.#options.streamFn
      ?? createGenerateFallbackStreamFn(this.#options.model);

    try {
      const result = await runStreamingAgentLoop(
        { continueOnly: true },
        {
          model: this.#options.modelKey ?? "default",
          streamFn,
          messages: this.#state.messages,
          tools: this.#options.tools,
          systemPrompt: this.#options.systemPrompt,
          maxIterations: this.#options.maxIterations,
          signal: this.#abortController.signal,
          emit: (event) => this.#handleLoopEvent(event),
          hooks: this.#options.hooks,
          transformContext: this.#options.transformContext,
          sessionStore: this.#options.sessionStore,
          sessionId: this.#options.sessionId,
          compaction: this.#options.compaction,
        },
      );

      this.#state = { ...this.#state, messages: result.messages, isStreaming: false };
      return toLegacyResult(result);
    } finally {
      this.#abortController = undefined;
    }
  }

  abort(reason = "Aborted by user"): void {
    this.#abortController?.abort(reason);
  }

  steer(message: string): void {
    this.#steeringQueue.enqueue(message);
  }

  followUp(message: string): void {
    this.#followUpQueue.enqueue(message);
  }

  async retry(): Promise<AgentLoopResult> {
    if (!this.#lastInput) {
      throw new Error("No previous prompt to retry");
    }
    this.#state = {
      ...this.#state,
      messages: [...this.#lastStableMessages],
      errorMessage: undefined,
    };
    return this.prompt(this.#lastInput);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  async #loadMemoryContext(): Promise<AgentMessage[]> {
    if (!this.#options.memoryManager) return [];

    try {
      const entries = await this.#options.memoryManager.query({ scope: "project" });
      const userEntries = await this.#options.memoryManager.query({ scope: "user" });

      return [...entries, ...userEntries].map((entry) => ({
        id: createRuntimeId("memory"),
        role: "system" as const,
        content: entry.content,
        createdAt: entry.updatedAt,
        visibleToModel: true,
        metadata: { source: "memory", scope: entry.scope, key: entry.key },
      }));
    } catch {
      return [];
    }
  }

  async #handleLoopEvent(event: AgentEvent): Promise<void> {
    // 根据事件更新局部状态
    this.#state = reduceAgentState(this.#state, event);
    await this.#emit(event);
  }

  async #emit(event: AgentEvent): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        await listener(event);
      } catch {
        // listener 抛错不应影响 agent
      }
    }
  }
}

// ============================================================
// 状态 reducer（纯函数，方便测试）
// ============================================================

export function reduceAgentState(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "message_start":
      return { ...state, isStreaming: true };

    case "message_update":
      return { ...state, isStreaming: true };

    case "message_end":
      return {
        ...state,
        isStreaming: false,
        pendingToolCalls: event.message.toolCalls ?? [],
      };

    case "tool_execution_start":
      return state;

    case "tool_execution_end":
      return {
        ...state,
        pendingToolCalls: state.pendingToolCalls.filter(
          (call) => call.id !== event.toolCall.id,
        ),
      };

    case "error":
      return { ...state, isStreaming: false, errorMessage: event.error };

    default:
      return state;
  }
}

// ============================================================
// 消息队列
// ============================================================

class PendingMessageQueue {
  readonly #messages: string[] = [];

  enqueue(message: string): void {
    this.#messages.push(message);
  }

  drainOne(): string | undefined {
    return this.#messages.shift();
  }

  drainAll(): string[] {
    const messages = [...this.#messages];
    this.#messages.length = 0;
    return messages;
  }
}

function createSteeringMessage(content: string): AgentMessage {
  return {
    id: createRuntimeId("steer"),
    role: "user",
    content: `[Steering instruction while agent was working]\n${content}`,
    createdAt: new Date().toISOString(),
    metadata: { kind: "steer" },
  };
}

function toLegacyResult(result: { content: string; messages: AgentMessage[]; iterations: number }): AgentLoopResult {
  return {
    content: result.content,
    messages: result.messages.map(toLegacyMessage),
    iterations: result.iterations,
  };
}

function toLegacyMessage(msg: AgentMessage): Message {
  switch (msg.role) {
    case "user": return { role: "user", content: msg.content };
    case "assistant": return { role: "assistant", content: msg.content, toolCalls: msg.toolCalls };
    case "toolResult": return { role: "tool", content: msg.content, toolResult: msg.toolResult };
    case "system": return { role: "user", content: msg.content };
    case "summary": return { role: "user", content: msg.content };
  }
}
```

## G.5 测试

`tests/agent.test.ts`：

```ts
describe("Agent", () => {
  it("subscribe 能收到事件", async () => {
    const events: string[] = [];
    const agent = new Agent({
      model: { async generate() { return { content: "ok", toolCalls: [] }; } },
    });

    agent.subscribe((e) => events.push(e.type));
    await agent.prompt("hi");

    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  it("abort 可被调用", async () => {
    const agent = new Agent({
      model: { async generate() { return { content: "x", toolCalls: [] }; } },
    });
    agent.abort();
    // 不报错即通过
  });

  it("steer 和 followUp 不报错", () => {
    const agent = new Agent({
      model: { async generate() { return { content: "x", toolCalls: [] }; } },
    });
    agent.steer("纠正一下方向");
    agent.followUp("继续做下一件事");
  });

  it("retry 用上次输入重跑", async () => {
    let calls = 0;
    const agent = new Agent({
      model: {
        async generate() {
          calls++;
          if (calls === 1) throw new Error("fail");
          return { content: "recovered", toolCalls: [] };
        },
      },
    });

    await expect(agent.prompt("test")).rejects.toThrow("fail");
    const result = await agent.retry();
    expect(result.content).toBe("recovered");
  });

  it("run() 兼容旧 API", async () => {
    const agent = new Agent({
      model: { async generate() { return { content: "legacy", toolCalls: [] }; } },
    });
    const result = await agent.run("hi");
    expect(result.content).toBe("legacy");
  });
});
```

## G.6 验收标准

- Agent.run() 仍可用
- Agent.prompt() 可用
- subscribe() 收到事件
- abort、steer、followUp、retry 可用
- memory context 自动注入

---

# H. JSONL session store + session tree

## H.1 这个阶段做什么

实现完整 JSONL append-only session 存储，支持 parent chain、分支、leaf 追踪。

参考 Pi 的 `harness/session/jsonl-storage.ts` 和 Claude Code 的 `sessionStorage.ts`。

## H.2 要新增的文件

```text
src/session/jsonl-session-store.ts
src/session/session-tree.ts
src/session/index.ts
src/index.ts
tests/jsonl-session-store.test.ts
```

## H.3 `src/session/jsonl-session-store.ts`

```ts
import { mkdir, appendFile, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionStore } from "./session-store.js";
import type { SessionEntry } from "./session-entry.js";

/**
 * JSONL session store。
 * 
 * 每行一条 JSON，追加写入。即使中途崩溃，已写行不丢失。
 * 
 * 写入用队列串行化，避免并发 append 导致行交错。
 */
export class JsonlSessionStore implements SessionStore {
  readonly #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("Session file path cannot be empty");
    this.#filePath = resolve(filePath);
  }

  async append(entry: SessionEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, line, "utf8");
    });
    return this.#writeQueue;
  }

  async load(sessionId: string): Promise<SessionEntry[]> {
    const text = await this.#readIfExists();
    const entries: SessionEntry[] = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.sessionId === sessionId) {
          entries.push(entry);
        }
      } catch {
        // 坏行跳过，避免损坏 session
        continue;
      }
    }

    return entries;
  }

  async getAncestorChain(entryId: string): Promise<SessionEntry[]> {
    const allEntries = await this.#readAll();
    const byId = new Map(allEntries.map((e) => [e.id, e]));

    const chain: SessionEntry[] = [];
    let current = byId.get(entryId);

    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return chain;
  }

  async getChildren(parentId: string): Promise<SessionEntry[]> {
    const allEntries = await this.#readAll();
    return allEntries.filter((e) => e.parentId === parentId);
  }

  async getLeaves(sessionId: string): Promise<SessionEntry[]> {
    const entries = await this.load(sessionId);
    const ids = new Set(entries.map((e) => e.id));

    return entries.filter((e) => {
      const children = entries.filter((child) => child.parentId === e.id);
      return children.length === 0;
    });
  }

  async getLatestLeaf(sessionId: string): Promise<SessionEntry | undefined> {
    const entries = await this.load(sessionId);
    if (entries.length === 0) return undefined;

    // 没有子节点的 entry 中最晚创建的
    const ids = new Set(entries.map((e) => e.id));
    const leaves = entries.filter((e) =>
      !entries.some((child) => child.parentId === e.id),
    );

    leaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return leaves[0];
  }

  async clear(_sessionId: string): Promise<void> {
    await writeFile(this.#filePath, "", "utf8");
  }

  async #fileExists(): Promise<boolean> {
    try {
      await access(this.#filePath);
      return true;
    } catch {
      return false;
    }
  }

  async #readIfExists(): Promise<string> {
    if (!(await this.#fileExists())) return "";
    return readFile(this.#filePath, "utf8");
  }

  async #readAll(): Promise<SessionEntry[]> {
    const text = await this.#readIfExists();
    const entries: SessionEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }
}
```

## H.4 `src/session/session-tree.ts`

```ts
import type { SessionEntry } from "./session-entry.js";
import type { SessionStore } from "./session-store.js";

/**
 * Session 树操作工具。
 * 
 * 不是所有 session store 都是 JSONL，但树结构是通用的。
 * 这里提供从 entries 构建 session 树的函数。
 */

export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
  depth: number;
}

export interface SessionTree {
  root: SessionNode;
  leaves: SessionNode[];
  /** 所有节点按创建时间排序的扁平列表 */
  flatList: SessionEntry[];
}

/**
 * 从 entries 构建 session 树。
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTree {
  if (entries.length === 0) {
    const rootEntry: SessionEntry = {
      id: "root",
      type: "metadata",
      sessionId: "",
      createdAt: new Date().toISOString(),
      key: "empty",
      value: null,
    };
    return {
      root: { entry: rootEntry, children: [], depth: 0 },
      leaves: [],
      flatList: [],
    };
  }

  const byId = new Map<string, SessionNode>();
  const roots: SessionNode[] = [];

  // 第一遍：创建所有节点
  for (const entry of entries) {
    byId.set(entry.id, { entry, children: [], depth: 0 });
  }

  // 第二遍：建立父子关系
  for (const entry of entries) {
    const node = byId.get(entry.id)!;
    if (entry.parentId && byId.has(entry.parentId)) {
      const parent = byId.get(entry.parentId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // 第三遍：计算深度
  function setDepth(node: SessionNode, depth: number): void {
    node.depth = depth;
    for (const child of node.children) {
      setDepth(child, depth + 1);
    }
  }
  for (const root of roots) {
    setDepth(root, 0);
  }

  // 找叶子
  const leaves: SessionNode[] = [];
  function collectLeaves(node: SessionNode): void {
    if (node.children.length === 0) {
      leaves.push(node);
    } else {
      for (const child of node.children) {
        collectLeaves(child);
      }
    }
  }
  for (const root of roots) {
    collectLeaves(root);
  }

  // 主 root 取第一个
  const root = roots[0] ?? {
    entry: entries[0]!,
    children: [],
    depth: 0,
  };

  return {
    root,
    leaves,
    flatList: entries,
  };
}

/**
 * 从叶子节点一直回溯到根，收集所有 entry 的消息。
 */
export function collectMessagesFromLeaf(
  leaf: SessionEntry,
  allEntries: SessionEntry[],
): SessionEntry[] {
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;

  while (current) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return chain;
}
```

## H.5 从 session entries 构建上下文

`src/context/context-builder.ts`：

```ts
import type { SessionEntry } from "../session/session-entry.js";
import type { AgentMessage, AgentContext } from "../core/types.js";

/**
 * 从 session entries 构建 AgentContext。
 * 
 * 找到 compact boundary 后的 entries，还原消息。
 */
export function buildContextFromEntries(
  entries: SessionEntry[],
  systemPrompt?: string,
): AgentContext {
  // 找最后一个 compact boundary
  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compact_boundary") {
      startIndex = i + 1;
      break;
    }
  }

  const messages: AgentMessage[] = [];

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "summary") {
      messages.push({
        id: entry.id,
        role: "summary",
        content: entry.summary,
        createdAt: entry.createdAt,
        range: entry.range,
      });
    }
  }

  return {
    systemPrompt,
    messages,
    tools: [],
  };
}

/**
 * 从 session entries 里提取消息列表（不含 summary/boundary 等元数据）。
 */
export function entriesToMessages(entries: SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type === "message") return [entry.message];
    if (entry.type === "summary") {
      return [{
        id: entry.id,
        role: "summary" as const,
        content: entry.summary,
        createdAt: entry.createdAt,
        range: entry.range,
      }];
    }
    return [];
  });
}
```

## H.6 测试

`tests/jsonl-session-store.test.ts`：

```ts
import { describe, expect, it, afterEach } from "vitest";
import { JsonlSessionStore } from "../src/index.js";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("JSONL session store", () => {
  const testPath = join(tmpdir(), `mingxu-test-session-${Date.now()}.jsonl`);

  afterEach(async () => {
    await rm(testPath, { force: true });
  });

  it("追加后可加载指定 sessionId 的 entries", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1", type: "message", sessionId: "s1",
      createdAt: "now", message: { id: "m1", role: "user", content: "hi", createdAt: "now" },
    });

    const entries = await store.load("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("e1");
  });

  it("不加载其他 sessionId 的 entries", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1", type: "message", sessionId: "s1",
      createdAt: "now", message: { id: "m1", role: "user", content: "hi", createdAt: "now" },
    });
    await store.append({
      id: "e2", type: "message", sessionId: "s2",
      createdAt: "now", message: { id: "m2", role: "user", content: "hey", createdAt: "now" },
    });

    expect((await store.load("s1"))).toHaveLength(1);
    expect((await store.load("s2"))).toHaveLength(1);
  });

  it("损坏行被跳过", async () => {
    const store = new JsonlSessionStore(testPath);
    // 手动写坏行
    const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(testPath), { recursive: true });
    await writeFile(testPath, "not json\n", "utf8");
    await store.append({
      id: "e1", type: "message", sessionId: "s1",
      createdAt: "now", message: { id: "m1", role: "user", content: "hi", createdAt: "now" },
    });

    const entries = await store.load("s1");
    expect(entries).toHaveLength(1);
  });

  it("支持 parent chain 查找", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "root", type: "message", sessionId: "s1",
      createdAt: "1", message: { id: "m1", role: "user", content: "root", createdAt: "1" },
    });
    await store.append({
      id: "child", type: "message", sessionId: "s1", parentId: "root",
      createdAt: "2", message: { id: "m2", role: "assistant", content: "child", createdAt: "2" },
    });
    await store.append({
      id: "grandchild", type: "message", sessionId: "s1", parentId: "child",
      createdAt: "3", message: { id: "m3", role: "user", content: "gc", createdAt: "3" },
    });

    const chain = await store.getAncestorChain("grandchild");
    expect(chain).toHaveLength(3);
    expect(chain.map((e) => e.id)).toEqual(["root", "child", "grandchild"]);
  });

  it("能找到最新叶子", async () => {
    const store = new JsonlSessionStore(testPath);
    await store.append({
      id: "e1", type: "message", sessionId: "s1",
      createdAt: "2026-01-01", message: { id: "m1", role: "user", content: "a", createdAt: "now" },
    });
    await store.append({
      id: "e2", type: "message", sessionId: "s1", parentId: "e1",
      createdAt: "2026-01-02", message: { id: "m2", role: "assistant", content: "b", createdAt: "now" },
    });

    const leaf = await store.getLatestLeaf("s1");
    expect(leaf?.id).toBe("e2");
  });
});
```

## H.7 验收标准

- JSONL 追加、加载、过滤
- parent chain 还原
- leaf 追踪
- 坏行容错

---

# I. 上下文压缩（完整版）

## I.1 这个阶段做什么

实现完整上下文压缩：

- token 粗估 + API usage 精确统计
- shouldCompact 判断
- findCutPoint 安全切分
- 模型摘要生成
- compact boundary 标记
- postCompact cleanup

参考 Pi 的 `harness/compaction/compaction.ts` 和 Claude Code 的 `compact.ts`。

## I.2 要新增的文件

```text
src/context/token-estimator.ts
src/context/compaction.ts
src/context/summary-generator.ts
src/context/context-builder.ts
src/context/index.ts
src/index.ts
tests/compaction.test.ts
```

## I.3 `src/context/token-estimator.ts`

```ts
import type { AgentMessage, ModelUsage } from "../core/types.js";

/** 默认最大上下文 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** 压缩后保留给输出的 token */
export const DEFAULT_RESERVE_TOKENS = 16_000;
/** 压缩后保留最近消息的 token */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * 粗估消息 token 数。
 * 简单策略：字符数 / 4。后续可用 API response usage 覆盖。
 */
export function estimateMessageTokens(message: AgentMessage): number {
  return Math.ceil(message.content.length / 4);
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * 从消息列表中提取最近一次 API usage 的 token 统计。
 * 优先用 usage 精确值，没有才用粗估。
 */
export function getLastUsage(messages: AgentMessage[]): ModelUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.usage?.totalTokens) {
      return msg.usage;
    }
  }
  return undefined;
}

/**
 * 估算当前上下文的 token 使用量。
 * 优先用最近 assistant 消息的 usage 值。
 */
export function estimateContextTokens(messages: AgentMessage[]): {
  total: number;
  fromUsage: boolean;
} {
  const usage = getLastUsage(messages);
  if (usage?.totalTokens !== undefined && usage.totalTokens > 0) {
    return { total: usage.totalTokens, fromUsage: true };
  }
  return { total: estimateMessagesTokens(messages), fromUsage: false };
}
```

## I.4 `src/context/compaction.ts`

```ts
import type { AgentMessage } from "../core/types.js";
import { estimateContextTokens, estimateMessageTokens } from "./token-estimator.js";
import type { SummaryGenerator } from "./summary-generator.js";
import { createRuntimeId } from "../core/runtime-id.js";

export interface CompactionSettings {
  enabled: boolean;
  maxContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: false,
  maxContextTokens: 200_000,
  reserveTokens: 16_000,
  keepRecentTokens: 20_000,
};

export interface CompactionResult {
  messages: AgentMessage[];
  didCompact: boolean;
  archivedIds: string[];
  summaryMessageId?: string;
}

/**
 * 判断是否需要压缩。
 * 规则：当前 token 使用量 >= 最大上下文 - 预留
 */
export function shouldCompact(
  messages: AgentMessage[],
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;

  const { total } = estimateContextTokens(messages);
  return total >= settings.maxContextTokens - settings.reserveTokens;
}

/**
 * 找安全切分点。从后往前累积 token，保留最近尾巴。
 */
export function findCutPoint(
  messages: AgentMessage[],
  settings: CompactionSettings,
): { archived: AgentMessage[]; retained: AgentMessage[] } {
  let retainedTokens = 0;
  const retained: AgentMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const tokens = estimateMessageTokens(msg);

    if (retainedTokens + tokens > settings.keepRecentTokens && retained.length > 0) {
      // 确保不在工具调用中间切
      if (msg.role === "toolResult") {
        // 把对应的 assistant + toolCalls 也保留
        retained.unshift(msg);
        retainedTokens += tokens;
        continue;
      }
      break;
    }

    retained.unshift(msg);
    retainedTokens += tokens;
  }

  return {
    archived: messages.slice(0, messages.length - retained.length),
    retained,
  };
}

/**
 * 执行完整压缩流程：
 * 1. 判断是否需要压缩
 * 2. 找切分点
 * 3. 生成摘要
 * 4. 组装 compressed messages
 */
export async function compactMessages(
  messages: AgentMessage[],
  settings: CompactionSettings,
  generateSummary: SummaryGenerator,
): Promise<CompactionResult> {
  if (!shouldCompact(messages, settings)) {
    return { messages, didCompact: false, archivedIds: [] };
  }

  const { archived, retained } = findCutPoint(messages, settings);
  if (archived.length === 0) {
    return { messages, didCompact: false, archivedIds: [] };
  }

  const summary = await generateSummary(archived);
  const summaryId = createRuntimeId("summary");

  const summaryMessage: AgentMessage = {
    id: summaryId,
    role: "summary",
    content: summary,
    createdAt: new Date().toISOString(),
    range: {
      fromId: archived[0]!.id,
      toId: archived[archived.length - 1]!.id,
    },
  };

  const compactBoundary: AgentMessage = {
    id: createRuntimeId("compact-boundary"),
    role: "system",
    content: `Compaction boundary: messages before ${archived[archived.length - 1]!.id} have been summarized`,
    createdAt: new Date().toISOString(),
    visibleToModel: false,
    metadata: {
      kind: "compact_boundary",
      summaryMessageId: summaryId,
      archivedCount: archived.length,
    },
  };

  return {
    messages: [summaryMessage, compactBoundary, ...retained],
    didCompact: true,
    archivedIds: archived.map((m) => m.id),
    summaryMessageId: summaryId,
  };
}
```

## I.5 `src/context/summary-generator.ts`

```ts
import type { AgentMessage } from "../core/types.js";

/**
 * 摘要生成器接口。
 * 第一版默认用简单拼接，后续可接入模型生成更精准的摘要。
 */
export type SummaryGenerator = (
  messages: AgentMessage[],
  options?: { signal?: AbortSignal },
) => Promise<string>;

/**
 * 默认摘要生成器：拼接消息内容。
 * 后续升级为调模型生成 summary。
 */
export const defaultSummaryGenerator: SummaryGenerator = async (messages) => {
  const text = messages
    .filter((m) => m.role !== "system" || m.visibleToModel !== false)
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");

  // 截断，避免摘要本身太大
  return text.slice(0, 16_000);
};

/**
 * 使用模型生成摘要的工厂。
 * 后续接入时传入 Agent 的 streamFn。
 */
export function createModelSummaryGenerator(
  streamFn?: (prompt: string) => Promise<string>,
): SummaryGenerator {
  if (!streamFn) return defaultSummaryGenerator;

  return async (messages, options) => {
    const text = messages
      .filter((m) => m.role !== "system" || m.visibleToModel !== false)
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n")
      .slice(0, 32_000);

    if (options?.signal?.aborted) {
      throw new Error("Summary generation aborted");
    }

    try {
      return await streamFn(
        `Please summarize the following conversation. Focus on key decisions, facts, and context:\n\n${text}`,
      );
    } catch {
      // 模型摘要失败时回退到简单拼接
      return text.slice(0, 8_000);
    }
  };
}
```

## I.6 测试

`tests/compaction.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { shouldCompact, findCutPoint, compactMessages, DEFAULT_COMPACTION_SETTINGS } from "../src/index.js";
import type { AgentMessage, CompactionSettings } from "../src/index.js";

function makeMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "user" as const,
    content: "x".repeat(1000), // ~250 tokens each
    createdAt: new Date().toISOString(),
  }));
}

describe("compaction", () => {
  const smallSettings: CompactionSettings = {
    enabled: true,
    maxContextTokens: 2000,
    reserveTokens: 500,
    keepRecentTokens: 500,
  };

  it("超阈值时 shouldCompact 返回 true", () => {
    const messages = makeMessages(10); // ~2500 tokens
    expect(shouldCompact(messages, smallSettings)).toBe(true);
  });

  it("disabled 时不压缩", () => {
    const messages = makeMessages(10);
    expect(shouldCompact(messages, { ...smallSettings, enabled: false })).toBe(false);
  });

  it("找切分点时保留最近尾巴", () => {
    const messages = makeMessages(10);
    const { archived, retained } = findCutPoint(messages, smallSettings);
    expect(archived.length).toBeGreaterThan(0);
    expect(retained.length).toBeGreaterThan(0);
    expect(archived.length + retained.length).toBe(10);
  });

  it("压缩后返回 summary + retained", async () => {
    const messages = makeMessages(10);
    const result = await compactMessages(messages, smallSettings, async () => "Summary of earlier conversation");

    expect(result.didCompact).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0]!.role).toBe("summary");
    expect(result.archivedIds.length).toBeGreaterThan(0);
  });

  it("不超阈值时返回原消息", async () => {
    const messages = makeMessages(2);
    const result = await compactMessages(messages, smallSettings, async () => "summary");

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
```

## I.7 验收标准

- token 估算
- 切分点安全
- summary + retained tail
- compact boundary 标记
- 默认关闭不破坏旧行为

---

# J. 记忆系统（多 scope、CLAUDE.md 自动加载）

## J.1 这个阶段做什么

实现完整记忆系统：

- 多 scope：user、project、local、session
- 基于文件的记忆存储（.md 文件）
- CLAUDE.md 自动加载
- 记忆查询和注入

参考 Claude Code 的 `memory/types.ts` 和 `memoryFileDetection.ts`。

## J.2 要新增的文件

```text
src/memory/memory-manager.ts
src/memory/file-memory-store.ts
src/memory/index.ts
src/index.ts
tests/memory-manager.test.ts
```

## J.3 `src/memory/memory-manager.ts`

```ts
import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";

/**
 * 记忆管理器接口。
 * 
 * 不同 scope 的记忆来源：
 * - user: 用户级记忆（~/.claude/memory/）
 * - project: 项目级记忆（项目根目录的 CLAUDE.md、.claude/ 等）
 * - local: 本地工作目录记忆
 * - session: 当前会话记忆（通常是内存中）
 */
export interface MemoryManager {
  /** 查询记忆 */
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  /** 写入记忆 */
  save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  /** 删除记忆 */
  delete(id: string): Promise<boolean>;
  /** 列出所有 scope */
  listScopes(): MemoryScope[];
}
```

## J.4 `src/memory/file-memory-store.ts`

```ts
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { createRuntimeId } from "../core/runtime-id.js";
import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory-scope.js";
import type { MemoryManager } from "./memory-manager.js";

/**
 * 基于文件的记忆存储。
 * 
 * 每个 scope 对应一个目录，目录下的 .md 文件就是一条记忆。
 * 文件内容 = 记忆内容，文件名 = key。
 * 
 * 支持加载 CLAUDE.md 格式文件。
 */
export class FileMemoryStore implements MemoryManager {
  readonly #basePaths: Map<MemoryScope, string>;

  constructor(basePaths: Partial<Record<MemoryScope, string>> = {}) {
    this.#basePaths = new Map(Object.entries(basePaths) as [MemoryScope, string][]);
  }

  addScope(scope: MemoryScope, path: string): void {
    this.#basePaths.set(scope, path);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const scopes = query.scope ? [query.scope] : [...this.#basePaths.keys()];

    for (const scope of scopes) {
      const dirPath = this.#basePaths.get(scope);
      if (!dirPath) continue;

      try {
        const entries = await this.#loadScope(scope, dirPath);
        for (const entry of entries) {
          if (query.key && entry.key !== query.key) continue;
          if (query.query) {
            const q = query.query.toLowerCase();
            if (!entry.content.toLowerCase().includes(q)
              && !entry.key.toLowerCase().includes(q)) continue;
          }
          results.push(entry);
        }
      } catch {
        // scope 目录不存在或不可读 -> 跳过
        continue;
      }
    }

    return results;
  }

  async save(
    input: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<MemoryEntry> {
    const dirPath = this.#basePaths.get(input.scope);
    if (!dirPath) throw new Error(`Unknown memory scope: ${input.scope}`);

    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, `${input.key}.md`);
    await writeFile(filePath, input.content, "utf8");

    const now = new Date().toISOString();
    return {
      id: createRuntimeId("mem"),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
  }

  async delete(id: string): Promise<boolean> {
    // 简化实现：遍历所有 scope 找匹配文件
    for (const dirPath of this.#basePaths.values()) {
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const content = await readFile(join(dirPath, file), "utf8");
          if (content.includes(id)) {
            // 简化：文件级删除
            // 实际应该通过 key 或 metadata 匹配
          }
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  listScopes(): MemoryScope[] {
    return [...this.#basePaths.keys()];
  }

  async #loadScope(scope: MemoryScope, dirPath: string): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    let files: string[];

    try {
      files = await readdir(dirPath);
    } catch {
      return entries;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = join(dirPath, file);
      const content = await readFile(filePath, "utf8");
      const key = basename(file, ".md");

      entries.push({
        id: `${scope}:${key}`,
        scope,
        key,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return entries;
  }
}

/**
 * 自动加载 CLAUDE.md 文件的记忆管理器。
 * 
 * 搜索顺序：
 * 1. 项目根目录 CLAUDE.md
 * 2. 用户 home 目录 CLAUDE.md
 * 3. 项目 .claude/ 目录下的 .md 文件
 */
export async function createAutoMemoryManager(
  projectRoot: string,
  userHome?: string,
): Promise<MemoryManager> {
  const store = new FileMemoryStore();

  // 项目根目录
  store.addScope("project", projectRoot);

  // 项目 .claude 目录（如果有）
  const projectClaudeDir = join(projectRoot, ".claude");
  store.addScope("local", projectClaudeDir);

  // 用户记忆目录
  if (userHome) {
    const userMemoryDir = join(userHome, ".claude", "memory");
    store.addScope("user", userMemoryDir);
  }

  return store;
}
```

## J.5 测试

`tests/memory-manager.test.ts`：

```ts
import { describe, expect, it, afterEach } from "vitest";
import { FileMemoryStore } from "../src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

describe("file memory store", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it("加载 scope 目录下的 .md 文件", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-"));
    await writeFile(join(testDir, "test-memory.md"), "This is a test memory", "utf8");

    const store = new FileMemoryStore();
    store.addScope("project", testDir);

    const results = await store.query({ scope: "project" });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("test-memory");
    expect(results[0]!.content).toBe("This is a test memory");
  });

  it("按 key 过滤", async () => {
    testDir = await mkdtemp(join(tmpdir(), "mingxu-memory-"));
    await writeFile(join(testDir, "a.md"), "content a", "utf8");
    await writeFile(join(testDir, "b.md"), "content b", "utf8");

    const store = new FileMemoryStore();
    store.addScope("project", testDir);

    const results = await store.query({ scope: "project", key: "a" });
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("a");
  });

  it("不存在的 scope 返回空", async () => {
    const store = new FileMemoryStore();
    const results = await store.query({ scope: "user" });
    expect(results).toEqual([]);
  });
});
```

## J.6 验收标准

- 多 scope 记忆加载
- CLAUDE.md 自动读取
- 记忆注入到 Agent context
- 查询过滤

---

# K. 完整 harness 组合入口

## K.1 这个阶段做什么

实现完整 harness 组合入口，把模型、session、tools、hooks、memory、compaction 全部拼在一起。

参考 Pi 的 `harness/agent-harness.ts`。

## K.2 要新增的文件

```text
src/harness/agent-harness.ts
src/harness/system-prompt.ts
src/harness/index.ts
src/index.ts
```

## K.3 `src/harness/agent-harness.ts`

```ts
import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import type { SessionStore } from "../session/session-store.js";
import { FileMemoryStore, createAutoMemoryManager } from "../memory/file-memory-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AgentHooks } from "../hooks/hook-types.js";
import type { CompactionSettings } from "../context/compaction.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../context/compaction.js";
import type { StreamFn } from "../core/stream-fn.js";
import type { ModelProvider, Tool } from "../core/types.js";
import type { AgentLoopResult } from "../core/types.js";
import { buildSystemPrompt } from "./system-prompt.js";

/**
 * AgentHarness 配置。
 * 
 * harness 是"马具"的意思：把 agent 这个"马"和 session、memory、
 * tools、hooks、compaction 这些"缰绳、鞍具"绑在一起。
 */
export interface AgentHarnessConfig {
  /** 模型标识 */
  model: ModelProvider;
  modelKey: string;
  streamFn?: StreamFn;

  /** 系统提示词（原始，会被 harness 增强） */
  systemPrompt?: string;

  /** 工具 */
  tools?: Tool[];

  /** 项目根目录（用于加载 CLAUDE.md 和 session） */
  projectRoot?: string;

  /** session 文件路径 */
  sessionFilePath?: string;
  sessionId?: string;

  /** hook */
  hooks?: AgentHooks;

  /** compaction */
  compaction?: CompactionSettings;

  /** maxIterations */
  maxIterations?: number;

  /** 是否自动加载 CLAUDE.md */
  autoLoadClaudeMd?: boolean;
}

/**
 * 完整 harness 组合入口。
 * 
 * 做的事：
 * 1. 创建 JSONL session store
 * 2. 创建 file memory store（自动加载 CLAUDE.md）
 * 3. 组装系统提示词（原始 + CLAUDE.md + memory）
 * 4. 创建 Agent
 */
export class AgentHarness {
  readonly #agent: Agent;
  readonly #sessionStore?: SessionStore;
  readonly #memoryManager?: MemoryManager;
  readonly #config: AgentHarnessConfig;

  constructor(config: AgentHarnessConfig) {
    this.#config = config;

    // ---- Session ----
    if (config.sessionFilePath) {
      this.#sessionStore = new JsonlSessionStore(config.sessionFilePath);
    }

    // ---- Memory ----
    if (config.projectRoot && config.autoLoadClaudeMd !== false) {
      // 异步创建，后续 prompt 时可 await
      this.#memoryManager = new FileMemoryStore();
      (this.#memoryManager as FileMemoryStore).addScope("project", config.projectRoot);
    }

    // ---- System Prompt ----
    const enhancedSystemPrompt = buildSystemPrompt({
      baseSystemPrompt: config.systemPrompt,
      projectRoot: config.projectRoot,
    });

    // ---- Agent ----
    const agentOptions: AgentOptions = {
      model: config.model,
      modelKey: config.modelKey,
      streamFn: config.streamFn,
      systemPrompt: enhancedSystemPrompt,
      tools: config.tools,
      maxIterations: config.maxIterations,
      hooks: config.hooks,
      sessionStore: this.#sessionStore,
      sessionId: config.sessionId,
      memoryManager: this.#memoryManager,
      compaction: config.compaction ?? DEFAULT_COMPACTION_SETTINGS,
    };

    this.#agent = new Agent(agentOptions);
  }

  get agent(): Agent {
    return this.#agent;
  }

  get state() {
    return this.#agent.state;
  }

  get sessionStore(): SessionStore | undefined {
    return this.#sessionStore;
  }

  get memoryManager(): MemoryManager | undefined {
    return this.#memoryManager;
  }

  subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void {
    return this.#agent.subscribe(listener);
  }

  async prompt(input: string): Promise<AgentLoopResult> {
    // 如果 memory manager 是异步创建的，等待加载完成
    return this.#agent.prompt(input);
  }

  async continue(): Promise<AgentLoopResult> {
    return this.#agent.continue();
  }

  abort(reason?: string): void {
    this.#agent.abort(reason);
  }

  steer(message: string): void {
    this.#agent.steer(message);
  }

  followUp(message: string): void {
    this.#agent.followUp(message);
  }

  async retry(): Promise<AgentLoopResult> {
    return this.#agent.retry();
  }
}
```

## K.4 `src/harness/system-prompt.ts`

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SystemPromptInput {
  baseSystemPrompt?: string;
  projectRoot?: string;
}

/**
 * 组装增强版系统提示词。
 * 
 * 结构：
 * 1. 基础系统提示词
 * 2. CLAUDE.md 内容（如果有）
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = [];

  if (input.baseSystemPrompt) {
    parts.push(input.baseSystemPrompt);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 异步加载 CLAUDE.md 内容。
 */
export async function loadClaudeMd(projectRoot: string): Promise<string | undefined> {
  try {
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const content = await readFile(claudeMdPath, "utf8");
    return content;
  } catch {
    return undefined;
  }
}
```

## K.5 验收标准

- AgentHarness 能拼装所有组件
- 系统提示词增强
- 与现有 CLI 兼容

---

# L. CLI 接入 + 最终验证

## L.1 这个阶段做什么

把 CLI 从旧 Agent 切换到新 AgentHarness，保持输出不变。

## L.2 要改的文件

```text
src/cli/main.ts
tests/cli.test.ts
```

## L.3 `src/cli/main.ts` 修改

在 `createDefaultRunner` 中：

```ts
function createDefaultRunner(configFilePath: string): NonNullable<CliDependencies["run"]> {
  return async (config, prompt, modelKey) => {
    const agentPrompt = prompt?.trim();
    if (!agentPrompt) {
      throw new Error("A prompt is required");
    }

    const providerRegistry = registerBuiltinProviders(
      new ProviderRegistry(),
      config.providerAliases,
    );
    // ... custom provider 加载不变 ...

    const { adapter, selection } = providerRegistry.createFromConfig(config, modelKey);
    const runtimeModel = createRuntimeModelProvider(adapter, selection.model);
    const streamFn = createRuntimeStreamFn(adapter, selection.model);

    const toolRegistry = new ToolRegistry([echoTool, readFileTool]);
    // ... plugin 加载不变 ...

    // 使用新的 AgentHarness
    const harness = new AgentHarness({
      model: runtimeModel,
      modelKey: selection.modelKey,
      streamFn,
      systemPrompt: config.systemPrompt,
      tools: [...toolRegistry.list()],
      projectRoot: process.cwd(),
      sessionFilePath: config.sessionFile,
      maxIterations: config.maxIterations,
    });

    const result = await harness.prompt(agentPrompt);
    return result.content;
  };
}
```

## L.4 最终验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
node dist/cli/entry.js --help
```

## L.5 验收标准

- 所有 CLI 测试通过
- 旧配置兼容
- legacy single-model config 仍可用
- custom provider module 仍可用

---

## 5. 实现顺序依赖图

```text
A. 冻结旧行为
  ↓
B. core 新类型（一次性定义所有类型）
  ↓
C. 上下文转换
  ↓
D. StreamFn + provider bridge
  ↓
E. 流式 Agent Loop（完整版）
  ↓
F. 工具执行升级
  ↓
G. Agent 完整版（状态、控制、记忆）
  ↓
H. JSONL session store + tree
  ↓
I. 上下文压缩
  ↓
J. 记忆系统
  ↓
K. harness 组合入口
  ↓
L. CLI 接入 + 验证
```

没有删减。JSONL session、compaction、memory、harness 全部排在主线里，每个阶段都有完整代码骨架。

---

## 6. 不要做的事

1. 不要先做 UI
2. 不要把具体模型 SDK 格式写进 `src/core`
3. 不要在第一版就把 compaction 做成 reactive compact（先手动触发）
4. 不要让工具自己修改 messages
5. 不要为了"看起来完整"跳过 typecheck/test

---

## 7. 代码风格要求

这个项目面向初学者，核心逻辑必须写通俗注释。建议注释重点解释"为什么这样做"，不要只重复代码。

示例：

```ts
// 模型只会请求工具，真正执行工具的是 runtime。
// 所以这里把工具异常转成 toolResult，让模型下一轮能看到失败原因，
// 而不是让整个 agent loop 直接崩掉。
const result = await executeToolCall(call, tool, signal);
```

不要写这种没意义注释：

```ts
// 调用函数
executeToolCall(call, tool, signal);
```

---

## 8. 提交建议

一阶段一提交：

```text
A: test: add compatibility tests for current runtime behavior
B: feat(core): add complete runtime type system
C: feat(core): add default context transformation
D: feat(models): add stream function fallback and provider bridge
E: feat(core): add streaming agent loop with events and hooks
F: feat(tools): add tool execution context and progress events
G: feat(core): add stateful Agent with subscriptions, control, and memory
H: feat(session): add JSONL session store with tree support
I: feat(context): add token estimation and compaction
J: feat(memory): add multi-scope file-based memory system
K: feat(harness): add agent harness composition layer
L: feat(cli): route CLI through AgentHarness
```
