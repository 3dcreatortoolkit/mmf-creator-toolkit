import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Exporter, OWNER_ONLY_MESSAGE, SIGN_IN_MESSAGE } from '../src/exporter.js';
import { parseSettingsProfile } from '../src/settings-profile.js';
import { createCsv, HEADERS } from '../src/csv.js';
import { progressPercent, STAGES } from '../src/progress.js';
import { DOMParser } from 'linkedom';

const origin = 'https://www.myminifactory.com';
const user = { id: 123, username: 'demo', name: 'Demo creator' };
globalThis.DOMParser = DOMParser;
const settings = (username = 'demo') => `<html><input name="user_profile_type[username]" value="${username}"><div class="avatar-container"><img alt="User avatar" src="https://images2.myminifactory.com/avatar.jpg"></div></html>`;

test('settings profile supplies the authenticated username and avatar, not a public user API', () => {
  assert.deepEqual(parseSettingsProfile(settings()), {
    username: 'demo', avatarUrl: 'https://images2.myminifactory.com/avatar.jpg',
  });
  assert.equal(parseSettingsProfile('<html><h1>Login</h1></html>'), null);
  assert.equal(parseSettingsProfile(settings().replace('images2.myminifactory.com', 'example.com'))?.avatarUrl, null);
});

function object(id, overrides = {}) {
  return {
    id, url: `${origin}/object/${id}`, name: `Object ${id}`,
    visibility_name: 'public', listed: true, description: 'Detailed, printable model.\nSecond line.',
    tags: ['terrain', 'japan'], images: [{ original: { url: `https://images.example/${id}.jpg` } }],
    categories: { total_count: 1, items: [{ name: 'Tabletop' }] },
    files: { total_count: 1, items: [{ filename: `model-${id}.stl`,
      download_url: `https://www.myminifactory.com/download/${id}?token=example`, size: '1536' }] },
    user_collections: [2255751], price: { currency: 'EUR', value: '4.95' },
    views: 9, likes: 2, published_at: '2024-01-01T00:00:00+00:00',
    ...overrides,
  };
}

function reply(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null },
    text: async () => typeof data === 'string' ? data : JSON.stringify(data) };
}

test('v2-only export pages objects, filters private records and maps public collections', async () => {
  const seen = [];
  const updates = [];
  const routes = new Map([
    ['/settings/profile', settings()], ['/api/v2/users/demo', user],
    ['/api/v2/users/demo/objects?page=1&per_page=5000', { total_count: 3, items: [
      object(10, { name: 'Lantern, one', user_collections: [2255751, 2805857] }),
      object(11, { name: 'Free object', price: null, description: null, tags: null, user_collections: [] }),
    ] }],
    ['/api/v2/users/demo/objects?page=2&per_page=5000', { total_count: 3, items: [
      object(12, { visibility_name: 'private', user_collections: [2255751] }),
    ] }],
    ['/api/v2/users/demo/collections?page=1&per_page=100', { total_count: 3, items: [
      { id: 2255751, name: 'Japanese Samurai Manors', is_public: true, total_objects: 2 },
      { id: 2805857, name: 'Japanese Tansu', is_public: true, total_objects: 1 },
      { id: 1924887, name: 'Save for later', is_public: false, total_objects: 0 },
    ] }],
  ]);
  const exporter = new Exporter({ delayMs: 0, report: update => updates.push(update), fetchImpl: async (url, options) => {
    const key = url.slice(origin.length);
    seen.push(key);
    assert.equal(options.credentials, 'include');
    assert.match(key, /^\/(?:api\/v2\/|settings\/profile$)/);
    if (!routes.has(key)) throw new Error(`Unexpected request ${key}`);
    return reply(routes.get(key));
  } });
  const result = await exporter.export({ includeFiles: true });
  assert.equal(seen[0], '/settings/profile');
  assert.ok(seen.includes('/api/v2/users/demo/objects?page=2&per_page=5000'));
  assert.equal(result.objectCount, 3);
  assert.equal(result.outsideStoreCount, 1);
  assert.equal(result.collectionCount, 2);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(JSON.parse(result.rows[0].collections_json), ['Japanese Samurai Manors', 'Japanese Tansu']);
  assert.deepEqual(JSON.parse(result.rows[0].image_urls_json), ['https://images.example/10.jpg']);
  assert.deepEqual(JSON.parse(result.rows[0].categories_json), ['Tabletop']);
  assert.deepEqual(JSON.parse(result.rows[0].tags_json), ['terrain', 'japan']);
  assert.deepEqual(JSON.parse(result.rows[0].files_json), [
    { filename: 'model-10.stl', download_url: 'https://www.myminifactory.com/download/10?token=example', size_bytes: 1536 },
  ]);
  assert.equal(result.rows[0].description_text, 'Detailed, printable model.\nSecond line.');
  assert.equal(result.rows[1].price_amount, '0');
  assert.equal(result.rows[1].price_currency, 'EUR');
  assert.equal(result.rows[1].is_free, true);
  assert.equal(result.rows[1].description_text, '');
  assert.deepEqual(JSON.parse(result.rows[1].tags_json), []);
  assert.ok(!result.rows.some(row => row.url === `${origin}/object/12`));
  assert.deepEqual([...new Set(updates.map(update => update.stage))], STAGES.map(stage => stage.id));
  const csv = createCsv(result.rows, { includeFiles: true });
  assert.ok(csv.startsWith('\uFEFF"listing_type"'));
  assert.ok(!csv.split('\r\n')[0].includes('creator_username'));
  assert.ok(!csv.split('\r\n')[0].includes('listing_id'));
  assert.ok(csv.includes('"Lantern, one"'));
  assert.ok(csv.includes('"files_json"'));
  assert.ok(csv.includes('model-10.stl'));
});

