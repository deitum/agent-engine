import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Repetition } from './repetition';
import { createTokenStream } from './token-stream';

/** The middleware factory as `loadDeps` hands it over — here, its config verbatim. */
interface FakeMiddleware {
  name: string;
  wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
}

const createMiddleware = (config: unknown): unknown => config;

/** The handler as langchain calls it, with the two callbacks we implement. */
interface Callbacks {
  handleLLMNewToken: (token: string, idx: unknown, runId: string) => void;
  handleLLMEnd: (output: unknown, runId: string) => void;
}

/** One finished call, in the shape `handleLLMEnd` receives. */
const ended = (id: string) => ({ generations: [[{ message: { id } }]] });

function build() {
  const deltas: string[] = [];
  const stuck: Repetition[] = [];
  const stream = createTokenStream(
    createMiddleware,
    (delta) => deltas.push(delta),
    (repetition) => stuck.push(repetition),
  );
  return {
    deltas,
    stuck,
    stream,
    handler: stream.callbacks[0] as Callbacks,
    middleware: stream.middleware as FakeMiddleware,
  };
}

/** One line of the loop this guards against, long enough to be reported. */
const STUCK_LINE = 'Checking `example-libs` — no. Checking `example-api` — no.\n\n';

test('tokens reach the sink while the agent’s own call is running', async () => {
  const { deltas, handler, middleware, stream } = build();

  await middleware.wrapModelCall({}, () => {
    handler.handleLLMNewToken('Hel', 0, 'run-1');
    handler.handleLLMNewToken('lo', 0, 'run-1');
    handler.handleLLMEnd(ended('chatcmpl-1'), 'run-1');
    return Promise.resolve({});
  });

  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.ok(stream.streamedIds.has('chatcmpl-1'));
});

/**
 * The summarizer calls the same model instance, from inside the same graph node,
 * to compact the history — but outside the agent's own call. Its text is not the
 * answer and must never reach the transcript, nor mark a message as streamed.
 */
test('a call made outside that one streams nothing and marks nothing', () => {
  const { deltas, handler, stream } = build();

  handler.handleLLMNewToken('a summary of the history was here', 0, 'run-summary');
  handler.handleLLMEnd(ended('chatcmpl-summary'), 'run-summary');

  assert.deepEqual(deltas, []);
  assert.equal(stream.streamedIds.has('chatcmpl-summary'), false);
  assert.equal(stream.streamedIds.has('run-run-summary'), false);
});

/**
 * The id has to be the assembled message's, which is the one the graph puts in
 * its state. Providers give each fragment an id of its own, and the first
 * fragment — role only, no text — is both the one the assembly inherits and the
 * one no token is ever reported for.
 */
test('the recorded id is the finished call’s, not a fragment’s', async () => {
  const { handler, middleware, stream } = build();

  await middleware.wrapModelCall({}, () => {
    handler.handleLLMNewToken('', 0, 'run-2');
    handler.handleLLMNewToken('text', 0, 'run-2');
    handler.handleLLMEnd(ended('chatcmpl-final'), 'run-2');
    return Promise.resolve({});
  });

  assert.deepEqual([...stream.streamedIds].sort(), ['chatcmpl-final', 'run-run-2']);
});

/** A turn that only called a tool wrote nothing for the user to have read. */
test('a call that streamed no text leaves its message to the completed step', async () => {
  const { deltas, handler, middleware, stream } = build();

  await middleware.wrapModelCall({}, () => {
    handler.handleLLMNewToken('', 0, 'run-3');
    handler.handleLLMEnd(ended('chatcmpl-tools'), 'run-3');
    return Promise.resolve({});
  });

  assert.deepEqual(deltas, []);
  assert.equal(stream.streamedIds.size, 0);
});

/**
 * The loop happens inside one model call, so nothing downstream — not the step
 * budget, not the graph — ever gets to see it. The tokens are the only place it
 * can be caught while it is happening.
 */
test('an answer repeating itself is reported once, and stops being relayed', async () => {
  const { deltas, stuck, handler, middleware } = build();

  await middleware.wrapModelCall({}, () => {
    for (let i = 0; i < 8; i += 1) {
      handler.handleLLMNewToken(STUCK_LINE, 0, 'run-1');
    }
    handler.handleLLMEnd(ended('chatcmpl-1'), 'run-1');
    return Promise.resolve({});
  });

  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]?.copies, 4);
  // The four copies that made the repetition are relayed; the rest are not,
  // because the turn is over the moment the caller hears about it.
  assert.equal(deltas.length, 4);
});

/** Two calls that each say the same thing are not one call saying it twice. */
test('the watch starts over for each model call', async () => {
  const { stuck, handler, middleware } = build();

  await middleware.wrapModelCall({}, () => {
    for (let i = 0; i < 3; i += 1) {
      handler.handleLLMNewToken(STUCK_LINE, 0, 'run-1');
    }
    handler.handleLLMEnd(ended('chatcmpl-1'), 'run-1');
    for (let i = 0; i < 3; i += 1) {
      handler.handleLLMNewToken(STUCK_LINE, 0, 'run-2');
    }
    handler.handleLLMEnd(ended('chatcmpl-2'), 'run-2');
    return Promise.resolve({});
  });

  assert.deepEqual(stuck, []);
});

/** The gate closes even when the model call it wraps throws. */
test('a failed call does not leave the stream open for the next one', async () => {
  const { deltas, handler, middleware } = build();

  await assert.rejects(
    middleware.wrapModelCall({}, () => Promise.reject(new Error('gateway said no'))),
    /gateway said no/,
  );
  handler.handleLLMNewToken('not an answer any more', 0, 'run-4');

  assert.deepEqual(deltas, []);
});
