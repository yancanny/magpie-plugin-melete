import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

export const roots = () => ({ dsh: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions'), codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
export function redact(s) {
  return String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[邮箱]')
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '[密钥]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[电话]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|password)["'\s:=]+)[^\s,}\]]{8,}/gi, '$1[密钥]');
}
const textOf = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(x => x?.text || x?.output || '').join('\n') : '';
const stamp = v => typeof v === 'number' ? v : Date.parse(v);
function decode(buf, compressed) {
  if (!compressed) return buf.toString('utf8');
  // DSH writes concatenated zstd frames. Do not silently accept partial frames.
  {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const starts = [];
    for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i);
    let pending = Buffer.alloc(0), output = '';
    for (let i = 0; i < starts.length; i++) {
      pending = Buffer.concat([pending, buf.subarray(starts[i], starts[i + 1] ?? buf.length)]);
      try { output += zstdDecompressSync(pending, {maxOutputLength: 128 * 1024 * 1024}).toString('utf8'); pending = Buffer.alloc(0); } catch {}
      if (output.length > 128 * 1024 * 1024) throw new Error('history-too-large');
    }
    if (pending.length || !starts.length) throw new Error('history-unreadable');
    return output;
  }
}
function readLines(file, limit = null) {
  const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) throw new Error('history-too-large');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const b = Buffer.alloc(Math.min(st.size, limit ?? st.size)); fs.readSync(fd, b, 0, b.length, 0); return decode(b, file.endsWith('.zstd')).split('\n'); }
  finally { fs.closeSync(fd); }
}
export function parseHistory(file, source, range) {
  const lines = readLines(file); const events = []; let header = null, partial = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { partial = true; continue; }
    if (i === 0) {
      header = source === 'dsh' ? o : o.payload;
      if (source === 'dsh' && (o.type !== 'session' || ![0, 4].includes(o.version))) throw new Error('unsupported-history-version');
      if (source === 'codex' && o.type !== 'session_meta') throw new Error('unsupported-history-version');
    }
    const time = stamp(source === 'dsh' ? o.time : o.timestamp);
    if (!Number.isFinite(time) || time < range.since || time > range.until) continue;
    const d = o.data || o.payload || {}; let who, text;
    if (source === 'dsh') {
      if (o.type === 'user/message' && (d.source?.kind === 'user' || (!d.source && d.role === 'user'))) { who = 'user'; text = textOf(d.content); }
      if (o.type === 'assistant/message') { who = 'assistant'; text = textOf(d.message?.content); }
      if (o.type === 'tool/call') { who = 'tool'; text = `工具调用：${d.name || '?'} ${typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments || {})}`; }
      if (o.type === 'tool/result') { who = 'tool'; text = textOf(d.message?.content) || String(d.error || ''); }
    } else if (o.type === 'response_item') {
      if (d.type === 'message' && ['user', 'assistant'].includes(d.role)) { who = d.role; text = textOf(d.content); }
      if (['function_call', 'custom_tool_call'].includes(d.type)) { who = 'tool'; text = `工具调用：${d.name || '?'} ${d.arguments || d.input || ''}`; }
      if (['function_call_output', 'custom_tool_call_output'].includes(d.type)) { who = 'tool'; text = textOf(d.output); }
    } else if (source === 'codex' && o.type === 'event_msg' && d.type === 'user_message') { who = 'user'; text = d.message; }
    if (!text || !who) continue;
    // Runtime instructions and review tasks are not the user's daily collaboration.
    if (who === 'user' && /^(<environment_context>|<user_instructions>|# AGENTS\.md|\[MELETE_REVIEW_TASK\])/.test(text.trim())) continue;
    const clean = redact(text); if (!clean.trim()) continue;
    const prev = events.at(-1); if (prev?.who === who && prev.text === clean) continue;
    events.push({seq: source === 'dsh' ? Number(o.seq) || i : i + 1, time, who, text: clean.slice(0, 6000), clipped: clean.length > 6000});
  }
  if (!header?.id) throw new Error('missing-session-id');
  if (String(header.cwd || '').includes(`${path.sep}.melete${path.sep}`) || String(header.cwd || '').includes('melete-magpie-private')) return null;
  return {id: String(header.id), project: path.basename(header.cwd || '') || '未命名项目', file, partial, events};
}
function walk(dir, depth, out) {
  if (depth < 0 || !fs.existsSync(dir) || out.length > 6000) return;
  for (const f of fs.readdirSync(dir, {withFileTypes: true})) {
    if (f.isSymbolicLink()) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, depth - 1, out);
    else if (f.isFile() && /(?:session(?:\.v\d+)?\.jsonl(?:\.zstd)?|rollout-.*\.jsonl)$/.test(f.name)) out.push(p);
  }
}
export class HistoryScope {
  constructor({source, root = roots()[source], since = 0, until = Date.now(), maxSessions = 24, onAccess = () => {}}) {
    if (!['dsh', 'codex'].includes(source) || !Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error('invalid-history-scope');
    this.source = source; this.root = root; this.range = {since, until}; this.maxSessions = maxSessions; this.onAccess = onAccess; this.sessions = null; this.accessed = new Set(); this.readSeqs = new Map(); this.skipped = 0;
  }
  *scan() {
    const files = []; if (this.source === 'dsh') walk(this.root, 2, files); else for (const d of ['sessions', 'archived_sessions']) walk(path.join(this.root, d), 4, files);
    // Retain only the newest 24 sessions, including while scanning a large archive.
    const selected = new Map(), seen = new Map();
    for (const file of files) {
      try {
        if (fs.statSync(file).mtimeMs >= this.range.since) {
          const s = parseHistory(file, this.source, this.range);
          if (s?.events.some(e => e.who === 'user') && (seen.get(s.id) ?? -1) < s.events.length) {
            seen.set(s.id, s.events.length); selected.set(s.id, s);
            if (selected.size > this.maxSessions) {
              const oldest = [...selected.values()].sort((a,b) => a.events.at(-1).time - b.events.at(-1).time)[0]; selected.delete(oldest.id);
            }
          }
        }
      } catch { this.skipped++; }
      yield;
    }
    this.total = seen.size; this.sessions = [...selected.values()].sort((a,b) => b.events.at(-1).time - a.events.at(-1).time);
    this.manifest = this.sessions.map(s => ({id:s.id, project:s.project, first:s.events[0].time, last:s.events.at(-1).time, messages:s.events.length, partial:s.partial}));
  }
  load() { if (!this.sessions) for (const _ of this.scan()) {} }
  async prepare(signal) {
    if (this.sessions) return;
    for (const _ of this.scan()) {
      if (signal?.aborted) throw new Error('cancelled');
      await new Promise(resolve => setImmediate(resolve));
    }
    if (signal?.aborted) throw new Error('cancelled');
  }
  list() { this.load(); this.onAccess({kind:'list', total:this.total, selected:this.sessions.length, skipped:this.skipped}); return {source:this.source, range:this.range, total:this.total, included:this.sessions.length, capped:this.total > this.sessions.length, unreadable:this.skipped, messages:this.sessions.reduce((n,s)=>n+s.events.length,0), readMessages:[...this.readSeqs.values()].reduce((n,s)=>n+s.size,0), clippedMessages:this.sessions.reduce((n,s)=>n+s.events.filter(e=>e.clipped).length,0), sessions:this.manifest}; }
  recordRead(sessionId, seqs) { this.accessed.add(sessionId);if(!this.readSeqs.has(sessionId))this.readSeqs.set(sessionId,new Set());for(const seq of seqs)this.readSeqs.get(sessionId).add(seq); }
  read({sessionId, offset = 0, limit = 24}) {
    this.load(); const s = this.sessions.find(s => s.id === sessionId); if (!s) throw new Error('session-outside-scope');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('invalid-history-page');
    let size = 0; const items = [];
    for (const e of s.events.slice(offset, offset + limit)) { if (size + e.text.length > 24000 && items.length) break; items.push(e); size += e.text.length; }
    this.recordRead(s.id,items.map(e=>e.seq)); this.onAccess({kind:'read', sessionId:s.id, count:items.length, seqs:items.map(e=>e.seq)});
    return {sessionId:s.id, project:s.project, items, nextOffset:offset + items.length < s.events.length ? offset + items.length : null, total:s.events.length, partial:s.partial};
  }
  evidence({sessionId, seq, quote}) {
    this.load(); const s = this.sessions.find(s => s.id === sessionId); const e = s?.events.find(e => e.seq === seq);
    const norm = t => String(t || '').replace(/\s+/g,'').replace(/[“”「」]/g,'');
    const q = redact(quote).slice(0,1200); const verified = !!e && q.length >= 2 && norm(e.text).includes(norm(q));
    return {sessionId:String(sessionId || ''), seq:Number(seq), quote:q, verified, ...(verified ? {who:e.who,time:e.time,project:s.project} : {})};
  }
  context(sessionId, seq) { this.load(); const s=this.sessions.find(s=>s.id===sessionId); const i=s?.events.findIndex(e=>e.seq===seq) ?? -1; return i<0 ? null : s.events.slice(Math.max(0,i-2),i+3); }
}

export const historyTools = [
  {name:'melete_history_list', description:'列出本次复盘允许读取的本 Agent 历史范围。必须先调用，再按会话读取；不要猜测未返回的内容。', inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'melete_history_read', description:'只读一段本次范围内的源历史，保留 sessionId、seq 和时间作为出处。nextOffset 非空表示还有下一页。', inputSchema:{type:'object',properties:{sessionId:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['sessionId'],additionalProperties:false}}
];
export function callHistory(scope, name, args) { if (name === 'melete_history_list') return scope.list(); if (name === 'melete_history_read') return scope.read(args); throw new Error('tool-not-allowed'); }
