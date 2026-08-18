import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { ConnectorError } from '../connector';
import { type EngineConfigRequest } from '../contracts';

import {
  adoptEngineConfig,
  configVersion,
  requireConfig,
  resetEngineConfig,
  resolveApiKey,
  resolveGatewayUrl,
  resolveRepoCredentials,
  resolveSearchConfig,
} from './engine-config';
import { resetTlsPolicyForTests } from './tls';

const realFetch = globalThis.fetch;

/** Answers the host config endpoint with `body`, recording the URL asked for. */
function hostServing(body: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { urls };
}

/** Fails the test if anything reaches the network at all. */
function noNetwork(): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (() => {
    state.calls += 1;
    return Promise.reject(new Error('the network should not have been touched'));
  }) as typeof fetch;
  return state;
}

/** A handshake bundle with only the parts a test cares about spelled out. */
function bundle(overrides: Partial<EngineConfigRequest> = {}): EngineConfigRequest {
  return {
    version: 'v1',
    llm: { apiKey: 'sk-test' },
    hostConfigUrl: 'https://app.corp/api/llm/config',
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEngineConfig();
});

describe('adoptEngineConfig — a gateway named outright', () => {
  test('is adopted without touching the network at all', async () => {
    const network = noNetwork();

    const result = await adoptEngineConfig({
      version: 'v1',
      llm: { baseUrl: 'https://gateway.corp/v1', apiKey: 'sk-test' },
    });

    assert.equal(network.calls, 0);
    assert.equal(result.baseUrl, 'https://gateway.corp/v1');
    assert.equal(resolveGatewayUrl(), 'https://gateway.corp/v1');
  });

  test('wins over a host that was named as well', async () => {
    const network = noNetwork();

    await adoptEngineConfig(
      bundle({ llm: { baseUrl: 'https://direct.corp/v1', apiKey: 'sk-test' } }),
    );

    assert.equal(network.calls, 0);
    assert.equal(resolveGatewayUrl(), 'https://direct.corp/v1');
  });

  test('a bundle naming neither is a 400, before anything is fetched', async () => {
    const network = noNetwork();

    await assert.rejects(() => adoptEngineConfig({ version: 'v1', llm: { apiKey: 'sk-test' } }), {
      status: 400,
    });
    assert.equal(network.calls, 0);
  });
});

describe('adoptEngineConfig — a gateway read from the host', () => {
  test('fetches exactly the URL it was given, with no route of its own', async () => {
    const host = hostServing({ baseUrl: 'https://gateway.corp/v1' });

    const result = await adoptEngineConfig(bundle());

    assert.deepEqual(host.urls, ['https://app.corp/api/llm/config']);
    assert.equal(result.baseUrl, 'https://gateway.corp/v1');
    assert.equal(resolveGatewayUrl(), 'https://gateway.corp/v1');
  });

  test('keeps the rest of the bundle for the routes that spend it', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1' });

    await adoptEngineConfig(
      bundle({
        search: { enabled: true, maxResults: 7 },
        repos: [{ provider: 'bitbucket-server', username: 'ivan', token: 'bb-token' }],
      }),
    );

    assert.equal(resolveApiKey(), 'sk-test');
    assert.deepEqual(resolveSearchConfig(), { enabled: true, maxResults: 7 });
    assert.deepEqual(resolveRepoCredentials('bitbucket-server'), {
      provider: 'bitbucket-server',
      username: 'ivan',
      token: 'bb-token',
    });
  });

  test('the version travels back and is what /ping reports', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1' });

    const result = await adoptEngineConfig(bundle({ version: 'abc123' }));

    assert.equal(result.version, 'abc123');
    assert.equal(configVersion(), 'abc123');
  });

  test('a trailing slash on the gateway is not carried into every request', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1/' });

    const result = await adoptEngineConfig(bundle());

    assert.equal(result.baseUrl, 'https://gateway.corp/v1');
  });

  test('a host publishing no certificates is still adopted', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1' });

    const result = await adoptEngineConfig(bundle());

    assert.equal(result.caCerts, 0);
    assert.equal(resolveGatewayUrl(), 'https://gateway.corp/v1');
  });

  test('a host that declares no gateway is refused, not adopted', async () => {
    hostServing({ baseUrl: '   ' });

    await assert.rejects(() => adoptEngineConfig(bundle()), { status: 502 });
    // Nothing was kept, so the client is told to hand it all over again rather
    // than left with a daemon holding half a configuration.
    assert.throws(() => requireConfig(), { status: 428 });
    assert.equal(configVersion(), '');
  });

  test('a host that answers with an error is refused', async () => {
    hostServing({ message: 'nope' }, 503);

    await assert.rejects(() => adoptEngineConfig(bundle()), { status: 502 });
  });

  test('an unreachable host is a 502 naming the address', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof fetch;

    await assert.rejects(
      () => adoptEngineConfig(bundle()),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.status, 502);
        assert.match(error.message, /app\.corp/);
        return true;
      },
    );
  });

  test('a later handshake replaces the whole of the earlier one', async () => {
    hostServing({ baseUrl: 'https://first.corp/v1' });
    await adoptEngineConfig(
      bundle({ version: 'one', llm: { apiKey: 'first' }, search: { enabled: true } }),
    );

    hostServing({ baseUrl: 'https://second.corp/v1' });
    await adoptEngineConfig(bundle({ version: 'two', llm: { apiKey: 'second' } }));

    assert.equal(resolveGatewayUrl(), 'https://second.corp/v1');
    assert.equal(resolveApiKey(), 'second');
    assert.equal(configVersion(), 'two');
    // Dropped, not merged: the bundle is the whole configuration, so a setting
    // the user turned off has to leave with it.
    assert.equal(resolveSearchConfig(), undefined);
  });
});

