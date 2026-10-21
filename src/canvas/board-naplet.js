// Connects one same-origin board editor iframe to its board controller over a
// private MessageChannel. The iframe stays in the DOM when the naplet window is
// promoted to full screen (showModal), so inline and full-screen editing share
// one Excalidraw instance and one draft.
export function registerCanvasBoard(Alpine, { controllerFor }) {
  Alpine.directive('canvas-board', (iframe, { expression }, { evaluateLater, effect, cleanup }) => {
    const evaluate = evaluateLater(expression);
    let naplet = null, controller = null, port = null;

    const disconnect = () => {
      if (controller && naplet) controller.detach(naplet.id);
      controller = null;
      if (port) { port.onmessage = null; port.close(); port = null; }
    };

    const connect = () => {
      disconnect();
      if (!naplet?.source?.id || !iframe.contentWindow) return;
      controller = controllerFor(naplet.source.id);
      if (!controller) return;
      const channel = new MessageChannel();
      port = channel.port1;
      const napletId = naplet.id, owner = controller;
      port.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'ready') { iframe.dataset.boardConnected = 'true'; owner.attach(napletId, payload => port?.postMessage(payload)); }
        else if (message.type === 'change' && message.scene) void owner.editorChanged(napletId, message.scene);
        else if (message.type === 'flushed') owner.editorFlushed(napletId, message.token);
        else if (message.type === 'error') iframe.dataset.boardError = String(message.message || 'error');
      };
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      iframe.contentWindow.postMessage({ type: 'wingman-board:connect', theme }, location.origin, [channel.port2]);
    };

    const onLoad = () => connect();
    iframe.addEventListener('load', onLoad);
    // A naplet's board never changes; the editor accepts one connection per load.
    effect(() => evaluate(value => { naplet = value && typeof value === 'object' ? value : null; }));
    cleanup(() => { iframe.removeEventListener('load', onLoad); disconnect(); });
  });
}
