import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  detectPackageManager,
  detectToolchain,
  FALLBACK_IMAGE,
  installFingerprint,
  nearestMajor,
  parseGoVersion,
  parseGradleJava,
  parseGradleWrapperVersion,
  parseMajor,
  parseMavenJava,
  parsePythonMinor,
} from './toolchain';

/** Creates a throw-away directory holding `files` (relative path → content). */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-toolchain-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('parseMajor understands the usual version notations', () => {
  assert.equal(parseMajor('20'), 20);
  assert.equal(parseMajor('v20.11.1'), 20);
  assert.equal(parseMajor('>=18.0.0'), 18);
  assert.equal(parseMajor('^22.1'), 22);
  assert.equal(parseMajor('lts/iron'), null);
  assert.equal(parseMajor(undefined), null);
});

test('nearestMajor picks the lowest supported version that is new enough', () => {
  assert.equal(nearestMajor(19, [18, 20, 22, 24]), 20);
  assert.equal(nearestMajor(22, [18, 20, 22, 24]), 22);
  assert.equal(nearestMajor(99, [18, 20, 22]), 22);
});

test('parseGradleJava reads every common JDK declaration', () => {
  assert.equal(parseGradleJava('java { jvmToolchain(21) }'), 21);
  assert.equal(parseGradleJava('languageVersion.set(JavaLanguageVersion.of(17))'), 17);
  assert.equal(parseGradleJava('sourceCompatibility = JavaVersion.VERSION_11'), 11);
  assert.equal(parseGradleJava("sourceCompatibility = '1.8'"), 8);
  assert.equal(parseGradleJava('plugins { id "java" }'), null);
});

test('parseGradleWrapperVersion reads the pinned distribution', () => {
  const properties =
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.2-bin.zip\n';
  assert.equal(parseGradleWrapperVersion(properties), '8.14.2');
  assert.equal(parseGradleWrapperVersion('distributionUrl=nonsense'), null);
});

test('parseMavenJava reads the compiler properties', () => {
  assert.equal(parseMavenJava('<properties><java.version>17</java.version></properties>'), 17);
  assert.equal(parseMavenJava('<maven.compiler.release>21</maven.compiler.release>'), 21);
  assert.equal(parseMavenJava('<maven.compiler.source>1.8</maven.compiler.source>'), 8);
});

test('parsePythonMinor and parseGoVersion read their pins', () => {
  assert.equal(parsePythonMinor('>=3.11'), 11);
  assert.equal(parsePythonMinor('2.7'), null);
  assert.equal(parseGoVersion('module x\n\ngo 1.23.4\n'), '1.23');
  assert.equal(parseGoVersion('module x\n'), null);
});

test('detectPackageManager prefers the lock file', () => {
  assert.equal(detectPackageManager(fixture({ 'pnpm-lock.yaml': '' })), 'pnpm');
  assert.equal(detectPackageManager(fixture({ 'yarn.lock': '' })), 'yarn');
  assert.equal(detectPackageManager(fixture({ 'package-lock.json': '{}' })), 'npm');
  assert.equal(
    detectPackageManager(fixture({ 'package.json': '{"packageManager":"pnpm@9.0.0"}' })),
    'pnpm',
  );
});

test('detectToolchain maps a Node repo to its .nvmrc major and scripts', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }),
    'package-lock.json': '{}',
    '.nvmrc': '20\n',
  });
  const detected = detectToolchain(dir);
  assert.equal(detected.toolchain, 'node');
  assert.equal(detected.image, 'node:20-bookworm');
  assert.equal(detected.commands.test, 'npm test');
  assert.equal(detected.commands.build, 'npm run build');
  assert.equal(detected.commands.install, 'npm ci');
});

