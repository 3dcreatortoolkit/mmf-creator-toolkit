import { trustedUrl } from './download-core.js';
import { AssetHttpError } from './download-retry.js';

export function resolveFileRedirect(tabId, url, signal, chromeApi = chrome) {
  if (signal.aborted) return Promise.reject(new DOMException('Download paused.', 'AbortError'));
  const source = trustedUrl(url).href;
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for MyMiniFactory to authorize the file link.')), 20_000);
    function finish(error, target) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      chromeApi.runtime.onMessage.removeListener(onRedirect);
      if (error) reject(error);
      else resolve(target);
    }
    function onAbort() { finish(new DOMException('Download paused.', 'AbortError')); }
    function onRedirect(message) {
      if (message?.kind !== 'MMF_ASSET_REDIRECT' || message.tabId !== tabId || message.from !== source) return;
      try { finish(null, trustedUrl(message.to).href); }
      catch (error) { finish(error); }
    }
    chromeApi.runtime.onMessage.addListener(onRedirect);
    signal.addEventListener('abort', onAbort, { once: true });
    chromeApi.tabs.sendMessage(tabId, { kind: 'MMF_RESOLVE_FILE', url: source })
      .then(response => { if (response?.error) finish(response.status === 429
        ? new AssetHttpError(429, response.error, response.retryAfterMs)
        : new Error(response.error)); })
      .catch(error => finish(error));
  });
}
