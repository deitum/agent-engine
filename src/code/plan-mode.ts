import { randomUUID } from 'node:crypto';

import { CODE_PLAN_APPROVE, EXIT_PLAN_MODE_TOOL } from '../contracts';
import { type loadDeps, type PendingAnswers } from '../deep-agent';

// Type-only on purpose: `code-agent` imports the guard and the tool below, so a
// value import here would close a runtime cycle. `import type` cannot.
import type { CodeEventSink } from './code-agent';

/**
 * The read-only guard of one plan-mode turn, shared by the workspace backend and
 * the {@link buildExitPlanModeTool} tool.
 *
 * It is deliberately mutable: both hold the *same* object, so approving the plan
 * unlocks writing inside the turn that is already running — the agent goes
 * straight from «here is my plan» to editing files, instead of ending its turn
 * and waiting for another message.
 */
export interface PlanGuard {
  /** True while the workspace is read-only. */
  readonly active: boolean;
  /** Lifts the guard for the rest of the turn (the user approved the plan). */
  release(): void;
}

/** Creates a guard, active until the plan is approved. */
export function createPlanGuard(active = true): PlanGuard {
  let planning = active;
  return {
    get active(): boolean {
      return planning;
    },
    release(): void {
      planning = false;
    },
  };
}

/**
 * The refusal a blocked operation returns. Written in Russian and for the user
 * as much as for the model: file and shell tools are visible steps in the Code
 * timeline, so this text is what appears in the transcript when the agent tries
 * to write while planning. It has to read as a rule of the mode rather than as a
 * broken tool, or the model spends its turn trying to repair the sandbox.
 */
export function planRefusal(what: string): string {
  return [
    `Refused: plan mode — ${what}.`,
    'Until the plan is approved the workspace is read-only. This is not a broken tool.',
    `Finish your research by reading (read_file, glob, grep, ls, read-only git) and call \`${EXIT_PLAN_MODE_TOOL}\` with the plan. Once approved, this very turn continues with full access.`,
  ].join('\n');
}

/**
 * Shell constructs that can hide a write behind a read-only-looking head:
 * output redirection, command substitution, and privilege escalation. Parsing
 * around them is not worth the risk — a line containing any of them is refused.
 */
