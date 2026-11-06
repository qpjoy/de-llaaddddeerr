// Server side of the file-dataset registry: product definition (shared with
// the UI) + storage kind (format, DDL, cleaning, indexes, acceptance).
// Adding a dataset = a shared entry, a kind module, a contract + search, and a
// migration that seeds account_dictionary.datasets.
import { FILE_DATASETS } from '../../../shared/file-datasets.mjs'
import { emailListKind } from './kinds/email-list.mjs'
import { phoneListKind } from './kinds/phone-list.mjs'
import { userEmailKind } from './kinds/user-email.mjs'

const KINDS = Object.freeze({
  'twitter-user-email': userEmailKind,
  'email-directory': emailListKind,
  'phone-directory': phoneListKind,
})

export const FILE_DATASET_DEFINITIONS = Object.freeze(FILE_DATASETS.map(product => {
  const kind = KINDS[product.key]
  if (!kind) throw new Error(`File dataset ${product.key} has no storage kind`)
  return Object.freeze({ key: product.key, product, kind: Object.freeze({ ...kind, extensions: product.sourceExtensions }) })
}))

export function fileDatasetDefinition(key) {
  return FILE_DATASET_DEFINITIONS.find(definition => definition.key === key) || null
}
