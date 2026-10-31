// A dedicated, short-lived worker keeps rich-tree/sequence reconciliation off
// the input thread. No content leaves the browser.
export async function reviewDocumentInWorker(input) {
  if (typeof Worker === 'undefined') {
    const { reviewDocumentChanges } = await import('./three-way-merge.js');
    return reviewDocumentChanges(input);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-review-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('Review took too long. Your draft is preserved; retry review.')), 15000);
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = () => finish(new Error('Review is unavailable. Your draft is preserved; retry review.'));
    worker.postMessage(JSON.parse(JSON.stringify(input)));
  });
}
