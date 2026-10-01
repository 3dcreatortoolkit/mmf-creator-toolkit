import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeedMeter, formatBytes, formatDuration, phaseMetrics } from '../src/download-metrics.js';

test('byte and duration labels use readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(formatDuration(75), '1m 15s');
});

test('file ETA uses API sizes, completed bytes, current transfer, and measured speed', () => {
  const tasks = [
    { id: 'a', kind: 'file', sizeBytes: 1_000, downloadedBytes: 1_000, done: true },
    { id: 'b', kind: 'file', sizeBytes: 2_000, done: false },
    { id: 'c', kind: 'file', sizeBytes: 3_000, done: false },
  ];
  assert.deepEqual(phaseMetrics(tasks, 'file', { taskId: 'b', bytes: 500, speed: 500 }), {
    downloaded: 1_500, totalBytes: 6_000, unknownSizes: 0, speed: 500, etaSeconds: 9,
    completed: 1, total: 3,
  });
  tasks[2].sizeBytes = null;
  assert.equal(phaseMetrics(tasks, 'file', { taskId: 'b', bytes: 500, speed: 500 }).etaSeconds, null);
  assert.equal(phaseMetrics(tasks, 'file').unknownSizes, 1);
});

test('image ETA is approximate from completed images, not invented API sizes', () => {
  const tasks = [
    { id: 'a', kind: 'image', downloadedBytes: 1000, done: true },
    { id: 'b', kind: 'image', done: false },
    { id: 'c', kind: 'image', done: false },
  ];
  const progress = phaseMetrics(tasks, 'image', { taskId: 'b', bytes: 200, speed: 400 });
  assert.equal(progress.downloaded, 1200);
  assert.equal(progress.totalBytes, null);
  assert.equal(progress.etaSeconds, 4.5);
  assert.equal(phaseMetrics(tasks, 'image').etaSeconds, null);
});

test('speed uses recent transferred bytes and waits for a meaningful interval', () => {
  let time = 0;
  const meter = createSpeedMeter(() => time);
  meter.add(1024);
  assert.equal(meter.speed(), null);
  time = 1000;
  meter.add(1024);
  assert.equal(meter.speed(), 2048);
});
