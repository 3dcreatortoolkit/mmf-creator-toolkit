import {progressPercent, STAGES} from './progress.js';
import {SIGN_IN_MESSAGE} from './exporter.js';
import {isMmfTab, listMmfTabs, sendToMmfTab} from './mmf-tabs.js';

const button = document.querySelector('#start');
const buttonLabel = document.querySelector('#button-label');
const filesCheckbox = document.querySelector('#include-files');
const retry = document.querySelector('#check-again');
const signIn = document.querySelector('#sign-in');
const alert = document.querySelector('#alert');
const activity = document.querySelector('#activity');
const percent = document.querySelector('#percent');
const fill = document.querySelector('#progress-fill');
const track = document.querySelector('#progress-track');
const creatorInput = document.querySelector('#creator-input');
const avatar = document.querySelector('#creator-avatar');
const avatarFallback = document.querySelector('#creator-avatar-fallback');
const steps = document.querySelector('#steps');
const collectTab = document.querySelector('#collect-tab');
const downloadTab = document.querySelector('#download-tab');
const collectPanel = document.querySelector('#collect-panel');
const downloadPanel = document.querySelector('#download-panel');
const downloadSummary = document.querySelector('#download-summary');

let tabId;
let authenticated = false;
let creatorUsername;
let authCheckVersion = 0;
let downloadJobSummaries = {};
let current = {stage: 'auth', completed: 0, total: 1, outcome: 'checking', detail: 'Checking your sign-in…'};

function resetAvatar() {
    avatar.removeAttribute('src');
    avatar.hidden = true;
    avatarFallback.hidden = false;
    avatarFallback.textContent = '?';
}

function setAvatar(username, rawUrl) {
    avatarFallback.textContent = username[0]?.toUpperCase() ?? '?';
    avatar.alt = `Avatar for @${username}`;
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return;
    }
    if (url.protocol !== 'https:' ||
        !(url.hostname === 'myminifactory.com' || url.hostname.endsWith('.myminifactory.com'))) return;
    avatar.onload = () => {
        if (creatorUsername !== username || avatar.src !== url.href) return;
        avatar.hidden = false;
        avatarFallback.hidden = true;
    };
    avatar.onerror = () => {
        if (creatorUsername !== username) return;
        avatar.hidden = true;
        avatarFallback.hidden = false;
    };
    avatar.src = url.href;
}

function selectTab(which) {
    const downloading = which === 'download';
    collectTab.setAttribute('aria-selected', String(!downloading));
    downloadTab.setAttribute('aria-selected', String(downloading));
    collectPanel.hidden = downloading;
    downloadPanel.hidden = !downloading;
}

function showDownloadSummary(summary) {
    downloadSummary.textContent = summary
        ? `${summary.status === 'running' ? 'Running or interrupted' : summary.status === 'complete' ? 'Complete' : 'Ready to resume'}: ${summary.completed} of ${summary.total} assets in ${summary.folder}.`
        : 'No download job started yet.';
    document.querySelector('#download-phase-progress').hidden = !summary?.images || !summary?.files;
    for (const [kind, data] of [['images', summary?.images], ['files', summary?.files]]) {
        if (!data) continue;
        const percent = data.total ? Math.round(data.completed * 100 / data.total) : 0;
        document.querySelector(`#popup-${kind}-count`).textContent = `${data.completed} / ${data.total}`;
        document.querySelector(`#popup-${kind}-fill`).style.width = `${percent}%`;
        document.querySelector(`#popup-${kind}-track`).setAttribute('aria-valuenow', String(percent));
    }
}

for (const [index, item] of STAGES.entries()) {
    const step = document.createElement('li');
    step.className = 'step';
    step.dataset.stage = item.id;
    const icon = document.createElement('span');
    icon.className = 'step-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'step-copy';
    label.textContent = item.label;
    const count = document.createElement('span');
    count.className = 'step-count';
    step.append(icon, label, count);
    steps.append(step);
}

function show(value) {
    if (value.signedOut) {
        authenticated = false;
        creatorUsername = undefined;
        creatorInput.value = '';
        resetAvatar();
        showDownloadSummary(null);
        value = {
            stage: 'auth', completed: 0, total: 1, percent: 0, outcome: 'error',
            running: false, signedOut: true, detail: SIGN_IN_MESSAGE
        };
    }
    current = value;
    if (typeof value.includeFiles === 'boolean') filesCheckbox.checked = value.includeFiles;
    const activeIndex = STAGES.findIndex(item => item.id === value.stage);
    const progress = Number.isFinite(value.percent) ? value.percent : progressPercent(value);
    percent.textContent = `${progress}%`;
    fill.style.width = `${progress}%`;
    track.setAttribute('aria-valuenow', String(progress));
    track.dataset.active = value.outcome === 'running' || value.outcome === 'checking' ? 'true' : 'false';
    const failed = value.outcome === 'error';
    const complete = value.outcome === 'complete';
    for (const [index, step] of [...steps.children].entries()) {
        const state = complete || (activeIndex >= 0 && index < activeIndex) ? 'done'
            : index === activeIndex && failed ? 'error'
                : index === activeIndex && ['running', 'checking'].includes(value.outcome) ? 'active' : 'pending';
        step.dataset.state = state;
        step.querySelector('.step-icon').textContent = state === 'done' ? '✓' : state === 'error' ? '!' : String(index + 1);
        step.querySelector('.step-count').textContent = index === activeIndex && value.total > 0 && !failed && !complete
            ? `${value.completed ?? 0} / ${value.total}` : '';
    }
    activity.textContent = complete ? 'Your CSV is ready in Downloads.'
        : failed ? 'Export paused. No partial CSV was saved.'
            : value.detail || STAGES[activeIndex]?.hint || 'Ready to export.';
    alert.hidden = !failed;
    if (failed) alert.textContent = value.detail || 'The export could not be completed.';
    const needsLogin = value.signedOut === true;
    document.querySelector('.card').dataset.signedOut = needsLogin ? 'true' : 'false';
    document.querySelector('.file-option').hidden = needsLogin;
    signIn.hidden = !needsLogin;
    retry.hidden = !needsLogin;
    button.disabled = !creatorUsername || !authenticated || value.running === true || value.outcome === 'checking';
    filesCheckbox.disabled = value.running === true || value.outcome === 'checking';
    buttonLabel.textContent = complete ? 'Export again' : 'Export CSV';
}

