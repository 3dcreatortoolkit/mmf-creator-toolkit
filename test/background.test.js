import assert from 'node:assert/strict';
import { test } from 'node:test';

test('remember-me updates do not pause a job; session-cookie changes do', async () => {
  const previous = globalThis.chrome;
  const notifications = [];
  let onCookieChange;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async message => { notifications.push(message); },
    },
    webRequest: { onBeforeRedirect: { addListener() {} } },
    cookies: { onChanged: { addListener: handler => { onCookieChange = handler; } } },
  };
  try {
    await import('../src/background.js');
    onCookieChange({ cookie: { name: 'REMEMBERME', domain: 'www.myminifactory.com' } });
    onCookieChange({ cookie: { name: 'PHPSESSID', domain: 'example.com' } });
    assert.deepEqual(notifications, []);
    onCookieChange({ cookie: { name: 'PHPSESSID', domain: '.myminifactory.com' } });
    assert.deepEqual(notifications, [{ kind: 'MMF_SESSION_CHANGED' }]);
  } finally { globalThis.chrome = previous; }
});
