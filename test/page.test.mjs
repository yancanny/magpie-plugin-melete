import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {startServer} from '../lib/server.mjs';
import os from 'node:os';
import path from 'node:path';

test('page declares no bridge reads and has no external resources', async () => {
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.deepEqual(pkg.magpie.permissions, []);
  assert.equal(pkg.magpie.page.file,'page/index.html');
  const html=await fs.readFile(new URL('../page/index.html',import.meta.url),'utf8');
  const boot=await fs.readFile(new URL('../page/boot.js',import.meta.url),'utf8');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { assert.match(script[1], /\bsrc=/); assert.equal(script[2].trim(), ''); }
  assert(!/(?:src|href)\s*=\s*["']https?:/i.test(html));
  assert(!/\b(?:fetch|XMLHttpRequest|WebSocket|magpie\.read)\s*\(/.test(boot));
});

test('local service protects navigation and API access', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'melete-page-')); let app;
  try {
    app=await startServer({port:0,dataDir:root,writeBootstrap:false,agents:()=>[]});
    const base=`http://127.0.0.1:${app.port}`;
    assert.equal((await fetch(base+'/open?key=wrong',{redirect:'manual'})).status,403);
    assert.equal((await fetch(base+'/open?key='+app.gate,{headers:{origin:'https://example.invalid'},redirect:'manual'})).status,403);
    assert.equal((await fetch(base+'/api/state')).status,403);
    assert.equal((await fetch(base+'/api/state',{headers:{'x-melete-token':app.token}})).status,200);
    const page=await fetch(base+'/app');
    assert.match(page.headers.get('content-security-policy'),/sandbox allow-scripts/);
  } finally { if(app) await app.close(); await fs.rm(root,{recursive:true,force:true}); }
});
