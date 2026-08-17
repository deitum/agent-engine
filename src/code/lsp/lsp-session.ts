import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CodeEnvVar,
  type CodeLspConfig,
  type CodeLspLanguage,
  type CodeLspState,
  type CodeLspStatus,
} from '../../contracts';

import { dockerLspTransport, LspClient } from './client';
import { formatDiagnosticsBlock } from './diagnostics';
import { type ContainerExec, ensureServerInstalled } from './install';
import { type LspTransport } from './jsonrpc';
import { CONTAINER_WORKSPACE, MAX_DOCUMENT_BYTES, MAX_SERVER_RESTARTS } from './lsp.constants';
import { type LspDiagnostic } from './lsp.types';
import { fromContainerUri, toContainerUri, toHostPath, toRelativePath } from './paths';
import {
  enabledLanguages,
  languageForPath,
  type LspServerSpec,
  type LspServerVariant,
  specFor,
} from './servers';

/**
 * The language servers of one Code session: started lazily, one per language,
 * and tied to the life of the session's container.
 *
 * This is the layer that decides *when* a server is worth paying for. Starting
 * one costs an install on a cold machine and, for jdtls, minutes of project
 * import — so nothing starts until a file of that language is actually touched,
 * and a language whose runtime is missing from the image is written off once with
 * a reason rather than retried on every edit.
 */

/** A prepared document: a live server plus the URI it knows the file by. */
export interface PreparedDocument {
  client: LspClient;
  spec: LspServerSpec;
  language: CodeLspLanguage;
  uri: string;
  /** Checkout-relative path. */
  relative: string;
  /** The content the server was last given. */
  text: string;
  /** The document version the server now holds. */
  version: number;
}

/** What {@link LspSession.beforeEdit} hands to {@link LspSession.afterEdit}. */
export interface EditProbe {
  /** Checkout-relative path. */
  relative: string;
  language: CodeLspLanguage;
  /** The file's content before the edit, used to detect that nothing changed. */
  text: string;
}

/** Per-language state inside a session. */
interface LanguageEntry {
  state: CodeLspState;
  detail?: string;
  client: LspClient | null;
  /** In-flight start, so two concurrent edits do not launch two servers. */
  starting: Promise<LspClient | null> | null;
  restarts: number;
}

export interface LspSessionOptions {
  sessionId: string;
  /** Host directory of the checkout (the bind mount's near side). */
  dir: string;
  containerName: string;
  env?: CodeEnvVar[];
  config: CodeLspConfig;
  /**
   * The language of the detected stack. Warmed by the bootstrap and used to
   * answer a project-wide symbol search when no server happens to be running.
   */
  primaryLanguage?: CodeLspLanguage;
  /** Runs a command inside the container; used for probes and installs. */
  exec: ContainerExec;
  /** Spawns a server process. Injected so tests need no Docker. */
  spawn?: (command: string) => LspTransport;
  onLog?: (message: string) => void;
}

export class LspSession {
  private readonly entries = new Map<CodeLspLanguage, LanguageEntry>();
  /**
   * The errors each file had after the last thing we did to it.
   *
   * Per file rather than per turn: what the agent needs to know is whether *this*
   * edit broke something, and the state right before it is a sharper baseline
   * than the state at the top of the turn — by the third edit of a file the two
   * have nothing to do with each other.
   */
  private readonly baselines = new Map<string, LspDiagnostic[]>();
  private readonly allowed: Set<CodeLspLanguage>;
  private disposed = false;

  constructor(private readonly options: LspSessionOptions) {
    this.allowed = new Set(enabledLanguages(options.config));
  }

  /** True when no language is permitted at all — the whole feature is off. */
  get off(): boolean {
    return this.allowed.size === 0;
  }

  /**
   * Prepares a file for an edit that is about to happen: starts the language
   * server if this is the first file of its language, opens the document, and
   * makes sure a baseline exists to compare against.
   *
   * Returns the pre-edit content, which is what lets {@link afterEdit} tell an
   * edit that landed from one that was refused — a plan-mode refusal and a failed
   * `edit_file` both leave the file untouched, and reporting the file's existing
   * errors at that point would read as though the agent had just caused them.
   *
   * Cheap after the first time: every later edit of the same file reuses the
   * diagnostics {@link afterEdit} already measured. The first one does wait for
   * the server's initial publish, because the alternative — an empty baseline —
   * blames the agent for a breakage that was there before it arrived.
   */
  async beforeEdit(path: string): Promise<EditProbe | null> {
    const prepared = await this.syncDocument(path);
    if (!prepared) {
      return null;
    }
    if (!this.baselines.has(prepared.relative)) {
      const initial = await prepared.client.waitForDiagnostics(
        prepared.uri,
        prepared.version,
        prepared.spec.diagnosticsTimeoutMs,
      );
      this.baselines.set(
        prepared.relative,
        initial ?? prepared.client.diagnosticsFor(prepared.uri),
      );
    }
    return { relative: prepared.relative, language: prepared.language, text: prepared.text };
  }

