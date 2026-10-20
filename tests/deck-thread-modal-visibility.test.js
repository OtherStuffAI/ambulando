import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const INDEX_PATH = resolve(process.cwd(), 'index.html');

function findThreadModalTemplate() {
  const document = new JSDOM(readFileSync(INDEX_PATH, 'utf8')).window.document;
  return Array.from(document.querySelectorAll('template')).find((template) => (
    template.content.querySelector('.chat-thread-modal-backdrop')
  ));
}

describe('Deck thread modal rendered visibility', () => {
  it('keeps the active thread modal outside the Chat-only hidden layout', () => {
    const template = findThreadModalTemplate();
    const modal = template?.content.querySelector('.chat-thread-modal-backdrop');
    const chatLayout = template?.content.querySelector('.chat-layout');

    expect(template?.getAttribute('x-if')).toContain("$store.chat.navSection === 'status' && ($store.chat.activeThreadId || $store.chat.deckThreadComposerOpen)");
    expect(chatLayout?.getAttribute('x-show')).toBe("$store.chat.navSection === 'chat'");
    expect(modal?.getAttribute('x-show')).toBe('$store.chat.deckThreadComposerOpen || ($store.chat.activeThreadId && $store.chat.threadLocalDetailReady)');
    expect(chatLayout?.contains(modal)).toBe(false);
    expect(modal?.parentElement).toBe(template?.content.querySelector('.chat-section'));
  });
});
