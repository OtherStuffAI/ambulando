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
      host: stack.host === true,
      available: true,
      ...(stack.extra || {}),
    }));
  }

  async listWorkspaces({ stackId }) {
    this.calls.push(['listWorkspaces', { stackId }]);
    this.requireDisclosure();
    const rawId = stackId.split(':stack:')[1];
    if (!rawId) throw providerError('not_disclosed', 'The NStack was not disclosed.');
    return (this.workspaces[rawId] || []).map(workspace => ({ id: `${this.origin}:workspace:${workspace.id}`, name: workspace.name }));
  }

  async requestCapabilities(request) {
    this.calls.push(['requestCapabilities', request]);
    this.requireDisclosure();
    this.sequence += 1;
    const handle = `opaque-handle-${this.sequence}`;
    this.handles.add(handle);
    const rawStackId = request.stackId.split(':stack:')[1];
    const stack = this.stacks.find(candidate => candidate.id === rawStackId);
    return {
      handle,
      stackId: request.stackId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      capabilities: [...request.capabilities].sort(),
      expiresAt: '2099-01-01T00:00:00.000Z',
      connection: {
        transport: 'https',
        url: stack?.url || 'https://stack.example',
        ...(stack?.fipsEndpoint ? { fipsEndpoint: stack.fipsEndpoint, peerNpub: stack.peerNpub } : {}),
      },
    };
  }

  async revoke({ handle }) {
    this.calls.push(['revoke', { handle }]);
    if (!this.handles.delete(handle)) throw providerError('stale_handle', 'Capability handle is stale or revoked.');
    return true;
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
