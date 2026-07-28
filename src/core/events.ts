import type { AgentMessage, AgentState, ToolCall, ToolResult } from "./types.js";
import type { AssistantStreamEvent } from "./stream-types.js";

/**
 * AgentEvent：agent 运行时产生的所有事件的集合。
 *
 * 类比：就像车间里的各个指示灯——开工亮绿灯（agent_start），
 * 每个轮次开始亮蓝灯（turn_start），出错亮红灯（error）。
 * 外部监听器通过订阅这些事件来了解 agent 内部在干什么。
 */
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

/** 事件监听器：可以同步或异步处理事件 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/** 事件发送器：和监听器类型一样，但语义上表示"发送端" */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
