import { toRaw } from '../utils/state-helpers.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

// Interaction geometry below is adapted from the current BYO Freedom Canvas
// and its Plan Space extraction. Keep it host-agnostic: Tower persistence and
// Alpine rendering belong to the page adapter, not to pointer mathematics.
export function canvasItemKey(type, id) {
  return `${type}:${id}`;
}

export function selectionRect(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

export function enclosedItemKeys(items, box) {
  if (box.right - box.left < 3 || box.bottom - box.top < 3) return [];
  return items
    .filter(item => item.left >= box.left && item.top >= box.top && item.right <= box.right && item.bottom <= box.bottom)
    .map(item => item.key);
}

export function movementItems(items, selectedKeys) {
  const keys = new Set(selectedKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (!keys.has(item.key) || item.type !== 'element' || item.item.data?.role !== 'group') continue;
      for (const member of item.item.data.members || []) {
        if (!keys.has(member)) { keys.add(member); changed = true; }
      }
    }
  }
  return items.filter(item => keys.has(item.key)).map(item => ({
    ...item,
    before: cloneCanvasValue(item.item.layout),
  }));
}

export function groupDelta(items, x, y, limit = 50000) {
  return {
    x: Math.max(...items.map(item => -limit - item.before.x), Math.min(x, ...items.map(item => limit - item.before.x))),
    y: Math.max(...items.map(item => -limit - item.before.y), Math.min(y, ...items.map(item => limit - item.before.y))),
  };
}

export function groupBounds(items, padding = 32) {
  return {
    x: Math.min(...items.map(item => item.layout.x)) - padding,
    y: Math.min(...items.map(item => item.layout.y)) - padding,
    width: Math.max(...items.map(item => item.layout.x + item.layout.width)) - Math.min(...items.map(item => item.layout.x)) + padding * 2,
    height: Math.max(...items.map(item => item.layout.y + item.layout.height)) - Math.min(...items.map(item => item.layout.y)) + padding * 2,
  };
}

export function arrowGeometry(start, end, minimum = 8) {
  const left = Math.min(start.x, end.x), top = Math.min(start.y, end.y);
  const width = Math.max(minimum, Math.abs(end.x - start.x)), height = Math.max(minimum, Math.abs(end.y - start.y));
  return {
    layout: { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) },
    data: {
      start: [Math.round(start.x - left), Math.round(start.y - top)],
      end: [Math.round(end.x - left), Math.round(end.y - top)],
    },
  };
}

export function moveArrowEndpoint(layout, data, endpoint, point) {
  const otherName = endpoint === 'start' ? 'end' : 'start';
  const own = { x: point.x, y: point.y };
  const stored = Array.isArray(data?.[otherName]) ? data[otherName] : (otherName === 'start' ? [0, layout.height] : [layout.width, 0]);
  const other = { x: layout.x + stored[0], y: layout.y + stored[1] };
  const geometry = endpoint === 'start' ? arrowGeometry(own, other) : arrowGeometry(other, own);
  return { layout: { ...layout, ...geometry.layout }, data: { ...data, ...geometry.data } };
}

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
