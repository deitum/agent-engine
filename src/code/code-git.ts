import { resolveRepoCredentials } from '../config/engine-config';
import { ConnectorError } from '../connector';
import { CODE_GIT_TOOLS, type CodeCredentials, type CodeRepoRef, repoProvider } from '../contracts';
import { type loadDeps } from '../deep-agent';
import { createRepoClient } from '../vcs/vcs';

import { type CodeWorkspaces } from './code-workspace';
import { commandSegments } from './plan-mode';

/**
 * The git operations that need the user's repository credentials, and the tools
 * that offer them to the coding agent.
 *
 * They live on the host rather than in the sandbox because the credentials do.
 * The checkout is cloned without a token in its `origin` (see `vcs.ts`), and the
 * container is handed neither the token nor a credential helper — a `git push`
 * typed into the agent's shell therefore fails with «could not read Username for
 * …», which is the sandbox working as designed and not a broken checkout. The
 * work-around used to be «ask the user to run /push», which is a poor answer to
 * «push it and open a pull request».
 *
 * So the same three operations the slash commands perform are exposed as tools,
 * and {@link networkGitRefusal} intercepts the shell command the model reaches
 * for first, naming the tool that does work.
 */

/** git sub-commands that cannot do their job without reaching the remote. */
const NETWORK_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'push',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
]);

/** What the tools need to reach the session they belong to. */
export interface GitToolContext {
  workspaces: CodeWorkspaces;
  sessionId: string;
}

/**
 * The credentials configured for a repository's host, refused when there are
 * none.
 *
 * Only the token is required. A username is Bitbucket Server's demand, not
 * git's, and insisting on one here would refuse a perfectly good GitHub PAT
 * before it was ever tried.
 */
export function requireCredentials(repo: CodeRepoRef): CodeCredentials {
  const credentials = resolveRepoCredentials(repoProvider(repo), repo.baseUrl);
  if (!credentials.token) {
    throw new ConnectorError(400, 'This operation needs repository credentials.');
  }
  return credentials;
}

/** Pushes the session's current branch to `origin`. Returns the branch. */
export async function pushSessionBranch(
  workspaces: CodeWorkspaces,
  sessionId: string,
  repo: CodeRepoRef,
): Promise<string> {
  return workspaces.push(sessionId, requireCredentials(repo));
}

/** Updates the session's remote-tracking refs from `origin`. Returns git's report. */
export async function fetchSession(
  workspaces: CodeWorkspaces,
  sessionId: string,
  repo: CodeRepoRef,
  branch?: string,
): Promise<string> {
  return workspaces.fetch(sessionId, requireCredentials(repo), branch);
}

/** What opening a pull request produced, for whoever has to word the answer. */
export interface PullRequestOutcome {
  branch: string;
  baseBranch: string;
  url: string;
  /** True when a pull request for this branch was already open — the usual second `/pr`. */
  existed: boolean;
}

/**
 * Pushes the session's branch and opens a pull request against its base.
 *
 * The push is part of it on purpose: a pull request for a branch the host has
 * never seen is refused by both hosts, and «the branch is not on the remote» is
 * exactly the dead end the agent reached when it had a Bitbucket tool but no way
 * to push.
 */
export async function openSessionPullRequest(
  workspaces: CodeWorkspaces,
  sessionId: string,
  repo: CodeRepoRef,
  title: string,
): Promise<PullRequestOutcome> {
  const credentials = requireCredentials(repo);
  const branch = await workspaces.push(sessionId, credentials);
  const baseBranch = await workspaces.baseBranch(sessionId);
  if (branch === baseBranch) {
    throw new ConnectorError(
      400,
      `Cannot open a pull request: the current branch is the base branch («${baseBranch}»). Create a work branch with /branch.`,
    );
  }
  const pr = await createRepoClient(repo, credentials).openPullRequest(
    branch,
    baseBranch,
    title || branch,
  );
  return { branch, baseBranch, url: pr.url, existed: pr.existed };
}

/**
 * The git sub-command in `command` that would have to reach the remote, or
 * `null` when the line touches only the local repository.
 *
 * The whole line is scanned, because the model writes `git add -A && git commit
 * -m … && git push`: the first two segments are perfectly runnable in the
 * container and it is the third that cannot work there.
 */
export function networkGitSubcommand(command: string): string | null {
  for (const tokens of commandSegments(command)) {
    const [head, ...args] = tokens;
    if (head !== 'git') {
      continue;
    }
    // Skip the global flags that may precede the sub-command (`-C dir`, `-c k=v`).
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) {
      index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
    }
    const subcommand = args[index];
    if (subcommand && NETWORK_GIT_SUBCOMMANDS.has(subcommand)) {
      return subcommand;
    }
  }
  return null;
}

/**
 * Who is reading a refusal. The two have different ways out: the model calls a
 * tool, the person types a command — and a message naming the other one's is a
 * dead end for them.
 */
export type GitAudience = 'agent' | 'user';

/** What does the blocked sub-command's job instead, per reader. */
const NETWORK_GIT_ALTERNATIVE: Record<GitAudience, Record<string, string>> = {
  agent: {
    push: `Use \`${CODE_GIT_TOOLS.push}\` instead — or \`${CODE_GIT_TOOLS.pullRequest}\`, which pushes and opens the pull request in one step.`,
    fetch: `Use \`${CODE_GIT_TOOLS.fetch}\` instead, then merge or rebase locally.`,
    pull: `Use \`${CODE_GIT_TOOLS.fetch}\` instead, then merge or rebase locally.`,
  },
  user: {
    push: 'Push with the /push command — or /pr, which pushes and opens the pull request in one step.',
    fetch:
      'Ask the agent for it: its `git_fetch` tool runs on the host, where the credentials are.',
    pull: 'Ask the agent for it: its `git_fetch` tool runs on the host, where the credentials are.',
  },
};

