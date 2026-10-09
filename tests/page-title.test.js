import { describe, expect, it } from 'vitest';
import { buildFlightDeckDocumentTitle } from '../src/page-title.js';

describe('page title', () => {
  it('builds task titles', () => {
    expect(buildFlightDeckDocumentTitle({ section: 'tasks' })).toBe('Tasks - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'tasks', workspaceLabel: 'Operator A' })).toBe('Tasks | Operator A - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'workroom', workspaceLabel: 'Operator A' })).toBe('Workroom | Operator A - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'opportunities' })).toBe('Opportunities - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'settings' })).toBe('Setup - Ambulando Sol');
  });

  it('builds chat titles with channel context', () => {
    expect(buildFlightDeckDocumentTitle({ section: 'chat' })).toBe('Chat - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'chat', channelLabel: 'Agent B' })).toBe('Chat | Agent B - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'chat', workspaceLabel: 'Example Workspace', channelLabel: 'Agent B' })).toBe('Chat | Example Workspace | Agent B - Ambulando Sol');
  });

  it('falls back to chat titles for removed or unknown sections', () => {
    expect(buildFlightDeckDocumentTitle({ section: 'live' })).toBe('Chat - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'calendar' })).toBe('Chat - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'schedules' })).toBe('Chat - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'scopes' })).toBe('Chat - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'flows' })).toBe('Chat - Ambulando Sol');
  });

  it('builds docs titles from folder or document context', () => {
    expect(buildFlightDeckDocumentTitle({ section: 'docs', folderLabel: 'Ops' })).toBe('Docs | Ops - Ambulando Sol');
    expect(buildFlightDeckDocumentTitle({ section: 'docs', workspaceLabel: 'Operator A', docTitle: 'Launch Plan' })).toBe('Docs | Operator A | Launch Plan - Ambulando Sol');
  });
});
