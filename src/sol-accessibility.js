const focusable =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const visible = (element) => element.isConnected && element.getClientRects().length > 0;
const controls = (element) => [...element.querySelectorAll(focusable)].filter(visible);
const firstControl = (element) => {
  // Stop at the first safe visible control; opening an 800-reply conversation
  // must not measure every reaction/button rectangle merely to place focus.
  for (const control of element.querySelectorAll(focusable)) {
    if (!control.matches('.btn-danger, .btn-destructive') && visible(control)) return control;
  }
  return null;
};

const ANCHORED_MENU_MARGIN = 8;
const ANCHORED_MENU_GAP = 5;
const clamp = (value, minimum, maximum) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

export function anchoredMenuPosition(triggerRect, menuRect, viewport = {}) {
  const viewportLeft = Number(viewport.offsetLeft) || 0;
  const viewportTop = Number(viewport.offsetTop) || 0;
  const viewportWidth = Number(viewport.width) || Number(globalThis.window?.innerWidth) || 0;
  const viewportHeight = Number(viewport.height) || Number(globalThis.window?.innerHeight) || 0;
  const leftEdge = viewportLeft + ANCHORED_MENU_MARGIN;
  const topEdge = viewportTop + ANCHORED_MENU_MARGIN;
  const rightEdge = viewportLeft + viewportWidth - ANCHORED_MENU_MARGIN;
  const bottomEdge = viewportTop + viewportHeight - ANCHORED_MENU_MARGIN;
  const menuWidth = Math.min(Number(menuRect?.width) || 0, Math.max(0, rightEdge - leftEdge));
  const menuHeight = Math.min(Number(menuRect?.height) || 0, Math.max(0, bottomEdge - topEdge));
  const below = Number(triggerRect?.bottom) + ANCHORED_MENU_GAP;
  const above = Number(triggerRect?.top) - ANCHORED_MENU_GAP - menuHeight;
  const fitsBelow = below + menuHeight <= bottomEdge;
  const fitsAbove = above >= topEdge;
  const spaceBelow = bottomEdge - Number(triggerRect?.bottom) - ANCHORED_MENU_GAP;
  const spaceAbove = Number(triggerRect?.top) - topEdge - ANCHORED_MENU_GAP;
  const placement = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove) ? 'bottom' : 'top';
  const desiredTop = placement === 'bottom' ? below : above;

  return {
    left: clamp(Number(triggerRect?.right) - menuWidth, leftEdge, rightEdge - menuWidth),
    maxHeight: Math.max(0, bottomEdge - topEdge),
    placement,
    top: clamp(desiredTop, topEdge, bottomEdge - menuHeight),
  };
}

