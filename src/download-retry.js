export class AssetHttpError extends Error {
  constructor(status, message, retryAfterMs = null) {
    super(message);
    this.name = 'AssetHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(Math.max(1_000, delay), 600_000) : null;
}

export function isRateLimitError(error) {
  return error?.status === 429 || /\bHTTP 429\b/.test(error?.message ?? '');
}

export const RATE_LIMIT_DELAY_MS = 5_000;

export function isRetryableAssetError(error) {
  const message = error?.message ?? '';
  return /\bHTTP (?:429|50[0-4])\b|Failed to fetch|NetworkError|network (?:changed|connection)|timed out|TimeoutError/i.test(message);
}

export function createRateLimitGate(now = () => Date.now(), wait = waitBeforeRetry) {
  let until = 0;
  return {
    defer(milliseconds) { until = Math.max(until, now() + milliseconds); },
    async wait(signal) {
      while (until > now()) await wait(until - now(), signal);
    },
  };
}

function waitBeforeRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Download paused.', 'AbortError')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Download paused.', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryAsset(transfer, {
  signal, onRetry = () => {}, attempts = 4, rateLimitAttempts = Infinity,
  wait = waitBeforeRetry, gate = createRateLimitGate(),
} = {}) {
  let ordinaryFailures = 0;
  let rateLimitFailures = 0;
  while (true) {
    await gate.wait(signal);
    try { return await transfer(); }
    catch (error) {
      if (signal.aborted || error.name === 'AbortError' || !isRetryableAssetError(error)) throw error;
      const limited = isRateLimitError(error);
      if (limited ? ++rateLimitFailures >= rateLimitAttempts : ++ordinaryFailures >= attempts) throw error;
      const delay = limited ? RATE_LIMIT_DELAY_MS : 1_000 * 2 ** (ordinaryFailures - 1);
      if (limited) gate.defer(delay);
      await onRetry(limited ? rateLimitFailures + 1 : ordinaryFailures + 1,
        limited ? rateLimitAttempts : attempts, error);
      if (limited) await gate.wait(signal);
      else await wait(delay, signal);
    }
  }
}
