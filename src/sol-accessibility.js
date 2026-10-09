const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const visible = element => element.isConnected && element.getClientRects().length > 0;
const controls = element => [...element.querySelectorAll(focusable)].filter(visible);
const firstControl = element => {
  // Stop at the first safe visible control; opening an 800-reply conversation
  // must not measure every reaction/button rectangle merely to place focus.
  for (const control of element.querySelectorAll(focusable)) {
    if (!control.matches('.btn-danger, .btn-destructive') && visible(control)) return control;
  }
  return null;
};

// Reuse existing Alpine open/close handlers. This directive owns focus only;
// it never approves an action, changes a record or overrides a busy exit guard.
export function installSolAccessibility(Alpine) {
  Alpine.directive('sol-viewport', (element, _directive, { cleanup }) => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Pinch zoom must retain native panning rather than reflowing the app.
        if (viewport.scale !== 1) return;
        element.style.setProperty('--sol-visual-height', `${viewport.height}px`);
        element.style.setProperty('--sol-visual-top', `${viewport.offsetTop}px`);
      });
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();
    cleanup(() => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      element.style.removeProperty('--sol-visual-height');
      element.style.removeProperty('--sol-visual-top');
    });
  });
  const openDialogs = [];
  const focusHistory = [];
  document.addEventListener('focusin', event => {
    focusHistory.push(event.target);
    if (focusHistory.length > 12) focusHistory.shift();
  });
  Alpine.directive('sol-dialog', (element, _directive, { effect, evaluate, cleanup }) => {
    let trigger = null;
    let opened = false;
    let frame = 0;
    const owner = element.closest('[x-show], [x-if]') || element.parentElement?.closest('[x-show]');
    const expression = _directive.expression || owner?.getAttribute('x-show');
    const update = (allowed) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const isOpen = allowed && visible(element);
        if (isOpen && !opened) {
          opened = true;
          trigger = element.contains(document.activeElement)
            ? focusHistory.toReversed().find(target => visible(target) && !element.contains(target)) || null
            : document.activeElement;
          openDialogs.push(element);
          // Preserve editors and primitives that already place focus.
          if (!element.contains(document.activeElement)) {
            element.setAttribute('tabindex', '-1');
            // Focus the named dialog itself for long reading surfaces; Tab then
            // enters its controls. Avoid querying every button in large threads.
            const initial = element.querySelector('[data-sol-initial-focus], [autofocus]');
            (initial || element).focus({ preventScroll: true });
          }
        } else if (!isOpen && opened) close();
      });
    };
    const close = () => {
      opened = false;
      const index = openDialogs.indexOf(element);
      if (index >= 0) openDialogs.splice(index, 1);
      if (visible(trigger || element) && trigger && (!document.activeElement || document.activeElement === document.body || element.contains(document.activeElement))) trigger.focus({ preventScroll: true });
    };
    effect(() => { update(expression ? Boolean(evaluate(expression)) : true); });
    cleanup(() => { cancelAnimationFrame(frame); if (opened) close(); });
  });
  Alpine.directive('sol-menu', (element, directive, { effect, evaluate, cleanup }) => {
    let trigger = null;
    let wasOpen = false;
    let frame = 0;
    effect(() => {
      const opened = Boolean(evaluate(directive.expression));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (opened && !wasOpen) {
          trigger = document.activeElement;
          (firstControl(element) || element).focus({ preventScroll: true });
        } else if (!opened && wasOpen && trigger && visible(trigger) && (element.contains(document.activeElement) || document.activeElement === document.body)) trigger.focus({ preventScroll: true });
        wasOpen = opened;
      });
    });
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        evaluate(`${directive.expression} = false`);
        if (trigger && visible(trigger)) trigger.focus({ preventScroll: true });
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target.matches('input, textarea, select, [contenteditable]')) return;
      const items = controls(element);
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    element.addEventListener('keydown', keydown);
    cleanup(() => { cancelAnimationFrame(frame); element.removeEventListener('keydown', keydown); });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const dialog = openDialogs.filter(visible).at(-1);
    if (!dialog) return;
    const items = controls(dialog);
    if (!items.length) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
}
