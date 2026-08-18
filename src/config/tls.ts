/**
 * Whether this process verifies TLS certificates at all — the last resort for a
 * network that intercepts TLS with a certificate nobody can hand over.
 *
 * `ca-certs.ts` is the answer to the same problem that keeps the connection
 * authenticated, and it is the one to reach for first. This is the switch for
 * when that is not possible: an interception certificate that cannot be
 * extracted, a gateway whose chain is broken rather than private, a machine
 * where the user cannot install anything. The two are independent — certificates
 * stay trusted while verification is off, and turning verification back on does
 * not withdraw them.
 *
 * It is implemented as `NODE_TLS_REJECT_UNAUTHORIZED` rather than a per-request
 * option because there is no single place every outbound call goes through: the
 * gateway client, the repository providers, the catalogue, web search and the
 * MCP SDK all reach for the global `fetch`. Node reads that variable on every
 * `tls.connect`, so setting it here covers all of them at once, including the
 * ones a dependency makes on its own — and {@link insecureChildEnv} carries the
 * same decision into the processes this daemon spawns, which do not inherit it
 * through an allow-list.
 */

/** Environment variable a user can start the daemon with — see {@link sslVerifyFromEnv}. */
export const SSL_VERIFY_VAR = 'AGENT_ENGINE_SSL_VERIFY';

/** Node's own switch, which is what actually turns verification off. */
const NODE_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED';

/** Values that read as «off» in the environment, in the spelling people use. */
const OFF = new Set(['false', '0', 'no', 'off']);

/**
 * What this process spawns its children with while verification is off. Node's
 * variable for anything running on Node, git's and npm's for the two programs
 * with a store of their own — the coding sandbox runs all three.
 */
const INSECURE_CHILD_ENV: Readonly<Record<string, string>> = {
  [NODE_VAR]: '0',
  GIT_SSL_NO_VERIFY: '1',
  NPM_CONFIG_STRICT_SSL: 'false',
};

/** Whether *this module* turned verification off, so it only undoes its own work. */
let insecure = false;
let warned = false;

/**
 * The daemon-local answer, for a user who cannot change the deployment: an
 * `AGENT_ENGINE_SSL_VERIFY=false` on the process that started this one.
 *
 * `undefined` when the variable is unset — which is not the same as `true`, and
 * is what lets the client's answer stand on its own.
 */
export function sslVerifyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = (env[SSL_VERIFY_VAR] ?? '').trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  return !OFF.has(raw);
}

/**
 * Settles whether certificates are verified from here on, and returns whether
 * they are (i.e. the safe state is `true`).
 *
 * Either side can turn verification off and neither can override the other: the
 * deployment says so in the configuration bundle, the user says so in the
 * environment of the daemon they started. An embedder that cares about the
 * difference can see which one is in force — the bundle is its own, and the
 * answer here is the total.
 *
 * Re-applied on every handshake, so a deployment that stops publishing the flag
 * gets verification back at the next probe rather than at the next restart. Only
 * what this module set is ever undone: a daemon started with
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` by hand keeps it, because that variable is
 * the user's and not ours to clear.
 *
 * What coming back on cannot do is re-check a connection that is already open:
 * the variable is read per handshake, and a pooled keep-alive socket to a host
 * this process already accepted stays usable until it goes idle. New
 * connections — and every other host — verify again immediately.
 */
export function applyTlsPolicy(
  sslVerify: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const off = sslVerify === false || sslVerifyFromEnv(env) === false;

  if (off) {
    env[NODE_VAR] = '0';
    if (!warned) {
      warned = true;
      console.warn(
        '[tls] Certificate verification is OFF for every outbound call this daemon makes ' +
          '(the gateway, repositories, the catalogue, web search, MCP servers, git). ' +
          'Traffic can be read and altered by anything on the path. ' +
          'Publish the interception CA instead as soon as you can.',
      );
    }
  } else if (insecure) {
    delete env[NODE_VAR];
  }

  insecure = off;
  return !off;
}

/** Whether verification is currently off. Read by everything that spawns. */
export function tlsVerificationDisabled(): boolean {
  return insecure;
}

/**
 * The environment additions a spawned process needs to make the same choice —
 * empty while verification is on, so a caller can always spread it.
 *
 * Needed because none of the ways this daemon starts a process pass the
 * environment through whole: the MCP SDK's stdio transport and the agent's local
 * shell both copy an allow-list, and a Docker container starts with none of it.
 */
export function insecureChildEnv(): Record<string, string> {
  return insecure ? { ...INSECURE_CHILD_ENV } : {};
}

/**
 * Test seam: forgets that anything was applied, without touching the
 * environment. The one-time warning stays spent — it is per process by design,
 * and a suite that re-warned on every case would drown its own output.
 */
export function resetTlsPolicyForTests(): void {
  insecure = false;
}
