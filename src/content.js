import { Exporter, SIGN_IN_MESSAGE } from './exporter.js';
import { createCsv } from './csv.js';
import { progressPercent } from './progress.js';
import { trustedUrl } from './download-core.js';
import { AssetHttpError, parseRetryAfter } from './download-retry.js';

let running = false;
let lastProgress = { stage: 'auth', completed: 0, total: 1 };
let includeFiles = false;
let creatorUsername;

function status(state) {
  chrome.runtime.sendMessage({ kind: 'MMF_EXPORT_STATUS', state: { ...state,
    percent: progressPercent(state),
    includeFiles,
    creatorUsername,
  } }).catch(() => {});
}

function download(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.kind === 'MMF_RESOLVE_FILE') {
    (async () => {
      const url = trustedUrl(message.url);
      if (url.hostname !== 'www.myminifactory.com') throw new Error('File link must originate from MyMiniFactory.');
      const response = await fetch(url.href, { credentials: 'include', redirect: 'manual' });
      if (response.status === 429) {
        throw new AssetHttpError(429, 'MyMiniFactory limited file downloads (HTTP 429).',
          parseRetryAfter(response.headers.get('retry-after')));
      }
      if (response.type !== 'opaqueredirect' && response.status !== 302 && response.status !== 303) {
        throw new Error(`MyMiniFactory did not provide a file download redirect (HTTP ${response.status}).`);
      }
      return { started: true };
    })().then(respond).catch(error => respond({
      error: error.message, status: error.status, retryAfterMs: error.retryAfterMs,
    }));
    return true;
  }
  if (message?.kind === 'MMF_AUTH_CHECK') {
    new Exporter().checkSession().then(me => respond({
      authenticated: true,
      username: me.username,
      avatarUrl: me.avatarUrl,
    }))
      .catch(error => respond({ authenticated: false,
        message: error instanceof Error ? error.message : String(error),
        signedOut: error?.message === SIGN_IN_MESSAGE,
        status: error?.status,
        retryAfterMs: error?.retryAfterMs,
      }));
    return true;
  }
  if (message?.kind !== 'MMF_EXPORT_START') return;
  if (running) { respond({ error: 'An export is already running in this tab.' }); return; }
  running = true;
  includeFiles = message.includeFiles === true;
  creatorUsername = undefined;
  respond({ started: true });
  lastProgress = { stage: 'auth', completed: 0, total: 1 };
  const exporter = new Exporter({ report: progress => {
    lastProgress = progress;
    if (progress.creatorUsername) creatorUsername = progress.creatorUsername;
    status({ ...progress, running: true, outcome: 'running' });
  } });
  exporter.export({ includeFiles }).then(result => {
    const filename = `myminifactory-${result.creatorUsername.replace(/[^a-z0-9_-]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.csv`;
    download(filename, createCsv(result.rows, { includeFiles }));
    status({ stage: 'download', completed: 1, total: 1, running: false, outcome: 'complete',
      detail: `Downloaded ${result.rows.length} public object listings across ${result.collectionCount} collections.` +
        (result.outsideStoreCount ? ` ${result.outsideStoreCount} non-public or unlisted objects were excluded.` : ''),
    });
  }).catch(error => {
    const signedOut = error?.message === SIGN_IN_MESSAGE;
    status({ ...(signedOut ? { stage: 'auth', completed: 0, total: 1 } : lastProgress),
      running: false, outcome: 'error',
      detail: signedOut ? SIGN_IN_MESSAGE : error instanceof Error ? error.message : String(error),
      signedOut,
    });
  }).finally(() => { running = false; });
});

// Streams one asset through the signed-in site tab. ACKs bound memory usage to one chunk.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'MMF_ASSET_TRANSFER') return;
  const controller = new AbortController();
  let reader;
  let started = false;
  async function next() {
    try {
      const { done, value } = await reader.read();
      if (done) { port.postMessage({ kind: 'DONE' }); return; }
      let binary = '';
      for (let i = 0; i < value.length; i += 8192) {
        binary += String.fromCharCode(...value.subarray(i, i + 8192));
      }
      port.postMessage({ kind: 'CHUNK', data: btoa(binary) });
    } catch (error) {
      port.postMessage({ kind: 'ERROR', message: error.message });
    }
  }
  port.onMessage.addListener(async message => {
    if (message.kind === 'CANCEL') { controller.abort(); return; }
    if (message.kind === 'ACK' && reader) { await next(); return; }
    if (message.kind !== 'START' || started) return;
    started = true;
    try {
      const url = trustedUrl(message.url);
      const response = await fetch(url.href, {
        credentials: url.hostname === 'www.myminifactory.com' ? 'include' : 'omit',
        signal: controller.signal,
      });
      if (response.status === 429) {
        throw new AssetHttpError(429, 'MyMiniFactory limited file downloads (HTTP 429).',
          parseRetryAfter(response.headers.get('retry-after')));
      }
      if (!response.ok || !response.body || response.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`Asset request returned HTTP ${response.status} or an invalid response.`);
      }
      reader = response.body.getReader();
      port.postMessage({ kind: 'META', total: Number(response.headers.get('content-length')) || 0 });
    } catch (error) {
      port.postMessage({ kind: 'ERROR', message: error.message,
        status: error.status, retryAfterMs: error.retryAfterMs });
    }
  });
  port.onDisconnect.addListener(() => controller.abort());
});
