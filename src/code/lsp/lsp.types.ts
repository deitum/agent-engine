/**
 * The slice of the Language Server Protocol this connector actually speaks.
 *
 * Hand-written rather than pulled from `vscode-languageserver-protocol`: we use
 * a dozen of its several hundred interfaces, the package drags in a runtime we
 * would never call, and the connector is npx-installed on the user's machine —
 * every dependency is weight someone downloads. The shapes below are the wire
 * format, so they are structural by nature and cannot drift silently: a server
 * that stops matching them fails at the one call site that reads the field.
 *
 * Positions are **zero-based** on the wire (line 0 is the first line). Everything
 * shown to the model is converted to one-based at the edge — see `formatLocation`
 * in `lsp-format.ts` — because a model reading «L0» will confidently edit the
 * wrong line.
 */

/** A zero-based point in a document. `character` is a UTF-16 code-unit offset. */
export interface LspPosition {
  line: number;
  character: number;
}

/** A half-open span; `end` is exclusive. */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A span in a named document. */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/**
 * The richer answer `textDocument/definition` may return instead of a
 * {@link LspLocation}. `targetSelectionRange` is the identifier itself, whereas
 * `targetRange` covers the whole declaration including its doc comment — we
 * report the former, which is what a reader wants to jump to.
 */
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

/** Severity levels, in the protocol's numbering. */
export const LSP_SEVERITY = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
} as const;

export type LspSeverity = (typeof LSP_SEVERITY)[keyof typeof LSP_SEVERITY];

/** One problem a server reports about a document. */
export interface LspDiagnostic {
  range: LspRange;
  /** Absent means «undefined severity»; servers in practice always send it. */
  severity?: LspSeverity;
  /** Rule / compiler code, e.g. `2339` (TS) or `reportUndefinedVariable`. */
  code?: string | number;
  /** Which analyser produced it, e.g. `ts`, `Java`, `basedpyright`. */
  source?: string;
  message: string;
}

/**
 * The push notification diagnostics arrive on. `version` is optional in the
 * protocol and not every server sends it, which is why
 * `LspClient.waitForDiagnostics` cannot simply match on it — see the note there.
 */
export interface LspPublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

/** Symbol kinds, in the protocol's numbering; only the ones we label. */
export const LSP_SYMBOL_KIND: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type parameter',
};

/**
 * The tree form of `textDocument/documentSymbol`. `range` covers the whole
 * declaration, `selectionRange` just the name — the latter is the position to
 * hand to `definition` / `references` / `rename`.
 */
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/**
 * The flat form, returned by `workspace/symbol` and by servers that predate
 * {@link LspDocumentSymbol}. Both shapes come back from the same request, so
 * every reader has to handle the pair.
 */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

/** Markdown or plain text, the modern form of a hover / doc string. */
export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

/**
 * `textDocument/hover`. `contents` has three historical shapes — a string, a
 * `{language, value}` pair, an array of either, or {@link LspMarkupContent} —
 * and servers in the wild still use all of them.
 */
export interface LspHover {
  contents: unknown;
  range?: LspRange;
}

/** One replacement inside a document. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** Edits to one document, with the version they were computed against. */
export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}

/**
 * The answer to `textDocument/rename`. Servers use either `changes` (a map from
 * URI to edits) or `documentChanges` (an ordered list that may also create /
 * rename / delete files) — jdtls prefers the latter, tsserver the former, so
 * both have to be read.
 */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (LspTextDocumentEdit | { kind: string })[];
}
