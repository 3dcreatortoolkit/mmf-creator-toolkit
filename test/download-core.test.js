import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCsv } from '../src/csv.js';
import { parseCsv, tasksFromCsv, safeName, csvFingerprint, downloadProgress, orderedDownloadTasks } from '../src/download-core.js';
import { restoreCompleted } from '../src/download-state.js';

const listing = {
  name: 'Temple, gate\nwith stairs',
  url: 'https://www.myminifactory.com/object/3d-print-temple-gate-123',
  description_text: 'Line one\n"quoted" line',
  image_urls_json: JSON.stringify(['https://assets.myminifactory.com/images/one.jpg?size=full']),
  files_json: JSON.stringify([{ filename: 'gate:final?.stl',
    download_url: 'https://www.myminifactory.com/download/123?token=private', size_bytes: 2048 }]),
};

test('CSV with quoted commas and multiline descriptions produces per-listing download tasks', () => {
  const csv = createCsv([listing], { includeFiles: true });
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, listing.name);
  assert.equal(rows[0].description_text, listing.description_text);
  const result = tasksFromCsv(csv);
  assert.equal(result.listings, 1);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].id, 'listings/Temple, gate with stairs/images/one.jpg');
  assert.equal(result.tasks[1].id, 'listings/Temple, gate with stairs/files/001-gate_final_.stl');
  assert.equal(result.tasks[1].url, 'https://www.myminifactory.com/download/123?token=private');
  assert.equal(result.tasks[1].sizeBytes, 2048);
});

test('download requires an opted-in CSV and rejects non-MyMiniFactory URLs', () => {
  assert.throws(() => tasksFromCsv(createCsv([listing])), /Include file download URLs/);
  assert.throws(() => tasksFromCsv(createCsv([{ ...listing,
    image_urls_json: '["https://example.org/private.png"]',
  }], { includeFiles: true })), /outside MyMiniFactory/);
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.throws(() => parseCsv('"incomplete'), /unfinished quoted field/);
  assert.throws(() => tasksFromCsv(createCsv([{ ...listing, files_json: JSON.stringify([{
    filename: 'model.stl', download_url: 'https://www.myminifactory.com/download/123', size_bytes: -1,
  }]) }], { includeFiles: true })), /invalid file size/);
});

test('CSV exported before sizes were available still creates file tasks with unknown size', () => {
  const files = [{ filename: 'legacy.stl', download_url: 'https://www.myminifactory.com/download/123' }];
  const { tasks } = tasksFromCsv(createCsv([{ ...listing, files_json: JSON.stringify(files) }],
    { includeFiles: true }));
  assert.equal(tasks.find(task => task.kind === 'file').sizeBytes, null);
});

test('duplicate or Windows-equivalent titles get stable ID suffixes without clobbering another title', () => {
  const rows = [
    { ...listing, name: 'Temple: Gate' },
    { ...listing, name: 'temple? gate', url: 'https://www.myminifactory.com/object/another-gate-456' },
    { ...listing, name: 'Temple_ Gate-123', url: 'https://www.myminifactory.com/object/another-gate-789' },
  ];
  const { tasks } = tasksFromCsv(createCsv(rows, { includeFiles: true }));
  assert.deepEqual(tasks.filter(task => task.kind === 'image').map(task => task.id), [
    'listings/Temple_ Gate-123-2/images/one.jpg',
    'listings/temple_ gate-456/images/one.jpg',
    'listings/Temple_ Gate-123/images/one.jpg',
  ]);
  const reordered = tasksFromCsv(createCsv([...rows].reverse(), { includeFiles: true })).tasks;
  assert.deepEqual(new Set(tasks.map(task => task.id)), new Set(reordered.map(task => task.id)));
});

test('long titles and reserved folder names are sanitized and bounded', () => {
  const name = 'Long title. '.repeat(15);
  const rows = [listing, { ...listing, name, url: 'https://www.myminifactory.com/object/other-456' },
    { ...listing, name, url: 'https://www.myminifactory.com/object/other-789' },
    { ...listing, name: 'CON', url: 'https://www.myminifactory.com/object/other-999' }];
  const { tasks } = tasksFromCsv(createCsv(rows, { includeFiles: true }));
  const folders = new Set(tasks.map(task => task.id.split('/')[1]));
  assert.equal(folders.size, 4);
  assert.ok([...folders].every(folder => folder.length <= 95 && !/[. ]$/.test(folder)));
  assert.ok(folders.has('_CON'));
  assert.ok([...folders].some(folder => folder.endsWith('-456')));
  assert.ok([...folders].some(folder => folder.endsWith('-789')));
});

