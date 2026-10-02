#!/usr/bin/env node
// mx-rig — MX Rig in a terminal.
//
// In a project directory it is a test engineer you talk to, like a coding
// agent in a terminal: it reads the code, runs the project's own tests,
// explains failures, writes and fixes tests — every command and every change
// shown to you first. On a test machine it is a station (工位) that replays
// procedure regression the service queued. Either way the work happens here;
// the service keeps the policy, the model keys and the record.
//
//   mx-rig [目标]              会话（见 mx-rig --help）
//   mx-rig station …           工位（见 apps/terminal/station.mjs）
//
// Each command family is loaded on its own, so the station image carries only
// what a station needs.

const [group, ...rest] = process.argv.slice(2)
try {
  if (group === 'station') {
    const { stationCommand } = await import('../apps/terminal/station.mjs')
    await stationCommand(rest)
  } else {
    const { main } = await import('../apps/terminal/cli.mjs')
    process.exitCode = await main(process.argv.slice(2))
    // Timers of a finished session (sync back-off, a browser's) must not keep
    // a finished command alive.
    process.exit()
  }
} catch (error) {
  if (process.env.MX_RIG_DEBUG_ERRORS === '1') console.error(error)
  console.error(`[mx-rig] ✗ ${error.message}`)
  process.exit(1)
}
