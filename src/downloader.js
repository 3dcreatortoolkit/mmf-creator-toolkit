import { tasksFromCsv, trustedUrl, PROGRESS_FILE, downloadProgress, orderedDownloadTasks } from './download-core.js';
import { deleteLegacyJob, fileHandleForTask, loadJob, loadLegacyJob, prepareJob, publishDownloadSummary, readProgressFile, restoreCompleted, saveJob, writeProgressFile } from './download-state.js';
import { resolveFileRedirect } from './redirect.js';
import { listMmfTabs, sendToMmfTab } from './mmf-tabs.js';
import { Exporter, OWNER_ONLY_MESSAGE, SIGN_IN_MESSAGE } from './exporter.js';
import { createSerialQueue } from './serial-queue.js';
import { createSpeedMeter, formatBytes, formatDuration, phaseMetrics } from './download-metrics.js';
import { AssetHttpError, createRateLimitGate, isRateLimitError, parseRetryAfter, retryAsset } from './download-retry.js';
import { runConcurrentWorkers } from './download-workers.js';

const csvInput = document.querySelector('#csv');
const csvInfo = document.querySelector('#csv-info');
const folderInfo = document.querySelector('#folder-info');
const count = document.querySelector('#progress-count');
const phaseElements = {
  image: { count: document.querySelector('#images-count'), fill: document.querySelector('#images-fill'), track: document.querySelector('#images-track'), section: document.querySelector('#images-phase'), stats: document.querySelector('#images-stats'), current: document.querySelector('#images-current') },
  file: { count: document.querySelector('#files-count'), fill: document.querySelector('#files-fill'), track: document.querySelector('#files-track'), section: document.querySelector('#files-phase'), stats: document.querySelector('#files-stats'), current: document.querySelector('#files-current') },
};
const overallEta = document.querySelector('#overall-eta');
const current = document.querySelector('#current');
const notice = document.querySelector('#notice');
const startButton = document.querySelector('#start');
const resumeButton = document.querySelector('#resume');
const pauseButton = document.querySelector('#pause');

let csvText;
let csvName;
let chosenDirectory;
let job;
let running = false;
let controller;
let lastAuthenticatedTab;
let lastAuthenticatedAt = 0;
let lastAuthenticatedUsername;
let lastCookieFingerprint;
let accountUsername;
let accountVerified = false;
let activeRun;
let authVersion = 0;
const pickerAvailable = typeof window.showDirectoryPicker === 'function';
let pickerHelpMessage = 'This browser does not support choosing a folder.';
let transfers = { image: {}, file: {} };

function showError(message) {
  notice.hidden = false;
  notice.textContent = message;
}

function clearError() { notice.hidden = true; notice.textContent = ''; }

function renderTransferStats() {
  const tasks = accountVerified ? job?.tasks ?? [] : [];
  if (!tasks.length) {
    phaseElements.image.stats.textContent = 'Transferred 0 B · Speed — · ETA —';
    phaseElements.file.stats.textContent = '0 B of 0 B expected · Speed — · ETA —';
    overallEta.textContent = 'Time estimates appear once downloads start.';
    return;
  }
  const images = phaseMetrics(tasks, 'image', transfers.image);
  const files = phaseMetrics(tasks, 'file', transfers.file);
  const etaLabel = eta => eta === null ? '—' : eta === 0 ? 'done' : `~${formatDuration(eta)}`;
  phaseElements.image.stats.textContent = `Transferred ${formatBytes(images.downloaded)} · Speed ${images.speed ? `${formatBytes(images.speed)}/s` : '—'} · ETA ${etaLabel(images.etaSeconds)}`;
  const fileTotal = files.unknownSizes
    ? `${formatBytes(files.totalBytes)} known (+${files.unknownSizes} unknown-size ${files.unknownSizes === 1 ? 'file' : 'files'})`
    : `${formatBytes(files.totalBytes)} expected`;
  phaseElements.file.stats.textContent = `${formatBytes(files.downloaded)} of ${fileTotal} · Speed ${files.speed ? `${formatBytes(files.speed)}/s` : '—'} · ETA ${etaLabel(files.etaSeconds)}`;
  overallEta.textContent = job && job.status === 'complete' && accountVerified
    ? 'All downloads complete.'
    : images.etaSeconds !== null && files.etaSeconds !== null
    ? `Approximate time remaining: ~${formatDuration(Math.max(images.etaSeconds, files.etaSeconds))}`
    : 'Approximate time remaining: waiting for transfer data or file sizes…';
}

