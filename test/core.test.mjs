import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {zstdCompressSync}from'node:zlib';
import {HistoryScope,parseHistory,redact} from '../lib/history.mjs';import {parseReview}from'../lib/review.mjs';import{exportHtml}from'../lib/store.mjs';import{fixtures,rawResult}from'./fixtures.mjs';
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'melete-unit-'));
test('range, source scope, paging, and exact evidence',async()=>{const root=await temp();try{const range=await fixtures(root);const s=new HistoryScope({source:'dsh',root,...range});assert.equal(s.list().total,2);assert.throws(()=>s.read({sessionId:'../other'}),/scope/);assert.throws(()=>s.read({sessionId:'fixture-1',offset:-1}),/page/);const page=s.read({sessionId:'fixture-1',limit:1});assert.equal(page.nextOffset,1);assert.equal(s.list().readMessages,1);assert.equal(s.evidence({sessionId:'fixture-1',seq:1,quote:page.items[0].text}).verified,true);assert.equal(s.evidence({sessionId:'fixture-2',seq:1,quote:page.items[0].text}).verified,false);assert.equal(new HistoryScope({source:'dsh',root,since:range.until+1,until:range.until+1000}).list().total,0);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('concatenated DSH zstd frames preserve events',async()=>{const root=await temp();try{const range=await fixtures(root);const p=path.join(root,'project/session-1/session.v4.jsonl'),lines=(await fs.readFile(p,'utf8')).trim().split('\n');const compressed=Buffer.concat(lines.map(l=>zstdCompressSync(Buffer.from(l+'\n'))));await fs.writeFile(p+'.zstd',compressed);const s=parseHistory(p+'.zstd','dsh',range);assert.equal(s.events.length,2);await fs.writeFile(p+'.zstd',compressed.subarray(0,compressed.length-5));assert.throws(()=>parseHistory(p+'.zstd','dsh',range));}finally{await fs.rm(root,{recursive:true,force:true});}});
test('Codex response item history remains in its own source',async()=>{const root=await temp();try{const range=await fixtures(root,'codex');const s=new HistoryScope({source:'codex',root,...range});assert.equal(s.list().total,2);assert.equal(s.read({sessionId:'fixture-2'}).items[0].seq,2);assert.equal(new HistoryScope({source:'dsh',root,...range}).list().total,0);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('symlink history is not followed',async()=>{const root=await temp(),other=await temp();try{const range=await fixtures(other);await fs.symlink(path.join(other,'project'),path.join(root,'linked'));assert.equal(new HistoryScope({source:'dsh',root,...range}).list().total,0);}finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(other,{recursive:true,force:true});}});
test('normalization requires actually read and verified evidence, and no intention means no experiments',async()=>{const root=await temp();try{const range=await fixtures(root);const s=new HistoryScope({source:'dsh',root,...range});const raw=rawResult(s),meta={id:'example',source:'dsh',createdAt:Date.now(),range,intention:'',language:'zh'};const r=parseReview(JSON.stringify(raw),s,meta);assert.equal(r.mirrors.length,1);assert.deepEqual(r.experiments,[]);assert.equal(r.meta.partial,true);const html=exportHtml(r);assert(!html.includes('fixture-1'));assert(!html.includes('/tmp/fictitious'));assert(!html.includes('sessionId'));raw.mirrors[0].evidence[0].quote='根本没有出现的句子';assert.throws(()=>parseReview(JSON.stringify(raw),s,meta),/verified/);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('secrets and markup remain safe in local export',()=>{assert(!redact('sk-abcdefghijklmnopqrstuvwxyz123456').includes('abcdefghijklmnopqrstuvwxyz'));assert(!redact('a@b.com 13800138000').includes('a@b.com'));const html=exportHtml({title:'<script>alert(1)</script>',meta:{language:'zh',createdAt:Date.now(),source:'dsh'},mirrors:[],society:[],question:'<img src=x>',ai_side:{mirrors:[]}});assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));});
test('async history preparation preserves the cap and can be cancelled',async()=>{
  const root=await temp();try{
    const range=await fixtures(root);const scope=new HistoryScope({source:'dsh',root,...range,maxSessions:1});await scope.prepare();const coverage=scope.list();assert.equal(coverage.total,2);assert.equal(coverage.included,1);assert.equal(coverage.capped,true);
    const controller=new AbortController();controller.abort();const cancelled=new HistoryScope({source:'dsh',root,...range});await assert.rejects(cancelled.prepare(controller.signal),/cancelled/);assert.equal(cancelled.sessions,null);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('compressed history rejects every incomplete frame and preserves split UTF-8', async () => {
  const root=await temp(); try {
    const range=await fixtures(root); const file=path.join(root,'project/session-1/session.v4.jsonl');
    const original=await fs.readFile(file); const marker=Buffer.from('请'); const cut=original.indexOf(marker)+1;
    assert(cut > 0); const first=zstdCompressSync(original.subarray(0,cut)); const second=zstdCompressSync(original.subarray(cut));
    await fs.writeFile(file+'.zstd',Buffer.concat([first,second]));
    assert.equal(parseHistory(file+'.zstd','dsh',range).events.length,2);
    for(let end=1;end<first.length;end++) {
      await fs.writeFile(file+'.zstd',first.subarray(0,end));
      assert.throws(()=>parseHistory(file+'.zstd','dsh',range));
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