  /**
   * The block describing what an edit did to a file's errors, or `null` when
   * there is nothing to say — the file did not change, the server is still
   * indexing, or the errors are the ones that were already there.
   */
  async afterEdit(probe: EditProbe): Promise<string | null> {
    const text = await this.readDocument(probe.relative);
    if (text === null || text === probe.text) {
      // Nothing was written: a refusal, a failed match, or an edit that replaced
      // a string with itself. There is no new information to report.
      return null;
    }
    const prepared = await this.syncDocument(probe.relative);
    if (!prepared) {
      return null;
    }
    const before = this.baselines.get(probe.relative) ?? [];
    const after = await prepared.client.waitForDiagnostics(
      prepared.uri,
      prepared.version,
      prepared.spec.diagnosticsTimeoutMs,
    );
    if (after === null) {
      // The server is still indexing, or slower than its budget. Saying nothing
      // is correct: a wrong «all clear» is worse than no answer at all.
      return null;
    }
    this.baselines.set(probe.relative, after);
    return formatDiagnosticsBlock({ language: prepared.language, before, after });
  }

  /**
   * Gets a server ready for a file and makes its view of it current, returning
   * `null` whenever LSP cannot serve this path — no server for the extension, the
   * language turned off, the file too large, the server unavailable.
   */
  async syncDocument(path: string): Promise<PreparedDocument | null> {
    if (this.disposed) {
      return null;
    }
    const relative = toRelativePath(path);
    if (!relative) {
      return null;
    }
    const language = languageForPath(relative);
    if (!language || !this.allowed.has(language)) {
      return null;
    }

    const text = await this.readDocument(relative);
    if (text === null) {
      return null;
    }
    const client = await this.clientFor(language);
    if (!client) {
      return null;
    }

    const spec = specFor(language);
    const uri = toContainerUri(relative);
    const version = client.syncDocument(uri, spec.languageId(relative), text);
    return { client, spec, language, uri, relative, text, version };
  }

  /**
   * A live server for a question that is about the project rather than about one
   * file — `workspace/symbol` is the only such request we make.
   *
   * Prefers a server that is already running, because starting one to answer a
   * symbol search would be a minutes-long detour on a Java project. Falls back to
   * the session's primary language, which is the stack the checkout was detected
   * as, so the first such call in a session still works.
   */
  async anyClient(): Promise<{ client: LspClient; language: CodeLspLanguage } | null> {
    for (const [language, entry] of this.entries) {
      if (entry.client?.alive) {
        return { client: entry.client, language };
      }
    }
    const primary = this.options.primaryLanguage;
    if (!primary || !this.allowed.has(primary)) {
      return null;
    }
    const client = await this.clientFor(primary);
    return client ? { client, language: primary } : null;
  }

  /**
   * Starts a language's server ahead of time. Used by the bootstrap for the
   * detected stack, so jdtls does its project import while the user is still
   * reading the setup log rather than during their first task.
   */
  async warm(language: CodeLspLanguage): Promise<CodeLspStatus> {
    if (this.allowed.has(language)) {
      await this.clientFor(language);
    }
    return this.statusOf(language);
  }

  /** What every touched language is doing, for `/lsp` and the header chip. */
  status(): CodeLspStatus[] {
    return [...this.entries.keys()].map((language) => this.statusOf(language));
  }

  /**
   * Drops a language's server so the next use starts a fresh one — `/lsp restart`,
   * and the way a session recovers from a server that was written off.
   */
  restart(language?: CodeLspLanguage): void {
    for (const [key, entry] of this.entries) {
      if (language && key !== language) {
        continue;
      }
      entry.client?.dispose();
      this.entries.delete(key);
    }
    this.baselines.clear();
  }

