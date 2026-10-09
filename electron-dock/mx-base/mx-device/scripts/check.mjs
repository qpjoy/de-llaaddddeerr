import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const file of ["manage.sh", "scripts/manage.sh"]) {
  const r = spawnSync("bash", ["-n", file], { stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
for (const dir of ["server", "scripts", "tests"])
  for (const file of await readdir(dir))
    if (file.endsWith(".mjs")) {
      const r = spawnSync(process.execPath, ["--check", `${dir}/${file}`], {
        stdio: "inherit",
      });
      if (r.status) process.exit(r.status);
    }
console.log("Node syntax checks passed");
