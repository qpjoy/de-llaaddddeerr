// Capacity is declared as a service level, not as raw permit counts: say what
// the deployment must sustain, and the admission limits follow from it. The
// same derivation runs at startup (to refuse an impossible promise) and is
// reported live, so headroom is observable instead of guessed.

const KB = 1024, MBIT = 1_000_000
const ceil = (value, floor) => Math.max(floor, Math.ceil(value))

export const DEFAULT_SLO = {
  assetQps: 10,           // sustained image/static reads per second
  assetP95Ms: 200,        // latency budget for that class
  assetSizeKb: 200,       // typical image size
  videoViewers: 30,       // concurrent video/audio streams
  videoBitrateKbps: 3000, // per stream
  burst: 4,               // headroom over the steady-state concurrency
  linkMbps: 1000,         // measure with iperf3
  diskReadMbps: 500,      // measure with fio; NVMe is far higher, HDD far lower
  utilisation: 0.7,       // never plan to run a shared link past this
}

export function planCapacity(slo = {}) {
  const input = { ...DEFAULT_SLO, ...slo }
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Capacity SLO ${name} must be a positive number`)
  }
  const { assetQps, assetP95Ms, assetSizeKb, videoViewers, videoBitrateKbps, burst, linkMbps, diskReadMbps, utilisation } = input

  // Little's law: the steady-state concurrency an SLO implies is rate x latency.
  // Permits are that, times a burst factor, so a normal spike is served rather
  // than shed -- the limit exists to stop a pile-up, not to enforce the average.
  const assetConcurrency = (assetQps * assetP95Ms) / 1000
  const maxAssetStreams = ceil(assetConcurrency * burst, 16)
  // A viewer seeking or reconnecting briefly holds two streams.
  const maxVideoStreams = ceil(videoViewers * 2, 32)
  // Disk-read permits cover the short manifest/stat/cache-fill phase of both
  // classes; byte transfers have already handed theirs back by then.
  const maxReads = ceil(assetConcurrency * burst + videoViewers / 4, 32)

  const assetMbps = (assetQps * assetSizeKb * KB * 8) / MBIT
  const videoMbps = (videoViewers * videoBitrateKbps) / 1000
  const totalMbps = assetMbps + videoMbps
  const linkShare = totalMbps / linkMbps
  const diskShare = totalMbps / (diskReadMbps * 8)

  const warnings = []
  if (linkShare > utilisation) warnings.push(`link: the SLO needs ${totalMbps.toFixed(0)} Mbps, which is ${(linkShare * 100).toFixed(0)}% of the declared ${linkMbps} Mbps link (planning limit ${(utilisation * 100).toFixed(0)}%)`)
  if (diskShare > utilisation) warnings.push(`disk: the SLO needs ${totalMbps.toFixed(0)} Mbps, which is ${(diskShare * 100).toFixed(0)}% of the declared ${diskReadMbps} MB/s of read throughput (planning limit ${(utilisation * 100).toFixed(0)}%)`)

  return {
    slo: input,
    limits: { maxReads, maxAssetStreams, maxVideoStreams },
    // Bytes the SLO actually asks for, so the promise can be checked against
    // measured hardware rather than assumed to fit.
    budget: {
      assetMbps: Number(assetMbps.toFixed(1)),
      videoMbps: Number(videoMbps.toFixed(1)),
      totalMbps: Number(totalMbps.toFixed(1)),
      linkUtilisation: Number(linkShare.toFixed(3)),
      diskUtilisation: Number(diskShare.toFixed(3)),
    },
    warnings,
    feasible: warnings.length === 0,
  }
}
