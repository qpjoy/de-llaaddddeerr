export {
  ElasticsearchClient,
  ElasticsearchError,
  ElasticsearchUnavailableError,
  createElasticsearchClient,
  describeClusterHealth,
  isClusterHealthBody,
} from './client.mjs'
export { MX_ANALYSIS, nameField, vectorField } from './analysis.mjs'
export {
  defineIndexSet,
  ensureIndexSet,
  defaultIlmPolicy,
  reindexSchemaVersion,
} from './index-manager.mjs'
export {
  DEFAULT_REPOSITORY,
  fsRepository,
  s3Repository,
  dailySnapshotPolicy,
  ensureSnapshots,
  executePolicy,
  snapshotHealth,
} from './snapshots.mjs'
