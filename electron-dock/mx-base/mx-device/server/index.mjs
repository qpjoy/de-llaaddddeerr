import { config } from "./config.mjs";
import { PgStore } from "./store.mjs";
import { createApp } from "./http.mjs";
import { register } from "./model.mjs";
const cfg = await config(),
  store = new PgStore(cfg.databaseUrl);
if (process.env.MX_DEVICE_SKIP_STARTUP_MIGRATION === "1") await store.ready();
else await store.migrate();
await store.atomic(
  (s, n) => {
    if (!s.devices.length)
      for (const letter of ["A", "B"])
        register(s, n, "sim", {
          name: `模拟手机 ${letter}`,
          rack: "演示机架",
          host: "模拟宿主机",
        });
  },
  { mode: "sim" },
);
const app = createApp({ store, cfg });
app.listen(cfg.port, cfg.host, () =>
  console.log(
    `MX Device API listening on ${cfg.host}:${cfg.port}; device execution is a separate process`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    app.close(async () => {
      await store.close();
      process.exit(0);
    }),
  );