// Reuse existing Alpine open/close handlers. This directive owns focus only;
// it never approves an action, changes a record or overrides a busy exit guard.
export function installSolAccessibility(Alpine) {
  Alpine.directive('sol-composer-focus', (element, _directive, { cleanup }) => {
    const activate = (event) => {
      // Leave selection, attachments, menus and send/cancel actions to their
      // own controls. Only the unused composer surface forwards focus.
      if (event.target.closest('button, a, input, label, select, textarea, [contenteditable], [role="menu"]')) return;
      const editor = element.querySelector('[data-chat-composer="thread"][contenteditable="true"]');
      editor?.focus({ preventScroll: true });
    };
    element.addEventListener('click', activate);
    cleanup(() => element.removeEventListener('click', activate));
  });
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
  Alpine.directive('sol-composer-scroll', (element, _directive, { cleanup }) => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Only the footer scrolls. Keep history anchors, selection and native
        // zoom/panning intact when context chips or editing state appear.
        if (window.innerWidth > 768 || (window.visualViewport && window.visualViewport.scale !== 1))
          return;
        const editor = element.querySelector('[data-chat-composer="thread"]');
        if (!editor?.contains(document.activeElement)) return;
        const viewport = element.getBoundingClientRect();
        const draft = editor.getBoundingClientRect();
        const actions = element.querySelector('.thread-input-actions')?.getBoundingClientRect();
        const bottom = Math.max(draft.bottom, actions?.bottom || draft.bottom);
        const top = Math.min(draft.top, actions?.top ?? draft.top);
        if (bottom > viewport.bottom) element.scrollTop += bottom - viewport.bottom;
        else if (top < viewport.top) element.scrollTop += top - viewport.top;
      });
    };
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    element.addEventListener('focusin', update);
    element.addEventListener('input', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    const bar = element.querySelector('.thread-input-bar');
    if (bar) observer?.observe(bar);
    cleanup(() => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      element.removeEventListener('focusin', update);
      element.removeEventListener('input', update);
    });
  });
  const openDialogs = [];
  const focusHistory = [];
  document.addEventListener('focusin', (event) => {
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
            ? focusHistory
                .toReversed()
                .find((target) => visible(target) && !element.contains(target)) || null
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
      if (
        visible(trigger || element) &&
        trigger &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          element.contains(document.activeElement))
      )
        trigger.focus({ preventScroll: true });
    };
    effect(() => {
      update(expression ? Boolean(evaluate(expression)) : true);
    });
    cleanup(() => {
      cancelAnimationFrame(frame);
      if (opened) close();
    });
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
        } else if (
          !opened &&
          wasOpen &&
          trigger &&
          visible(trigger) &&
          (element.contains(document.activeElement) || document.activeElement === document.body)
        )
          trigger.focus({ preventScroll: true });
        wasOpen = opened;
      });
    });
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        evaluate(`${directive.expression} = false`);
        if (trigger && visible(trigger)) trigger.focus({ preventScroll: true });
        return;
      }
      if (
        !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
        event.target.matches('input, textarea, select, [contenteditable]')
      )
        return;
      const items = controls(element);
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    const focusPositionedMenu = () => {
      if (!wasOpen || element.contains(document.activeElement)) return;
      (firstControl(element) || element).focus({ preventScroll: true });
    };
    element.addEventListener('keydown', keydown);
    element.addEventListener('sol-menu-positioned', focusPositionedMenu);
    cleanup(() => {
      cancelAnimationFrame(frame);
      element.removeEventListener('keydown', keydown);
      element.removeEventListener('sol-menu-positioned', focusPositionedMenu);
    });
  });
  Alpine.directive('sol-anchor-menu', (element, directive, { effect, evaluate, cleanup }) => {
    const MAX_LAYOUT_ATTEMPTS = 12;
    let frame = 0;
    let layoutAttempts = 0;
    let opened = false;
    let positioned = false;
    const trigger = element.parentElement?.querySelector('[aria-haspopup="menu"]');
    const resetPosition = () => {
      positioned = false;
      element.dataset.positioned = 'false';
    };
    const position = (resetAttempts = false) => {
      if (!opened) return;
      if (resetAttempts) layoutAttempts = 0;
      cancelAnimationFrame(frame);
      const attempt = () => {
        if (!opened || !visible(trigger)) return;
        const menuRect = element.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        // x-show and responsive CSS can expose the menu after this directive's
        // reactive effect. Retry for a bounded number of painted frames while
        // data-positioned keeps the interim box from flashing or taking input.
        if (
          !element.getClientRects().length ||
          menuRect.width <= 0 ||
          menuRect.height <= 0 ||
          triggerRect.width <= 0 ||
          triggerRect.height <= 0
        ) {
          layoutAttempts += 1;
          if (layoutAttempts < MAX_LAYOUT_ATTEMPTS) frame = requestAnimationFrame(attempt);
          return;
        }
        const visualViewport = window.visualViewport;
        const viewport = visualViewport
          ? {
              width: visualViewport.width,
              height: visualViewport.height,
              offsetLeft: visualViewport.offsetLeft,
              offsetTop: visualViewport.offsetTop,
            }
          : { width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 };
        const clipRect = trigger.closest('.deck-card-scroll')?.getBoundingClientRect();
        const viewportRight = viewport.offsetLeft + viewport.width;
        const viewportBottom = viewport.offsetTop + viewport.height;
        const outsideViewport =
          triggerRect.bottom <= viewport.offsetTop ||
          triggerRect.top >= viewportBottom ||
          triggerRect.right <= viewport.offsetLeft ||
          triggerRect.left >= viewportRight;
        const outsideClip =
          clipRect &&
          (triggerRect.bottom <= clipRect.top ||
            triggerRect.top >= clipRect.bottom ||
            triggerRect.right <= clipRect.left ||
            triggerRect.left >= clipRect.right);
        if (outsideViewport || outsideClip) {
          resetPosition();
          evaluate(`${directive.expression} = false`);
          return;
        }
        const result = anchoredMenuPosition(triggerRect, menuRect, viewport);
        element.style.left = `${result.left}px`;
        element.style.top = `${result.top}px`;
        element.style.maxHeight = `${result.maxHeight}px`;
        element.dataset.placement = result.placement;
        element.dataset.positioned = 'true';
        if (!positioned) {
          positioned = true;
          element.dispatchEvent(new CustomEvent('sol-menu-positioned'));
        }
      };
      frame = requestAnimationFrame(attempt);
    };
    resetPosition();
    effect(() => {
      opened = Boolean(evaluate(directive.expression));
      if (opened) {
        resetPosition();
        Alpine.nextTick(() => {
          if (opened) position(true);
        });
      } else {
        cancelAnimationFrame(frame);
        layoutAttempts = 0;
        resetPosition();
      }
    });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    cleanup(() => {
      opened = false;
      cancelAnimationFrame(frame);
      layoutAttempts = 0;
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const dialog = openDialogs.filter(visible).at(-1);
    if (!dialog) return;
    const items = controls(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0],
      last = items.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
}