describe('adoptEngineConfig — certificate verification', () => {
  const NODE_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED';

  afterEach(() => {
    delete process.env[NODE_VAR];
    resetTlsPolicyForTests();
  });

  test('is on unless someone says otherwise, and says so', async () => {
    noNetwork();

    const result = await adoptEngineConfig({
      version: 'v1',
      llm: { baseUrl: 'https://gateway.corp/v1', apiKey: 'sk' },
    });

    assert.equal(result.sslVerify, true);
    assert.equal(process.env[NODE_VAR], undefined);
  });

  test('a bundle that turns it off is applied before the host is fetched', async () => {
    // The whole point of the ordering: a deployment sitting behind the very
    // certificate nobody can verify would otherwise never get to deliver the
    // flag that makes its own address readable.
    const seen: (string | undefined)[] = [];
    globalThis.fetch = (() => {
      seen.push(process.env[NODE_VAR]);
      return Promise.resolve(
        new Response(JSON.stringify({ baseUrl: 'https://gateway.corp/v1' }), { status: 200 }),
      );
    }) as typeof fetch;

    const result = await adoptEngineConfig(bundle({ llm: { apiKey: 'sk', sslVerify: false } }));

    assert.deepEqual(seen, ['0']);
    assert.equal(result.sslVerify, false);
  });

  test('a host may decide it instead of the client', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1', sslVerify: false });

    const result = await adoptEngineConfig(bundle());

    assert.equal(result.sslVerify, false);
    assert.equal(process.env[NODE_VAR], '0');
  });

  test('a client that turned it off is not overruled by a host that did not', async () => {
    hostServing({ baseUrl: 'https://gateway.corp/v1', sslVerify: true });

    const result = await adoptEngineConfig(bundle({ llm: { apiKey: 'sk', sslVerify: false } }));

    assert.equal(result.sslVerify, false);
    assert.equal(process.env[NODE_VAR], '0');
  });
});

describe('resolveRepoCredentials', () => {
  const bitbucket = { provider: 'bitbucket-server' as const, username: 'ivan', token: 'bb' };
  const github = { provider: 'github' as const, token: 'gh' };

  test('answers per provider, so two accounts never shadow each other', async () => {
    noNetwork();
    await adoptEngineConfig({
      version: 'v1',
      llm: { baseUrl: 'https://gateway.corp/v1', apiKey: 'sk' },
      repos: [bitbucket, github],
    });

    assert.deepEqual(resolveRepoCredentials('bitbucket-server'), bitbucket);
    assert.deepEqual(resolveRepoCredentials('github'), github);
  });

  test('a credential naming a host wins over one that names none', async () => {
    const hosted = { provider: 'github' as const, baseUrl: 'https://ghe.corp', token: 'ghe' };
    noNetwork();
    await adoptEngineConfig({
      version: 'v1',
      llm: { baseUrl: 'https://gateway.corp/v1', apiKey: 'sk' },
      repos: [github, hosted],
    });

    assert.deepEqual(resolveRepoCredentials('github', 'https://ghe.corp'), hosted);
    // A different host falls back to the credential that claims no host at all.
    assert.deepEqual(resolveRepoCredentials('github', 'https://github.com'), github);
  });

  test('a provider the user configured nothing for reads as a blank token', () => {
    assert.deepEqual(resolveRepoCredentials('github'), { provider: 'github', token: '' });
  });
});

describe('requireConfig', () => {
  test('is a 428 until a client has handed a configuration over', () => {
    for (const read of [requireConfig, resolveGatewayUrl, resolveApiKey]) {
      assert.throws(
        () => read(),
        (error: unknown) => {
          assert.ok(error instanceof ConnectorError);
          // 428 and not 500: the client answers this one by pushing the
          // configuration and retrying, which is what makes a restart invisible.
          assert.equal(error.status, 428);
          return true;
        },
      );
    }
  });

  test('the optional halves read as absent rather than throwing', () => {
    assert.equal(resolveSearchConfig(), undefined);
    assert.deepEqual(resolveRepoCredentials('bitbucket-server'), {
      provider: 'bitbucket-server',
      token: '',
    });
    assert.equal(configVersion(), '');
  });
});
