import { describe, expect, it, vi } from 'vitest';
import { normalizeEnabledFlightDeckSection } from '../src/disabled-surfaces.js';
import { createShellState } from '../src/shell-state.js';

describe('optional Agents and Context views', () => {
  it.each(['agents', 'context'])('defaults %s off and restores it independently', (section) => {
    expect(normalizeEnabledFlightDeckSection(section, {})).toBe('status');
    expect(normalizeEnabledFlightDeckSection(section, { [`${section}Enabled`]: 'true' })).toBe('status');
    expect(normalizeEnabledFlightDeckSection(section, { [`${section}Enabled`]: true })).toBe(section);
    const other = section === 'agents' ? 'context' : 'agents';
    expect(normalizeEnabledFlightDeckSection(other, { [`${section}Enabled`]: true })).toBe('status');
  });
  it.each(['agents', 'context'])('guards direct %s assignment and route construction', (section) => {
    const shell = createShellState();
    shell.navSection = section;
    expect(shell.navSection).toBe('status');
    expect(shell.getRoutePath(section)).toMatch(/\/flight-deck$/);
    shell[`${section}Enabled`] = true;
    shell.navSection = section;
    expect(shell.navSection).toBe(section);
    expect(shell.getRoutePath(section)).toMatch(new RegExp(`/${section}$`));
    shell[`${section}Enabled`] = false;
    shell.syncRoute = vi.fn();
    shell.startWorkspaceLiveQueries = vi.fn();
    shell.ensureBackgroundSync = vi.fn();
    shell.refreshStatusRecentChanges = vi.fn();
    shell.cancelEditSchedule = vi.fn();
    shell.navigateTo(section);
    expect(shell.navSection).toBe('status');
  });
});

it('blocks agent-card and pipeline entry before selecting or loading private views', async () => {
  const { agentSpaceManagerMixin } = await import('../src/agent-space-manager.js');
  const { pipelineViewerManagerMixin } = await import('../src/pipeline-viewer-manager.js');
  const store = {
    agentsEnabled: false,
    navigateTo: vi.fn(),
    selectAgentSpaceView: vi.fn(),
    selectedWorkspaceAgentId: 'retained-agent',
    pipelineViewerOpen: false,
  };
  await agentSpaceManagerMixin.openAgentSpace.call(store, 'new-agent');
  pipelineViewerManagerMixin.openPipelineViewer.call(store, { runId: 'run' });
  expect(store.navigateTo).toHaveBeenCalledWith('status');
  expect(store.selectAgentSpaceView).not.toHaveBeenCalled();
  expect(store.selectedWorkspaceAgentId).toBe('retained-agent');
  expect(store.pipelineViewerOpen).toBe(false);
});
