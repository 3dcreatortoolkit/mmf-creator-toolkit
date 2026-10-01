const BASE_URL = 'https://www.myminifactory.com';

export function parseSettingsProfile(html, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(html, 'text/html');
  const username = doc.querySelector('input[name="user_profile_type[username]"]')
    ?.getAttribute('value')?.trim();
  if (!username) return null;

  const avatar = doc.querySelector('.avatar-container img[alt="User avatar"]')?.getAttribute('src');
  let avatarUrl = null;
  if (avatar) {
    try {
      const url = new URL(avatar, BASE_URL);
      if (url.protocol === 'https:' &&
          (url.hostname === 'myminifactory.com' || url.hostname.endsWith('.myminifactory.com'))) {
        avatarUrl = url.href;
      }
    } catch { /* A missing or malformed avatar uses the popup's initial fallback. */ }
  }
  return { username, avatarUrl };
}