const UNSAFE_SHELL = /[>`]|\$\(|\bsudo\b|\bdoas\b/;

/**
 * Redirections that write nothing — discarding to `/dev/null`, and folding
 * stderr into stdout. Stripped before the scan above, or the everyday
 * `grep -r x . 2>/dev/null` would be refused as a file write.
 */
const HARMLESS_REDIRECTS = /\d*>&\d+|&?>>?\s*\/dev\/null/g;

/** Where one command in a line ends and the next begins. */
const SEGMENT_SEPARATORS = /[;\n]|&&?|\|\|?/;

/** Binaries that cannot modify anything without a redirection (already refused above). */
const READ_ONLY_BINARIES: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'pwd',
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'awk',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'du',
  'df',
  'which',
  'whereis',
  'type',
  'printenv',
  'date',
  'tree',
  'jq',
  'yq',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'true',
  'false',
]);

/** Toolchain entry points whose `--version` probe is read-only whatever they are. */
const TOOLCHAIN_BINARIES: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'pip',
  'pip3',
  'java',
  'javac',
  'mvn',
  'gradle',
  'gradlew',
  './gradlew',
  'go',
  'cargo',
  'rustc',
  'tsc',
  'git',
  'docker',
]);

const VERSION_FLAGS: ReadonlySet<string> = new Set(['-v', '-V', '--version', '-version']);

/** git sub-commands that only ever read the repository. */
const GIT_READ_ONLY: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'diff-tree',
  'log',
  'show',
  'blame',
  'describe',
  'shortlog',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'cat-file',
  'show-ref',
  'symbolic-ref',
  'grep',
  'whatchanged',
  'count-objects',
  'var',
]);

/**
 * Flags that turn `git branch` / `git tag` from a listing into an edit. A bare
 * positional argument is an edit too (it creates a ref), so those sub-commands
 * additionally require every remaining token to be a flag.
 */
const GIT_REF_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-f',
  '-c',
  '-C',
  '-u',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--edit-description',
  '--set-upstream-to',
  '--unset-upstream',
]);

/** `git config` reads only when one of these is present. */
const GIT_CONFIG_READS: ReadonlySet<string> = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--list',
  '-l',
]);

/** Package-manager sub-commands that only report. */
const READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set([
    'ls',
    'list',
    'view',
    'info',
    'show',
    'outdated',
    'why',
    'explain',
    'root',
    'prefix',
  ]),
  pnpm: new Set(['ls', 'list', 'why', 'outdated', 'root']),
  yarn: new Set(['list', 'why', 'info']),
  go: new Set(['list', 'version', 'env', 'vet', 'doc']),
  gradle: new Set(['tasks', 'projects', 'properties', 'dependencies', 'help']),
  gradlew: new Set(['tasks', 'projects', 'properties', 'dependencies', 'help']),
  './gradlew': new Set(['tasks', 'projects', 'properties', 'dependencies', 'help']),
  mvn: new Set(['dependency:tree', 'dependency:list', 'help:effective-pom', 'validate']),
};

/** `find` predicates that make it act on what it matched. */
const FIND_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
]);

/**
 * True when `command` cannot change the workspace, so plan mode may run it.
 *
 * An allow-list rather than a denial list, and deliberately conservative: a
 * legitimate command wrongly refused costs the agent one step and says exactly
 * why, while one wrongly allowed silently edits the repository the user asked it
 * only to read. Anything unrecognised is therefore treated as a write.
 *
 * The whole line must be read-only — `cat a && rm b` is refused on its second
 * segment — and redirection or command substitution anywhere refuses it outright
 * (see {@link UNSAFE_SHELL}).
 */
export function isReadOnlyCommand(command: string): boolean {
  const line = command.replace(HARMLESS_REDIRECTS, ' ');
  if (UNSAFE_SHELL.test(line)) {
    return false;
  }
  return commandSegments(line).every((tokens) => isReadOnlySegment(tokens));
}

/**
 * Splits a shell line into its `;`/`&&`-separated commands, each tokenised on
 * whitespace. Empty segments (the trailing half of `cmd &&`) are dropped.
 *
 * Shared with the remote-git check in `code-git.ts`, which has the same job as
 * this module's: decide what one line of shell would do before running it. Both
 * are deliberately naive about quoting — neither is a security boundary, and
 * `git push` never needs quoting to be recognised.
 */
export function commandSegments(command: string): string[][] {
  return command
    .split(SEGMENT_SEPARATORS)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** True when one `;`/`&&`-separated segment, already tokenised, only reads. */
function isReadOnlySegment(tokens: string[]): boolean {
  if (tokens.length === 0) {
    return true; // The empty half of `cmd &&` or a trailing `;`.
  }
  const [head, ...args] = tokens;

  // `FOO=bar cmd` — the real command hides behind the assignment; not worth
  // unwrapping for the handful of read-only cases it would buy.
  if (head.includes('=')) {
    return false;
  }

  if (TOOLCHAIN_BINARIES.has(head) && args.length === 1 && VERSION_FLAGS.has(args[0])) {
    return true;
  }

  if (head === 'git') {
    return isReadOnlyGit(args);
  }

  if (head === 'sed') {
    // In-place editing is the one thing `sed` does that is not a read.
    return !args.some((arg) => arg === '--in-place' || /^-[a-zA-Z]*i/.test(arg));
  }

  if (head === 'find') {
    return !args.some((arg) => FIND_WRITE_ACTIONS.has(arg));
  }

  const subcommands = READ_ONLY_SUBCOMMANDS[head];
  if (subcommands) {
    return args.length > 0 && subcommands.has(args[0]);
  }

  return READ_ONLY_BINARIES.has(head);
}

/** True when a `git` invocation, given its arguments, only reads the repository. */
function isReadOnlyGit(args: string[]): boolean {
  // Skip the global flags that may precede the sub-command (`-C dir`, `-c k=v`).
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (!subcommand) {
    return false;
  }

  if (GIT_READ_ONLY.has(subcommand)) {
    return true;
  }
  switch (subcommand) {
    case 'branch':
    case 'tag':
      // A listing takes no positional argument — one would create the ref.
      return rest.every((arg) => arg.startsWith('-') && !GIT_REF_WRITE_FLAGS.has(arg));
    case 'remote':
      return rest.every((arg) => arg === '-v' || arg === '--verbose');
    case 'config':
      return rest.some((arg) => GIT_CONFIG_READS.has(arg));
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    case 'submodule':
      return rest[0] === 'status';
    default:
      return false;
  }
}

/** Model-facing description of {@link EXIT_PLAN_MODE_TOOL}. */
const EXIT_PLAN_MODE_DESCRIPTION = [
  'Put your finished plan to the user for approval and leave plan mode.',
  'Call this only once you have researched the repository read-only and know exactly what you intend to change.',
  'The plan is shown to the user as a document, so write it for a human to read and judge:',
  'what you will change and why, which files it touches, and how the result will be verified.',
  'This blocks until the user answers. Approval lifts the read-only guard and you implement the plan',
  'in this same turn; a rejection leaves the workspace read-only and you revise the plan.',
].join(' ');

/** JSON Schema for {@link EXIT_PLAN_MODE_TOOL} arguments. */
const EXIT_PLAN_MODE_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'string',
      description:
        'The complete plan as markdown. Not a checklist of your own steps — the changes you propose, in enough detail that the user can approve or correct them.',
    },
  },
  required: ['plan'],
} as const;

/**
 * Builds the plan-approval tool granted to the coding agent in plan mode.
 *
 * Structurally the `ask_user` tool of `deep-agent.ts`: it emits its event and
 * blocks on the shared `pending` map, so the answer arrives through the existing
 * `POST /code/answer` and no new endpoint is needed. What it adds is the effect
 * of the answer — approval releases `guard`, which is the same object the
 * workspace backend consults on every write, and announces the mode change so
 * the browser can drop the session's plan-mode flag.
 */
export function buildExitPlanModeTool(
  tool: Awaited<ReturnType<typeof loadDeps>>['tool'],
  onEvent: CodeEventSink,
  pending: PendingAnswers,
  signal: AbortSignal,
  guard: PlanGuard,
): unknown {
  return tool(
    async (args: Record<string, unknown>): Promise<string> => {
      const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
      if (!plan) {
        return 'Send the plan itself in `plan` — there is nothing for the user to approve otherwise.';
      }

      const id = randomUUID();
      onEvent({ type: 'plan_proposal', id, plan });
      // Hoisted so it can be detached again: one signal lives for the whole
      // turn, and an agent that re-proposes would otherwise pile up listeners.
      let onAbort = (): void => {};
      let answer: string;
      try {
        answer = await new Promise<string>((resolve, reject) => {
          onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          // The map is shared with `client_tool`, whose results carry an error
          // flag; an approval verdict only ever has text to give back.
          pending.set(id, (result) => resolve(result.text));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
      }

      if (answer.trim() !== CODE_PLAN_APPROVE) {
        return [
          `The user did not approve the plan: ${answer || '(no reason given)'}.`,
          'The workspace is still read-only. Ask what should change, revise the plan,',
          `and call ${EXIT_PLAN_MODE_TOOL} again.`,
        ].join(' ');
      }

      guard.release();
      onEvent({ type: 'plan_mode', active: false });
      return 'Plan approved. Plan mode is off and the workspace is writable again — implement the plan now, in this same turn.';
    },
    {
      name: EXIT_PLAN_MODE_TOOL,
      description: EXIT_PLAN_MODE_DESCRIPTION,
      schema: EXIT_PLAN_MODE_SCHEMA,
    },
  );
}
