import { createHash } from 'node:crypto'
import { SOURCE_CATALOG_SEED } from './source-catalog-seed.mjs'
const template = SOURCE_CATALOG_SEED.find(row=>row.sourceKey==='source-catalog-0085')
const rows=[['lemon8','Lemon8'],['pipixia','皮皮虾'],['youku','优酷'],['imdb','IMDb'],['vcg','视觉中国'],['pixabay','Pixabay'],['qq-huxuan','腾讯互选'],['douyin-xingtu','巨量星图']]
export const PROVIDER_CATALOG_ADDITIONS=rows.map(([platform,name])=>{
  const domestic = ['pipixia','youku','vcg','qq-huxuan','douyin-xingtu'].includes(platform)
  const hex=createHash('sha256').update(`hub-source-platform:${platform}`).digest('hex')
  const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
  return {...template,id,sourceKey:`source-platform-${platform}`,legacySequence:null,canonicalName:name,aliases:[],parentSourceId:null,
    majorCategory:domestic ? '国内社媒与内容平台' : template.majorCategory,
    scenarios:['内容/舆情/评论监测'],regions:[domestic ? '中国大陆' : '全球'],entryModules:[],monitorableContent:[],extractableClues:[],trackingFields:[],suggestedAccess:[],
    complianceBoundary:null,priority:'P2',coverageStatus:'unknown',deliveryStatus:'planned',reviewStatus:'needs_review',runtimeStatus:'not_configured',
    owner:null,connectorHints:[],notes:'已登记接口合同；实时可用性与数据覆盖需按运行和交付证据核验。',tags:[],evidenceRefs:[],customFields:{},revision:1,archivedAt:null,importedFrom:'official-contracts-2026-09-27'}
})