test('CSV quotes multiline fields and neutralizes spreadsheet formulas', () => {
  const csv = createCsv([{ name: '=IMPORTXML("https://example.com")', description_text: 'one\n"two"', tags_json: '["a","b"]',
    files_json: '[{"filename":"private.stl","download_url":"https://files.example/secret"}]' }]);
  assert.ok(csv.includes('"\'=IMPORTXML(""https://example.com"")"'));
  assert.ok(csv.includes('"one\n""two"""'));
  assert.ok(csv.includes('"[""a"",""b""]"'));
  assert.ok(!csv.includes('files_json'));
  assert.ok(!csv.includes('private.stl'));
  assert.ok(!csv.includes('https://files.example/secret'));
  assert.equal(HEADERS.length, 16);
});

test('default export neither maps file URLs nor requests file pages', async () => {
  const paths = [];
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    paths.push(path);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/users/demo/objects?')) return reply({ total_count: 1, items: [
      object(10, { files: { total_count: 2, items: [{ filename: 'partial.stl' }] } }),
    ] });
    if (path.includes('/users/demo/collections?')) return reply({ total_count: 1,
      items: [{ id: 2255751, name: 'Japanese Samurai Manors', is_public: true }] });
    throw new Error(`Unexpected request ${path}`);
  } });
  const result = await exporter.export();
  assert.equal(Object.hasOwn(result.rows[0], 'files_json'), false);
  assert.ok(!paths.some(path => path.includes('/files?')));
  assert.ok(!createCsv(result.rows).includes('files_json'));
});

test('fetches truncated v2 file pages and pairs filenames with their download URLs', async () => {
  const urls = [];
  const entry = object(10, { files: { total_count: 2, items: [
    { filename: 'first.stl', download_url: 'https://files.example/first' },
  ] } });
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    urls.push(path);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/users/demo/objects?')) return reply({ total_count: 1, items: [entry] });
    if (path === '/api/v2/objects/10/files?page=1&per_page=5000') return reply({ total_count: 2, items: [
      { filename: 'first.stl', download_url: 'https://files.example/first' },
      { filename: 'second.stl', download_url: 'https://files.example/second' },
    ] });
    if (path.includes('/users/demo/collections?')) return reply({ total_count: 1,
      items: [{ id: 2255751, name: 'Japanese Samurai Manors', is_public: true }] });
    throw new Error(`Unexpected request ${path}`);
  } });
  const result = await exporter.export({ includeFiles: true });
  assert.deepEqual(JSON.parse(result.rows[0].files_json), [
    { filename: 'first.stl', download_url: 'https://files.example/first', size_bytes: null },
    { filename: 'second.stl', download_url: 'https://files.example/second', size_bytes: null },
  ]);
  assert.ok(urls.includes('/api/v2/objects/10/files?page=1&per_page=5000'));
});

