// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { prepareCanvasChatDom } from '../src/canvas/chat-embed.js';

it('removes unobserved shell branches before Alpine mounts while retaining ordinary composer and detail templates',()=>{
  const root=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html');
  prepareCanvasChatDom(root);
  expect(root.querySelector('.sidebar')).toBeNull();
  expect(root.querySelector('.page-header')).toBeNull();
  expect(root.querySelector('.global-pg-channel-bar')).toBeNull();
  expect(root.querySelector('.wapp-management-editor-backdrop, .personal-wapp-editor-backdrop, .wapp-publishing-editor-backdrop')).toBeNull();
  const templates=[...root.querySelector('.content-scroll-area').children].filter(node=>node.tagName==='TEMPLATE');
  expect(templates).toHaveLength(3);
  const chat=templates.find(node=>node.content.querySelector('.chat-thread-modal-backdrop'));
  expect(chat.content.querySelector('[data-chat-composer="thread"]')).not.toBeNull();
  expect(chat.content.querySelector('.chat-section').children).toHaveLength(1);
  expect(templates.some(node=>node.getAttribute('x-if').includes('chatTaskModalOpen'))).toBe(true);
  expect(templates.some(node=>node.getAttribute('x-if').includes('chatDocModalOpen'))).toBe(true);
});
