import { normalizeFeed } from '../feed/normalize.js';
self.onmessage = ({ data }) => { try { self.postMessage({ id: data.id, result: normalizeFeed(data.text, data.format, data.privateSource) }); } catch (e) { self.postMessage({ id: data.id, error: e.message }); } };
