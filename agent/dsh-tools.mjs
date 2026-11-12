import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {HistoryScope, historyTools, callHistory} from '../lib/history.mjs';

export const name = 'melete-readonly-history';
export const inject = ['tools'];
export async function apply(ctx) {
  const {defineTool} = await import(pathToFileURL(process.env.MELETE_DSH_TOOLS).href);
  const job = JSON.parse(fs.readFileSync(process.env.MELETE_JOB_FILE, 'utf8'));
  const scope = new HistoryScope({...job.history, onAccess:entry => fs.appendFileSync(job.audit, JSON.stringify(entry)+'\n', {mode:0o600})});
  for (const t of historyTools) {
    const properties = Object.fromEntries(Object.entries(t.inputSchema.properties).map(([key,value]) => [key,{...value,...(t.inputSchema.required?.includes(key)?{required:true}:{})}]));
    ctx.tools.register(defineTool({name:t.name,description:t.description,parameters:properties,output:{schema:{type:'string'},render:(_args,v)=>[{type:'text',text:v}]},execute:async args=>JSON.stringify(callHistory(scope,t.name,args))}));
  }
  // Only these two tools can execute; no shell, writes, network or delegation.
  const allowed = new Set(historyTools.map(t=>t.name));
  if (ctx.tools.definitions().some(t => !allowed.has(t.name))) throw new Error('Unexpected tool in Melete read-only runtime');
  ctx.provide('meleteHistoryReady', true);
}
