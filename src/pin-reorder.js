// Ephemeral interaction only. Membership/order authority stays in Dexie/Tower.
const gestures = new WeakMap();
export const pinKey = pin => pin.key || `${pin.type || 'thread'}:${pin.id}`;
export const legacyPinCompare = (a, b) => (b.pinnedAt || '').localeCompare(a.pinnedAt || '') || (pinKey(a) < pinKey(b) ? -1 : pinKey(a) > pinKey(b) ? 1 : 0);
export const pinReorderMixin = {
  pinMove: null,
  pinMoveAnnouncement: '',
  startPinMove(pin) {
    this.cancelPinMove();
    const keys = this.pinnedThreads.map(pinKey);
    this.pinMove = { key: pinKey(pin), title: pin.title, keys, index: keys.indexOf(pinKey(pin)), partition: this.pinnedThreadsPartition };
    this.announcePinMove();
  },
  announcePinMove() {
    if (this.pinMove) this.pinMoveAnnouncement = `${this.pinMove.title}, position ${this.pinMove.index + 1} of ${this.pinMove.keys.length}. Arrow keys move; Enter saves; Escape cancels.`;
  },
  cancelPinMove() {
    const gesture = gestures.get(this);
    if (gesture) { cancelAnimationFrame(gesture.frame); gesture.cleanup(); gestures.delete(this); }
    this.pinMove = null;
  },
  async finishPinMove() {
    const move = this.pinMove;
    this.cancelPinMove();
    if (!move || move.partition !== this.pinnedThreadsPartition) return;
    const keys = this.pinnedThreads.map(pinKey);
    if (!keys.includes(move.key)) { this.pinMoveAnnouncement = 'Move cancelled: item was unpinned.'; return; }
    // Only move this item. A concurrent new pin never gets replaced by a stale list.
    const preview = move.keys.filter(key => keys.includes(key));
    const index = preview.indexOf(move.key);
    const before = preview[index + 1] || null;
    const after = preview[index - 1] || null;
    await this.savePersonalPinMove(move.key, before, after);
  },
  pinMoveKeydown(event, pin) {
    if (event.key === 'Escape' && this.pinMove) { event.preventDefault(); event.stopPropagation(); this.cancelPinMove(); this.pinMoveAnnouncement = 'Move cancelled.'; return; }
    if (!this.pinMove || this.pinMove.key !== pinKey(pin)) {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); this.startPinMove(pin); return;
    }
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); void this.finishPinMove(); return; }
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const move = this.pinMove, keys = [...move.keys];
    const index = Math.max(0, Math.min(keys.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : move.index + (event.key === 'ArrowUp' ? -1 : 1)));
    keys.splice(move.index, 1); keys.splice(index, 0, move.key);
    this.pinMove = { ...move, keys, index }; this.announcePinMove();
  },
  pinPointerDown(event, pin) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, list = handle.closest('.deck-card-scroll');
    handle.focus({ preventScroll: true });
    this.startPinMove(pin);
    const startY = event.clientY;
    let y = startY, moved = false;
    const update = () => {
      if (!this.pinMove) return;
      const rect = list.getBoundingClientRect();
      if (moved) {
        const edge = 32;
        const speed = y < rect.top + edge ? -8 : y > rect.bottom - edge ? 8 : 0;
        if (speed) list.scrollTop += speed;
        const rows = [...list.querySelectorAll('[data-pin-key]')].filter(row => row.dataset.pinKey !== this.pinMove.key);
        let index = rows.findIndex(row => y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
        if (index < 0) index = rows.length;
        const keys = rows.map(row => row.dataset.pinKey); keys.splice(index, 0, this.pinMove.key);
        if (index !== this.pinMove.index) { this.pinMove = { ...this.pinMove, keys, index }; this.announcePinMove(); }
      }
      const gesture = gestures.get(this); if (gesture) gesture.frame = requestAnimationFrame(update);
    };
    const move = e => { if (e.pointerId !== event.pointerId) return; e.preventDefault(); e.stopPropagation(); y = e.clientY; moved ||= Math.abs(y - startY) > 5; };
    const up = e => { if (e.pointerId !== event.pointerId) return; e.preventDefault(); e.stopPropagation(); if (moved) void this.finishPinMove(); else this.cancelPinMove(); };
    const cancel = e => { if (e.pointerId === event.pointerId) this.cancelPinMove(); };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel);
    gestures.set(this, { frame: requestAnimationFrame(update), cleanup: () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    } });
  },
  pinInsertionClass(pin) {
    const move = this.pinMove;
    if (!move) return {};
    const remaining = move.keys.filter(key => key !== move.key);
    return { 'pin-moving': pinKey(pin) === move.key,
      'pin-insert-before': pinKey(pin) === remaining[move.index],
      'pin-insert-after': move.index === remaining.length && pinKey(pin) === remaining.at(-1) };
  },
};
