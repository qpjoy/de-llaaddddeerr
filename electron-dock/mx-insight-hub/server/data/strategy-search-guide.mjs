import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { WECHAT_SEARCH_OPERATION, WECHAT_SEARCH_PATH } from '../contracts/wechat-search-alias.mjs'
import { hubSocialAccountPlatforms } from '../contracts/hub-social-docs.mjs'
import { HUB_SOCIAL_COMPAT_ACTIVITIES } from '../contracts/hub-social-compat.mjs'

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
  const newlyDirectStandard = standard.filter(platform => ['reddit', 'youtube'].includes(platform))
  const noTitle = standard.filter(platform => ['twitter', 'facebook', 'weibo', 'instagram'].includes(platform))
  const wechat = scopes == null || scopes.some(scope => scope.platforms?.includes('social')
    && scope.capabilities?.includes(WECHAT_SEARCH_OPERATION))
  const accounts = ['crawl', 'user-info'].map(operation => ({ operation, platforms: hubSocialAccountPlatforms(operation, scopes) })).filter(row => row.platforms.length)
  return `<section class="doc-page" data-doc-page="strategy-search"><h1>策略搜索</h1>
    <p>面向监测策略的关键词搜索、账号内容与账号资料。调用方使用已授权的业务接口，不传 provider 或路由控制参数。产品可见不等于已开通全部接口，查看本文或保存管理配置不会新增权限；实际授权、额度、费用与可用性以当前 Key 为准。</p>
    ${rows ? `<h2>业务接口</h2><p>以下平台按当前授权范围列出。每类接口支持的平台不同；账号资料是查询已知账号，不是按关键词搜索账号。</p>
    <table><thead><tr><th>用途</th><th>接口</th><th>核心参数</th><th>返回重点</th><th>平台</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${examplePlatform ? `<h2>标准内容搜索</h2><p><code>POST /api/v1/data/search</code> 返回 <code>data.items</code> 与 <code>data.pageInfo</code>。普通内容搜索使用 <code>platform、query、pageSize</code>，与兼容接口的 <code>raw_data</code> JSON 字符串格式不同，调用方需按实际接口解析。</p>
    <pre>${escape(JSON.stringify({ platform: examplePlatform, query: '示例关键词', pageSize: 20 }, null, 2))}</pre>
    <p>标准内容平台：${standard.map(escape).join('、')}。不要只替换 URL 而保留另一接口的请求体或解析逻辑。响应中的 <code>metrics</code> 按合同区分已取得的 0 与未提供的 null，历史或上游默认 0 本身不能证明实测零值；<code>media.coverUrl/images/videos</code> 分别表示封面、图片和视频引用。${noTitle.length ? `${noTitle.map(escape).join('、')} 普通帖子不从正文生成标题，标准 title 为 null；` : ''}其他内容的原生视频或文章标题按对应平台合同保留。</p>` : ''}
    ${twitter ? `<h3>Twitter 搜索条件</h3><p><code>POST /api/v1/data/search</code> 与 <code>POST /api/v2/data/search</code> 的新 Twitter 查询默认 <code>params.category=Latest</code>，可覆盖为 Top、Latest、Photos 或 Videos。<code>params.filters</code> 可选，最多 2048 字；<code>params.includeTimestamp</code> 为布尔值，默认 false。<code>query</code> 仍必填，不支持只传 filters；People 返回账号，不属于此内容搜索合同。当前链路无法保留所选条件时返回 <code>twitter_search_parameters_unsupported</code>，不会丢弃条件继续查询。</p><pre>${escape(JSON.stringify({ platform: 'twitter', query: '示例关键词', pageSize: 20, type: 'stable', params: { category: 'Latest', includeTimestamp: false } }, null, 2))}</pre><p>v2 另外要求完整的 timeWindow，并使用独立的 mxds2 游标；不可交换 v1/v2 游标。下一页保持原 query、pageSize、type 和 params，原样回传顶层 cursor。新游标绑定所有搜索条件，旧游标及历史重放保留原条件与排序；不要向旧请求补写新默认值。</p><h3>Twitter 标准分页</h3><p>标准搜索先读已取得的余量，再自动补齐当前逻辑页并跨页去重；例如前页取得 24 条、已返回 20 条，下一次会将剩余 4 条与后续结果合并到最多 20 条。下游只传回 <code>data.pageInfo.nextCursor</code>。不再设置每次 Hub 请求默认 3 次的补页调用上限；原生 count 已不再受支持，不能用它限制上游返回条数；Hub 的 pageSize 独立控制本页交付与余量保存，不接受 params.count 或 params.cursor。整次查询最多 15 个上游页和 15 个公开页，游标有效期 24 小时。原截止时间、归档字节、授权与准入限制继续生效，触及边界时返回已有结果、partial 与警告；结果耗尽时可能自然不足一页。一个 Hub 请求仍按现有客户规则结算一次。旧 raw 与旧 crawl 转发入口未新增此补页行为。</p>` : ''}
    ${facebook ? `<h3>Facebook 标准分页</h3><p>标准搜索先读已取得的余量，再在原供应链内自动补齐并跨页去重；不再设置每次 Hub 请求默认 3 次的补页派发上限；15 个上游页／公开页、24 小时、截止时间、归档字节与准入边界继续生效。首次明确 429 的保底规则保留，其他已派发失败或未知结果不会为补齐而重试。原 raw 接口保持单上游页。短页仍按返回的 nextCursor 判断是否继续。可选日期窗口放在 <code>params.startTime/endTime</code> 或 <code>params.startDate/endDate</code>，上游按日期精度处理，精确时间仍由调用方过滤。</p>` : ''}
    ${standard.some(platform => ['bilibili', 'douyin', 'kuaishou', 'zhihu'].includes(platform)) ? `<h3>关键词搜索直连</h3><p>${standard.filter(platform => ['bilibili', 'douyin', 'kuaishou', 'zhihu'].includes(platform)).map(escape).join('、')} 的新关键词搜索由 Hub 执行，标准 items/pageInfo 与兼容 raw_info/raw_data 字符串格式分别保留。标准搜索余量优先、跨页去重，不再设置每请求默认 3 次的补页派发上限；15 个上游页／公开页、24 小时、截止时间、归档字节与准入边界继续生效，只传回 Hub 游标。params 只接受各平台固定合同中的过滤条件。历史已保存交付精确重放，旧历史服务游标的新采集须明确从第一页重启。账号内容与资料迁移范围不因关键词搜索改变；详情和评论附采不属于本轮关键词路径，显式附采参数会在采购前拒绝。</p>` : ''}
    ${newlyDirectStandard.length ? `<h3>标准内容搜索直连</h3><p>${newlyDirectStandard.map(escape).join('、')} 的新 <code>POST /api/v1/data/search</code> 请求由 Hub 直接执行，继续使用 platform、query、pageSize、type 与可选 cursor，保留 <code>data.contractVersion=night-all.data-search.v1</code>、items、pageInfo、status、warnings。合同名不会因内部执行位置改变。这些平台的标准请求继续拒绝 <code>params</code>，采用既有默认搜索条件；其他平台已支持的 params 不扩展到这些平台。两个 raw 入口 <code>/api/v1/search/raw</code> 与 <code>/api/v1/night-all/search/raw</code> 继续原链路及原参数合同；账号接口状态另列。</p>
    ${newlyDirectStandard.map(platform => `<pre>${escape(JSON.stringify({ platform, query: '示例关键词', pageSize: 20, type: 'stable' }, null, 2))}</pre>`).join('')}
    <p>新标准分页先消费已取得余量，按稳定条目身份去重后有界补齐。上限为 15 个上游页和 15 个公开页，Hub 游标有效 24 小时，并绑定当前 Key、查询、页大小和 type。只传回 <code>data.pageInfo.nextCursor</code>，不解析其中状态、不传原生 continuation。短页或 partial 应检查 hasMore、nextCursor 和 warnings；没有可用游标就停止自动续页，页大小不保证实际返回条数。</p>
    <p>已保存交付在原重放窗口内精确返回。旧 <code>mxnc1</code> 游标不能用于新直连采购；尚未交付的旧下一页返回 <code>409 search_restart_required</code>，不派发供应商请求。由调用方明确移除 cursor、使用新的 Idempotency-Key 从首页重启；不要自动重启。其他无效游标或参数返回 400。未知结果先只读核对，不能换键重购或回退旧 raw 路径。</p>` : ''}
    ${wechat ? `<h2>微信搜索</h2><p><code>POST /api/v1/data/search</code> 支持 <code>wechat_search</code>（别名 <code>wechat/weixin</code>）和 <code>wechat_mp</code>，与 <code>POST ${WECHAT_SEARCH_PATH}</code>、<code>POST /api/v1/search/raw</code> 共用当前授权、客户价格、余额与同一业务幂等身份。要求同一调用身份具有 <code>social + ${WECHAT_SEARCH_OPERATION}</code>；仅微信存量平台授权不能调用实时搜索。</p>
    <pre>${escape(JSON.stringify({ platform: 'wechat_search', query: '示例关键词', pageSize: 20, params: { raw: false } }, null, 2))}</pre>
    <p>微信保留已发布的专项响应：顶层 <code>contractVersion/endpoint/data/meta/requestId</code>，其中 <code>endpoint=wechat.search.search</code>。该分支不是普通平台的 <code>night-all.data-search.v1</code>，也不返回旧 <code>raw_data</code> 字符串。需要结果列表时显式传 <code>params.raw=false</code>，只读取 <code>data.items</code>；<code>data.categories</code> 是分类导航，不是搜索结果。公众号使用 <code>wechat_mp</code>，固定 <code>business_type=article</code>；其他分类、排序和时间条件使用专项接口已声明的 params。</p>
    <p>每次返回原生一页，不截断、不补齐；旧 <code>pageSize/count/limit</code> 仅接受默认提示 20，不承诺条数。微信分页读取 <code>data.continue_flag</code> 与 <code>data.cursor</code>，不读取 <code>data.pageInfo</code>。仅在继续标识为 true/1、没有 no_more 且存在新的非空 cursor 时，原样传入下一次请求，使用新的 Idempotency-Key。旧 <code>mxnc1</code> 游标、仅 offset 或仅 page 翻页、批量关键词与自动补详情均不能映射。</p>
    <p>微信的 <code>type=fresh/stable</code> 都沿用专项接口的永久幂等重放；同一业务参数和幂等键可跨上述三个可用路径重放，不重复采集或扣款。新采集需显式使用新键。<code>POST /api/v1/night-all/search/raw</code> 的微信分支已经返回 <code>410 wechat_search_route_retired</code>，不回退或恢复旧格式；原专项接口与其他微信数据产品继续保留。</p>` : ''}
    ${accounts.length ? `<h2>Hub 账号内容与资料</h2><p>新账号入口沿用已声明的账号标识及业务字段，由 Hub 执行。旧转发入口继续保留，下游切换需从第一页开始。以下只列出同一调用身份同时具有平台与操作授权的组合；普通内容搜索权限不会自动开放账号查询。</p>
    <table><thead><tr><th>用途</th><th>Hub 接口</th><th>所需操作授权</th><th>平台</th></tr></thead><tbody>${accounts.map(({ operation, platforms }) => `<tr><td>${operation === 'crawl' ? '账号内容' : '账号资料'}</td><td><code>POST /api/v1/data/social/${operation}</code></td><td><code>${operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'}</code></td><td>${platforms.map(escape).join('、')}</td></tr>`).join('')}</tbody></table>
    <h3>账号请求参数</h3><table><thead><tr><th>参数</th><th>兼容规则</th></tr></thead><tbody>
      <tr><td>platform</td><td>一次请求一个平台；响应使用规范平台名。不能把多个平台拼接在一个字符串中。</td></tr>
      <tr><td>username / usernames</td><td>用户名或同平台用户名列表；以该平台账号为准。</td></tr>
      <tr><td>userId / user_id / uid / userIds</td><td>平台账号 ID 或同平台 ID 列表；不同字段提交的账号会按身份去重，不把昵称当稳定 ID。</td></tr>
      <tr><td>url / urls / profileUrl / profile_url</td><td>对应平台的公开主页链接；禁止任意域名、内嵌凭据和自定义请求地址。</td></tr>
      <tr><td>channelId / channel_id / channelUrl / channel_url</td><td>频道标识或链接；按所选平台的已声明账号合同解析。</td></tr>
      <tr><td>count / pageSize / page_size / limit</td><td>逻辑页上限 1–500，仍受 Key 上限约束。账号内容优先 count、pageSize、page_size、limit；账号资料优先 limit、count、pageSize、page_size。pageSize 与 page_size 同时出现须一致。批量请求还有总工作量上限，不保证返回指定条数。</td></tr>
      <tr><td>cursor / page</td><td>首页省略 cursor，page 为 1；后续原样提交本接口 nextCursor，不能仅递增 page，也不能使用旧接口游标。</td></tr>
      <tr><td>params</td><td>仅接受对应平台已声明的账号与业务参数；未知字段、供应选择、原生游标、凭据和扩大调用量的控制参数会在执行前拒绝。</td></tr>
      <tr><td>includeRaw</td><td>仅 false 或省略；业务 raw_info/raw_data 字符串仍保留，不提供原始审计包。</td></tr>
      <tr><td>concurrency / cacheMaxAgeHours</td><td>分别兼容 1–20 和 0–720 的历史提示；不覆盖 Hub 实际并发、幂等与准入规则，不承诺强制缓存命中。</td></tr>
    </tbody></table>
    ${accounts.some(row => row.operation === 'crawl') ? `<p>账号内容默认 <code>activityTypes: ["posts"]</code>。多个账号与活动组合受总工作量上限约束。产品展示提供单账号 posts，接口调试可编辑批量请求。</p><table><thead><tr><th>平台</th><th>可用 activityTypes</th></tr></thead><tbody>${accounts.find(row => row.operation === 'crawl').platforms.map(platform => `<tr><td>${escape(platform)}</td><td><code>${(HUB_SOCIAL_COMPAT_ACTIVITIES[platform] || []).map(escape).join('、')}</code></td></tr>`).join('')}</tbody></table>` : ''}
    ${accounts.map(({ operation, platforms }) => `<h3>${operation === 'crawl' ? '账号内容' : '账号资料'}示例</h3><p><code>POST /api/v1/data/social/${operation}</code>；以下为参数示例，不代表账号存在或服务实时可用。</p><pre>${escape(JSON.stringify({ platform: platforms[0], username: 'example', ...(operation === 'crawl' ? { page_size: 20, activityTypes: ['posts'] } : {}) }, null, 2))}</pre>`).join('')}
    ${accounts.some(row => row.platforms.includes('twitter')) ? '<p>Twitter / X 账号自动识别，username/usernames/userId/userIds/user_id/uid 及 params 中对应账号别名使用相同规则：裸纯数字字符串按 1–19 位平台 ID 查询，含字母或下划线按 1–15 位用户名查询；纯数字用户名须加 @，或通过 url/urls 字段提交主页 URL。数字 ID 请作为字符串传输。产品展示无需选择账号字段；历史精确回执保持原响应，不自动重新采集。内部任务编号如 ui_batch_019 不证明存在同名平台账号；不存在或无法确认身份时返回明确错误，不能伪装成一条内容或分页耗尽。</p>' : ''}
    <h3>返回字段与续页</h3><p><code>data.items</code> 为已投影数组；<code>data.raw_info</code> 和 <code>data.raw_data</code> 保持 JSON 字符串。账号内容默认分别表示账号资料与内容，账号资料以 raw_info 为主。followers/following 的 items/raw_data 为关系账号，使用 objectType=user 和 user_id，不生成 content_id；raw_info 只包含目标账号与本页交付的关系账号。先判断实际类型再解析，不能对 items 再执行 JSON.parse，也不能把整个 raw_data 字符串当作一条内容。统一指标区分真实 0 和未提供的 null，完整业务字段保留在对应投影中。</p>
    <p><code>data.pageInfo</code> 与兼容 <code>data.page</code> 使用同一 hasMore/nextCursor。Hub 优先消费已有余量并去重，再按资源和准入限制继续获取。最多 15 个公开页、游标 24 小时有效；pageSize 是上限。短页、空页或 partial 都应检查游标和 warnings。没有可用游标时停止自动续页；若出现 pagination_completeness_unknown，即使 hasMore=false、nextCursor=null 也只是无法继续，不表示确认耗尽。下一页保持平台、账号、活动、过滤条件与页大小，原样回传游标并使用新 Idempotency-Key。</p>
    <p>遇到 400 invalid_cursor 或需明确重启的错误时，由调用方决定是否从第一页重新查询。429 不等于分页耗尽；超时或未知结果也不是空结果，先按原请求标识只读核对，不自动换键重发。分页不会切换到旧转发入口或跨供应链继续。</p>` : ''}
    <p>使用 <code>Authorization: Bearer &lt;Hub API Key&gt;</code> 与 <code>Idempotency-Key</code>。兼容接口的 <code>data.raw_info</code> 和 <code>data.raw_data</code> 是 JSON 字符串，须按实际响应解析；不能与标准接口的数组字段互换。表中未列出的平台与用途不由本文授予调用权限。</p>
    <h2>分页与策略变更</h2><p>标准接口原样传回 <code>data.pageInfo.nextCursor</code>，兼容接口原样传回 <code>data.page.nextCursor</code>；每个新页面使用新的 Idempotency-Key。保持原查询、页大小和 Key，不解析、拼接或跨平台复用游标。没有下一页游标时停止，不根据短页推断还有没有结果。</p>
    <p>新的搜索使用当前默认策略，已有可继续的分页沿用原链路。遇到 <code>409 search_restart_required</code> 或游标过期时，由调用方明确重新从第一页查询。更改配置不重新执行历史请求，也不修改既有响应或账单。</p>
    ${twitter || facebook || standard.includes('instagram') ? `<p>已有接口路径、标准数组和兼容 raw 字符串合同继续保留，不能跨路径或跨供应链转换旧游标。已保存交付仍在原窗口内精确重放，包括此前的空结果或失败。已退役或无法验证归属的历史游标可能要求重新从第一页开始，不代表所有旧分页都能无缝续接；不要改写旧游标或自动新建查询。</p>` : ''}
    <h2>失败与请求核对</h2><p>保存响应中的 requestId，用于查询该次请求状态。400 检查参数；403 检查授权；402 检查余额；429 检查限额；502/503 查看请求诊断。外部接口的 400 拒绝可能呈现为 Hub 502，不能仅凭状态码认定为某个参数错误。本文不承诺 400 或任何已派发请求失败后自动切换路由。</p>
    <p>处理中或结果未知时，只读核查请求状态与账本，不自动新建请求重试。幂等回放有有效窗口，不能将超时后反复 POST 视为永远免费或不会重新采集。</p>
    <p>管理端可按业务接口和目标平台选择已适配的路由。优先/保底只在其明确支持的条件下生效，不保证所有错误都自动换路。</p></section>`
}
