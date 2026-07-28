import type { AgentMessage, AgentState, ToolCall, ToolResult } from "../core/types.js";

// ============================================================
// 工具相关 hook
// ============================================================

/**
 * beforeToolCall hook 的返回值。
 * - allow：放行，可以同时修改工具的输入参数
 * - deny：拒绝执行，附带拒绝原因
 * - ask：需要用户审批
 */
export type BeforeToolCallResult =
  | { behavior: "allow"; input?: unknown }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason?: string };

/**
 * afterToolCall hook 的返回值。
 * 可以修改工具输出（output）、追加额外上下文（additionalContext），或者什么都不做。
 */
export type AfterToolCallResult =
  | { output?: unknown; additionalContext?: string }
  | void;

// ============================================================
// 会话生命周期 hook
// ============================================================

/** 会话开始时触发，可以往上下文里注入额外信息 */
export type SessionStartResult = { additionalContext?: string } | void;
/** 会话结束时触发，用于清理资源 */
export type SessionEndResult = void;

// ============================================================
// 上下文压缩相关 hook
// ============================================================

/** 压缩前触发，可以注入自定义压缩指令或附加上下文 */
export type PreCompactResult =
  | { additionalContext?: string; customInstructions?: string }
  | void;
/** 压缩后触发 */
export type PostCompactResult = void;

// ============================================================
// 用户输入 hook
// ============================================================

/** 用户提交输入后触发，可以修改或增强用户输入 */
export type UserPromptSubmitResult =
  | { updatedPrompt?: string; additionalContext?: string }
  | void;

// ============================================================
// Hook 集合
// ============================================================

/**
 * AgentHooks：所有 hook 的集合。
 *
 * Hook 就像是"事件侦听器"——在 agent 生命周期的关键节点插入自定义逻辑。
 * 和事件（AgentEvent）的区别是：hook 可以修改行为（比如拒绝工具执行），
 * 而事件只是"通知"——不能改变流程。
 */
export interface AgentHooks {
  /** 工具执行前触发——可以拒绝执行或修改输入 */
  beforeToolCall?: (
    call: ToolCall,
    state: AgentState,
  ) => BeforeToolCallResult | Promise<BeforeToolCallResult>;

  /** 工具执行后触发——可以修改输出或注入额外上下文 */
  afterToolCall?: (
    call: ToolCall,
    result: ToolResult,
    state: AgentState,
  ) => AfterToolCallResult | Promise<AfterToolCallResult>;

  /** 会话开始 */
  onSessionStart?: (
    state: AgentState,
  ) => SessionStartResult | Promise<SessionStartResult>;

  /** 会话结束 */
  onSessionEnd?: (
    state: AgentState,
  ) => SessionEndResult | Promise<SessionEndResult>;

  /** 上下文压缩前 */
  preCompact?: (
    trigger: "manual" | "auto",
    state: AgentState,
  ) => PreCompactResult | Promise<PreCompactResult>;

  /** 上下文压缩后 */
  postCompact?: (
    state: AgentState,
  ) => PostCompactResult | Promise<PostCompactResult>;

  /** 用户提交输入时 */
  onUserPromptSubmit?: (
    prompt: string,
    state: AgentState,
  ) => UserPromptSubmitResult | Promise<UserPromptSubmitResult>;
}
