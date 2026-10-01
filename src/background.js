chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.kind !== 'MMF_EXPORT_STATUS' || !sender.tab?.id || !message.state) return;
  const state = message.state;
  chrome.storage.session.set({ [`tab_${sender.tab.id}`]: {
    stage: state.stage,
    completed: state.completed,
    total: state.total,
    percent: state.percent,
    detail: String(state.detail ?? '').slice(0, 500),
    outcome: state.outcome,
    signedOut: state.signedOut === true,
    includeFiles: state.includeFiles === true,
    creatorUsername: typeof state.creatorUsername === 'string' ? state.creatorUsername : null,
    running: state.running === true,
  } });
});

chrome.webRequest.onBeforeRedirect.addListener(details => {
  if (details.tabId < 0) return;
  let target;
  try { target = new URL(details.redirectUrl); }
  catch { return; }
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.myminifactory.com')) return;
  chrome.runtime.sendMessage({
    kind: 'MMF_ASSET_REDIRECT',
    tabId: details.tabId,
    from: details.url,
    to: details.redirectUrl,
  }).catch(() => {});
}, { urls: ['https://www.myminifactory.com/*'] });

chrome.cookies.onChanged.addListener(({ cookie }) => {
  // Remember-me cookie updates do not prove that the signed-in session changed.
  if (cookie.name !== 'PHPSESSID' ||
      !['myminifactory.com', '.myminifactory.com', 'www.myminifactory.com'].includes(cookie.domain)) return;
  chrome.runtime.sendMessage({ kind: 'MMF_SESSION_CHANGED' }).catch(() => {});
});
