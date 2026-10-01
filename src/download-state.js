import { PROGRESS_FILE, csvFingerprint, downloadProgress, tasksFromCsv } from './download-core.js';
import { OWNER_ONLY_MESSAGE } from './exporter.js';

const DATABASE = '3d-creator-toolkit-downloads';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function ownerKey(username) {
  if (!username || typeof username !== 'string') throw new Error('Sign in to a creator account before saving a download job.');
  return `creator:${username.toLowerCase()}`;
}

async function transaction(method, key, value) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', method === 'get' ? 'readonly' : 'readwrite');
      const result = tx.objectStore('jobs')[method](...(method === 'put' ? [value, key] : [key]));
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function loadJob(username) { return transaction('get', ownerKey(username)); }
export async function loadLegacyJob() { return transaction('get', 'current'); }
export async function deleteLegacyJob() { return transaction('delete', 'current'); }

export async function publishDownloadSummary(username, directory, tasks, status = 'paused') {
  const phases = downloadProgress(tasks);
  const { downloadJobSummaries = {} } = await chrome.storage.local.get('downloadJobSummaries');
  await chrome.storage.local.set({ downloadJobSummaries: { ...downloadJobSummaries, [ownerKey(username).slice('creator:'.length)]: {
    status,
    completed: tasks.filter(task => task.done).length,
    total: tasks.length, folder: directory.name,
    images: phases.image, files: phases.file,
  } } });
}

export async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await transaction('put', ownerKey(job.ownerUsername), job);
  await publishDownloadSummary(job.ownerUsername, job.directory, job.tasks, job.status);
}

export async function readProgressFile(directory) {
  let handle;
  try { handle = await directory.getFileHandle(PROGRESS_FILE); }
  catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(await (await handle.getFile()).text()); }
  catch { throw new Error(`The ${PROGRESS_FILE} file is unreadable. Choose another folder or restore it.`); }
  if (![1, 2].includes(value?.format) || typeof value.csvFingerprint !== 'string' ||
      !Array.isArray(value.completed) || (value.format === 2 && typeof value.ownerUsername !== 'string')) {
    throw new Error(`The ${PROGRESS_FILE} file has an unrecognized format.`);
  }
  return value;
}

export async function writeProgressFile(job) {
  const handle = await job.directory.getFileHandle(PROGRESS_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify({
      format: 2, ownerUsername: job.ownerUsername, csvFingerprint: job.csvFingerprint, csvName: job.csvName,
      total: job.tasks.length, completed: job.tasks.filter(task => task.done).map(task => task.id),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    await writable.close();
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
}

export async function fileHandleForTask(directory, task, create = false) {
  const parts = task.id.split('/');
  let current = directory;
  for (const name of parts.slice(0, -1)) current = await current.getDirectoryHandle(name, { create });
  return current.getFileHandle(parts.at(-1), { create });
}

export async function restoreCompleted(job, metadata) {
  if (metadata?.ownerUsername && metadata.ownerUsername.toLowerCase() !== job.ownerUsername.toLowerCase()) {
    throw new Error(OWNER_ONLY_MESSAGE);
  }
  if (metadata && metadata.csvFingerprint !== job.csvFingerprint) {
    throw new Error('This folder belongs to a different CSV export. Choose its original CSV or a different folder.');
  }
  const finished = new Set(metadata?.completed ?? []);
  for (const task of job.tasks) {
    if (!task.done && !finished.has(task.id)) continue;
    try {
      const file = await (await fileHandleForTask(job.directory, task)).getFile();
      task.done = file.size > 0;
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      task.done = false;
    }
  }
  return job;
}

export async function prepareJob(csvText, csvName, directory, ownerUsername) {
  const { listings, listingUrls, tasks } = tasksFromCsv(csvText);
  const job = {
    ownerUsername, csvFingerprint: await csvFingerprint(csvText), csvName, directory, listings, listingUrls, tasks,
    status: 'paused', updatedAt: new Date().toISOString(),
  };
  await restoreCompleted(job, await readProgressFile(directory));
  await saveJob(job);
  await writeProgressFile(job);
  return job;
}
