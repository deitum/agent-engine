import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type ChatMessage, ChatRole } from '../contracts';
import { loadDeps } from '../deep-agent';

import {
  buildContextReport,
  contextWindowOf,
  FALLBACK_CONTEXT_TOKENS,
  historyTokensOf,
  SUMMARIZE_AT_RATIO,
  summarizeAtTokens,
} from './code-context';

/** A manifest with the one number the report actually reads. */
const manifest = (totalTokens: number) => ({
  files: [],
  totalChars: totalTokens * 4,
  totalTokens,
  notesBudgetChars: 8_000,
  overBudget: false,
  failures: [],
});

describe('buildContextReport', () => {
  test('the overhead is the sum of what the model sees before the conversation', () => {
    const report = buildContextReport({
      systemPrompt: 'a'.repeat(400),
      memory: manifest(500),
      skills: [{ id: '1', name: 'n', description: 'd', instructions: 'i'.repeat(200), files: [] }],
      toolDescriptions: ['b'.repeat(80), 'c'.repeat(120)],
    });

    assert.equal(report.systemTokens, 100);
    assert.equal(report.skillsTokens, 51);
    assert.equal(report.toolsTokens, 50);
    assert.equal(report.toolCount, 2);
    assert.equal(report.overheadTokens, 100 + 500 + 51 + 50);
  });

  test('history is counted only when it was handed over', () => {
    const messages: ChatMessage[] = [
      { role: ChatRole.User, content: 'x'.repeat(40) },
      {
        role: ChatRole.Assistant,
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"q":"todo"}' } },
        ],
      },
      { role: ChatRole.Tool, content: 'y'.repeat(80), tool_call_id: 'c1' },
    ];

    const withHistory = buildContextReport({
      systemPrompt: '',
      memory: manifest(0),
      skills: [],
      toolDescriptions: [],
      messages,
    });
    assert.equal(withHistory.historyTokens, historyTokensOf(messages));
    assert.ok((withHistory.historyTokens ?? 0) > 30, 'tool calls and results are counted too');

    const atRest = buildContextReport({
      systemPrompt: '',
      memory: manifest(0),
      skills: [],
      toolDescriptions: [],
    });
    assert.equal(atRest.historyTokens, undefined);
  });
});

describe('summarization threshold', () => {
  test('follows the reported window', () => {
    assert.equal(contextWindowOf(200_000), 200_000);
    assert.equal(summarizeAtTokens(200_000), 200_000 * SUMMARIZE_AT_RATIO);
  });

  test('falls back below the library default when the provider reports nothing', () => {
    assert.equal(contextWindowOf(undefined), FALLBACK_CONTEXT_TOKENS);
    // The library's own profile-less fallback is 170_000 tokens. Ours has to sit
    // under the windows real deployments serve, or the request fails before
    // summarization ever gets a chance to run.
    assert.ok(summarizeAtTokens(undefined) < 170_000);
    assert.equal(summarizeAtTokens(0), FALLBACK_CONTEXT_TOKENS * SUMMARIZE_AT_RATIO);
  });
});

describe('tuned middleware', () => {
  test('carry the names deepagents uses, so they replace the built-ins', async () => {
    // This is the whole mechanism: `createDeepAgent` merges `middleware` over its
    // own stack by name ("same-name custom entries replace matching defaults"),
    // which is how the Code path gets a summarizer sized to the real window. If a
    // future deepagents renames either middleware, ours stops replacing anything
    // and silently reverts to the defaults — so the names are asserted here.
    const { createSummarizationMiddleware, createFilesystemMiddleware } = await loadDeps();
    const backend = {} as Parameters<typeof createSummarizationMiddleware>[0]['backend'];

    assert.equal(createSummarizationMiddleware({ backend }).name, 'SummarizationMiddleware');
    assert.equal(createFilesystemMiddleware({ backend }).name, 'FilesystemMiddleware');
  });
});