/**
 * The refusal returned instead of running a git command that would talk to the
 * remote from inside the container, or `null` for a command that is fine there.
 *
 * Refused rather than let through because the error git gives on its own is
 * «could not read Username for 'https://…'» — or, against a corporate host whose
 * CA a stock image does not carry, a certificate failure. Both read as a broken
 * sandbox, and the agent's next move is to repair it: write a `.netrc`, add a
 * credential helper, put a token it does not have into the remote URL. Naming
 * what does work is one step instead of a lost turn.
 */
export function networkGitRefusal(command: string, audience: GitAudience = 'agent'): string | null {
  const subcommand = networkGitSubcommand(command);
  if (!subcommand) {
    return null;
  }
  const alternative = NETWORK_GIT_ALTERNATIVE[audience][subcommand];
  return [
    `Refused: \`git ${subcommand}\` has to reach the repository host, and this sandbox holds no credentials for it — by design, so a token never lands in the container.`,
    alternative ??
      'The repository is already cloned at `/workspace`; work in this checkout rather than reaching for another one.',
    ...(audience === 'agent'
      ? [
          'This is not a broken checkout — do not write a `.netrc`, add a credential helper or put a token into the remote URL.',
        ]
      : []),
  ].join('\n');
}

/** JSON Schema of the {@link CODE_GIT_TOOLS.push} arguments. */
const PUSH_SCHEMA = { type: 'object', properties: {} } as const;

/** JSON Schema of the {@link CODE_GIT_TOOLS.fetch} arguments. */
const FETCH_SCHEMA = {
  type: 'object',
  properties: {
    branch: {
      type: 'string',
      description:
        'Branch to fetch, e.g. the base branch. Omit to fetch every branch the remote offers.',
    },
  },
} as const;

/** JSON Schema of the {@link CODE_GIT_TOOLS.pullRequest} arguments. */
const PULL_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'Title of the pull request, written for the person who will review it. Defaults to the branch name.',
    },
  },
} as const;

/**
 * The remote git the coding agent may perform: push the branch, update the
 * remote refs, open the pull request.
 *
 * Not registered in plan mode — all three change something outside the
 * workspace, which is precisely what that mode exists to prevent.
 */
export function buildGitTools(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  context: GitToolContext,
): unknown[] {
  const { workspaces, sessionId } = context;

  const push = tool(
    async (): Promise<string> =>
      report(async () => {
        const repo = await workspaces.repo(sessionId);
        const branch = await pushSessionBranch(workspaces, sessionId, repo);
        return `Branch «${branch}» was pushed to origin.`;
      }),
    {
      name: CODE_GIT_TOOLS.push,
      description:
        'Push the session branch to origin, with the user’s credentials (the sandbox has none, so `git push` in the shell cannot work). Commit first — only what is committed is pushed.',
      schema: PUSH_SCHEMA,
    },
  );

  const fetch = tool(
    async (args: Record<string, unknown>): Promise<string> =>
      report(async () => {
        const branch = typeof args.branch === 'string' ? args.branch.trim() : '';
        const repo = await workspaces.repo(sessionId);
        const output = await fetchSession(workspaces, sessionId, repo, branch || undefined);
        // What arrived is not in this output — git reports a fetch on stderr —
        // so the answer says what was done and leaves reading the result to the
        // ordinary local commands (`git log origin/<branch>`, `git status`).
        const what = branch ? `«${branch}»` : 'every branch';
        return output
          ? `Fetched ${what} from origin:\n${output}`
          : `Fetched ${what} from origin. The remote-tracking refs (\`origin/…\`) are up to date; merge or rebase onto them with an ordinary git command.`;
      }),
    {
      name: CODE_GIT_TOOLS.fetch,
      description:
        'Update the remote-tracking refs from origin, with the user’s credentials (the sandbox has none, so `git fetch` in the shell cannot work). Merging or rebasing onto what arrived is an ordinary local git command afterwards.',
      schema: FETCH_SCHEMA,
    },
  );

  const pullRequest = tool(
    async (args: Record<string, unknown>): Promise<string> =>
      report(async () => {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const repo = await workspaces.repo(sessionId);
        const pr = await openSessionPullRequest(workspaces, sessionId, repo, title);
        return pr.existed
          ? // A host that reports the duplicate without naming it leaves no URL
            // to hand back; the branch is pushed either way, which is the part
            // the model has to know.
            `Branch «${pr.branch}» was pushed. A pull request for it is already open${pr.url ? `: ${pr.url}` : ''}.`
          : `Branch «${pr.branch}» was pushed and a pull request against «${pr.baseBranch}» was opened: ${pr.url}`;
      }),
    {
      name: CODE_GIT_TOOLS.pullRequest,
      description:
        'Push the session branch and open a pull request against the base branch, with the user’s credentials. Returns the pull request’s URL; a second call on the same branch reports the one that is already open instead of failing.',
      schema: PULL_REQUEST_SCHEMA,
    },
  );

  return [push, fetch, pullRequest];
}

/**
 * Runs one operation and hands a failure back as the tool's result.
 *
 * The same rule the MCP bridge and the delegation tools follow: a push rejected
 * by the host, or credentials the user never configured, is something the model
 * can read and act on — committing first, asking the user — whereas a thrown
 * error ends the turn over it.
 */
async function report(operation: () => Promise<string>): Promise<string> {
  try {
    return await operation();
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : 'the git operation failed'}`;
  }
}
