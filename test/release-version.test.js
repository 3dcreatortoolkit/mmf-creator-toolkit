import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextReleaseVersion } from '../scripts/prepare-release.js';

test('workflow run number produces a distinct patch version per push', () => {
  assert.equal(nextReleaseVersion('0.0.1', 1), '0.0.1');
  assert.equal(nextReleaseVersion('0.0.1', 2), '0.0.2');
  assert.equal(nextReleaseVersion('1.0.0', 10), '1.0.9');
});

test('release version rejects missing runs and invalid manifest versions', () => {
  assert.throws(() => nextReleaseVersion('0.8.9', undefined), /positive GITHUB_RUN_NUMBER/);
  assert.throws(() => nextReleaseVersion('0.8.9', 0), /positive GITHUB_RUN_NUMBER/);
  assert.throws(() => nextReleaseVersion('0.8.9-beta', 1), /three-part base version/);
  assert.throws(() => nextReleaseVersion('0.8.65535', 2), /manifest limit/);
});