function render() {
  const visibleJob = accountVerified ? job : null;
  const phases = downloadProgress(visibleJob?.tasks ?? []);
  const finished = phases.image.completed + phases.file.completed;
  const total = visibleJob?.tasks.length ?? 0;
  count.textContent = `${finished} / ${total}`;
  for (const [kind, progress] of Object.entries(phases)) {
    const elements = phaseElements[kind];
    const percent = progress.total ? Math.round(progress.completed * 100 / progress.total) : 0;
    elements.count.textContent = `${progress.completed} / ${progress.total}`;
    elements.fill.style.width = `${percent}%`;
    elements.track.setAttribute('aria-valuenow', String(percent));
    elements.section.dataset.active = running && progress.completed < progress.total ? 'true' : 'false';
    if (!accountVerified) elements.current.textContent = 'Sign in to view this phase.';
    else if (!visibleJob) elements.current.textContent = `Waiting for ${kind === 'image' ? 'images' : 'files'}…`;
  }
  startButton.disabled = running || !accountVerified || !pickerAvailable || !csvText || !chosenDirectory;
  resumeButton.hidden = !visibleJob || visibleJob.status === 'complete';
  resumeButton.disabled = running || !accountVerified || !pickerAvailable;
  pauseButton.hidden = !running;
  csvInput.disabled = running || !accountVerified;
  document.querySelector('#choose-folder').disabled = running || !accountVerified || !pickerAvailable;
  if (!accountVerified) current.textContent = 'Sign in to MyMiniFactory to view your download job.';
  else if (!running && visibleJob && !csvText) {
    current.textContent = visibleJob.status === 'complete'
      ? `Complete. ${finished} assets are in ${visibleJob.directory.name}.`
      : `Saved job: ${finished} of ${total} assets. Resume with a signed-in MyMiniFactory tab open.`;
  } else if (!running && !visibleJob) current.textContent = chosenDirectory
    ? 'New folder selected. Start a new download with your CSV.'
    : `Signed in as @${accountUsername}. Choose a CSV and folder to begin.`;
  if (accountVerified && !running && visibleJob?.status === 'paused' && visibleJob.lastError) {
    showError(visibleJob.lastError);
  }
  renderTransferStats();
}

async function signedInTab(force = false) {
  const tabs = await listMmfTabs();
  if (!force && lastAuthenticatedTab && lastAuthenticatedUsername && Date.now() - lastAuthenticatedAt < 60_000 &&
      tabs.some(tab => tab.id === lastAuthenticatedTab)) {
    return { tabId: lastAuthenticatedTab, username: lastAuthenticatedUsername };
  }
  let signedOut = false;
  let rateLimited;
  for (const tab of tabs) {
    try {
      const response = await sendToMmfTab(tab.id, { kind: 'MMF_AUTH_CHECK' });
      if (response?.authenticated === true && typeof response.username === 'string' && response.username) {
        lastAuthenticatedTab = tab.id;
        lastAuthenticatedAt = Date.now();
        lastAuthenticatedUsername = response.username;
        return { tabId: tab.id, username: response.username };
      }
      signedOut ||= response?.signedOut === true;
      if (response?.status === 429) {
        rateLimited = new AssetHttpError(429, response.message, response.retryAfterMs);
        break;
      }
    } catch { /* Try another MyMiniFactory tab if this one cannot receive messages. */ }
  }
  if (signedOut) throw new Error(SIGN_IN_MESSAGE);
  if (rateLimited) throw rateLimited;
  throw new Error(tabs.length
    ? 'Could not connect to an open MyMiniFactory tab. Reload that tab and resume.'
    : 'Open a signed-in MyMiniFactory tab, then resume.');
}

