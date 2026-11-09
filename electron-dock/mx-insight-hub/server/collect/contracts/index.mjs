import { COLLECT_KINDS } from '../../../shared/collect-engines.mjs'
import { runnerContract } from './runner.mjs'
import { apifyContract } from './apify.mjs'

// One contract module per execution kind. A contract only builds requests
// and classifies answers; the store and executor own every state change.
//
//   mode 'sync':  dispatch(ctx)            → { outcome }
//   mode 'async': start(ctx)               → { outcome } | { upstream: { ref, state }, nextCheckMs }
//                 check(ctx)               → { outcome } | { upstream?: { state }, nextCheckMs }
//   abort(ctx)                             → { stopped } at the run deadline (optional)
//   probe(ctx)                             → read-only reachability
//   reconcilable: an orphaned dispatch is re-checked instead of marked unknown
//
// outcome: { status: succeeded|failed|unknown, dataStatus?, result?, itemCount?,
//            error?, quarantine?: 'slot' | 'engine' | null, charge, cooldownUntil?, cost? }
const BUILT_IN = [runnerContract, apifyContract]

export function createCollectContracts(extra = []) {
  const contracts = new Map()
  for (const contract of [...BUILT_IN, ...extra]) {
    if (!COLLECT_KINDS[contract.kind] && !extra.includes(contract)) throw new TypeError(`Unknown collection kind ${contract.kind}`)
    contracts.set(contract.kind, contract)
  }
  return contracts
}
