export const AVATAR_STATUS_TOWER_PG_CONNECTED = 'tower-pg-connected';
export const AVATAR_STATUS_SYNCING = 'syncing';
export const AVATAR_STATUS_LOCAL_ONLY = 'local-only';
export const AVATAR_STATUS_ERROR = 'error';

const ENCRYPTED_STATUS_LABELS = Object.freeze({
  synced: 'Synced',
  unsynced: 'Pending',
  stale: 'Stale',
  syncing: 'Syncing',
  quarantined: 'Quarantined',
  error: 'Error',
  disabled: 'Disabled',
});

const ENCRYPTED_STATUS_TITLES = Object.freeze({
  synced: 'Synced',
  unsynced: 'Local changes pending',
  stale: 'Updates available',
  syncing: 'Syncing...',
  quarantined: 'Quarantine needs review',
  error: 'Sync error',
  disabled: 'Sync disabled',
});

const PG_STATUS_LABELS = Object.freeze({
  [AVATAR_STATUS_TOWER_PG_CONNECTED]: 'Tower Connected (PG)',
  [AVATAR_STATUS_SYNCING]: 'Syncing',
  [AVATAR_STATUS_LOCAL_ONLY]: 'Offline (Local Only)',
  [AVATAR_STATUS_ERROR]: 'Update Error',
});

export function resolveAvatarConnectionStatus(store = {}, env = globalThis) {
  if (!store.isTowerPgMode) return store.syncStatus || 'disabled';
  if (
    store.syncing
    || store.connectHostBusy
    || store.connectWorkspacesBusy
    || store.connectCreatingWorkspace
    || store.pendingWritesBusy
    || store.syncStatus === 'syncing'
  ) {
    return AVATAR_STATUS_SYNCING;
  }
  if (store.applicationAssetError || store.startupSyncProgress?.error || store.syncStatus === 'error' || store.syncSession?.state === 'error') return AVATAR_STATUS_ERROR;
  const offline = typeof env?.navigator !== 'undefined' && env.navigator?.onLine === false;
  const connected = Boolean(store.currentWorkspace?.pgBackendMode && store.backendUrl && store.session?.npub);
  if (offline || !connected) return AVATAR_STATUS_LOCAL_ONLY;
  return AVATAR_STATUS_TOWER_PG_CONNECTED;
}

export function avatarConnectionLabel(store = {}) {
  const status = store.avatarConnectionStatus || resolveAvatarConnectionStatus(store);
  if (store.isTowerPgMode) return PG_STATUS_LABELS[status] || PG_STATUS_LABELS[AVATAR_STATUS_LOCAL_ONLY];
  return ENCRYPTED_STATUS_LABELS[store.syncStatus] || store.syncStatus;
}

export function avatarConnectionTitle(store = {}) {
  if (store.isTowerPgMode) return avatarConnectionLabel(store);
  return ENCRYPTED_STATUS_TITLES[store.syncStatus] || 'Unknown';
}

export function avatarControlTitle(store = {}) {
  if (store.applicationAssetError) return 'Application file unavailable — open recovery options';
  const startupProgress = store.startupSyncProgress || {};
  if (startupProgress.visible && (startupProgress.error || startupProgress.stage === 'error')) {
    return 'Update stalled — open progress and retry';
  }
  if (startupProgress.visible && startupProgress.active) {
    return 'Receiving updates — open progress';
  }
  return avatarConnectionTitle(store);
}

export const avatarStatusMixin = {
  get avatarConnectionStatus() {
    return resolveAvatarConnectionStatus(this);
  },

  get avatarConnectionLabel() {
    return avatarConnectionLabel(this);
  },

  get avatarConnectionTitle() {
    return avatarConnectionTitle(this);
  },

  get avatarControlTitle() {
    return avatarControlTitle(this);
  },
};
