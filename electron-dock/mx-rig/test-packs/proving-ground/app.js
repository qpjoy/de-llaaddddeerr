// 试验场 · 星港物资台 — the page side. Plain DOM, no framework.
//
// Each defect in defects.json that lives in the page is behind `bug(id)`; the
// server says which are on. The fixed build is the same code with every
// branch taking its correct side.

;(function () {
  'use strict'

  const config = JSON.parse(document.getElementById('pg-config')?.textContent || '{"bugs":[]}')
  const bug = (id) => config.bugs.includes(id)
  const app = document.getElementById('app')

  const TEXT = {
    zh: {
      brand: '星港物资台',
      'nav.items': '物资列表',
      'nav.new': '新建',
      'nav.reports': '报表',
      'nav.settings': '设置',
      'login.title': '登录',
      'login.hint': '试验场演示环境：只需填写用户名。',
      'login.user': '用户名',
      'login.submit': '登录',
      'login.expired': '请先登录后再访问物资列表',
      'items.title': '物资列表',
      'items.keyword': '关键字',
      'items.status': '状态',
      'items.all': '全部',
      'items.active': '在用',
      'items.archived': '已归档',
      'items.search': '查询',
      'items.results': '筛选结果',
      'items.loading': '加载中…',
      'items.empty': '没有找到匹配的物资',
      'items.failed': '加载失败，请稍后再试',
      'items.name': '名称',
      'items.qty': '库存',
      'detail.title': '物资详情',
      'detail.id': '编号',
      'detail.owner': '负责人',
      'detail.unassigned': '未分配',
      'detail.favorite': '收藏',
      'detail.favorited': '已收藏',
      'detail.back': '返回列表',
      'new.title': '新建物资',
      'new.name': '名称',
      'new.submit': '提交',
      'new.saving': '保存中…',
      'reports.title': '报表',
      'reports.loading': '正在加载指标',
      'reports.outbound': '本月出库',
      'reports.inbound': '本月入库',
      'reports.stock': '当前库存',
      'reports.export': '导出报表',
      'reports.exporting': '正在导出…',
      'reports.exported': '导出完成：',
      'settings.title': '设置',
      'settings.language': '语言',
      'settings.notify': '通知偏好',
      'settings.save.button': '保存设置',
      'settings.saved': '已保存'
    },
    en: {
      brand: 'Starport Supplies',
      'nav.items': 'Items',
      'nav.new': 'New',
      'nav.reports': 'Reports',
      'nav.settings': 'Settings',
      'login.title': 'Sign in',
      'login.hint': 'Proving ground demo: a user name is all it takes.',
      'login.user': 'User name',
      'login.submit': 'Sign in',
      'login.expired': 'Please sign in to see the items',
      'items.title': 'Items',
      'items.keyword': 'Keyword',
      'items.status': 'Status',
      'items.all': 'All',
      'items.active': 'Active',
      'items.archived': 'Archived',
      'items.search': 'Search',
      'items.results': 'Results',
      'items.loading': 'Loading…',
      'items.empty': 'No matching items',
      'items.failed': 'Could not load, please try again',
      'items.name': 'Name',
      'items.qty': 'Stock',
      'detail.title': 'Item details',
      'detail.id': 'No.',
      'detail.owner': 'Owner',
      'detail.unassigned': 'Unassigned',
      'detail.favorite': 'Favorite',
      'detail.favorited': 'Favorited',
      'detail.back': 'Back to list',
      'new.title': 'New item',
      'new.name': 'Name',
      'new.submit': 'Submit',
      'new.saving': 'Saving…',
      'reports.title': 'Reports',
      'reports.loading': 'Loading figures',
      'reports.outbound': 'Outbound this month',
      'reports.inbound': 'Inbound this month',
      'reports.stock': 'In stock',
      'reports.export': 'Export report',
      'reports.exporting': 'Exporting…',
      'reports.exported': 'Exported: ',
      'settings.title': 'Settings',
      'settings.language': 'Language',
      'settings.notify': 'Notification preferences',
      'settings.saved': 'Saved'
    }
  }
  // PG-004: the English table has no entry for the save button, and the
  // lookup falls back to the key itself.
  if (!bug('PG-004')) TEXT.en['settings.save.button'] = 'Save settings'

  let lang = 'zh'
  try {
    lang = localStorage.getItem('pg-lang') === 'en' ? 'en' : 'zh'
  } catch {
    /* Storage blocked: Chinese. */
  }
  const t = (key) => (key in TEXT[lang] ? TEXT[lang][key] : key)

  /** An element with text and attributes; children appended in order. Never markup from data. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'text') node.textContent = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children) if (child) node.append(child)
    return node
  }

  const token = () => {
    try {
      return sessionStorage.getItem('pg-token')
    } catch {
      return null
    }
  }

  function api(path, options) {
    const headers = { 'content-type': 'application/json' }
    const held = token()
    if (held) headers.authorization = 'Bearer ' + held
    return fetch(path, Object.assign({ headers: headers }, options || {}))
  }

  function bar(current) {
    const link = (href, key) =>
      el('a', { href: href, 'aria-current': current === href ? 'page' : null, text: t(key) })
    return el(
      'header',
      { class: 'pg-bar' },
      el('strong', { text: t('brand') }),
      el('nav', { class: 'pg-row', 'aria-label': 'main' }, link('/items', 'nav.items'), link('/new', 'nav.new'), link('/reports', 'nav.reports'), link('/settings', 'nav.settings'))
    )
  }

  function frame(current, ...content) {
    app.replaceChildren(bar(current), el('main', null, ...content))
  }

  // -- login -------------------------------------------------------------------

  function login() {
    const expired = new URLSearchParams(location.search).get('expired') === '1'
    const input = el('input', { id: 'username', name: 'username', autocomplete: 'username' })
    const message = el('p', { role: 'alert', class: 'pg-alert', text: expired ? t('login.expired') : '' })
    const form = el(
      'form',
      {
        class: 'pg-card',
        onsubmit: function (event) {
          event.preventDefault()
          api('/api/login', { method: 'POST', body: JSON.stringify({ username: input.value }) })
            .then((res) => res.json().then((body) => ({ ok: res.ok, body: body })))
            .then(function (answer) {
              if (!answer.ok) {
                message.textContent = answer.body.error || '登录失败'
                return
              }
              // PG-010: the token rides in the address, into history, logs and referrers.
              if (bug('PG-010')) {
                location.href = '/items?token=' + encodeURIComponent(answer.body.token)
                return
              }
              sessionStorage.setItem('pg-token', answer.body.token)
              location.href = '/items'
            })
        }
      },
      el('p', { class: 'pg-muted', text: t('login.hint') }),
      el('div', { class: 'pg-field' }, el('label', { for: 'username', text: t('login.user') }), input),
      el('p', null, el('button', { type: 'submit', text: t('login.submit') })),
      message
    )
    app.replaceChildren(el('main', null, el('h1', { text: t('brand') + ' · ' + t('login.title') }), form))
  }

  // -- list --------------------------------------------------------------------

  const listState = { q: '', status: '', items: [], summary: '', failed: false, empty: false }

  function renderList() {
    const q = el('input', { id: 'q', value: listState.q })
    const status = el(
      'select',
      { id: 'status' },
      el('option', { value: '', text: t('items.all') }),
      el('option', { value: 'active', text: t('items.active') }),
      el('option', { value: 'archived', text: t('items.archived') })
    )
    status.value = listState.status
    const form = el(
      'form',
      {
        class: 'pg-card pg-filters',
        onsubmit: function (event) {
          event.preventDefault()
          listState.q = q.value.trim()
          listState.status = status.value
          loadList()
        }
      },
      el('div', { class: 'pg-field' }, el('label', { for: 'q', text: t('items.keyword') }), q),
      el('div', { class: 'pg-field' }, el('label', { for: 'status', text: t('items.status') }), status),
      el('button', { type: 'submit', text: t('items.search') })
    )
    // PG-002: `items` is null when nothing matched, and this reads it as a list
    // after the page has already been cleared.
    const rows = listState.items.map((item) =>
      el(
        'tr',
        null,
        el('td', null, el('a', { href: '/items/' + item.id, text: item.name })),
        el('td', { text: item.status === 'archived' ? t('items.archived') : t('items.active') }),
        el('td', { text: String(item.qty) })
      )
    )
    const results = el(
      'section',
      { class: 'pg-card', 'aria-labelledby': 'results-title' },
      el('h2', { id: 'results-title', text: t('items.results') }),
      listState.failed ? el('p', { role: 'alert', class: 'pg-alert', text: t('items.failed') }) : null,
      el('p', { class: 'pg-muted', role: 'status', text: listState.summary }),
      listState.empty
        ? el('p', { text: t('items.empty') })
        : el(
            'table',
            null,
            el('thead', null, el('tr', null, el('th', { text: t('items.name') }), el('th', { text: t('items.status') }), el('th', { text: t('items.qty') }))),
            el('tbody', null, ...rows)
          )
    )
    frame('/items', el('h1', { text: t('items.title') }), form, results)
  }

  function loadList() {
    listState.summary = t('items.loading')
    listState.failed = false
    renderList()
    const query = new URLSearchParams()
    if (listState.q) query.set('q', listState.q)
    if (listState.status) query.set('status', listState.status)
    api('/api/items?' + query.toString())
      .then(function (res) {
        if (res.status === 401) {
          // PG-012: an expired session reads as an empty list instead of a way back in.
          if (bug('PG-012')) return { items: [], total: 0 }
          location.href = '/login?expired=1'
          return null
        }
        if (!res.ok) {
          // PG-001's page half: the failure is swallowed and shown as nothing found.
          if (bug('PG-001')) return { items: [], total: 0, swallowed: true }
          return { failed: true }
        }
        return res.json()
      })
      .then(function (data) {
        if (!data) return
        // Rendered on the next tick, where a throw is the page's, uncaught.
        setTimeout(function () {
          listState.failed = Boolean(data.failed)
          listState.items = data.failed ? [] : data.items
          listState.empty = !data.failed && data.items !== null && data.items.length === 0 && Boolean(listState.q || listState.status) && !data.swallowed
          listState.summary = data.failed ? '' : '共 ' + data.total + ' 条'
          app.replaceChildren()
          renderList()
        })
      })
  }

  function list() {
    // PG-010's other half: a token handed over in the address is picked up from there.
    const handed = new URLSearchParams(location.search).get('token')
    if (handed) sessionStorage.setItem('pg-token', handed)
    loadList()
  }

  // -- detail ------------------------------------------------------------------

  function detail(id) {
    frame('/items', el('p', { class: 'pg-muted', text: t('items.loading') }))
    api('/api/items/' + id)
      .then((res) => (res.ok ? res.json() : null))
      .then(function (data) {
        if (!data) {
          frame('/items', el('p', { role: 'alert', class: 'pg-alert', text: t('items.failed') }))
          return
        }
        const item = data.item
        // PG-003: a missing owner is printed as whatever JavaScript makes of it.
        const owner = bug('PG-003') ? t('detail.owner') + '：' + item.owner : t('detail.owner') + '：' + (item.owner || t('detail.unassigned'))
        const favorite = el('button', { type: 'button', class: 'pg-ghost', 'aria-pressed': 'false', text: t('detail.favorite') })
        // PG-008: the button is drawn, and nothing listens to it.
        if (!bug('PG-008'))
          favorite.addEventListener('click', function () {
            const on = favorite.getAttribute('aria-pressed') !== 'true'
            favorite.setAttribute('aria-pressed', String(on))
            favorite.textContent = on ? t('detail.favorited') : t('detail.favorite')
          })
        frame(
          '/items',
          el('h1', { text: t('detail.title') }),
          el(
            'section',
            { class: 'pg-card' },
            el('h2', { text: item.name }),
            el(
              'dl',
              null,
              el('dt', { text: t('detail.id') }),
              el('dd', { text: '#' + item.id }),
              el('dt', { text: t('items.status') }),
              el('dd', { text: item.status === 'archived' ? t('items.archived') : t('items.active') }),
              el('dt', { text: t('items.qty') }),
              el('dd', { text: String(item.qty) })
            ),
            el('p', { text: owner }),
            el('p', { class: 'pg-row' }, favorite, el('a', { href: '/items', text: t('detail.back') }))
          )
        )
      })
  }

  // -- new ---------------------------------------------------------------------

  function create() {
    const id = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now())
    // One id per form: a second click is the same request, not a new record.
    const requestId = id()
    const name = el('input', { id: 'name', name: 'name' })
    const result = el('p', { role: 'status' })
    let pending = 0
    let made = 0
    const submit = el('button', {
      type: 'button',
      text: t('new.submit'),
      onclick: function () {
        pending += 1
        result.textContent = t('new.saving')
        // PG-011: no request id, and the button stays live while saving.
        const body = bug('PG-011') ? { name: name.value } : { name: name.value, requestId: requestId }
        api('/api/items', { method: 'POST', body: JSON.stringify(body) })
          .then((res) => res.json())
          .then(function (answer) {
            if (answer.item && !answer.duplicate) made += 1
          })
          .finally(function () {
            pending -= 1
            if (!pending) result.textContent = '保存完成，本次共创建 ' + made + ' 条'
          })
      }
    })
    frame(
      '/new',
      el('h1', { text: t('new.title') }),
      el('section', { class: 'pg-card' }, el('div', { class: 'pg-field' }, el('label', { for: 'name', text: t('new.name') }), name), el('p', null, submit), result)
    )
  }

  // -- reports -----------------------------------------------------------------

  function reports() {
    // PG-006: a chart configuration that never parses, on every visit.
    if (bug('PG-006')) console.error('图表配置解析失败：unexpected token } in chart config at position 118')
    const kpis = el('div', { class: 'pg-kpis' }, el('div', { role: 'progressbar', 'aria-label': t('reports.loading'), class: 'pg-muted', text: t('reports.loading') + '…' }))
    const outcome = el('div', { class: 'pg-row' })
    const exportButton = el('button', {
      type: 'button',
      text: t('reports.export'),
      onclick: function () {
        outcome.replaceChildren(el('div', { role: 'progressbar', 'aria-label': t('reports.exporting'), class: 'pg-muted', text: t('reports.exporting') }))
        api('/api/reports/export')
          .then((res) => res.json())
          .then(function (data) {
            outcome.replaceChildren(el('p', { role: 'status', text: t('reports.exported') + data.file }))
          })
          .catch(function () {
            outcome.replaceChildren(el('p', { role: 'alert', class: 'pg-alert', text: t('items.failed') }))
          })
      }
    })
    frame('/reports', el('h1', { text: t('reports.title') }), el('section', { class: 'pg-card' }, kpis), el('section', { class: 'pg-card pg-row' }, exportButton, outcome))
    api('/api/reports/kpi')
      .then((res) => res.json())
      .then(function (data) {
        const card = (key, value) => el('div', { class: 'pg-kpi' }, el('span', { class: 'pg-muted', text: t(key) }), el('b', { text: String(value) }))
        kpis.replaceChildren(card('reports.outbound', data.outbound), card('reports.inbound', data.inbound), card('reports.stock', data.stock))
      })
  }

  // -- settings ----------------------------------------------------------------

  function settings() {
    const language = el('select', { id: 'language' }, el('option', { value: 'zh', text: '中文' }), el('option', { value: 'en', text: 'English' }))
    language.value = lang
    language.addEventListener('change', function () {
      lang = language.value === 'en' ? 'en' : 'zh'
      try {
        localStorage.setItem('pg-lang', lang)
      } catch {
        /* Not remembered; this page still switches. */
      }
      settings()
    })
    const saved = el('p', { role: 'status' })
    frame(
      '/settings',
      el('h1', { text: t('settings.title') }),
      el(
        'section',
        { class: 'pg-card' },
        el('div', { class: 'pg-field' }, el('label', { for: 'language', text: t('settings.language') }), language),
        el(
          'p',
          { class: 'pg-row' },
          // PG-005: a fixed-width button with the overflow cut off and no title.
          el('button', { type: 'button', class: bug('PG-005') ? 'pg-ghost pg-fixed' : 'pg-ghost', text: t('settings.notify'), onclick: function () {} }),
          el('button', {
            type: 'button',
            text: t('settings.save.button'),
            onclick: function () {
              saved.textContent = t('settings.saved')
            }
          })
        ),
        saved
      )
    )
  }

  // -- routes ------------------------------------------------------------------

  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  const path = location.pathname.replace(/\/$/, '') || '/login'
  const item = path.match(/^\/items\/(\d+)$/)
  if (path === '/login') login()
  else if (path === '/items') list()
  else if (item) detail(item[1])
  else if (path === '/new') create()
  else if (path === '/reports') reports()
  else if (path === '/settings') settings()
  else app.replaceChildren(el('main', null, el('h1', { text: '404' })))
})()