  /** Stops every server. Called when the container stops or the session is removed. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.client?.dispose();
    }
    this.entries.clear();
    this.baselines.clear();
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private statusOf(language: CodeLspLanguage): CodeLspStatus {
    const entry = this.entries.get(language);
    if (!entry) {
      return { language, state: this.allowed.has(language) ? 'off' : 'off' };
    }
    // A server that finished indexing since we last looked reports `ready`
    // without anyone having to poll it.
    const state: CodeLspState =
      entry.state === 'indexing' && entry.client?.indexed ? 'ready' : entry.state;
    return {
      language,
      state,
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
  }

  /** The live client for a language, starting or restarting it as needed. */
  private async clientFor(language: CodeLspLanguage): Promise<LspClient | null> {
    const entry = this.entries.get(language) ?? {
      state: 'off' as CodeLspState,
      client: null,
      starting: null,
      restarts: 0,
    };
    this.entries.set(language, entry);

    if (entry.client?.alive) {
      return entry.client;
    }
    if (entry.starting) {
      return entry.starting;
    }
    if (entry.state === 'unavailable') {
      return null;
    }
    if (entry.client && !entry.client.alive) {
      // The server died. One retry covers an unlucky OOM during a build; a
      // server that dies twice is broken, and retrying it forever would turn
      // every edit into a slow no-op.
      if (entry.restarts >= MAX_SERVER_RESTARTS) {
        entry.state = 'unavailable';
        entry.detail = 'the server crashed several times in a row';
        entry.client = null;
        return null;
      }
      entry.restarts += 1;
      entry.client = null;
      this.baselines.clear();
    }

    const starting = this.startServer(language, entry).finally(() => {
      entry.starting = null;
    });
    entry.starting = starting;
    return starting;
  }

  private async startServer(
    language: CodeLspLanguage,
    entry: LanguageEntry,
  ): Promise<LspClient | null> {
    const spec = specFor(language);

    entry.state = 'installing';
    const outcome = await ensureServerInstalled(language, this.options.config, this.options.exec);
    if (!outcome.variant) {
      entry.state = 'unavailable';
      entry.detail = outcome.reason ?? 'the server is unavailable';
      this.options.onLog?.(`lsp ${language}: ${entry.detail}`);
      return null;
    }

    entry.state = 'starting';
    const context = {
      sessionId: this.options.sessionId,
      ...this.typescriptOverride(language),
    };
    const client = new LspClient({
      spawn: () => this.spawnServer(outcome.variant as LspServerVariant, context),
      rootUri: `file://${CONTAINER_WORKSPACE}`,
      initializeTimeoutMs: spec.initializeTimeoutMs,
      requestTimeoutMs: spec.requestTimeoutMs,
      ...(outcome.variant.initializationOptions
        ? { initializationOptions: outcome.variant.initializationOptions(context) }
        : {}),
      ...(outcome.variant.readySignal ? { readySignal: outcome.variant.readySignal } : {}),
      ...(this.options.onLog ? { onLog: this.options.onLog } : {}),
    });

    try {
      await client.start();
    } catch (error) {
      entry.state = 'unavailable';
      entry.detail = `the server did not start: ${error instanceof Error ? error.message : String(error)}`;
      this.options.onLog?.(`lsp ${language}: ${entry.detail}`);
      client.dispose();
      return null;
    }

    entry.client = client;
    entry.detail = undefined;
    if (client.indexed) {
      entry.state = 'ready';
    } else {
      entry.state = 'indexing';
      // Watched, not awaited: the caller gets a usable (if partial) server now,
      // and the state flips to `ready` on its own once the import finishes.
      void client.whenReady(spec.indexTimeoutMs).then((ready) => {
        if (entry.client === client) {
          entry.state = ready ? 'ready' : 'indexing';
        }
      });
    }
    return client;
  }

  private spawnServer(
    variant: LspServerVariant,
    context: { sessionId: string; projectTypescriptPath?: string },
  ): LspTransport {
    const command = variant.launch(context);
    return this.options.spawn
      ? this.options.spawn(command)
      : dockerLspTransport(this.options.containerName, command, this.options.env);
  }

  /**
   * Points tsserver at the checkout's own TypeScript when it has one. Diagnostics
   * have to match the compiler the project builds with, or the agent spends its
   * turn chasing errors its own build would never report.
   */
  private typescriptOverride(language: CodeLspLanguage): { projectTypescriptPath?: string } {
    if (language !== 'typescript') {
      return {};
    }
    const relative = join('node_modules', 'typescript', 'lib');
    return existsSync(join(this.options.dir, relative))
      ? { projectTypescriptPath: `${CONTAINER_WORKSPACE}/node_modules/typescript/lib` }
      : {};
  }

  /**
   * Reads a file from the host side of the bind mount, refusing one too big to be
   * worth analysing. Returns `null` for anything unreadable — a deleted file, a
   * directory, a generated bundle.
   */
  private async readDocument(relative: string): Promise<string | null> {
    const path = toHostPath(this.options.dir, relative);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) {
        return null;
      }
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }
}

/** Re-exported for the tools, which map a server's answers back to project paths. */
export { fromContainerUri };
