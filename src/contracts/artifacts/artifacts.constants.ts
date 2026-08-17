/**
 * Name of the built-in artifact tool. Both execution paths expose it under this
 * name: the browser's client-side tool loop (a normal chat) and the deep agent
 * inside the local connector (a project chat).
 */
export const WRITE_ARTIFACT_TOOL = 'write_artifact';

/**
 * Model-facing description of {@link WRITE_ARTIFACT_TOOL} — the only place the
 * artifact conventions are explained to the model, so it is shared by both
 * paths rather than duplicated per app.
 *
 * Every rule here is one the model gets wrong without it, and nothing else is:
 * a tool description travels in **every** request of every turn, including the
 * ones that will never write an artifact, so its length is paid by «hello» too.
 */
export const WRITE_ARTIFACT_DESCRIPTION = [
  'Save a substantial, self-contained result as an artifact: a card in the chat, opened in a side',
  'panel where it is rendered, versioned and downloadable.',
  'Use it for a document or report (markdown), a script or module (code), a standalone page (html)',
  'or a UI component (react) — never for short answers or small snippets, which belong in the reply.',
  'Never repeat the content in your reply; just say what you saved.',
  'To revise one, call again with the SAME key and the FULL new content — that becomes its next',
  'version; a fresh key means a genuinely different artifact.',
  'For "react": one module with a default-exported component. For "react" and "html": React is the',
  'only package in the preview and there is no CSS framework, so import nothing else and style with',
  'inline styles or a <style> tag.',
].join(' ');

/**
 * JSON Schema for {@link WRITE_ARTIFACT_TOOL} arguments, mirroring
 * `ArtifactPayload`. Shared by the connector's LangChain tool and the browser's
 * OpenAI tool definition so the model sees one contract.
 */
export const WRITE_ARTIFACT_SCHEMA = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description:
        'Stable slug identifying this artifact within the chat (e.g. "release-notes"). Reuse it to publish a new version of the same artifact.',
    },
    title: {
      type: 'string',
      description: 'Short human title shown on the card and in the panel header.',
    },
    kind: {
      type: 'string',
      enum: ['markdown', 'code', 'html', 'react'],
      description:
        'markdown = document, code = source file, html = standalone page, react = single component module with a default export.',
    },
    language: {
      type: 'string',
      description: 'Source language for kind "code" (e.g. "ts", "python", "sql").',
    },
    content: {
      type: 'string',
      description: 'The complete artifact body. Always send the whole thing, never a diff.',
    },
  },
  required: ['key', 'title', 'kind', 'content'],
} as const;
