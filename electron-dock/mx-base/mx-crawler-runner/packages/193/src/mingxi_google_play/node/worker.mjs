import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import gplay from 'google-play-scraper';

const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const operation = config.operation;
const input = config.options;
let requests = 0;
let rejected = 0;
const sourceUrls = [];
const result = { status: 'error', data: { items: [], next_page_token: input.next_page_token || null, has_more: false },
  warnings: [], error: null, stats: { requests: 0, pages: 0, rejected: 0 }, source_urls: sourceUrls };

function save() {
  result.stats.requests = requests;
  result.stats.rejected = rejected;
  const file = path.join(config.output_dir, 'checkpoint.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(result));
  fs.renameSync(file + '.tmp', file);
}

function scrub(message) {
  let text = String(message);
  if (config.proxy) text = text.split(config.proxy).join('[proxy]');
  return text.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@').slice(0, 800);
}

function validItem(item) {
  if (operation === 'suggest' || operation === 'categories') return typeof item === 'string' && item.length > 0;
  if (!item || typeof item !== 'object') return false;
  if (operation === 'reviews') return !!(item.id && typeof item.text === 'string' && item.text.trim());
  if (operation === 'permissions') return !!item.permission;
  if (operation === 'datasafety') return !!(item.privacyPolicyUrl || item.collectedData?.length || item.sharedData?.length || item.securityPractices?.length);
  return !!(item.appId && item.title && (operation !== 'app' || item.developer));
}

function add(items) {
  if (!Array.isArray(items)) throw new Error('INVALID_PAYLOAD: expected an array');
  const seen = new Set(result.data.items.map(item => typeof item === 'string' ? item : item.id || item.appId));
  for (const item of items) {
    if (!validItem(item)) { rejected++; continue; }
    const key = typeof item === 'string' ? item : item.id || item.appId;
    if (key && seen.has(key)) continue;
    result.data.items.push(item);
    if (key) seen.add(key);
  }
}

const agent = config.proxy
  ? new HttpsProxyAgent(config.proxy, { keepAlive: true, maxSockets: 1 })
  : new https.Agent({ keepAlive: true, maxSockets: 1 });
const requestOptions = {
  timeout: { request: config.request_timeout * 1000 }, retry: { limit: 0 }, maxRedirects: 3,
  agent: { https: agent }, https: { rejectUnauthorized: true },
  hooks: {
    beforeRequest: [options => {
      if (requests >= config.max_requests) throw new Error('REQUEST_LIMIT: configured request budget reached');
      requests++;
      sourceUrls.push(options.url.toString());
    }],
    beforeRedirect: [options => {
      if (requests >= config.max_requests) throw new Error('REQUEST_LIMIT: configured request budget reached');
      requests++;
      sourceUrls.push(options.url.toString());
    }],
    afterResponse: [response => {
      if (response.rawBody.length > 16 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
      return response;
    }]
  }
};
const options = {
  appId: input.app_id, term: input.term, devId: input.developer_id,
  lang: input.lang, country: input.country, num: input.num || 20,
  fullDetail: false, requestOptions, throttle: 1
};

try {
  if (operation === 'reviews') {
    let token = input.next_page_token || null;
    const used = new Set();
    for (let page = 0; page < input.max_pages; page++) {
      if (token && used.has(token)) throw new Error('REPEATED_TOKEN: pagination did not advance');
      if (token) used.add(token);
      // Always return the whole source page: truncating to num would discard
      // reviews while returning a token pointing past those discarded records.
      const response = await gplay.reviews({ ...options, num: 150, paginate: true,
        sort: gplay.sort[input.sort.toUpperCase()], nextPaginationToken: token });
      add(response.data);
      token = response.nextPaginationToken || null;
      result.data.next_page_token = token;
      result.data.has_more = !!token;
      result.stats.pages++;
      result.status = result.data.items.length ? 'partial' : 'unknown';
      result.error = { code: 'IN_PROGRESS', message: 'Completed pages retained while fetching the requested page range.' };
      save();
      if (!token || !response.data.length) break;
    }
    if (result.data.has_more) result.warnings.push('Only the requested review pages were collected; use next_page_token with the same app, language, country and sort to continue.');
  } else {
    if (operation === 'list') {
      if (input.category && !gplay.category[input.category]) throw new Error('INVALID_CATEGORY');
      options.category = input.category ? gplay.category[input.category] : undefined;
      options.collection = gplay.collection[input.collection];
    }
    const data = await gplay[operation](options);
    // Upstream always appends APPLICATION, even if its page parser found nothing.
    if (operation === 'categories' && Array.isArray(data) && data.every(x => x === 'APPLICATION')) {
      result.warnings.push('Only the upstream fallback category was returned; real category extraction was not verified.');
    } else {
      add(['app', 'datasafety'].includes(operation) ? [data] : data);
    }
    result.stats.pages = 1;
  }
  result.status = result.data.items.length ? (rejected ? 'partial' : 'success') : 'unknown';
  result.error = result.status === 'success' ? null : { code: 'NO_VALID_RECORDS', message: 'Empty or incomplete data is not proof that an app is unavailable.' };
  if (rejected) result.warnings.push('Incomplete records were rejected; inspect rejected count.');
  if (operation === 'app' && result.data.items[0]?.version === 'VARY') result.warnings.push('Google Play returned a device-dependent version (VARY), not a specific version number.');
} catch (error) {
  result.status = result.data.items.length ? 'partial' : 'error';
  const message = scrub(error.message);
  result.error = { code: message.includes('REQUEST_LIMIT') ? 'REQUEST_LIMIT' : /timeout/i.test(message) ? 'REQUEST_TIMEOUT' : 'SOURCE_ERROR', message };
  if (result.data.items.length) result.warnings.push('The failed request did not discard already completed review pages.');
} finally {
  save();
  agent.destroy();
}