test('does not export a file entry missing its download URL', async () => {
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/users/demo/objects?')) return reply({ total_count: 1, items: [
      object(10, { files: { total_count: 1, items: [{ filename: 'model.stl' }] } }),
    ] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export({ includeFiles: true }), /missing download URL/);
});

test('rejects an invalid v2 file size rather than exporting misleading byte totals', async () => {
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/users/demo/objects?')) return reply({ total_count: 1, items: [
      object(10, { files: { total_count: 1, items: [
        { filename: 'model.stl', download_url: 'https://files.example/model', size: '-1' },
      ] } }),
    ] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export({ includeFiles: true }), /invalid file size/);
});

test('truncated v2 object pages stop export before CSV creation', async () => {
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.endsWith('page=1&per_page=5000')) return reply({ total_count: 2, items: [object(10)] });
    if (path.endsWith('page=2&per_page=5000')) return reply({ total_count: 2, items: [] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export(), /Object pagination ended early/);
});

test('a missing collection reference stops export instead of silently dropping membership', async () => {
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = url.slice(origin.length);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/objects?')) return reply({ total_count: 1, items: [object(10)] });
    if (path.includes('/collections?')) return reply({ total_count: 0, items: [] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export(), /collection missing from the v2 response/);
});

test('no creator data requests are sent before login is verified', async () => {
  const requested = [];
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    requested.push(new URL(url).pathname);
    return reply('<html><h1>Login</h1></html>');
  } });
  await assert.rejects(() => exporter.export(), error => error.message === SIGN_IN_MESSAGE);
  assert.deepEqual(requested, ['/settings/profile']);
});

test('rate-limited settings checks are not reported as a sign-out', async () => {
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async () => ({
    ...reply('', 429), headers: { get: name => name === 'retry-after' ? '5' : null },
  }) });
  await assert.rejects(() => exporter.checkSession(), error =>
    error.status === 429 && error.retryAfterMs === 5_000 && error.message !== SIGN_IN_MESSAGE);
});

test('a mismatched creator response cannot reach the objects endpoint', async () => {
  const requested = [];
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === '/settings/profile') return reply(settings());
    if (path === '/api/v2/users/demo') return reply({ ...user, username: 'other' });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export(), error => error.message === OWNER_ONLY_MESSAGE);
  assert.deepEqual(requested, ['/settings/profile', '/api/v2/users/demo']);
});

test('changing the signed-in account mid-export stops before reading collections', async () => {
  let checks = 0;
  const requested = [];
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === '/settings/profile') return reply(settings(++checks === 1 ? 'demo' : 'other'));
    if (path === '/api/v2/users/demo') return reply(user);
    if (path === '/api/v2/users/demo/objects') return reply({ total_count: 0, items: [] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export(), error => error.message === OWNER_ONLY_MESSAGE);
  assert.ok(!requested.some(path => path.includes('/collections')));
});

test('signing out during export stops before reading objects or saving a CSV', async () => {
  const requested = [];
  let checks = 0;
  const exporter = new Exporter({ delayMs: 0, fetchImpl: async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === '/settings/profile') return ++checks === 1 ? reply(settings()) : reply('', 302);
    if (path === '/api/v2/users/demo') return reply(user);
    if (path.includes('/objects')) return reply({ total_count: 0, items: [] });
    throw new Error(`Unexpected request ${path}`);
  } });
  await assert.rejects(() => exporter.export(), error => error.message === SIGN_IN_MESSAGE);
  assert.equal(checks, 2);
  assert.ok(!requested.some(path => path.includes('/collections')));
});

test('default browser fetch retains its Window receiver and reports an expired session', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = function (_url, options) {
      assert.equal(this, globalThis);
      assert.equal(options.credentials, 'include');
      return Promise.resolve(reply('', 401));
    };
    await assert.rejects(() => new Exporter({ delayMs: 0 }).export(), error => error.message === SIGN_IN_MESSAGE);
  } finally {
    globalThis.fetch = previous;
  }
});

test('stage progress remains measurable through CSV creation', () => {
  assert.equal(progressPercent({ stage: 'auth', completed: 0, total: 1 }), 0);
  assert.equal(progressPercent({ stage: 'auth', completed: 1, total: 1 }), 8);
  assert.equal(progressPercent({ stage: 'details', completed: 5, total: 10 }), 82);
  assert.equal(progressPercent({ stage: 'download', completed: 0, total: 1 }), 96);
  assert.equal(progressPercent({ stage: 'download', outcome: 'complete' }), 100);
});
