// Same-origin Excalidraw editor surface for one board naplet. It owns no
// network or storage: the Canvas page's board controller sends scenes over a
// MessagePort and receives changes back. Fonts are self-hosted (no CDN).
window.EXCALIDRAW_ASSET_PATH = `${location.origin}/excalidraw-assets/`;

const root = document.getElementById('board-root');

function connect(event) {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type !== 'wingman-board:connect' || !event.ports?.[0]) return;
  removeEventListener('message', connect);
  const port = event.ports[0];
  import('./editor.js')
    .then(({ mountBoardEditor }) => mountBoardEditor(root, port, { theme: event.data.theme === 'dark' ? 'dark' : 'light' }))
    .catch(error => {
      root.dataset.boardEditorState = 'error';
      root.textContent = 'The board editor could not be loaded. Refresh the canvas.';
      port.postMessage({ type: 'error', message: String(error?.message || error) });
    });
}

addEventListener('message', connect);
root.dataset.boardEditorState = 'waiting';
