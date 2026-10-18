// Device Gate (plan §7.3): one writer per device, fenced by the center's
// lease token. Times use the Agent's monotonic clock.
//
// - One live lease per device. A smaller token is always rejected; a larger
//   token replaces an idle lease, and is refused while a command runs.
// - Every command carries the current token and the next seq (1, 2, …);
//   stale tokens, gaps and repeats are refused.
// - No command starts after the local lease deadline.
export class DeviceGate {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.slots = new Map();
  }
  grant(deviceId, { attemptId, token, generation = 1, leaseMs }) {
    const slot = this.slots.get(deviceId);
    if (!Number.isInteger(token) || token < 1)
      return { ok: false, reason: "stale-token" };
    if (slot) {
      if (token < slot.token) return { ok: false, reason: "stale-token" };
      if (token === slot.token)
        return slot.attemptId === attemptId
          ? { ok: true, duplicate: true }
          : { ok: false, reason: "stale-token" };
      if (slot.active) return { ok: false, reason: "busy" };
    }
    this.slots.set(deviceId, {
      attemptId,
      token,
      generation,
      seq: 0,
      active: false,
      expiresAt: this.clock() + leaseMs,
    });
    return { ok: true };
  }
  renew(deviceId, token, leaseMs) {
    const slot = this.slots.get(deviceId);
    if (slot?.token === token) slot.expiresAt = this.clock() + leaseMs;
  }
  revoke(deviceId, token) {
    const slot = this.slots.get(deviceId);
    if (slot?.token === token) slot.expiresAt = 0;
  }
  begin(deviceId, { token, seq }) {
    const slot = this.slots.get(deviceId);
    if (!slot) return { ok: false, reason: "no-lease" };
    if (token !== slot.token) return { ok: false, reason: "stale-token" };
    if (slot.active) return { ok: false, reason: "busy" };
    if (seq !== slot.seq + 1) return { ok: false, reason: "out-of-order" };
    if (this.clock() >= slot.expiresAt)
      return { ok: false, reason: "lease-expired" };
    slot.active = true;
    slot.seq = seq;
    return { ok: true };
  }
  end(deviceId, token) {
    const slot = this.slots.get(deviceId);
    if (slot?.token === token) slot.active = false;
  }
  release(deviceId, token) {
    const slot = this.slots.get(deviceId);
    if (slot?.token === token && !slot.active) this.slots.delete(deviceId);
  }
  expired(deviceId, token, graceMs = 0) {
    const slot = this.slots.get(deviceId);
    return (
      !slot || slot.token !== token || this.clock() >= slot.expiresAt + graceMs
    );
  }
  busy(deviceId) {
    return !!this.slots.get(deviceId)?.active;
  }
  held() {
    return [...this.slots].map(([deviceId, s]) => ({
      deviceId,
      attemptId: s.attemptId,
      token: s.token,
      generation: s.generation,
    }));
  }
}
