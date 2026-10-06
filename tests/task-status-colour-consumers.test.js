import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('task status colour consumers', () => {
  it('passes canonical column colours into expanded, collapsed, and list Board treatments', () => {
    expect(html).toContain(":style=\"{ '--task-status-color': col.color }\"");
    expect(html).toContain(":style=\"{ '--task-status-color': group.color }\"");
    expect(styles).toMatch(/\.kanban-column-collapsed \.kanban-column-header\s*\{[^}]*var\(--task-status-color/s);
    expect(styles).toMatch(/\.kanban-column:not\(\.kanban-column-collapsed\) \.kanban-column-header\s*\{[^}]*var\(--task-status-color/s);
    expect(styles).toMatch(/\.task-list-group-header\s*\{[^}]*var\(--task-status-color/s);
    expect(styles).not.toMatch(/\.kanban-col-(?:summary|new|ready|in_progress|blocked|review|done).*border-(?:left|bottom)-color/);
  });

  it('uses the canonical helper for representative Board and task-detail badges', () => {
    const badges = html.match(/<[^>]*task-status-badge[^>]*>/g) || [];
    expect(badges.length).toBeGreaterThanOrEqual(8);
    for (const badge of badges) {
      expect(badge).toContain('--task-status-color');
      expect(badge).toContain('$store.chat.stateColor(');
    }
    expect(html).toContain("$store.chat.stateColor($store.chat.editingTask.state || 'new')");
    expect(html).toContain('$store.chat.stateColor(pred.state)');
    expect(html).toContain('$store.chat.stateColor(st.state)');
    expect(styles).toMatch(/\.task-status-badge\s*\{[^}]*--task-status-color[^}]*--task-status-color/s);
  });

  it('keeps generic non-task state utilities separate from task status badges', () => {
    expect(html).toContain("job.enabled ? 'state-done' : 'state-new'");
    expect(html).toContain("schedule.active ? 'state-done' : 'state-new'");
    expect(html).not.toMatch(/task-status-badge[^>]*:class=\"`state-/);
  });
});
