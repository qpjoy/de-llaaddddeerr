// Format examples for the documented native envelope. Empty collections,
// missing counts and partial batch results do not imply complete source coverage.
const object = { type: 'object', additionalProperties: true }
const list = { type: 'array', items: object }
const nullable = { type: ['object', 'null'], additionalProperties: true }
const cursor = { type: ['string', 'null'] }
const username = 'example.account', code = 'C8O-JbtAKrp'
const sampleUser = { pk: '42', id: '42', username, follower_count: 0 }
const samplePost = { id: '3390920896561588969', code, username, text: '示例帖子', taken_at: 1700000000, like_count: 0 }
const examples = {
  search_posts: [{ query: '自行车' }, { results: [], cursor: null }, { results: list, cursor }],
  user_detail: [{ username }, { user: sampleUser }, { user: nullable }],
  user_detail_with_biolink: [{ username }, { user: sampleUser }, { user: nullable }],
  search_users: [{ query: 'example', count: 10 }, { results: [] }, { results: list }],
  user_posts: [{ username }, { posts: [], cursor: null }, { posts: list, cursor }],
  post_detail: [{ code }, { post: samplePost }, { post: object }],
  resolve_post: [{ reference: code }, { code, url: `https://www.threads.com/t/${code}`, existenceVerified: false },
    { code: { type: 'string' }, url: { type: 'string' }, existenceVerified: { const: false } }],
  post_media: [{ url: `https://www.threads.com/@${username}/post/${code}` }, null, {}],
  profiles_batch: [{ usernames: 'example.account,second.account' }, { items: [
    { username, status: 'ok', data: sampleUser }, { username: 'second.account', status: 'error', data: null },
  ] }, { items: list, requested: { description: '供应商回显的批量请求信息。' } }],
}

const operationNotes = {
  search_posts: '帖子按来源顺序放在 data.data.results。续页传回同一查询的 data.data.cursor。游标为 null 或数据页为空时结束。',
  user_detail: 'data.data.user 是返回的公开账号。账号查不到时该字段可能为 null。',
  user_detail_with_biolink: '公开简介中的链接是可选字段。账号拥有链接时查看 data.data.user 中的来源字段。',
  search_users: '账号候选在 data.data.results 中。count 默认 10，此接口返回单页。',
  user_posts: 'data.data.posts 包含完整来源会话条目。一个条目可以包含多条帖子。续页使用账号页的 data.data.cursor。',
  post_detail: 'data.data.post 提供帖子身份、正文、作者及可用指标。按链接或短码查询，同时提供时优先使用 url。',
  resolve_post: '按链接或短码取得规范化标识。existenceVerified 恒为 false，表示仅完成语法转换。',
  post_media: '返回帖子标识及图片、视频或轮播媒体的可用版本，可含尺寸和媒体类型。纯文本帖可没有媒体链接，媒体地址可能过期。',
  profiles_batch: '一次按输入顺序查询最多三个用户名。逐项读取 data.data.items 的 username、status、data。个别资料不可用时该项的 data 可为 null，其余结果可继续使用。',
}

export function threadsScraperNativeDocs(row) {
  if (row.marketplace !== 'threads-scraper') return null
  const name = row.key.slice('r.threads_scraper_'.length)
  const [params, data, properties] = examples[name]
  const description = `${operationNotes[name]} Hub 返回完整的业务响应。请检查 data.status，HTTP 200 也可能包含 status=error。示例用于说明格式，未提供的字段可能为空或省略。`
  const nativeBody = { type: 'object', additionalProperties: true, properties: {
    status: { type: 'string' }, request_id: { type: 'string' }, data: { type: ['object', 'null'], properties, additionalProperties: true },
  } }
  const body = payload => ({ contractVersion: 'mx-insight-hub.native-forwarding.v1', endpoint: row.key,
    data: payload, meta: { capturedAt: '2026-11-13T00:00:00.000Z', projection: 'native', pagination: 'explicit_parameters' },
    requestId: '00000000-0000-4000-8000-000000000001' })
  return { description, params,
    ...(name === 'post_detail' || name === 'post_media' ? { paramsConstraints: { anyOf: [{ required: ['url'] }, { required: ['code'] }] } } : {}),
    response: { 'application/json': { schema: { type: 'object', properties: {
      contractVersion: { type: 'string' }, endpoint: { const: row.key }, requestId: { type: 'string' }, meta: object, data: nativeBody,
    }, required: ['contractVersion', 'endpoint', 'data', 'meta'] }, examples: {
      ...(data === null ? {} : { ok: { summary: '业务成功（格式示例）', value: body({ status: 'ok', data }) } }),
      error: { summary: 'HTTP 200 内的供应商错误（格式示例）', value: body({ status: 'error', data: null }) },
    } } },
  }
}
