import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkUrl, formatPage, isPrivateHost, isTextualType } from './fetch-page';

test('isPrivateHost covers loopback, RFC-1918 and link-local', () => {
  for (const host of [
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    'wiki.local',
    'db.internal',
    '::1',
    '[fd00::1]',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
});

test('isPrivateHost leaves public hosts alone, including near-misses', () => {
  for (const host of ['example.com', '172.32.0.1', '11.0.0.1', '192.169.0.1', '8.8.8.8']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('checkUrl refuses an internal address unless the deployment opted in', () => {
  assert.match(checkUrl('http://169.254.169.254/latest/meta-data', {}) ?? '', /internal network/);
  assert.equal(
    checkUrl('http://wiki.internal/page', { fetch: { allowPrivateNetwork: true } }),
    null,
  );
});

test('checkUrl refuses non-http schemes and unparseable input', () => {
  assert.match(checkUrl('file:///etc/passwd', {}) ?? '', /is not supported/);
  assert.match(checkUrl('ftp://host/x', {}) ?? '', /is not supported/);
  assert.match(checkUrl('just text', {}) ?? '', /does not look like a URL/);
});

test('checkUrl passes an ordinary public page', () => {
  assert.equal(checkUrl('https://example.com/doc?a=1', {}), null);
});

test('isTextualType accepts the readable types and the +json/+xml families', () => {
  assert.equal(isTextualType('text/html; charset=utf-8'), true);
  assert.equal(isTextualType('application/json'), true);
  assert.equal(isTextualType('application/ld+json'), true);
  assert.equal(isTextualType('image/png'), false);
  assert.equal(isTextualType('application/pdf'), false);
});

test('formatPage marks a truncated page so the model knows the tail is missing', () => {
  const text = formatPage({
    url: 'https://a.example',
    title: 'Heading',
    text: 'start',
    truncated: true,
  });
  assert.match(text, /# Heading/);
  assert.match(text, /Source: https:\/\/a\.example/);
  assert.match(text, /the rest was cut/);
});

test('formatPage explains an empty page instead of returning nothing', () => {
  const text = formatPage({ url: 'https://a.example', title: null, text: '', truncated: false });
  assert.match(text, /no readable text/);
});
