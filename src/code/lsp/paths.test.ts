import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeUri, fromContainerUri, toContainerUri, toHostPath, toRelativePath } from './paths';

describe('toRelativePath', () => {
  /** The three spellings the model produces in practice. */
  test('accepts the virtual, bare and container-absolute forms alike', () => {
    assert.equal(toRelativePath('/src/OrderService.java'), 'src/OrderService.java');
    assert.equal(toRelativePath('src/OrderService.java'), 'src/OrderService.java');
    assert.equal(toRelativePath('/workspace/src/OrderService.java'), 'src/OrderService.java');
  });

  test('collapses the redundant bits of a path', () => {
    assert.equal(toRelativePath('./src/./a.ts'), 'src/a.ts');
    assert.equal(toRelativePath('src/lib/../a.ts'), 'src/a.ts');
    assert.equal(toRelativePath('  /src/a.ts  '), 'src/a.ts');
  });

  /** A path that climbs out of the checkout must never reach the filesystem. */
  test('refuses to escape the checkout', () => {
    assert.equal(toRelativePath('../../../etc/passwd'), null);
    assert.equal(toRelativePath('/workspace/../etc/passwd'), null);
    assert.equal(toRelativePath('src/../../secrets'), null);
  });

  test('refuses the root itself and the empty string', () => {
    assert.equal(toRelativePath('/workspace'), null);
    assert.equal(toRelativePath(''), null);
    assert.equal(toRelativePath('   '), null);
  });
});

describe('toContainerUri', () => {
  test('builds the URI the server knows a file by', () => {
    assert.equal(toContainerUri('src/index.ts'), 'file:///workspace/src/index.ts');
  });

  test('percent-encodes what a bare path could not carry', () => {
    assert.equal(toContainerUri('src/my file.ts'), 'file:///workspace/src/my%20file.ts');
    assert.match(toContainerUri('src/naïve.py'), /^file:\/\/\/workspace\/src\/na%C3%AF/);
  });

  test('leaves the separators alone', () => {
    assert.equal(toContainerUri('a/b/c.java'), 'file:///workspace/a/b/c.java');
  });
});

describe('fromContainerUri', () => {
  test('round-trips every path we produce', () => {
    for (const relative of ['src/index.ts', 'src/my file.ts', 'src/naïve.py', 'a/b/c.java']) {
      assert.equal(fromContainerUri(toContainerUri(relative)), relative);
    }
  });

  /**
   * A «go to definition» on a JDK method legitimately lands outside the
   * checkout. Rewriting those into project paths would be a lie.
   */
  test('returns null for anything outside the workspace', () => {
    assert.equal(fromContainerUri('file:///usr/lib/python3.12/typing.py'), null);
    assert.equal(fromContainerUri('jdt://contents/java.base/java.util/List.class'), null);
    assert.equal(fromContainerUri('file:///workspaces/other/a.ts'), null);
  });

  test('survives a URI it cannot decode', () => {
    assert.equal(fromContainerUri('file:///workspace/%E0%A4%A'), null);
  });
});

describe('describeUri', () => {
  test('labels a project file by its relative path', () => {
    assert.equal(describeUri('file:///workspace/src/a.ts'), 'src/a.ts');
  });

  test('keeps an external location readable', () => {
    assert.equal(
      describeUri('file:///usr/lib/python3.12/typing.py'),
      '/usr/lib/python3.12/typing.py',
    );
  });
});

describe('toHostPath', () => {
  test('joins onto the checkout root', () => {
    assert.equal(toHostPath('/home/u/repo', 'src/a.ts'), '/home/u/repo/src/a.ts');
  });
});
