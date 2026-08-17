// Server-rendered run report.
//
// Rendered here rather than taken from the runner: a report built by the tool
// under test is tied to that tool's layout and its relative-path quirks (compass
// needed a patch just to make mochawesome's video links resolve). Rendering from
// the normalized records gives every engine the same report, and lets the step
// timeline seek the recording — which is what makes a failure reviewable without
// watching the whole thing.

const STATUS_LABEL = {
  passed: '通过',
  failed: '失败',
  flaky: '不稳定',
  skipped: '跳过',
  notRun: '未执行',
  blocked: '受阻',
  expired: '已过期',
  timeout: '超时',
  cancelled: '已取消',
  running: '执行中',
  queued: '排队中',
  'pending-runner': '等待执行机',
}

const STATUS_TONE = {
  passed: 'success',
  flaky: 'warning',
  failed: 'danger',
  blocked: 'danger',
  timeout: 'danger',
  notRun: 'muted',
  skipped: 'muted',
  expired: 'muted',
  cancelled: 'muted',
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const clock = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const duration = (ms) => {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

const statusTag = (status) =>
  `<span class="mxt-status mxt-status--${STATUS_TONE[status] ?? 'muted'}">${
    STATUS_LABEL[status] ?? escapeHtml(status)
  }</span>`

/**
 * Pick the recording that belongs to a case.
 *
 * Cypress names a video after its spec file, so several cases in one spec share
 * one recording — matching on the spec path is what makes the step timeline land
 * on the right file instead of the first video in the run.
 */
function recordingFor(testCase, artifacts) {
  const videos = artifacts.filter((entry) => /\.(mp4|webm)$/iu.test(entry.path))
  if (videos.length === 0) return null
  if (testCase.specPath) {
    const specName = testCase.specPath.split('/').pop()
    const bySpec = videos.find((entry) => entry.path.includes(specName))
    if (bySpec) return bySpec
  }
  const byCase = videos.find((entry) => entry.path.includes(testCase.caseId))
  return byCase ?? (videos.length === 1 ? videos[0] : null)
}

function renderSteps(testCase, recording, artifactBase) {
  if (!testCase.steps?.length) {
    return '<p class="mxt-empty">这个用例没有上报步骤。在 spec 里用 <code>step()</code> 包裹用户可见动作即可获得可点击的时间轴。</p>'
  }
  const rows = testCase.steps
    .map(
      (step) => `
        <li class="mxt-step mxt-step--${STATUS_TONE[step.status] ?? 'muted'}">
          <span class="mxt-step__seq">${step.seq}</span>
          <span class="mxt-step__label">${escapeHtml(step.label)}</span>
          ${
            step.offsetMs != null && recording
              ? `<button class="mxt-step__time" data-seek="${(step.offsetMs / 1000).toFixed(
                  2,
                )}" type="button" title="跳到录像的这一刻">${clock(step.offsetMs)}</button>`
              : `<span class="mxt-step__time is-plain">${
                  step.offsetMs != null ? clock(step.offsetMs) : '—'
                }</span>`
          }
        </li>`,
    )
    .join('')

  return `
    <div class="mxt-playback">
      ${
        recording
          ? `<video class="mxt-video" controls preload="metadata" src="${artifactBase}/${encodeURI(
              recording.path,
            )}"></video>`
          : '<p class="mxt-empty">这个用例没有录像。</p>'
      }
      <ol class="mxt-steps">${rows}</ol>
    </div>`
}

const when = (iso) => {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  // Rendered in the platform's own zone. An ISO string with a Z on the end is
  // technically precise and useless to the person reading the report.
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

function renderCase(testCase, artifacts, artifactBase) {
  const recording = recordingFor(testCase, artifacts)
  const shots = artifacts.filter(
    (entry) => /\.(png|jpe?g)$/iu.test(entry.path) && entry.path.includes(testCase.caseId),
  )
  return `
    <details class="mxt-case" ${testCase.status === 'failed' ? 'open' : ''}>
      <summary class="mxt-case__head">
        ${statusTag(testCase.status)}
        <code class="mxt-case__id">${escapeHtml(testCase.caseId)}</code>
        <span class="mxt-case__title">${escapeHtml(testCase.title ?? '')}</span>
        <span class="mxt-case__meta">${duration(testCase.durationMs)}${
          testCase.attempts > 1 ? ` · 重试 ${testCase.attempts - 1} 次` : ''
        }</span>
      </summary>
      <div class="mxt-case__body">
        ${
          testCase.specPath
            ? `<p class="mxt-case__spec">实现于 <code>${escapeHtml(testCase.specPath)}</code></p>`
            : testCase.pendingImplementation
              ? '<p class="mxt-case__spec mxt-case__spec--missing">尚无实现代码。这条用例已登记在目录里，等待工程师补 spec。</p>'
              : ''
        }
        ${testCase.errorText ? `<pre class="mxt-error">${escapeHtml(testCase.errorText)}</pre>` : ''}
        ${renderSteps(testCase, recording, artifactBase)}
        ${
          shots.length
            ? `<div class="mxt-shots">${shots
                .map(
                  (shot) =>
                    `<a href="${artifactBase}/${encodeURI(
                      shot.path,
                    )}" target="_blank" rel="noreferrer"><img loading="lazy" src="${artifactBase}/${encodeURI(
                      shot.path,
                    )}" alt="${escapeHtml(shot.path)}"></a>`,
                )
                .join('')}</div>`
            : ''
        }
      </div>
    </details>`
}