function sameOwner(left, right) { return left?.toLowerCase() === right?.toLowerCase(); }

async function cookieFingerprint() {
  const cookie = await chrome.cookies.get({ url: 'https://www.myminifactory.com', name: 'PHPSESSID' });
  if (!cookie?.value) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookie.value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function ownerTab(force = false) {
  const fingerprint = await cookieFingerprint();
  if (fingerprint !== lastCookieFingerprint) {
    lastCookieFingerprint = fingerprint;
    force = true;
  }
  let actor;
  try { actor = await signedInTab(force); }
  catch (error) {
    if (error.message === SIGN_IN_MESSAGE) sessionChanged();
    throw error;
  }
  if (!sameOwner(actor.username, job?.ownerUsername)) {
    sessionChanged();
    throw new Error(OWNER_ONLY_MESSAGE);
  }
  return actor.tabId;
}

async function validateListingOwnership(listingUrls, username) {
  const objects = await new Exporter().getObjects(username);
  for (const raw of listingUrls) {
    const url = new URL(raw);
    const id = /(?:-|\/)(\d+)$/.exec(url.pathname)?.[1];
    const object = objects.get(id);
    if (!id || !object || object.visibility_name !== 'public' || !object.listed) {
      throw new Error('The selected CSV does not belong to your signed-in creator account.');
    }
  }
}

async function migrateLegacyJob(username, version) {
  const legacy = await loadLegacyJob();
  if (!legacy) return null;
  const urls = legacy.listingUrls ?? [...new Set(legacy.tasks.map(task => {
    const id = /(?:-|\/)(\d+)\/(?:images|files)\//.exec(task.id)?.[1];
    return id ? `https://www.myminifactory.com/object/${id}` : null;
  }))];
  if (urls.some(url => !url)) return null;
  try { await validateListingOwnership(urls, username); }
  catch { return null; }
  if (version !== authVersion) return null;
  legacy.ownerUsername = username;
  await saveJob(legacy);
  await deleteLegacyJob();
  return legacy;
}

function aborted(signal) {
  if (signal.aborted) throw new DOMException('Download paused.', 'AbortError');
}

async function directTransfer(url, writable, signal, progress, credentials = 'include') {
  const response = await fetch(url, { credentials, signal });
  if (response.status === 429) {
    throw new AssetHttpError(429, 'MyMiniFactory limited file downloads (HTTP 429).',
      parseRetryAfter(response.headers.get('retry-after')));
  }
  if (!response.ok || !response.body || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`Asset returned HTTP ${response.status} or a login page. The download URL may have expired.`);
  }
  trustedUrl(response.url);
  const reader = response.body.getReader();
  const length = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  while (true) {
    aborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    await writable.write(value);
    received += value.byteLength;
    progress(received, length);
  }
  if (!received) throw new Error('Asset was empty; it was not marked complete.');
}

function pageTransfer(tabId, url, writable, signal, progress) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'MMF_ASSET_TRANSFER' });
    let received = 0;
    let total = 0;
    let ended = false;
    function finish(error) {
      if (ended) return;
      ended = true;
      signal.removeEventListener('abort', onAbort);
      port.disconnect();
      if (error) reject(error);
      else if (!received) reject(new Error('Asset was empty; it was not marked complete.'));
      else resolve();
    }
    function onAbort() {
      try { port.postMessage({ kind: 'CANCEL' }); } catch { /* Tab already closed. */ }
      finish(new DOMException('Download paused.', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    port.onDisconnect.addListener(() => finish(new Error('MyMiniFactory tab closed during the transfer.')));
    port.onMessage.addListener(async message => {
      if (ended) return;
      if (message.kind === 'META') { total = message.total; port.postMessage({ kind: 'ACK' }); }
      if (message.kind === 'ERROR') finish(message.status === 429
        ? new AssetHttpError(429, message.message, message.retryAfterMs)
        : new Error(message.message));
      if (message.kind === 'DONE') finish();
      if (message.kind === 'CHUNK') {
        try {
          const binary = atob(message.data);
          const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          await writable.write(bytes);
          received += bytes.byteLength;
          progress(received, total);
          if (!ended) port.postMessage({ kind: 'ACK' });
        } catch (error) { finish(error); }
      }
    });
    port.postMessage({ kind: 'START', url });
  });
}

