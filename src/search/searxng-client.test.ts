import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeSearchFailure, formatResults, parseSearxng, searchUrl } from './searxng-client';

test('searchUrl always asks for JSON and carries the config', () => {
  const url = new URL(
    searchUrl(
      'http://127.0.0.1:50881',
      { language: 'ru-RU', safeSearch: 1, categories: ['general'] },
      { query: 'oil prices', timeRange: 'week' },
    ),
  );
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'oil prices');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('language'), 'ru-RU');
  assert.equal(url.searchParams.get('safesearch'), '1');
  assert.equal(url.searchParams.get('categories'), 'general');
  assert.equal(url.searchParams.get('time_range'), 'week');
});

test('searchUrl tolerates a base URL written with a trailing slash', () => {
  assert.ok(
    searchUrl('http://host:8080/', {}, { query: 'x' }).startsWith('http://host:8080/search?'),
  );
});

test("searchUrl lets the call's category override the configured ones", () => {
  const url = new URL(
    searchUrl('http://h', { categories: ['general'] }, { query: 'x', category: 'news' }),
  );
  assert.equal(url.searchParams.get('categories'), 'news');
});

test('parseSearxng maps rows and caps them at the limit', () => {
  const outcome = parseSearxng(
    {
      results: [
        { url: 'https://a.example', title: 'A', content: 'about A', engine: 'duckduckgo' },
        { url: 'https://b.example', title: 'B', content: 'about B', publishedDate: '2026-05-01' },
        { url: 'https://c.example', title: 'C' },
      ],
    },
    2,
  );
  assert.equal(outcome.results.length, 2);
  assert.deepEqual(outcome.results[0], {
    title: 'A',
    url: 'https://a.example',
    snippet: 'about A',
    engine: 'duckduckgo',
  });
  assert.equal(outcome.results[1].publishedAt, '2026-05-01');
});

test('parseSearxng skips rows without a URL and falls back to the URL as title', () => {
  const outcome = parseSearxng({ results: [{ title: 'no url' }, { url: 'https://x.example' }] }, 5);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].title, 'https://x.example');
  assert.equal(outcome.results[0].snippet, '');
});

test('parseSearxng reads answers in both the string and object shapes', () => {
  const outcome = parseSearxng({ answers: ['42', { answer: 'forty two' }, { nothing: 1 }] }, 5);
  assert.deepEqual(outcome.answers, ['42', 'forty two']);
});

test('parseSearxng survives a reply with nothing in it', () => {
  assert.deepEqual(parseSearxng(null, 5), { results: [], answers: [] });
});

test('describeSearchFailure names the two misconfigurations that look healthy', () => {
  assert.match(describeSearchFailure(403, 'http://h'), /formats: \[json\]/);
  assert.match(describeSearchFailure(429, 'http://h'), /limiter/);
  assert.match(describeSearchFailure(500, 'http://h'), /answered 500/);
});

test('formatResults lists sources and tells the model to open them', () => {
  const text = formatResults(
    { results: [{ title: 'A', url: 'https://a.example', snippet: 'about A' }], answers: ['42'] },
    'question',
  );
  assert.match(text, /The engine's direct answer: 42/);
  assert.match(text, /1\. A/);
  assert.match(text, /https:\/\/a\.example/);
  assert.match(text, /web_fetch/);
});

test('formatResults says plainly when nothing was found', () => {
  const text = formatResults({ results: [], answers: [] }, 'nothing of the sort');
  assert.match(text, /Nothing was found/);
});
