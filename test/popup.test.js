import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DOMParser } from 'linkedom';
import { SIGN_IN_MESSAGE } from '../src/exporter.js';

test('a signed-out status clears old checkmarks and cannot be overwritten by stale progress', async () => {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  const markup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  globalThis.document = new DOMParser().parseFromString(markup, 'text/html');
  let signedIn = false;
  let onStorageChanged;
  let onRuntimeMessage;
  const startMessages = [];
  let workspaceUrl;
  globalThis.chrome = {
    tabs: {
      query: async options => options?.url?.startsWith('https://www.myminifactory.com/')
        ? [{ id: 7, url: 'https://www.myminifactory.com/users/demo' }]
        : options?.url ? [] : [{ id: 77, url: 'chrome-extension://test/downloader.html' }],
      create: async options => { workspaceUrl = options.url; },
      sendMessage: async (_id, message) => {
        if (message.kind === 'MMF_EXPORT_START') {
          startMessages.push(message);
          return { started: true };
        }
        return signedIn ? { authenticated: true, username: 'demo',
          avatarUrl: 'https://images2.myminifactory.com/avatars/demo.jpg' }
          : { authenticated: false, signedOut: true, message: SIGN_IN_MESSAGE };
      },
    },
    storage: {
      session: { get: async () => ({}) },
      local: { get: async () => ({}) },
      onChanged: { addListener: listener => { onStorageChanged = listener; } },
    },
    runtime: { getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: listener => { onRuntimeMessage = listener; } } },
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import('../src/popup.js');
    await tick();
    await tick();
    const authStep = document.querySelector('.step[data-stage="auth"]');
    const detailsStep = document.querySelector('.step[data-stage="details"]');
    assert.equal(document.querySelector('#creator-input').hasAttribute('readonly'), true);
    assert.equal(document.querySelector('#start').disabled, true);
    assert.equal(authStep.dataset.state, 'error');
    assert.equal(document.querySelector('#alert').textContent, SIGN_IN_MESSAGE);
    assert.equal(document.querySelector('.card').dataset.signedOut, 'true');
    assert.equal(document.querySelector('#collect-tab').getAttribute('aria-selected'), 'true');
    document.querySelector('#download-tab').click();
    assert.equal(document.querySelector('#download-panel').hidden, false);
    onStorageChanged({ downloadJobSummaries: { newValue: { demo: {
      status: 'running', completed: 3, total: 5, folder: 'Demo models',
      images: { completed: 2, total: 2 }, files: { completed: 1, total: 3 },
    }, other: { status: 'running', completed: 8, total: 8, folder: 'Other models' } } } }, 'local');
    assert.equal(document.querySelector('#download-phase-progress').hidden, true);
    assert.equal(document.querySelector('#download-summary').textContent, 'No download job started yet.');
    document.querySelector('#open-downloader').click();
    await tick();
    assert.equal(workspaceUrl, 'chrome-extension://test/downloader.html');
    document.querySelector('#collect-tab').click();

    signedIn = true;
    document.querySelector('#check-again').click();
    await tick();
    await tick();
    assert.equal(document.querySelector('#creator-input').value, 'demo');
    assert.equal(document.querySelector('#popup-images-count').textContent, '2 / 2');
    assert.equal(document.querySelector('#popup-files-count').textContent, '1 / 3');
    assert.equal(document.querySelector('#popup-images-track').getAttribute('aria-valuenow'), '100');
    assert.equal(document.querySelector('#popup-files-track').getAttribute('aria-valuenow'), '33');
    assert.match(document.querySelector('#download-summary').textContent, /Demo models/);
    assert.doesNotMatch(document.querySelector('#download-summary').textContent, /Other models/);
    assert.equal(document.querySelector('#creator-avatar').getAttribute('src'),
      'https://images2.myminifactory.com/avatars/demo.jpg');
    assert.equal(document.querySelector('#creator-avatar').getAttribute('alt'), 'Avatar for @demo');
    const checkbox = document.querySelector('#include-files');
    assert.equal(checkbox.checked === true, false);
    document.querySelector('#start').click();
    await tick();
    assert.equal(startMessages[0].includeFiles, false);
    assert.equal(Object.hasOwn(startMessages[0], 'username'), false);
    onStorageChanged({ tab_7: { newValue: {
      stage: 'download', completed: 1, total: 1, percent: 100, outcome: 'complete', running: false, includeFiles: false,
    } } }, 'session');
    checkbox.checked = true;
    document.querySelector('#start').click();
    await tick();
    assert.equal(startMessages[1].includeFiles, true);
    assert.equal(checkbox.disabled, true);
    onStorageChanged({ tab_7: { newValue: {
      stage: 'details', completed: 54, total: 152, percent: 78, running: true, outcome: 'running', detail: 'Reading listing', includeFiles: true,
    } } }, 'session');
    assert.equal(checkbox.checked, true);
    assert.equal(authStep.dataset.state, 'done');
    assert.equal(detailsStep.dataset.state, 'active');

    onStorageChanged({ tab_7: { newValue: {
      stage: 'details', completed: 54, total: 152, percent: 78, running: false,
      outcome: 'error', signedOut: true, detail: SIGN_IN_MESSAGE,
    } } }, 'session');
    assert.equal(authStep.dataset.state, 'error');
    assert.equal(detailsStep.dataset.state, 'pending');
    assert.equal(document.querySelector('#percent').textContent, '0%');
    assert.equal(document.querySelector('#start').disabled, true);
    assert.equal(document.querySelector('#alert').textContent, SIGN_IN_MESSAGE);
    assert.equal(document.querySelector('#creator-avatar-fallback').textContent, '?');
    assert.equal(document.querySelector('#download-phase-progress').hidden, true);

    onStorageChanged({ tab_7: { newValue: {
      stage: 'details', completed: 55, total: 152, percent: 79, running: true, outcome: 'running',
    } } }, 'session');
    assert.equal(authStep.dataset.state, 'error');
    assert.equal(document.querySelector('#percent').textContent, '0%');
    signedIn = false;
    onRuntimeMessage({ kind: 'MMF_SESSION_CHANGED' });
    await tick();
    await tick();
    assert.equal(document.querySelector('#creator-input').value, '');
    assert.equal(document.querySelector('#download-summary').textContent, 'No download job started yet.');
  } finally {
    globalThis.document = previousDocument;
    globalThis.chrome = previousChrome;
  }
});

