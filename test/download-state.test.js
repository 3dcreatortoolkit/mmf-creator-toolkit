import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { loadJob, saveJob, publishDownloadSummary, readProgressFile, writeProgressFile, restoreCompleted } from '../src/download-state.js';
import { OWNER_ONLY_MESSAGE } from '../src/exporter.js';

test('download job checkpoints survive a new IndexedDB read', async () => {
  const previousChrome = globalThis.chrome;
  let summaries = {};
  globalThis.chrome = { storage: { local: {
    get: async () => ({ downloadJobSummaries: summaries }),
    set: async value => { summaries = value.downloadJobSummaries; },
  } } };
  try {
    const job = { ownerUsername: 'demo', directory: { name: 'Chosen folder' }, status: 'running', tasks: [
      { id: 'listings/a/images/image-001.jpg', url: 'https://assets.myminifactory.com/a.jpg', kind: 'image', done: false },
      { id: 'listings/a/files/001-model.stl', url: 'https://www.myminifactory.com/download/a?token=secret', kind: 'file', done: false },
    ] };
    await saveJob(job);
    const restored = await loadJob('demo');
    restored.tasks[0].done = true;
    restored.status = 'paused';
    restored.lastError = 'Asset returned HTTP 503.';
    await saveJob(restored);
    assert.equal((await loadJob('DEMO')).tasks[0].done, true);
    assert.equal((await loadJob('demo')).lastError, 'Asset returned HTTP 503.');
    assert.equal(await loadJob('other'), undefined);
    assert.deepEqual(summaries.demo, { status: 'paused', completed: 1, total: 2, folder: 'Chosen folder',
      images: { completed: 1, total: 1 }, files: { completed: 0, total: 1 },
    });
    await saveJob({ ...job, ownerUsername: 'other', directory: { name: 'Other folder' }, status: 'paused' });
    assert.equal((await loadJob('demo')).directory.name, 'Chosen folder');
    assert.equal((await loadJob('other')).directory.name, 'Other folder');
    assert.equal(summaries.demo.folder, 'Chosen folder');
    assert.equal(summaries.other.folder, 'Other folder');
    await publishDownloadSummary('demo', { name: 'Fresh folder' }, []);
    assert.deepEqual(summaries.demo, { status: 'paused', completed: 0, total: 0, folder: 'Fresh folder',
      images: { completed: 0, total: 0 }, files: { completed: 0, total: 0 },
    });
    assert.equal((await loadJob('demo')).tasks[0].done, true);
  } finally { globalThis.chrome = previousChrome; }
});

test('folder progress file records completed paths without storing download URLs', async () => {
  let data;
  const handle = {
    async getFile() { return { text: async () => data }; },
    async createWritable() {
      return { write: async value => { data = value; }, close: async () => {}, abort: async () => {} };
    },
  };
  const job = { ownerUsername: 'demo', directory: { getFileHandle: async () => handle }, csvFingerprint: 'abc', csvName: 'export.csv', tasks: [
    { id: 'listings/a/files/001-model.stl', url: 'https://www.myminifactory.com/download/a?token=secret', done: true },
  ] };
  await writeProgressFile(job);
  const progress = await readProgressFile(job.directory);
  assert.deepEqual(progress.completed, ['listings/a/files/001-model.stl']);
  assert.equal(progress.csvFingerprint, 'abc');
  assert.equal(progress.ownerUsername, 'demo');
  assert.ok(!data.includes('token=secret'));
  await assert.rejects(() => restoreCompleted(job, { ...progress, ownerUsername: 'other' }),
    error => error.message === OWNER_ONLY_MESSAGE);
});
