import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageTrackerBundle } from '../src/napplets/tracker-bundle.js';
const root=new URL('../public/napplets/daily-tracker/v1/',import.meta.url);
const [html,style,model,app]=await Promise.all(['index.html','style.css','model.js','app.js'].map(name=>readFile(new URL(name,root),'utf8')));
const output=process.argv[2];if(!output)throw new Error('Usage: bun scripts/package-daily-tracker.mjs <output.html>');
const result=packageTrackerBundle({html,style,model,app});await writeFile(resolve(output),result);
console.log(JSON.stringify({path:resolve(output),bytes:Buffer.byteLength(result),sha256:createHash('sha256').update(result).digest('hex')}));
