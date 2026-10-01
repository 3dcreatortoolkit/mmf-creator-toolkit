export const PROGRESS_FILE = '3d-creator-toolkit-progress.json';

export function downloadProgress(tasks) {
  const progress = { image: { completed: 0, total: 0 }, file: { completed: 0, total: 0 } };
  for (const task of tasks) {
    if (!Object.hasOwn(progress, task.kind)) throw new Error(`Unknown asset type: ${task.kind}`);
    progress[task.kind].total++;
    if (task.done) progress[task.kind].completed++;
  }
  return progress;
}

export function orderedDownloadTasks(tasks) {
  downloadProgress(tasks);
  // Do not mutate the stored plan: older checkpoints use its original order.
  return [...tasks.filter(task => task.kind === 'image'), ...tasks.filter(task => task.kind === 'file')];
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(value); value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(value); value = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
    } else value += char;
  }
  if (quoted) throw new Error('CSV has an unfinished quoted field.');
  if (value || row.length) { row.push(value); rows.push(row); }
  if (!rows.length) throw new Error('The CSV is empty.');
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate column names.');
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
}

export function safeName(value, maxLength = 100) {
  let name = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, maxLength).replace(/[. ]+$/g, '');
  if (!name) name = 'untitled';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function trustedUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('The CSV contains an invalid asset URL.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !(url.hostname === 'myminifactory.com' || url.hostname.endsWith('.myminifactory.com'))) {
    throw new Error('The CSV contains an asset URL outside MyMiniFactory.');
  }
  return url;
}

function jsonArray(value, field, row) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`CSV row ${row} has invalid ${field}.`); }
  if (!Array.isArray(parsed)) throw new Error(`CSV row ${row} needs an array in ${field}.`);
  return parsed;
}

function listingFolders(rows) {
  const listings = rows.map((row, index) => {
    const url = trustedUrl(row.url);
    if (!url.pathname.startsWith('/object/')) throw new Error(`CSV row ${index + 2} is not an object listing.`);
    const title = safeName(row.name.replace(/\s+/g, ' ').trim(), 95);
    return { url, title, key: title.toLowerCase(), number: index + 2 };
  });
  const urls = new Set();
  const counts = new Map();
  for (const listing of listings) {
    if (urls.has(listing.url.href)) throw new Error(`CSV has a duplicate listing URL at row ${listing.number}.`);
    urls.add(listing.url.href);
    counts.set(listing.key, (counts.get(listing.key) ?? 0) + 1);
  }
  const used = new Set(listings.filter(listing => counts.get(listing.key) === 1).map(listing => listing.key));
  for (const listing of [...listings].sort((left, right) => left.url.href.localeCompare(right.url.href))) {
    if (counts.get(listing.key) === 1) { listing.folder = listing.title; continue; }
    const id = /-(\d+)$/.exec(listing.url.pathname)?.[1];
    for (let suffix = 1; ; suffix++) {
      const postfix = `-${id ?? listing.number}${suffix === 1 ? '' : `-${suffix}`}`;
      const folder = `${safeName(listing.title, 95 - postfix.length)}${postfix}`;
      if (used.has(folder.toLowerCase())) continue;
      listing.folder = folder;
      used.add(folder.toLowerCase());
      break;
    }
  }
  return listings;
}

function imageFilename(url, rowNumber) {
  const encoded = url.pathname.split('/').at(-1);
  let filename;
  try { filename = decodeURIComponent(encoded); }
  catch { throw new Error(`CSV row ${rowNumber} has an invalid image filename.`); }
  if (!filename || filename === '.' || filename === '..') {
    throw new Error(`CSV row ${rowNumber} has an image URL without a filename.`);
  }
  const extension = /\.[a-z0-9]{1,10}$/i.exec(filename)?.[0] ?? '';
  return `${safeName(filename.slice(0, filename.length - extension.length), 100 - extension.length)}${extension}`;
}

function uniqueImageFilename(filename, used) {
  const extension = /\.[a-z0-9]{1,10}$/i.exec(filename)?.[0] ?? '';
  const stem = filename.slice(0, filename.length - extension.length);
  let name = filename;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
    const postfix = `-${suffix}`;
    name = `${safeName(stem, 100 - extension.length - postfix.length)}${postfix}${extension}`;
  }
  used.add(name.toLowerCase());
  return name;
}

export function tasksFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The CSV contains no listings.');
  const required = ['url', 'name', 'image_urls_json', 'files_json'];
  if (required.some(header => !Object.hasOwn(rows[0], header))) {
    throw new Error('Choose a CSV exported with "Include file download URLs" selected.');
  }
  const tasks = [];
  const folders = listingFolders(rows);
  for (const [index, row] of rows.entries()) {
    const folder = folders[index].folder;
    const images = jsonArray(row.image_urls_json, 'image_urls_json', index + 2);
    const files = jsonArray(row.files_json, 'files_json', index + 2);
    const imageNames = new Set();
    for (const raw of new Set(images)) {
      if (typeof raw !== 'string') throw new Error(`CSV row ${index + 2} has an invalid image URL.`);
      const url = trustedUrl(raw);
      const name = uniqueImageFilename(imageFilename(url, index + 2), imageNames);
      tasks.push({ id: `listings/${folder}/images/${name}`, url: url.href, listing: row.name, kind: 'image', done: false });
    }
    for (const [number, file] of files.entries()) {
      if (!file || typeof file.filename !== 'string' || !file.filename || typeof file.download_url !== 'string') {
        throw new Error(`CSV row ${index + 2} has a file without a filename or download URL.`);
      }
      const sizeBytes = file.size_bytes ?? null;
      if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
        throw new Error(`CSV row ${index + 2} has an invalid file size.`);
      }
      const url = trustedUrl(file.download_url);
      const name = `${String(number + 1).padStart(3, '0')}-${safeName(file.filename)}`;
      tasks.push({ id: `listings/${folder}/files/${name}`, url: url.href, listing: row.name,
        kind: 'file', sizeBytes, done: false });
    }
  }
  if (!tasks.length) throw new Error('The CSV contains no images or files to download.');
  return { listings: rows.length, listingUrls: rows.map(row => row.url), tasks };
}

export async function csvFingerprint(text) {
  // Signed query strings and export timestamps change; the asset inventory must stay the same.
  const { tasks } = tasksFromCsv(text);
  const inventory = tasks.map(task => `${task.id}\n${new URL(task.url).origin}${new URL(task.url).pathname}`).join('\n');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inventory));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
