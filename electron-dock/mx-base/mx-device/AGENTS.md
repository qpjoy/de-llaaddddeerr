# MX Device

Independent experimental device center. Do not modify, restart, recreate, install into, or take ownership of the existing mobile-agent container/phone/ADB. Preserve all Hub, Launcher, MX-H2I login and networking. No dependency on mx-rig; Rig is a test client, never a second physical scheduler.

Real and simulation realms are disjoint. Reads never dispatch device operations. Real devices start paused; enable needs fresh explicit idle evidence and exclusive-owner acknowledgement. Legacy PoC cannot cancel, fence, resume global pagination on another phone, prove power/login state, or guarantee physical exactly-once. Timeout/crash after dispatch means unknown + quarantine; queued jobs survive. No automatic retry of real ambiguous work. Simulation retries are visibly labeled and never invoke HTTP.

Keep phone calls outside PostgreSQL transactions. Job identity is independent of Attempt/device. Search with bounded pages holds one device for the entire session. Priority cannot preempt physical work. Preserve attempts and late evidence. Never place credentials in browser storage/URLs/logs. No public PoC port or Docker socket access. Bootstrap secrets may be generated locally; operational settings belong in the authenticated UI.

Use React/Vite and the cool-light MX visual family. This first release is a bounded experimental scheduler, not rack HA. Real deployment and phone acceptance require separate evidence; local mock tests are not a real-phone success claim.
