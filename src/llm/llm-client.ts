import { resolveApiKey, resolveGatewayUrl } from '../config/engine-config';
import { ConnectorError } from '../connector';
import {
  type ChatCompletionRequest,
  type ModelInfo,
  type ModelsListResponse,
  parseToolArguments,
} from '../contracts';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../package.constants';

import { aggregateCompletion } from './llm-aggregate';
import { LLM_LOGGED_BODY_CHARS, LLM_UPSTREAM_PATHS, USER_AGENT_VAR } from './llm.constants';

/** A chat request as it goes out: always streamed, because the gateway is. */
type UpstreamChatRequest = ChatCompletionRequest & {
  stream: true;
  stream_options: { include_usage: true };
};

/**
 * Sends one chat completion to the gateway and hands the raw response back for
 * relaying. Always asks the gateway to stream — that is the only mode it has —
 * and adds `include_usage` so the terminal chunk carries real token counts.
 *
 * The token comes from the adopted configuration rather than from the request:
 * it is the user's, it is the same for every call, and it was handed over once
 * when the browser connected (`config/engine-config.ts`).
 *
 * Throws a {@link ConnectorError} with the gateway's own status on a rejection,
 * after logging what was sent: the gateway's error body is often opaque, and the
 * request summary is usually what names the cause.
 */
export async function chatCompletion(request: ChatCompletionRequest): Promise<Response> {
  const path = LLM_UPSTREAM_PATHS.chatCompletions;
  const body = JSON.stringify(upstreamBody(request));

  const response = await gatewayFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey()}` },
    body,
  });

  if (!response.ok) {
    throw await upstreamError(response, path, request, body);
  }
  if (!response.body) {
    throw new ConnectorError(502, `The LLM gateway answered ${response.status} with no body`);
  }
  return response;
}

/** Lists the gateway's models, with their context window normalized. */
export async function listModels(): Promise<ModelsListResponse> {
  const path = LLM_UPSTREAM_PATHS.models;
  const response = await gatewayFetch(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${resolveApiKey()}` },
  });

  if (!response.ok) {
    throw await upstreamError(response, path);
  }

  const payload = (await response.json()) as ModelsListResponse;
  return { ...payload, data: (payload.data ?? []).map(normalizeModel) };
}

/**
 * One rejected attempt at the gateway, as the run that made it hears about it.
 *
 * A model call is retried by langchain, silently and with an exponential
 * backoff, so a gateway that refuses the first few attempts costs the turn tens
 * of seconds during which nothing at all is said. This is what makes that wait
 * explicable — see {@link createLlmFetch}.
 */
export interface GatewayAttempt {
  /** Consecutive failures so far, this one included. */
  attempt: number;
  /** The gateway's own status, when it answered at all. */
  status?: number;
  /** Why it failed: the gateway's message, or the transport error. */
  reason: string;
}

/** Told about each rejected attempt, in the order they happen. */
export type GatewayAttemptSink = (attempt: GatewayAttempt) => void;

/** How much of the gateway's own message survives into the user-facing notice. */
const ATTEMPT_REASON_CHARS = 200;

/**
 * One rejected attempt as a sentence for the user. Deliberately says only what
 * happened: whether a retry follows is the caller's budget to know, and a notice
 * promising one that never comes is worse than no notice at all.
 */
export function gatewayAttemptMessage({ attempt, status, reason }: GatewayAttempt): string {
  const detail =
    reason.length > ATTEMPT_REASON_CHARS ? `${reason.slice(0, ATTEMPT_REASON_CHARS)}…` : reason;
  return status === undefined
    ? `The LLM gateway could not be reached on attempt ${attempt}: ${detail}`
    : `The LLM gateway rejected attempt ${attempt} with ${status}: ${detail}`;
}

/**
 * Builds the `fetch` this daemon's own `ChatOpenAI` instances are given.
 *
 * Three things the OpenAI SDK cannot do for itself happen here. It sends
 * `stream: false` for an `invoke`, which the gateway (streaming-only) refuses —
 * so the request is upgraded to a stream and the reply folded back into one
 * `ChatCompletion` before the SDK sees it. A rejected request is summarized to
 * the console, which is the only place a failing agent turn can be read back now
 * that no server is in the path. And every rejection is counted and handed to
 * `onAttemptFailed`, because the retries that follow it are otherwise invisible:
 * langchain's `AsyncCaller` retries a failed call six times by default, waiting
 * up to ~113s in total, and neither the chat nor the console shows a trace of it.
 *
 * The counter is per-instance, and an instance belongs to one turn: consecutive
 * failures are the retries of a single model call, and any success resets it.
 */
