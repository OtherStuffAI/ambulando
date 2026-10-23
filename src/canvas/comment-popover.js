// Nonmodal dialogs retain native dialog semantics without making the board inert.
export function registerCanvasCommentPopover(Alpine) {
  Alpine.directive('canvas-comment-popover', (panel, { expression }, { cleanup }) => {
    let opener = null, drag = null;
    const header = panel.querySelector('[data-popover-drag]');
    const bounds = (x, y) => {
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, x))}px`;
      panel.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, y))}px`;
    };
    const open = event => {
      if (event.detail !== expression) return;
      opener = document.activeElement;
      if (!panel.open) panel.show();
      const rect = panel.getBoundingClientRect();
      bounds(rect.left || innerWidth - rect.width - 24, rect.top || 88);
      panel.querySelector('textarea,button')?.focus();
    };
    const close = () => {
      if (expression === 'commentPanel') { Alpine.store('canvas').activeCommentId = ''; Alpine.store('canvas').linkDrag = null; }
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      drag = null;
    };
    const down = event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
    };
    const move = event => { if (drag?.id === event.pointerId) bounds(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); };
    const up = () => { drag = null; };
    const key = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (Alpine.store('canvas').linkDrag) Alpine.store('canvas').linkDrag = null;
        else panel.close();
      }
      if (event.target === header && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const rect = panel.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        bounds(rect.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), rect.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
      }
    };
    const resize = () => { if (panel.open) { const rect = panel.getBoundingClientRect(); bounds(rect.left, rect.top); } };
    const observer = new ResizeObserver(resize); observer.observe(panel);
    addEventListener('canvas-comment-open', open); addEventListener('resize', resize);
    panel.addEventListener('close', close); panel.addEventListener('keydown', key);
    header.addEventListener('pointerdown', down); header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up); header.addEventListener('pointercancel', up);
    cleanup(() => {
      observer.disconnect(); removeEventListener('canvas-comment-open', open); removeEventListener('resize', resize);
      panel.removeEventListener('close', close); panel.removeEventListener('keydown', key);
      header.removeEventListener('pointerdown', down); header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up); header.removeEventListener('pointercancel', up);
    });
  });
}
