import template from './settings-dialog.html?raw';
import './settings-dialog.css';

// Both the Deck and Canvas Link flow use the same access/name dialog.
export function mountCanvasSettingsDialog(storeName = 'chat') {
  const host = document.querySelector('[data-canvas-settings-host]');
  if (host) host.outerHTML = template.replaceAll('$store.chat', `$store.${storeName}`);
}