export function createLlmFetch(onAttemptFailed?: GatewayAttemptSink) {
  let consecutiveFailures = 0;

  const rejected = (reason: string, status?: number): void => {
    consecutiveFailures += 1;
    onAttemptFailed?.({
      attempt: consecutiveFailures,
      ...(status !== undefined ? { status } : {}),
      reason,
    });
  };

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Anything that is not a JSON chat completion (the SDK's own metadata calls)
    // goes out untouched — only the streaming mismatch is ours to fix.
    if (!url.endsWith(LLM_UPSTREAM_PATHS.chatCompletions) || typeof init?.body !== 'string') {
      return fetchUpstream(url, init ?? {});
    }

    const parsed = JSON.parse(init.body) as ChatCompletionRequest & { stream?: boolean };
    const clientStreaming = parsed.stream === true;
    const body = JSON.stringify(upstreamBody(parsed));

    // `content-length` would still describe the body we replaced.
    const headers = new Headers(init.headers);
    headers.delete('content-length');

    let response: Response;
    try {
      response = await fetchUpstream(url, { ...init, headers, body });
    } catch (error) {
      // The transport failed. `fetchUpstream` has already named it in the log;
      // the run is told so the user is not left watching a backoff.
      rejected(attemptReason(error));
      throw error;
    }

    if (!response.ok) {
      // Logged, not thrown: the SDK turns the response into its own `APIError`,
      // which is what langchain and the agent middleware know how to report.
      // Cloned: the SDK still has to read this body to build its own error.
      const message = await logUpstreamFailure(
        response.clone(),
        LLM_UPSTREAM_PATHS.chatCompletions,
        parsed,
        body,
      );
      rejected(message, response.status);
      return response;
    }

    consecutiveFailures = 0;

    if (clientStreaming) {
      return response;
    }

    const completion = await aggregateCompletion(response, parsed.model);
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/** The body every request goes out with: streamed, with usage reporting on. */
function upstreamBody(request: ChatCompletionRequest): UpstreamChatRequest {
  return { ...request, stream: true, stream_options: { include_usage: true } };
}

/** Calls the adopted gateway, resolving `path` against its base URL. */
function gatewayFetch(path: string, init: RequestInit): Promise<Response> {
  return fetchUpstream(`${resolveGatewayUrl()}/${path}`, init);
}

/**
 * `fetch` with the failure modes named. A daemon that cannot reach the gateway
 * is the common case now that the call is made from the user's own machine, and
 * "fetch failed" on its own sends nobody anywhere — least of all when the reason
 * is a corporate certificate the deployment could have published itself.
 *
 * A transport failure is **logged** here and not only thrown. It is the one
 * failure mode this module used to swallow: a rejected *response* was summarized
 * to the console, but a connection that was reset or never opened left no trace
 * at all — while langchain quietly retried it for the next minute and a half.
 * «The chat hangs and the daemon says nothing» was that, every time.
 */
async function fetchUpstream(url: string, init: RequestInit): Promise<Response> {
  const started = Date.now();
  const headers = new Headers(init.headers);
  headers.set('user-agent', userAgent());
  try {
    const response = await fetch(url, { ...init, headers });
    if (process.env.AGENT_ENGINE_DEBUG_TIMING === '1') {
      console.log(`[llm] ${url} answered ${response.status} in ${Date.now() - started}ms`);
    }
    return response;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code ?? '';
    const reason = cause?.message ?? (error instanceof Error ? error.message : String(error));
    console.error(
      `[llm] ${url} could not be reached after ${Date.now() - started}ms: ${code || 'no code'} — ${reason}`,
    );

    if (isTrustFailure(code)) {
      // No `cause`: this message is an instruction, and whoever reports the
      // attempt should quote all of it rather than the bare error code.
      throw new ConnectorError(
        502,
        `The LLM gateway's certificate was not trusted (${code}). Publish the CA from the ` +
          'deployment (CA_CERT_DIR on the API), or start this connector with NODE_EXTRA_CA_CERTS.',
      );
    }
    const failure = new ConnectorError(502, `Could not reach the LLM gateway at ${url}: ${reason}`);
    // The message names the URL because it may be the last thing a dead turn
    // says; an attempt notice already has that context, so it quotes this.
    failure.cause = code ? `${code} — ${reason}` : reason;
    throw failure;
  }
}

/**
 * What this daemon calls the gateway as.
 *
 * The OpenAI SDK announces itself as `langchainjs-openai/…`, and that is worth
 * replacing rather than leaving alone: it names a library instead of the program
 * making the call, and corporate gateways route on it. On the deployment this
 * was found in, **any** `User-Agent` containing «langchain» was answered in
 * 61–84 seconds while the identical request under any other name came back in
 * ~1.3 — measured with the same body, key and URL, one header apart. The daemon
 * naming itself is both the honest header and the fast one.
 *
 * `AGENT_ENGINE_USER_AGENT` overrides it, for a deployment whose gateway expects
 * something specific.
 */
function userAgent(): string {
  return (process.env[USER_AGENT_VAR] ?? '').trim() || `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
}

/** The shortest true account of a thrown attempt (see {@link fetchUpstream}). */
function attemptReason(error: unknown): string {
  if (error instanceof Error) {
    return typeof error.cause === 'string' ? error.cause : error.message;
  }
  return String(error);
}

/**
 * Whether an error code means "I do not trust this certificate".
 *
 * Matched on more than the word `CERT` because the most common one of all —
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which is exactly what a corporate CA the
 * daemon has not been given produces — does not contain it.
 */
function isTrustFailure(code: string): boolean {
  return (
    code.includes('CERT') ||
    code.includes('SIGNATURE') ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL')
  );
}

/**
 * Providers report the context-window size under different keys (OpenRouter's
 * `context_length`, vLLM's `max_model_len`, others' `context_window` /
 * `max_context_length`). Normalize whichever is present into
 * {@link ModelInfo.context_length} so the client has one field to read.
 */
function normalizeModel(model: ModelInfo): ModelInfo {
  const raw = model as ModelInfo & Record<string, unknown>;
  const candidate =
    raw.context_length ??
    raw.context_window ??
    raw.max_context_length ??
    raw.max_model_len ??
    raw.max_context_window;
  const contextLength =
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
      ? candidate
      : undefined;

  return contextLength ? { ...model, context_length: contextLength } : model;
}

/** Logs a rejected request and returns the error to throw for it. */
async function upstreamError(
  response: Response,
  path: string,
  request?: ChatCompletionRequest,
  body?: string,
): Promise<ConnectorError> {
  const message = await logUpstreamFailure(response, path, request, body);
  return new ConnectorError(response.status, message);
}

/**
 * Logs a non-OK gateway response (status + path + body, which carries the
 * provider's own traceId) and returns its human-readable message.
 *
 * The gateway's own error body is often opaque — a bare `"UNPROCESSABLE_ENTITY"`
 * or a flat `500` naming nothing — so the *request* is what pinpoints the
 * rejected field. It is logged as a **summary** rather than verbatim: a
 * turn that edits code carries whole source files inside `tool_calls.arguments`,
 * and the raw body drowns everything else in the terminal. The body itself is
 * still there, trimmed, under `AGENT_ENGINE_DEBUG_EVENTS`.
 */
async function logUpstreamFailure(
  response: Response,
  path: string,
  request?: ChatCompletionRequest,
  body?: string,
): Promise<string> {
  const message = await safeErrorBody(response);
  console.error(`[llm] ${path} failed with ${response.status}: ${message}`);
  if (request) {
    console.error(`[llm] ${path} request: ${describeRequest(request, body)}`);
  }
  if (body && process.env.AGENT_ENGINE_DEBUG_EVENTS === '1') {
    console.error(`[llm] ${path} request body: ${body.slice(0, LLM_LOGGED_BODY_CHARS)}`);
  }
  return message;
}

/**
 * One readable line describing what was sent: model, size, the shape of the
 * conversation and the tools that were on the table. Everything a strict
 * gateway is likely to have objected to is a count or a name here — an
 * over-long tool list, an unanswered `tool_calls`, a request past a size
 * limit — so the line is usually enough to name the cause without a repro.
 */
function describeRequest(request: ChatCompletionRequest, serialized?: string): string {
  const messages = request.messages ?? [];
  const roles = new Map<string, number>();
  let toolCalls = 0;
  let answered = 0;
  let badArgs = 0;
  let nullContent = 0;

  for (const message of messages) {
    roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
    toolCalls += message.tool_calls?.length ?? 0;
    if (message.tool_call_id) {
      answered += 1;
    }
    if (message.content === null) {
      nullContent += 1;
    }
    for (const call of message.tool_calls ?? []) {
      if (parseToolArguments(call.function.arguments) === null) {
        badArgs += 1;
      }
    }
  }

  const parts = [
    `model=${request.model}`,
    `bytes=${serialized ? Buffer.byteLength(serialized) : 0}`,
    `messages=${messages.length}`,
    `roles=${[...roles].map(([role, count]) => `${role}:${count}`).join(',') || 'none'}`,
    // A mismatch here is an invalid conversation, and gateways reject it
    // without saying so: every `tool_calls` entry needs its own answer.
    `toolCalls=${toolCalls}/answers=${answered}`,
    // The other two shapes a strict gateway has been seen to refuse without
    // naming: arguments the model wrote that are not valid JSON, and a `null`
    // content. Both are legal OpenAI and both are the client's to avoid, so a
    // non-zero count here says whose bug it is before anyone opens a browser.
    `badArgs=${badArgs}`,
    `nullContent=${nullContent}`,
    `tools=${request.tools?.length ?? 0}`,
  ];

  const names = (request.tools ?? []).map((tool) => tool.function.name).join(',');
  if (names) {
    parts.push(`toolNames=${names}`);
  }
  return parts.join(' ');
}

/**
 * Extracts a human-readable message from a gateway error response. Prefers the
 * OpenAI-style `{ error: { message } }` shape, then a bare `message`, then the
 * raw text, and finally a generic status line.
 */
async function safeErrorBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return `The LLM gateway failed with ${response.status}`;
  }

  if (!text) {
    return `The LLM gateway failed with ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.message;
    if (message) {
      return message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }

  return text;
}
