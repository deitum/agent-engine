import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  engineHome,
  checkoutConfigArgs,
  checkoutGitConfig,
  hostShellPromptSection,
  sandboxEnv,
  toDockerMountPath,
} from './platform';

/**
 * These are the branches that decide whether the daemon works on a Windows box,
 * and nobody on this team runs one. Every function under test therefore takes
 * the platform as an argument — the tests below are the only place the `win32`
 * paths are exercised at all, so they are written to fail loudly rather than to
 * describe whatever the code happens to do.
 */

describe('toDockerMountPath', () => {
  test('normalises separators on Windows, so the `-v src:dst` split stays unambiguous', () => {
    assert.equal(
      toDockerMountPath('C:\\Users\\dev\\.agent-engine\\code\\s1\\repo', 'win32'),
      'C:/Users/dev/.agent-engine/code/s1/repo',
    );
  });

  test('leaves a POSIX path exactly as it is', () => {
    const path = '/Users/dev/.agent-engine/code/s1/repo';
    assert.equal(toDockerMountPath(path, 'darwin'), path);
    assert.equal(toDockerMountPath(path, 'linux'), path);
  });
});

describe('sandboxEnv', () => {
  test('passes the toolchain through and leaves secrets behind', () => {
    const env = sandboxEnv(
      {
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: '/Users/dev',
        NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
        AWS_SECRET_ACCESS_KEY: 'must stay outside',
        AGENT_ENGINE_TOKEN: 'as well',
      },
      'darwin',
    );

    assert.deepEqual(env, {
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/dev',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
    });
  });

  test('carries what cmd.exe needs on Windows', () => {
    const env = sandboxEnv(
      {
        PATH: 'C:\\Windows\\system32',
        PATHEXT: '.COM;.EXE;.BAT',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
        USERPROFILE: 'C:\\Users\\dev',
        HTTPS_PROXY: 'http://proxy:3128',
        AWS_SECRET_ACCESS_KEY: 'must stay outside',
      },
      'win32',
    );

    // Without SystemRoot a Windows child fails at winsock initialisation, long
    // before it runs any code of its own — this is the whole reason the list
    // is platform-specific.
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT');
    assert.equal(env.TEMP, 'C:\\Users\\dev\\AppData\\Local\\Temp');
    assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  });

  test('does not smuggle POSIX names into a Windows shell, or the reverse', () => {
    const source = { HOME: '/Users/dev', SHELL: '/bin/zsh', SystemRoot: 'C:\\Windows' };
    assert.equal(sandboxEnv(source, 'win32').HOME, undefined);
    assert.equal(sandboxEnv(source, 'win32').SHELL, undefined);
    assert.equal(sandboxEnv(source, 'darwin').SystemRoot, undefined);
  });

  test('omits a key the daemon does not have, rather than passing undefined', () => {
    assert.deepEqual(sandboxEnv({}, 'darwin'), {});
  });
});

describe('checkoutGitConfig', () => {
  test('forces LF everywhere — the container half of the workspace is Linux', () => {
    for (const platformName of ['darwin', 'linux', 'win32'] as const) {
      assert.equal(checkoutGitConfig(platformName)['core.autocrlf'], 'false');
      assert.equal(checkoutGitConfig(platformName)['core.eol'], 'lf');
    }
  });

  test('adds core.longpaths only on Windows, where MAX_PATH is real', () => {
    assert.equal(checkoutGitConfig('win32')['core.longpaths'], 'true');
    assert.equal(checkoutGitConfig('darwin')['core.longpaths'], undefined);
  });

  test('never forces core.symlinks, which would break a checkout without Developer Mode', () => {
    assert.equal(checkoutGitConfig('win32')['core.symlinks'], undefined);
  });

  test('renders as `-c key=value` pairs for a git command line', () => {
    const args = checkoutConfigArgs('darwin');
    assert.deepEqual(args, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);
  });
});

describe('hostShellPromptSection', () => {
  test('warns the agent about cmd.exe on Windows', () => {
    const section = hostShellPromptSection('win32');
    assert.match(section, /cmd\.exe/);
    assert.match(section, /findstr/);
  });

  test('says nothing at all on macOS and Linux', () => {
    assert.equal(hostShellPromptSection('darwin'), '');
    assert.equal(hostShellPromptSection('linux'), '');
  });
});

/**
 * `engineHome` takes the home directory as an argument, so these hand it one
 * rather than asserting against whatever the machine running the suite has.
 *
 * Passing it beats pointing `HOME` at a temp directory: `homedir()` reads `HOME`
 * only on POSIX — on Windows it reads `USERPROFILE` and ignores `HOME` entirely,
 * so an env-based fixture silently asserts against the real profile there.
 */
describe('engineHome', () => {
  const posixHome = '/home/agent';
  const windowsHome = 'C:\\Users\\agent';

  test('defaults to ~/.agent-engine', () => {
    assert.equal(engineHome({}, posixHome, 'linux'), '/home/agent/.agent-engine');
    assert.equal(engineHome({}, windowsHome, 'win32'), 'C:\\Users\\agent\\.agent-engine');
  });

  test('honours the override, the escape hatch for a non-ASCII Windows profile', () => {
    assert.equal(
      engineHome({ AGENT_ENGINE_HOME: 'D:\\engine' }, windowsHome, 'win32'),
      'D:\\engine',
    );
  });

  test('an empty or blank override is not an override', () => {
    assert.equal(
      engineHome({ AGENT_ENGINE_HOME: '   ' }, posixHome, 'linux'),
      '/home/agent/.agent-engine',
    );
  });
});
