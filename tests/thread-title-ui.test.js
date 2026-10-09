import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('thread title UI', () => {
  it('offers rename from the channel root message menu through root eligibility', () => {
    expect(html).toContain('x-show="$store.chat.canRenameThreadTitle(msg)"');
    expect(html).toContain('@click.stop.prevent="$store.chat.startThreadTitleEdit(msg.record_id)"');
    expect(html).not.toContain('$store.chat.startThreadTitleEdit(reply.record_id)');
  });

  it('edits the displayed thread title in place with accessible controls', () => {
    const header = html.slice(html.indexOf('<div class="thread-header">'), html.indexOf('<div class="thread-replies"'));
    expect(header).toContain('class="thread-title-display"');
    expect(header).toContain('@click="$store.chat.startThreadTitleEdit()"');
    expect(header).toContain('class="thread-title-editor"');
    expect(header).toContain('x-effect="$store.chat.threadTitleEditing && $nextTick');
    expect(header).toContain('@keydown.escape.prevent="$store.chat.cancelThreadTitleEdit()"');
    expect(header).toContain('role="alert"');
    expect(html.match(/class="thread-title-editor"/g)).toHaveLength(1);
  });

  it('links every thread message menu and the thread header to the latest thread session', () => {
    const header = html.slice(html.indexOf('<div class="thread-header">'), html.indexOf('<div class="thread-replies"'));
    expect(header).toContain('x-show="$store.chat.hasThreadAutopilotSessionLink()"');
    expect(header).toContain('@click.stop.prevent="$store.chat.openThreadAutopilotSession()"');
    expect(html).toContain('x-show="$store.chat.hasThreadAutopilotSessionLink(msg)"');
    expect(html).toContain('x-show="$store.chat.hasThreadAutopilotSessionLink($store.chat.getThreadParentMessage())"');
    expect(html).toContain('x-show="$store.chat.hasThreadAutopilotSessionLink(reply)"');
    expect(html.match(/>Autopilot Link<\/button>/g)).toHaveLength(4);
  });

  it('offers the full root-message action set from the thread header in product order', () => {
    const header = html.slice(html.indexOf('<div class="thread-header">'), html.indexOf('<div class="thread-replies"'));
    const menu = header.slice(header.indexOf('<div class="thread-title-menu-popover"'), header.indexOf('</div>', header.indexOf('<div class="thread-title-menu-popover"')));
    const labels = [
      'Get it done',
      'Rename thread',
      'Copy message',
      'Autopilot Link',
      'FD Ref',
      'Archive thread',
      'Delete message',
    ];

    for (const label of labels) expect(menu).toContain(label);
    for (let index = 1; index < labels.length; index += 1) {
      expect(menu.indexOf(labels[index])).toBeGreaterThan(menu.indexOf(labels[index - 1]));
    }
    expect(menu).toContain('data-source-surface="thread_header"');
    expect(menu).toContain(':data-record-id="$store.chat.getThreadParentMessage()?.record_id || \'\'"');
    expect(menu).toContain("copyMessageRawText($store.chat.getThreadParentMessage()?.record_id)");
    expect(menu).toContain("buildChatMessageFlightDeckReferenceId($store.chat.getThreadParentMessage()?.record_id)");
    expect(menu).toContain("archiveChatThreadByParentId($store.chat.getThreadParentMessage()?.record_id, true)");
    expect(menu).toContain("archiveChatThreadByParentId($store.chat.getThreadParentMessage()?.record_id, false)");
    expect(menu).toContain("openChatDeleteConfirm('message', $store.chat.getThreadParentMessage()?.record_id)");
    expect(menu).toContain("x-text=\"$store.chat.isChatThreadArchiveSubmitting($store.chat.getThreadParentMessage()?.record_id, 'unarchive') ? 'Unarchiving...' : 'Unarchive thread'\"");
  });

  it('pairs the title menu semantic surface and foreground in both themes', () => {
    const popoverRule = css.match(/\.thread-title-menu-popover\s*\{[\s\S]*?\}/)?.[0] || '';
    const buttonRule = css.match(/\.thread-title-menu-popover button\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(popoverRule).toContain('background: var(--card);');
    expect(popoverRule).toContain('color: var(--foreground);');
    expect(buttonRule).toContain('color: var(--foreground);');
    expect(css).toMatch(/\.thread-title-menu-popover \.chat-msg-actions-danger\s*\{[\s\S]*?color:\s*var\(--destructive\);/);
  });
});
