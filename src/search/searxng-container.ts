import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dnsSearchArgs, hostSearchDomains } from '../code/docker-dns';
import { defaultRunner, PROCESS_TIMEOUTS, type ProcessRunner } from '../code/process';
import {
  SEARXNG_IMAGE,
  SEARXNG_PORT,
  type SearchBackendState,
  type SearchStartRequest,
  type SearchStatus,
} from '../contracts';
import { toDockerMountPath } from '../platform';

import {
  LEGACY_SEARXNG_CONTAINERS,
  SEARXNG_CONFIG_DIR,
  SEARXNG_CONTAINER,
  SEARXNG_ENV_KEYS,
  SEARXNG_LABEL,
  SEARXNG_PROBE_INTERVAL_MS,
  SEARXNG_READY_TIMEOUT_MS,
} from './search.constants';

/** Probes an already-running instance; injectable so tests never open a socket. */
export type HealthProbe = (url: string) => Promise<boolean>;

/** How long a liveness check is trusted before it is taken again. */
const READY_TTL_MS = 30_000;

/**
 * The SearXNG instance the connector runs for the user, as a Docker container on
 * their own machine.
 *
 * It lives here and not in the cluster because the cluster has no internet
 * access at all: the daemon is the only part of the product that can reach the
 * outside world, so the search backend has to sit next to it. Everything about
 * the lifecycle mirrors {@link CodeWorkspaces} — the same `ProcessRunner` seam,
 * the same timeouts, the same «Docker missing is a message, not a crash» rule —
 * so there is one way containers are handled in this daemon rather than two.
 *
 * The container is **not** stopped when the daemon shuts down. It is started by
 * an explicit user action, runs with `--restart unless-stopped`, and a cold
 * start costs an image pull; tying it to Ctrl+C would make every daemon restart
 * an outage of the search tools. The settings screen has a stop button for the case
 * where the user actually wants it gone.
 */
export class SearxngContainer {
  private readonly runner: ProcessRunner;
  private readonly configDir: string;
  private readonly probe: HealthProbe;
  private readonly dnsSearch: () => Promise<string[]>;

  /** Port/image the last start was asked for, so `status` can report them back. */
  private port = SEARXNG_PORT;
  private image = SEARXNG_IMAGE;

  /**
   * State of the start currently in flight, or of the last one that failed.
   *
   * `start` returns as soon as the work is scheduled and the browser polls
   * `GET /search/status`, so this is where a multi-minute `docker pull` is
   * visible from. `null` means nothing is in flight and Docker is the source of
   * truth for the answer.
   */
  private pending: { state: SearchBackendState; message?: string } | null = null;

  constructor(
    options: {
      runner?: ProcessRunner;
      configDir?: string;
      probe?: HealthProbe;
      dnsSearch?: () => Promise<string[]>;
    } = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.configDir = options.configDir ?? SEARXNG_CONFIG_DIR;
    this.probe = options.probe ?? defaultProbe;
    this.dnsSearch = options.dnsSearch ?? (() => hostSearchDomains(this.runner));
  }

  /** Result of the last liveness check, with the moment it was taken. */
  private ready: { value: boolean; at: number } | null = null;

  /** The liveness check currently in flight, shared by everyone who asks. */
  private checking: Promise<boolean> | null = null;

  /**
   * Base URL the instance answers on, or `null` when it is not up.
   *
   * Asked at the start of every turn that has search enabled, and therefore
   * answered from the last check whenever there is one — a `docker inspect` plus
   * a health probe means spawning the Docker CLI, which is cheap next to a model
   * call but not next to nothing, and it would sit squarely between the user
   * pressing Enter and the first token. Past {@link READY_TTL_MS} the answer is
   * still served, and the check runs behind the turn rather than in front of it,
   * so the *next* one is current. Only the very first call, which has nothing to
   * serve, waits. A container started before the daemon (it outlives it on
   * purpose) is picked up here rather than needing the settings screen.
   */
  async resolveUrl(): Promise<string | null> {
    if (this.pending) {
      return null;
    }
    const cached = this.ready;
    if (!cached) {
      return (await this.checkReady()) ? this.baseUrl() : null;
    }
    if (Date.now() - cached.at >= READY_TTL_MS) {
      void this.checkReady().catch(() => {
        // A failed check leaves the last answer in place; the next turn retries.
      });
    }
    return cached.value ? this.baseUrl() : null;
  }

