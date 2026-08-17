import { createHash } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

/**
 * Whether this Node can be told what to trust at runtime. The two APIs arrived
 * together in Node 22.15; on anything older the daemon keeps working and the
 * user is back to `NODE_EXTRA_CA_CERTS`.
 */
const SUPPORTED =
  typeof setDefaultCACertificates === 'function' && typeof getCACertificates === 'function';

/**
 * What this process trusted before we touched anything — the bundled Mozilla
 * roots plus whatever `NODE_EXTRA_CA_CERTS` added.
 *
 * Snapshotted once, at import, because every later application merges onto
 * *this* rather than onto the current store: a certificate the deployment stops
 * publishing has to stop being trusted at the next handshake, not linger until
 * the daemon is restarted.
 */
const BASE: readonly string[] = SUPPORTED ? getCACertificates('default') : [];

/** The machine's own store, added at startup — see {@link trustSystemCerts}. */
let system: readonly string[] = [];
/** What the deployment last published — see {@link trustDeploymentCerts}. */
let deployment: readonly string[] = [];

/** The set currently installed, so an unchanged handshake does no work. */
let installed = '';
/** A set Node refused, so a handshake every 30 seconds complains only once. */
let refused = '';

let warned = false;

/**
 * Rebuilds the process trust store from {@link BASE} plus everything added
 * since. Returns whether it was applied (i.e. whether this runtime can).
 */
function apply(): boolean {
  if (!SUPPORTED) {
    return false;
  }

  const certs = [...new Set([...BASE, ...system, ...deployment])];
  // Hashed rather than counted: a deployment that swaps one certificate for
  // another keeps the count and would otherwise never be applied.
  const signature = createHash('sha1').update(certs.join('\n')).digest('hex');
  if (signature === installed) {
    return true;
  }
  if (signature === refused) {
    return false;
  }

  try {
    setDefaultCACertificates(certs);
  } catch (error) {
    // One malformed certificate makes Node refuse the whole list, and this runs
    // on every handshake — so a typo in the deployment's directory would take
    // the app down rather than degrade it. The previous store stays in force.
    refused = signature;
    console.warn(
      `[llm] Certificates were refused, keeping the previous trust store: ${String(error)}`,
    );
    return false;
  }

  installed = signature;
  return true;
}

/**
 * Adds the machine's own certificate store to what this process trusts.
 *
 * Node does not look there on its own — it ships its own copy of the Mozilla
 * roots — and on a corporate machine the CA that fronts everything is exactly
 * what an MDM put in that store. Without this the daemon could not even reach
 * the API to ask for the deployment's certificates, which is the chicken-and-egg
 * this call exists to break.
 */
export function trustSystemCerts(): void {
  if (!SUPPORTED) {
    return;
  }
  try {
    system = getCACertificates('system');
  } catch (error) {
    // Not every platform has a store Node can read. Nothing is lost: the
    // deployment's own certificates still arrive with the handshake.
    console.warn(`[llm] Could not read the system certificate store: ${String(error)}`);
    return;
  }
  apply();
}

/**
 * Trusts the certificates the deployment publishes (`CA_CERT_DIR` on the API,
 * relayed through `GET /api/llm/config`), so a corporate TLS gateway works
 * without every user setting `NODE_EXTRA_CA_CERTS` on their own machine.
 *
 * Returns how many were applied — `0` on a Node too old to be told, where it
 * warns once instead of failing: the gateway may well be publicly trusted, and
 * a daemon that refused to start over it would be worse than one that says so.
 */
export function trustDeploymentCerts(pems: readonly string[]): number {
  const certs = pems.map((pem) => pem.trim()).filter(Boolean);

  if (!SUPPORTED) {
    if (certs.length > 0 && !warned) {
      warned = true;
      console.warn(
        `[llm] ${certs.length} CA certificate(s) from the deployment could not be applied: ` +
          `this Node (${process.version}) is older than 22.15. ` +
          'Update Node, or start the connector with NODE_EXTRA_CA_CERTS pointing at them.',
      );
    }
    return 0;
  }

  deployment = certs;
  return apply() ? certs.length : 0;
}
