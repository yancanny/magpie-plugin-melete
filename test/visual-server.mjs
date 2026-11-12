// A separate synthetic UI QA service, never the installed user-data service.
import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{startServer}from'../lib/server.mjs';import{HistoryScope}from'../lib/history.mjs';import{fixtures,rawResult}from'./fixtures.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'melete-visual-'));const range=await fixtures(path.join(root,'history'));
const app=await startServer({port:3499,dataDir:path.join(root,'data'),writeBootstrap:false,agents:()=>[{id:'dsh',available:true,version:'QA only'},{id:'codex',available:true,version:'QA only'}],scopeFactory:o=>new HistoryScope({...o,root:path.join(root,'history')}),runners:{dsh:async({scope})=>{await new Promise(r=>setTimeout(r,2500));return{text:JSON.stringify(rawResult(scope)),runtime:'synthetic-ui-qa'};}}});
await fs.writeFile('/tmp/melete-visual-access.json',JSON.stringify({port:app.port,token:app.token,range}),{mode:0o600});console.log('Synthetic UI QA service ready.');
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>app.close().then(()=>process.exit(0)));
