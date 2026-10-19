import { nip19 } from 'nostr-tools';
import { createNStackProviderAdapter, nstackErrorMessage, waitForNStackProvider } from './nstack-provider.js';
import { activeNStackRoute, projectNStackDestinations } from './nstack-destinations.js';
import { loadNStackSelection, saveNStackSelection } from './nstack-selection-store.js';
import {
  buildNStackRecoveryEvent,
  nstackRecoveryAddress,
  NSTACK_RECOVERY_TYPES,
  restoreNStackRecovery,
} from './nstack-recovery.js';
import { createNStackRecoveryRepository, nstackRecoveryRelayUrls } from './nstack-recovery-relay.js';
import {
  decodeNpub,
  personalDecryptFromNpub,
  personalEncryptForNpub,
  signNostrEvent,
} from './auth/nostr.js';

function text(value) {
  return String(value ?? '').trim();
}

function currentOrigin() {
  return globalThis.location?.origin || 'http://localhost';
}

function signerForSession(session) {
  const npub = text(session?.npub);
  if (!npub) throw new Error('Sign in with your Nostr identity first.');
  const pubkey = decodeNpub(npub);
  return {
    getPublicKey: async () => pubkey,
    encrypt: async (peerPubkey, plaintext) => personalEncryptForNpub(nip19.npubEncode(peerPubkey), plaintext),
    decrypt: async (peerPubkey, ciphertext) => personalDecryptFromNpub(nip19.npubEncode(peerPubkey), ciphertext),
    signEvent: signNostrEvent,
  };
}

function statusForError(error) {
  if (error?.code === 'consent_denied') return 'denied';
  if (error?.code === 'stale_handle' || error?.code === 'not_disclosed') return 'revoked';
  if (error?.code === 'stack_unavailable' || error?.code === 'unavailable') return 'unreachable';
  if (error?.code === 'malformed' || error?.code === 'invalid_request' || error?.code === 'unsupported_capability') return 'malformed';
  return 'error';
}

