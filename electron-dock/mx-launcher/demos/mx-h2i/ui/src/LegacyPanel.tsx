import { useLayoutEffect, useRef } from 'react';

// Existing forms keep the original delegated command handlers. Preserve the
// user's cursor and scroll when a runtime broadcast updates their markup.
export default function LegacyPanel({
  html,
  className = '',
  trimHints = false,
}: {
  html: string;
  className?: string;
  trimHints?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    if (trimHints) {
      // Keep actual fields, values, logs and command handlers. Explanatory copy
      // from the previous interface is outside the approved prototype.
      template.content.querySelectorAll([
        '.kicker', '.panel-head p', '[class$="-hint"]', '[class$="-note"]',
        '.diagnostic-log-privacy', '.field > small', '.h2o-clash-link small',
        '.h2o-manager-hero > div > span', '.h2o-action-band > div > span',
        '.h2o-subscription-reason', '.update-mini-empty',
      ].join(',')).forEach((element) => element.remove());
      template.content.querySelectorAll('[title]').forEach((element) => element.removeAttribute('title'));
    }
    const markup = template.innerHTML;
    if (host.innerHTML === markup) return;
    const active = document.activeElement;
    const fields = Array.from(host.querySelectorAll<HTMLElement>('input,select,textarea,button,a'));
    const focused = active instanceof HTMLElement && host.contains(active) ? active : null;
    const focusIndex = focused ? fields.indexOf(focused) : -1;
    const key =
      focused?.id || focused?.getAttribute('name') || focused?.getAttribute('data-action');
    const selection =
      focused instanceof HTMLInputElement &&
      ['text', 'password', 'search', 'url', 'tel'].includes(focused.type)
        ? ([focused.selectionStart, focused.selectionEnd] as const)
        : null;
    const scroll = [host.scrollLeft, host.scrollTop];
    host.innerHTML = markup;
    if (focused) {
      const nextFields = Array.from(
        host.querySelectorAll<HTMLElement>('input,select,textarea,button,a'),
      );
      const next = key
        ? nextFields.find(
            (el) =>
              el.id === key ||
              el.getAttribute('name') === key ||
              el.getAttribute('data-action') === key,
          )
        : nextFields[focusIndex];
      next?.focus({ preventScroll: true });
      if (next instanceof HTMLInputElement && selection) next.setSelectionRange(...selection);
    }
    host.scrollTo(...(scroll as [number, number]));
  }, [html, trimHints]);
  return <div className={`mincave-legacy ${className}`} ref={ref} />;
}
