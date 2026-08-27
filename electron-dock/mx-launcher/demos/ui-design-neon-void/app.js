const app = document.querySelector('.demo-app');
const densityButtons = Array.from(document.querySelectorAll('[data-density]'));
const themeButtons = Array.from(document.querySelectorAll('[data-theme]'));
const partialCheck = document.querySelector('#partial-check');
const dropdowns = Array.from(document.querySelectorAll('[data-dropdown]'));
const routeTitle = document.querySelector('#route-title');
const routeKicker = document.querySelector('#route-kicker');
const routeSections = Array.from(document.querySelectorAll('[data-route]'));
const routeLinks = Array.from(document.querySelectorAll('[data-route-link]'));
const paginationDemo = document.querySelector('[data-pagination-demo]');
const basePath = '/demos/ui-design-neon-void';

const routeMeta = {
  overview: {
    title: 'Project Console',
    kicker: 'EFFECTIVE CONTROL SURFACE'
  },
  market: {
    title: 'AppCenter Market',
    kicker: 'CATALOG / PACKAGE / INSPECTOR'
  },
  buttons: {
    title: 'Buttons',
    kicker: 'ACTIONS / STATES / DENSITY'
  },
  inputs: {
    title: 'Inputs',
    kicker: 'FIELDS / COORDINATES / SLIDERS'
  },
  dropdowns: {
    title: 'Dropdowns & Selection',
    kicker: 'CUSTOM MENUS / CHOICES'
  },
  feedback: {
    title: 'Feedback',
    kicker: 'DIALOGS / TOASTS / ACTIONBARS'
  },
  settings: {
    title: 'Settings',
    kicker: 'APP SHELL / INSTALLATION'
  },
  properties: {
    title: 'Properties & Panels',
    kicker: 'EDITOR INSPECTOR / PRESETS'
  },
  icons: {
    title: 'Icons',
    kicker: 'CANVAS / STROKES / CATEGORIES'
  },
  tokens: {
    title: 'Tokens',
    kicker: 'COLOR / TYPOGRAPHY / EFFECTS'
  }
};

function routeFromPath(pathname) {
  const normalized = pathname.replace(/\/+$/, '');
  if (normalized === basePath || normalized === '') return 'overview';
  if (!normalized.startsWith(`${basePath}/`)) return 'overview';
  const route = normalized.slice(basePath.length + 1).split('/')[0] || 'overview';
  return routeMeta[route] ? route : 'overview';
}

function routeHref(route) {
  return route === 'overview' ? `${basePath}/` : `${basePath}/${route}`;
}

function renderRoute(route, mode = 'push') {
  const meta = routeMeta[route] || routeMeta.overview;
  for (const section of routeSections) {
    section.hidden = section.dataset.route !== route;
  }
  for (const link of routeLinks) {
    const active = link.dataset.routeLink === route;
    link.classList.toggle('is-selected', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  if (routeTitle) routeTitle.textContent = meta.title;
  if (routeKicker) routeKicker.textContent = meta.kicker;
  const nextPath = routeHref(route);
  if (window.location.pathname !== nextPath) {
    const state = { route };
    if (mode === 'replace') {
      window.history.replaceState(state, '', nextPath);
    } else {
      window.history.pushState(state, '', nextPath);
    }
  }
  document.querySelector('.demo-main')?.scrollTo({ top: 0, left: 0 });
}

for (const link of routeLinks) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const route = link.dataset.routeLink || 'overview';
    renderRoute(route);
  });
}

window.addEventListener('popstate', () => {
  renderRoute(routeFromPath(window.location.pathname), 'replace');
});

renderRoute(routeFromPath(window.location.pathname), 'replace');

if (partialCheck) {
  partialCheck.indeterminate = true;
}

for (const button of densityButtons) {
  button.addEventListener('click', () => {
    const density = button.dataset.density;
    if (!density || !app) return;
    app.classList.remove('qp-density--small', 'qp-density--medium', 'qp-density--large');
    app.classList.add(`qp-density--${density}`);
    for (const item of densityButtons) {
      item.classList.toggle('is-active', item === button);
    }
  });
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.theme;
    if (!app || !['dark', 'light'].includes(theme)) return;
    app.classList.remove('qp-theme-neon-void', 'qp-theme-neon-void-light');
    app.classList.add(theme === 'light' ? 'qp-theme-neon-void-light' : 'qp-theme-neon-void');
    for (const item of themeButtons) {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  });
}

function closeDropdown(dropdown) {
  dropdown.classList.remove('is-open');
  dropdown.querySelector('.qp-dropdown__trigger')?.setAttribute('aria-expanded', 'false');
  for (const option of dropdown.querySelectorAll('.qp-dropdown__option')) {
    option.classList.remove('is-highlighted');
  }
}

function openDropdown(dropdown) {
  for (const item of dropdowns) {
    if (item !== dropdown) closeDropdown(item);
  }
  dropdown.classList.add('is-open');
  dropdown.querySelector('.qp-dropdown__trigger')?.setAttribute('aria-expanded', 'true');
  const search = dropdown.querySelector('.qp-dropdown__search input');
  if (search instanceof HTMLInputElement) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
    window.requestAnimationFrame(() => search.focus());
  }
}

