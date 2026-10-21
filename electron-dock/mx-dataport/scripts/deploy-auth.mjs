import { setTimeout as delay } from 'node:timers/promises';
import { validateApplicationSsoSettings } from '../../mx-common/src/identity/profile.mjs';

const CHECKS = { discovery: ['issuerMatches'], capabilities: ['nativeForm', 'appIdMatches', 'originMatches', 'audienceMatches'] };
const PROBE_CATEGORIES = ['ok', 'not_attempted', 'dns_error', 'timeout', 'tls_error', 'connection_error', 'network_error',
  'redirect_refused', 'upstream_http_error', 'http_error', 'invalid_json', 'configuration_mismatch'];
const RECOVERY_CODES = ['wrong_host', 'image_unknown', 'cluster_changed', 'node_changed', 'node_unschedulable',
  'migration_incomplete', 'runtime_changed', 'deployment_unstable', 'public_template_changed', 'node_taint_untolerated',
  'pod_set_changed', 'pod_unstable', 'identity_config_changed', 'container_unknown', 'container_changed', 'image_changed',
  'pod_health_failed', 'host_failure_not_refused', 'state_changed', 'recovery_state_changed', 'hostport_not_recovered',
  'invalid_arguments', 'linux_root_required', 'command_failed', 'recovery_failed', 'operation_locked'];
const COMMAND_CATEGORIES = ['timeout', 'exec_failure', 'conflict', 'forbidden', 'not_found', 'invalid_argument'];
const allowed = (value, values) => values.includes(value) ? value : 'unknown';
function diagnosticSummary(result) {
  return {
    profile: { category: allowed(result?.profile?.category, ['valid', 'missing', 'invalid']) },
    ...Object.fromEntries(Object.entries(CHECKS).map(([name, checks]) => {
      const probe = result?.[name];
      return [name, {
        status: Number.isInteger(probe?.status) && probe.status >= 100 && probe.status <= 599 ? probe.status : null,
        category: allowed(probe?.category, PROBE_CATEGORIES),
        ...Object.fromEntries(['jsonValid', ...checks].filter(key => typeof probe?.[key] === 'boolean').map(key => [key, probe[key]])),
      }];
    })),
  };
}
const healthyProbe = (probe, checks) => probe?.status === 200 && probe.category === 'ok' && probe.jsonValid === true
  && checks.every(key => probe[key] === true);
const validDiagnostic = result => result?.profile?.valid === true && result.profile.category === 'valid' && result.category === undefined;
const healthy = result => result?.ok === true && validDiagnostic(result)
  && Object.entries(CHECKS).every(([name, checks]) => healthyProbe(result[name], checks));
const upstream = probe => [502, 503, 504].includes(probe?.status) && probe.category === 'upstream_http_error'
  && Object.keys(probe).every(key => ['status', 'category'].includes(key));
const upstreamOnly = result => result?.ok === false && validDiagnostic(result)
  && Object.entries(CHECKS).every(([name, checks]) => upstream(result[name]) || healthyProbe(result[name], checks))
  && Object.keys(CHECKS).some(name => upstream(result[name]));

// Called after DataPort readiness. This does not retry deploy or authentication mutations.
export async function verifyDeployedAuth({ settings, profile, diagnose, recover, report = () => {}, pause = delay }) {
  let diagnostic;
  const emit = summary => { try { report(summary); } catch {} };
  const finish = status => { const summary = { stage: 'auth', status }; emit(summary); return summary; };
  const fail = (step, reason, recovery) => {
    const summary = { stage: 'auth', status: 'failed', step, reason };
    if (diagnostic) summary.diagnostic = diagnostic;
    if (step === 'recover') {
      summary.recoveryCode = allowed(recovery?.code, RECOVERY_CODES);
      if (recovery?.commandCategory !== undefined) summary.commandCategory = allowed(recovery.commandCategory, COMMAND_CATEGORIES);
      summary.recoveryStage = ['preflight', 'lock', 'wrapper', 'restart', 'rollout', 'postcheck'].includes(recovery?.stage) ? recovery.stage : 'unknown';
      summary.mutationAttempted = [true, false, 'unknown'].includes(recovery?.mutationAttempted) ? recovery.mutationAttempted : 'unknown';
      summary.restartSubmitted = [true, false, 'unknown'].includes(recovery?.restartSubmitted) ? recovery.restartSubmitted : 'unknown';
    }
    emit(summary);
    throw Object.assign(Error('DataPort 已更新，但 SSO 验证未通过；请按诊断结果核对，未重试恢复操作。'),
      { code: 'dataport_sso_verification_failed', ...summary });
  };
  if (profile === undefined || profile === null) return finish('skipped_profile_missing');
  let identity;
  try {
    if (typeof profile !== 'string') throw Error();
    identity = validateApplicationSsoSettings(JSON.parse(profile));
    if (identity.appId !== 'mx-harbor' || !/^[A-Za-z0-9_-]{43}$/.test(identity.sessionKey || '')
      || Buffer.from(identity.sessionKey, 'base64url').length !== 32) throw Error();
  } catch { fail('profile', 'invalid_profile'); }
  const inspect = async step => {
    diagnostic = undefined;
    try {
      const result = await diagnose();
      diagnostic = diagnosticSummary(result);
      return result;
    } catch { fail(step, 'diagnostic_unavailable'); }
  };
  const initial = await inspect('diagnose');
  if (healthy(initial)) return finish('verified');
  if (!upstreamOnly(initial)) fail('diagnose', 'diagnostic_rejected');
  if (settings?.clusterUid !== '399f2349-3a34-48f4-8105-d7bae56ca136' || settings.node !== 'mx-internal-server'
    || identity.origin !== 'https://dataport.minsight-ai.com' || identity.issuer !== 'https://auth.minsight-ai.com/identity'
    || identity.audience !== 'mx-harbor') fail('recover', 'recovery_not_eligible', { mutationAttempted: false, restartSubmitted: false });
  emit({ stage: 'auth', status: 'checking_public_auth_recovery' });
  let recovered;
  try { recovered = await recover(); } catch { fail('recover', 'recovery_unconfirmed'); }
  if (recovered?.ok !== true || !((recovered.action === 'recovered' && recovered.applied === true)
    || (recovered.action === 'already_healthy' && recovered.applied === false))) fail('recover', 'recovery_unconfirmed', recovered);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await inspect('verify');
    if (healthy(result)) return finish('recovered');
    if (!upstreamOnly(result) || attempt === 3) fail('verify', 'post_recovery_verification_failed');
    emit({ stage: 'auth', status: 'waiting_for_auth', attempt });
    try { await pause(2000); } catch { fail('verify', 'verification_wait_failed'); }
  }
}
