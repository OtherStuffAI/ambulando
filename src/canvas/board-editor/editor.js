import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptureUpdateAction, Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { BOARD_APP_STATE_DEFAULTS, boardSceneFingerprint } from '../board-scene.js';

const CHANGE_DELAY_MS = 250;
const root = () => document.getElementById('board-root');

// Observable editor state for diagnostics and browser tests (no content).
function reportCounts(elements, files) {
  const node = root();
  if (!node) return;
  node.dataset.boardElementCount = String((elements || []).filter(element => !element.isDeleted).length);
  node.dataset.boardFileCount = String(Object.keys(files || {}).length);
}
const SAFE_LINK = /^https?:\/\//i;

function sceneElements(scene) {
  return restoreElements(scene?.elements || [], null, { refreshDimensions: false, repairBindings: false });
}

function BoardEditor({ port, theme }) {
  const apiRef = useRef(null);
  const state = useRef({ key: '', readOnly: true, fingerprint: '', sentFiles: new Set(), interacted: false, timer: 0, pending: null });
  const [readOnly, setReadOnly] = useState(true);
  const [ready, setReady] = useState(false);

  const applyScene = useCallback((scene, { reset }) => {
    const api = apiRef.current;
    if (!api || !scene) return;
    const files = Object.values(scene.files || {});
    if (files.length) api.addFiles(files);
    for (const file of files) state.current.sentFiles.add(file.id);
    api.updateScene({
      elements: sceneElements(scene),
      ...(reset ? { appState: { ...BOARD_APP_STATE_DEFAULTS, ...(scene.appState || {}) } } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (reset) { api.history.clear(); api.scrollToContent?.(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, animate: false }); }
    state.current.fingerprint = boardSceneFingerprint(scene);
    state.current.interacted = false;
    reportCounts(api.getSceneElementsIncludingDeleted(), api.getFiles());
  }, []);

  const flush = useCallback(() => {
    const current = state.current;
    current.timer = 0;
    const pending = current.pending; current.pending = null;
    if (!pending || current.readOnly || !current.interacted) return;
    const scene = { type: 'excalidraw', version: 2, elements: pending.elements, appState: pending.appState, files: {} };
    const fingerprint = boardSceneFingerprint({ ...scene, files: pending.files });
    if (fingerprint === current.fingerprint) return;
    current.fingerprint = fingerprint;
    for (const [id, file] of Object.entries(pending.files || {})) {
      if (current.sentFiles.has(id)) continue;
      current.sentFiles.add(id);
      scene.files[id] = { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created, lastRetrieved: file.lastRetrieved };
    }
    port.postMessage({ type: 'change', scene });
  }, [port]);

  useEffect(() => {
    // Messages queue on the port until Excalidraw's API exists.
    if (!ready) return undefined;
    port.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'load') {
        const reset = message.key !== state.current.key;
        state.current.key = message.key;
        state.current.readOnly = message.readOnly === true;
        setReadOnly(state.current.readOnly);
        applyScene(message.scene, { reset });
        root().dataset.boardKey = message.key;
        root().dataset.boardReadonly = String(state.current.readOnly);
      } else if (message.type === 'flush') {
        // Save requested: deliver the debounced change first (port order is preserved).
        clearTimeout(state.current.timer);
        flush();
        port.postMessage({ type: 'flushed', token: message.token });
      } else if (message.type === 'patch') {
        applyScene(message.scene, { reset: false });
      } else if (message.type === 'clear') {
        state.current.readOnly = true; setReadOnly(true);
        apiRef.current?.resetScene();
        reportCounts([], {});
      }
    };
    port.postMessage({ type: 'ready' });
    return () => { port.onmessage = null; };
  }, [port, applyScene, ready, flush]);

  useEffect(() => {
    // Only user input makes a draft. Excalidraw's own load-time normalisation
    // (font metrics, bindings) must not mark a freshly loaded board unsaved.
    const mark = () => { state.current.interacted = true; };
    const events = ['pointerdown', 'keydown', 'paste', 'drop', 'wheel'];
    // A finished stroke or keystroke is delivered at once (after Excalidraw's
    // render), so navigating away right after drawing cannot lose it.
    const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (state.current.pending) { clearTimeout(state.current.timer); flush(); } }));
    for (const name of events) addEventListener(name, mark, { capture: true });
    addEventListener('pointerup', settle, { capture: true });
    addEventListener('keyup', settle, { capture: true });
    return () => {
      for (const name of events) removeEventListener(name, mark, { capture: true });
      removeEventListener('pointerup', settle, { capture: true });
      removeEventListener('keyup', settle, { capture: true });
    };
  }, [flush]);


  const onChange = useCallback((elements, appState, files) => {
    const current = state.current;
    reportCounts(elements, files);
    if (current.readOnly) return;
    current.pending = {
      elements: elements.map(element => ({ ...element })),
      appState: { viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize, gridStep: appState.gridStep, gridModeEnabled: appState.gridModeEnabled },
      files,
    };
    if (!current.timer) current.timer = setTimeout(flush, CHANGE_DELAY_MS);
  }, [flush]);

  return createElement('div', { style: { width: '100%', height: '100%' }, 'data-board-ready': ready ? 'true' : 'false', 'data-board-readonly': readOnly ? 'true' : 'false' },
    createElement(Excalidraw, {
      excalidrawAPI: api => { apiRef.current = api; setReady(Boolean(api)); },
      onChange,
      theme,
      viewModeEnabled: readOnly,
      // Board content is data: never load third-party embeds or navigate this frame.
      validateEmbeddable: () => false,
      onLinkOpen: (element, event) => {
        event.preventDefault();
        const link = String(element?.link || '');
        if (SAFE_LINK.test(link)) window.open(link, '_blank', 'noopener,noreferrer');
      },
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, clearCanvas: true, export: { saveFileToDisk: true }, toggleTheme: false } },
    }));
}

export function mountBoardEditor(root, port, { theme = 'light' } = {}) {
  root.dataset.boardEditorState = 'ready';
  createRoot(root).render(createElement(BoardEditor, { port, theme }));
}
