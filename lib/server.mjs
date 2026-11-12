import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HistoryScope} from './history.mjs';
import {DATA,initData,atomic,listReviews,getReview,deleteReview,settings,exportHtml} from './store.mjs';
import {probeAgents,runDsh,runCodex} from './runtime.mjs';
import {buildPrompt,parseReview} from './review.mjs';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const same=(a,b)=>typeof a==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const errorCodes=new Set(['agent-not-installed','agent-authentication','agent-model-unavailable','agent-run-failed','agent-timeout','agent-process-closed','cancelled','invalid-agent-output','no-verified-evidence','empty-agent-output','no-history']);
function abortable(promise, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('cancelled'));
    if(signal.aborted){promise.catch(()=>{});return abort();}
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export async function startServer({port=3497,dataDir=DATA,writeBootstrap=true,runners={dsh:runDsh,codex:runCodex},scopeFactory=o=>new HistoryScope(o),agents=probeAgents,jobTimeoutMs=8*60*1000}={}) {
  await initData(dataDir);const gate=crypto.randomBytes(32).toString('hex'),token=crypto.randomBytes(32).toString('hex');const jobs=new Map();let active=null,generation=0;
  const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const body=async(req,max=32768)=>{let b='';for await(const chunk of req){b+=chunk;if(b.length>max)throw new Error('body-too-large');}return b?JSON.parse(b):{};};
  const publicJob=j=>({id:j.id,source:j.source,state:j.state,stage:j.stage,createdAt:j.createdAt,updatedAt:j.updatedAt,reviewId:j.reviewId,error:j.error,readSessions:j.readSessions||0});
  const persist=j=>{const snapshot=publicJob(j);j.persistQueue=(j.persistQueue||Promise.resolve()).catch(()=>{}).then(()=>atomic(path.join(dataDir,'jobs',j.id+'.json'),snapshot));return j.persistQueue;};
  const stage=(j,s)=>{j.stage=s;j.updatedAt=Date.now();persist(j).catch(()=>{});};
  async function execute(j,request) {
    const jobGeneration=generation; let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;j.controller.abort();},jobTimeoutMs);timer.unref();
    try{
      stage(j,'discovering');j.scope=scopeFactory({source:j.source,since:request.since,until:request.until,maxSessions:24,onAccess:e=>{if(e.kind==='read'){j.readSessions=j.scope.accessed.size;stage(j,'reviewing');}}});
      await j.scope.prepare?.(j.controller.signal);
      const manifest=j.scope.list();if(!manifest.included)throw new Error('no-history');
      const workdir=path.join(dataDir,'private',j.id);await fs.mkdir(workdir,{recursive:true,mode:0o700});
      stage(j,'connecting');const prompt=buildPrompt({source:j.source,range:j.scope.range,intention:request.intention,language:request.language});
      const result=await abortable(runners[j.source]({scope:j.scope,workdir,prompt,signal:j.controller.signal,onEvent:e=>{if(e.type==='session')j.runtimeSession=e.id;if(e.type==='tool'||e.type==='history-read'){j.readSessions=j.scope.accessed.size;stage(j,'reviewing');}}}),j.controller.signal);
      if(j.controller.signal.aborted||generation!==jobGeneration)throw new Error('cancelled');stage(j,'organizing');
      const review=parseReview(result.text,j.scope,{id:crypto.randomUUID(),source:j.source,createdAt:Date.now(),range:j.scope.range,intention:request.intention,language:request.language,runtime:result.runtime,runtimeSession:result.sessionId,model:result.model||null});
      if(j.controller.signal.aborted||generation!==jobGeneration)throw new Error('cancelled');
      await atomic(path.join(dataDir,'reviews',review.meta.id+'.json'),review);j.reviewId=review.meta.id;j.state='completed';stage(j,'completed');
    }catch(e){j.state=timedOut?'failed':j.controller.signal.aborted?'cancelled':'failed';j.error=timedOut?'agent-timeout':errorCodes.has(e.message)?e.message:'agent-run-failed';stage(j,j.state);}
    finally{clearTimeout(timer);if(active===j)active=null;await persist(j);}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const actualPort=server.address()?.port;const host=req.headers.host;
      if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(host))return reply(res,421,{error:'invalid-host'});
      const origin=req.headers.origin;const own=[`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`];
      if(origin&&origin!=='null'&&!own.includes(origin))return reply(res,403,{error:'invalid-origin'});
      const url=new URL(req.url,'http://127.0.0.1');
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
      if(req.method==='OPTIONS'){
        if(!url.pathname.startsWith('/api/'))return reply(res,403,{error:'forbidden'});
        res.writeHead(204,{'Access-Control-Allow-Origin':origin||'null','Access-Control-Allow-Methods':'GET,POST,DELETE','Access-Control-Allow-Headers':'content-type,x-melete-token','Access-Control-Max-Age':'600','Vary':'Origin'});return res.end();
      }
      if(url.pathname==='/open'&&req.method==='GET'){
        if(origin||!same(url.searchParams.get('key'),gate))return reply(res,403,{error:'forbidden'});
        const theme=['light','dark'].includes(url.searchParams.get('theme'))?url.searchParams.get('theme'):'auto';
        const lang=url.searchParams.get('lang')==='en'?'en':'zh';
        res.writeHead(302,{'Location':`/app#token=${token}&theme=${theme}&lang=${lang}`,'Cache-Control':'no-store'});return res.end();
      }
      if(req.method==='GET'&&['/app','/ui/app.js','/ui/style.css','/ui/icon.svg'].includes(url.pathname)){
        const name=url.pathname==='/app'?'index.html':path.basename(url.pathname);const files={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8','icon.svg':'image/svg+xml'};
        res.writeHead(200,{'Content-Type':files[name],'Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; script-src http://127.0.0.1:${actualPort} http://localhost:${actualPort}; style-src http://127.0.0.1:${actualPort} http://localhost:${actualPort}; img-src data: blob: http://127.0.0.1:${actualPort}; connect-src http://127.0.0.1:${actualPort} http://localhost:${actualPort}; sandbox allow-scripts; frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://wails.localhost:* wails://localhost wails:; base-uri 'none'; form-action 'none'`});return res.end(await fs.readFile(path.join(ROOT,'ui',name)));
      }
      if(!url.pathname.startsWith('/api/')||!same(req.headers['x-melete-token'],token))return reply(res,403,{error:'unauthorized'});
      if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
      if(url.pathname==='/api/state'&&req.method==='GET')return reply(res,200,{version:'0.1.0',agents:agents(),settings:await settings(null,dataDir),reviews:await listReviews(dataDir),job:active?publicJob(active):null});
      if(url.pathname==='/api/settings'&&req.method==='POST')return reply(res,200,await settings(await body(req),dataDir));
      if(url.pathname==='/api/exports/open'&&req.method==='POST'){
        const folder=path.join(dataDir,'exports');const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
        await new Promise((resolve,reject)=>execFile(command,[folder],error=>error?reject(error):resolve()));return reply(res,200,{ok:true});
      }
      if(url.pathname==='/api/review'&&req.method==='GET')return reply(res,200,await getReview(url.searchParams.get('id'),dataDir));
      if(url.pathname==='/api/review'&&req.method==='DELETE'){await deleteReview(url.searchParams.get('id'),dataDir);return reply(res,200,{ok:true});}
      if(url.pathname==='/api/jobs'&&req.method==='POST'){
        if(active)return reply(res,200,publicJob(active));const b=await body(req);if(!['dsh','codex'].includes(b.source))return reply(res,400,{error:'invalid-source'});
        if(!agents().some(a=>a.id===b.source&&a.available))return reply(res,400,{error:'agent-not-installed'});
        const now=Date.now(),until=Math.min(Number(b.until)||now,now),since=Number(b.since)||0;
        if(!Number.isFinite(since)||since<0||since>until)return reply(res,400,{error:'invalid-range'});
        const j={id:crypto.randomUUID(),source:b.source,state:'running',stage:'connecting',createdAt:now,updatedAt:now,controller:new AbortController()};jobs.set(j.id,j);active=j;await persist(j);reply(res,202,publicJob(j));
        j.done=new Promise(resolve=>setImmediate(resolve)).then(()=>execute(j,{since,until,intention:typeof b.intention==='string'?b.intention.slice(0,4000):'',language:b.language==='en'?'en':'zh'}));j.done.catch(()=>{});return;
      }
      if(url.pathname==='/api/job'&&req.method==='GET'){
        const id=url.searchParams.get('id');if(!/^[a-f0-9-]{36}$/.test(id||''))return reply(res,400,{error:'invalid-id'});
        const j=jobs.get(id);if(j)return reply(res,200,publicJob(j));
        const saved=JSON.parse(await fs.readFile(path.join(dataDir,'jobs',id+'.json'),'utf8'));if(saved.state==='running'){saved.state='interrupted';saved.stage='interrupted';}return reply(res,200,saved);
      }
      if(url.pathname==='/api/cancel'&&req.method==='POST'){const b=await body(req);const j=jobs.get(b.id);if(j?.state==='running'){j.controller.abort();j.state='cancelled';stage(j,'cancelled');}return reply(res,200,{ok:true});}
      if(url.pathname==='/api/export'&&req.method==='GET'){
        const r=await getReview(url.searchParams.get('id'),dataDir),html=exportHtml(r),file=`Melete-${new Date(r.meta.createdAt).toISOString().slice(0,10)}-${r.meta.id.slice(0,8)}.html`;
        await fs.writeFile(path.join(dataDir,'exports',file),html,{mode:0o600});return reply(res,200,{filename:file,html});
      }
      if(url.pathname==='/api/export/png'&&req.method==='POST'){
        const b=await body(req,12_000_000);await getReview(b.id,dataDir);const data=Buffer.from(b.png||'','base64');
        if(data.length>8_000_000||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return reply(res,400,{error:'invalid-image'});
        const file=`Melete-${b.id.slice(0,8)}.png`;await fs.writeFile(path.join(dataDir,'exports',file),data,{mode:0o600});return reply(res,200,{filename:file,saved:true});
      }
      if(url.pathname==='/api/context'&&req.method==='POST'){
        const b=await body(req),r=await getReview(b.id,dataDir);const all=[...r.mirrors,...r.ai_side.mirrors,...r.society,...Object.values(r.tooling||{}).filter(Boolean)];
        if(!all.some(m=>m.evidence.some(e=>e.verified&&e.sessionId===b.sessionId&&e.seq===b.seq)))return reply(res,403,{error:'evidence-outside-review'});
        const scope=scopeFactory({source:r.meta.source,...r.meta.range});return reply(res,200,{items:scope.context(b.sessionId,b.seq)});
      }
      if(url.pathname==='/api/data/clear'&&req.method==='POST'){
        const b=await body(req);if(b.confirm!=='DELETE_MELETE_MAGPIE')return reply(res,400,{error:'confirmation-required'});generation++;active?.controller.abort();
        // Keep active private runtime files until its process has terminated.
        for(const d of ['reviews','exports']){await fs.rm(path.join(dataDir,d),{recursive:true,force:true});await fs.mkdir(path.join(dataDir,d),{mode:0o700});}return reply(res,200,{ok:true});
      }
      return reply(res,404,{error:'not-found'});
    }catch(e){return reply(res,e.code==='ENOENT'?404:400,{error:e.code==='ENOENT'?'not-found':'request-failed'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const actualPort=server.address().port;
  if(writeBootstrap)await fs.writeFile(path.join(ROOT,'page/session.js'),`globalThis.MeleteSession=${JSON.stringify({port:actualPort,key:gate})};\n`,{mode:0o600});
  return {server,port:actualPort,gate,token,close:async()=>{generation++;for(const j of jobs.values())j.controller.abort();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...jobs.values()].map(j=>j.done));}};
}
