import { nip19 } from 'nostr-tools';
import { createNStackProviderAdapter, nstackErrorMessage } from './nstack-provider.js';
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

export const AMBULANDO_NSTACK_CAPABILITIES = Object.freeze(['workspace.read']);

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
  nstackSelectedStackId: '',
  nstackSelectedWorkspaceId: '',
  nstackActiveSelection: null,
  nstackCapabilityHandleId: '',
  nstackRecoveryRelaysInput: '',
  nstackRecoveryStatus: '',
  nstackRecoveryError: '',
  nstackRecoveredRegistry: null,
  _nstackAdapter: null,
  _nstackUnsubscribe: null,
  _nstackInitializedPartition: '',
  _nstackCapability: null,

  get nstackSelectedStack() {
    return this.nstackStacks.find(stack => stack.id === this.nstackSelectedStackId) || null;
  },

  get nstackSelectedWorkspace() {
    return this.nstackWorkspaces.find(workspace => workspace.id === this.nstackSelectedWorkspaceId) || null;
  },

  nstackRelays() {
    return nstackRecoveryRelayUrls(text(this.nstackRecoveryRelaysInput).split(/[\s,]+/).filter(Boolean));
  },

  async initializeNStackDiscovery({ provider = globalThis.window?.NStack } = {}) {
    const identity = text(this.session?.npub);
    const workspacePartition = text(this.currentWorkspaceKey || this.selectedWorkspaceKey) || 'unbound';
    const partition = `${currentOrigin()}\n${identity}\n${workspacePartition}`;
    if (this._nstackInitializedPartition === partition && this._nstackAdapter) return;
    this._nstackUnsubscribe?.();
    this._nstackAdapter?.dispose?.();
    this._nstackAdapter = createNStackProviderAdapter({ provider, origin: currentOrigin() });
    this._nstackInitializedPartition = partition;
    this.nstackAvailability = 'checking';
    this.nstackError = '';
    this.nstackDiscoveryApproved = false;
    this.nstackStacks = [];
    this.nstackWorkspaces = [];
    this.nstackCapabilityHandleId = '';
    this._nstackCapability = null;
    try {
      const availability = await this._nstackAdapter.isAvailable();
      this.nstackAvailability = availability.available ? 'available' : 'unavailable';
      this.nstackProtocolVersion = availability.version;
    } catch (error) {
      this.nstackAvailability = 'unavailable';
      this.nstackError = nstackErrorMessage(error);
    }
    this._nstackUnsubscribe = this._nstackAdapter.on('change', change => this.handleNStackChange(change));
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
    this.nstackCapabilityHandleId = '';
    this._nstackCapability = null;
    this.nstackBusy = true;
    this.nstackError = '';
    try {
      this.nstackWorkspaces = await this._nstackAdapter.listWorkspaces({ stackId: this.nstackSelectedStackId });
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
    this.nstackCapabilityHandleId = '';
    this._nstackCapability = null;
    this.nstackStatus = 'workspace_selected';
    this.nstackError = '';
  },

  async activateNStackSelection() {
    const stack = this.nstackSelectedStack;
    const workspace = this.nstackSelectedWorkspace;
    if (!stack || !workspace || this.nstackBusy) return;
    this.nstackBusy = true;
    this.nstackError = '';
    try {
      const handle = await this._nstackAdapter.requestCapabilities({
        stackId: stack.id,
        workspaceId: workspace.id,
        capabilities: AMBULANDO_NSTACK_CAPABILITIES,
        duration: 900,
      });
      this._nstackCapability = handle;
      this.nstackCapabilityHandleId = handle.handle;
      this.nstackActiveSelection = await saveNStackSelection({
        origin: currentOrigin(),
        identity: this.session?.npub,
        workspacePartition: text(this.currentWorkspaceKey || this.selectedWorkspaceKey) || 'unbound',
        selection: {
          stackId: stack.id,
          stackLabel: stack.name,
          workspaceId: workspace.id,
          workspaceLabel: workspace.name,
        },
      });
      this.nstackStatus = 'active';
    } catch (error) {
      this.nstackStatus = statusForError(error);
      this.nstackError = nstackErrorMessage(error);
    } finally {
      this.nstackBusy = false;
    }
  },

  handleNStackChange(change = {}) {
    if (this.nstackCapabilityHandleId) {
      this.nstackCapabilityHandleId = '';
      this._nstackCapability = null;
      this.nstackStatus = 'changed';
      this.nstackError = `NStack access changed (${text(change.reason) || 'changed'}). Review the same destination and request access again; Ambulando did not switch destinations.`;
    } else {
      this.nstackStatus = 'changed';
    }
  },

  async createNStackRecoveryBackup() {
    const stack = this.nstackSelectedStack;
    const workspace = this.nstackSelectedWorkspace;
    const capability = this._nstackCapability;
    if (!stack || !workspace || !capability || this.nstackBusy) {
      this.nstackRecoveryError = 'Choose a host workspace and approve access before creating its recovery records.';
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
      this._nstackAdapter.assertHandleActive(capability.handle);
      const descriptor = await buildNStackRecoveryEvent({
        type: NSTACK_RECOVERY_TYPES.DESCRIPTOR,
        logicalKey: stack.id,
        data: {
          stackId: stack.id,
          label: stack.name,
          endpoint: capability.connection.url,
          servicePubkeys: capability.connection.peerNpub ? { tower: capability.connection.peerNpub } : {},
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
        data: { stackId: stack.id, workspaceId: workspace.id, capabilities: AMBULANDO_NSTACK_CAPABILITIES },
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
        data: { host: { stackId: stack.id, endpoint: capability.connection.url }, recoveryRelays: relays },
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
