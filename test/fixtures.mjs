import fs from 'node:fs/promises';
import path from 'node:path';
export async function fixtures(root,source='dsh') {
  const now=Date.now();
  for(let n=1;n<=2;n++) {
    const dir=path.join(root,source==='dsh'?`project/session-${n}`:'sessions/2026/11/12');await fs.mkdir(dir,{recursive:true});
    const id='fixture-'+n,u=`请先核对 SOURCE_MARKER_${n} 的出处，再给我解释。`,a=`我会先核对 SOURCE_MARKER_${n} 的出处，再区分事实和推测。`;
    const rows=source==='dsh'?[{type:'session',version:4,id,createdAt:now-60000,cwd:'/tmp/fictitious-work',delegationDepth:0,isSeeded:false},{type:'user/message',seq:1,time:now-50000,data:{source:{kind:'user'},content:[{type:'text',text:u}]}},{type:'assistant/message',seq:2,time:now-49000,data:{message:{content:[{type:'text',text:a}]}}}]:[{type:'session_meta',timestamp:new Date(now-60000).toISOString(),payload:{id,cwd:'/tmp/fictitious-work'}},{type:'response_item',timestamp:new Date(now-50000).toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:u}]}},{type:'response_item',timestamp:new Date(now-49000).toISOString(),payload:{type:'message',role:'assistant',content:[{type:'output_text',text:a}]}}];
    await fs.writeFile(path.join(dir,source==='dsh'?'session.v4.jsonl':`rollout-${n}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  return {since:now-120000,until:now};
}
export function rawResult(scope) {
  scope.list();const s=scope.read({sessionId:'fixture-1'});const e=s.items[0];
  return {title:'先核对，再解释',prelude:'你在两段记录里都先问了出处。',scope:'虚构验证材料',mirrors:[{title:'先问出处',body:'你先让 AI 核对资料，再解释。这个顺序在两段记录里重复出现。',dimension:'H2.2 求证',evidence:[{sessionId:s.sessionId,seq:e.seq,quote:e.text}],readings:[{by:'you',text:'可能你想先确定来源。'},{by:'thing',text:'也可能这类任务恰好需要来源。'}]}],ai_side:{mirrors:[],note_to_ai:''},society:[],question:'下次还会先问出处吗？',experiments:[{try:'没有意图时此项必须被移除'}],coda:'记录停在下一次核对之前。',share:{headline:'我先问了出处',lines:['先找来处','再看解释','把判断留给自己']}};
}
