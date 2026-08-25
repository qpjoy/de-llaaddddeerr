import { AppError } from '../core/errors.mjs'

export const DEFAULT_SEARCH_PROFILE = 'canonical.balanced.v1'
export const POSTGRES_SEARCH_PROFILE = 'postgres.substring.v1'
export const CONTENT_INDEX_SCHEMA = 'content-v5'
const CONTENT_PROFILE_MIN_INDEX_SCHEMA = 'content-v4'

function indexSchemaVersion(value) {
  const match = /^content-v(\d+)$/.exec(String(value || ''))
  return match ? Number(match[1]) : null
}

export function searchIndexSchemaSatisfies(activeIndexSchema, requiredIndexSchema) {
  if (!requiredIndexSchema) return true
  const activeVersion = indexSchemaVersion(activeIndexSchema)
  const requiredVersion = indexSchemaVersion(requiredIndexSchema)
  return activeVersion != null && requiredVersion != null && activeVersion >= requiredVersion
}

const INDEX_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: 'canonical.raw-text.v1',
    label: 'Raw text',
    summary: 'Standard-analyzed source text with positional phrase matching.',
    fields: Object.freeze(['title', 'body', 'chatUsername']),
  }),
  Object.freeze({
    id: 'canonical.presegmented.v1',
    label: 'Pre-segmented terms',
    summary: 'Primary Chinese word channel: coarse HanLP terms when healthy, with explicit Jieba/bigram degradation, indexed verbatim.',
    fields: Object.freeze(['titleHanlp', 'bodyHanlp', 'chatUsernameHanlp']),
  }),
  Object.freeze({
    id: 'canonical.cjk-bigram.v1',
    label: 'CJK bigrams',
    summary: 'Plugin-free CJK bigram companion fields for segmentation-independent recall.',
    fields: Object.freeze([
      'title.cjk', 'body.cjk', 'authorName.bigram', 'authorHandle.bigram',
      'username.bigram', 'chatUsername.bigram',
    ]),
  }),
  Object.freeze({
    id: 'canonical.title-prefix.v1',
    label: 'Title and name prefix',
    summary: 'Leading prefix terms for titles and bounded human-facing identifier fields.',
    fields: Object.freeze([
      'title.prefix', 'authorName.prefix', 'authorHandle.prefix',
      'username.prefix', 'chatUsername.prefix',
    ]),
  }),
  Object.freeze({
    id: POSTGRES_SEARCH_PROFILE,
    label: 'PostgreSQL substring fallback',
    summary: 'Deterministic canonical substring matching used only when Elasticsearch is unavailable.',
    fields: Object.freeze(['title', 'body', 'stableFields.attributes.chatUsername']),
  }),
])

function plan(branch, label, summary) {
  return Object.freeze({ branch, label, summary })
}

function profile({
  id,
  label,
  summary,
  indexRepresentations,
  queryPlan,
  public: isPublic,
  warning = null,
  maxPrefixChars = null,
  requiredIndexSchema = null,
  needsSegmentation = false,
  kind,
}) {
  return Object.freeze({
    id,
    label,
    summary,
    indexRepresentations: Object.freeze([...indexRepresentations]),
    queryPlan: Object.freeze([...queryPlan]),
    public: isPublic,
    warning,
    maxPrefixChars,
    requiredIndexSchema,
    needsSegmentation,
    kind,
  })
}

