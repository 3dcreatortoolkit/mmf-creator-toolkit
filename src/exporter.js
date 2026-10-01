import { parseSettingsProfile } from './settings-profile.js';
import { AssetHttpError, parseRetryAfter } from './download-retry.js';

const BASE = 'https://www.myminifactory.com';
const RETRYABLE = new Set([429, 502, 503, 504]);
export const SIGN_IN_MESSAGE = 'You must be logged in to MyMiniFactory to collect your listings.';
export const OWNER_ONLY_MESSAGE = 'You can export listings only for your signed-in MyMiniFactory creator account.';

export class Exporter {
  constructor({ fetchImpl = (url, options) => globalThis.fetch(url, options), report = () => {}, delayMs = 250 } = {}) {
    this.fetchImpl = fetchImpl;
    this.report = report;
    this.delayMs = delayMs;
    this.nextRequestAt = 0;
  }

  progress(stage, completed, total, detail = '') {
    this.report({ stage, completed, total, detail, creatorUsername: this.creatorUsername ?? null });
  }

  async request(path) {
    const url = new URL(path, BASE);
    if (url.origin !== BASE || !url.pathname.startsWith('/api/v2/')) {
      throw new Error('Refusing to request a URL outside the MyMiniFactory v2 API.');
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      this.nextRequestAt = Date.now() + wait + this.delayMs;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      let response;
      try {
        response = await this.fetchImpl(url.href, {
          credentials: 'include',
          redirect: 'manual',
          signal: AbortSignal.timeout(120_000),
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (response.status === 401 || response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)) throw new Error(SIGN_IN_MESSAGE);
      if (RETRYABLE.has(response.status) && attempt < 3) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        await new Promise(resolve => setTimeout(resolve,
          Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 30_000) : 500 * 2 ** attempt));
        continue;
      }
      if (response.status === 403) return { forbidden: true };
      if (!response.ok) throw new Error(`HTTP ${response.status} at ${url.pathname}.`);
      try { return JSON.parse(await response.text()); }
      catch { throw new Error(`MyMiniFactory returned an unexpected response at ${url.pathname}.`); }
    }
    throw new Error('Request retries exhausted.');
  }

  async checkSession(expectedUsername) {
    const response = await this.fetchImpl(`${BASE}/settings/profile`, {
      credentials: 'include', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(30_000), headers: { Accept: 'text/html' },
    });
    if (response.status === 429) {
      throw new AssetHttpError(429, 'MyMiniFactory is limiting requests (HTTP 429).',
        parseRetryAfter(response.headers.get('retry-after')));
    }
    if (!response.ok || response.type === 'opaqueredirect' ||
        new URL(response.url || `${BASE}/settings/profile`).pathname !== '/settings/profile') {
      throw new Error(SIGN_IN_MESSAGE);
    }
    const profile = parseSettingsProfile(await response.text());
    if (!profile) throw new Error(SIGN_IN_MESSAGE);
    if (expectedUsername !== undefined && profile.username.toLowerCase() !== expectedUsername.toLowerCase()) {
      throw new Error(OWNER_ONLY_MESSAGE);
    }
    return profile;
  }

  async getUser(username) {
    const user = await this.request(`/api/v2/users/${encodeURIComponent(username)}`);
    if (user.forbidden || !Number.isSafeInteger(user?.id) ||
        typeof user.username !== 'string' || typeof user.name !== 'string') {
      throw new Error('Could not read the creator details from the v2 API.');
    }
    if (user.username.toLowerCase() !== username.toLowerCase()) throw new Error(OWNER_ONLY_MESSAGE);
    return user;
  }

