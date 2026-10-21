// Promote the existing dialog to the browser top layer without moving/rebuilding
// its children: HTML packages and document readers keep their local state.
export function registerCanvasWindow(Alpine) {
  Alpine.data('canvasWindow', () => {
    const inlineScroll = new Map(), modalScroll = new Map();
    const rememberScroll = (root, positions) => {
      for (const node of root.querySelectorAll('.canvas-document-scroll, .canvas-naplet-body')) positions.set(node, { top: node.scrollTop, left: node.scrollLeft });
    };
    const restoreScroll = positions => {
      for (const [node, position] of positions) if (node.isConnected) { node.scrollTop = position.top; node.scrollLeft = position.left; }
    };
    return {
    minimised: false,
    expanded: false,
    optionsOpen: false,
    returnFocus: null,
    init() {
      this.repositionOptions = () => { if (this.optionsOpen) this.positionOptions(); };
      window.addEventListener('resize', this.repositionOptions);
    },
    destroy() {
      this.closeOptions();
      window.removeEventListener('resize', this.repositionOptions);
    },
    closeOptions() {
      if (this.$refs.options?.matches(':popover-open')) this.$refs.options.hidePopover();
    },
    toggleMinimise() {
      this.closeOptions();
      if (this.expanded) this.closeExpanded();
      else if (!this.minimised) rememberScroll(this.$root, inlineScroll);
      this.minimised = !this.minimised;
      if (!this.minimised) this.$nextTick(() => restoreScroll(inlineScroll));
    },
    toggleExpanded() {
      this.closeOptions();
      if (this.expanded) { this.closeExpanded(); return; }
      if (!this.minimised) rememberScroll(this.$root, inlineScroll);
      this.returnFocus = this.$root.querySelector('.window-popout');
      this.minimised = false;
      this.expanded = true;
      this.$root.showModal();
      this.$nextTick(() => restoreScroll(modalScroll.size ? modalScroll : inlineScroll));
    },
    closeExpanded() {
      rememberScroll(this.$root, modalScroll);
      this.$root.close();
    },
    rememberModalScroll() { rememberScroll(this.$root, modalScroll); },
    didClose() {
      this.closeOptions();
      this.expanded = false;
      this.$nextTick(() => {
        if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
        this.returnFocus = null;
        if (!this.minimised) restoreScroll(inlineScroll);
      });
    },
    positionOptions() {
      const rect = this.$refs.optionsButton.getBoundingClientRect();
      const menu = this.$refs.options;
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`;
    },
    toggleOptions() {
      if (this.$refs.options.matches(':popover-open')) { this.closeOptions(); return; }
      this.$refs.options.showPopover();
      this.positionOptions();
      this.$refs.options.querySelector('[role="menuitem"]')?.focus();
    },
    menuKeydown(event) {
      const items = [...this.$refs.options.querySelectorAll('[role="menuitem"]')].filter(item => item.getClientRects().length);
      const index = items.indexOf(document.activeElement);
      let target;
      if (event.key === 'ArrowDown') target = items[(index + 1) % items.length];
      if (event.key === 'ArrowUp') target = items[(index - 1 + items.length) % items.length];
      if (event.key === 'Home') target = items[0];
      if (event.key === 'End') target = items.at(-1);
      if (target) { event.preventDefault(); target.focus(); }
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        this.closeOptions(); this.$refs.optionsButton.focus();
      }
      event.stopPropagation();
    },
    async action(method, argument) {
      this.closeOptions();
      const store = this.$store.canvas;
      store.select('naplet', this.naplet.id);
      if (method === 'deleteItem' && this.expanded) this.$root.close();
      await store[method](argument);
    },
    comment() {
      this.closeOptions();
      this.$store.canvas.openCommentDialog({ type: 'naplet', naplet_id: this.naplet.id });
    },
    };
  });
}
