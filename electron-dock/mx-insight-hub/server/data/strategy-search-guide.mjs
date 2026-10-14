import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { WECHAT_SEARCH_OPERATION, WECHAT_SEARCH_PATH } from '../contracts/wechat-search-alias.mjs'

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
  const twitter = standard.includes('twitter')
  const facebook = standard.includes('facebook')
  const noTitle = standard.filter(platform => ['twitter', 'facebook', 'weibo', 'instagram'].includes(platform))
  const wechat = scopes == null || scopes.some(scope => scope.platforms?.includes('social')
    && scope.capabilities?.includes(WECHAT_SEARCH_OPERATION))
  return `<section class="doc-page" data-doc-page="strategy-search"><h1>策略搜索</h1>
    <p>面向监测策略的关键词搜索、账号内容与账号资料。调用方使用已授权的业务接口，不传 provider 或路由控制参数。产品可见不等于已开通全部接口，查看本文或保存管理配置不会新增权限；实际授权、额度、费用与可用性以当前 Key 为准。</p>
    ${rows ? `<h2>业务接口</h2><p>以下平台按当前授权范围列出。每类接口支持的平台不同；账号资料是查询已知账号，不是按关键词搜索账号。</p>
    <table><thead><tr><th>用途</th><th>接口</th><th>核心参数</th><th>返回重点</th><th>平台</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${examplePlatform ? `<h2>标准内容搜索</h2><p><code>POST /api/v1/data/search</code> 返回 <code>data.items</code> 与 <code>data.pageInfo</code>。普通内容搜索使用 <code>platform、query、pageSize</code>，与兼容接口的 <code>raw_data</code> JSON 字符串格式不同，调用方需按实际接口解析。</p>
    <pre>${escape(JSON.stringify({ platform: examplePlatform, query: '示例关键词', pageSize: 20 }, null, 2))}</pre>
    <p>标准内容平台：${standard.map(escape).join('、')}。不要只替换 URL 而保留另一接口的请求体或解析逻辑。响应中的 <code>metrics</code> 按合同区分已取得的 0 与未提供的 null，历史或上游默认 0 本身不能证明实测零值；<code>media.coverUrl/images/videos</code> 分别表示封面、图片和视频引用。${noTitle.length ? `${noTitle.map(escape).join('、')} 普通帖子不从正文生成标题，标准 title 为 null；` : ''}其他内容的原生视频或文章标题按对应平台合同保留。</p>` : ''}
    ${twitter ? `<h3>Twitter 标准分页</h3><p>标准搜索先读已取得的余量，再自动补齐当前逻辑页并跨页去重；例如前页取得 24 条、已返回 20 条，下一次会将剩余 4 条与后续结果合并到最多 20 条。下游只传回 <code>data.pageInfo.nextCursor</code>。每次 Hub 请求最多 3 次上游调用，每次最多请求 50 条，整次查询最多 15 个上游页和 15 个公开页，游标有效期 24 小时。达到补齐预算或准入限制时返回已有结果、partial 与警告；结果耗尽时可能自然不足一页。一个 Hub 请求仍按现有客户规则结算一次。旧 raw、social、crawl 接口未新增此补页行为。</p>` : ''}
    ${facebook ? `<h3>Facebook 标准分页</h3><p>标准搜索先读已取得的余量，再在原供应链内自动补齐并跨页去重；一次 Hub 请求最多 3 次实际派发，首次明确 429 的保底请求也计入上限。原 raw 接口保持单上游页。短页仍按返回的 nextCursor 判断是否继续。可选日期窗口放在 <code>params.startTime/endTime</code> 或 <code>params.startDate/endDate</code>，上游按日期精度处理，精确时间仍由调用方过滤。</p>` : ''}
    ${standard.some(platform => ['bilibili', 'douyin', 'kuaishou', 'zhihu'].includes(platform)) ? `<h3>关键词搜索直连</h3><p>${standard.filter(platform => ['bilibili', 'douyin', 'kuaishou', 'zhihu'].includes(platform)).map(escape).join('、')} 的新关键词搜索由 Hub 执行，标准 items/pageInfo 与兼容 raw_info/raw_data 字符串格式分别保留。标准搜索余量优先、跨页去重、每请求最多 3 次上游派发；只传回 Hub 游标。params 只接受各平台固定合同中的过滤条件。历史已保存交付精确重放，旧历史服务游标的新采集须明确从第一页重启。账号内容与资料迁移范围不因关键词搜索改变；详情和评论附采不属于本轮关键词路径，显式附采参数会在采购前拒绝。</p>` : ''}
    ${wechat ? `<h2>微信搜索</h2><p><code>POST /api/v1/data/search</code> 支持 <code>wechat_search</code>（别名 <code>wechat/weixin</code>）和 <code>wechat_mp</code>，与 <code>POST ${WECHAT_SEARCH_PATH}</code>、<code>POST /api/v1/search/raw</code> 共用当前授权、客户价格、余额与同一业务幂等身份。要求同一调用身份具有 <code>social + ${WECHAT_SEARCH_OPERATION}</code>；仅微信存量平台授权不能调用实时搜索。</p>
    <pre>${escape(JSON.stringify({ platform: 'wechat_search', query: '示例关键词', pageSize: 20, params: { raw: false } }, null, 2))}</pre>
    <p>微信保留已发布的专项响应：顶层 <code>contractVersion/endpoint/data/meta/requestId</code>，其中 <code>endpoint=wechat.search.search</code>。该分支不是普通平台的 <code>night-all.data-search.v1</code>，也不返回旧 <code>raw_data</code> 字符串。需要结果列表时显式传 <code>params.raw=false</code>，只读取 <code>data.items</code>；<code>data.categories</code> 是分类导航，不是搜索结果。公众号使用 <code>wechat_mp</code>，固定 <code>business_type=article</code>；其他分类、排序和时间条件使用专项接口已声明的 params。</p>
    <p>每次返回原生一页，不截断、不补齐；旧 <code>pageSize/count/limit</code> 仅接受默认提示 20，不承诺条数。微信分页读取 <code>data.continue_flag</code> 与 <code>data.cursor</code>，不读取 <code>data.pageInfo</code>。仅在继续标识为 true/1、没有 no_more 且存在新的非空 cursor 时，原样传入下一次请求，使用新的 Idempotency-Key。旧 <code>mxnc1</code> 游标、仅 offset 或仅 page 翻页、批量关键词与自动补详情均不能映射。</p>
    <p>微信的 <code>type=fresh/stable</code> 都沿用专项接口的永久幂等重放；同一业务参数和幂等键可跨上述三个可用路径重放，不重复采集或扣款。新采集需显式使用新键。<code>POST /api/v1/night-all/search/raw</code> 的微信分支已经返回 <code>410 wechat_search_route_retired</code>，不回退或恢复旧格式；原专项接口与其他微信数据产品继续保留。</p>` : ''}
    <p>使用 <code>Authorization: Bearer &lt;Hub API Key&gt;</code> 与 <code>Idempotency-Key</code>。兼容接口的 <code>data.raw_info</code> 和 <code>data.raw_data</code> 是 JSON 字符串，须按实际响应解析；不能与标准接口的数组字段互换。表中未列出的平台与用途不由本文授予调用权限。</p>
    <h2>分页与策略变更</h2><p>标准接口原样传回 <code>data.pageInfo.nextCursor</code>，兼容接口原样传回 <code>data.page.nextCursor</code>；每个新页面使用新的 Idempotency-Key。保持原查询、页大小和 Key，不解析、拼接或跨平台复用游标。没有下一页游标时停止，不根据短页推断还有没有结果。</p>
    <p>新的搜索使用当前默认策略，已有可继续的分页沿用原链路。遇到 <code>409 search_restart_required</code> 或游标过期时，由调用方明确重新从第一页查询。更改配置不重新执行历史请求，也不修改既有响应或账单。</p>
    ${twitter || facebook || standard.includes('instagram') ? `<p>已有接口路径、标准数组和兼容 raw 字符串合同继续保留，不能跨路径或跨供应链转换旧游标。已保存交付仍在原窗口内精确重放，包括此前的空结果或失败。已退役或无法验证归属的历史游标可能要求重新从第一页开始，不代表所有旧分页都能无缝续接；不要改写旧游标或自动新建查询。</p>` : ''}
    <h2>失败与请求核对</h2><p>保存响应中的 requestId，用于查询该次请求状态。400 检查参数；403 检查授权；402 检查余额；429 检查限额；502/503 查看请求诊断。外部接口的 400 拒绝可能呈现为 Hub 502，不能仅凭状态码认定为某个参数错误。本文不承诺 400 或任何已派发请求失败后自动切换路由。</p>
    <p>处理中或结果未知时，只读核查请求状态与账本，不自动新建请求重试。幂等回放有有效窗口，不能将超时后反复 POST 视为永远免费或不会重新采集。</p>
    <p>管理端可按业务接口和目标平台选择已适配的路由。优先/保底只在其明确支持的条件下生效，不保证所有错误都自动换路。</p></section>`
}
