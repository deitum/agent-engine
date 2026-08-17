import { type ChatRole } from './llm.enums';

/**
 * A request by the model to call a tool. `function.arguments` is a JSON string
 * (OpenAI encodes tool arguments as a string, not an object) — and one the model
 * wrote, so it is not guaranteed to parse. Put anything that came off a stream
 * through {@link normalizeToolArguments} before storing or forwarding it.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: ChatRole;
  /**
   * `null` is valid per the OpenAI schema for assistant turns that only carry
   * `tool_calls`, and stays legal here because the provider is configurable.
   * The app itself sends `''` instead: our gateway rejects the `null` with a
   * flat `500`, and `''` is what every path already agreed on (langchain, which
   * serializes the connector's requests, never emits `null`).
   */
  content: string | null;
  /** Present on assistant turns that request one or more tool calls. */
  tool_calls?: ToolCall[];
  /** Present on {@link ChatRole.Tool} messages: the call this result answers. */
  tool_call_id?: string;
  /** Optional tool/function name (used on tool-result messages). */
  name?: string;
}

/**
 * A tool the model may call, in OpenAI function-calling format. `parameters`
 * is the tool's JSON Schema.
 */
export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * An OpenAI-compatible chat-completion request, as the connector sends it to the
 * gateway. The connector always asks the gateway to stream (it is streaming-only
 * upstream) and decides per caller what to do with the reply: relay the SSE to
 * the browser, or fold it into one {@link ChatCompletion} for its own agents.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Tools exposed to the model for this request (MCP methods). */
  tools?: ChatCompletionTool[];
  /** Tool-selection strategy forwarded verbatim to the upstream LLM. */
  tool_choice?: 'auto' | 'none' | 'required';
}

/** A fragment of a streamed tool call (arguments arrive incrementally). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Incremental content produced by the streamed completion. */
export interface ChatCompletionDelta {
  content?: string;
  tool_calls?: ToolCallDelta[];
}

/** A single choice inside a streamed completion chunk. */
export interface ChatCompletionChoice {
  delta: ChatCompletionDelta;
  finish_reason: string | null;
}

/**
 * Real token counts reported by the provider for a completion. Populated when
 * the request opts in via `stream_options: { include_usage: true }`; the
 * provider then emits a final chunk carrying `usage` (and empty `choices`).
 */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * One Server-Sent-Event chunk of an OpenAI-compatible streamed completion
 * (the JSON carried by each `data:` line, excluding the terminal `[DONE]`).
 */
export interface ChatCompletionChunk {
  choices: ChatCompletionChoice[];
  /** Present only on the terminal usage chunk (see {@link CompletionUsage}). */
  usage?: CompletionUsage | null;
}

/** The assistant message of a non-streamed completion choice. */
export interface ChatCompletionMessage {
  role: 'assistant';
  /** `null` when the turn produced only tool calls (OpenAI shape). */
  content: string | null;
  /** Present when the assistant requested one or more tool calls. */
  tool_calls?: ToolCall[];
}

/** A single choice of a non-streamed completion. */
export interface ChatCompletionResponseChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
}

/**
 * A non-streamed OpenAI-compatible chat completion. The connector synthesizes
 * this for its own deep-agent model calls by aggregating the streamed gateway
 * reply (see {@link ChatCompletionRequest}); its shape matches what `ChatOpenAI`
 * expects from a `stream: false` request.
 */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionResponseChoice[];
  usage?: CompletionUsage | null;
}

/** A model entry returned by `POST /llm/models` on the local connector. */
export interface ModelInfo {
  id: string;
  object: string;
  owned_by: string;
  /**
   * Size of the model's context window in tokens, when the upstream provider
   * reports it. Absent when the provider does not expose it.
   */
  context_length?: number;
}

/** Shape of `POST /llm/models` responses (OpenAI-compatible list). */
export interface ModelsListResponse {
  object: 'list';
  data: ModelInfo[];
}

/**
 * Everything the daemon needs from a deployment to reach the model, as the
 * endpoint named by {@link EngineConfigRequest.hostConfigUrl} answers it.
 *
 * The daemon fetches this itself during the handshake, which is what lets the
 * gateway address stay an administrative setting: the client passes a URL, never
 * the address, and never has to hold it.
 */
export interface LlmConfig {
  /** Base URL (including any version prefix) of the OpenAI-compatible gateway. */
  baseUrl: string;
  /**
   * PEM certificate blocks the connector adds to the trust store of its own
   * process, so a corporate TLS gateway works without the user setting
   * `NODE_EXTRA_CA_CERTS`. Empty when the deployment declares no `CA_CERT_DIR`.
   */
  caCerts?: string[];
}

/**
 * `POST /llm/chat/completions` on the connector. The daemon relays the gateway's
 * SSE verbatim, so the browser parses the very same chunks it used to get from
 * the API proxy.
 *
 * There are no credentials here: the token is part of the configuration the
 * browser hands over once, when it connects (see {@link EngineConfigRequest}).
 */
export interface LlmChatRequest {
  request: ChatCompletionRequest;
}