test('a repeated listing URL is rejected even when titles differ', () => {
  assert.throws(() => tasksFromCsv(createCsv([listing, { ...listing, name: 'New title' }],
    { includeFiles: true })), /duplicate listing URL/);
});

test('image names come from decoded CDN basenames and do not include query strings', () => {
  const images = [
    'https://assets.myminifactory.com/images/My%20Model%20Front.PNG?quality=100',
    'https://assets.myminifactory.com/images/rear-angle.webp',
  ];
  const { tasks } = tasksFromCsv(createCsv([{ ...listing, image_urls_json: JSON.stringify(images) }],
    { includeFiles: true }));
  assert.deepEqual(tasks.filter(task => task.kind === 'image').map(task => task.id), [
    'listings/Temple, gate with stairs/images/My Model Front.PNG',
    'listings/Temple, gate with stairs/images/rear-angle.webp',
  ]);
});

test('duplicate image basenames receive a suffix instead of overwriting a CDN-named file', () => {
  const images = [
    'https://assets.myminifactory.com/object-a/cover.jpg',
    'https://assets.myminifactory.com/object-b/cover.jpg',
    'https://assets.myminifactory.com/object-c/cover-2.jpg',
    'https://assets.myminifactory.com/object-d/COVER.jpg',
  ];
  const { tasks } = tasksFromCsv(createCsv([{ ...listing, image_urls_json: JSON.stringify(images) }],
    { includeFiles: true }));
  const names = tasks.filter(task => task.kind === 'image').map(task => task.id.split('/').at(-1));
  assert.deepEqual(names, ['cover.jpg', 'cover-2.jpg', 'cover-2-2.jpg', 'COVER-3.jpg']);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
});

test('image filenames are sanitized and keep their extension when truncated', () => {
  const filename = `${'a'.repeat(120)}.jpeg`;
  const url = `https://assets.myminifactory.com/images/${filename}`;
  const { tasks } = tasksFromCsv(createCsv([{ ...listing, image_urls_json: JSON.stringify([url]) }],
    { includeFiles: true }));
  const name = tasks[0].id.split('/').at(-1);
  assert.equal(name.length, 100);
  assert.ok(name.endsWith('.jpeg'));
  assert.throws(() => tasksFromCsv(createCsv([{ ...listing, image_urls_json: '["https://assets.myminifactory.com/images/"]' }],
    { includeFiles: true })), /without a filename/);
});

test('a refreshed signed CSV keeps the same download-plan fingerprint', async () => {
  const original = createCsv([listing], { includeFiles: true });
  const refreshed = createCsv([{ ...listing, files_json: JSON.stringify([{ filename: 'gate:final?.stl',
    download_url: 'https://www.myminifactory.com/download/123?token=refreshed' }]) }], { includeFiles: true });
  assert.equal(await csvFingerprint(original), await csvFingerprint(refreshed));
});

test('legacy task order can be grouped into independent image and file worker queues', () => {
  const csv = createCsv([listing, { ...listing,
    name: 'Second listing', url: 'https://www.myminifactory.com/object/3d-print-other-456',
  }], { includeFiles: true });
  const { tasks } = tasksFromCsv(csv);
  assert.deepEqual(tasks.map(task => task.kind), ['image', 'file', 'image', 'file']);
  tasks[0].done = true;
  tasks[1].done = true;
  assert.deepEqual(orderedDownloadTasks(tasks).filter(task => !task.done).map(task => task.kind), ['image', 'file']);
  assert.deepEqual(downloadProgress(tasks), {
    image: { completed: 1, total: 2 }, file: { completed: 1, total: 2 },
  });
});

test('resume only trusts completed tasks when the matching file still exists', async () => {
  const { tasks } = tasksFromCsv(createCsv([listing], { includeFiles: true }));
  const directory = {
    async getDirectoryHandle() { return this; },
    async getFileHandle(name) {
      if (name === 'one.jpg') return { getFile: async () => ({ size: 120 }) };
      throw new DOMException('Missing', 'NotFoundError');
    },
  };
  const job = { directory, csvFingerprint: 'same-csv', tasks };
  const metadata = { csvFingerprint: 'same-csv', completed: tasks.map(task => task.id) };
  await restoreCompleted(job, metadata);
  assert.deepEqual(tasks.map(task => task.done), [true, false]);
  await assert.rejects(() => restoreCompleted(job, { ...metadata, csvFingerprint: 'other-csv' }), /different CSV export/);
});
