// File datasets ("文件数据集"): versioned PostgreSQL datasets cleaned from a
// large operator file on the server. Queries read a published version only;
// nothing here triggers live collection, Elasticsearch, HanLP or embeddings.
//
// Browser-safe: shared by the Admin UI, the public catalogue and the server.
// The server adds the parsing/storage "kind" for each key in
// server/data/file-datasets/registry.mjs.

export const FILE_DATASET_NAV_SECTION = 'file-datasets'
export const FILE_DATASET_NAV_LABEL = '文件数据集'
export const FILE_DATASET_NAV_DESCRIPTION = '服务器文件清洗入库 · 版本化查询'
// '@' cannot start a deployment-defined import root ID.
export const HOST_FILE_ROOT_ID = '@internal-host'

const define = dataset => Object.freeze({
  ...dataset,
  searchPath: `${dataset.apiBase}/search`,
  metadataPath: `${dataset.apiBase}/metadata`,
  // Personal data: only Keys whose scopes were chosen explicitly may carry these.
  scopes: Object.freeze([dataset.platform, dataset.searchCapability, ...(dataset.legacyCapabilities || [])]),
  defaultSource: Object.freeze(dataset.defaultSource),
})

export const FILE_DATASETS = Object.freeze([
  define({
    key: 'twitter-user-email',
    label: 'Twitter 用户邮箱',
    navDescription: '用户名与邮箱双向查询',
    pipelineLabel: 'Twitter 用户清洗计划',
    recordUnit: '组',
    uniqueLabel: '唯一映射',
    pipelineSummary: '读取服务器上的 用户名 → 邮箱 JSON 文件，流式分批写入 PostgreSQL；去重、建索引并核对计数后发布到「Twitter 用户邮箱」数据产品。',
    platform: 'twitter_user_email',
    searchCapability: 'twitter.user_email.search',
    // Retired: full e-mails are governed by the search grant. Kept so old grants stay visible and removable.
    legacyCapabilities: ['twitter.user_email.reveal'],
    productPath: '/data-products/twitter-user-email',
    apiBase: '/api/v1/data/twitter-user-email',
    docsKey: 'twitter-user-email',
    sourceFormat: 'JSON 对象（用户名 → 邮箱）；可直接是 .zip 里的文件',
    sourceExtensions: ['.json'],
    defaultSource: { rootId: 'shared-dir', relativePath: 'imports/twitter/new_email.json', sha256: 'c63812d32bbd144f210647d3ade3ef7d475e407158e96858b5669ba51555ebda' },
  }),
  define({
    key: 'email-directory',
    label: '邮箱库',
    navDescription: '邮箱存在性、前缀、域名与片段查询',
    pipelineLabel: '邮箱库清洗计划',
    recordUnit: '行',
    uniqueLabel: '唯一邮箱',
    pipelineSummary: '读取服务器上每行一个邮箱的文本文件，拆分为本地部分与域名后分批写入 PostgreSQL；去重、建索引并核对计数后发布到「邮箱库」数据产品。',
    platform: 'email_directory',
    searchCapability: 'email.directory.search',
    productPath: '/data-products/email-directory',
    apiBase: '/api/v1/data/email-directory',
    docsKey: 'email-directory',
    sourceFormat: '文本文件，每行一个邮箱；可直接是 .zip 里的文件',
    sourceExtensions: ['.txt'],
    // email-phone.zip holds email_only.txt and phone_only.txt; read in place.
    defaultSource: { rootId: 'shared-dir', relativePath: 'imports/email-phone.zip', entry: 'email_only.txt', sha256: null },
  }),
  define({
    key: 'phone-directory',
    label: '手机号库',
    navDescription: '手机号精确、前缀与尾号查询',
    pipelineLabel: '手机号库清洗计划',
    recordUnit: '行',
    uniqueLabel: '唯一号码',
    pipelineSummary: '读取服务器上每行一个手机号的文本文件，规范为国际号码数字后分批写入 PostgreSQL；去重、建索引并核对计数后发布到「手机号库」数据产品。',
    platform: 'phone_directory',
    searchCapability: 'phone.directory.search',
    productPath: '/data-products/phone-directory',
    apiBase: '/api/v1/data/phone-directory',
    docsKey: 'phone-directory',
    sourceFormat: '文本文件，每行一个手机号（+国家码…）；可直接是 .zip 里的文件',
    sourceExtensions: ['.txt'],
    defaultSource: { rootId: 'shared-dir', relativePath: 'imports/email-phone.zip', entry: 'phone_only.txt', sha256: null },
  }),
])

const byKey = new Map(FILE_DATASETS.map(dataset => [dataset.key, dataset]))
const byPath = new Map(FILE_DATASETS.map(dataset => [dataset.productPath, dataset]))

export const fileDataset = key => byKey.get(key) || null
export const fileDatasetByPath = path => byPath.get(path) || null
export const FILE_DATASET_PATHS = Object.freeze(FILE_DATASETS.map(dataset => dataset.productPath))
export const FILE_DATASET_PLATFORMS = Object.freeze(FILE_DATASETS.map(dataset => dataset.platform))
export const FILE_DATASET_SEARCH_CAPABILITIES = Object.freeze(FILE_DATASETS.map(dataset => dataset.searchCapability))
export const FILE_DATASET_SCOPES = Object.freeze(FILE_DATASETS.flatMap(dataset => dataset.scopes))
