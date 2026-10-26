// Thin Microsoft Graph client: retries on throttling, follows paging, batches.
// Every write goes through Graph.mutate(), which is the single dry-run gate.

const BASE = 'https://graph.microsoft.com/beta';
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class GraphError extends Error {
  constructor(status, body, method, path) {
    const msg = (body && body.error && body.error.message) || (typeof body === 'string' ? body : '') || `HTTP ${status}`;
    super(msg);
    this.status = status;
    this.code = body && body.error && body.error.code;
    this.method = method;
    this.path = path;
  }
}

export class Graph {
  /**
   * @param {object} o
   * @param {() => Promise<string>} o.getToken
   * @param {object} [o.mock] demo backend with handle(method, url, body, headers)
   * @param {() => boolean} o.isDryRun
   * @param {(entry: object) => void} o.onWrite called for every write (real or simulated)
   * @param {{sessionToken: string}} [o.backend] local server.ps1 that holds the app credentials
   */
  constructor({ getToken, mock, backend, isDryRun, onWrite }) {
    this.getToken = getToken;
    this.mock = mock || null;
    this.backend = backend || null;
    this.isDryRun = isDryRun;
    this.onWrite = onWrite || (() => {});
  }

  url(path) {
    return /^https?:/i.test(path) ? path : BASE + (path.startsWith('/') ? path : '/' + path);
  }

  async send(method, path, { body, headers = {} } = {}) {
    const url = this.url(path);
    for (let attempt = 1; ; attempt++) {
      let status, resHeaders, json;
      if (this.mock) {
        await sleep(25 + Math.random() * 60);
        let h;
        ({ status, headers: h = {}, body: json } = this.mock.handle(method, url, body, headers));
        resHeaders = { get: k => h[k] ?? h[k.toLowerCase()] ?? null };
      } else {
        let target = url;
        let auth;
        if (this.backend) {
          // Same-origin proxy: https://graph.microsoft.com/beta/x -> /graph/beta/x
          target = url.replace(/^https:\/\/[^/]+\/(beta|v1\.0)\//i, '/graph/$1/');
          auth = { 'X-IAD-Session': this.backend.sessionToken };
        } else {
          auth = { Authorization: `Bearer ${await this.getToken()}` };
        }
        const res = await fetch(target, {
          method,
          headers: Object.assign(
            auth,
            body ? { 'Content-Type': 'application/json' } : {},
            headers
          ),
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });
        status = res.status;
        resHeaders = res.headers;
        const text = await res.text();
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      }
      if (status >= 200 && status < 300) return json;
      if (RETRY_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
        const ra = Number(resHeaders.get('Retry-After'));
        await sleep(ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      throw new GraphError(status, json, method, path);
    }
  }

  get(path, headers) {
    return this.send('GET', path, { headers });
  }

  async getAll(path, { onPage, headers } = {}) {
    const out = [];
    let next = path;
    while (next) {
      const page = await this.send('GET', next, { headers });
      const items = (page && page.value) || [];
      out.push(...items);
      if (onPage) onPage(out.length);
      next = page && page['@odata.nextLink'];
    }
    return out;
  }

  /**
   * JSON $batch with automatic chunking (20 per call) and per-item retry on throttling.
   * @param {{id:string, method?:string, url:string, headers?:object, body?:object}[]} requests
   * @returns {Promise<Map<string, {status:number, body:any}>>}
   */
  async batch(requests, { onProgress } = {}) {
    const results = new Map();
    let queue = requests.map(r => ({ method: 'GET', ...r, url: r.url.replace(/^\//, '') }));
    let done = 0;
    for (let round = 1; queue.length && round <= MAX_ATTEMPTS; round++) {
      const retry = [];
      let wait = 0;
      for (let i = 0; i < queue.length; i += 20) {
        const chunk = queue.slice(i, i + 20);
        const res = await this.send('POST', '/$batch', { body: { requests: chunk } });
        for (const r of (res && res.responses) || []) {
          if (RETRY_STATUS.has(r.status) && round < MAX_ATTEMPTS) {
            retry.push(chunk.find(c => c.id === r.id));
            const ra = Number((r.headers && (r.headers['Retry-After'] || r.headers['retry-after'])) || 0);
            wait = Math.max(wait, ra * 1000 || 2000 * round);
          } else {
            results.set(r.id, { status: r.status, body: r.body });
            done++;
          }
        }
        if (onProgress) onProgress(done, requests.length);
      }
      queue = retry.filter(Boolean);
      if (queue.length) await sleep(Math.min(wait, 30000));
    }
    return results;
  }

  /**
   * The only path for writes. In dry-run it records what would happen and returns.
   * @param {string} method DELETE | POST | PATCH
   * @param {string} path
   * @param {object} meta  { action, target, targetId, detail }
   */
  async mutate(method, path, meta, body) {
    const dry = this.isDryRun();
    const entry = { ...meta, method, path, mode: dry ? 'DRY' : 'LIVE' };
    if (dry) {
      this.onWrite({ ...entry, result: 'simulated' });
      return { dry: true };
    }
    try {
      const res = await this.send(method, path, { body });
      this.onWrite({ ...entry, result: 'success' });
      return { dry: false, res };
    } catch (e) {
      // A 404 on DELETE means the object is already gone: that is the desired end state.
      if (method === 'DELETE' && e.status === 404) {
        this.onWrite({ ...entry, result: 'already gone', detail: 'Object not found (404)' });
        return { dry: false, gone: true };
      }
      this.onWrite({ ...entry, result: 'failed', detail: `${e.status || ''} ${e.message}`.trim() });
      throw e;
    }
  }
}

/** Run async jobs with bounded concurrency. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { ok: true, value: await fn(items[idx], idx) }; }
      catch (e) { results[idx] = { ok: false, error: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}
