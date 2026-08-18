import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  applyTlsPolicy,
  insecureChildEnv,
  resetTlsPolicyForTests,
  SSL_VERIFY_VAR,
  sslVerifyFromEnv,
  tlsVerificationDisabled,
} from './tls';

const NODE_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED';

/** A throwaway environment, so no test can change what this process trusts. */
const env = (values: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...values });

afterEach(() => {
  resetTlsPolicyForTests();
});

describe('sslVerifyFromEnv', () => {
  test('an unset variable is not an answer', () => {
    assert.equal(sslVerifyFromEnv(env()), undefined);
    assert.equal(sslVerifyFromEnv(env({ [SSL_VERIFY_VAR]: '  ' })), undefined);
  });

  test('the spellings people actually use all read as off', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', ' False ']) {
      assert.equal(sslVerifyFromEnv(env({ [SSL_VERIFY_VAR]: value })), false, value);
    }
  });

  test('anything else leaves verification on', () => {
    assert.equal(sslVerifyFromEnv(env({ [SSL_VERIFY_VAR]: 'true' })), true);
    assert.equal(sslVerifyFromEnv(env({ [SSL_VERIFY_VAR]: '1' })), true);
  });
});

describe('applyTlsPolicy', () => {
  test('a bundle that says nothing leaves the process as it was', () => {
    const scope = env();

    assert.equal(applyTlsPolicy(undefined, scope), true);
    assert.equal(scope[NODE_VAR], undefined);
    assert.equal(tlsVerificationDisabled(), false);
  });

  test('the deployment can turn verification off', () => {
    const scope = env();

    assert.equal(applyTlsPolicy(false, scope), false);
    assert.equal(scope[NODE_VAR], '0');
    assert.equal(tlsVerificationDisabled(), true);
  });

  test('so can the machine, with no bundle involved', () => {
    const scope = env({ [SSL_VERIFY_VAR]: 'false' });

    assert.equal(applyTlsPolicy(undefined, scope), false);
    assert.equal(scope[NODE_VAR], '0');
  });

  test('neither side can force verification back on for the other', () => {
    // The user started the daemon insecurely on purpose; a deployment that
    // verifies must not silently undo that, and vice versa.
    assert.equal(applyTlsPolicy(true, env({ [SSL_VERIFY_VAR]: 'false' })), false);
    assert.equal(applyTlsPolicy(false, env({ [SSL_VERIFY_VAR]: 'true' })), false);
  });

  test('a withdrawn setting restores verification at the next handshake', () => {
    const scope = env();
    applyTlsPolicy(false, scope);

    assert.equal(applyTlsPolicy(undefined, scope), true);
    assert.equal(scope[NODE_VAR], undefined);
    assert.equal(tlsVerificationDisabled(), false);
  });

  test('a variable this module did not set is left alone', () => {
    // Started by hand with Node's own switch: not ours to clear, and clearing it
    // would make a working setup fail on the first secure handshake.
    const scope = env({ [NODE_VAR]: '0' });

    assert.equal(applyTlsPolicy(undefined, scope), true);
    assert.equal(scope[NODE_VAR], '0');
  });
});

describe('insecureChildEnv', () => {
  test('is empty while certificates are verified', () => {
    applyTlsPolicy(undefined, env());

    assert.deepEqual(insecureChildEnv(), {});
  });

  test('carries the decision to Node, git and npm alike', () => {
    applyTlsPolicy(false, env());

    assert.deepEqual(insecureChildEnv(), {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      GIT_SSL_NO_VERIFY: '1',
      NPM_CONFIG_STRICT_SSL: 'false',
    });
  });

  test('hands out a copy, so a caller cannot edit the policy', () => {
    applyTlsPolicy(false, env());

    const first = insecureChildEnv();
    first.GIT_SSL_NO_VERIFY = 'tampered';

    assert.equal(insecureChildEnv().GIT_SSL_NO_VERIFY, '1');
  });
});