async function checkSignIn() {
    const version = ++authCheckVersion;
    authenticated = false;
    creatorUsername = undefined;
    creatorInput.value = '';
    resetAvatar();
    showDownloadSummary(null);
    show({stage: 'auth', completed: 0, total: 1, outcome: 'checking', detail: 'Checking your MyMiniFactory sign-in…'});
    try {
        const response = await sendToMmfTab(tabId, {kind: 'MMF_AUTH_CHECK'});
        if (version !== authCheckVersion) return;
        authenticated = response?.authenticated === true && typeof response.username === 'string' && !!response.username;
        if (!authenticated) {
            show({
                stage: 'auth', completed: 0, total: 1, outcome: 'error',
                detail: response?.signedOut ? SIGN_IN_MESSAGE : response?.message || 'Could not check your sign-in. Refresh the creator tab and try again.',
                signedOut: response?.signedOut === true
            });
            return;
        }
        creatorUsername = response.username;
        creatorInput.value = creatorUsername;
        setAvatar(creatorUsername, response.avatarUrl);
        showDownloadSummary(downloadJobSummaries[creatorUsername.toLowerCase()]);
        const saved = await chrome.storage.session.get(`tab_${tabId}`);
        if (version !== authCheckVersion) return;
        const previous = saved[`tab_${tabId}`];
        show(previous?.creatorUsername?.toLowerCase() === creatorUsername.toLowerCase() &&
        (previous.outcome === 'running' || previous.outcome === 'complete')
            ? previous : {
                stage: null,
                completed: 0,
                total: 0,
                outcome: 'ready',
                detail: `Signed in as @${creatorUsername}. Ready to collect your listings.`
            });
    } catch {
        if (version !== authCheckVersion) return;
        authenticated = false;
        show({
            stage: 'auth', completed: 0, total: 1, outcome: 'error',
            detail: 'Could not check your sign-in. Refresh the creator tab and try again.'
        });
    }
}

async function initialize() {
    show(current);
    ({downloadJobSummaries = {}} = await chrome.storage.local.get('downloadJobSummaries'));
    showDownloadSummary(null);
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    const mmfTabs = await listMmfTabs();
    const tab = isMmfTab(activeTab) ? activeTab : mmfTabs[0];
    tabId = tab?.id;
    if (!tabId) {
        creatorInput.placeholder = 'Open a MyMiniFactory tab';
        show({
            stage: null, completed: 0, total: 0, outcome: 'error',
            detail: 'Open a signed-in MyMiniFactory tab to start the export.'
        });
        return;
    }
    await checkSignIn();
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.downloadJobSummaries) {
        downloadJobSummaries = changes.downloadJobSummaries.newValue ?? {};
        showDownloadSummary(authenticated && creatorUsername
            ? downloadJobSummaries[creatorUsername.toLowerCase()] : null);
    }
    if (area === 'session' && authenticated && changes[`tab_${tabId}`]?.newValue) {
        show(changes[`tab_${tabId}`].newValue);
    }
});

chrome.runtime.onMessage.addListener(message => {
    if (message?.kind === 'MMF_SESSION_CHANGED' && tabId) checkSignIn();
});

button.addEventListener('click', async () => {
    if (!authenticated || !creatorUsername || current.running) return;
    const includeFiles = filesCheckbox.checked === true;
    show({
        stage: 'auth', completed: 0, total: 1, outcome: 'checking', includeFiles,
        detail: 'Verifying your session before collecting anything…'
    });
    try {
        const response = await sendToMmfTab(tabId, {kind: 'MMF_EXPORT_START', includeFiles});
        if (response?.error) throw new Error(response.error);
        if (!response?.started) throw new Error('The export did not start. Refresh the creator tab and try again.');
        show({
            stage: 'auth', completed: 0, total: 1, outcome: 'running', running: true, includeFiles,
            detail: 'Verifying your MyMiniFactory session…'
        });
    } catch (error) {
        show({stage: 'auth', completed: 0, total: 1, outcome: 'error', detail: error.message});
    }
});

retry.addEventListener('click', checkSignIn);
collectTab.addEventListener('click', () => selectTab('collect'));
downloadTab.addEventListener('click', () => selectTab('download'));
document.querySelector('#open-downloader').addEventListener('click', async () => {
    const url = chrome.runtime.getURL('downloader.html');
    const existing = (await chrome.tabs.query({url}))[0];
    if (existing) await chrome.tabs.update(existing.id, {active: true});
    else await chrome.tabs.create({url});
});
initialize().catch(() => show({
    stage: null, outcome: 'error',
    detail: 'Could not open the exporter. Refresh the creator tab and try again.'
}));
