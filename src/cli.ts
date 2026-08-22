#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { trustSystemCerts } from './config/ca-certs';
import { applyTlsPolicy } from './config/tls';
import { startFileLog } from './log-file';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package.constants';
import { createEngineServer } from './server';
import { stateDbPath } from './storage/storage.constants';

const DEFAULT_PORT = 50880;
/** How long a shutdown may take before the process is killed regardless. */
const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  // First, so that everything below — a rejected port, a CA warning, the banner
  // itself — is in the file the user is about to be told the path of.
  const log = startFileLog();

  // `MCP_AUTH_TOKEN` is what this was called before the engine was a package of
  // its own; still read so an existing launcher script keeps working.
  const token =
    process.argv[2] ?? process.env.AGENT_ENGINE_TOKEN ?? process.env.MCP_AUTH_TOKEN ?? randomUUID();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid PORT: ${String(process.env.PORT)}`);
    process.exit(1);
  }

  // This daemon now calls the LLM gateway itself, and on a corporate machine the
  // CA that signs it usually lives in the OS store — which Node ignores unless
  // told. Done here rather than in `createEngineServer` because it changes
  // the whole process's trust, and a test that spins up a server should not.
  trustSystemCerts();

  // The escape hatch for a machine where trusting more is not enough: started
  // with `AGENT_ENGINE_SSL_VERIFY=false`, this process stops verifying
  // certificates from boot rather than from the first handshake. Every handshake
  // re-applies the decision together with what the deployment says.
  applyTlsPolicy(undefined);

  // `stop` is defined below and only ever reached from a request handler, i.e.
  // long after `main` has returned.
  const server = createEngineServer({ token, onShutdownRequest: () => stop() });

  server.listen(port, '127.0.0.1', () => {
    console.log(`${PACKAGE_NAME} v${PACKAGE_VERSION} is running.`);
    console.log('');
    console.log(`  URL:   http://127.0.0.1:${port}`);
    console.log(`  Token: ${token}`);
    console.log(`  Data:  ${stateDbPath()} (only if a client moves its storage here)`);
    console.log(`  Logs:  ${log ? log.path : 'this console only — no log file could be opened'}`);
    console.log('');
    // The person reading this ran a command their app told them to run, and the
    // one thing they need to know is that the terminal is done with them.
    console.log('The connector is running — go back to the app.');
    console.log('Give the URL and token to your app, which then hands this process its');
    console.log('configuration over POST /config. Keep it running while you use the app.');
  });

  let stopping = false;
  const stop = (): void => {
    // A second Ctrl+C means "I do not care about the containers" — obey it.
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    console.log('Stopping — ending open streams and containers…');

    // Nothing here may hang the exit: a wedged Docker daemon must not make the
    // connector unkillable.
    const forced = setTimeout(() => {
      console.error(`Shutdown exceeded ${SHUTDOWN_GRACE_MS / 1000}s — exiting anyway.`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forced.unref();

    server.close();
    void server.shutdownConnector().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`Shutdown failed: ${String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Windows never delivers SIGTERM, and Ctrl+Break is the other way a console
  // process is asked to stop there — without it the containers are orphaned.
  process.on('SIGBREAK', stop);
}

main();
