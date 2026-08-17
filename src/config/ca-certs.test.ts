import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { trustDeploymentCerts, trustSystemCerts } from './ca-certs';

/** Whether this Node can be told what to trust (the APIs arrived in 22.15). */
const SUPPORTED =
  typeof setDefaultCACertificates === 'function' && typeof getCACertificates === 'function';

/** A real certificate to hand over as the deployment's — Node accepts no other. */
const REAL_CERT = SUPPORTED ? (getCACertificates('bundled')[0] ?? '') : '';
const JUNK_CERT = '-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----';

const pristine = SUPPORTED ? getCACertificates('default') : [];

/** A certificate as a comparable value: Node re-wraps the PEM it gives back. */
const norm = (pem: string): string => pem.replace(/\s+/g, '');

/**
 * What the process trusts, as a comparable set. Setting the store re-serializes
 * it and hands it back in another order, so neither the strings nor their
 * positions survive a round trip — only the certificates themselves do.
 */
const trusted = (): string[] => getCACertificates('default').map(norm).sort();

after(() => {
  // This module changes the trust store of the whole process; put it back.
  if (SUPPORTED) {
    setDefaultCACertificates(pristine);
  }
});

describe('trustDeploymentCerts', () => {
  test('takes the deployment certificates and reports how many', { skip: !SUPPORTED }, () => {
    assert.equal(trustDeploymentCerts([REAL_CERT]), 1);
    assert.ok(trusted().includes(norm(REAL_CERT)));
  });

  test('blanks are dropped rather than handed to Node', { skip: !SUPPORTED }, () => {
    assert.equal(trustDeploymentCerts(['   ', '']), 0);
  });

  test('a malformed certificate leaves the store as it was', { skip: !SUPPORTED }, () => {
    trustDeploymentCerts([REAL_CERT]);
    const before = trusted();

    // Node refuses the whole list over one bad entry, and this runs on every
    // handshake — so it must degrade, not take the daemon's TLS with it.
    assert.equal(trustDeploymentCerts([JUNK_CERT]), 0);
    assert.deepEqual(trusted(), before);
  });

  test('what the deployment stops publishing stops being trusted', { skip: !SUPPORTED }, () => {
    trustDeploymentCerts([REAL_CERT]);

    trustDeploymentCerts([]);

    // Merged onto the store as it was at startup, never onto the current one —
    // otherwise a withdrawn certificate would linger until the daemon restarts.
    assert.deepEqual(trusted(), pristine.map(norm).sort());
  });

  test('the machine store and the deployment both stay in force', { skip: !SUPPORTED }, () => {
    trustSystemCerts();
    const withSystem = trusted();

    trustDeploymentCerts([REAL_CERT]);

    const now = trusted();
    for (const cert of withSystem) {
      assert.ok(now.includes(cert));
    }
    assert.ok(now.includes(norm(REAL_CERT)));
  });

  test('an old Node is told once and keeps working', { skip: SUPPORTED }, () => {
    assert.equal(trustDeploymentCerts([REAL_CERT || JUNK_CERT]), 0);
  });
});
