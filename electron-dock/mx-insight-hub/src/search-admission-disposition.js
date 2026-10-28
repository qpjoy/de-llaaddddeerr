const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sessions = new WeakMap()

export function searchAdmissionDispositionValid(value, requestId) {
  if (!object(value) || !UUID.test(requestId) || value.requestId !== requestId
    || value.upstreamDispatched !== false || typeof value.eligibility?.allowed !== 'boolean'
    || !Object.hasOwn(value, 'disposition')) return false
  if (value.eligibility.allowed || value.disposition?.effective === true) {
    const scope = value.scope
    if (!object(scope) || scope.platform !== 'twitter'
      || !['tenantId', 'consumerId', 'apiKeyId'].every(key => UUID.test(scope[key] || ''))
      || typeof scope.query !== 'string' || !scope.query.trim()
      || typeof value.revision !== 'string' || !value.revision) return false
  }
  return value.disposition === null || object(value.disposition)
    && value.eligibility.allowed === false && typeof value.disposition.effective === 'boolean'
    && typeof value.disposition.reason === 'string' && value.disposition.reason.trim().length >= 3
    && typeof value.disposition.actor === 'string' && Boolean(value.disposition.actor)
    && Number.isFinite(Date.parse(value.disposition.createdAt))
}

function sameScope(left, right) {
  return ['platform', 'tenantId', 'consumerId', 'apiKeyId', 'query'].every(key => left?.[key] === right?.[key])
}

export function canConfirmSearchAdmissionDisposition(state) {
  return state.checked && state.data?.eligibility.allowed === true && !state.data.disposition
    && !state.loading && !state.saving && state.outcome !== 'uncertain'
    && state.reason.trim().length >= 3 && state.reason.trim().length <= 500
}

// Keep the operation with the existing in-memory diagnostic session. A token
// or request change creates a new store; an old asynchronous response cannot
// become the new target's preparation or approval.
export function searchAdmissionDispositionSessionFor(session, token, requestId, adminApi) {
  const previous = sessions.get(session)
  if (previous?.token === token && previous.requestId === requestId) return previous.store
  previous?.store.retire()
  const store = createSearchAdmissionDispositionSession({ token, requestId }, adminApi)
  sessions.set(session, { token, requestId, store })
  return store
}

export function createSearchAdmissionDispositionSession({ token, requestId }, adminApi) {
  let state = { data: null, reason: '', checked: false, loading: false, saving: false,
    confirming: false, outcome: 'idle', attempt: null, error: null }
  let retired = false
  const listeners = new Set()
  const update = patch => {
    if (retired) return
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const active = () => !retired && typeof token === 'string' && Boolean(token) && UUID.test(requestId)
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    retire() { retired = true; listeners.clear() },
    setReason(reason) { if (!state.saving && state.outcome !== 'uncertain') update({ reason, confirming: false }) },
    openConfirmation() { if (active() && canConfirmSearchAdmissionDisposition(state)) update({ confirming: true }) },
    cancelConfirmation() { if (!state.saving) update({ confirming: false }) },
    async read() {
      if (!active() || state.loading || state.saving) return
      update({ loading: true, checked: false, confirming: false, error: null })
      try {
        const data = await adminApi.searchAdmissionDisposition(token, requestId)
        if (!searchAdmissionDispositionValid(data, requestId)
          || state.attempt && data.disposition?.effective !== false && !sameScope(state.attempt.scope, data.scope)) {
          throw new Error('恢复条件未能匹配原请求及影响范围，请继续只读核对。')
        }
        update({ data, checked: true, outcome: data.disposition ? data.disposition.effective ? 'confirmed' : 'stale'
          : state.outcome === 'uncertain' ? 'uncertain' : 'idle' })
      } catch (error) { update({ error }) }
      finally { update({ loading: false }) }
    },
    async confirm() {
      if (!active() || !state.confirming || !canConfirmSearchAdmissionDisposition(state)) return
      const attempt = { revision: state.data.revision, reason: state.reason.trim(), scope: { ...state.data.scope } }
      update({ saving: true, checked: false, error: null, attempt })
      try {
        const data = await adminApi.dispositionSearchAdmission(token, requestId,
          { revision: attempt.revision, reason: attempt.reason, acceptUnknownRisk: true })
        if (!searchAdmissionDispositionValid(data, requestId) || !data.disposition || !sameScope(attempt.scope, data.scope)) {
          throw new Error('操作响应尚未确认已保存解除记录，请只读核对。')
        }
        update({ data, checked: true, outcome: data.disposition.effective ? 'confirmed' : 'stale' })
      } catch (error) {
        // A missing/failed response can follow a committed write. Preserve the
        // submitted revision, offer GET only, and never silently retry POST.
        update({ error, outcome: Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? 'rejected' : 'uncertain' })
      } finally { update({ saving: false, confirming: false }) }
    },
  }
}