test('a generic MyMiniFactory tab pre-fills the authenticated creator without an editable target', async () => {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  const markup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  globalThis.document = new DOMParser().parseFromString(markup, 'text/html');
  let exportMessage;
  globalThis.chrome = {
    tabs: {
      query: async options => options?.url?.startsWith('https://www.myminifactory.com/')
        ? [{ id: 8, url: 'https://www.myminifactory.com/object/3d-print-sample-123' }]
        : [{ id: 77, url: 'chrome-extension://test/downloader.html' }],
      sendMessage: async (_id, message) => {
        if (message.kind === 'MMF_EXPORT_START') { exportMessage = message; return { started: true }; }
        return { authenticated: true, username: 'demo', avatarUrl: 'https://example.com/tracker.png' };
      },
    },
    storage: { session: { get: async () => ({}) }, local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
    runtime: { getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => {} } },
  };
  try {
    await import('../src/popup.js?generic');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const input = document.querySelector('#creator-input');
    assert.equal(input.hasAttribute('readonly'), true);
    assert.equal(input.value, 'demo');
    assert.equal(document.querySelector('#creator-avatar-fallback').textContent, 'D');
    assert.equal(document.querySelector('#creator-avatar').hasAttribute('src'), false);
    assert.equal(document.querySelector('#start').disabled, false);
    document.querySelector('#start').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Object.hasOwn(exportMessage, 'username'), false);
  } finally {
    globalThis.document = previousDocument;
    globalThis.chrome = previousChrome;
  }
});
