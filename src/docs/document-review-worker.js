import { reviewDocumentChanges } from './three-way-merge.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ result: reviewDocumentChanges(data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
