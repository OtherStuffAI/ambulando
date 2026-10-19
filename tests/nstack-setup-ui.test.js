import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('unified NStack setup UI', () => {
  it('renders one NStack management area with nested workspaces and the active route', () => {
    expect(html).toContain('<h2>Your NStacks</h2>');
    expect(html).toContain('x-text="`${$store.chat.activeNStackRoute?.stackLabel');
    expect(html).toContain('x-for="nstack in $store.chat.knownNStacks"');
    expect(html).toContain('x-for="workspace in nstack.workspaces"');
    expect(html).not.toContain('<h2>SuperBased</h2>');
    expect(html).not.toContain('<h2>NStack discovery</h2>');
  });

  it('describes browser discovery and manual setup as sources for the same NStacks', () => {
    expect(html).toContain('Find NStacks through Nostr Browser');
    expect(html).toContain('Add an NStack manually');
    expect(html).toContain('@click="$store.chat.openConnectModal()">Add an NStack manually');
    expect(html).not.toContain('@click="$store.chat.openWorkspaceBootstrapModal()">Add an NStack manually');
    expect(html).toContain('Tower/Supabase connection details to add an NStack');
    expect(html).toContain('Existing Tower/Supabase connection key');
  });

  it('promises a real verified Tower connection rather than a capability badge', () => {
    expect(html).toContain('Connect to this workspace');
    expect(html).toContain('fresh <code>window.nostr</code>/NIP-98 requests to Tower');
    expect(html).toContain('nstackConnectionVerified');
    expect(html).not.toContain('Request workspace access');
    expect(html).not.toContain('Capability active for this page');
  });
});
