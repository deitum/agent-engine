import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeEntities, htmlTitle, htmlToText } from './html-text';

test('htmlToText drops scripts, styles and their contents', () => {
  const html = `
    <html><head><style>.a { color: red }</style></head>
    <body><script>var leak = "secret";</script><p>Visible text</p></body></html>`;
  const text = htmlToText(html);
  assert.equal(text, 'Visible text');
});

test('htmlToText drops an unclosed script left by a truncated download', () => {
  const text = htmlToText('<p>Start</p><script>var x = 1; // cut off');
  assert.equal(text, 'Start');
});

test('htmlToText keeps block structure as line breaks', () => {
  const html = '<h1>Heading</h1><ul><li>One</li><li>Two</li></ul><p>Paragraph</p>';
  assert.equal(htmlToText(html), 'Heading\n\nOne\n\nTwo\n\nParagraph');
});

test('htmlToText collapses runs of whitespace and never stacks blank lines', () => {
  const html = '<p>First</p>\n\n\n<p>Second    paragraph</p>';
  assert.equal(htmlToText(html), 'First\n\nSecond paragraph');
});

test('htmlToText strips comments, including ones holding markup', () => {
  assert.equal(htmlToText('<p>Before</p><!-- <p>Hidden</p> --><p>After</p>'), 'Before\n\nAfter');
});

test('htmlToText turns <br> into a line break inside a paragraph', () => {
  assert.equal(htmlToText('<p>Line<br>Another line</p>'), 'Line\nAnother line');
});

test('decodeEntities resolves named, decimal and hex references', () => {
  assert.equal(decodeEntities('&laquo;a &amp; b&raquo;'), '«a & b»');
  assert.equal(decodeEntities('&#233;&#224;&#231;'), 'éàç');
  assert.equal(decodeEntities('&#xE9;&#xE0;'), 'éà');
});

test('decodeEntities leaves an unknown entity alone', () => {
  assert.equal(decodeEntities('a &notarealentity; b'), 'a &notarealentity; b');
});

test('htmlTitle reads the page title and decodes it', () => {
  assert.equal(
    htmlTitle('<html><head><title>SearXNG &mdash; search</title></head>'),
    'SearXNG — search',
  );
  assert.equal(htmlTitle('<html><head></head><body>x</body></html>'), null);
});
