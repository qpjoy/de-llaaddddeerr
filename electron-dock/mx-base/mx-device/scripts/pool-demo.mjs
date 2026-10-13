import {
  POOL_SCENARIOS,
  runPoolSimulation,
} from "../server/pool-simulator.mjs";

const [scenario = "mixed", count = "10", seed = "42", format] =
  process.argv.slice(2);
if (scenario === "--help") {
  console.log(
    "npm run demo:pool -- <scenario> <devices:2|10|20|50|100> <seed> [--json]",
  );
  for (const entry of POOL_SCENARIOS) console.log(`${entry.id}: ${entry.name}`);
} else {
  try {
    const report = runPoolSimulation({
      scenario,
      deviceCount: Number(count),
      seed: Number(seed),
    });
    if (format === "--json") console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `${report.name} · ${report.deviceCount} 台 · seed ${report.seed} · 仅模拟`,
      );
      const row = (name, s) => ({
        strategy: name,
        completed: s.completed,
        unresolved: s.failed + s.queued,
        makespanMs: s.makespanMs,
        waitP95Ms: s.waitP95Ms,
        appSwitches: s.appSwitches,
        replans: s.replans,
        peak: s.peakConcurrency,
        violations: s.invariantViolations,
      });
      console.table([
        row("adaptive", report.summary),
        row("spread", report.baseline),
      ]);
      console.log(
        "同负载策略比较；不代表真实手机性能或通用最优。使用 --json 输出完整参数、事件与边界。",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
