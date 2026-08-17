import {
  type ChatCompletion,
  type ChatCompletionChunk,
  type CompletionUsage,
  type ToolCall,
} from '../contracts';

/**
 * Aggregates a streamed OpenAI-compatible completion (an SSE `Response`) into a
 * single non-streamed {@link ChatCompletion}. The gateway is streaming-only, but
 * this daemon's own `ChatOpenAI` calls are non-streaming (`invoke`) and expect a
 * plain JSON completion — so `createLlmFetch` requests `stream: true` upstream and
 * folds the chunks back together here.
 *
 * Mirrors the browser-side reducer in `entities/chat/api/chat.api.ts`: content
 * is concatenated, tool-call fragments are assembled by their `index`, and the
 * terminal usage chunk (empty `choices`) supplies token counts.
 */
export async function aggregateCompletion(
  response: Response,
  model: string,
): Promise<ChatCompletion> {
  let content = '';
  let finishReason: string | null = null;
  let usage: CompletionUsage | null = null;
  // Tool calls stream as fragments keyed by `index`; accumulate their pieces.
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const data of streamSse(response)) {
    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      continue;
    }

    // The terminal usage chunk carries `usage` with empty `choices`.
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (choice.delta.content) {
      content += choice.delta.content;
    }

    for (const fragment of choice.delta.tool_calls ?? []) {
      const current = toolAcc.get(fragment.index) ?? { id: '', name: '', arguments: '' };
      if (fragment.id) {
        current.id = fragment.id;
      }
      if (fragment.function?.name) {
        current.name = fragment.function.name;
      }
      if (fragment.function?.arguments) {
        current.arguments += fragment.function.arguments;
      }
      toolAcc.set(fragment.index, current);
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => ({
      id: value.id,
      type: 'function',
      function: { name: value.name, arguments: value.arguments },
    }));

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI reports `null` content on a tool-call-only turn.
          content: content || (toolCalls.length > 0 ? null : ''),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/**
 * Yields the JSON payload of each `data:` line of an SSE `Response`, stopping at
 * the terminal `[DONE]` sentinel. Server-side twin of the browser's `streamSse`.
 */
async function* streamSse(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith('data:')) {
          continue;
        }

        const data = line.slice('data:'.length).trim();
        if (data === '[DONE]') {
          return;
        }
        if (data) {
          yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