test('detectToolchain prefers the JVM stack over a bundled frontend', () => {
  const dir = fixture({
    'package.json': '{}',
    'build.gradle.kts': 'java { jvmToolchain(17) }',
    gradlew: '#!/bin/sh\n',
    'gradle/wrapper/gradle-wrapper.properties':
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n',
  });
  const detected = detectToolchain(dir);
  assert.equal(detected.toolchain, 'gradle');
  assert.equal(detected.image, 'gradle:8.10-jdk17');
  assert.equal(detected.commands.test, './gradlew test');
});

test('detectToolchain maps Maven, Python and Go repos', () => {
  assert.equal(
    detectToolchain(fixture({ 'pom.xml': '<java.version>21</java.version>' })).image,
    'maven:3.9-eclipse-temurin-21',
  );
  assert.equal(
    detectToolchain(fixture({ 'pyproject.toml': 'requires-python = ">=3.11"' })).image,
    'python:3.11-bookworm',
  );
  assert.equal(detectToolchain(fixture({ 'go.mod': 'go 1.22\n' })).image, 'golang:1.22-bookworm');
});

test('detectToolchain falls back when nothing is recognised', () => {
  const detected = detectToolchain(fixture({ 'README.md': 'hello' }));
  assert.equal(detected.toolchain, 'unknown');
  assert.equal(detected.image, FALLBACK_IMAGE);
  assert.deepEqual(detected.commands, {});
});

/**
 * `npm ci` refuses to run without a lock file, and npm is what
 * `detectPackageManager` falls back to — so a repository that ships none used to
 * get an install command guaranteed to fail.
 */
test('the Node install command is strict only when the lock file is there', () => {
  assert.equal(
    detectToolchain(fixture({ 'package.json': '{}', 'package-lock.json': '{}' })).commands.install,
    'npm ci',
  );
  assert.equal(detectToolchain(fixture({ 'package.json': '{}' })).commands.install, 'npm install');
  assert.equal(
    detectToolchain(fixture({ 'package.json': '{}', 'pnpm-lock.yaml': '' })).commands.install,
    'pnpm install --frozen-lockfile',
  );
  assert.equal(
    detectToolchain(fixture({ 'package.json': '{"packageManager":"yarn@4.0.0"}' })).commands
      .install,
    'yarn install',
  );
});

test('every other stack knows how to fetch its dependencies too', () => {
  assert.equal(
    detectToolchain(fixture({ 'build.gradle': '', gradlew: '#!/bin/sh\n' })).commands.install,
    './gradlew --no-daemon dependencies',
  );
  assert.equal(
    detectToolchain(fixture({ 'pom.xml': '<project/>' })).commands.install,
    'mvn -B -q dependency:go-offline',
  );
  assert.equal(
    detectToolchain(fixture({ 'go.mod': 'go 1.22\n' })).commands.install,
    'go mod download',
  );
  assert.equal(
    detectToolchain(fixture({ 'pyproject.toml': '', 'uv.lock': '' })).commands.install,
    'uv sync',
  );
  assert.equal(
    detectToolchain(fixture({ 'requirements.txt': 'flask\n' })).commands.install,
    'pip install -r requirements.txt',
  );
});

test('installFingerprint changes with the lock files and nothing else', () => {
  const before = installFingerprint(
    fixture({ 'package.json': '{}', 'package-lock.json': '{"v":1}' }),
  );
  const same = installFingerprint(
    fixture({ 'package.json': '{}', 'package-lock.json': '{"v":1}' }),
  );
  const moved = installFingerprint(
    fixture({ 'package.json': '{}', 'package-lock.json': '{"v":2}' }),
  );
  const sourceEdit = installFingerprint(
    fixture({ 'package.json': '{}', 'package-lock.json': '{"v":1}', 'src/app.ts': 'edited' }),
  );

  assert.equal(before, same, 'two identical checkouts share a fingerprint');
  assert.notEqual(before, moved, 'a changed lock file must force a re-install');
  assert.equal(before, sourceEdit, 'editing sources must not');
  assert.equal(
    installFingerprint(fixture({ 'README.md': '' })),
    '',
    'no manifests, no fingerprint',
  );
});
