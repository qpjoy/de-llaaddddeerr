import pg from "pg";
import { EventEmitter } from "node:events";

// Single active scheduler. The instance holding a session advisory lock on a
// dedicated connection is the leader; acquiring bumps scheduler_leader.epoch.
// Losing the connection releases the lock in PostgreSQL, so a standby takes
// over on its next check. Scheduling transactions carry the epoch and fail
// once a newer leader exists (see PgStore.atomic), so a stale leader that is
// still running cannot commit placements. Execution already bound to devices
// is not leader-gated: it is fenced per attempt (lease, epoch, row versions).
// The same connection LISTENs for work notifications to wake the scan early.
export class Leadership extends EventEmitter {
  constructor(url, { instanceId, lockKey = 10 } = {}) {
    super();
    this.url = url;
    this.instanceId = instanceId;
    this.lockKey = lockKey;
    this.client = null;
    this.epoch = null;
  }
  async check() {
    try {
      if (!this.client) {
        const client = new pg.Client({
          connectionString: this.url,
          application_name: "mx-device-scheduler",
          connectionTimeoutMillis: 2000,
        });
        client.on("error", () => this.#drop(client));
        client.on("end", () => this.#drop(client));
        client.on("notification", (message) =>
          this.emit("work", message.payload),
        );
        this.client = client;
        await client.connect();
        await client.query("LISTEN mx_device_work");
      }
      if (this.epoch == null) {
        const { rows } = await this.client.query(
          "SELECT pg_try_advisory_lock(1297634386,$1) AS ok",
          [this.lockKey],
        );
        if (rows[0].ok) {
          // Waits for any scheduling transaction of the previous leader that
          // still holds the epoch row FOR SHARE.
          const bumped = await this.client.query(
            "UPDATE mx_device.scheduler_leader SET epoch=epoch+1,holder=$1,acquired_at=(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1 RETURNING epoch",
            [this.instanceId],
          );
          this.epoch = Number(bumped.rows[0].epoch);
          this.emit("acquired", this.epoch);
        }
      } else await this.client.query("SELECT 1");
    } catch {
      this.#drop(this.client);
    }
    return this.epoch;
  }
  // A transaction reported a newer epoch: step down and reconnect from scratch.
  lost() {
    this.#drop(this.client);
  }
  #drop(client) {
    if (!client || client !== this.client) return;
    const epoch = this.epoch;
    this.client = null;
    this.epoch = null;
    client.end().catch(() => {});
    if (epoch != null) this.emit("lost", epoch);
  }
  async close() {
    const client = this.client;
    this.client = null;
    this.epoch = null;
    await client?.end().catch(() => {});
  }
}
