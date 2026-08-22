import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { type CodeLspConfig } from '../../contracts';
import { type ExecuteResponse } from '../docker-backend';

import { ensureServerInstalled, firstMeaningfulLine } from './install';
import {
  enabledLanguages,
  installMarkerName,
  languageForPath,
  MIN_JDTLS_JDK,
  parseJavaMajor,
  shellQuote,
  specFor,
} from './servers';

/** An `exec` that answers by matching the command against a table. */
function fakeExec(routes: { match: RegExp; output?: string; exitCode?: number }[]): {
  exec: (command: string, timeoutSec: number) => Promise<ExecuteResponse>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: (command) => {
      calls.push(command);
      const route = routes.find((entry) => entry.match.test(command));
      return Promise.resolve({
        output: route?.output ?? '',
        exitCode: route?.exitCode ?? 0,
        truncated: false,
      });
    },
  };
}

describe('languageForPath', () => {
  test('maps the extensions each server owns', () => {
    assert.equal(languageForPath('src/main/java/App.java'), 'java');
    assert.equal(languageForPath('src/index.ts'), 'typescript');
    assert.equal(languageForPath('src/App.tsx'), 'typescript');
    assert.equal(languageForPath('scripts/build.mjs'), 'typescript');
    assert.equal(languageForPath('app/main.py'), 'python');
    assert.equal(languageForPath('types/api.pyi'), 'python');
  });

  test('returns null for a file no server owns', () => {
    assert.equal(languageForPath('README.md'), null);
    assert.equal(languageForPath('build.gradle.kts'), null);
    assert.equal(languageForPath('Makefile'), null);
  });

  test('is case-insensitive about the extension', () => {
    assert.equal(languageForPath('src/App.JAVA'), 'java');
  });
});

describe('languageId', () => {
  test('distinguishes the JSX flavours tsserver treats differently', () => {
    const spec = specFor('typescript');

    assert.equal(spec.languageId('a.ts'), 'typescript');
    assert.equal(spec.languageId('a.tsx'), 'typescriptreact');
    assert.equal(spec.languageId('a.js'), 'javascript');
    assert.equal(spec.languageId('a.jsx'), 'javascriptreact');
  });
});

describe('enabledLanguages', () => {
  test('allows everything when nothing is configured', () => {
    assert.deepEqual(enabledLanguages(undefined), ['java', 'typescript', 'python']);
    assert.deepEqual(enabledLanguages({}), ['java', 'typescript', 'python']);
  });

  test('honours an explicit list', () => {
    assert.deepEqual(enabledLanguages({ servers: ['python'] }), ['python']);
  });

  test('the master switch wins over the list', () => {
    assert.deepEqual(enabledLanguages({ enabled: false, servers: ['java'] }), []);
  });

  /** An operator who wrote an empty list meant «none», not «surprise me». */
  test('an empty list means none', () => {
    assert.deepEqual(enabledLanguages({ servers: [] }), []);
  });
});

describe('parseJavaMajor', () => {
  test('reads the modern banner', () => {
    assert.equal(parseJavaMajor('openjdk version "21.0.1" 2023-10-17'), 21);
    assert.equal(parseJavaMajor('openjdk version "17" 2021-09-14'), 17);
  });

  /** `1.8.0_202` is Java 8 — the one case where the first number is not the major. */
  test('reads the legacy 1.x banner as its minor', () => {
    assert.equal(parseJavaMajor('java version "1.8.0_202"'), 8);
  });

  test('returns null for anything else', () => {
    assert.equal(parseJavaMajor('bash: java: command not found'), null);
  });
});

describe('java probe', () => {
  const { probe } = specFor('java');

  test('accepts a supported JDK', () => {
    assert.equal(probe.check('openjdk version "21.0.1"', 0), null);
  });

  test('names the version when the JDK is too old', () => {
    const reason = probe.check('java version "1.8.0_202"', 0);
    assert.match(reason ?? '', new RegExp(`JDK ${MIN_JDTLS_JDK}`));
    assert.match(reason ?? '', /JDK 8/);
  });

  test('says the image has no JDK rather than «install failed»', () => {
    assert.match(probe.check('', 127) ?? '', /no JDK/);
  });
});

describe('python probe', () => {
  const { probe } = specFor('python');

  test('accepts an image that has python3 and pip', () => {
    assert.equal(probe.check('pip 24.0 from /usr/lib/python3/dist-packages/pip', 0), null);
  });

  /** `gradle:` and `node:` images both carry python3 without pip. */
  test('names pip when the interpreter is there without it', () => {
    assert.match(probe.check('/usr/bin/python3: No module named pip', 1) ?? '', /no pip/);
  });

  test('says the image has no python3 rather than «install failed»', () => {
    assert.match(probe.check('', 127) ?? '', /no python3/);
  });
});

