function providerError(code, message) { return Object.assign(new Error(message), { code }); }

export class DeterministicNStackProviderFixture {
  constructor({ origin = 'https://ambulando.example', stacks = [], workspaces = {}, discovery = 'approve' } = {}) {
    this.version = 1;
    this.origin = origin;
    this.stacks = stacks;
    this.workspaces = workspaces;
    this.discovery = discovery;
    this.calls = [];
    this.listeners = new Set();
    this.sequence = 0;
    this.disclosed = false;
    this.handles = new Set();
  }

  async isAvailable() {
    this.calls.push(['isAvailable']);
    return { available: true, version: 1 };
  }

  async requestDiscovery(options = {}) {
    this.calls.push(['requestDiscovery', options]);
    if (this.discovery !== 'approve') throw providerError('consent_denied', 'NStack discovery was denied.');
    this.disclosed = true;
    return { disclosed: this.stacks.length, workspaces: options.workspaces === true };
  }

  requireDisclosure() {
    if (!this.disclosed) throw providerError('not_disclosed', 'Request NStack discovery first.');
  }

  async listNStacks() {
    this.calls.push(['listNStacks']);
    this.requireDisclosure();
    return this.stacks.map(stack => ({
      id: `${this.origin}:stack:${stack.id}`,
      name: stack.name,
      url: stack.url,
      host: stack.host === true,
      available: true,
      stale: false,
      lastRefreshedAt: '2026-10-19T00:00:00.000Z',
      ...(stack.extra || {}),
    }));
  }

  async listWorkspaces({ stackId }) {
    this.calls.push(['listWorkspaces', { stackId }]);
    this.requireDisclosure();
    const rawId = stackId.split(':stack:')[1];
    if (!rawId) throw providerError('not_disclosed', 'The NStack was not disclosed.');
    const stack = this.stacks.find(candidate => candidate.id === rawId);
    return (this.workspaces[rawId] || []).map(workspace => ({
      id: `${this.origin}:workspace:${workspace.id}`,
      name: workspace.name,
      workspaceId: workspace.workspaceId || workspace.id,
      workspaceOwnerNpub: workspace.workspaceOwnerNpub || `npub1${'q'.repeat(58)}`,
      workspaceServiceNpub: workspace.workspaceServiceNpub || `npub1${'p'.repeat(58)}`,
      directHttpsUrl: workspace.directHttpsUrl || stack?.url || 'https://stack.example',
      serviceNpub: workspace.serviceNpub || stack?.serviceNpub || `npub1${'z'.repeat(58)}`,
      ...(workspace.fipsEndpoint ? { fipsEndpoint: workspace.fipsEndpoint, peerNpub: workspace.peerNpub } : {}),
      nstack: {
        id: stackId,
        name: stack?.name || 'NStack',
        url: stack?.url || 'https://stack.example',
      },
    }));
  }

  async getConnection({ stackId, workspaceId }) {
    this.calls.push(['getConnection', { stackId, workspaceId }]);
    const workspaces = await this.listWorkspaces({ stackId });
    const selected = workspaces.find(workspace => workspace.id === workspaceId);
    if (!selected) throw providerError('not_disclosed', 'The workspace was not disclosed.');
    return selected;
  }

  on(event, handler) {
    if (event !== 'change' || typeof handler !== 'function') throw new TypeError('Only on("change", handler) is supported.');
    this.calls.push(['on', event]);
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(reason = 'changed') {
    const event = Object.freeze({ reason });
    for (const listener of this.listeners) listener(event);
  }
}
