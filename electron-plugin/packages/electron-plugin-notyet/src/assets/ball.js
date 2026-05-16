// NotYet ball renderer logic — phase 2.2.
//
// Reverted to mouse events (worked in phase 1; Chromium's pointer-events
// hit testing under `setIgnoreMouseEvents(true, { forward: true })` was
// flaky, causing the ball to feel "unclickable"). Click vs drag is
// disambiguated by a 5 px movement threshold during mousemove, and a
// `clickSuppressed` flag swallows the click event that follows a real drag.
//
// Hot-zone tracking moved to the main process via cursor polling — the
// renderer reports the orbit rect; main flips `setIgnoreMouseEvents` based
// on `screen.getCursorScreenPoint()`. That's robust independent of
// whatever Chromium quirks affect forwarded mousemove events.
(function () {
  'use strict';

  const COLLAPSE_DELAY_MS = 3000;
  const DRAG_THRESHOLD_PX = 5;

  const api = window.notyetBall;
  if (!api) {
    document.body.innerHTML = '<pre style="color:#d4a548;padding:24px">notyetBall preload missing</pre>';
    return;
  }
  const orbit = document.getElementById('orbit');
  const ball = document.getElementById('ball');
  const sparks = document.querySelector('.sparks');
  const petals = Array.from(orbit.querySelectorAll('.petal'));
  const backBtn = orbit.querySelector('[data-action="back"]');

  /* ── Position state ───────────────────────────────────────────────── */

  // Normalised ball-center fractions of window dims. Default bottom-right.
  let position = { fx: 1, fy: 1 };
  let collapseTimer = null;
  let isExpanded = false;
  let coverOpen = false;

  // Active drag interaction.
  let drag = null;
  // Set true between a drag's mouseup and the next click event so we can
  // swallow the synthetic click that browsers emit after the user lifts off.
  let clickSuppressed = false;

  function geom() {
    const cs = getComputedStyle(document.documentElement);
    return {
      petalSize:   px(cs, '--petal-size',   56),
      petalRadius: px(cs, '--petal-radius', 92),
      menuMargin:  px(cs, '--menu-margin',  16)
    };
  }
  function px(cs, name, fb) { const v = parseFloat(cs.getPropertyValue(name)); return isFinite(v) ? v : fb; }

  /* ── Apply position + report hot zone to main ─────────────────────── */

  function safeBounds() {
    const g = geom();
    const required = g.petalRadius + g.petalSize / 2 + g.menuMargin;
    const w = window.innerWidth, h = window.innerHeight;
    if (w < required * 2 + 1 || h < required * 2 + 1) {
      return { minX: w / 2, maxX: w / 2, minY: h / 2, maxY: h / 2 };
    }
    return { minX: required, maxX: w - required, minY: required, maxY: h - required };
  }

  function applyPosition() {
    const w = window.innerWidth, h = window.innerHeight;
    const b = safeBounds();
    const ballCx = clamp(position.fx * w, b.minX, b.maxX);
    const ballCy = clamp(position.fy * h, b.minY, b.maxY);
    const orbitSize = orbit.offsetWidth || 240;
    orbit.style.right = 'auto';
    orbit.style.bottom = 'auto';
    orbit.style.left = (ballCx - orbitSize / 2) + 'px';
    orbit.style.top  = (ballCy - orbitSize / 2) + 'px';
    syncSparksToBall(ballCx, ballCy);
    reportHotRect();
  }

  function syncSparksToBall(cx, cy) {
    if (!sparks) return;
    sparks.style.setProperty('--spark-cx', cx + 'px');
    sparks.style.setProperty('--spark-cy', cy + 'px');
  }

  function reportHotRect() {
    // Report the FULL orbit rect so main's cursor-polling treats the entire
    // 240×240 area as a hot zone. That keeps capture mode active while the
    // user sweeps from ball → petal.
    const r = orbit.getBoundingClientRect();
    api.setHotRect({ x: r.left, y: r.top, w: r.width, h: r.height });
  }

  async function loadPosition() {
    try {
      const saved = await api.loadPosition();
      if (saved && typeof saved.fx === 'number' && typeof saved.fy === 'number') {
        position = { fx: saved.fx, fy: saved.fy };
      }
    } catch (err) {
      console.warn('[notyet] failed to load saved position', err);
    }
    applyPosition();
  }

  async function persistPosition() {
    try { await api.savePosition({ ...position }); }
    catch (err) { console.warn('[notyet] failed to save position', err); }
  }

  /* ── Expand / collapse ────────────────────────────────────────────── */

  function expand() {
    if (isExpanded) return;
    isExpanded = true;
    orbit.dataset.state = 'expanded';
    armCollapseTimer();
  }
  function collapse() {
    if (!isExpanded) return;
    isExpanded = false;
    orbit.dataset.state = 'collapsed';
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  }
  function armCollapseTimer() {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      // If the cursor is still inside the orbit, re-arm. Otherwise collapse.
      // We can't reliably detect this from the renderer alone, so just trust
      // the user to move the cursor out (or click) — collapse triggers and
      // a fresh hover re-expands.
      collapse();
    }, COLLAPSE_DELAY_MS);
  }

  /* ── Mouse-driven click + drag ────────────────────────────────────── */

  ball.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = {
      startX: e.clientX, startY: e.clientY,
      origFx: position.fx, origFy: position.fy,
      moved: false
    };
    ball.classList.add('is-dragging');
    orbit.classList.add('is-dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    // Lock main's polling into capture mode for the duration of the drag.
    api.setDrag(true);
  });

  function onDragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.moved = true;
      collapse();  // never drag with petals fanned open
    }
    if (drag.moved) {
      const w = window.innerWidth, h = window.innerHeight;
      position.fx = clamp(drag.origFx + dx / w, 0, 1);
      position.fy = clamp(drag.origFy + dy / h, 0, 1);
      applyPosition();
    }
  }

  function onDragEnd() {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    ball.classList.remove('is-dragging');
    orbit.classList.remove('is-dragging');
    api.setDrag(false);
    if (wasMoved) {
      clickSuppressed = true;  // swallow the synthetic click that follows
      persistPosition();
    }
  }

  // The natural click event handles single taps. Drags suppress it via the
  // `clickSuppressed` flag set in `onDragEnd`.
  ball.addEventListener('click', (e) => {
    e.stopPropagation();
    if (clickSuppressed) {
      clickSuppressed = false;
      return;
    }
    if (isExpanded) collapse();
    else expand();
  });

  /* ── Petal actions ─────────────────────────────────────────────────── */

  for (const btn of petals) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const action = btn.dataset.action;
      try {
        if (action === 'chat')      await api.openChat();
        else if (action === 'back') await api.closeChat();
        else if (action === 'hide') await api.hideBall();
      } catch (err) {
        console.warn('[notyet] petal action failed', err);
      }
      collapse();
    });
  }

  /* ── Cover state — enable/disable "返回" petal ──────────────────────── */

  function applyCoverState(coverIsOpen) {
    coverOpen = coverIsOpen;
    if (backBtn) backBtn.disabled = !coverOpen;
  }
  api.queryState()
    .then((state) => { if (state && typeof state.coverOpen === 'boolean') applyCoverState(state.coverOpen); })
    .catch(() => {});
  api.onCoverState((payload) => {
    if (payload && typeof payload.coverOpen === 'boolean') applyCoverState(payload.coverOpen);
  });

  /* ── Window resize ─────────────────────────────────────────────────── */

  window.addEventListener('resize', applyPosition);

  /* ── Init ──────────────────────────────────────────────────────────── */

  loadPosition();

  /* ── helpers ──────────────────────────────────────────────────────── */

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
})();
