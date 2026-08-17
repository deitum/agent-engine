// Two things `npm run check:package` cannot prove about a release.
//
// First, that the binary in the tarball boots. A broken shebang, a dependency
// that only resolved because a workspace symlink existed, or a top-level `await
// import()` of something that is not there all pass every other check in CI and
// fail on a user's first `npx`. So this starts the built daemon on a free port
// and asks it the one question that needs no configuration: `GET /ping`.
//
// Second, that the tarball carries no tests. They are compiled into `dist/`
// (see the `//test` note in package.json) and kept out by a negated `files`
// entry, which is exactly the kind of thing that breaks silently.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Away from the daemon's own default, so a developer's running instance is not in the way. */
const PORT = 50897;
const TOKEN = 'smoke-token';
const BOOT_TIMEOUT_MS = 20_000;

// Hermetic: without this the daemon would open the real `~/.agent-engine` of
// whoever ran it, which on a developer's machine is their actual state.
const home = mkdtempSync(join(tmpdir(), 'agent-engine-smoke-'));

const daemon = spawn(process.execPath, ['dist/cli.js', TOKEN], {
  env: { ...process.env, PORT: String(PORT), AGENT_ENGINE_HOME: home },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let output = '';
daemon.stdout.on('data', (chunk) => {
  output += chunk;
});

/** Set before we stop the daemon ourselves, so its exit is not read as a crash. */
let stopping = false;

const cleanup = () => rmSync(home, { recursive: true, force: true });

const fail = async (message) => {
  stopping = true;
  console.error(message);
  daemon.kill('SIGKILL');
  cleanup();
  process.exit(1);
};

daemon.on('exit', (code) => {
  if (!stopping) {
    console.error(`The daemon exited with ${code} before it could answer.\n${output}`);
    cleanup();
    process.exit(1);
  }
});

/** `/ping` is unauthenticated on purpose, which is what makes it the right probe. */
const ping = async () => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/ping`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
};

const reported = await ping();
if (!reported) {
  await fail(`The daemon did not answer /ping within ${BOOT_TIMEOUT_MS / 1000}s.\n${output}`);
}

stopping = true;
daemon.kill();
await once(daemon, 'exit');
cleanup();

if (reported.name !== '@deitum/agent-engine' || !reported.version) {
  await fail(`/ping identified itself as ${JSON.stringify(reported)}.`);
}
// The token was not sent, so this must be false — if it were true the bearer
// check would be passing requests it never authenticated.
if (reported.authorized !== false) {
  await fail('/ping reported `authorized` without being given a token.');
}
console.log(`${reported.name} ${reported.version} — storage: ${reported.storage}`);

const packed = spawn('npm', ['pack', '--dry-run', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});
const chunks = [];
packed.stdout.on('data', (chunk) => chunks.push(chunk));
const [packExit] = await once(packed, 'exit');
if (packExit !== 0) {
  console.error('npm pack --dry-run failed.');
  process.exit(1);
}

const [tarball] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const tests = tarball.files.filter((file) => /\.test\./u.test(file.path));
if (tests.length > 0) {
  console.error(
    `The tarball carries ${tests.length} test file(s), starting with ${tests[0].path}.`,
  );
  process.exit(1);
}

const entrypoints = [
  'dist/index.js',
  'dist/cli.js',
  'dist/client/index.js',
  'dist/contracts/index.js',
];
const packedPaths = new Set(tarball.files.map((file) => file.path));
const missing = entrypoints.filter((file) => !packedPaths.has(file));
if (missing.length > 0) {
  console.error(`The tarball is missing ${missing.join(', ')} — check "files" in package.json.`);
  process.exit(1);
}
console.log(`tarball: ${tarball.files.length} files, no tests, every entry point present`);
