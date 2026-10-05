import { createContextTreeEditor } from './context-tree-editor.js';
import { isContextAccessDenied } from './context-tree-errors.js';
import { observeContextScope } from './context-cache.js';
import { getWorkspaceDb, isWorkspaceDbOpenForKey } from './db.js';
import { layoutContextTree, contextPath, contextSearchChoices, fitContextTree } from './context-tree-layout.js';
import { normalizeRecordLinkType } from './record-links.js';

const views = new WeakMap();
const viewPreferenceKey = 'flightdeck.context-tree.view';
export function disposeContextTreeView(store) { views.get(store)?.suspend(); }
export function resumeContextTreeView(store) { views.get(store)?.resume(); }

export { contextArtifactOrigin } from './context-artifact-link.js';
import { contextArtifactOrigin, contextArtifactLatestUrl } from './context-artifact-link.js';

export function createContextTreeView(deps = {}) {
  let subscription, resizeObserver, rowObserver, generation = 0, request = 0, queued = 0, key = '', db, service, store;
  let refSignature = '', hadAvailable = false, fitted = false, drag = null, destroyed = false, pendingRevealId = '';
  const observe = deps.observe || observeContextScope;
  const database = deps.getDb || getWorkspaceDb;
  const ready = deps.isDbReady || isWorkspaceDbOpenForKey;
  const rowHeights = new Map();
  let outlineRevealTicket = 0, outlineScrollPending = false;
  const preference = () => { try { return (deps.storage || globalThis.localStorage)?.getItem(viewPreferenceKey) === 'visual' ? 'visual' : 'outline'; } catch { return 'outline'; } };
  const view = {
    viewMode: preference(), outlineScroll: 0, outlineRows: [], outlineHeight: 0,
    hasContext: false, status: 'unloaded', components: [], references: [], selectedId: '', focusedId: '', collapsed: [],
    layout: layoutContextTree([]), scale: 1, panX: 0, panY: 0, viewportWidth: 800, viewportHeight: 500,
    nodeSearch: '', nodeSearchOpen: false, nodeSearchIndex: 0,
    get nodeResults() { return contextSearchChoices(this.components,this.nodeSearch).map(row=>({...row,subtitle:row.path})); },
    chooseNode(row) { if(!this.nodeResults.some(r=>r.id===row.id))return; this.collapsed=this.collapsed.filter(id=>!contextPath(this.components,row.id).some(p=>p.id===id)); this.relayout(); this.select(row.id); this.scale=Math.min(1,(this.viewportWidth-32)/240); this.reveal(row.id); this.nodeSearch=''; this.nodeSearchOpen=false; this.focusNode(row.id); },
    nodeSearchKey(event) { if(event.key==='Escape'){event.preventDefault();this.nodeSearchOpen=false;} else if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();this.nodeSearchOpen=true;this.nodeSearchIndex=Math.max(0,Math.min(this.nodeResults.length-1,this.nodeSearchIndex+(event.key==='ArrowDown'?1:-1)));} else if(event.key==='Enter'){event.preventDefault();if(this.nodeResults[this.nodeSearchIndex])this.chooseNode(this.nodeResults[this.nodeSearchIndex]);} this.$nextTick?.(()=>this.$refs?.nodeResults?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'})); },
    refsLoading: false, refsError: '', notice: '', scopeTitle: '', workspaceId: '', scopeId: '',
    init() {
      store = deps.store || this.$store.chat;
      views.set(store, this);
      if (typeof ResizeObserver !== 'undefined' && this.$refs?.canvas) {
        resizeObserver = new ResizeObserver(entries => {
          const rect = entries[0].contentRect;
          if (this.viewportWidth !== rect.width) { rowHeights.clear(); this.rebuildOutline(); }
          this.viewportWidth = rect.width; this.viewportHeight = rect.height;
          if (!fitted && this.layout.nodes.length) this.initialView();
        });
        resizeObserver.observe(this.$refs.canvas);
      }
    },
    setView(mode) {
      if (!['outline', 'visual'].includes(mode) || mode === this.viewMode) return;
      this.viewMode = mode;
      if (mode === 'visual') rowObserver?.disconnect();
      this.$nextTick?.(() => { if (this.viewMode === mode && this.$refs?.canvas) this.$refs.canvas.scrollTop = mode === 'outline' ? this.outlineScroll : 0; });
      try { (deps.storage || globalThis.localStorage)?.setItem(viewPreferenceKey, mode); } catch { /* Storage may be unavailable. */ }
      if (mode === 'visual' && !fitted) this.initialView();
      this.reveal(this.focusedId || this.selectedId);
      this.observeOutlineRows();
    },
    initialView() {
      // Open at readable size at the first root; a broad tree can be panned.
      if (this.viewMode !== 'visual') return;
      this.scale = Math.min(1, Math.max(0.85, (this.viewportWidth - 48) / 240));
      this.panX = 0; this.panY = 0; fitted = true;
      this.reveal(this.focusedId || this.layout.nodes[0]?.id);
    },
    rebuildOutline() {
      let top = 0;
      this.outlineRows = this.layout.nodes.map(node => {
        const height = rowHeights.get(node.id) || 48;
        const row = { ...node, outlineTop: top, outlineHeight: height };
        top += height; return row;
      });
      this.outlineHeight = top;
    },
    get outlineWindow() {
      const start = Math.max(0, this.outlineScroll - 240), end = this.outlineScroll + this.viewportHeight + 240;
      return this.outlineRows.filter(row => row.outlineTop + row.outlineHeight >= start && row.outlineTop <= end);
    },
    get outlineBefore() { return this.outlineWindow[0]?.outlineTop || 0; },
    get outlineAfter() { const last = this.outlineWindow.at(-1); return last ? Math.max(0, this.outlineHeight - last.outlineTop - last.outlineHeight) : 0; },
    observeOutlineRows() {
      this.$nextTick?.(() => {
        if (destroyed || this.viewMode !== 'outline' || typeof ResizeObserver === 'undefined') return;
        rowObserver ||= new ResizeObserver(entries => {
          if (this.viewMode !== 'outline' || destroyed) return;
          let changed = false;
          for (const entry of entries) {
            const id = entry.target.dataset.contextRow;
            const height = entry.target.getBoundingClientRect().height;
            if (height > 0 && Math.abs((rowHeights.get(id) || 48) - height) > 0.5) { rowHeights.set(id, height); changed = true; }
          }
          if (changed) { this.rebuildOutline(); this.observeOutlineRows(); }
        });
        rowObserver.disconnect();
        for (const row of this.$refs?.canvas?.querySelectorAll('[data-context-row]') || []) rowObserver.observe(row);
      });
    },
    scrolled(event) { if (this.viewMode === 'outline' && !outlineScrollPending) { this.outlineScroll = event.currentTarget.scrollTop; this.observeOutlineRows(); } },
    get referenceCounts() { const counts = Object.create(null); for (const row of this.references) counts[row.component_id] = (counts[row.component_id] || 0) + 1; return counts; },
    nodeStyle(node) {
      if (this.viewMode === 'visual') return { left: node.x + 'px', top: node.y + 'px', width: node.width + 'px', height: node.height + 'px' };
      // Cap physical indentation so even very deep branches retain a readable label.
      return { '--context-indent': Math.min(node.depth * 18, Math.max(36, this.viewportWidth * 0.22)) + 'px' };
    },
    // x-effect reads only shell identity; liveQuery and UI state never cause reload loops.
    queueSync(workspaceId, scopeId, dbKey, title, enabled) {
      const ticket = ++queued;
      queueMicrotask(() => { if (ticket === queued && !destroyed) this.sync(workspaceId, scopeId, dbKey, title, enabled); });
    },
    sync(workspaceId, scopeId, dbKey, title = '', enabled = true) {
      const nextKey = enabled && workspaceId && scopeId && ready(dbKey) ? `${dbKey}|${workspaceId}|${scopeId}` : '';
      this.scopeTitle = title;
      if (nextKey === key) return;
      this.reset(); key = nextKey; this.hasContext = !!nextKey;
      this.workspaceId = workspaceId; this.scopeId = scopeId;
      if (!key) return;
      db = database(); service = store.getTowerSyncService?.();
      const epoch = generation;
      const active = () => epoch === generation && key === nextKey && database() === db && !service?.disposed;
      subscription = observe(db, workspaceId, scopeId).subscribe({
        next: snapshot => {
          if (!active()) return;
          this.status = snapshot.status;
          this.capabilities = snapshot.capabilities || {read:false,manage:false};
          if (!this.canManage) this.clearEditor();
          this.components = ['complete', 'loading'].includes(snapshot.status) ? snapshot.components : [];
          this.references = snapshot.status === 'complete' ? snapshot.references : [];
          if (this.selectedId && !this.components.some(row => row.id === this.selectedId)) {
            this.clearEditor(); this.selectedId = ''; this.refsLoading = false; this.refsError = ''; request++;
            this.notice = 'The selected component is no longer available.';
          }
          const ids = new Set(this.components.map(row => row.id));
          this.collapsed = this.collapsed.filter(id => ids.has(id));
          this.relayout();
          if (pendingRevealId && this.components.some(row => row.id === pendingRevealId)) this.revealCreated(pendingRevealId);
          if (!fitted && this.layout.nodes.length) this.initialView();
          const refs = this.directReferences;
          const signature = refs.map(row => `${row.id}:${row.row_version}`).sort().join('|');
          const available = refs.some(row => row.resolution?.status === 'available');
          if (this.selectedId && snapshot.status === 'complete' && !this.refsLoading && (signature !== refSignature || (hadAvailable && !available))) {
            refSignature = signature; hadAvailable = false;
            void this.loadReferences();
          }
          if (!this.refsLoading) hadAvailable = available;
        },
        error: () => { if (active()) { this.status = 'error'; this.components = []; this.references = []; this.selectedId = ''; this.relayout(); } },
      });
      void this.loadTree();
    },
    reset() {
      this.nodeSearch=''; this.nodeSearchOpen=false; this.clearEditor(); this.capabilities = {read:false,manage:false};
      generation++; request++; rowObserver?.disconnect(); subscription?.unsubscribe(); subscription = null;
      this.hasContext = false; this.status = 'unloaded'; this.components = []; this.references = []; this.selectedId = ''; this.focusedId = '';
      this.collapsed = []; this.refsLoading = false; this.refsError = ''; this.notice = '';
      outlineRevealTicket++; outlineScrollPending = false;
      rowHeights.clear(); this.outlineRows = []; this.outlineHeight = 0; this.outlineScroll = 0;
      if (this.$refs?.canvas) this.$refs.canvas.scrollTop = 0;
      this.layout = layoutContextTree([]); this.scale = 1; this.panX = 0; this.panY = 0;
      refSignature = ''; hadAvailable = false; fitted = false; drag = null; pendingRevealId = '';
    },
    resume() {
      this.queueSync(store.currentWorkspace?.workspaceId || store.currentWorkspace?.workspace_id,
        store.pgContextScope?.record_id || store.selectedBoardScope?.record_id, store.workspaceDbKey,
        store.pgContextScope?.title || store.selectedBoardScope?.title || '', store.isLoggedIn && store.isTowerPgMode);
    },
    suspend() { queued++; this.reset(); key = ''; },
    destroy() { destroyed = true; this.suspend(); resizeObserver?.disconnect(); rowObserver?.disconnect(); views.delete(store); },
    async loadTree() {
      const epoch = generation;
      this.status = 'loading';
      try {
        if (!service || service.disposed) throw new Error('Context service unavailable');
        await service.ensureLoaded('context-tree', this.scopeId, { force: true });
      } catch (error) {
        if (epoch !== generation) return;
        this.status = isContextAccessDenied(error) ? 'denied' : 'error';
        this.components = []; this.references = []; this.selectedId = ''; this.relayout();
      }
    },
    get selected() { return this.components.find(row => row.id === this.selectedId) || null; },
    get path() { return contextPath(this.components, this.selectedId); },
    get directReferences() { return this.references.filter(row => row.component_id === this.selectedId).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)); },
    get stateMessage() {
      if (!this.hasContext) return 'Choose a scope to browse its context.';
      return { unloaded: 'Context has not loaded yet.', loading: 'Loading context…', denied: 'This context is unavailable for your access.', error: 'Context could not be loaded. Try again.' }[this.status]
        || (this.components.length ? '' : 'No components in this scope yet.');
    },
    get transform() { return `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`; },
    get visibleNodes() {
      if (this.viewMode === 'outline') return this.outlineWindow;
      // Bound DOM work when zooming into large forests; the pure layout retains all nodes.
      const left = -this.panX / this.scale - 240, top = -this.panY / this.scale - 100;
      const right = left + this.viewportWidth / this.scale + 480, bottom = top + this.viewportHeight / this.scale + 200;
      return this.layout.nodes.filter(n => n.x + n.width >= left && n.x <= right && n.y + n.height >= top && n.y <= bottom);
    },
    get visibleEdges() { const ids = new Set(this.visibleNodes.map(node => node.id)); return this.layout.edges.filter(edge => ids.has(edge.id) || ids.has(edge.parentId)); },
    // Only pure-layout numeric paths enter this SVG markup; no record text/URL.
    get edgeMarkup() { return this.visibleEdges.map(edge => `<path d="${edge.path}"></path>`).join(''); },
    relayout() {
      this.layout = layoutContextTree(this.components, this.collapsed);
      this.rebuildOutline(); this.observeOutlineRows();
      if (!this.layout.nodes.some(node => node.id === this.focusedId)) this.focusedId = this.layout.nodes[0]?.id || '';
    },
    revealCreated(id) {
      pendingRevealId = id;
      const row = this.components.find(row => row.id === id);
      if (!row || this.busy || this.status !== 'complete') return;
      const ancestors = contextPath(this.components, id).map(row => row.id);
      this.collapsed = this.collapsed.filter(id => !ancestors.includes(id));
      this.relayout(); pendingRevealId = ''; this.select(id); this.reveal(id);
    },
    select(id) {
      if (this.status !== 'complete' || !this.components.some(row => row.id === id)) return;
      if (this.busy) return;
      this.clearEditor();
      this.selectedId = id; this.focusedId = id; this.notice = ''; refSignature = ''; hadAvailable = false;
      void this.loadReferences();
    },
    async loadReferences() {
      const epoch = generation, ticket = ++request, id = this.selectedId;
      if (!id || this.status !== 'complete') return;
      this.refsLoading = true; this.refsError = ''; hadAvailable = false;
      try { await service.ensureLoaded('context-references', id, { scopeId: this.scopeId, force: true }); }
      catch { if (epoch === generation && ticket === request) this.refsError = 'References could not be checked. Try again.'; }
      finally {
        if (epoch === generation && ticket === request) {
          this.refsLoading = false;
          refSignature = this.directReferences.map(row => `${row.id}:${row.row_version}`).sort().join('|');
          // Wait for liveQuery to observe the committed resolution, not the old view.
          hadAvailable = false;
        }
      }
    },
    toggle(id) {
      this.collapsed = this.collapsed.includes(id) ? this.collapsed.filter(value => value !== id) : [...this.collapsed, id];
      this.relayout(); this.focusNode(id);
    },
    fit() {
      const view = fitContextTree(this.layout, this.viewportWidth, this.viewportHeight);
      this.scale = view.scale; this.panX = view.x; this.panY = view.y; fitted = true;
    },
    zoom(factor, x = this.viewportWidth / 2, y = this.viewportHeight / 2) {
      const scale = Math.max(0.001, Math.min(2.5, this.scale * factor)), ratio = scale / this.scale;
      this.panX = x - (x - this.panX) * ratio; this.panY = y - (y - this.panY) * ratio; this.scale = scale;
    },
    wheel(event) {
      if (this.viewMode !== 'visual') return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = event.currentTarget.getBoundingClientRect(); this.zoom(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
      } else { this.panX -= event.deltaX; this.panY -= event.deltaY; }
    },
    pointerDown(event) {
      if (this.viewMode !== 'visual') return;
      if (event.target.closest('button') || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    pointerMove(event) { if (drag?.id === event.pointerId) { this.panX = drag.panX + event.clientX - drag.x; this.panY = drag.panY + event.clientY - drag.y; } },
    pointerUp() { drag = null; },
    reveal(id) {
      if (this.viewMode === 'outline') {
        const row = this.outlineRows.find(row => row.id === id), canvas = this.$refs?.canvas;
        if (!row) return;
        const ticket = ++outlineRevealTicket; outlineScrollPending = !!canvas;
        if (row.outlineTop < this.outlineScroll || row.outlineTop + row.outlineHeight > this.outlineScroll + this.viewportHeight) {
          this.outlineScroll = Math.max(0, row.outlineTop - this.viewportHeight / 3);
        }
        this.observeOutlineRows();
        this.$nextTick?.(() => {
          if (ticket !== outlineRevealTicket || this.viewMode !== 'outline' || !canvas) { if (ticket === outlineRevealTicket) outlineScrollPending = false; return; }
          // Apply scrolling after Alpine has replaced Visual geometry/spacers.
          // Otherwise native scroll clamps to the old DOM and resets the window.
          canvas.scrollTop = this.outlineScroll;
          Array.from(canvas.querySelectorAll('[data-context-node]')).find(el => el.dataset.contextNode === id)?.scrollIntoView({ block: 'nearest' });
          const settle = () => { if (ticket === outlineRevealTicket) { outlineScrollPending = false; this.outlineScroll = canvas.scrollTop; } };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle); else settle();
        });
        return;
      }
      const node = this.layout.nodes.find(row => row.id === id); if (!node) return;
      // Keep keyboard targets readable even after fitting a very deep/wide scope.
      if (this.scale < 0.5) this.scale = 1;
      const x = node.x * this.scale + this.panX, y = node.y * this.scale + this.panY;
      if (x < 0 || x + node.width * this.scale > this.viewportWidth || y < 0 || y + node.height * this.scale > this.viewportHeight) {
        this.panX = (this.viewportWidth - node.width * this.scale) / 2 - node.x * this.scale;
        this.panY = (this.viewportHeight - node.height * this.scale) / 2 - node.y * this.scale;
      }
    },
    focusNode(id) {
      this.focusedId = id; this.reveal(id);
      this.$nextTick?.(() => Array.from(this.$refs?.canvas?.querySelectorAll('[data-context-node]') || []).find(el => el.dataset.contextNode === id)?.focus({ preventScroll: true }));
    },
    keydown(event, id) {
      const nodes = this.layout.nodes, index = nodes.findIndex(node => node.id === id), node = nodes[index];
      if (!node) return;
      let next;
      switch (event.key) {
        case 'ArrowDown': next = nodes[Math.min(nodes.length - 1, index + 1)]?.id; break;
        case 'ArrowUp': next = nodes[Math.max(0, index - 1)]?.id; break;
        case 'Home': next = nodes[0]?.id; break;
        case 'End': next = nodes.at(-1)?.id; break;
        case 'ArrowRight': if (node.childCount && !node.expanded) this.toggle(id); else next = nodes.find(row => row.parentId === id)?.id; break;
        case 'ArrowLeft': if (node.childCount && node.expanded) this.toggle(id); else next = node.parentId; break;
        case 'Enter': case ' ': this.select(id); break;
        default: return;
      }
      event.preventDefault(); if (next) this.focusNode(next);
    },
    referenceTitle(row) {
      if (this.refsLoading) return 'Checking reference…';
      if (this.refsError) return 'Reference unavailable';
      if (row.target_type === 'artifact') return contextArtifactOrigin(row.target) ? `Open latest artifact: ${row.target.project} / ${row.target.artifact} (latest)` : 'Reference unavailable';
      return row.resolution?.status === 'available' ? row.resolution.title || 'Untitled record' : 'Reference unavailable';
    },
    canOpen(row) { return !this.refsLoading && !this.refsError && (row.target_type === 'artifact' ? !!contextArtifactOrigin(row.target) : row.resolution?.status === 'available'); },
    async openReference(row) {
      if (!this.canOpen(row)) return;
      if (row.target_type === 'artifact') { (deps.openExternal || (url => window.open(url, '_blank', 'noopener,noreferrer')))(contextArtifactLatestUrl(row.target)); return; }
      const epoch = generation, id = row.target?.record_id;
      try {
        // Recheck context resolution, then reuse ordinary target routes/viewers (their ACL remains authoritative).
        await this.loadReferences();
        if (epoch !== generation || this.refsError || this.selectedId !== row.component_id) return;
        // liveQuery notification can trail the loader's transaction. Read the
        // committed resolution, never a stale rendered snapshot, for opening.
        const checked = await db.transaction('r', db.context_references, db.context_reference_resolutions, async () => {
          const current = await db.context_references.get(row.id);
          const resolved = await db.context_reference_resolutions.get(row.id);
          return current?.workspace_id === this.workspaceId && current.scope_id === this.scopeId
            && current.component_id === this.selectedId && current.row_version === resolved?.row_version
            && resolved?.resolution?.status === 'available';
        });
        if (epoch !== generation || !checked) return;
        const type = normalizeRecordLinkType(row.target_type);
        if (type === 'file') {
          await service.ensureLoaded('documents', '', { force: true });
          if (epoch !== generation) return;
          const file = await db.documents.get(id);
          if (!file || file.pg_record_type !== 'file' || file.record_state !== 'active') throw new Error('Unavailable');
          store.navigateTo('files');
          await store.downloadFileBrowserRow({ object_id: file.pg_storage_object_id, name: file.title, kind: 'file' });
        } else store.handleMentionNavigate(type, id);
      } catch { if (epoch === generation) this.refsError = 'Reference unavailable. Access may have changed.'; }
    },
  };
  Object.defineProperties(view, Object.getOwnPropertyDescriptors(createContextTreeEditor({getService: () => service, getDb: () => db, getStore: () => store, online: deps.online, observe: deps.observePicker})));
  return view;
}
