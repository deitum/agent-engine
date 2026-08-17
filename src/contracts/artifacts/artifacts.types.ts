/**
 * What kind of thing an artifact is — decides how the web client renders it:
 * `markdown` as a document, `code` as a highlighted listing, `html` and `react`
 * with a live preview inside a sandboxed iframe.
 */
export type ArtifactKind = 'markdown' | 'code' | 'html' | 'react';

/**
 * One artifact write, as produced by the built-in `write_artifact` tool. The
 * same shape is used on both execution paths: the browser's client-side tool
 * loop (a normal chat) and the local connector's deep agent (a project chat,
 * where it arrives as an `artifact` stream event).
 */
export interface ArtifactPayload {
  /**
   * Stable slug identifying the artifact within its chat. Writing the same
   * `key` again updates the artifact — the new content becomes its next
   * version rather than a separate entry.
   */
  key: string;
  /** Human title shown on the card, in the panel header and in the catalogue. */
  title: string;
  kind: ArtifactKind;
  /** Source language for `kind: 'code'` (e.g. `ts`, `python`, `sql`). */
  language?: string;
  /** The artifact body: markdown text, source code, an HTML page, or a React module. */
  content: string;
}
