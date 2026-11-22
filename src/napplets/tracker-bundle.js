// Produces the same self-contained NStack HTML File on browser and native hosts.
export function packageTrackerBundle({html,style,model,app}) {
  return html.replace('<link rel="stylesheet" href="style.css">',()=>`<style>${style}</style>`)
    .replace('<script src="model.js"></script>',()=>`<script>${model.replace(/<\/script/gi,'<\\/script')}</script>`)
    .replace('<script src="app.js"></script>',()=>`<script>${app.replace(/<\/script/gi,'<\\/script')}</script>`);
}
export async function loadTrackerBundle() {
  const revision=typeof __APP_BUILD_ID__ === 'undefined' ? 'source' : __APP_BUILD_ID__;
  const names=['index.html','style.css','model.js','app.js'];
  const parts=await Promise.all(names.map(async name=>{const r=await fetch(`/napplets/daily-tracker/v1/${name}?build=${encodeURIComponent(revision)}`,{cache:'no-cache'});if(!r.ok)throw new Error('Daily tracker template unavailable.');return r.text();}));
  return packageTrackerBundle({html:parts[0],style:parts[1],model:parts[2],app:parts[3]});
}
