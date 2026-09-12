// Public documentation example; never reads or embeds an actual key.
export const ecommerceFeedExample = String.raw`function createEcommerceFeed(hubUrl, apiKey, render) {
  let filters, historyCursor = null, historyStarted = false;
  let upstreamCursor = null, upstreamPage = 1, upstreamEnded = false;
  let queue = [], seen = new Set(), busy = false, pending = null;
  async function call(path, options = {}) {
    const response = await fetch(hubUrl + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json', ...options.headers }
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error?.message || 'Request failed'), { status: response.status, body });
    return body;
  }
  function show(items, edge) {
    const unique = items.filter(row => {
      const id = row.requestId + ':' + row.ordinal;
      if (seen.has(id)) return false; seen.add(id); return true;
    });
    render(unique, edge); // prepend preserves the array's internal order
  }
  async function history() {
    if (busy || (historyStarted && !historyCursor)) return;
    busy = true;
    try {
      const query = new URLSearchParams({ marketplace: filters.marketplace,
        query: filters.query || '', pageSize: String(filters.pageSize || 10) });
      for (const name of ['minPrice', 'maxPrice', 'from', 'to'])
        if (filters[name]) query.set(name, filters[name]);
      if (historyCursor) query.set('cursor', historyCursor);
      const result = await call('/api/v1/data/ecommerce/products/items?' + query);
      historyCursor = result.data.pageInfo.nextCursor; historyStarted = true;
      show(result.data.items, 'bottom');
    } finally { busy = false; }
  }
  async function pull() {
    if (busy) return;
    if (filters.marketplace === 'all') throw new Error('Choose one marketplace');
    if (queue.length) { show(queue.splice(0, filters.pageSize || 10), 'top'); return; }
    if (pending) throw new Error('Resolve the previous request before another paid dispatch');
    if (upstreamEnded) return;
    const body = { marketplace: filters.marketplace, query: filters.query, deliveryMode: 'refresh',
      ...(upstreamCursor ? { cursor: upstreamCursor } : { page: upstreamPage }) };
    if (['taobao', 'tmall', 'xianyu'].includes(filters.marketplace) && filters.sort) body.sort = filters.sort;
    if (['taobao', 'tmall'].includes(filters.marketplace) && (filters.minPrice || filters.maxPrice))
      body.price = { ...(filters.minPrice ? { min: filters.minPrice } : {}), ...(filters.maxPrice ? { max: filters.maxPrice } : {}) };
    const key = 'feed-' + crypto.randomUUID();
    pending = { key, body }; // retain this exact record on any error; never store apiKey
    busy = true;
    try {
      const result = await call('/api/v1/data/ecommerce/products/search', {
        method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body)
      });
      queue = result.data.items.map((product, index) => ({ product, requestId: result.requestId,
        ordinal: index + 1, capturedAt: result.meta.capturedAt }));
      upstreamCursor = result.data.page.nextCursor;
      upstreamPage = result.data.page.page + 1;
      upstreamEnded = result.data.page.hasMore === false || upstreamPage > 1000
        || (filters.marketplace === 'xiaohongshu_ec' && !upstreamCursor);
      pending = null;
      show(queue.splice(0, filters.pageSize || 10), 'top');
    } finally { busy = false; } // rejected or ambiguous request remains pending
  }
  return {
    async reset(nextFilters) {
      if (busy || pending) throw new Error('Finish/reconcile current request first');
      filters = { pageSize: 10, ...nextFilters };
      historyCursor = upstreamCursor = null; historyStarted = upstreamEnded = false;
      upstreamPage = nextFilters.page || 1; queue = []; seen.clear();
      render([], 'reset'); await history();
    },
    history, pull,
    async status() {
      if (!pending) return null;
      return call('/api/v1/requests/by-idempotency-key', { headers: { 'Idempotency-Key': pending.key } });
    },
    // On errors: inspect status; committed permits exact replay; reserved means wait.
    // unknown needs the documented explicit controlled retry, never an automatic new key.
    pendingRequest: () => pending
  };
}`