const PROFILES = Object.freeze([
  profile({
    id: DEFAULT_SEARCH_PROFILE,
    label: 'Balanced',
    summary: 'Exact source phrase or every coarse HanLP/pre-segmented query term (AND); this is the stable default.',
    indexRepresentations: ['canonical.raw-text.v1', 'canonical.presegmented.v1'],
    queryPlan: [
      plan('raw_phrase', 'Raw phrase', 'Preserves source order and exact character adjacency.'),
      plan('terms_all', 'All pre-segmented terms (AND)', 'Requires every coarse HanLP/pre-segmented query term while allowing word-order variation.'),
    ],
    public: true,
    needsSegmentation: true,
    kind: 'balanced',
  }),
  profile({
    id: 'canonical.phrase.v1',
    label: 'Phrase only',
    summary: 'Matches the normalized source text as one ordered phrase.',
    indexRepresentations: ['canonical.raw-text.v1'],
    queryPlan: [plan('raw_phrase', 'Raw phrase', 'Requires source order and character adjacency.')],
    public: true,
    kind: 'phrase',
  }),
  profile({
    id: 'canonical.terms-all.v1',
    label: 'All terms',
    summary: 'Uses the primary coarse HanLP/pre-segmented channel and requires every query term (AND).',
    indexRepresentations: ['canonical.presegmented.v1'],
    queryPlan: [plan('terms_all', 'All pre-segmented terms (AND)', 'Requires every coarse HanLP/pre-segmented query term.')],
    public: true,
    needsSegmentation: true,
    kind: 'terms-all',
  }),
  profile({
    id: 'canonical.zh-recall.v1',
    label: 'Chinese recall',
    summary: 'Keeps coarse HanLP/pre-segmented AND as the primary Chinese path and adds CJK bigrams only as low-weight recall.',
    indexRepresentations: [
      'canonical.raw-text.v1', 'canonical.presegmented.v1', 'canonical.cjk-bigram.v1',
    ],
    queryPlan: [
      plan('raw_phrase', 'Raw phrase', 'Highest-weight ordered source-text match.'),
      plan('terms_all', 'All pre-segmented terms (AND)', 'Requires every coarse HanLP/pre-segmented query term.'),
      plan('cjk_phrase', 'CJK bigram phrase', 'Low-weight supplement for segmentation drift; it does not replace HanLP.'),
    ],
    public: true,
    needsSegmentation: true,
    requiredIndexSchema: CONTENT_PROFILE_MIN_INDEX_SCHEMA,
    kind: 'zh-recall',
  }),
  profile({
    id: 'canonical.title-prefix.v1',
    label: 'Title and name prefix',
    summary: 'Searches leading title, author, handle, username, and chat-name prefixes up to 12 characters.',
    indexRepresentations: ['canonical.title-prefix.v1'],
    queryPlan: [plan('title_prefix', 'Title/name prefix', 'Matches bounded leading prefixes only.')],
    public: true,
    warning: 'Prefix terms are indexed through 12 characters; longer terms may not match.',
    maxPrefixChars: 12,
    requiredIndexSchema: CONTENT_PROFILE_MIN_INDEX_SCHEMA,
    kind: 'title-prefix',
  }),
  profile({
    id: 'canonical.cjk-bigram.v1',
    label: 'CJK bigram only',
    summary: 'Admin comparison profile using only ordered CJK-bigram fields.',
    indexRepresentations: ['canonical.cjk-bigram.v1'],
    queryPlan: [plan('cjk_phrase', 'CJK bigram phrase', 'Requires ordered CJK bigrams.')],
    public: false,
    warning: 'Comparison profile: single-character CJK queries may produce no bigram terms.',
    requiredIndexSchema: CONTENT_PROFILE_MIN_INDEX_SCHEMA,
    kind: 'cjk-bigram',
  }),
  profile({
    id: 'canonical.legacy-or.v1',
    label: 'Legacy OR',
    summary: 'Reproduces the retired broad OR query for controlled relevance comparison.',
    indexRepresentations: ['canonical.raw-text.v1', 'canonical.presegmented.v1'],
    queryPlan: [
      plan('legacy_raw_or', 'Legacy raw OR', 'Any raw analyzed term may match.'),
      plan('legacy_terms_or', 'Legacy segmented OR', 'Any segmented term may match.'),
    ],
    public: false,
    warning: 'Diagnostic only: this profile can admit low-relevance single-character matches.',
    needsSegmentation: true,
    kind: 'legacy-or',
  }),
])