  /**
   * What the backend is doing right now. Docker is asked every time rather than
   * served from the cache: the user can stop the container from their own
   * terminal, and a status that insists it is running is worse than a slow one.
   */
  async status(): Promise<SearchStatus> {
    if (this.pending) {
      return {
        mode: 'managed',
        state: this.pending.state,
        image: this.image,
        port: this.port,
        ...(this.pending.message ? { message: this.pending.message } : {}),
      };
    }

    if (!(await this.hasDocker())) {
      this.ready = { value: false, at: Date.now() };
      return {
        mode: 'managed',
        state: 'unavailable',
        message:
          'Docker was not found. Install and start Docker, or name a SearXNG address instead.',
      };
    }

    const running = await this.isRunning();
    const healthy = running && (await this.probe(this.baseUrl()));
    this.ready = { value: healthy, at: Date.now() };
    return {
      mode: 'managed',
      // Running but not answering yet is «starting», not «broken»: the engine
      // takes a few seconds to come up after the container does.
      state: healthy ? 'running' : running ? 'starting' : 'off',
      image: this.image,
      port: this.port,
      ...(healthy ? { url: this.baseUrl() } : {}),
    };
  }

  /**
   * One liveness check (container up *and* engine answering), memoized — and
   * never two at once: several turns can start within the same second, and each
   * of them finding the cache stale must not mean its own pair of Docker calls.
   */
  private checkReady(): Promise<boolean> {
    this.checking ??= (async () => {
      try {
        const healthy = (await this.isRunning()) && (await this.probe(this.baseUrl()));
        this.ready = { value: healthy, at: Date.now() };
        return healthy;
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /**
   * Brings the instance up, in the background: writes the config, pulls the
   * image if it is missing, runs the container and waits for its health probe.
   * Returns the status as of scheduling, so a cold pull does not hold an HTTP
   * request open for a quarter of an hour.
   */
  async start(request: SearchStartRequest = {}): Promise<SearchStatus> {
    if (this.pending) {
      return this.status();
    }
    if (request.port !== undefined) {
      this.port = request.port;
    }
    if (request.image) {
      this.image = request.image;
    }

    if (!(await this.hasDocker())) {
      return this.status();
    }

    this.pending = { state: 'pulling', message: 'Pulling the SearXNG image…' };
    void this.run().then(
      () => {
        this.pending = null;
      },
      (error: unknown) => {
        // Left as the pending state on purpose: an error that is cleared on the
        // next poll is an error the user never gets to read.
        this.pending = { state: 'error', message: asMessage(error) };
      },
    );
    return this.status();
  }

  /** Stops and removes the container. Idempotent. */
  async stop(): Promise<SearchStatus> {
    this.pending = null;
    this.ready = { value: false, at: Date.now() };
    await this.removeContainers();
    return this.status();
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Removes our container, under its current name and every name it has had.
   *
   * A container left from a previous run may be bound to another port or a stale
   * image, and `docker run` would only fail on the *name* clash. One left under
   * an older name would not even do that: it keeps running, keeps the port, and
   * the new container dies on the bind instead — with an error about a port
   * rather than about the stale container that is holding it.
   */
  private async removeContainers(): Promise<void> {
    for (const name of [SEARXNG_CONTAINER, ...LEGACY_SEARXNG_CONTAINERS]) {
      await this.dockerAllowFail(['rm', '-f', name]);
    }
  }

  /** The whole start sequence, run detached from the HTTP request. */
  private async run(): Promise<void> {
    await this.writeSettings();

    if (!(await this.imagePresent())) {
      await this.docker(['pull', this.image], PROCESS_TIMEOUTS.dockerPull);
    }

    this.pending = { state: 'starting', message: 'Starting…' };
    await this.removeContainers();
    await this.docker(await this.runArgs(), PROCESS_TIMEOUTS.dockerLifecycle);

    if (!(await this.waitForReady())) {
      throw new Error(
        `SearXNG did not answer within ${Math.round(SEARXNG_READY_TIMEOUT_MS / 1000)}s. Check «docker logs ${SEARXNG_CONTAINER}».`,
      );
    }
    this.ready = { value: true, at: Date.now() };
  }

  private async runArgs(): Promise<string[]> {
    const args = [
      'run',
      '-d',
      '--name',
      SEARXNG_CONTAINER,
      '--label',
      `${SEARXNG_LABEL}=1`,
      // Survives a machine reboot and a Docker restart, which is what makes it
      // reasonable not to stop it with the daemon.
      '--restart',
      'unless-stopped',
      // Loopback only: this is one user's private instance, not a service.
      '-p',
      `127.0.0.1:${this.port}:8080`,
      '-v',
      `${toDockerMountPath(this.configDir)}:/etc/searxng`,
    ];
    for (const key of SEARXNG_ENV_KEYS) {
      const value = process.env[key];
      if (value) {
        args.push('-e', `${key}=${value}`);
      }
    }
    // Same reason as a Code container: without the host's search domains an
    // internal short host does not resolve inside Docker (see `docker-dns.ts`).
    args.push(...dnsSearchArgs(await this.dnsSearch()));
    args.push(this.image);
    return args;
  }

  /**
   * Writes the instance's `settings.yml` unless the user already has one — the
   * file is theirs to edit once it exists (engines, hosting policy, language).
   *
   * The two overrides that are not optional: SearXNG serves **HTML only** by
   * default and answers `format=json` with a 403, and its bot limiter rejects
   * requests that do not come from a browser. Both would make every single tool
   * call fail, on an instance that looks perfectly healthy in a browser tab.
   */
  private async writeSettings(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const path = join(this.configDir, 'settings.yml');
    const settings = [
      '# Generated by @deitum/agent-engine. Edit freely — it is not overwritten.',
      'use_default_settings: true',
      'server:',
      `  secret_key: '${randomUUID()}'`,
      '  limiter: false',
      '  image_proxy: false',
      'search:',
      '  formats:',
      '    - json',
      '    - html',
      '',
    ].join('\n');
    await writeFile(path, settings, { encoding: 'utf8', flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    });
  }

  /** Polls the engine's health endpoint until it answers or the budget runs out. */
  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + SEARXNG_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.probe(this.baseUrl())) {
        return true;
      }
      await delay(SEARXNG_PROBE_INTERVAL_MS);
    }
    return false;
  }

  private async hasDocker(): Promise<boolean> {
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}'], PROCESS_TIMEOUTS.probe);
      return true;
    } catch {
      return false;
    }
  }

  private async isRunning(): Promise<boolean> {
    try {
      const stdout = await this.docker(
        ['inspect', '--format', '{{.State.Running}}', SEARXNG_CONTAINER],
        PROCESS_TIMEOUTS.probe,
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async imagePresent(): Promise<boolean> {
    try {
      await this.docker(['image', 'inspect', this.image], PROCESS_TIMEOUTS.probe);
      return true;
    } catch {
      return false;
    }
  }

  private async docker(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await this.runner.run('docker', args, { timeoutMs });
    return stdout;
  }

  private async dockerAllowFail(args: string[]): Promise<void> {
    try {
      await this.docker(args, PROCESS_TIMEOUTS.dockerLifecycle);
    } catch {
      // best-effort: removing a container that is not there is a no-op
    }
  }
}

/** True when SearXNG answers its own `/healthz`. Never throws. */
async function defaultProbe(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(PROCESS_TIMEOUTS.probe),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
