import { DEFAULT_MAX_ITERATIONS } from "./runtime-defaults.js";
import type { AgentLoopOptions, AgentLoopResult, Message, ModelInput } from "./types.js";

const SESSION_MESSAGES_KEY = "messages";

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;

  try {
    const serialized = JSON.stringify(output);
    return serialized ?? String(output);
  } catch {
    return String(output);
  }
}

async function executeTool(
  call: { id: string; name: string; input: unknown },
  tool?: { execute(input: unknown): Promise<unknown> },
): Promise<{ role: "tool"; content: string; toolResult: { toolCallId: string; name: string; output: unknown; isError?: boolean } }> {
  let result: { toolCallId: string; name: string; output: unknown; isError?: boolean };

  if (!tool) {
    result = {
      toolCallId: call.id,
      name: call.name,
      output: `Unknown tool: ${call.name}`,
      isError: true,
    };
  } else {
    try {
      result = {
        toolCallId: call.id,
        name: call.name,
        output: await tool.execute(call.input),
      };
    } catch (error) {
      result = {
        toolCallId: call.id,
        name: call.name,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  return {
    role: "tool",
    content: serializeToolOutput(result.output),
    toolResult: result,
  };
}

export async function runAgentLoop(
  userInput: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }

  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  // A configured store resumes the prior conversation; without one the loop
  // keeps its existing one-shot, in-memory behavior.
  const storedMessages = await options.sessionStore?.get(SESSION_MESSAGES_KEY);
  const messages: Message[] = [...(storedMessages ?? []), { role: "user", content: userInput }];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const modelInput: ModelInput = {
      messages: [...messages],
      ...(options.tools?.length ? { tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    };
    const output = await options.model.generate(modelInput);
    const assistantMessage = {
      role: "assistant" as const,
      content: output.content,
      ...(output.toolCalls.length > 0 ? { toolCalls: [...output.toolCalls] } : {}),
    };
    messages.push(assistantMessage);

    if (output.toolCalls.length === 0) {
      // Persist only completed turns, avoiding a session file that ends halfway
      // through a tool exchange when execution fails or reaches its limit.
      await options.sessionStore?.set(SESSION_MESSAGES_KEY, messages);
      return { content: output.content, messages, iterations: iteration };
    }

    for (const call of output.toolCalls) {
      messages.push(await executeTool(call, tools.get(call.name)));
    }
  }

  throw new Error(`Agent loop reached the maximum of ${maxIterations} iterations`);
}