describe('install recipes', () => {
  /**
   * A recipe is a shell command string, and the only competent judge of one is a
   * shell: `sh -n` parses without running. This is the check that a missing
   * separator between two commands survives every other way — the install dies
   * with «Syntax error», and the session reports a server that is unavailable
   * for no stated reason.
   */
  const parses = (command: string): boolean => {
    try {
      execFileSync('sh', ['-n', '-c', command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  test('every install and launch command is one a shell can parse', () => {
    for (const language of enabledLanguages(undefined)) {
      for (const variant of specFor(language).variants) {
        const install = variant.install({});
        assert.ok(parses(install), `${language}/${variant.id} install: ${install}`);

        const launch = variant.launch({ sessionId: 'probe' });
        assert.ok(parses(launch), `${language}/${variant.id} launch: ${launch}`);
      }
    }
  });

  test('every probe command is one a shell can parse', () => {
    for (const language of enabledLanguages(undefined)) {
      const { command } = specFor(language).probe;
      assert.ok(parses(command), `${language} probe: ${command}`);
    }
  });

  /**
   * `typescript@latest` is the native port: a platform binary and no
   * `lib/tsserver.js`, which the language server refuses to initialize against.
   * Unpinned, the recipe installs cleanly and fails at every start instead.
   */
  test('pins the TypeScript compiler to the major the server can drive', () => {
    assert.match(specFor('typescript').variants[0].install({}), / typescript@5(?![\d.])/);
  });

  test('the npm registry override reaches the command line', () => {
    const command = specFor('typescript').variants[0].install({
      npmRegistry: 'https://nexus.internal/repository/npm',
    });

    assert.match(command, /--registry 'https:\/\/nexus\.internal\/repository\/npm'/);
    assert.match(command, /typescript-language-server typescript@/);
  });

  test('the PyPI index override reaches the command line', () => {
    const command = specFor('python').variants[0].install({
      pypiIndexUrl: 'https://nexus.internal/repository/pypi/simple',
    });

    assert.match(command, /--index-url 'https:\/\/nexus\.internal\/repository\/pypi\/simple'/);
  });

  test('the jdtls URL override reaches the command line', () => {
    const command = specFor('java').variants[0].install({
      jdtlsUrl: 'https://nexus.internal/jdt-language-server.tar.gz',
    });

    assert.match(command, /'https:\/\/nexus\.internal\/jdt-language-server\.tar\.gz'/);
    assert.match(command, /tar -xz -C/);
  });

  test('falls back to the public source when none is configured', () => {
    assert.match(specFor('typescript').variants[0].install({}), /registry\.npmjs\.org/);
  });
});

describe('installMarkerName', () => {
  test('changes when the recipe changes, so a new source reinstalls', () => {
    const variant = specFor('java').variants[0];
    const first = installMarkerName('java', variant, { jdtlsUrl: 'https://a/one.tar.gz' });
    const second = installMarkerName('java', variant, { jdtlsUrl: 'https://b/two.tar.gz' });

    assert.notEqual(first, second);
    assert.match(first, /\.installed-java-jdtls-/);
  });

  test('is stable for the same recipe', () => {
    const variant = specFor('python').variants[0];
    const config: CodeLspConfig = { pypiIndexUrl: 'https://pypi.org/simple' };

    assert.equal(
      installMarkerName('python', variant, config),
      installMarkerName('python', variant, config),
    );
  });
});

describe('shellQuote', () => {
  /**
   * The property that matters is what a real shell makes of the result, not what
   * the string looks like: a source URL comes from operator config and is
   * interpolated into a `sh -lc` command line. `printf %s` echoes the single
   * argument the shell parsed, so a round-trip proves the value survived whole
   * and started no second command.
   */
  const roundTrip = (value: string): string =>
    execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`]).toString('utf8');

  test('round-trips an ordinary URL', () => {
    const url = 'https://nexus.internal/repository/raw/jdt-language-server.tar.gz';
    assert.equal(roundTrip(url), url);
  });

  test('round-trips a value that tries to start a second command', () => {
    const nasty = "https://x/'; touch /tmp/lsp-pwned; echo '";
    assert.equal(roundTrip(nasty), nasty);
    assert.equal(existsSync('/tmp/lsp-pwned'), false);
  });

  test('round-trips spaces, quotes and non-ASCII', () => {
    for (const value of ['a b', `it's`, '$HOME', '`id`', 'path/file', 'a\nb']) {
      assert.equal(roundTrip(value), value);
    }
  });
});

describe('ensureServerInstalled', () => {
  test('reports the missing runtime instead of trying to install', async () => {
    const { exec, calls } = fakeExec([{ match: /command -v node/, exitCode: 127 }]);

    const outcome = await ensureServerInstalled('typescript', {}, exec);

    assert.match(outcome.reason ?? '', /no Node\.js/);
    assert.equal(outcome.variant, undefined);
    assert.equal(calls.filter((call) => call.includes('npm install')).length, 0);
  });

  test('skips the install when the marker is already there', async () => {
    const { exec, calls } = fakeExec([
      { match: /command -v node/, output: 'v22.0.0', exitCode: 0 },
      { match: /test -f/, exitCode: 0 },
    ]);

    const outcome = await ensureServerInstalled('typescript', {}, exec);

    assert.equal(outcome.variant?.id, 'typescript-language-server');
    assert.equal(
      calls.some((call) => call.includes('npm install')),
      false,
    );
  });

  test('installs and records the marker on success', async () => {
    const { exec, calls } = fakeExec([
      { match: /command -v node/, output: 'v22.0.0', exitCode: 0 },
      { match: /test -f/, exitCode: 1 },
      { match: /npm install/, exitCode: 0 },
    ]);

    const outcome = await ensureServerInstalled('typescript', {}, exec);

    assert.equal(outcome.variant?.id, 'typescript-language-server');
    assert.ok(calls.some((call) => call.startsWith('mkdir -p') && call.includes('touch')));
  });

  /** A half-finished install that is trusted would fail on every later launch. */
  test('does not record a marker for a failed install', async () => {
    const { exec, calls } = fakeExec([
      { match: /command -v node/, output: 'v22.0.0', exitCode: 0 },
      { match: /test -f/, exitCode: 1 },
      { match: /npm install/, output: 'npm ERR! ETIMEDOUT', exitCode: 1 },
    ]);

    const outcome = await ensureServerInstalled('typescript', {}, exec);

    assert.equal(outcome.variant, undefined);
    assert.match(outcome.reason ?? '', /ETIMEDOUT/);
    assert.equal(
      calls.some((call) => call.includes('touch')),
      false,
    );
  });

  test('falls back to the second variant when the first will not install', async () => {
    const { exec } = fakeExec([
      { match: /command -v python3/, output: 'Python 3.12.0', exitCode: 0 },
      { match: /test -f/, exitCode: 1 },
      { match: /basedpyright/, output: 'ERROR: No matching distribution', exitCode: 1 },
      { match: /jedi-language-server/, exitCode: 0 },
    ]);

    const outcome = await ensureServerInstalled('python', {}, exec);

    assert.equal(outcome.variant?.id, 'jedi-language-server');
  });

  /**
   * Two sessions opening the same stack would otherwise run `npm install -g`
   * against the same directory concurrently, which npm does not survive.
   */
  test('serialises concurrent installs of one language', async () => {
    let running = 0;
    let overlapped = false;
    const exec = async (command: string): Promise<ExecuteResponse> => {
      if (command.includes('npm install')) {
        running += 1;
        overlapped ||= running > 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
      }
      return {
        output: command.includes('command -v') ? 'v22.0.0' : '',
        exitCode: command.startsWith('test -f') ? 1 : 0,
        truncated: false,
      };
    };

    const [first, second] = await Promise.all([
      ensureServerInstalled('typescript', {}, exec),
      ensureServerInstalled('typescript', {}, exec),
    ]);

    assert.equal(overlapped, false);
    assert.equal(first.variant?.id, 'typescript-language-server');
    assert.equal(second.variant?.id, 'typescript-language-server');
  });

  /** A proxy that was down at breakfast must not disable the language all day. */
  test('a failure is not cached', async () => {
    let attempt = 0;
    const exec = (command: string): Promise<ExecuteResponse> => {
      if (command.includes('npm install')) {
        attempt += 1;
        return Promise.resolve({
          output: 'npm ERR!',
          exitCode: attempt === 1 ? 1 : 0,
          truncated: false,
        });
      }
      return Promise.resolve({
        output: 'v22.0.0',
        exitCode: command.startsWith('test -f') ? 1 : 0,
        truncated: false,
      });
    };

    assert.equal((await ensureServerInstalled('typescript', {}, exec)).variant, undefined);
    assert.equal(
      (await ensureServerInstalled('typescript', {}, exec)).variant?.id,
      'typescript-language-server',
    );
  });
});

describe('firstMeaningfulLine', () => {
  test('prefers the line that mentions a failure over the last one', () => {
    const output = [
      'Collecting basedpyright',
      'ERROR: Could not find a version that satisfies the requirement',
      'Cleaning up...',
    ].join('\n');

    assert.match(firstMeaningfulLine(output), /Could not find a version/);
  });

  test('falls back to the last line', () => {
    assert.equal(firstMeaningfulLine('one\ntwo\n\n'), 'two');
  });

  test('says something for empty output', () => {
    assert.equal(firstMeaningfulLine(''), 'no output');
  });
});