/**
 * @param {object} options.run       the run record
 * @param {Array}  options.cases     run cases, each with `steps`
 * @param {Array}  options.artifacts files on disk for this run
 * @param {object} options.app       the application record
 * @param {boolean} options.redacted strip internal hostnames, spec paths and stack traces
 */
export function renderReport({ run, cases, artifacts, app, suite, redacted = false, brand = null }) {
  const artifactBase = `/api/v1/runs/${run.id}/artifacts`
  const counts = run.catalog?.counts ?? {}
  const coverage = run.catalog?.coverage ?? {}

  const visibleCases = cases.map((entry) => {
    // Whether a case still lacks an implementation is decided before redaction.
    // Redaction removes the spec *path* because it leaks repository layout —
    // it does not mean the case is unimplemented, and reading it that way would
    // tell a customer the opposite of the truth.
    const pendingImplementation = !entry.specPath && entry.status === 'notRun'
    return redacted
      ? { ...entry, pendingImplementation, specPath: null, errorText: null }
      : { ...entry, pendingImplementation }
  })

  const tiles = [
    ['结果', STATUS_LABEL[run.status] ?? run.status, STATUS_TONE[run.status] ?? 'muted'],
    ['通过', counts.passed ?? 0, 'success'],
    ['失败', counts.failed ?? 0, (counts.failed ?? 0) > 0 ? 'danger' : 'muted'],
    ['不稳定', counts.flaky ?? 0, (counts.flaky ?? 0) > 0 ? 'warning' : 'muted'],
    ['未执行', counts.notRun ?? 0, (counts.notRun ?? 0) > 0 ? 'warning' : 'muted'],
    ['耗时', duration(run.durationMs), 'muted'],
  ]

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试报告 · ${escapeHtml(app?.displayName ?? run.appId)}</title>
<link rel="stylesheet" href="/vendor/neon-void.css">
<link rel="stylesheet" href="/assets/report.css">
</head>
<body class="qp-app qp-theme-neon-void qp-density--medium mxt-report">
<header class="mxt-report__head">
  <div>
    <p class="qp-caption qp-muted">${escapeHtml(brand ?? 'MX 测试平台')}</p>
    <h1 class="qp-heading-1">${escapeHtml(app?.displayName ?? run.appId)} · 测试报告</h1>
    <p class="qp-body-2 qp-muted">
      ${escapeHtml(suite?.displayName ?? '')} ·
      ${escapeHtml(run.profile)} / ${escapeHtml(run.track)} ·
      ${escapeHtml(when(run.finishedAt ?? run.queuedAt))}
      ${redacted ? '' : run.targetUrl ? ` · <code>${escapeHtml(run.targetUrl)}</code>` : ''}
    </p>
  </div>
  ${redacted ? '<span class="qp-tag">对外版本 · 已脱敏</span>' : ''}
</header>

${
  run.blockedReason
    ? `<div class="mxt-banner mxt-banner--danger">
         <strong>本次执行受阻，不算通过。</strong> ${escapeHtml(run.blockedReason)}
         <p class="qp-body-2">受阻表示环境或配置问题（目标不可达、浏览器起不来、没有用例），不是产品缺陷。</p>
       </div>`
    : ''
}

<section class="mxt-tiles">
  ${tiles
    .map(
      ([label, value, tone]) => `
    <div class="mxt-tile mxt-tile--${tone}">
      <p class="qp-caption qp-muted">${label}</p>
      <p class="mxt-tile__value">${escapeHtml(String(value))}</p>
    </div>`,
    )
    .join('')}
</section>

<section class="mxt-coverage">
  <h2 class="qp-heading-2">覆盖情况</h2>
  <p class="qp-body-2 qp-muted">
    三个百分比的分母不同，不能互相替代，也都不等于产品需求覆盖率。
  </p>
  <div class="mxt-coverage__grid">
    <div><span class="qp-caption qp-muted">目录执行率</span><b>${
      coverage.catalogCompletionPercent ?? 0
    }%</b><span class="qp-caption qp-muted">该跑的跑到了吗（分母：目录 ${
      run.catalog?.catalogTotal ?? 0
    } 条）</span></div>
    <div><span class="qp-caption qp-muted">目录通过率</span><b>${
      coverage.catalogPassPercent ?? 0
    }%</b><span class="qp-caption qp-muted">该跑的都过了吗（同上分母）</span></div>
    <div><span class="qp-caption qp-muted">执行通过率</span><b>${
      coverage.executedPassPercent ?? 0
    }%</b><span class="qp-caption qp-muted">跑到的里面过了多少</span></div>
    <div><span class="qp-caption qp-muted">需求关联率</span><b>${
      coverage.requirementLinkedPercent ?? 0
    }%</b><span class="qp-caption qp-muted">有多少用例能追溯到需求</span></div>
  </div>
</section>

<section class="mxt-cases">
  <h2 class="qp-heading-2">用例明细 <span class="qp-body-2 qp-muted">${
    visibleCases.length
  } 条</span></h2>
  ${
    visibleCases.length === 0
      ? '<p class="mxt-empty">没有用例结果。</p>'
      : visibleCases.map((entry) => renderCase(entry, artifacts, artifactBase)).join('')
  }
</section>

<script>
// Clicking a step seeks the recording that sits in the same case block.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-seek]');
  if (!button) return;
  const video = button.closest('.mxt-case__body')?.querySelector('video');
  if (!video) return;
  video.currentTime = Number(button.dataset.seek);
  video.play().catch(() => {});
});
</script>
</body>
</html>`
}