const POSTGRES_PROFILE = profile({
  id: POSTGRES_SEARCH_PROFILE,
  label: 'PostgreSQL substring fallback',
  summary: 'Unranked canonical substring matching used during Elasticsearch degradation.',
  indexRepresentations: [POSTGRES_SEARCH_PROFILE],
  queryPlan: [plan('postgres_substring', 'PostgreSQL substring', 'ILIKE substring matching over canonical text.')],
  public: false,
  warning: 'Elasticsearch profile semantics are unavailable; PostgreSQL substring matching was applied.',
  kind: 'postgres',
})

const profileById = new Map(PROFILES.map((entry) => [entry.id, entry]))

export function publicSearchProfile(profileValue) {
  const value = typeof profileValue === 'string' ? profileById.get(profileValue) : profileValue
  if (!value) return null
  return {
    id: value.id,
    label: value.label,
    summary: value.summary,
    indexRepresentations: [...value.indexRepresentations],
    queryPlan: value.queryPlan.map((entry) => ({ ...entry })),
    public: value.public,
    warning: value.warning,
    ...(value.maxPrefixChars == null ? {} : { maxPrefixChars: value.maxPrefixChars }),
    ...(value.requiredIndexSchema == null ? {} : { requiredIndexSchema: value.requiredIndexSchema }),
  }
}

export function resolveSearchProfile(value, { audience = 'public' } = {}) {
  if (audience !== 'public' && audience !== 'admin') {
    throw new Error('Search profile audience must be public or admin')
  }
  const id = value == null || value === '' ? DEFAULT_SEARCH_PROFILE : value
  if (typeof id !== 'string' || !id.trim() || id.length > 128) {
    throw new AppError(400, 'invalid_search_profile', 'searchProfile must be a valid profile id')
  }
  const resolved = profileById.get(id.trim())
  if (!resolved || (audience === 'public' && !resolved.public)) {
    const allowed = PROFILES.filter((entry) => audience === 'admin' || entry.public).map((entry) => entry.id)
    throw new AppError(400, 'invalid_search_profile', `searchProfile must be one of: ${allowed.join(', ')}`)
  }
  return resolved
}

export function searchCapabilities({ audience = 'public', activeIndexSchema = undefined } = {}) {
  if (audience !== 'public' && audience !== 'admin') {
    throw new Error('Search profile audience must be public or admin')
  }
  const profiles = PROFILES.filter((entry) => audience === 'admin' || entry.public)
  const represented = new Set(profiles.flatMap((entry) => entry.indexRepresentations))
  const includeReadiness = activeIndexSchema !== undefined
  const publicProfiles = profiles.map((entry) => {
    const metadata = publicSearchProfile(entry)
    return includeReadiness
      ? {
          ...metadata,
          ready: searchIndexSchemaSatisfies(activeIndexSchema, entry.requiredIndexSchema),
        }
      : metadata
  })
  const fallbackProfile = publicSearchProfile(POSTGRES_PROFILE)
  return {
    indexSchema: CONTENT_INDEX_SCHEMA,
    defaultProfile: DEFAULT_SEARCH_PROFILE,
    profiles: publicProfiles,
    indexRepresentations: INDEX_REPRESENTATIONS
      .filter((entry) => represented.has(entry.id))
      .map((entry) => ({ ...entry, fields: [...entry.fields] })),
    fallbackProfile: includeReadiness ? { ...fallbackProfile, ready: true } : fallbackProfile,
    ...(includeReadiness ? {
      activeIndexSchema,
      ready: activeIndexSchema === CONTENT_INDEX_SCHEMA,
    } : {}),
  }
}

function rawPhraseClause({ query, boost = null }) {
  return {
    multi_match: {
      _name: 'raw_phrase',
      query,
      fields: ['title^3', 'body', 'chatUsername^2'],
      type: 'phrase',
      ...(boost == null ? {} : { boost }),
    },
  }
}

