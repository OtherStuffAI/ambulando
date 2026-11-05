import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/auth/nostr.js', async original => ({ ...await original(),
  tryAutoLoginFromStorage: async () => ({ pubkey: 'owner', method: 'ephemeral' }),
  signLoginEvent: async () => ({ pubkey: 'owner' }), getPubkeyFromEvent: e => e.pubkey,
  pubkeyToNpub: async () => 'owner', setAutoLogin: vi.fn(),
}));
import { createShellState } from '../src/shell-state.js';
function store() {
  const s = { knownWorkspaces: [], session: null, currentWorkspaceOwnerNpub: '', selectedWorkspaceKey: '',
    resumeNewUserOnboarding: vi.fn(async () => true), openConnectModal: vi.fn(),
  };
  for (const name of ['resolveChatProfile', 'rememberPeople', 'filterKnownWorkspacesForActiveSession', 'updateWorkspaceBootstrapPrompt', 'discoverPgOnboardingAnnouncements', 'discoverPgWorkspaceSelfIndex', 'loadRemoteWorkspaces', 'persistWorkspaceSettings', 'ensureBackgroundSync']) s[name] = vi.fn(async () => {});
  return s;
}
describe('active shell authentication preserves new-user journey', () => {
  it('automatically resumes the persisted identity before opening the connection picker', async () => {
    const s = store(); await createShellState().maybeAutoLogin.call(s);
    expect(s.session).toMatchObject({ npub: 'owner', method: 'ephemeral' });
    expect(s.resumeNewUserOnboarding).toHaveBeenCalledOnce(); expect(s.openConnectModal).not.toHaveBeenCalled();
  });
  it('new sign-in resumes pending setup through the active shell method', async () => {
    const s = store(); await createShellState().login.call(s, 'ephemeral');
    expect(s.loginError).toBeNull(); expect(s.resumeNewUserOnboarding).toHaveBeenCalledOnce(); expect(s.openConnectModal).not.toHaveBeenCalled();
  });
});
