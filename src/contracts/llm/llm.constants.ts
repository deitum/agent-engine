/**
 * A tool call's `arguments` as an object, repairing what can be repaired.
 * `null` when there is nothing usable in it.
 *
 * The protocol carries tool arguments as a **model-generated string**, and
 * OpenAI's own docs warn it is not guaranteed to be valid JSON. It reaches us
 * through the streaming accumulator, which concatenates whatever fragments the
 * provider sends — and a gateway that re-parses the string on the way to the
 * model answers a broken one with a flat `500` naming nothing. That is not
 * hypothetical: a zero-argument tool comes back called with `{}""`, which then
 * travels upstream in every later request of that chat.
 *
 * So a string that merely has something *after* a complete object is repaired
 * rather than thrown away: the arguments are all there, and dropping the call
 * costs the turn its work. A truncated one (`{"path":`) is genuinely unusable
 * and returns `null` — the caller decides whether that means «no arguments» or
 * «drop this call».
 */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  // A zero-argument tool: providers spell this as `''`, `'{}'`, or nothing at
  // all. Every spelling means the same thing, and `''` is not valid JSON.
  if (text === '') {
    return {};
  }

  const direct = asArgumentObject(text);
  if (direct) {
    return direct;
  }

  const prefix = balancedObjectPrefix(text);
  return prefix === null ? null : asArgumentObject(prefix);
}

/**
 * The same, back as the JSON string the protocol carries — `'{}'` when nothing
 * could be recovered. Use this wherever a tool call is stored or forwarded.
 */
export function normalizeToolArguments(raw: string): string {
  return JSON.stringify(parseToolArguments(raw) ?? {});
}

/** Parses `text`, keeping only a plain JSON object (not an array, not a scalar). */
function asArgumentObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The first balanced `{…}` of `text`, or `null` when it holds no complete
 * object. Braces inside strings are not braces, which is why this counts
 * characters instead of reaching for a regex.
 */
function balancedObjectPrefix(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}
