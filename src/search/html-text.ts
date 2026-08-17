/** Elements whose content is markup or styling, never text worth reading. */
const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas'];

/** Elements that end a line of text when they close. */
const BLOCK_ELEMENTS = [
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'li',
  'tr',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'form',
  'table',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

/** The handful of named entities that actually turn up in prose. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  middot: '·',
};

/** Resolves `&amp;`, `&#1055;` and `&#x41f;` in a run of text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Turns a page into the plain text the model reads.
 *
 * Deliberately a stripper rather than a parser: a real DOM (jsdom + Readability)
 * would be a heavyweight dependency in a daemon the user installs with `npx`,
 * and what the model needs from a page is its prose, not its structure. Block
 * elements become line breaks so lists and headings stay readable, and
 * everything else collapses to whitespace.
 */
export function htmlToText(html: string): string {
  let text = html;

  // Comments first: they can contain anything, including tags that would
  // otherwise be matched below.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const element of DROPPED_ELEMENTS) {
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}\\s*>`, 'gi'), ' ');
    // An unclosed <script> at the end of a truncated download would otherwise
    // leak its source into the text.
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n\n');
  for (const element of BLOCK_ELEMENTS) {
    text = text.replace(new RegExp(`</${element}\\s*>`, 'gi'), '\n');
    text = text.replace(new RegExp(`<${element}\\b[^>]*>`, 'gi'), '\n');
  }
  // Whatever tags are left carry no line structure.
  text = text.replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text);

  return (
    text
      .replace(/\r\n?/g, '\n')
      // Spaces and tabs only: newlines are the structure we just recovered.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** The page's `<title>`, when it has a usable one. */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
  return title || null;
}