async function saveAsset(task, tabId, signal, progress) {
  const handle = await fileHandleForTask(job.directory, task, true);
  const writable = await handle.createWritable();
  let signedTarget;
  const methods = task.kind === 'file'
    ? [async () => {
        signedTarget = await resolveFileRedirect(tabId, task.url, signal);
        await directTransfer(signedTarget, writable, signal, progress, 'omit');
      },
      () => signedTarget
        ? pageTransfer(tabId, signedTarget, writable, signal, progress)
        : Promise.reject(new Error('No signed download redirect was available.')),
      () => pageTransfer(tabId, task.url, writable, signal, progress),
      () => directTransfer(task.url, writable, signal, progress)]
    : [() => directTransfer(task.url, writable, signal, progress, 'omit'),
      () => pageTransfer(tabId, task.url, writable, signal, progress)];
  try {
    const failures = [];
    for (const method of methods) {
      try { await method(); failures.length = 0; break; }
      catch (error) {
        aborted(signal);
        if (isRateLimitError(error)) throw error;
        failures.push(error.message);
        await ownerTab(true);
        await writable.truncate(0);
        await writable.seek(0);
      }
    }
    if (failures.length) throw new Error(`Could not transfer asset: ${failures.join('; ')}`);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function permission(directory) {
  if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') {
    throw new Error('Folder access is needed to resume. Choose the original folder and allow access.');
  }
}

async function performDownload() {
  controller = new AbortController();
  running = true;
  job.status = 'running';
  job.lastError = null;
  transfers = { image: {}, file: {} };
  const checkpoint = createSerialQueue();
  const rateLimitGate = createRateLimitGate();
  const ordered = orderedDownloadTasks(job.tasks);

  async function runWorker(kind) {
    const phase = phaseElements[kind];
    const tasks = ordered.filter(task => task.kind === kind);
    const meter = createSpeedMeter();
    let lastUiUpdate = 0;
    if (!tasks.length) {
      phase.current.textContent = `No listing ${kind === 'image' ? 'images' : 'files'} to download.`;
      return;
    }
    for (const task of tasks) {
      aborted(controller.signal);
      if (task.done) continue;
      const retryOptions = {
        signal: controller.signal,
        gate: rateLimitGate,
        onRetry: (attempt, total, error) => {
          phase.current.textContent = isRateLimitError(error)
            ? `MyMiniFactory is busy. Retrying ${task.id.split('/').at(-1)} in five seconds…`
            : `Temporary transfer error. Retrying ${task.id.split('/').at(-1)} (${attempt}/${total})…`;
        },
      };
      let tabId = await retryAsset(() => ownerTab(), retryOptions);
      phase.current.textContent = `${task.listing} · ${task.id.split('/').at(-1)}`;
      let lastReceived = 0;
      transfers[kind] = { taskId: task.id, bytes: 0, speed: meter.speed() };
      const onProgress = (received, length) => {
        if (received < lastReceived) lastReceived = 0; // A fallback transfer restarted this asset.
        meter.add(received - lastReceived);
        lastReceived = received;
        transfers[kind] = { taskId: task.id, bytes: received, length, speed: meter.speed() };
        if (Date.now() - lastUiUpdate < 250) return;
        lastUiUpdate = Date.now();
        phase.current.textContent = `${task.listing} · ${(received / 1048576).toFixed(1)} MB` +
          (length ? ` / ${(length / 1048576).toFixed(1)} MB` : '');
        renderTransferStats();
      };
      try {
        let recheckOwner = false;
        await retryAsset(async () => {
          if (recheckOwner) tabId = await ownerTab(true);
          await saveAsset(task, tabId, controller.signal, onProgress);
          await ownerTab();
        }, {
          ...retryOptions,
          onRetry: (attempt, total, error) => {
            recheckOwner = true;
            retryOptions.onRetry(attempt, total, error);
          },
        });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error(`${kind === 'image' ? 'Image' : 'File'} for ${task.listing} (${task.id.split('/').at(-1)}): ${error.message}`);
      }
      aborted(controller.signal);
      await checkpoint(async () => {
        aborted(controller.signal);
        task.downloadedBytes = lastReceived;
        task.done = true;
        transfers[kind] = { speed: meter.speed() };
        await saveJob(job);
        await writeProgressFile(job);
        render();
      });
    }
    phase.current.textContent = `All listing ${kind === 'image' ? 'images' : 'files'} complete.`;
  }

  try {
    await saveJob(job);
    clearError();
    current.textContent = 'Downloading listing images and files…';
    render();
    await runConcurrentWorkers(['image', 'file'], runWorker, controller);
    await retryAsset(() => ownerTab(true), {
      signal: controller.signal, gate: rateLimitGate,
      onRetry: () => { current.textContent = 'Waiting for MyMiniFactory to allow the final account check…'; },
    });
    await checkpoint(async () => {
      job.status = 'complete';
      await saveJob(job);
      await writeProgressFile(job);
    });
    current.textContent = `Complete. ${job.tasks.length} assets saved in ${job.directory.name}.`;
  } catch (error) {
    controller.abort();
    await checkpoint(async () => {
      job.status = 'paused';
      job.lastError = error.name === 'AbortError' ? null : error.message;
      await saveJob(job).catch(() => {});
    });
    if (accountVerified && error.name !== 'AbortError') showError(error.message);
    if (accountVerified) current.textContent = 'Paused. Completed assets are saved; resume when ready.';
  } finally {
    running = false;
    controller = null;
    transfers = { image: {}, file: {} };
    render();
  }
}

async function runWithLock(prepare) {
  const version = authVersion;
  const promise = navigator.locks.request('3d-creator-toolkit-asset-downloader', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('The downloader is already running in another tab.');
    await prepare(version);
    if (version !== authVersion || !accountVerified) throw new Error(OWNER_ONLY_MESSAGE);
    await ownerTab(true);
    await performDownload();
  });
  activeRun = promise;
  try { await promise; }
  finally { if (activeRun === promise) activeRun = null; }
}