export const nstackManagerMixin = {
  nstackAvailability: 'checking',
  nstackProtocolVersion: '',
  nstackStatus: '',
  nstackError: '',
  nstackBusy: false,
  nstackDiscoveryApproved: false,
  nstackStacks: [],
  nstackWorkspaces: [],
  nstackWorkspaceCatalogues: {},
  nstackBrowserApprovedConnections: {},
  nstackSelectedStackId: '',
  nstackSelectedWorkspaceId: '',
  nstackActiveSelection: null,
  nstackConnectionVerified: false,
  nstackRecoveryRelaysInput: '',
  nstackRecoveryStatus: '',
  nstackRecoveryError: '',
  nstackRecoveredRegistry: null,
  _nstackAdapter: null,
  _nstackUnsubscribe: null,
  _nstackInitializedPartition: '',
  _nstackReadyListener: null,

  get nstackSelectedStack() {
    return this.nstackStacks.find(stack => stack.id === this.nstackSelectedStackId) || null;
  },

  get nstackSelectedWorkspace() {
    return this.nstackWorkspaces.find(workspace => workspace.id === this.nstackSelectedWorkspaceId) || null;
  },

  get knownNStacks() {
    return projectNStackDestinations({
      knownHosts: this.mergedHostsList || this.knownHosts || [],
      knownWorkspaces: this.knownWorkspaces || [],
      currentWorkspace: this.currentWorkspace,
      currentBackendUrl: this.currentWorkspaceBackendUrl || this.backendUrl,
      browserStacks: this.nstackStacks,
      browserWorkspaceCatalogues: this.nstackWorkspaceCatalogues,
      browserApprovedConnections: this.nstackBrowserApprovedConnections,
      browserOrigin: currentOrigin(),
    });
  },

  get activeNStackRoute() {
    return activeNStackRoute(this.knownNStacks);
  },

  nstackRelays() {
    return nstackRecoveryRelayUrls(text(this.nstackRecoveryRelaysInput).split(/[\s,]+/).filter(Boolean));
  },

  async initializeNStackDiscovery({ provider, timeoutMs = 1_500, force = false } = {}) {
    const identity = text(this.session?.npub);
    const workspacePartition = text(this.currentWorkspaceKey || this.selectedWorkspaceKey) || 'unbound';
    const partition = `${currentOrigin()}\n${identity}\n${workspacePartition}`;
    if (!force && this._nstackInitializedPartition === partition && this._nstackAdapter) return;
    this._nstackUnsubscribe?.();
    this._nstackAdapter?.dispose?.();
    const resolvedProvider = await waitForNStackProvider({ provider, timeoutMs });
    this._nstackAdapter = createNStackProviderAdapter({ provider: resolvedProvider, origin: currentOrigin() });
    this._nstackInitializedPartition = partition;
    this.nstackAvailability = 'checking';
    this.nstackError = '';
    this.nstackDiscoveryApproved = false;
    this.nstackStacks = [];
    this.nstackWorkspaces = [];
    this.nstackWorkspaceCatalogues = {};
    this.nstackBrowserApprovedConnections = {};
    this.nstackConnectionVerified = false;
    try {
      const availability = await this._nstackAdapter.isAvailable();
      this.nstackAvailability = availability.available ? 'available' : 'unavailable';
      this.nstackProtocolVersion = availability.version;
    } catch (error) {
      this.nstackAvailability = 'unavailable';
      this.nstackError = nstackErrorMessage(error);
    }
    this._nstackUnsubscribe = this._nstackAdapter.on('change', change => this.handleNStackChange(change));
    if (!resolvedProvider && !this._nstackReadyListener && globalThis.window?.addEventListener) {
      this._nstackReadyListener = () => {
        this._nstackReadyListener = null;
        void this.initializeNStackDiscovery({ provider: globalThis.window?.NStack, timeoutMs: 0, force: true });
      };
      globalThis.window.addEventListener('nstackready', this._nstackReadyListener, { once: true });
    }
    if (identity) {
      this.nstackActiveSelection = await loadNStackSelection({ origin: currentOrigin(), identity, workspacePartition }).catch(() => null);
      if (this.nstackActiveSelection) {
        this.nstackSelectedStackId = this.nstackActiveSelection.stackId;
        this.nstackSelectedWorkspaceId = this.nstackActiveSelection.workspaceId;
      }
    }
  },

  async requestNStackDiscovery() {
    if (this.nstackBusy) return;
    await this.initializeNStackDiscovery();
    if (this.nstackAvailability !== 'available') {
      this.nstackStatus = 'unavailable';
      this.nstackError = 'NStack discovery is unavailable. Use the manual Tower connection below.';
      return;
    }
    this.nstackBusy = true;
    this.nstackError = '';
    this.nstackStatus = 'requesting';
    try {
      await this._nstackAdapter.requestDiscovery({ workspaces: true });
      this.nstackDiscoveryApproved = true;
      this.nstackStacks = await this._nstackAdapter.listNStacks();
      this.nstackWorkspaceCatalogues = {};
      this.nstackBrowserApprovedConnections = {};
      this.nstackStatus = this.nstackStacks.length ? 'discovered' : 'empty';
      if (this.nstackStacks.length === 1) await this.selectNStack(this.nstackStacks[0].id);
    } catch (error) {
      this.nstackStatus = statusForError(error);
      this.nstackError = nstackErrorMessage(error);
    } finally {
      this.nstackBusy = false;
    }
  },

  async selectNStack(stackId) {
    this.nstackSelectedStackId = text(stackId);
    this.nstackSelectedWorkspaceId = '';
    this.nstackWorkspaces = [];
    this.nstackConnectionVerified = false;
    this.nstackBusy = true;
    this.nstackError = '';
    try {
      this.nstackWorkspaces = await this._nstackAdapter.listWorkspaces({ stackId: this.nstackSelectedStackId });
      this.nstackWorkspaceCatalogues = {
        ...this.nstackWorkspaceCatalogues,
        [this.nstackSelectedStackId]: this.nstackWorkspaces,
      };
      const first = this.nstackWorkspaces[0];
      if (first) {
        this.nstackBrowserApprovedConnections = {
          ...this.nstackBrowserApprovedConnections,
          [this.nstackSelectedStackId]: {
            url: first.directHttpsUrl,
            peerNpub: first.serviceNpub,
          },
        };
      }
      this.nstackStatus = this.nstackWorkspaces.length ? 'workspaces' : 'no_workspaces';
    } catch (error) {
      this.nstackStatus = statusForError(error);
      this.nstackError = nstackErrorMessage(error);
    } finally {
      this.nstackBusy = false;
    }
  },

  chooseNStackWorkspace(workspaceId) {
    this.nstackSelectedWorkspaceId = text(workspaceId);
    this.nstackConnectionVerified = false;
    this.nstackStatus = 'workspace_selected';
    this.nstackError = '';
  },

  async activateNStackSelection() {
    const stack = this.nstackSelectedStack;
    const workspace = this.nstackSelectedWorkspace;
    if (!stack || !workspace || this.nstackBusy) return;
    this.nstackBusy = true;
    this.nstackError = '';
    const previousSelection = this.nstackActiveSelection;
    try {
      const disclosed = await this._nstackAdapter.getConnection({
        stackId: stack.id,
        workspaceId: workspace.id,
      });
      const candidate = {
        type: 'wingman_workspace_locator',
        tower_base_url: disclosed.directHttpsUrl,
        identity: {
          tower_service_npub: disclosed.serviceNpub,
          workspace_service_npub: disclosed.workspaceServiceNpub,
          workspace_owner_npub: disclosed.workspaceOwnerNpub,
          workspace_id: disclosed.workspaceId,
        },
        label: disclosed.name,
      };
      const { descriptor, me } = await this.verifyPgDescriptor(candidate, { baseUrl: disclosed.directHttpsUrl });
      if (descriptor.workspaceId !== disclosed.workspaceId
        || descriptor.workspaceOwnerNpub !== disclosed.workspaceOwnerNpub
        || descriptor.workspaceServiceNpub !== disclosed.workspaceServiceNpub
        || descriptor.towerServiceNpub !== disclosed.serviceNpub
        || descriptor.towerBaseUrl !== disclosed.directHttpsUrl) {
        throw Object.assign(new Error('NBrowser workspace details do not match Tower verification.'), { code: 'malformed' });
      }
      const imported = await this.rememberVerifiedPgWorkspace(descriptor, me, {
        clearLocalForget: true,
        connectionMetadata: {
          fipsEndpoint: disclosed.fipsEndpoint || '',
          peerNpub: disclosed.peerNpub || '',
        },
      });
      await this.selectWorkspace(imported.workspaceKey || imported.workspaceOwnerNpub, { pgVerified: true });
      this.nstackBrowserApprovedConnections = {
        ...this.nstackBrowserApprovedConnections,
        [stack.id]: {
          url: disclosed.directHttpsUrl,
          peerNpub: disclosed.serviceNpub,
          workspaceId: disclosed.workspaceId,
        },
      };
      this.nstackActiveSelection = await saveNStackSelection({
        origin: currentOrigin(),
        identity: this.session?.npub,
        workspacePartition: text(this.currentWorkspaceKey || this.selectedWorkspaceKey) || 'unbound',
        selection: {
          stackId: stack.id,
          stackLabel: stack.name,
          workspaceId: workspace.id,
          workspaceLabel: workspace.name,
          remoteWorkspaceId: disclosed.workspaceId,
        },
      });
      this.nstackConnectionVerified = true;
      this.nstackStatus = 'active';
    } catch (error) {
      this.nstackActiveSelection = previousSelection;
      this.nstackConnectionVerified = false;
      this.nstackStatus = statusForError(error);
      this.nstackError = nstackErrorMessage(error);
    } finally {
      this.nstackBusy = false;
    }
  },

  handleNStackChange(change = {}) {
    this.nstackDiscoveryApproved = false;
    this.nstackStacks = [];
    this.nstackWorkspaces = [];
    this.nstackWorkspaceCatalogues = {};
    this.nstackBrowserApprovedConnections = {};
    this.nstackSelectedStackId = '';
    this.nstackSelectedWorkspaceId = '';
    this.nstackConnectionVerified = false;
    this.nstackStatus = 'changed';
    this.nstackError = `NStack access changed (${text(change.reason) || 'changed'}). Discover again to review browser-saved destinations. The active Tower connection was preserved.`;
  },

  async selectKnownNStackWorkspace(nstack, workspace) {
    if (workspace?.workspaceKey) {
      await this.selectWorkspace(workspace.workspaceKey);
      return;
    }
    if (!nstack?.browserStackId || !workspace?.browserWorkspaceId) return;
    if (this.nstackSelectedStackId !== nstack.browserStackId) {
      await this.selectNStack(nstack.browserStackId);
    }
    this.chooseNStackWorkspace(workspace.browserWorkspaceId);
  },

  async createNStackRecoveryBackup() {
    const stack = this.nstackSelectedStack;
    const workspace = this.nstackSelectedWorkspace;
    if (!stack || !workspace || !this.nstackConnectionVerified || this.nstackBusy) {
      this.nstackRecoveryError = 'Import and verify a host workspace before creating its recovery records.';
      return;
    }
    if (!stack.host) {
      this.nstackRecoveryError = 'Select the host NStack and approve its workspace before creating the bootstrap record.';
      return;
    }
    this.nstackBusy = true;
    this.nstackRecoveryError = '';
    this.nstackRecoveryStatus = 'publishing';
    const repository = createNStackRecoveryRepository();
    const relays = this.nstackRelays();
    try {
      const signer = signerForSession(this.session);
      const author = await signer.getPublicKey();
      const disclosed = this._nstackAdapter.getWorkspaceDescriptor({ stackId: stack.id, workspaceId: workspace.id });
      const descriptor = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.DESCRIPTOR,
        logicalKey: stack.id,
        data: {
          stackId: stack.id,
          label: stack.name,
          endpoint: disclosed.directHttpsUrl,
          servicePubkeys: { tower: disclosed.serviceNpub },
          protocolVersions: { nstack: this.nstackProtocolVersion },
        },
        signer,
      });
      const catalogue = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.WORKSPACES,
        logicalKey: stack.id,
        data: { stackId: stack.id, workspaces: this.nstackWorkspaces.map(entry => ({ id: entry.id, label: entry.name })) },
        signer,
      });
      const policy = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.POLICY,
        logicalKey: stack.id,
        data: { stackId: stack.id, workspaceId: workspace.id, capabilities: ['connection.autofill'] },
        signer,
      });
      for (const event of [descriptor, catalogue, policy]) await repository.publish({ relays, event });
      const stackRecords = [{
        descriptor: nstackRecoveryAddress(author, descriptor.tags[0][1]),
        workspaces: nstackRecoveryAddress(author, catalogue.tags[0][1]),
        policy: nstackRecoveryAddress(author, policy.tags[0][1]),
      }];
      const index = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.INDEX,
        data: { stackRecords, snapshotReferences: [] },
        signer,
      });
      const hostHint = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.HOST_HINT,
        data: { host: { stackId: stack.id, endpoint: disclosed.directHttpsUrl }, recoveryRelays: relays },
        signer,
      });
      await repository.publish({ relays, event: index });
      await repository.publish({ relays, event: hostHint });
      this.nstackRecoveryStatus = `published:${stackRecords.length}`;
    } catch (error) {
      this.nstackRecoveryStatus = 'error';
      this.nstackRecoveryError = error?.message || 'NStack recovery publication failed.';
    } finally {
      this.nstackBusy = false;
    }
  },

  async restoreNStackRecoveryBackup() {
    if (this.nstackBusy) return;
    this.nstackBusy = true;
    this.nstackRecoveryError = '';
    this.nstackRecoveryStatus = 'restoring';
    try {
      const signer = signerForSession(this.session);
      this.nstackRecoveredRegistry = await restoreNStackRecovery({
        repository: createNStackRecoveryRepository(),
        bootstrapRelays: this.nstackRelays(),
        author: await signer.getPublicKey(),
        signer,
      });
      this.nstackRecoveryStatus = this.nstackRecoveredRegistry.failures.length ? 'partial' : 'restored';
    } catch (error) {
      this.nstackRecoveryStatus = 'error';
      this.nstackRecoveryError = error?.message || 'NStack recovery restore failed.';
    } finally {
      this.nstackBusy = false;
    }
  },
};