for (const dropdown of dropdowns) {
  const trigger = dropdown.querySelector('.qp-dropdown__trigger');
  const value = dropdown.querySelector('[data-dropdown-value]');
  const options = Array.from(dropdown.querySelectorAll('.qp-dropdown__option'));
  const search = dropdown.querySelector('.qp-dropdown__search input');
  const empty = dropdown.querySelector('.qp-dropdown__empty');
  const groups = Array.from(dropdown.querySelectorAll('.qp-dropdown__group'));

  const visibleOptions = () => options.filter((option) => !option.hidden && !option.disabled);
  const highlight = (option) => {
    for (const item of options) item.classList.toggle('is-highlighted', item === option);
    option?.scrollIntoView({ block: 'nearest' });
  };
  const moveHighlight = (delta) => {
    const visible = visibleOptions();
    if (!visible.length) return;
    const current = visible.findIndex((option) => option.classList.contains('is-highlighted'));
    const next = current < 0 ? (delta > 0 ? 0 : visible.length - 1) : (current + delta + visible.length) % visible.length;
    highlight(visible[next]);
  };
  const choose = (option) => {
    if (!option) return;
    const nextValue = option.dataset.value || option.textContent?.trim() || '';
    if (value) value.textContent = nextValue;
    for (const item of options) {
      const selected = item === option;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    closeDropdown(dropdown);
    trigger?.focus();
  };
  const filterOptions = () => {
    const query = search instanceof HTMLInputElement ? search.value.trim().toLocaleLowerCase() : '';
    for (const option of options) {
      option.hidden = Boolean(query) && !(option.dataset.value || option.textContent || '').toLocaleLowerCase().includes(query);
    }
    for (const group of groups) group.hidden = visibleOptions().length === 0;
    if (empty instanceof HTMLElement) empty.hidden = visibleOptions().length > 0;
    highlight(visibleOptions()[0]);
  };

  trigger?.addEventListener('click', () => {
    if (dropdown.classList.contains('is-open')) {
      closeDropdown(dropdown);
    } else {
      openDropdown(dropdown);
    }
  });

  trigger?.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!dropdown.classList.contains('is-open')) openDropdown(dropdown);
      else moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!dropdown.classList.contains('is-open')) openDropdown(dropdown);
      else choose(visibleOptions().find((option) => option.classList.contains('is-highlighted')) || visibleOptions()[0]);
    } else if (event.key === 'Escape') {
      closeDropdown(dropdown);
    }
  });

  search?.addEventListener('input', filterOptions);
  search?.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const visible = visibleOptions();
      highlight(event.key === 'Home' ? visible[0] : visible.at(-1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visibleOptions().find((item) => item.classList.contains('is-highlighted')) || visibleOptions()[0];
      if (option) choose(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeDropdown(dropdown);
      trigger?.focus();
    }
  });

  for (const option of options) {
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('mouseenter', () => highlight(option));
    option.addEventListener('click', () => choose(option));
  }
}

function paginationItems(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const candidates = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right);
  const items = [];
  for (const value of candidates) {
    const previous = items.at(-1);
    if (typeof previous === 'number' && value - previous > 1) items.push(`ellipsis-${value}`);
    items.push(value);
  }
  return items;
}

function renderPaginationDemo(page) {
  if (!paginationDemo) return;
  const total = Number(paginationDemo.dataset.total);
  const pageSize = Number(paginationDemo.dataset.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number.isSafeInteger(page) ? page : Number(paginationDemo.dataset.page) || 1;
  const currentPage = Math.min(totalPages, Math.max(1, requestedPage));
  paginationDemo.dataset.page = String(currentPage);
  const summary = paginationDemo.querySelector('[data-pagination-summary]');
  if (summary) summary.textContent = `${total.toLocaleString()} records · ${pageSize} per page · Page ${currentPage} / ${totalPages}`;
  const pages = paginationDemo.querySelector('[data-pagination-pages]');
  pages?.replaceChildren(...paginationItems(currentPage, totalPages).map((item) => {
    if (typeof item !== 'number') {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'qp-pagination__ellipsis';
      ellipsis.textContent = '…';
      ellipsis.setAttribute('aria-hidden', 'true');
      return ellipsis;
    }
    const button = document.createElement('button');
    button.className = `qp-pagination__page${item === currentPage ? ' is-active' : ''}`;
    button.type = 'button';
    button.textContent = String(item);
    button.dataset.page = String(item);
    button.setAttribute('aria-label', `Page ${item}`);
    if (item === currentPage) button.setAttribute('aria-current', 'page');
    return button;
  }));
  const previous = paginationDemo.querySelector('[data-pagination-previous]');
  const next = paginationDemo.querySelector('[data-pagination-next]');
  if (previous) previous.disabled = currentPage <= 1;
  if (next) next.disabled = currentPage >= totalPages;
  const input = paginationDemo.querySelector('[data-pagination-jump] input');
  if (input) input.value = String(currentPage);
}

if (paginationDemo) {
  paginationDemo.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const currentPage = Number(paginationDemo.dataset.page);
    if (target.closest('[data-pagination-previous]')) renderPaginationDemo(currentPage - 1);
    if (target.closest('[data-pagination-next]')) renderPaginationDemo(currentPage + 1);
    const pageButton = target.closest('.qp-pagination__page[data-page]');
    if (pageButton) renderPaginationDemo(Number(pageButton.dataset.page));
  });
  paginationDemo.querySelector('[data-pagination-jump]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = paginationDemo.querySelector('[data-pagination-jump] input');
    renderPaginationDemo(Number(input?.value));
  });
  renderPaginationDemo(Number(paginationDemo.dataset.page));
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const dropdown of dropdowns) {
    if (!dropdown.contains(target)) closeDropdown(dropdown);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const dropdown of dropdowns) {
    closeDropdown(dropdown);
  }
});
