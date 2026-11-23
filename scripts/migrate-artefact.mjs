#!/usr/bin/env bun
import { writeFile, access } from 'node:fs/promises';
import { migrationSource, importMigration } from './artefact-migration.mjs';
import { brokerSigner, towerClient } from './html-artifact/tower.mjs';
const options = {};
for (let i=2;i<process.argv.length;i++) { const key=process.argv[i].replace(/^--/,''); options[key]=['dry-run','audience-verified','legacy-navigation-reviewed'].includes(key)?true:process.argv[++i]; }
try {
  const source = await migrationSource({ folder: options.folder, type: options.type, sourceUrl: options['source-url'], sourceVersion: options['source-version'], title: options.title, legacyNavigationReviewed: options['legacy-navigation-reviewed'] === true });
  const preview = { title: source.title, type: source.type, bytes: source.bytes.length, archive_bytes: source.archive.length, assets: source.assets.length, provenance: source.provenance, source_files: source.manifest };
  if (options['dry-run']) console.log(JSON.stringify(preview,null,2));
  else {
    if (!options.workspace || !options.channel || !options.receipt) throw Error('--workspace, --channel and --receipt are required. Use an ignored receipt path.');
    try { await access(options.receipt); throw Error('Receipt already exists; inspect it before choosing a new receipt path.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const client=towerClient({baseUrl:options.tower||process.env.WINGMAN_TOWER_URL,workspaceId:options.workspace,sign:brokerSigner()});
    const result=await importMigration(client,options.workspace,options.channel,source,{audienceVerified:options['audience-verified']===true});
    await writeFile(options.receipt,JSON.stringify(result,null,2),{flag:'wx'});
    console.log(JSON.stringify(result,null,2));
  }
} catch(error) { console.error(error.message); process.exitCode=1; }
