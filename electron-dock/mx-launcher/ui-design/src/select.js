/** Enhance single native selects without changing their form values or business events. */
export function installNeonSelects(root = document) {
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  const entries = new Map();
  let serial = 0, opened = null, queued = false, destroyed = false, pendingFocus = null;
  const element = (tag, className, text) => {
    const node = doc.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = path => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 20 20', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const shape = doc.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape); return svg;
  };
  const visible = node => node.isConnected && node.getClientRects().length && !node.closest('[hidden], [inert]');
  const labelFor = select => select.getAttribute('aria-label') || (select.getAttribute('aria-labelledby') || '').split(' ').map(id => doc.getElementById(id)?.textContent || '').join(' ').trim()
    || [...(select.labels || [])].map(label => [...label.childNodes].filter(node => node !== select && !node.classList?.contains('qp-select-control')).map(node => node.textContent).join(' ').trim()).join(' ')
    || select.name || select.id || '选择选项';
  function close(restoreFocus = false) {
    if (!opened) return;
    const entry = opened; opened = null;
    entry.wrapper.classList.remove('is-open'); entry.trigger.setAttribute('aria-expanded', 'false'); entry.menu.remove();
    entry.trigger.removeAttribute('aria-activedescendant');
    if (restoreFocus && visible(entry.trigger)) entry.trigger.focus({ preventScroll: true });
  }
  function position() {
    if (!opened) return;
    const { trigger, menu, list } = opened;
    if (!visible(trigger) || trigger.disabled) { close(); return; }
    const box = trigger.getBoundingClientRect(), viewport = win.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    if (box.bottom < topEdge || box.top > topEdge + height) { close(); return; }
    const popupWidth = Math.min(Math.max(box.width, 240), width - 24);
    const below = topEdge + height - box.bottom - 12, above = box.top - topEdge - 12;
    const upward = below < 230 && above > below;
    menu.style.width = `${popupWidth}px`;
    menu.style.left = `${Math.max(leftEdge + 12, Math.min(box.left, leftEdge + width - popupWidth - 12))}px`;
    list.style.maxHeight = `${Math.max(44, Math.min(260, (upward ? above : below) - 88))}px`;
    menu.style.top = `${upward ? Math.max(topEdge + 8, box.top - menu.offsetHeight - 6) : box.bottom + 6}px`;
  }
  function highlight(entry, index) {
    const enabled = entry.items.filter(item => !item.hidden && item.getAttribute('aria-disabled') !== 'true');
    const target = enabled[index];
    for (const item of entry.items) item.classList.toggle('is-highlighted', item === target);
    entry.active = target || null;
    if (target) { entry.search.setAttribute('aria-activedescendant', target.id); target.scrollIntoView({ block: 'nearest' }); }
    else entry.search.removeAttribute('aria-activedescendant');
  }
  function filter(entry) {
    const query = entry.search.value.trim().toLocaleLowerCase(); let count = 0;
    for (const item of entry.items) {
      item.hidden = !item.dataset.search.includes(query); if (!item.hidden) count++;
    }
    for (const group of entry.list.querySelectorAll('[role="group"]')) group.hidden = ![...group.querySelectorAll('[role="option"]')].some(item => !item.hidden);
    entry.empty.hidden = count > 0;
    entry.count.textContent = query ? `${count} 个匹配选项` : `${count} 个选项`;
    const choices = entry.items.filter(item => !item.hidden && item.getAttribute('aria-disabled') !== 'true');
    const selected = query ? -1 : choices.findIndex(item => item.getAttribute('aria-selected') === 'true');
    highlight(entry, Math.max(0, selected)); position();
  }
  function choose(entry, item) {
    if (!item || item.getAttribute('aria-disabled') === 'true' || entry.select.matches(':disabled')) return;
    const index = Number(item.dataset.index), changed = entry.select.selectedIndex !== index;
    close(true); entry.select.selectedIndex = index; sync(entry);
    if (changed) {
      const focusTarget = { id: entry.select.id, label: labelFor(entry.select) };
      entry.select.dispatchEvent(new win.Event('input', { bubbles: true }));
      entry.select.dispatchEvent(new win.Event('change', { bubbles: true }));
      if (!entry.select.isConnected) pendingFocus = focusTarget;
    }
  }
  function renderOptions(entry) {
    entry.list.replaceChildren(); entry.items = []; let group = null, container = entry.list;
    [...entry.select.options].forEach((option, index) => {
      if (option.hidden || option.parentElement.hidden) return;
      const parentGroup = option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null;
      if (parentGroup !== group) {
        group = parentGroup; container = entry.list;
        if (group) {
          container = element('div', 'qp-select-group'); container.setAttribute('role', 'group'); container.setAttribute('aria-label', group.label);
          const title = element('div', 'qp-dropdown__group', group.label); title.setAttribute('aria-hidden', 'true'); container.append(title); entry.list.append(container);
        }
      }
      const item = element('div', 'qp-dropdown__option qp-select-option');
      item.id = `${entry.id}-option-${index}`; item.dataset.index = String(index); item.dataset.search = `${option.label} ${option.value} ${group?.label || ''}`.toLocaleLowerCase();
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected)); item.setAttribute('aria-disabled', String(option.disabled || Boolean(group?.disabled)));
      const check = icon('m4 10 4 4 8-8'); check.classList.add('qp-dropdown__check'); item.append(check, element('span', 'qp-select-option-label', option.label));
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('click', () => choose(entry, item));
      container.append(item); entry.items.push(item);
    });
    filter(entry);
  }
  function inheritTheme(entry) {
    // The portal leaves the field's theme/density scope; carry its resolved tokens.
    const style = win.getComputedStyle(entry.wrapper);
    for (const name of style) if (name.startsWith('--qp-')) entry.menu.style.setProperty(name, style.getPropertyValue(name));
    entry.menu.style.colorScheme = style.colorScheme;
    entry.menu.dir = style.direction;
  }
  function open(entry, query = '') {
    sync(entry);
    if (entry.trigger.disabled || !visible(entry.trigger)) return;
    close(); opened = entry;
    entry.search.value = query; entry.wrapper.classList.add('is-open'); entry.trigger.setAttribute('aria-expanded', 'true');
    // Body portal avoids overflow clipping in tables, scroll panels and drawers.
    inheritTheme(entry); doc.body.append(entry.menu); renderOptions(entry); position(); entry.search.focus({ preventScroll: true });
  }
  function sync(entry) {
    const { select, trigger, value, wrapper } = entry;
    const text = select.selectedOptions[0]?.label || select.getAttribute('data-placeholder') || '请选择';
    if (value.textContent !== text) value.textContent = text;
    const name = labelFor(select);
    for (const [key, val] of Object.entries({ 'aria-label': name, 'aria-required': String(select.required), 'aria-invalid': select.getAttribute('aria-invalid') || String(!select.validity.valid && entry.validated) })) {
      if (trigger.getAttribute(key) !== val) trigger.setAttribute(key, val);
    }
    entry.search.setAttribute('aria-label', `搜索${name}`); entry.list.setAttribute('aria-label', name);
    const disabled = select.matches(':disabled'); if (trigger.disabled !== disabled) trigger.disabled = disabled;
    const description = select.getAttribute('aria-describedby');
    if (description) trigger.setAttribute('aria-describedby', description); else trigger.removeAttribute('aria-describedby');
    if (wrapper.hidden !== select.hidden) wrapper.hidden = select.hidden;
    if (opened === entry && (disabled || select.hidden || !visible(trigger))) close();
    if (select.validity.valid) { entry.validation.hidden = true; entry.validated = false; }
  }
  function enhance(select) {
    if (entries.has(select) || select.multiple || select.size > 1 || select.hasAttribute('data-neon-native')) return;
    const id = `qp-select-${++serial}`, wrapper = element('span', 'qp-dropdown qp-select-control');
    const trigger = element('button', 'qp-dropdown__trigger qp-select-trigger'); trigger.type = 'button';
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-list`);
    const value = element('span', 'qp-dropdown__value'); const chevron = icon('m6 8 4 4 4-4'); chevron.classList.add('qp-dropdown__chevron'); trigger.append(value, chevron);
    const menu = element('div', 'qp-dropdown__menu qp-select-popup');
    const searchBox = element('div', 'qp-dropdown__search'); const search = element('input', 'qp-select-search'); search.type = 'search'; search.placeholder = '搜索选项…'; search.autocomplete = 'off'; search.spellcheck = false;
    search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-controls', `${id}-list`);
    searchBox.append(icon('m14 14 3 3 M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0'), search);
    const list = element('div', 'qp-dropdown__options'); list.id = `${id}-list`; list.setAttribute('role', 'listbox');
    const empty = element('p', 'qp-dropdown__empty', '没有匹配的选项'); empty.setAttribute('role', 'status');
    const count = element('span', 'qp-select-count'); const footer = element('div', 'qp-select-footer'); footer.append(count, element('span', '', '↑↓ 选择 · Enter 确认'));
    const validation = element('span', 'qp-select-validation'); validation.setAttribute('role', 'alert'); validation.hidden = true;
    menu.append(searchBox, list, empty, footer);
    const entry = { id, select, wrapper, trigger, value, menu, search, list, empty, count, validation, items: [], validated: false, tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden'), descriptors: {} };
    entries.set(select, entry);
    select.before(wrapper); wrapper.append(select, trigger, validation);
    select.classList.add('qp-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    // Reflect assignments from existing renderers without changing the native
    // prototype or forcing business code to dispatch synthetic change events.
    for (const key of ['value', 'selectedIndex']) {
      const native = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, key);
      entry.descriptors[key] = Object.getOwnPropertyDescriptor(select, key);
      Object.defineProperty(select, key, { configurable: true, get() { return native.get.call(this); }, set(value) { native.set.call(this, value); sync(entry); } });
    }
    entry.change = () => { sync(entry); if (opened === entry) renderOptions(entry); };
    entry.focus = () => trigger.focus();
    entry.invalid = event => { event.preventDefault(); entry.validated = true; validation.textContent = select.validationMessage; validation.hidden = false; sync(entry); trigger.focus(); };
    select.addEventListener('change', entry.change); select.addEventListener('focus', entry.focus); select.addEventListener('invalid', entry.invalid);
    trigger.addEventListener('click', () => opened === entry ? close(true) : open(entry));
    trigger.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); open(entry); if (event.key === 'ArrowUp' || event.key === 'End') highlight(entry, entry.items.filter(i => i.getAttribute('aria-disabled') !== 'true').length - 1); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') { event.preventDefault(); open(entry, event.key); }
    });
    search.addEventListener('input', () => filter(entry));
    menu.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const choices = entry.items.filter(item => !item.hidden && item.getAttribute('aria-disabled') !== 'true');
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const current = choices.indexOf(entry.active);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        highlight(entry, index);
      } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); choose(entry, entry.active); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); close(true);
        const scope = trigger.closest('[role="dialog"], dialog') || doc;
        const focusable = [...scope.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && visible(node));
        const index = focusable.indexOf(trigger), next = focusable[index + (event.shiftKey ? -1 : 1)]; (next || trigger).focus();
      }
    });
    sync(entry);
  }
  function remove(entry, restore = false) {
    if (opened === entry) close();
    const { select } = entry;
    select.removeEventListener('change', entry.change); select.removeEventListener('focus', entry.focus); select.removeEventListener('invalid', entry.invalid);
    for (const key of ['value', 'selectedIndex']) { delete select[key]; if (entry.descriptors[key]) Object.defineProperty(select, key, entry.descriptors[key]); }
    select.classList.remove('qp-select-native');
    for (const [key, val] of [['tabindex', entry.tabIndex], ['aria-hidden', entry.ariaHidden]]) { if (val === null) select.removeAttribute(key); else select.setAttribute(key, val); }
    if (restore && entry.wrapper.isConnected) { entry.wrapper.before(select); entry.wrapper.remove(); }
    entries.delete(select);
  }
  function refresh() {
    if (destroyed) return;
    queued = false;
    root.querySelectorAll('select').forEach(enhance);
    for (const entry of entries.values()) {
      if (!entry.select.isConnected || !root.contains(entry.select)) remove(entry);
      else { sync(entry); if (opened === entry) { inheritTheme(entry); renderOptions(entry); } }
    }
    if (pendingFocus) {
      const target = [...entries.values()].find(entry => visible(entry.trigger) && (pendingFocus.id ? entry.select.id === pendingFocus.id : labelFor(entry.select) === pendingFocus.label));
      if (target && doc.activeElement === doc.body) target.trigger.focus({ preventScroll: true });
      pendingFocus = null;
    }
  }
  // Reconcile before paint so a newly rendered field never flashes a native menu.
  const schedule = () => { if (!queued) { queued = true; win.queueMicrotask(() => { if (!destroyed) refresh(); }); } };
  const observer = new win.MutationObserver(records => {
    if (records.some(record => record.target.closest?.('select, option, optgroup') || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('select, .qp-select-control') || node.querySelector('select'))) || record.type === 'attributes' && ['hidden', 'class', 'disabled'].includes(record.attributeName) && record.target.querySelector?.('select'))) schedule();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'hidden', 'class', 'required', 'aria-label', 'aria-labelledby', 'aria-invalid'] });
  const outside = event => { if (opened && !opened.menu.contains(event.target) && !opened.wrapper.contains(event.target)) close(); };
  const focusOutside = event => { if (opened && !opened.menu.contains(event.target) && !opened.wrapper.contains(event.target)) close(); };
  const reset = () => win.setTimeout(() => { for (const entry of entries.values()) entry.validated = false; refresh(); }, 0);
  doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', focusOutside); doc.addEventListener('reset', reset);
  win.addEventListener('resize', position); doc.addEventListener('scroll', position, true); win.visualViewport?.addEventListener('resize', position);
  refresh();
  return { refresh, destroy() {
    destroyed = true; close(); observer.disconnect();
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', focusOutside); doc.removeEventListener('reset', reset);
    win.removeEventListener('resize', position); doc.removeEventListener('scroll', position, true); win.visualViewport?.removeEventListener('resize', position);
    for (const entry of entries.values()) remove(entry, true);
  } };
}
