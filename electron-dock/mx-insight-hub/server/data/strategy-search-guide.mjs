import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const XIAOHONGSHU_CAPABILITIES = { raw: 'social.posts.search', crawl: 'social.users.posts', 'user-info': 'social.users.resolve' }

export function strategySearchGuide(scopes = null) {
  // Document existing effective scopes only. Platform and operation capability
  // must belong to the same scope; this view never grants or merges Key rights.
  const platforms = operation => NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[operation].filter(platform =>
    scopes == null || scopes.some(scope => scope.platforms?.includes(platform)
      && (platform !== 'xiaohongshu' || scope.capabilities?.includes(XIAOHONGSHU_CAPABILITIES[operation]))))
  const rows = [
    ['关键词搜索', 'raw', 'platform + keyword / query', 'raw_data：内容列表'],
    ['账号内容', 'crawl', 'platform + username / userId / uid', 'raw_info + raw_data：账号与内容'],
    ['账号资料', 'user-info', 'platform + username / userId / uid', 'raw_info：账号资料'],
  ].filter(([, operation]) => platforms(operation).length).map(([label, operation, params, output]) =>
    `<tr><td>${label}</td><td><code>POST /api/v1/night-all/search/${operation}</code><br><code>POST /api/v1/search/${operation}</code></td><td>${params}</td><td>${output}</td><td>${platforms(operation).map(escape).join('、')}</td></tr>`).join('')
  const standard = platforms('raw')
  const examplePlatform = standard.includes('instagram') ? 'instagram' : standard[0]
  return `<section class="doc-page" data-doc-page="strategy-search"><h1>策略搜索</h1>
    <p>面向监测策略的关键词搜索、账号内容与账号资料。调用方使用已授权的业务接口，不传 provider 或路由控制参数。产品可见不等于已开通全部接口，查看本文或保存管理配置不会新增权限；实际授权、额度、费用与可用性以当前 Key 为准。</p>
    <h2>业务接口</h2><p>以下平台按当前授权范围列出。每类接口支持的平台不同；账号资料是查询已知账号，不是按关键词搜索账号。</p>
    <table><thead><tr><th>用途</th><th>接口</th><th>核心参数</th><th>返回重点</th><th>平台</th></tr></thead><tbody>${rows}</tbody></table>
    ${examplePlatform ? `<h2>标准内容搜索</h2><p><code>POST /api/v1/data/search</code> 返回 <code>data.items</code> 与 <code>data.pageInfo</code>。普通内容搜索使用 <code>platform、query、pageSize</code>，与兼容接口的 <code>raw_data</code> JSON 字符串格式不同，调用方需按实际接口解析。</p>
    <pre>${escape(JSON.stringify({ platform: examplePlatform, query: '示例关键词', pageSize: 20 }, null, 2))}</pre>
    <p>标准内容平台：${standard.map(escape).join('、')}。不要只替换 URL 而保留另一接口的请求体或解析逻辑。</p>` : ''}
    <p>使用 <code>Authorization: Bearer &lt;Hub API Key&gt;</code> 与 <code>Idempotency-Key</code>。兼容接口的 <code>data.raw_info</code> 和 <code>data.raw_data</code> 是 JSON 字符串，须按实际响应解析；不能与标准接口的数组字段互换。表中未列出的平台与用途不由本文授予调用权限。</p>
    <h2>分页与策略变更</h2><p>标准接口原样传回 <code>data.pageInfo.nextCursor</code>，兼容接口原样传回 <code>data.page.nextCursor</code>；每个新页面使用新的 Idempotency-Key。保持原查询、页大小和 Key，不解析、拼接或跨平台复用游标。没有下一页游标时停止，不根据短页推断还有没有结果。</p>
    <p>新的搜索使用当前默认策略，已有可继续的分页沿用原链路。遇到 <code>409 search_restart_required</code> 或游标过期时，由调用方明确重新从第一页查询。更改配置不重新执行历史请求，也不修改既有响应或账单。</p>
    <h2>失败与请求核对</h2><p>保存响应中的 requestId，用于查询该次请求状态。400 检查参数；403 检查授权；402 检查余额；429 检查限额；502/503 查看请求诊断。外部接口的 400 拒绝可能呈现为 Hub 502，不能仅凭状态码认定为某个参数错误。本文不承诺 400 或任何已派发请求失败后自动切换路由。</p>
    <p>处理中或结果未知时，只读核查请求状态与账本，不自动新建请求重试。幂等回放有有效窗口，不能将超时后反复 POST 视为永远免费或不会重新采集。</p>
    <p>管理端可按业务接口和目标平台选择已适配的路由。优先/保底只在其明确支持的条件下生效，不保证所有错误都自动换路。</p></section>`
}
