const { test, expect } = require('playwright/test');
const { buildSync } = require('esbuild');
const path = require('node:path');
const bundle = buildSync({ entryPoints:[path.join(__dirname,'fixtures/scope-chat-browser.js')],
  bundle:true, write:false, format:'iife', globalName:'ScopeChatHarness', platform:'browser',
  define:{ 'import.meta.env':'{}', '__FLIGHT_DECK_PG_APP_NPUB__':JSON.stringify('npub1scopefixture') },
  logLevel:'silent',
}).outputFiles[0].text;

for (const channelCount of [1, 10, 30]) test(`persisted IndexedDB scope reader parity and read reduction: ${channelCount} channels`, async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['localhost','127.0.0.1'].includes(url.hostname)) return route.abort();
    return url.pathname === '/scope-reader.js'
      ? route.fulfill({ contentType:'text/javascript',body:bundle })
      : route.fulfill({ contentType:'text/html',body:'<!doctype html><html><body><script src="/scope-reader.js"></script></body></html>' });
  });
  await page.goto('/scope-reader');
  const result = await page.evaluate(async count => {
    const h = window.ScopeChatHarness;
    const db = h.openWorkspaceDb(`scope-browser-${count}`); await db.open();
    const { channels, rows } = h.scopeChatFixture(count);
    await db.chat_messages.bulkPut(rows);
    const metrics = h.instrumentIndexedDb();
    const options = { rootLimit:21 };
    const ids = values => values.map(row=>row.record_id).join(',');
    const oldRead = async () => h.buildThreadAwarePresentationWindow(
      (await Promise.all(channels.map(id=>h.getMessagePresentationWindowByChannel(id,options)))).flat(),options);
    const measurements = { channelCount:count,fixtureRows:rows.length,before:[],after:[] };
    let expected;
    try {
      for (let i=0;i<5;i++) {
        for (const [name,read] of [['before',oldRead],['after',()=>h.getMessagePresentationWindowByChannels(channels,options)]]) {
          metrics.reset(); const at = performance.now();
          const values = await read();
          measurements[name].push({ ms:performance.now()-at,...metrics.snapshot().byStore.chat_messages });
          if (expected === undefined) expected = ids(values);
          if (ids(values) !== expected) throw new Error('old/new presentation IDs differ');
        }
      }
      // Concurrent reader requests must retain their own channel set.
      const results = await Promise.all([channels,channels.slice(0,1),channels]
        .map(selected=>h.getMessagePresentationWindowByChannels(selected,options)));
      if (ids(results[0])!==expected || ids(results[2])!==expected
        || !results[1].every(row=>row.channel_id===channels[0])) throw new Error('concurrent reader isolation failed');
    } finally { metrics.restore(); }
    // Verify the two-phase reader retains Dexie's live dependency on the
    // indexed root boundary, including roots newer than every cached candidate.
    await new Promise((resolve,reject)=>{
      let inserted=false,subscription;
      const timer=setTimeout(()=>{subscription?.unsubscribe();reject(new Error('new indexed root not observed'));},5000);
      subscription=h.liveQuery(()=>h.getMessagePresentationWindowByChannels(channels,options)).subscribe({
        async next(values) {
          if(values.some(row=>row.record_id==='incoming-root')) {clearTimeout(timer);subscription.unsubscribe();resolve();return;}
          if(!inserted) {inserted=true;await db.chat_messages.put({record_id:'incoming-root',channel_id:channels[0],updated_at:'2026-10-23T12:00:00.000Z'});}
        },error:reject,
      });
    });
    const summarize = values => {const sorted=values.sort((a,b)=>a-b);return {p50:sorted[2],p95:sorted[4]};};
    measurements.beforeMs=summarize(measurements.before.map(row=>row.ms));
    measurements.afterMs=summarize(measurements.after.map(row=>row.ms));
    db.close();
    return measurements;
  }, channelCount);
  expect(result.after[0].valueRowsRead).toBeLessThanOrEqual(result.before[0].valueRowsRead);
  if(channelCount>1) expect(result.after[0].valueRowsRead).toBeLessThan(result.before[0].valueRowsRead/2);
  console.info('SCOPE_CHAT_READER_PERF',JSON.stringify(result));
  await test.info().attach('scope-reader-measurements.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});