async function refreshAccount() {
  const version = ++authVersion;
  accountVerified = false;
  render();
  if (activeRun) await activeRun.catch(() => {});
  if (version !== authVersion) return;
  job = null;
  try {
    const actor = await signedInTab(true);
    if (version !== authVersion) return;
    const saved = await loadJob(actor.username) ?? await migrateLegacyJob(actor.username, version);
    if (version !== authVersion) return;
    accountUsername = actor.username;
    lastCookieFingerprint = await cookieFingerprint();
    if (version !== authVersion) return;
    job = saved;
    transfers = { image: {}, file: {} };
    accountVerified = true;
    if (job) await publishDownloadSummary(job.ownerUsername, job.directory, job.tasks, job.status);
    folderInfo.textContent = job ? `${job.directory.name} (saved folder)` : 'No folder selected yet.';
    csvInfo.textContent = job ? `${job.csvName} (saved job · ${job.listings} listings)` : 'No CSV selected yet.';
    clearError();
    render();
  } catch (error) {
    if (version !== authVersion) return;
    accountUsername = undefined;
    accountVerified = false;
    job = null;
    showError(error.message);
    render();
  }
}

function sessionChanged() {
  authVersion++;
  accountVerified = false;
  lastAuthenticatedTab = undefined;
  lastAuthenticatedUsername = undefined;
  lastAuthenticatedAt = 0;
  lastCookieFingerprint = undefined;
  controller?.abort();
  transfers = { image: {}, file: {} };
  csvText = undefined;
  csvName = undefined;
  chosenDirectory = undefined;
  csvInput.value = '';
  csvInfo.textContent = 'No CSV selected yet.';
  folderInfo.textContent = 'No folder selected yet.';
  clearError();
  render();
  void refreshAccount();
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.kind === 'MMF_SESSION_CHANGED') sessionChanged();
});