function allTermsClause({ segmented, boost = null }) {
  return {
    multi_match: {
      _name: 'terms_all',
      query: segmented,
      fields: ['titleHanlp^3', 'bodyHanlp', 'chatUsernameHanlp^2'],
      type: 'best_fields',
      operator: 'and',
      ...(boost == null ? {} : { boost }),
    },
  }
}

function cjkPhraseClause(query) {
  return {
    multi_match: {
      _name: 'cjk_phrase',
      query,
      fields: [
        'title.cjk^3', 'body.cjk', 'authorName.bigram^2', 'authorHandle.bigram^2',
        'username.bigram^2', 'chatUsername.bigram^2',
      ],
      type: 'phrase',
      boost: 0.75,
    },
  }
}

function titlePrefixClause(query) {
  return {
    multi_match: {
      _name: 'title_prefix',
      query,
      fields: [
        'title.prefix^5', 'authorName.prefix^3', 'authorHandle.prefix^3',
        'username.prefix^3', 'chatUsername.prefix^3',
      ],
      type: 'phrase',
    },
  }
}

export function buildContentSearchPlan({ profile: profileValue, query, segmented = '' }) {
  const resolved = typeof profileValue === 'string'
    ? resolveSearchProfile(profileValue, { audience: 'admin' })
    : profileValue
  if (!resolved || !profileById.has(resolved.id)) {
    throw new AppError(400, 'invalid_search_profile', 'searchProfile is not supported')
  }
  if (resolved.needsSegmentation && !segmented) {
    throw new AppError(503, 'search_analysis_unavailable', 'The selected search profile produced no query terms')
  }
  switch (resolved.kind) {
    case 'balanced':
      return { profile: resolved, should: [rawPhraseClause({ query }), allTermsClause({ segmented })] }
    case 'phrase':
      return { profile: resolved, should: [rawPhraseClause({ query })] }
    case 'terms-all':
      return { profile: resolved, should: [allTermsClause({ segmented })] }
    case 'zh-recall':
      return {
        profile: resolved,
        should: [
          rawPhraseClause({ query, boost: 4 }),
          allTermsClause({ segmented, boost: 2 }),
          cjkPhraseClause(query),
        ],
      }
    case 'title-prefix':
      return { profile: resolved, should: [titlePrefixClause(query)] }
    case 'cjk-bigram':
      return { profile: resolved, should: [cjkPhraseClause(query)] }
    case 'legacy-or':
      return {
        profile: resolved,
        should: [
          {
            multi_match: {
              _name: 'legacy_raw_or', query,
              fields: ['title^3', 'body', 'chatUsername^2'], type: 'best_fields',
            },
          },
          {
            multi_match: {
              _name: 'legacy_terms_or', query: segmented,
              fields: ['titleHanlp^3', 'bodyHanlp', 'chatUsernameHanlp^2'], type: 'best_fields',
            },
          },
        ],
      }
    default:
      throw new AppError(400, 'invalid_search_profile', 'searchProfile is not supported')
  }
}

export function postgresSearchProfile() {
  return POSTGRES_PROFILE
}

export function searchProfileNeedsSegmentation(profileValue) {
  return Boolean(
    (typeof profileValue === 'string'
      ? resolveSearchProfile(profileValue, { audience: 'admin' })
      : profileValue)?.needsSegmentation,
  )
}

export function searchProfileRequiredIndexSchema(profileValue) {
  const resolved = typeof profileValue === 'string'
    ? resolveSearchProfile(profileValue, { audience: 'admin' })
    : profileValue
  return resolved?.requiredIndexSchema ?? null
}

export function knownMatchBranches(profileValue) {
  const resolved = typeof profileValue === 'string'
    ? (profileById.get(profileValue) || (profileValue === POSTGRES_SEARCH_PROFILE ? POSTGRES_PROFILE : null))
    : profileValue
  return new Set((resolved?.queryPlan || []).map((entry) => entry.branch))
}
