import {
  type LspPosition,
  type LspTextDocumentEdit,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from './lsp.types';

/**
 * Applying the `WorkspaceEdit` a `textDocument/rename` comes back with.
 *
 * The edits are ranges, and the agent's file tools speak in strings, so the
 * translation happens here: ranges are turned into new file content, which is
 * then written **through the backend** — never straight to disk. That is what
 * keeps plan mode's read-only guard in force for a rename, and what keeps a
 * rename on the same host-side path as every other edit the session makes.
 */

/** Offsets of the start of each line, for turning positions into indices. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * The string index of a protocol position.
 *
 * `character` counts UTF-16 code units, which is exactly what JavaScript string
 * indexing uses — so no conversion is needed, and a file with emoji or Cyrillic
 * lands in the right place. Positions past the end of their line are clamped,
 * because a server that computed them against a slightly different revision
 * should not corrupt the file.
 */
export function offsetAt(text: string, starts: number[], position: LspPosition): number {
  if (position.line < 0) {
    return 0;
  }
  if (position.line >= starts.length) {
    return text.length;
  }
  const start = starts[position.line];
  const end = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length;
  return Math.min(start + Math.max(0, position.character), end);
}

/**
 * Applies edits to a document, back to front.
 *
 * Order is the whole trick: applying from the end means every offset still
 * describes the text it was computed against. The protocol forbids overlapping
 * edits within one document, so sorting by start position is enough.
 */
export function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const starts = lineStarts(text);
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(text, starts, edit.range.start),
      end: offsetAt(text, starts, edit.range.end),
      newText: edit.newText,
    }))
    .sort((left, right) => right.start - left.start || right.end - left.end);

  let result = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    // Defensive: a server that returned overlapping ranges would otherwise
    // produce silently mangled source.
    if (edit.end > previousStart) {
      continue;
    }
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}

/** What a workspace edit asked for, grouped by document. */
export interface CollectedEdits {
  /** URI → the edits for that document. */
  byUri: Map<string, LspTextEdit[]>;
  total: number;
}

/**
 * Flattens a `WorkspaceEdit` into per-document edits, or explains why it cannot
 * be applied.
 *
 * Servers use either `changes` (a map) or `documentChanges` (an ordered list) —
 * tsserver prefers the first, jdtls the second — so both have to be read.
 *
 * A `documentChanges` list may also contain **file operations**: renaming a
 * public Java class means renaming its file too. Those are refused rather than
 * skipped. Applying half of such an edit would leave a tree that does not
 * compile, and telling the agent it must move the file itself is both true and
 * actionable.
 */
export function collectWorkspaceEdit(
  edit: LspWorkspaceEdit | null | undefined,
): CollectedEdits | { error: string } {
  const byUri = new Map<string, LspTextEdit[]>();
  let total = 0;

  const add = (uri: string, edits: readonly LspTextEdit[]): void => {
    const usable = edits.filter(
      (entry) => entry && entry.range && typeof entry.newText === 'string',
    );
    if (usable.length === 0) {
      return;
    }
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...usable]);
    total += usable.length;
  };

  if (edit?.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (Array.isArray(edits)) {
        add(uri, edits);
      }
    }
  }

  for (const change of edit?.documentChanges ?? []) {
    if (!change || typeof change !== 'object') {
      continue;
    }
    const operation = (change as { kind?: unknown }).kind;
    if (typeof operation === 'string') {
      return {
        error: `This rename also needs file operations (${operation}) — renaming the class's own file, for instance. Do it by hand: /revert will not help, and a half-applied edit breaks the build.`,
      };
    }
    const documentEdit = change as LspTextDocumentEdit;
    if (documentEdit.textDocument?.uri && Array.isArray(documentEdit.edits)) {
      add(documentEdit.textDocument.uri, documentEdit.edits);
    }
  }

  return { byUri, total };
}
