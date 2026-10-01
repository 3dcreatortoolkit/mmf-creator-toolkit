import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFileRedirect } from '../src/redirect.js';

test('matches only the authorized tab and file link, then releases the redirect listener', async () => {
  const listeners = new Set();
  const source = 'https://www.myminifactory.com/download/123?token=example';
  const target = 'https://dlcc.myminifactory.com/signed/123?temporary=yes';
  const chromeApi = {
    runtime: { onMessage: { addListener: listener => listeners.add(listener),
      removeListener: listener => listeners.delete(listener) } },
    tabs: { sendMessage: async (_tabId, message) => {
      assert.equal(message.url, source);
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ kind: 'MMF_ASSET_REDIRECT', tabId: 999, from: source, to: target });
          listener({ kind: 'MMF_ASSET_REDIRECT', tabId: 7, from: 'https://www.myminifactory.com/other', to: target });
          listener({ kind: 'MMF_ASSET_REDIRECT', tabId: 7, from: source, to: target });
        }
      });
      return { started: true };
    } },
  };
  assert.equal(await resolveFileRedirect(7, source, new AbortController().signal, chromeApi), target);
  assert.equal(listeners.size, 0);
});
