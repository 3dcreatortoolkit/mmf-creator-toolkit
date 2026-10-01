import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMmfTab, listMmfTabs, sendToMmfTab } from '../src/mmf-tabs.js';

test('only MyMiniFactory tabs can supply the authenticated account', () => {
  assert.equal(isMmfTab({ id: 8, url: 'https://www.myminifactory.com/object/123' }), true);
  assert.equal(isMmfTab({ id: 9, url: 'chrome-extension://extension/downloader.html' }), false);
  assert.equal(isMmfTab({ id: 10, url: 'https://example.com/users/demo' }), false);
});

test('downloader considers any MyMiniFactory tab and ignores extension tabs', async () => {
  const tabs = await listMmfTabs({ tabs: { query: async () => [
    { id: 1, url: 'chrome-extension://extension/downloader.html' },
    { id: 2, url: 'https://www.myminifactory.com/object/3d-print-model-12', lastAccessed: 10 },
    { id: 3, url: 'https://www.myminifactory.com/', lastAccessed: 20 },
  ] } });
  assert.deepEqual(tabs.map(tab => tab.id), [3, 2]);
});

test('already-open tabs get the current content script when no receiver exists', async () => {
  let messages = 0;
  const chromeApi = {
    tabs: { sendMessage: async () => {
      if (++messages === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { authenticated: true };
    } },
    scripting: { executeScript: async request => {
      assert.deepEqual(request, { target: { tabId: 7 }, files: ['content.js'] });
    } },
  };
  assert.deepEqual(await sendToMmfTab(7, { kind: 'MMF_AUTH_CHECK' }, chromeApi), { authenticated: true });
  assert.equal(messages, 2);
});