  async getObjects(username) {
    const objects = new Map();
    let page = 1;
    let total;
    do {
      const data = await this.request(`/api/v2/users/${encodeURIComponent(username)}/objects?page=${page}&per_page=5000`);
      if (data.forbidden || !Number.isSafeInteger(data.total_count) || !Array.isArray(data.items)) {
        throw new Error('Object API response format changed.');
      }
      total = data.total_count;
      for (const object of data.items) {
        if (!Number.isSafeInteger(object.id) || typeof object.name !== 'string' || typeof object.url !== 'string' ||
            typeof object.visibility_name !== 'string' || typeof object.listed !== 'boolean') {
          throw new Error('Object API returned an invalid listing.');
        }
        objects.set(String(object.id), object);
      }
      this.progress('store', objects.size, total,
        `Checked ${objects.size} of ${total} creator objects for public listings…`);
      if (objects.size < total && !data.items.length) throw new Error('Object pagination ended early.');
      page++;
      if (page > 1000) throw new Error('Object pagination limit exceeded.');
    } while (objects.size < total);
    return objects;
  }

  async getCollections(username) {
    const collections = new Map();
    let page = 1;
    let total;
    do {
      const data = await this.request(`/api/v2/users/${encodeURIComponent(username)}/collections?page=${page}&per_page=100`);
      if (data.forbidden || !Number.isSafeInteger(data.total_count) || !Array.isArray(data.items)) {
        throw new Error('Collections API response format changed.');
      }
      total = data.total_count;
      for (const collection of data.items) {
        if (!Number.isSafeInteger(collection.id) || typeof collection.name !== 'string' ||
            typeof collection.is_public !== 'boolean') {
          throw new Error('Collections API returned an invalid collection.');
        }
        collections.set(collection.id, collection);
      }
      this.progress('collections', collections.size, total,
        `Read ${collections.size} of ${total} creator collections…`);
      if (collections.size < total && !data.items.length) throw new Error('Collections pagination ended early.');
      page++;
      if (page > 1000) throw new Error('Collections pagination limit exceeded.');
    } while (collections.size < total);
    return collections;
  }

  async getAllFiles(objectId, expectedCount) {
    const files = [];
    let page = 1;
    do {
      const data = await this.request(`/api/v2/objects/${objectId}/files?page=${page}&per_page=5000`);
      if (data.forbidden || !Number.isSafeInteger(data.total_count) ||
          data.total_count !== expectedCount || !Array.isArray(data.items)) {
        throw new Error(`Could not retrieve the complete file list for object ${objectId}.`);
      }
      files.push(...data.items);
      if (!data.items.length && files.length < expectedCount) {
        throw new Error(`Files for object ${objectId} ended before the reported total.`);
      }
      page++;
      if (page > 1000) throw new Error(`File pagination limit exceeded for object ${objectId}.`);
    } while (files.length < expectedCount);
    return files;
  }

