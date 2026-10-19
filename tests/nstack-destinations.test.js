import { describe, expect, it } from 'vitest';
import { activeNStackRoute, projectNStackDestinations } from '../src/nstack-destinations.js';

const manualWorkspace = {
  workspaceKey: 'saved-workspace',
  workspaceOwnerNpub: 'npub1owner',
  name: 'Operations',
  directHttpsUrl: 'https://tower.example/',
  towerServiceNpub: 'npub1tower',
  towerName: 'Wingman Tower',
};

describe('unified NStack destinations', () => {
  it('projects legacy saved servers and workspaces as NStacks immediately', () => {
    const result = projectNStackDestinations({
      knownHosts: [{ url: 'https://tower.example', label: 'Saved Tower', serviceNpub: 'npub1tower' }],
      knownWorkspaces: [manualWorkspace],
      currentWorkspace: manualWorkspace,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ label: 'Wingman Tower', active: true, sources: ['configured'] });
    expect(result[0].workspaces).toEqual([
      expect.objectContaining({ label: 'Operations', workspaceKey: 'saved-workspace', active: true }),
    ]);
    expect(activeNStackRoute(result)).toEqual({ stackLabel: 'Wingman Tower', workspaceLabel: 'Operations' });
  });

  it('does not merge a pre-approval browser summary by display name', () => {
    const result = projectNStackDestinations({
      knownHosts: [{ url: 'https://tower.example', label: 'Same name' }],
      browserStacks: [{ id: 'opaque-origin-id', name: 'Same name', available: true }],
      browserOrigin: 'https://ambulando.example',
    });
    expect(result).toHaveLength(2);
    expect(result.find(entry => entry.browserStackId === 'opaque-origin-id')).toMatchObject({ provisional: true });
  });

  it('merges browser and manual sources only after approved endpoint identity matches', () => {
    const result = projectNStackDestinations({
      knownHosts: [{ url: 'https://tower.example/', label: 'Manual NStack' }],
      knownWorkspaces: [manualWorkspace],
      browserStacks: [{ id: 'opaque-stack', name: 'Browser label', available: true }],
      browserWorkspaceCatalogues: { 'opaque-stack': [{ id: 'opaque-workspace', name: 'Browser workspace' }] },
      browserApprovedConnections: {
        'opaque-stack': { url: 'https://tower.example', peerNpub: 'npub1tower', workspaceId: 'opaque-workspace' },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sources: ['configured', 'browser'], provisional: false, browserStackId: 'opaque-stack' });
    expect(result[0].workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceKey: 'saved-workspace', source: 'configured' }),
      expect.objectContaining({ browserWorkspaceId: 'opaque-workspace', source: 'browser', authorized: true }),
    ]));
  });

  it('uses endpoint metadata and a safe generic fallback for the current NStack label', () => {
    expect(projectNStackDestinations({ currentBackendUrl: 'https://hosted.example/' })[0].label).toBe('hosted.example');
    expect(projectNStackDestinations({
      currentWorkspace: { workspaceKey: 'local-only', workspaceOwnerNpub: 'npub1owner', name: 'Local' },
    })[0].label).toBe('Current NStack');
  });
});
