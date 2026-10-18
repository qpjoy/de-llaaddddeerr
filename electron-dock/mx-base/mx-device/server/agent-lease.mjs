// Leases executed by a host Agent (V2-3). Kept free of imports so the claim
// path (model, workflows, scheduling) can use it without import cycles.

export const AGENT_PROTOCOL = 1;
// Renewed by every heartbeat; a grant must be accepted within this time.
export const AGENT_LEASE_MS = 20000;
// After the lease runs out the attempt is suspect for this long: late evidence
// still counts. Then it is settled (requeued if nothing was issued, else unknown).
export const AGENT_GRACE_MS = 15000;
export const AGENT_HEARTBEAT_MS = 5000;
// An Agent unseen for longer gets no new grants.
export const AGENT_ONLINE_MS = 15000;

export const agentOnline = (agent, now) =>
  agent?.status === "active" &&
  now - (agent.lastSeenAt || 0) <= AGENT_ONLINE_MS;
export const leaseGrace = (a) => (a?.executor === "agent" ? AGENT_GRACE_MS : 0);
export const suspect = (a, now) =>
  a?.executor === "agent" &&
  a.status === "running" &&
  a.leaseUntil <= now &&
  a.leaseUntil + AGENT_GRACE_MS > now;

/** A device hosted by an Agent receives each session (and each continuation
 * of a yielded session) as a lease grant with the device's next fencing
 * token. Nothing runs in-process; the Agent pulls the grant and accepts it,
 * and every command it runs is issued as a directive under that token. */
export function grantToAgent(d, a, now) {
  d.leaseToken = (d.leaseToken || 0) + 1;
  Object.assign(a, {
    executor: "agent",
    agentId: d.agentId,
    token: d.leaseToken,
    agentState: "granted",
    grantedAt: now,
    leaseUntil: now + AGENT_LEASE_MS,
    workerId: `agent:${d.agentId}`,
    // Commands issued under this token; zero proves nothing physical happened.
    leaseIssued: 0,
    seq: 0,
  });
  delete a.agentStop;
}
