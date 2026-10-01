import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetHttpError, RATE_LIMIT_DELAY_MS, createRateLimitGate, isRetryableAssetError, parseRetryAfter, retryAsset } from '../src/download-retry.js';
import { runConcurrentWorkers } from '../src/download-workers.js';

test('a file failure is reported instead of the sibling image worker AbortError', async () => {
  const controller = new AbortController();
  const reason = new Error('File returned HTTP 403');
  await assert.rejects(() => runConcurrentWorkers(['image', 'file'], async kind => {
    if (kind === 'file') throw reason;
    await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    throw new DOMException('Download paused.', 'AbortError');
  }, controller), error => error === reason);
  assert.equal(controller.signal.aborted, true);
});

test('temporary transfer failures retry with a delay and keep the job running', async () => {
  let calls = 0;
  const delays = [];
  const attempts = [];
  await retryAsset(async () => {
    if (++calls < 3) throw new Error('Could not transfer asset: HTTP 503; Failed to fetch');
  }, {
    signal: new AbortController().signal,
    onRetry: attempt => attempts.push(attempt),
    wait: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(attempts, [2, 3]);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test('auth failures and forbidden links do not retry', async () => {
  assert.equal(isRetryableAssetError(new Error('HTTP 429')), true);
  assert.equal(isRetryableAssetError(new Error('Timed out waiting for redirect')), true);
  assert.equal(isRetryableAssetError(new Error('HTTP 403')), false);
  assert.equal(isRetryableAssetError(new Error('You must be logged in')), false);
  let calls = 0;
  await assert.rejects(() => retryAsset(async () => {
    calls++;
    throw new Error('Asset returned HTTP 403');
  }, { signal: new AbortController().signal, wait: async () => { throw new Error('should not wait'); } }), /403/);
  assert.equal(calls, 1);
});

test('manual pause interrupts a pending retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => retryAsset(async () => {
    calls++;
    throw new Error('Failed to fetch');
  }, {
    signal: controller.signal,
    onRetry: () => { controller.abort(); },
  }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('Retry-After accepts seconds and HTTP dates with bounded delays', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  assert.equal(parseRetryAfter('2', now), 2_000);
  assert.equal(parseRetryAfter(new Date(now + 45_000).toUTCString(), now), 45_000);
  assert.equal(parseRetryAfter('0', now), 1_000);
  assert.equal(parseRetryAfter('not-a-date', now), null);
  assert.equal(parseRetryAfter('99999', now), 600_000);
});

test('HTTP 429 uses a fixed five-second wait regardless of Retry-After', async () => {
  let time = 0;
  const delays = [];
  const gate = createRateLimitGate(() => time, async duration => {
    delays.push(duration);
    time += duration;
  });
  let calls = 0;
  await retryAsset(async () => {
    if (++calls < 3) throw new AssetHttpError(429, 'HTTP 429', 60_000);
  }, { signal: new AbortController().signal, gate, wait: async () => { throw new Error('ordinary retry wait'); } });
  assert.equal(calls, 3);
  assert.equal(RATE_LIMIT_DELAY_MS, 5_000);
  assert.deepEqual(delays, [5_000, 5_000]);
});

test('HTTP 429 without Retry-After still waits five seconds and retries', async () => {
  let time = 0;
  const gate = createRateLimitGate(() => time, async delay => { time += delay; });
  let calls = 0;
  await retryAsset(async () => {
    if (++calls === 1) throw new AssetHttpError(429, 'HTTP 429');
  }, { signal: new AbortController().signal, gate });
  assert.equal(time, 5_000);
  assert.equal(calls, 2);
});

test('repeated 429s continue past the former eight-attempt limit until success', async () => {
  let time = 0;
  const gate = createRateLimitGate(() => time, async delay => { time += delay; });
  let calls = 0;
  await retryAsset(async () => {
    if (++calls <= 10) throw new AssetHttpError(429, 'HTTP 429');
  }, { signal: new AbortController().signal, gate });
  assert.equal(calls, 11);
  assert.equal(time, 50_000);
});

test('shared rate-limit gate holds another worker before its next request', async () => {
  let time = 0;
  const delays = [];
  const gate = createRateLimitGate(() => time, async duration => {
    delays.push(duration);
    time += duration;
  });
  gate.defer(30_000);
  let startedAt;
  await retryAsset(async () => { startedAt = time; }, { signal: new AbortController().signal, gate });
  assert.equal(startedAt, 30_000);
  assert.deepEqual(delays, [30_000]);
});
