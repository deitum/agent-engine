import { ConnectorError } from '../connector';
import { type CodeCommandRequest, type CodeCommandResult, type CodeLspState } from '../contracts';

import { networkGitRefusal, openSessionPullRequest, pushSessionBranch } from './code-git';
import { type CodeWorkspaces } from './code-workspace';

/** Output longer than this is cut before it reaches the transcript. */
const MAX_OUTPUT_CHARS = 20_000;

/** How each language-server state reads in the `/lsp` report. */
const LSP_STATE_LABELS: Record<CodeLspState, string> = {
  off: 'not started',
  installing: 'installing',
  starting: 'starting',
  indexing: 'indexing the project',
  ready: 'ready',
  unavailable: 'unavailable',
};

/**
 * `/lsp` — what the session's language servers are doing, and the two levers
 * over them.
 *
 * `restart` exists because the one failure a user can fix themselves is a server
 * that was written off early: it started before the dependency install finished,
 * or it crashed once on a machine that was briefly out of memory. Without a way
 * back, the only remedy would be recreating the session.
 */
async function runLspCommand(
  workspaces: CodeWorkspaces,
  sessionId: string,
  arg: string,
): Promise<string> {
  const action = arg.trim().toLowerCase();

  if (action === 'off') {
    workspaces.stopLsp(sessionId);
    return 'The language servers were stopped. They come back on the next edit — to turn them off for good, clear the checkbox in the session settings.';
  }

  if (action === 'restart') {
    workspaces.stopLsp(sessionId);
    return 'The language servers are restarting — the first request to them brings them back up.';
  }

  if (action && action !== 'status') {
    throw new ConnectorError(400, `Unknown argument: /lsp ${arg}. Available: restart, off.`);
  }

  const statuses = workspaces.lspStatus(sessionId);
  if (statuses.length === 0) {
    return 'The language servers have not started yet. They come up on their own with the first edit to a Java, TypeScript or Python file.';
  }
  const lines = statuses.map((entry) => {
    const label = LSP_STATE_LABELS[entry.state];
    return `- ${entry.language}: ${label}${entry.detail ? ` — ${entry.detail}` : ''}`;
  });
  return `Code analysis (LSP):\n${lines.join('\n')}`;
}

/** Trims command output to something a chat transcript can hold. */
function capOutput(output: string): { text: string; truncated: boolean } {
  const text = output.trimEnd();
  return text.length > MAX_OUTPUT_CHARS
    ? { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…`, truncated: true }
    : { text, truncated: false };
}

/** The shape a single command handler returns before the state is re-read. */
interface CommandOutcome {
  ok: boolean;
  output: string;
  truncated?: boolean;
  exitCode?: number | null;
  prUrl?: string;
}

/**
 * Runs one deterministic operation on a prepared session workspace — no coding
 * agent, no LLM. Finishes by re-reading the workspace `status` + `diff` so the
 * Code UI's panels refresh. Network operations (`push`, `pr`) pass the
 * configured credentials to that single git invocation, because the checkout's
 * `origin` deliberately holds no token.
 */
export async function runCodeCommand(
  workspaces: CodeWorkspaces,
  req: CodeCommandRequest,
  signal?: AbortSignal,
): Promise<CodeCommandResult> {
  await workspaces.setEnv(req.sessionId, req.env);
  const outcome = await runOne(workspaces, req, signal);

  return {
    ok: outcome.ok,
    output: outcome.output,
    ...(outcome.truncated ? { truncated: true } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    status: await workspaces.status(req.sessionId),
    diff: await workspaces.diff(req.sessionId),
    ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
  };
}

async function runOne(
  workspaces: CodeWorkspaces,
  req: CodeCommandRequest,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const arg = req.arg?.trim() ?? '';

  switch (req.command) {
    case 'branch': {
      const branch = await workspaces.createBranch(req.sessionId, arg);
      return { ok: true, output: `Created branch «${branch}» and switched to it.` };
    }

    case 'checkout': {
      const branch = await workspaces.checkout(req.sessionId, arg);
      return { ok: true, output: `Switched to branch «${branch}».` };
    }

    case 'commit': {
      return { ok: true, output: await workspaces.commit(req.sessionId, arg) };
    }

    case 'push': {
      const repo = req.repo ?? (await workspaces.repo(req.sessionId));
      const branch = await pushSessionBranch(workspaces, req.sessionId, repo);
      return { ok: true, output: `Branch «${branch}» was pushed to origin.` };
    }

    case 'pr': {
      const repo = req.repo ?? (await workspaces.repo(req.sessionId));
      const pr = await openSessionPullRequest(workspaces, req.sessionId, repo, arg);
      if (pr.existed) {
        return {
          ok: true,
          output: `Branch «${pr.branch}» was pushed. A pull request for it is already open.`,
          ...(pr.url ? { prUrl: pr.url } : {}),
        };
      }
      return {
        ok: true,
        output: `Branch «${pr.branch}» was pushed and a pull request against «${pr.baseBranch}» was opened.`,
        prUrl: pr.url,
      };
    }

    case 'revert': {
      return { ok: true, output: await workspaces.revert(req.sessionId, arg) };
    }

    case 'exec': {
      if (!arg) {
        throw new ConnectorError(400, 'Name a command: /run <command>');
      }
      // The same wall the agent's shell hits, worded for the person who typed
      // it: git that reaches the repository host cannot run in the sandbox, and
      // `/push` is what does.
      const remote = networkGitRefusal(arg, 'user');
      if (remote) {
        return { ok: false, output: remote, exitCode: 1 };
      }
      return shellOutcome(await workspaces.exec(req.sessionId, arg, { signal }), arg);
    }

    case 'test':
    case 'build': {
      const commands = await workspaces.commands(req.sessionId);
      const command = arg || (req.command === 'test' ? commands.test : commands.build);
      if (!command) {
        throw new ConnectorError(
          400,
          req.command === 'test'
            ? 'Could not work out the test command for this stack — run it with /run <command>.'
            : 'Could not work out the build command for this stack — run it with /run <command>.',
        );
      }
      return shellOutcome(await workspaces.exec(req.sessionId, command, { signal }), command);
    }

    case 'lsp': {
      return { ok: true, output: await runLspCommand(workspaces, req.sessionId, arg) };
    }

    default:
      throw new ConnectorError(400, `Unknown command: ${String(req.command)}`);
  }
}

/** Renders a shell result as a transcript-ready outcome. */
function shellOutcome(
  result: { output: string; exitCode: number | null; truncated: boolean },
  command: string,
): CommandOutcome {
  const capped = capOutput(result.output);
  const status =
    result.exitCode === 0
      ? '✅ succeeded'
      : result.exitCode === null
        ? '⏹ interrupted'
        : `❌ exit code ${result.exitCode}`;
  return {
    ok: result.exitCode === 0,
    output: `\`${command}\` — ${status}\n\n\`\`\`\n${capped.text || '(no output)'}\n\`\`\``,
    truncated: capped.truncated || result.truncated,
    exitCode: result.exitCode,
  };
}