async function verifyOnReturn() {
  if (!accountVerified) { await refreshAccount(); return; }
  const version = authVersion;
  try {
    const fingerprint = await cookieFingerprint();
    if (version !== authVersion) return;
    if (fingerprint !== lastCookieFingerprint) { sessionChanged(); return; }
    const actor = await signedInTab(true);
    if (version !== authVersion) return;
    if (!sameOwner(actor.username, accountUsername)) { sessionChanged(); return; }
  } catch (error) { if (version === authVersion && !isRateLimitError(error)) sessionChanged(); }
}
window.addEventListener('focus', () => { void verifyOnReturn(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void verifyOnReturn();
});

csvInput.addEventListener('change', async () => {
  clearError();
  const file = csvInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = tasksFromCsv(text);
    csvText = text;
    csvName = file.name;
    csvInfo.textContent = `${file.name} · ${parsed.listings} listings · ${parsed.tasks.length} assets`;
  } catch (error) { csvText = undefined; showError(error.message); }
  render();
});

document.querySelector('#choose-folder').addEventListener('click', async () => {
  if (running || !accountVerified) return;
  clearError();
  try {
    if (!pickerAvailable) throw new Error(pickerHelpMessage);
    const version = authVersion;
    const directory = await window.showDirectoryPicker({ id: 'creator-toolkit-assets', mode: 'readwrite' });
    if (version !== authVersion || !accountVerified) return;
    if (job && typeof directory.isSameEntry === 'function' && await directory.isSameEntry(job.directory)) {
      chosenDirectory = directory;
      folderInfo.textContent = directory.name;
      render();
      return;
    }
    chosenDirectory = directory;
    job = null;
    transfers = { image: {}, file: {} };
    if (!csvText) csvInfo.textContent = 'No CSV selected yet.';
    folderInfo.textContent = chosenDirectory.name;
    await publishDownloadSummary(accountUsername, chosenDirectory, []);
  } catch (error) { if (error.name !== 'AbortError') showError(error.message); }
  render();
});

startButton.addEventListener('click', async () => {
  if (!accountVerified || !csvText || !chosenDirectory || running) return;
  startButton.disabled = true;
  try {
    await permission(chosenDirectory);
    const actor = await signedInTab(true);
    if (!sameOwner(actor.username, accountUsername)) throw new Error(OWNER_ONLY_MESSAGE);
    await runWithLock(async version => {
      await validateListingOwnership(tasksFromCsv(csvText).listingUrls, actor.username);
      if (version !== authVersion) throw new Error(OWNER_ONLY_MESSAGE);
      job = await prepareJob(csvText, csvName, chosenDirectory, actor.username);
    });
  } catch (error) { showError(error.message); render(); }
});

resumeButton.addEventListener('click', async () => {
  if (!accountVerified || !job || running) return;
  resumeButton.disabled = true;
  try {
    const directory = chosenDirectory ?? job.directory;
    await permission(directory);
    const actor = await signedInTab(true);
    if (!sameOwner(actor.username, job.ownerUsername)) throw new Error(OWNER_ONLY_MESSAGE);
    await runWithLock(async () => {
      const metadata = await readProgressFile(directory);
      if (!metadata && directory !== job.directory && job.tasks.some(task => task.done)) {
        throw new Error(`Choose the original folder containing ${PROGRESS_FILE} to resume.`);
      }
      job.directory = directory;
      await restoreCompleted(job, metadata);
      await saveJob(job);
    });
  } catch (error) { showError(error.message); render(); }
});

pauseButton.addEventListener('click', () => controller?.abort());

async function initialize() {
  if (!pickerAvailable) {
    const isBrave = typeof navigator.brave?.isBrave === 'function' && await navigator.brave.isBrave();
    document.querySelector('#picker-help').hidden = false;
    document.querySelector(isBrave ? '#brave-help' : '#other-browser-help').hidden = false;
    pickerHelpMessage = isBrave
      ? 'Enable the File System Access API at brave://flags/#file-system-access-api and relaunch Brave.'
      : 'Use a browser with the File System Access API to choose an arbitrary folder.';
  }
  await refreshAccount();
}
initialize().catch(error => showError(error.message));
