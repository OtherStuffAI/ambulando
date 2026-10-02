import { describe, expect, it } from 'vitest';

import { parseRouteLocation, buildSectionUrl } from '../src/route-helpers.js';

describe('scopeid preservation across section navigation', () => {
  const base = 'http://localhost:5173';

  describe('parseRouteLocation reads scopeid from all sections', () => {
    const sections = ['context', 'tasks', 'chat', 'docs', 'reports', 'opportunities', 'people', 'settings'];
    const disabledSections = new Set(['reports', 'opportunities', 'people']);

    for (const section of sections) {
      it(`reads scopeid from ${section} URL`, () => {
        const route = parseRouteLocation(`${base}/be-free/${section}?scopeid=scope-123`);
        expect(route.section).toBe(disabledSections.has(section) ? 'status' : section);
        expect(route.params.scopeid).toBe('scope-123');
      });
    }

    it('reads scopeid from root status URL', () => {
      const route = parseRouteLocation(`${base}/be-free/flight-deck?scopeid=scope-123`);
      expect(route.section).toBe('status');
      expect(route.params.scopeid).toBe('scope-123');
    });
  });

  describe('buildSectionUrl preserves scopeid across sections', () => {
    it('includes scopeid when navigating from tasks to chat', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'chat',
        scopeid: 'scope-abc',
        params: { channelid: 'chan-1' },
      });
      expect(url).toContain('scopeid=scope-abc');
      expect(url).toContain('channelid=chan-1');
      expect(url).toMatch(/^\/be-free\/chat\?/);
    });

    it('includes scopeid when navigating from chat to docs', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'docs',
        scopeid: 'scope-abc',
        params: { folderid: 'folder-1' },
      });
      expect(url).toContain('scopeid=scope-abc');
      expect(url).toContain('folderid=folder-1');
    });

    it('includes scopeid when navigating to tasks', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'tasks',
        scopeid: 'scope-abc',
        params: { taskid: 'task-1', view: 'list' },
      });
      expect(url).toContain('scopeid=scope-abc');
      expect(url).toContain('taskid=task-1');
      expect(url).toContain('view=list');
    });

    it('includes scopeid when navigating to reports', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'reports',
        scopeid: 'scope-abc',
        params: { reportid: 'report-1' },
      });
      expect(url).toContain('scopeid=scope-abc');
      expect(url).toContain('reportid=report-1');
    });

    it('omits scopeid when null', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'chat',
        scopeid: null,
        params: { channelid: 'chan-1' },
      });
      expect(url).not.toContain('scopeid');
      expect(url).toContain('channelid=chan-1');
    });

    it('omits scopeid when empty string', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'tasks',
        scopeid: '',
      });
      expect(url).not.toContain('scopeid');
    });

    it('works without workspace slug', () => {
      const url = buildSectionUrl({
        section: 'tasks',
        scopeid: 'scope-abc',
      });
      expect(url).toBe('/tasks?scopeid=scope-abc');
    });

    it('omits empty params', () => {
      const url = buildSectionUrl({
        workspaceSlug: 'be-free',
        section: 'chat',
        scopeid: 'scope-abc',
        params: { channelid: null, threadid: '' },
      });
      expect(url).not.toContain('channelid');
      expect(url).not.toContain('threadid');
      expect(url).toContain('scopeid=scope-abc');
    });
  });

  describe('round-trip: buildSectionUrl → parseRouteLocation preserves scopeid', () => {
    const sections = ['context', 'tasks', 'chat', 'docs', 'reports'];
    const disabledSections = new Set(['reports']);

    for (const section of sections) {
      it(`round-trips scopeid through ${section}`, () => {
        const url = buildSectionUrl({
          workspaceSlug: 'be-free',
          section,
          scopeid: 'scope-round-trip',
        });
        const route = parseRouteLocation(`${base}${url}`);
        expect(route.section).toBe(disabledSections.has(section) ? 'status' : section);
        expect(route.params.scopeid).toBe('scope-round-trip');
        expect(route.workspaceSlug).toBe('be-free');
      });
    }
  });
});
