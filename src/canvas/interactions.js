import { toRaw } from '../utils/state-helpers.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

// Canvas layout, element data, and undo history are JSON contracts. Alpine wraps
// each of them in reactive proxies after a snapshot enters the store, and browser
// structured-clone consumers reject those proxies. Take one explicit plain-value
// copy at the Canvas interaction boundary before retaining or transporting them.
export function cloneCanvasValue(value) {
  return toRaw(value);
}

export function canvasWheelIntent(event) {
  return event.ctrlKey || event.metaKey ? 'zoom' : 'pan';
}

export function zoomViewport(viewport, factor, origin, rect = { left: 0, top: 0 }) {
  const previous = viewport.scale;
  const scale = clamp(previous * factor, 0.2, 3);
  const px = origin.clientX - rect.left;
  const py = origin.clientY - rect.top;
  return {
    x: px - ((px - viewport.x) / previous) * scale,
    y: py - ((py - viewport.y) / previous) * scale,
    scale,
  };
}

export function worldPoint(viewport, point, rect = { left: 0, top: 0 }) {
  return {
    x: (point.clientX - rect.left - viewport.x) / viewport.scale,
    y: (point.clientY - rect.top - viewport.y) / viewport.scale,
  };
}
