import { APP_NPUB } from './app-identity.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import {
  broadcastWorkspaceSelfIndexEvent,
  flightDeckSelfIndexAppPubkeyHex,
  publishWorkspaceSelfIndex,
  publishWorkspaceSelfIndexTombstone,
  queryWorkspaceSelfIndexCandidates,
  workspaceSelfIndexRelayUrls,
} from './nostr-workspace-self-index.js';
import { mergeWorkspaceEntries, normalizeWorkspaceEntry, findWorkspaceByKey } from './workspaces.js';

function errorMessage(error) {
  return error?.message || String(error || 'Workspace self-index failed');
}

function timestamp() {
  return new Date().toISOString();
}

const SELF_INDEX_REBROADCAST_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const SELF_INDEX_INACTIVE_STATUSES = new Set([
  'pending',
  'publishing',
  'stale',
  'verified',
  'deleted',
]);

function isSelfIndexBroadcastStale(workspace, now = Date.now()) {
  const last = Date.parse(workspace?.pgSelfIndexLastBroadcastAt || workspace?.pgSelfIndexPublishedAt || '');
  return !Number.isFinite(last) || (Number(now) - last) >= SELF_INDEX_REBROADCAST_INTERVAL_MS;
}

function shouldQueueSelfIndexPublish(workspace, now = Date.now()) {
  if (!workspace?.pgBackendMode) return false;
  const status = String(workspace.pgSelfIndexStatus || '').trim();
  if (SELF_INDEX_INACTIVE_STATUSES.has(status)) return false;
  if (status === 'indexed' && !isSelfIndexBroadcastStale(workspace, now)) return false;
  return true;
}

