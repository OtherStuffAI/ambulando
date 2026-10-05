// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hydrateMentionComposer, serializeMentionComposer } from '../src/mention-composer.js';
import { canonicalTaskAgentMentions, sameNpubSet } from '../src/task-agent-mentions.js';
import { mapPgTaskCommentToLocal, mapPgTaskToLocal } from '../src/pg-read-hydrator.js';
import fs from 'node:fs';

describe('typed PG task agent mentions', () => {
  it('selects, serializes, and hydrates canonical agent tokens', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.innerHTML = 'Please @[Test Agent](mention:agent:npub1testagent) review';
    const value = root.textContent;
    hydrateMentionComposer(root, value);

    expect(serializeMentionComposer(root)).toBe(value);
    expect(canonicalTaskAgentMentions(value)).toEqual([
      { type: 'agent', npub: 'npub1testagent', label: 'Test Agent' },
    ]);
  });

  it('deduplicates person and agent spellings by stable npub', () => {
    expect(canonicalTaskAgentMentions(
      '@[Test Agent](mention:person:npub1testagent) and @[Test Agent](mention:agent:npub1testagent)',
    )).toEqual([{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }]);
  });

  it('treats unchanged assignment re-saves as the same transition set', () => {
    expect(sameNpubSet(['npub1testagent'], ['npub1testagent'])).toBe(true);
    expect(sameNpubSet(['npub1testagent'], ['npub1testagent', 'npub1operator-a'])).toBe(false);
  });

  it('preserves canonical metadata through task and comment hydration', () => {
    const mentions = [{ type: 'agent', npub: 'npub1testagent', actor_id: 'actor-testagent', label: 'Test Agent' }];
    const task = mapPgTaskToLocal({ id: 'task-1', title: 'Task', description: '@[Test Agent](mention:agent:npub1testagent)', metadata: { mentions } });
    const comment = mapPgTaskCommentToLocal({ id: 'comment-1', task_id: 'task-1', body: '@[Test Agent](mention:agent:npub1testagent)', metadata: { mentions } });

    expect(task.pg_metadata.mentions).toEqual(mentions);
    expect(comment.pg_metadata.mentions).toEqual(mentions);
  });

  it('uses mention-aware task detail composers in responsive details and comments panes', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const css = fs.readFileSync('src/styles.css', 'utf8');
    expect(html).toContain("mountTaskRichDescriptionEditor($el)");
    expect(html).toContain("handleMentionInput($event.target.closest('.ProseMirror'), $event)");
    expect(html).toContain("initMentionComposer($el, 'task-comment')");
    expect(html).toContain('taskCommentAudioDrafts.length > 0');
    expect(css).toMatch(/@media[^{}]*\(max-width:[^)]+\)[\s\S]*\.task-detail-body\s*\{[\s\S]*grid-template-columns:\s*1fr/);
    expect(css).toContain('.task-comment-composer');
  });
});