  async export({ includeFiles = false } = {}) {
    this.creatorUsername = undefined;
    this.progress('auth', 0, 1, 'Verifying your MyMiniFactory session…');
    const me = await this.checkSession();
    this.creatorUsername = me.username;
    this.progress('auth', 1, 1);

    this.progress('store', 0, 0, 'Reading the creator profile and finding public listings…');
    const username = me.username;
    const user = await this.getUser(username);
    const allObjects = await this.getObjects(username);
    const listings = [...allObjects.values()].filter(object => object.visibility_name === 'public' && object.listed);
    this.progress('store', allObjects.size, allObjects.size,
      `Found ${listings.length} public listings; ${allObjects.size - listings.length} other objects excluded.`);

    await this.checkSession(me.username);
    const imagesById = new Map();
    const categoriesById = new Map();
    const filesById = new Map();
    for (const [index, object] of listings.entries()) {
      if (!Array.isArray(object.images) || !Array.isArray(object.categories?.items)) {
        throw new Error(`Object ${object.id} has missing image or category data.`);
      }
      imagesById.set(object.id, [...new Set(object.images.map(image => image?.original?.url)
        .filter(url => typeof url === 'string' && url))]);
      categoriesById.set(object.id, [...new Set(object.categories.items.map(category => category?.name)
        .filter(name => typeof name === 'string' && name))]);
      if (includeFiles) {
        if (!Number.isSafeInteger(object.files?.total_count) || !Array.isArray(object.files?.items)) {
          throw new Error(`Object ${object.id} has missing file data.`);
        }
        const files = object.files.total_count === object.files.items.length
          ? object.files.items : await this.getAllFiles(object.id, object.files.total_count);
        if (files.length !== object.files.total_count || files.some(file =>
          typeof file?.filename !== 'string' || !file.filename ||
          typeof file.download_url !== 'string' || !file.download_url)) {
          throw new Error(`Object ${object.id} has an incomplete file list or missing download URL.`);
        }
        filesById.set(object.id, files.map(file => {
          const size = typeof file.size === 'string' && /^\d+$/.test(file.size)
            ? Number(file.size) : file.size;
          if (size != null && (!Number.isSafeInteger(size) || size < 0)) {
            throw new Error(`Object ${object.id} has an invalid file size.`);
          }
          return {
            filename: file.filename,
            download_url: file.download_url,
            size_bytes: size ?? null,
          };
        }));
      }
      this.progress('objects', index + 1, listings.length, object.name);
    }
    if (!listings.length) this.progress('objects', 0, 0, 'No public objects to enrich.');

    await this.checkSession(me.username);
    this.progress('collections', 0, 0, 'Reading collections from the v2 API…');
    const allCollections = await this.getCollections(username);
    const collections = new Map([...allCollections].filter(([, value]) => value.is_public === true));
    this.progress('collections', collections.size, collections.size,
      `Mapped ${collections.size} public collections to listings.`);

    const currencyCounts = new Map();
    for (const object of listings) {
      const currency = object.price?.currency;
      if (currency) currencyCounts.set(currency, (currencyCounts.get(currency) ?? 0) + 1);
    }
    const defaultCurrency = [...currencyCounts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'USD';
    const exportedAt = new Date().toISOString();
    const rows = [];
    for (const object of listings) {
      if (rows.length % 25 === 0) await this.checkSession(me.username);
      if ((object.description != null && typeof object.description !== 'string') ||
          (object.tags != null && !Array.isArray(object.tags)) ||
          !Array.isArray(object.user_collections) ||
          (object.tags ?? []).some(tag => typeof tag !== 'string')) {
        throw new Error(`Object ${object.id} has missing description, tags or collection data.`);
      }
      if (object.user_collections.some(id => !allCollections.has(id))) {
        throw new Error(`Object ${object.id} references a collection missing from the v2 response.`);
      }
      const collectionNames = object.user_collections
        .map(id => collections.get(id)?.name).filter(Boolean);
      const price = object.price;
      if (price !== null && price !== undefined &&
          ((typeof price.value !== 'string' && typeof price.value !== 'number') || typeof price.currency !== 'string')) {
        throw new Error(`Object ${object.id} has an invalid price.`);
      }
      rows.push({
        listing_type: 'object',
        name: object.name, url: object.url, price_amount: price?.value ?? '0',
        price_currency: price?.currency ?? defaultCurrency, is_free: price == null || Number(price?.value) === 0,
        description_text: object.description ?? '', tags_json: JSON.stringify([...new Set(object.tags ?? [])]),
        categories_json: JSON.stringify(categoriesById.get(object.id)),
        collections_json: JSON.stringify([...new Set(collectionNames)]),
        image_urls_json: JSON.stringify(imagesById.get(object.id)),
        ...(includeFiles ? { files_json: JSON.stringify(filesById.get(object.id)) } : {}),
        published_at: object.published_at ?? '',
        views: object.views ?? '', likes: object.likes ?? '', exported_at: exportedAt,
      });
      this.progress('details', rows.length, listings.length, object.name);
    }
    await this.checkSession(me.username);
    this.progress('download', 0, 1, 'Preparing your CSV…');
    return { rows, creatorUsername: username, collectionCount: collections.size, objectCount: allObjects.size,
      outsideStoreCount: allObjects.size - listings.length };
  }
}
