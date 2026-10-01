export function isMmfTab(tab) {
  if (!tab?.id || !tab.url) return false;
  try { return new URL(tab.url).origin === 'https://www.myminifactory.com'; }
  catch { return false; }
}

export async function listMmfTabs(chromeApi = chrome) {
  const tabs = await chromeApi.tabs.query({ url: 'https://www.myminifactory.com/*' });
  return tabs.filter(isMmfTab).sort((left, right) =>
    Number(right.active) - Number(left.active) || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
}

export async function sendToMmfTab(tabId, message, chromeApi = chrome) {
  try { return await chromeApi.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/receiving end does not exist/i.test(error.message)) throw error;
    // Reloading an unpacked extension leaves already-open site tabs without its new content script.
    await chromeApi.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chromeApi.tabs.sendMessage(tabId, message);
  }
}
