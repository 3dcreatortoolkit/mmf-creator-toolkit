import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerialQueue } from '../src/serial-queue.js';

test('parallel worker completions serialize checkpoint writes and recover after an error', async () => {
  const queue = createSerialQueue();
  const events = [];
  let inProgress = 0;
  let maxConcurrent = 0;
  const task = (name, fail = false) => queue(async () => {
    events.push(`start:${name}`);
    maxConcurrent = Math.max(maxConcurrent, ++inProgress);
    await new Promise(resolve => setImmediate(resolve));
    inProgress--;
    events.push(`end:${name}`);
    if (fail) throw new Error('checkpoint failed');
  });
  const results = await Promise.allSettled([task('image'), task('file', true), task('retry')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(events, [
    'start:image', 'end:image', 'start:file', 'end:file', 'start:retry', 'end:retry',
  ]);
  assert.equal(maxConcurrent, 1);
});
