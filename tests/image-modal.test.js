/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Dynamic import so the module sees the jsdom globals
let initImageModal, openImageModal, closeImageModal, isImageModalOpen;

beforeEach(async () => {
  // Re-import fresh module each run to reset module-level state
  vi.resetModules();
  const mod = await import('../src/image-modal.js');
  initImageModal = mod.initImageModal;
  openImageModal = mod.openImageModal;
  closeImageModal = mod.closeImageModal;
  isImageModalOpen = mod.isImageModalOpen;
});

describe('image-modal', () => {
  let cleanup;

  beforeEach(() => {
    document.body.innerHTML = '';
    cleanup = initImageModal();
  });

  afterEach(() => {
    if (cleanup) cleanup();
    document.body.innerHTML = '';
  });

  it('initImageModal appends the overlay element to body', () => {
    const overlay = document.getElementById('image-preview-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });

  it('openImageModal shows overlay with the given image src', () => {
    openImageModal('https://example.com/photo.png', 'A photo');
    const overlay = document.getElementById('image-preview-overlay');
    const img = overlay.querySelector('img');
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(img.src).toBe('https://example.com/photo.png');
    expect(img.alt).toBe('A photo');
    expect(isImageModalOpen()).toBe(true);
  });

  it('closeImageModal hides the overlay', () => {
    openImageModal('https://example.com/photo.png', 'A photo');
    closeImageModal();
    const overlay = document.getElementById('image-preview-overlay');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(isImageModalOpen()).toBe(false);
  });

  it('clicking the overlay backdrop closes the modal', () => {
    openImageModal('https://example.com/photo.png', 'A photo');
    const overlay = document.getElementById('image-preview-overlay');
    overlay.click();
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });

  it('pressing Escape closes the modal', () => {
    openImageModal('https://example.com/photo.png', 'A photo');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isImageModalOpen()).toBe(false);
  });

  it('Escape does nothing when modal is already closed', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isImageModalOpen()).toBe(false);
  });

  it('clicking an md-storage-image inside the document opens the modal', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span class="md-storage-image-wrap"><img class="md-storage-image" src="https://example.com/abc.png" alt="test image" /></span>';
    document.body.appendChild(container);

    const img = container.querySelector('img');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const overlay = document.getElementById('image-preview-overlay');
    const previewImg = overlay.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('https://example.com/abc.png');
    expect(previewImg.alt).toBe('test image');
  });

  it('does not open modal for images without md-storage-image class', () => {
    const container = document.createElement('div');
    container.innerHTML = '<img class="other-image" src="https://example.com/x.png" alt="other" />';
    document.body.appendChild(container);

    const img = container.querySelector('img');
    img.click();

    expect(isImageModalOpen()).toBe(false);
  });

  it('does not open modal for pending storage images', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span class="md-storage-image-wrap"><img class="md-storage-image md-storage-image-pending" data-storage-object-id="img-1" alt="loading" /></span>';
    document.body.appendChild(container);

    const img = container.querySelector('img');
    img.click();

    expect(isImageModalOpen()).toBe(false);
  });

  it('does not open modal for errored storage images', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span class="md-storage-image-wrap"><img class="md-storage-image md-storage-image-error" alt="error" /></span>';
    document.body.appendChild(container);

    const img = container.querySelector('img');
    img.click();

    expect(isImageModalOpen()).toBe(false);
  });

  it('cleanup removes the overlay and listeners', () => {
    cleanup();
    cleanup = null;
    const overlay = document.getElementById('image-preview-overlay');
    expect(overlay).toBeNull();
  });

  // ---- chat feed and thread reply contexts --------------------------------

  it('clicking an image inside a chat feed message opens the modal', () => {
    const feed = document.createElement('div');
    feed.className = 'chat-feed';
    feed.setAttribute('data-chat-feed', '');
    feed.innerHTML = `
      <div class="chat-post" data-message-id="msg-1">
        <div class="chat-post-content">
          <div class="chat-post-markdown">
            <span class="md-storage-image-wrap">
              <img class="md-storage-image" src="https://example.com/chat-photo.png" alt="chat image" />
            </span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(feed);

    const img = feed.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const previewImg = document.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('https://example.com/chat-photo.png');
    expect(previewImg.alt).toBe('chat image');
  });

  it('clicking an image inside a thread parent message opens the modal', () => {
    const threadPanel = document.createElement('div');
    threadPanel.className = 'thread-replies';
    threadPanel.setAttribute('data-thread-replies', '');
    threadPanel.innerHTML = `
      <div class="thread-message" data-thread-message-id="msg-parent">
        <div class="thread-msg-body">
          <div class="thread-msg-text">
            <div class="chat-post-markdown">
              <span class="md-storage-image-wrap">
                <img class="md-storage-image" src="https://example.com/thread-parent.png" alt="thread parent image" />
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(threadPanel);

    const img = threadPanel.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const previewImg = document.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('https://example.com/thread-parent.png');
    expect(previewImg.alt).toBe('thread parent image');
  });

  it('clicking an image inside a thread reply opens the modal', () => {
    const threadPanel = document.createElement('div');
    threadPanel.className = 'thread-replies';
    threadPanel.setAttribute('data-thread-replies', '');
    threadPanel.innerHTML = `
      <div class="thread-message" data-thread-message-id="msg-reply-1">
        <div class="thread-msg-body">
          <div class="thread-msg-text">
            <div class="chat-post-markdown">
              <span class="md-storage-image-wrap">
                <img class="md-storage-image" src="https://example.com/reply-photo.png" alt="reply image" />
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(threadPanel);

    const img = threadPanel.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const previewImg = document.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('https://example.com/reply-photo.png');
    expect(previewImg.alt).toBe('reply image');
  });

  it('pending storage image inside chat feed does not open modal', () => {
    const feed = document.createElement('div');
    feed.className = 'chat-feed';
    feed.setAttribute('data-chat-feed', '');
    feed.innerHTML = `
      <div class="chat-post" data-message-id="msg-2">
        <div class="chat-post-content">
          <div class="chat-post-markdown">
            <span class="md-storage-image-wrap">
              <img class="md-storage-image md-storage-image-pending" data-storage-object-id="img-pending" alt="loading" />
            </span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(feed);

    const img = feed.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(false);
  });

  it('storage image in chat feed opens modal after hydration resolves src', () => {
    const feed = document.createElement('div');
    feed.className = 'chat-feed';
    feed.setAttribute('data-chat-feed', '');
    feed.innerHTML = `
      <div class="chat-post" data-message-id="msg-3">
        <div class="chat-post-content">
          <div class="chat-post-markdown">
            <span class="md-storage-image-wrap">
              <img class="md-storage-image" data-storage-object-id="img-hydrated" data-storage-resolved="true" src="blob:http://localhost/fake-uuid" alt="hydrated" />
            </span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(feed);

    const img = feed.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const previewImg = document.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('blob:http://localhost/fake-uuid');
    expect(previewImg.alt).toBe('hydrated');
  });

  it('remote image in a thread reply opens modal', () => {
    const threadPanel = document.createElement('div');
    threadPanel.className = 'thread-replies';
    threadPanel.setAttribute('data-thread-replies', '');
    threadPanel.innerHTML = `
      <div class="thread-message" data-thread-message-id="msg-reply-2">
        <div class="thread-msg-body">
          <div class="thread-msg-text">
            <div class="chat-post-markdown">
              <span class="md-storage-image-wrap">
                <img class="md-storage-image" src="https://cdn.example.com/remote-pic.jpg" alt="remote in thread" />
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(threadPanel);

    const img = threadPanel.querySelector('img.md-storage-image');
    img.click();

    expect(isImageModalOpen()).toBe(true);
    const previewImg = document.querySelector('.image-preview-img');
    expect(previewImg.src).toBe('https://cdn.example.com/remote-pic.jpg');
    expect(previewImg.alt).toBe('remote in thread');
  });

  it('opens only the lightbox when an image inside a feed card is clicked', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain(`@click="$event.target.closest('a, button, img.md-storage-image') || $store.chat.openThread(msg.record_id)"`);

    const card = document.createElement('div');
    const openThread = vi.fn();
    card.innerHTML = '<span class="md-storage-image-wrap"><img class="md-storage-image" src="https://cdn.example.com/feed.png" alt="feed"></span>';
    card.addEventListener('click', (event) => event.target.closest('a, button, img.md-storage-image') || openThread());
    document.body.appendChild(card);

    card.querySelector('img').click();
    expect(isImageModalOpen()).toBe(true);
    expect(openThread).not.toHaveBeenCalled();
  });
});
