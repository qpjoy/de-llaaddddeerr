import { FILE_DATASET_SCOPES } from './file-datasets.mjs'

// Explicit endpoint grants remain bounded; provider-sized batches never imply a wildcard.
export const MAX_PLATFORM_SCOPES = 128
export const MAX_CAPABILITY_SCOPES = 2048
export const MAX_PROVISIONING_OPERATIONS = 1500

export const TWITTER_USER_EMAIL_SCOPES = Object.freeze({
  platform: 'twitter_user_email',
  search: 'twitter.user_email.search',
  reveal: 'twitter.user_email.reveal',
})
// Every file dataset holds personal data (e-mails, phones, usernames).
const explicitOnlyScopes = new Set([...Object.values(TWITTER_USER_EMAIL_SCOPES), ...FILE_DATASET_SCOPES])
export function isExplicitOnlyKeyScope(scope) {
  return explicitOnlyScopes.has(scope)
}
