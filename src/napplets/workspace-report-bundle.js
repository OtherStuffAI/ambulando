export function packageWorkspaceReport({html,style,model,app}) {
  return html.replace('<link rel="stylesheet" href="style.css">',()=>`<style>${style}</style>`).replace('<script src="model.js"></script>',()=>`<script>${model.replace(/<\/script/gi,'<\\/script')}</script>`).replace('<script src="app.js"></script>',()=>`<script>${app.replace(/<\/script/gi,'<\\/script')}</script>`);
}
export async function loadWorkspaceReport({signal}={}) {
  const build=typeof __APP_BUILD_ID__==='undefined'?'source':__APP_BUILD_ID__;
  const parts=await Promise.all(['index.html','style.css','model.js','app.js'].map(async name=>{const r=await fetch(`/napplets/workspace-report/v1/${name}?build=${encodeURIComponent(build)}`,{cache:'no-cache',signal});if(!r.ok)throw Error('Workspace Report template unavailable.');return r.text();}));
  return packageWorkspaceReport({html:parts[0],style:parts[1],model:parts[2],app:parts[3]});
}
