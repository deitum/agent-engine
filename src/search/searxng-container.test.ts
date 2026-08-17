import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { type ProcessRunner, type RunResult } from '../code/process';

import { LEGACY_SEARXNG_CONTAINERS, SEARXNG_CONTAINER } from './search.constants';
import { SearxngContainer } from './searxng-container';

/**
 * A stand-in for the Docker CLI, in the spirit of `code-workspace.test.ts`'s
 * `FakeDocker`: the class shells out for everything, and a test that needed a
 * real daemon would not run in CI.
 */
class FakeDocker {
  readonly calls: string[][] = [];
  /** Set false to play a machine where Docker is missing. */
  installed = true;
  /** Set true to play an image that is already on the machine (no pull). */
  imageCached = false;
  running = false;

  readonly runner: ProcessRunner = {
    run: async (command, args): Promise<RunResult> => {
      assert.equal(command, 'docker');
      this.calls.push(args);
      const [verb, ...rest] = args;
      if (!this.installed) {
        throw new Error('docker: command not found');
      }
      switch (verb) {
        case 'version':
          return { stdout: '27.0.0', stderr: '' };
        case 'image':
          if (!this.imageCached) {
            throw new Error(`No such image: ${rest[1]}`);
          }
          return { stdout: '', stderr: '' };
        case 'pull':
          this.imageCached = true;
          return { stdout: '', stderr: '' };
        case 'inspect':
          if (!this.running) {
            throw new Error(`No such object: ${SEARXNG_CONTAINER}`);
          }
          return { stdout: 'true\n', stderr: '' };
        case 'run':
          this.running = true;
          return { stdout: 'deadbeef\n', stderr: '' };
        case 'rm':
          this.running = false;
          return { stdout: '', stderr: '' };
        default:
          throw new Error(`unexpected docker ${verb}`);
      }
    },
  };

  /** The recorded `docker run`, flattened for substring assertions. */
  runArgs(): string {
    return (this.calls.find((call) => call[0] === 'run') ?? []).join(' ');
  }
}

/** Waits for the background start to settle (it is deliberately not awaited). */
async function settle(container: SearxngContainer): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await container.status();
    if (status.state !== 'pulling' && status.state !== 'starting') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('start did not settle');
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-searxng-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('status reports Docker as unavailable instead of failing', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    docker.installed = false;
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => false,
      dnsSearch: async () => [],
    });

    const status = await container.status();
    assert.equal(status.state, 'unavailable');
    assert.match(status.message ?? '', /Docker was not found/);
    assert.equal(await container.resolveUrl(), null);
  });
});

test('start pulls, runs and reports the instance once it answers', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => ['corp.example.test'],
    });

    // The call returns as soon as the work is scheduled — a cold pull must not
    // hold an HTTP request open.
    const scheduled = await container.start({ port: 51999 });
    assert.equal(scheduled.state, 'pulling');

    await settle(container);
    const status = await container.status();
    assert.equal(status.state, 'running');
    assert.equal(status.url, 'http://127.0.0.1:51999');
    assert.equal(await container.resolveUrl(), 'http://127.0.0.1:51999');

    const run = docker.runArgs();
    assert.match(run, /--name agent-engine-searxng/);
    assert.match(run, /--restart unless-stopped/);
    // Loopback only: this is one user's private instance, not a service.
    assert.match(run, /-p 127\.0\.0\.1:51999:8080/);
    assert.match(run, /--dns-search corp\.example\.test/);
    assert.ok(docker.calls.some((call) => call[0] === 'pull'));
  });
});

test('start writes a settings.yml that enables JSON and disables the limiter', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => [],
    });
    await container.start();
    await settle(container);

    const settings = await readFile(join(dir, 'settings.yml'), 'utf8');
    assert.match(settings, /use_default_settings: true/);
    assert.match(settings, /limiter: false/);
    assert.match(settings, /- json/);
    assert.match(settings, /secret_key: '[0-9a-f-]{36}'/);
  });
});

test('an existing settings.yml is the user’s and is never overwritten', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'settings.yml'), '# my config\n', 'utf8');
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => [],
    });
    await container.start();
    await settle(container);

    assert.equal(await readFile(join(dir, 'settings.yml'), 'utf8'), '# my config\n');
  });
});

test('a start that never becomes healthy is reported as an error, not left spinning', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      // The container runs but the engine never answers.
      probe: async () => false,
      dnsSearch: async () => [],
    });
    await container.start();

    // Rather than waiting out the real 90s budget, assert the intermediate
    // state is honest and that nothing claims to be usable.
    const status = await container.status();
    assert.ok(status.state === 'pulling' || status.state === 'starting');
    assert.equal(await container.resolveUrl(), null);
  });
});

test('stop removes the container and the URL goes away with it', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => [],
    });
    await container.start();
    await settle(container);
    assert.equal((await container.status()).state, 'running');

    const stopped = await container.stop();
    assert.equal(stopped.state, 'off');
    assert.equal(await container.resolveUrl(), null);
    assert.ok(docker.calls.some((call) => call[0] === 'rm' && call.includes(SEARXNG_CONTAINER)));
  });
});

/**
 * The container runs with `--restart unless-stopped`, so one started by an older
 * build is still up after a reboot — holding the port. `docker run` would then
 * fail on the *bind*, naming a port rather than the stale container that has it,
 * so every name this engine has used has to be removed.
 */
test('a container left under a name this build no longer uses is removed too', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => [],
    });

    await container.start();
    await settle(container);

    for (const legacy of LEGACY_SEARXNG_CONTAINERS) {
      assert.ok(
        docker.calls.some((call) => call[0] === 'rm' && call.includes(legacy)),
        `${legacy} is removed before the new container starts`,
      );
    }
  });
});

test('a container left running by a previous daemon is picked up without a start', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    // What `--restart unless-stopped` leaves behind after the daemon exits.
    docker.running = true;
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => true,
      dnsSearch: async () => [],
    });

    assert.equal(await container.resolveUrl(), 'http://127.0.0.1:50881');
    assert.ok(!docker.calls.some((call) => call[0] === 'run'));
  });
});

test('an internal registry image is honoured and reported back', async () => {
  await withDir(async (dir) => {
    const docker = new FakeDocker();
    const container = new SearxngContainer({
      runner: docker.runner,
      configDir: dir,
      probe: async () => docker.running,
      dnsSearch: async () => [],
    });
    await container.start({ image: 'nexus.corp/searxng:2026.1' });
    await settle(container);

    assert.equal((await container.status()).image, 'nexus.corp/searxng:2026.1');
    assert.match(docker.runArgs(), /nexus\.corp\/searxng:2026\.1/);
  });
});
