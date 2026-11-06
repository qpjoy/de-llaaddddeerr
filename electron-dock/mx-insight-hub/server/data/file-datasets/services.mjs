// Wiring of every file dataset for the Hub listeners and the worker.
import { EmailDirectorySearch } from '../email-directory/search.mjs'
import { PhoneDirectorySearch } from '../phone-directory/search.mjs'
import { TwitterUserEmailSearch } from '../twitter-user-email/search.mjs'
import { FileDatasetEngine } from './engine.mjs'
import { FileDatasetPipeline } from './pipeline.mjs'
import { FILE_DATASET_DEFINITIONS } from './registry.mjs'
import { FileDatasetStore } from './store.mjs'

const SEARCHES = Object.freeze({
  'twitter-user-email': TwitterUserEmailSearch,
  'email-directory': EmailDirectorySearch,
  'phone-directory': PhoneDirectorySearch,
})

export function createFileDatasetStores(pool, definitions = FILE_DATASET_DEFINITIONS) {
  return Object.fromEntries(definitions.map(({ key, kind }) => [key, new FileDatasetStore(pool, { datasetKey: key, kind })]))
}

/**
 * Public listeners get searches; the Admin listener also gets pipelines
 * (cleaning-task intent and progress). Both are keyed by dataset key.
 */
export function createFileDatasetServices({ pool, hmacKey, serverFileReader = null, admin = false, definitions = FILE_DATASET_DEFINITIONS }) {
  if (!pool) return { stores: {}, searches: {}, pipelines: {} }
  const stores = createFileDatasetStores(pool, definitions)
  const searches = Object.fromEntries(definitions.map(({ key }) => [key, new SEARCHES[key]({ pool, store: stores[key], hmacKey })]))
  const pipelines = admin
    ? Object.fromEntries(definitions.map(({ key, product }) => [key, new FileDatasetPipeline({ store: stores[key], product, serverFileReader })]))
    : {}
  return { stores, searches, pipelines }
}

/** One engine per dataset; they share the domain-id cache. */
export function createFileDatasetEngines({ pool, fileReader, workerId, definitions = FILE_DATASET_DEFINITIONS, ...options }) {
  const stores = createFileDatasetStores(pool, definitions)
  const domainCache = new Map()
  return definitions.map(({ key }) => new FileDatasetEngine({ pool, store: stores[key], fileReader, workerId, domainCache, ...options }))
}