export const workspaceSelfIndexManagerMixin = {
  workspaceSelfIndexRelayUrls(workspace = null) {
    return workspaceSelfIndexRelayUrls(
      this.currentWorkspace?.relayUrls || [],
      workspace?.relayUrls || [],
    );
  },

  applyWorkspaceSelfIndexPatch(workspace, patch = {}) {
    const workspaceKey = normalizeWorkspaceEntry(workspace)?.workspaceKey || patch.workspaceKey || '';
    const current = workspaceKey
      ? findWorkspaceByKey(this.knownWorkspaces, workspaceKey)
      : null;
    const next = mergeWorkspaceEntries(this.knownWorkspaces, [{
      ...(current || workspace || {}),
      ...patch,
    }]);
    this.knownWorkspaces = next;
    return workspaceKey
      ? findWorkspaceByKey(this.knownWorkspaces, workspaceKey) || null
      : null;
  },

  async persistWorkspaceSelfIndexPatch(workspace, patch = {}) {
    const updated = this.applyWorkspaceSelfIndexPatch(workspace, patch);
    if (typeof this.persistWorkspaceSettings === 'function') {
      await this.persistWorkspaceSettings();
    }
    return updated;
  },

  shouldQueuePgWorkspaceSelfIndexPublish(workspace, now = Date.now()) {
    return shouldQueueSelfIndexPublish(workspace, now);
  },

  async markPgWorkspaceSelfIndexPending(workspace) {
    if (!isTowerPgBackendMode() || !workspace?.pgBackendMode || !this.session?.npub) return workspace || null;
    if (!this.shouldQueuePgWorkspaceSelfIndexPublish(workspace)) return workspace || null;
    return this.persistWorkspaceSelfIndexPatch(workspace, {
      pgSelfIndexStatus: 'pending',
      pgSelfIndexError: null,
      pgSelfIndexFailedAt: null,
    });
  },

  schedulePgWorkspaceSelfIndexPublish(workspace) {
    if (!isTowerPgBackendMode() || !workspace?.pgBackendMode || !this.session?.npub) return null;
    const status = String(workspace.pgSelfIndexStatus || '').trim();
    if (status !== 'pending' && !this.shouldQueuePgWorkspaceSelfIndexPublish(workspace)) return null;
    const task = Promise.resolve()
      .then(() => this.publishPgWorkspaceSelfIndex(workspace))
      .catch(async (error) => {
        try {
          await this.persistWorkspaceSelfIndexPatch(workspace, {
            pgSelfIndexStatus: 'failed',
            pgSelfIndexError: errorMessage(error),
            pgSelfIndexFailedAt: timestamp(),
          });
        } catch (_) {
          // Best-effort background publish must never disrupt local workspace use.
        }
        return null;
      });
    this.pgWorkspaceSelfIndexPublishPromise = task;
    return task;
  },

  async ensureKnownPgWorkspacesSelfIndexed() {
    if (!isTowerPgBackendMode() || !this.session?.npub) return { queued: 0 };
    const candidates = (this.knownWorkspaces || []).filter((workspace) =>
      workspace?.pgBackendMode
      && workspace.pgSessionNpub === this.session.npub
      && this.shouldQueuePgWorkspaceSelfIndexPublish(workspace)
    );
    let queued = 0;
    for (const workspace of candidates) {
      const pending = await this.markPgWorkspaceSelfIndexPending(workspace);
      this.schedulePgWorkspaceSelfIndexPublish(pending || workspace);
      queued += 1;
    }
    return { queued };
  },

  async publishPgWorkspaceSelfIndex(workspace) {
    if (!isTowerPgBackendMode() || !workspace?.pgBackendMode || !this.session?.npub) return null;
    try {
      const existingSignedEvent = workspace.pgSelfIndexSignedEvent && isSelfIndexBroadcastStale(workspace)
        ? workspace.pgSelfIndexSignedEvent
        : null;
      const result = existingSignedEvent
        ? await broadcastWorkspaceSelfIndexEvent({
          event: existingSignedEvent,
          workspace,
          relayUrls: this.workspaceSelfIndexRelayUrls(workspace),
        })
        : await publishWorkspaceSelfIndex({
          workspace,
          userNpub: this.session.npub,
          userPubkeyHex: this.session.pubkey,
          relayUrls: this.workspaceSelfIndexRelayUrls(workspace),
          appNpub: APP_NPUB,
          appPubkeyHex: flightDeckSelfIndexAppPubkeyHex(APP_NPUB),
        });
      await this.persistWorkspaceSelfIndexPatch(workspace, {
        pgSelfIndexStatus: 'indexed',
        pgSelfIndexError: null,
        pgSelfIndexPublishedAt: result.publishedAt,
        pgSelfIndexLastBroadcastAt: result.publishedAt,
        pgSelfIndexEventId: result.event?.id || null,
        pgSelfIndexSignedEvent: result.event || null,
        pgSelfIndexRelays: result.acceptedRelays,
      });
      return result;
    } catch (error) {
      await this.persistWorkspaceSelfIndexPatch(workspace, {
        pgSelfIndexStatus: 'failed',
        pgSelfIndexError: errorMessage(error),
        pgSelfIndexFailedAt: timestamp(),
      });
      return null;
    }
  },

  async publishPgWorkspaceSelfIndexTombstone(workspace, {
    towerResult = 'workspace_deleted',
    reason = 'workspace_deleted',
    sourceEventId = '',
  } = {}) {
    if (!isTowerPgBackendMode() || !workspace?.pgBackendMode || !this.session?.npub) return null;
    try {
      const result = await publishWorkspaceSelfIndexTombstone({
        workspace,
        userNpub: this.session.npub,
        userPubkeyHex: this.session.pubkey,
        relayUrls: this.workspaceSelfIndexRelayUrls(workspace),
        appNpub: APP_NPUB,
        appPubkeyHex: flightDeckSelfIndexAppPubkeyHex(APP_NPUB),
        towerResult,
        reason,
        sourceEventId,
      });
      await this.persistWorkspaceSelfIndexPatch(workspace, {
        pgSelfIndexStatus: 'deleted',
        pgSelfIndexError: null,
        pgSelfIndexPublishedAt: result.publishedAt,
        pgSelfIndexLastBroadcastAt: result.publishedAt,
        pgSelfIndexEventId: result.event?.id || null,
        pgSelfIndexSignedEvent: result.event || null,
        pgSelfIndexRelays: result.acceptedRelays,
      });
      return result;
    } catch (error) {
      await this.persistWorkspaceSelfIndexPatch(workspace, {
        pgSelfIndexStatus: 'failed',
        pgSelfIndexError: errorMessage(error),
        pgSelfIndexFailedAt: timestamp(),
      });
      return null;
    }
  },

  async discoverPgWorkspaceSelfIndex({ candidates = null, tombstones = null } = {}) {
    if (!isTowerPgBackendMode() || !this.session?.npub) {
      return { discovered: 0, eventsSeen: 0, verified: 0, stale: 0, failed: 0 };
    }
    this.pgWorkspaceSelfIndexDiscovering = true;
    this.pgWorkspaceSelfIndexError = null;
    const summary = {
      discovered: 0,
      eventsSeen: 0,
      verified: 0,
      forgotten: 0,
      stale: 0,
      failed: 0,
      rejected: [],
    };
    try {
      const discovered = candidates
        ? { candidates, tombstones: tombstones || [], rejected: [], events: [] }
        : await queryWorkspaceSelfIndexCandidates({
          userNpub: this.session.npub,
          userPubkeyHex: this.session.pubkey,
          relayUrls: this.workspaceSelfIndexRelayUrls(),
          appPubkeyHex: flightDeckSelfIndexAppPubkeyHex(APP_NPUB),
        });
      summary.eventsSeen = discovered.events?.length || discovered.candidates.length || 0;
      summary.discovered = discovered.candidates.length;
      summary.rejected.push(...(discovered.rejected || []));
      if (summary.eventsSeen > 0 && summary.discovered === 0 && summary.rejected.length > 0) {
        this.pgWorkspaceSelfIndexError = `Found ${summary.eventsSeen} workspace index event${summary.eventsSeen === 1 ? '' : 's'} but none could be decrypted or accepted. Check this browser's Nostr signer and relay access.`;
      }

      for (const tombstone of discovered.tombstones || []) {
        // A foreign app can retire only its own address, already reduced by the reader.
        // It must not forget this client's saved connection or suppress another app's active index.
        if (tombstone.payload?.app?.app_pubkey !== flightDeckSelfIndexAppPubkeyHex(APP_NPUB)) continue;
        this.rememberPgWorkspaceForgottenThisLoad?.(tombstone.locator, {
          forgottenAt: tombstone.payload?.state?.deleted_at
            || tombstone.payload?.updated_at
            || (Number(tombstone.event?.created_at || 0) > 0
              ? new Date(Number(tombstone.event.created_at) * 1000).toISOString()
              : new Date().toISOString()),
          reason: tombstone.payload?.state?.reason || 'workspace_self_index_tombstone',
        });
        summary.forgotten += 1;
      }

      for (const candidate of discovered.candidates) {
        const locator = candidate.locator;
        if (this.isPgWorkspaceForgottenThisLoad?.(locator, { event: candidate.event })) {
          summary.stale += 1;
          continue;
        }
        try {
          const { descriptor, me } = await this.verifyPgDescriptor(locator, {
            baseUrl: locator.tower_base_url,
          });
          this.addKnownHost?.({ url: locator.tower_base_url, label: descriptor.label || locator.tower_base_url,
            serviceNpub: locator.tower_service_npub });
          const shouldSelectWorkspace = false; // Discovery never chooses a Tower or workspace for the user.
          const workspace = await this.rememberVerifiedPgWorkspace(descriptor, me, {
            select: shouldSelectWorkspace,
            publishSelfIndex: false,
          });
          if (shouldSelectWorkspace && workspace?.workspaceKey) {
            this.selectedWorkspaceKey = workspace.workspaceKey;
            this.currentWorkspaceOwnerNpub = workspace.workspaceOwnerNpub || this.currentWorkspaceOwnerNpub;
            await this.selectWorkspace?.(workspace.workspaceKey || workspace.workspaceOwnerNpub, {
              pgVerified: true,
              refresh: false,
            });
          }
          await this.persistWorkspaceSelfIndexPatch(workspace, {
            pgSelfIndexStatus: 'verified',
            pgSelfIndexDiscoveredAt: timestamp(),
            pgSelfIndexVerifiedAt: timestamp(),
            pgSelfIndexEventId: candidate.event?.id || null,
          });
          summary.verified += 1;
        } catch (error) {
          summary.stale += 1;
          summary.rejected.push({
            eventId: candidate.event?.id || '',
            workspaceId: locator?.workspace_id || '',
            error: errorMessage(error),
          });
          const existing = this.findKnownPgWorkspaceForLocator?.(locator)
            || this.knownWorkspaces.find((workspace) =>
              workspace.pgBackendMode
              && workspace.workspaceId === locator?.workspace_id
              && workspace.workspaceServiceNpub === locator?.workspace_service_npub
            );
          if (existing && Number(error?.status) === 404 && typeof this.forgetMissingPgWorkspace === 'function') {
            await this.forgetMissingPgWorkspace(existing, {
              error,
              towerResult: 'workspace_not_found',
              reason: 'descriptor_not_found',
              sourceEventId: candidate.event?.id || '',
              selectFallback: true,
            });
            continue;
          }
          if (existing) {
            await this.persistWorkspaceSelfIndexPatch(existing, {
              pgSelfIndexStatus: 'stale',
              pgSelfIndexError: errorMessage(error),
              pgSelfIndexStaleAt: timestamp(),
            });
          }
        }
      }
      if (summary.discovered > 0 && summary.verified === 0 && summary.stale > 0) {
        const lastError = [...summary.rejected].reverse().find((entry) => entry?.error)?.error;
        this.pgWorkspaceSelfIndexError = [
          `Found ${summary.discovered} workspace index event${summary.discovered === 1 ? '' : 's'}, but Tower did not verify current access`,
          lastError ? `: ${lastError}` : '.',
        ].join('');
      }
      this.pgWorkspaceSelfIndexSummary = summary;
      await this.ensureKnownPgWorkspacesSelfIndexed();
      return summary;
    } catch (error) {
      summary.failed += 1;
      this.pgWorkspaceSelfIndexError = errorMessage(error);
      this.pgWorkspaceSelfIndexSummary = summary;
      await this.ensureKnownPgWorkspacesSelfIndexed();
      return summary;
    } finally {
      this.pgWorkspaceSelfIndexDiscovering = false;
    }
  },
};
