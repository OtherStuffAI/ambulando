import { expect, it, vi } from 'vitest';
import { flightDeckSyncFailure } from '../src/logging.js';

it('keeps one actionable transaction console error across retry owners with periodic reprobe', () => {
  const store = { currentWorkspaceKey: 'workspace-1' };
  const failure = Object.assign(new Error('Transaction has already completed or failed'), {
    name: 'TransactionInactiveError', materializationContext: { mode: 'delta', changeCount: 0 },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    flightDeckSyncFailure(store, 'warn', 'startup-sync', 'workspace sync failed', failure, { page: 8 });
    flightDeckSyncFailure(store, 'warn', 'sse', 'SSE failed', failure);
    flightDeckSyncFailure(store, 'error', 'sync', 'poll failed', failure);
    expect(warn).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][1]).toMatchObject({ page: 8, errorName: 'TransactionInactiveError', errorStack: failure.stack,
      workerContext: { mode: 'delta', changeCount: 0 }, action: expect.stringContaining('unresolved') });
    now.mockReturnValue(61_001);
    flightDeckSyncFailure(store, 'error', 'sync', 'poll failed', failure);
    expect(logError).toHaveBeenCalledOnce();
    store.currentWorkspaceKey = 'workspace-2';
    flightDeckSyncFailure(store, 'warn', 'sse', 'SSE failed', failure);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); }
});

it('keeps other sync failures visible and traces only typed read cancellations', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const store = {};
    flightDeckSyncFailure(store, 'warn', 'sse', 'read failed', Object.assign(new Error('changed'), { code: 'pg_read_authority_changed' }));
    expect(warn).not.toHaveBeenCalled();
    flightDeckSyncFailure(store, 'warn', 'sse', 'read failed', new Error('permission_denied'));
    flightDeckSyncFailure(store, 'warn', 'sse', 'read failed', new Error('permission_denied'));
    expect(warn).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); }
});
