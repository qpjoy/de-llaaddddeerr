// Apply before styles paint; preference is independent of accounts and server config.
(() => {
  const key = 'mx-launcher-theme';
  const root = document.documentElement;
  let theme = 'light';
  try { theme = localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; } catch { /* Storage may be unavailable in Electron/private browsing. */ }
  function render() {
    root.classList.toggle('qp-theme-neon-void', theme === 'dark');
    root.classList.toggle('qp-theme-neon-void-light', theme === 'light');
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const label = theme === 'light' ? '切换到深色模式' : '切换到浅色模式';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }
  render();
  document.addEventListener('DOMContentLoaded', render, { once: true });
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    theme = theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(key, theme); } catch { /* Keep the in-memory choice usable. */ }
    render();
    window.dispatchEvent(new Event('mx-theme-change'));
  });
})();
