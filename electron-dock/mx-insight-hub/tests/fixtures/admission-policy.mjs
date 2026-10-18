import { randomUUID } from 'node:crypto'
import { AdmissionPolicyStore } from '../../server/external-platforms/admission-policy.mjs'
import { deploymentAdmissionLimits } from '../../server/external-platforms/admission-runtime.mjs'

export function attachAdmissionPolicy(gateway, provider = gateway.providerKey || 'tikhub') {
  const policies = new AdmissionPolicyStore({ defaultsByProvider: {
    [provider]: deploymentAdmissionLimits(gateway.config),
  } })
  gateway.admissionPolicies = policies
  const save = async changes => {
    const current = await policies.read(provider)
    return policies.save(provider, { expectedRevision: current.revision, reason: 'Offline admission regression',
      limits: { ...current.limits, ...changes } }, { actor: 'admin-token', requestId: randomUUID() })
  }
  return { policies, save }
}
