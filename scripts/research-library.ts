#!/usr/bin/env tsx
/**
 * Sage Research Library — local web UI for browsing deep-dives + monitor.
 * Usage: pnpm run research
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import readline from 'readline';
import type { IncomingMessage, ServerResponse } from 'http';

// ─── Config ────────────────────────────────────────────────────────────────
const SAGE_GROUP_ID = 'ag-1781833560826-hi0vjd';
const DATA_DIR = path.join(process.cwd(), 'data');
const SAGE_DIR = path.join(process.cwd(), 'groups', 'dm-with-ran');
const RESEARCH_DIR = path.join(SAGE_DIR, 'research');
const COVERAGE_LOG = path.join(SAGE_DIR, 'coverage-log.md');
const FOLLOW_UPS = path.join(SAGE_DIR, 'follow-ups.md');
const TAGS_FILE = path.join(RESEARCH_DIR, '.tags.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions', SAGE_GROUP_ID, '.claude-shared', 'projects');
const PORT = Number(process.env.RESEARCH_PORT) || 3030;

// ─── Types ──────────────────────────────────────────────────────────────────
interface Entry {
  date: string;
  title: string;
  slug: string;
  gist: string;
  tags: string[];
}

interface AgentStatus {
  agentId: string;
  subject: string;
  status: 'done' | 'running' | 'pending';
  resultPreview: string;
}

interface WorkflowRun {
  wfId: string;
  projectDir: string;
  sessionUuid: string;
  journalPath: string;
  mtime: Date;
  totalAgents: number;
  doneAgents: number;
  agents: AgentStatus[];
  topic: string;
  isRunning: boolean;
}

interface MonitorSnapshot {
  current: WorkflowRun | null;
  history: WorkflowRun[];
}

// ─── Tags ────────────────────────────────────────────────────────────────────
function readTags(): Record<string, string[]> {
  if (!fs.existsSync(TAGS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8')); } catch { return {}; }
}

function writeTags(tags: Record<string, string[]>): void {
  fs.mkdirSync(path.dirname(TAGS_FILE), { recursive: true });
  fs.writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2));
}

// ─── Coverage log ─────────────────────────────────────────────────────────
function parseCoverageLog(): Omit<Entry, 'tags'>[] {
  if (!fs.existsSync(COVERAGE_LOG)) return [];
  return fs
    .readFileSync(COVERAGE_LOG, 'utf-8')
    .split('\n')
    .filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l.trim()))
    .map((line) => {
      const parts = line.split('·').map((p) => p.trim());
      if (parts.length < 3) return null;
      const [date, title, filePath, ...gistParts] = parts;
      const slug = filePath.replace(/^research\//, '').replace(/\/deep-dive\.md$/, '').trim();
      return { date, title, slug, gist: gistParts.join(' · ') };
    })
    .filter(Boolean) as Omit<Entry, 'tags'>[];
}

function getEntriesWithTags(): Entry[] {
  const tags = readTags();
  return parseCoverageLog().map((e) => ({ ...e, tags: tags[e.slug] ?? [] }));
}

function getDeepDive(slug: string): string | null {
  const p = path.join(RESEARCH_DIR, slug, 'deep-dive.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function addFollowUp(title: string, note: string): void {
  const line = `- **${title}**${note ? ': ' + note : ''}\n`;
  fs.appendFileSync(FOLLOW_UPS, line);
}

function parseFollowUps(): string[] {
  if (!fs.existsSync(FOLLOW_UPS)) return [];
  return fs
    .readFileSync(FOLLOW_UPS, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').replace(/\*\*/g, '').trim());
}

function writeFollowUps(items: string[]): void {
  const header = fs
    .readFileSync(FOLLOW_UPS, 'utf-8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('-'))
    .join('\n')
    .trimEnd();
  const body = items.map((item) => `- ${item}`).join('\n');
  fs.writeFileSync(FOLLOW_UPS, header + (body ? '\n' + body : '') + '\n');
}

// ─── Monitor ────────────────────────────────────────────────────────────────
async function readFirstLines(filePath: string, n: number): Promise<string[]> {
  if (!fs.existsSync(filePath)) return [];
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length >= n) rl.close();
    });
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(lines));
  });
}

function readJournalSync(journalPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(journalPath)) return [];
  return fs.readFileSync(journalPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as Array<Record<string, unknown>>;
}

async function getAgentSubject(wfDir: string, agentId: string): Promise<string> {
  const agentFile = path.join(wfDir, `agent-${agentId}.jsonl`);
  const lines = await readFirstLines(agentFile, 5);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const content = typeof obj.content === 'string' ? obj.content : '';
      const m = content.match(/Research this specific area: "([^"]+)"/);
      if (m) return m[1];
    } catch { /* skip */ }
  }
  return 'Researching…';
}

function topicForDate(dateStr: string): string {
  if (!fs.existsSync(COVERAGE_LOG)) return '';
  const lines = fs.readFileSync(COVERAGE_LOG, 'utf-8').split('\n');
  for (const line of lines) {
    if (line.startsWith(dateStr)) {
      const parts = line.split('·').map((p) => p.trim());
      if (parts.length >= 2) return parts[1];
    }
  }
  return '';
}

async function buildWorkflowRun(
  projectDir: string,
  sessionUuid: string,
  wfId: string,
): Promise<WorkflowRun | null> {
  const wfDir = path.join(SESSIONS_DIR, projectDir, sessionUuid, 'subagents', 'workflows', wfId);
  const journalPath = path.join(wfDir, 'journal.jsonl');
  if (!fs.existsSync(journalPath)) return null;

  const stat = fs.statSync(journalPath);
  const mtime = stat.mtime;

  const entries = readJournalSync(journalPath);
  const startedIds = entries
    .filter((e) => e.type === 'started')
    .map((e) => String(e.agentId));
  const results = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.type === 'result' && typeof e.agentId === 'string') {
      results.set(e.agentId, (e.result as Record<string, unknown>) ?? {});
    }
  }

  const totalAgents = startedIds.length;
  const doneAgents = results.size;
  const ageMs = Date.now() - mtime.getTime();
  const isRunning = ageMs < 10 * 60 * 1000 && doneAgents < totalAgents;

  const dateStr = mtime.toISOString().slice(0, 10);
  const topic = topicForDate(dateStr);

  const agents: AgentStatus[] = await Promise.all(
    startedIds.map(async (agentId): Promise<AgentStatus> => {
      const resultData = results.get(agentId);
      const done = !!resultData;
      let subject = '';
      let resultPreview = '';
      if (done && resultData) {
        subject = String(resultData.pillar ?? resultData.question ?? '');
        const findings = String(resultData.findings ?? '');
        resultPreview = findings.slice(0, 200).replace(/\n/g, ' ');
      } else {
        subject = await getAgentSubject(wfDir, agentId);
      }
      const status: AgentStatus['status'] = done ? 'done' : isRunning ? 'running' : 'pending';
      return { agentId, subject, status, resultPreview };
    }),
  );

  return { wfId, projectDir, sessionUuid, journalPath, mtime, totalAgents, doneAgents, agents, topic, isRunning };
}

async function getMonitorSnapshot(): Promise<MonitorSnapshot> {
  if (!fs.existsSync(SESSIONS_DIR)) return { current: null, history: [] };

  const runs: WorkflowRun[] = [];

  let projectDirs: string[] = [];
  try { projectDirs = fs.readdirSync(SESSIONS_DIR); } catch { return { current: null, history: [] }; }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(SESSIONS_DIR, projectDir);
    let sessionUuids: string[] = [];
    try { sessionUuids = fs.readdirSync(projectPath); } catch { continue; }

    for (const sessionUuid of sessionUuids) {
      const wfBase = path.join(projectPath, sessionUuid, 'subagents', 'workflows');
      if (!fs.existsSync(wfBase)) continue;
      let wfIds: string[] = [];
      try { wfIds = fs.readdirSync(wfBase); } catch { continue; }

      for (const wfId of wfIds) {
        const run = await buildWorkflowRun(projectDir, sessionUuid, wfId);
        if (run) runs.push(run);
      }
    }
  }

  runs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const current = runs.find((r) => r.isRunning) ?? null;
  const history = runs.filter((r) => !r.isRunning).slice(0, 20);

  return { current, history };
}

// ─── SSE ────────────────────────────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const snapshot = await getMonitorSnapshot();
    const data = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  } catch { /* ignore */ }
}, 3000);

// ─── HTML ────────────────────────────────────────────────────────────────────
const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sage Research Library</title>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d0d; color: #ddd; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* Header / Tabs */
header { padding: 0 20px; border-bottom: 1px solid #1e1e1e; display: flex; align-items: center; gap: 0; flex-shrink: 0; height: 48px; }
header h1 { font-size: 15px; font-weight: 600; color: #fff; letter-spacing: -0.01em; margin-right: 24px; }
.tabs { display: flex; gap: 0; height: 100%; }
.tab-btn { padding: 0 16px; background: transparent; border: none; color: #555; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; height: 100%; transition: color 0.15s; }
.tab-btn:hover { color: #aaa; }
.tab-btn.active { color: #7c9ef8; border-bottom-color: #7c9ef8; }
#lib-count { font-size: 12px; color: #444; margin-left: auto; }

/* Tab panels */
.tab-panel { display: none; flex: 1; overflow: hidden; }
.tab-panel.active { display: flex; flex-direction: column; }
#panel-library { flex-direction: row; }

/* ── Library sidebar ── */
.sidebar { width: 290px; border-right: 1px solid #1e1e1e; display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-controls { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.sidebar-controls input[type=search] { width: 100%; background: #141414; border: 1px solid #222; color: #ddd; border-radius: 6px; padding: 7px 10px; font-size: 12px; outline: none; }
.sidebar-controls input[type=search]:focus { border-color: #7c9ef8; }
.sidebar-controls select { width: 100%; background: #141414; border: 1px solid #222; color: #aaa; border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none; cursor: pointer; }
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 4px; min-height: 0; }
.tag-chip { padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #888; cursor: pointer; transition: all 0.1s; user-select: none; }
.tag-chip:hover { border-color: #7c9ef8; color: #7c9ef8; }
.tag-chip.selected { background: #141420; border-color: #7c9ef8; color: #7c9ef8; }
.list { overflow-y: auto; flex: 1; }
.entry { padding: 11px 14px; border-bottom: 1px solid #141414; cursor: pointer; transition: background 0.1s; }
.entry:hover { background: #111; }
.entry.active { background: #141420; border-left: 2px solid #7c9ef8; padding-left: 12px; }
.entry-title { font-size: 13px; font-weight: 500; color: #e0e0e0; line-height: 1.35; margin-bottom: 2px; }
.entry-date { font-size: 11px; color: #444; margin-bottom: 4px; }
.entry-gist { font-size: 11px; color: #555; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.entry-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
.entry-tag { padding: 1px 6px; border-radius: 10px; font-size: 10px; background: #141420; border: 1px solid #2a2a3e; color: #7c9ef8; }

/* ── Library main ── */
.main { flex: 1; overflow-y: auto; }
.placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #333; font-size: 14px; }
.article { max-width: 740px; margin: 0 auto; padding: 36px 32px 80px; }
.article-top { margin-bottom: 24px; padding-bottom: 18px; border-bottom: 1px solid #1e1e1e; }
.article-title { font-size: 22px; font-weight: 700; color: #fff; line-height: 1.3; margin-bottom: 5px; }
.article-date { font-size: 12px; color: #444; margin-bottom: 14px; }
.article-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.follow-btn { padding: 5px 13px; background: transparent; border: 1px solid #2a2a3e; color: #7c9ef8; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
.follow-btn:hover { background: #141420; }
.follow-btn.done { border-color: #2a3e2a; color: #5a9e5a; cursor: default; }

/* Tag editor */
.tag-editor { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 10px; }
.tag-editor-chip { padding: 3px 8px; border-radius: 12px; font-size: 11px; background: #141420; border: 1px solid #2a2a3e; color: #7c9ef8; display: flex; align-items: center; gap: 4px; }
.tag-editor-chip button { background: none; border: none; color: #556; cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px; }
.tag-editor-chip button:hover { color: #c66; }
.tag-add-input { background: #141414; border: 1px solid #222; color: #ddd; border-radius: 12px; padding: 3px 10px; font-size: 11px; outline: none; width: 110px; }
.tag-add-input:focus { border-color: #7c9ef8; }

/* Markdown */
.content { font-size: 15px; line-height: 1.75; color: #c8c8c8; }
.content h1 { font-size: 20px; color: #fff; margin: 36px 0 12px; }
.content h2 { font-size: 17px; color: #eee; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #1e1e1e; }
.content h3 { font-size: 14px; color: #ddd; margin: 20px 0 8px; font-weight: 600; }
.content p { margin-bottom: 14px; }
.content ul, .content ol { margin: 0 0 14px 22px; }
.content li { margin-bottom: 5px; }
.content strong { color: #fff; }
.content em { color: #999; }
.content a { color: #7c9ef8; text-decoration: none; }
.content a:hover { text-decoration: underline; }
.content blockquote { border-left: 3px solid #2a2a3e; padding-left: 16px; color: #777; margin: 0 0 14px; }
.content code { background: #161616; border: 1px solid #2a2a2a; border-radius: 3px; padding: 2px 5px; font-size: 12px; font-family: 'SF Mono','Menlo',monospace; color: #c8c8c8; }
.content pre { background: #161616; border: 1px solid #2a2a2a; border-radius: 6px; padding: 16px; overflow-x: auto; margin-bottom: 14px; }
.content pre code { background: none; border: none; padding: 0; }
.content hr { border: none; border-top: 1px solid #1e1e1e; margin: 24px 0; }

/* ── Monitor panel ── */
#panel-monitor { flex-direction: column; overflow-y: auto; }
.monitor-inner { max-width: 820px; width: 100%; margin: 0 auto; padding: 28px 32px 60px; display: flex; flex-direction: column; gap: 20px; }
.mon-section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #444; margin-bottom: 10px; }
.mon-card { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 18px 20px; }
.mon-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.status-dot.running { background: #4ade80; box-shadow: 0 0 0 0 rgba(74,222,128,0.4); animation: pulse 1.5s ease-in-out infinite; }
.status-dot.idle { background: #333; }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.4); } 50% { box-shadow: 0 0 0 6px rgba(74,222,128,0); } }
.mon-topic { font-size: 15px; font-weight: 600; color: #e0e0e0; flex: 1; }
.mon-status-badge { font-size: 11px; padding: 3px 9px; border-radius: 10px; font-weight: 600; }
.badge-running { background: #0d2010; border: 1px solid #2a5a2a; color: #4ade80; }
.badge-done { background: #111; border: 1px solid #2a2a2a; color: #555; }
.progress-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.progress-bar-bg { flex: 1; height: 5px; background: #1a1a1a; border-radius: 3px; overflow: hidden; }
.progress-bar-fill { height: 100%; background: #7c9ef8; border-radius: 3px; transition: width 0.5s; }
.progress-label { font-size: 11px; color: #555; flex-shrink: 0; }
.agent-list { display: flex; flex-direction: column; gap: 4px; }
.agent-row { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 6px; overflow: hidden; }
.agent-row-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.agent-icon { width: 18px; text-align: center; font-size: 13px; flex-shrink: 0; }
.agent-id { font-size: 10px; color: #444; font-family: monospace; flex-shrink: 0; }
.agent-subject { font-size: 12px; color: #c8c8c8; flex: 1; }
.agent-expand { font-size: 10px; color: #444; }
.agent-preview { display: none; padding: 8px 12px 10px 38px; font-size: 12px; color: #666; line-height: 1.5; border-top: 1px solid #1a1a1a; }
.agent-row.open .agent-preview { display: block; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #2a2a2a; border-top-color: #7c9ef8; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.idle-card { display: flex; align-items: center; justify-content: center; min-height: 60px; color: #333; font-size: 13px; padding: 12px; text-align: center; }
.queue-list { display: flex; flex-direction: column; gap: 6px; }
.queue-item { display: flex; align-items: flex-start; gap: 10px; background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 10px 12px; }
.queue-item-text { flex: 1; font-size: 13px; color: #ccc; line-height: 1.45; }
.queue-send { flex-shrink: 0; background: #1a2a1a; border: 1px solid #2a4a2a; color: #6dbf6d; font-size: 11px; font-weight: 600; cursor: pointer; padding: 3px 8px; border-radius: 4px; line-height: 1.4; }
.queue-send:hover { background: #223322; border-color: #3a6a3a; }
.queue-send:disabled { opacity: 0.5; cursor: default; }
.queue-remove { flex-shrink: 0; background: none; border: none; color: #444; font-size: 16px; cursor: pointer; padding: 0 2px; line-height: 1; margin-top: -1px; }
.queue-remove:hover { color: #e05555; }
.hist-grid { display: flex; flex-direction: column; gap: 10px; }
.hist-card { background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 14px 16px; cursor: pointer; transition: border-color 0.15s; }
.hist-card:hover { border-color: #2a2a2a; }
.hist-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 0; }
.hist-topic { font-size: 13px; font-weight: 500; color: #d0d0d0; flex: 1; }
.hist-meta { font-size: 11px; color: #444; }
.hist-card .agent-list { margin-top: 12px; border-top: 1px solid #1a1a1a; padding-top: 10px; display: none; }
.hist-card.open .agent-list { display: flex; }

/* Modal */
.modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 50; align-items: center; justify-content: center; }
.modal-bg.open { display: flex; }
.modal { background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 24px; width: 420px; }
.modal h3 { font-size: 15px; color: #fff; margin-bottom: 6px; }
.modal p { font-size: 12px; color: #555; margin-bottom: 16px; }
.modal input { width: 100%; background: #0d0d0d; border: 1px solid #2a2a2a; color: #ddd; border-radius: 6px; padding: 9px 12px; font-size: 14px; outline: none; }
.modal input:focus { border-color: #7c9ef8; }
.modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.modal-btns button { padding: 7px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #2a2a2a; }
.btn-cancel { background: transparent; color: #666; }
.btn-cancel:hover { color: #999; }
.btn-confirm { background: #7c9ef8; color: #0d0d0d; border-color: #7c9ef8; font-weight: 600; }
.btn-confirm:hover { background: #96b2ff; }
</style>
</head>
<body>
<header>
  <h1>Sage</h1>
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('library')">Research Library</button>
    <button class="tab-btn" onclick="switchTab('monitor')">Monitor</button>
  </div>
  <span id="lib-count"></span>
</header>

<!-- ── Library tab ── -->
<div id="panel-library" class="tab-panel active">
  <aside class="sidebar">
    <div class="sidebar-controls">
      <input type="search" id="search-box" placeholder="Search topics…" oninput="renderList()">
      <select id="sort-select" onchange="renderList()">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="az">A – Z</option>
        <option value="za">Z – A</option>
      </select>
      <div class="tag-filter-row" id="tag-filter-row"></div>
    </div>
    <div class="list" id="list"></div>
  </aside>
  <main class="main" id="main">
    <div class="placeholder">Select a topic to read the deep-dive</div>
  </main>
</div>

<!-- ── Monitor tab ── -->
<div id="panel-monitor" class="tab-panel">
  <div class="monitor-inner">
    <div>
      <div class="mon-section-label">Current Run</div>
      <div id="mon-current"><div class="idle-card">No active run</div></div>
    </div>
    <div>
      <div class="mon-section-label">Past Runs</div>
      <div class="hist-grid" id="mon-history"><div style="color:#333;font-size:13px">No past runs found</div></div>
    </div>
    <div>
      <div class="mon-section-label">Follow-up Queue <span id="queue-count" style="color:#444;font-weight:400"></span></div>
      <div id="mon-queue"><div class="idle-card">Queue is empty</div></div>
    </div>
  </div>
</div>

<!-- ── Follow-up modal ── -->
<div class="modal-bg" id="modal">
  <div class="modal">
    <h3>Add to follow-ups</h3>
    <p>Sage will see this on her next run and can pick it up from the follow-ups file.</p>
    <input id="modal-note" type="text" placeholder="Optional note — leave blank to just queue it" />
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="confirmFollowUp()">Add follow-up</button>
    </div>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
let allEntries = [];
let filteredEntries = [];
let currentEntry = null;
let currentTags = [];
let activeTagFilter = null;

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.textContent.toLowerCase().includes(name === 'library' ? 'library' : 'monitor')) b.classList.add('active');
  });
}

// ── Library ────────────────────────────────────────────────────────────────
async function loadLibrary() {
  const res = await fetch('/api/researches');
  allEntries = await res.json();
  renderTagFilterChips();
  renderList();
}

function allTags() {
  const s = new Set();
  allEntries.forEach(e => (e.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

function renderTagFilterChips() {
  const row = document.getElementById('tag-filter-row');
  const tags = allTags();
  if (!tags.length) { row.innerHTML = ''; return; }
  row.innerHTML = tags.map(t => \`<span class="tag-chip\${activeTagFilter===t?' selected':''}" onclick="toggleTagFilter(\${JSON.stringify(t)})">\${esc(t)}</span>\`).join('');
}

function toggleTagFilter(tag) {
  activeTagFilter = activeTagFilter === tag ? null : tag;
  renderTagFilterChips();
  renderList();
}

function renderList() {
  const q = document.getElementById('search-box').value.toLowerCase();
  const sort = document.getElementById('sort-select').value;

  let list = allEntries.filter(e => {
    const matchQ = !q || e.title.toLowerCase().includes(q) || (e.gist||'').toLowerCase().includes(q);
    const matchTag = !activeTagFilter || (e.tags||[]).includes(activeTagFilter);
    return matchQ && matchTag;
  });

  list = [...list].sort((a, b) => {
    if (sort === 'newest') return b.date.localeCompare(a.date);
    if (sort === 'oldest') return a.date.localeCompare(b.date);
    if (sort === 'az') return a.title.localeCompare(b.title);
    if (sort === 'za') return b.title.localeCompare(a.title);
    return 0;
  });

  filteredEntries = list;
  document.getElementById('lib-count').textContent = list.length + ' topics';

  const container = document.getElementById('list');
  container.innerHTML = list.map((e, i) => {
    const isActive = currentEntry && currentEntry.slug === e.slug;
    const tagHtml = (e.tags||[]).length ? \`<div class="entry-tags">\${(e.tags||[]).map(t=>\`<span class="entry-tag">\${esc(t)}</span>\`).join('')}</div>\` : '';
    return \`<div class="entry\${isActive?' active':''}" onclick="openEntry('\${e.slug}')" id="esl-\${i}">
      <div class="entry-title">\${esc(e.title)}</div>
      <div class="entry-date">\${esc(e.date)}</div>
      \${e.gist ? \`<div class="entry-gist">\${esc(e.gist)}</div>\` : ''}
      \${tagHtml}
    </div>\`;
  }).join('');
}

async function openEntry(slug) {
  const entry = allEntries.find(e => e.slug === slug);
  if (!entry) return;
  currentEntry = entry;
  currentTags = [...(entry.tags || [])];
  renderList();
  document.getElementById('main').innerHTML = '<div class="placeholder">Loading…</div>';

  const res = await fetch('/api/research/' + encodeURIComponent(slug));
  if (!res.ok) { document.getElementById('main').innerHTML = '<div class="placeholder">Deep-dive not found.</div>'; return; }
  const { markdown } = await res.json();

  document.getElementById('main').innerHTML = \`
    <div class="article">
      <div class="article-top">
        <div class="article-title">\${esc(entry.title)}</div>
        <div class="article-date">\${esc(entry.date)}</div>
        <div class="article-actions">
          <button class="follow-btn" id="fubtn" onclick="openModal()">+ Follow up</button>
        </div>
        <div class="tag-editor" id="tag-editor"></div>
      </div>
      <div class="content" id="content"></div>
    </div>
  \`;

  document.getElementById('content').innerHTML = marked.parse(markdown);
  renderTagEditor();
}

function renderTagEditor() {
  const el = document.getElementById('tag-editor');
  if (!el) return;
  const chips = currentTags.map(t => \`<span class="tag-editor-chip">\${esc(t)}<button onclick="removeTag(\${JSON.stringify(t)})" title="Remove">×</button></span>\`).join('');
  el.innerHTML = chips + \`<input class="tag-add-input" id="tag-add-input" placeholder="Add tag…" onkeydown="tagInputKey(event)">\`;
  setTimeout(() => {}, 0);
}

function tagInputKey(e) {
  if (e.key === 'Enter') {
    const val = e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      saveTags();
    }
    e.target.value = '';
    renderTagEditor();
    e.preventDefault();
  }
}

function removeTag(tag) {
  currentTags = currentTags.filter(t => t !== tag);
  saveTags();
  renderTagEditor();
}

async function saveTags() {
  if (!currentEntry) return;
  await fetch('/api/research/' + encodeURIComponent(currentEntry.slug) + '/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: currentTags }),
  });
  // Update local allEntries
  const idx = allEntries.findIndex(e => e.slug === currentEntry.slug);
  if (idx !== -1) allEntries[idx].tags = [...currentTags];
  renderTagFilterChips();
  renderList();
}

// ── Follow-up modal ────────────────────────────────────────────────────────
function openModal() {
  document.getElementById('modal').classList.add('open');
  document.getElementById('modal-note').value = '';
  setTimeout(() => document.getElementById('modal-note').focus(), 50);
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }

async function confirmFollowUp() {
  const note = document.getElementById('modal-note').value.trim();
  await fetch('/api/research/' + encodeURIComponent(currentEntry.slug) + '/follow-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  closeModal();
  const btn = document.getElementById('fubtn');
  if (btn) { btn.textContent = '✓ Queued'; btn.classList.add('done'); btn.onclick = null; }
  loadQueue(); // refresh queue panel on monitor tab
}

document.getElementById('modal-note').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmFollowUp();
  if (e.key === 'Escape') closeModal();
});
document.getElementById('modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

// ── Monitor ────────────────────────────────────────────────────────────────
let monSnapshot = null;

function agentIcon(status) {
  if (status === 'done') return '<span style="color:#4ade80">✓</span>';
  if (status === 'running') return '<span class="spinner"></span>';
  return '<span style="color:#444">—</span>';
}

function renderAgentList(agents) {
  if (!agents || !agents.length) return '<div style="color:#444;font-size:12px;padding:4px 0">No agents found</div>';
  return \`<div class="agent-list">\${agents.map((a, i) => \`
    <div class="agent-row" id="ar-\${i}">
      <div class="agent-row-header" onclick="toggleAgent(event,'ar-\${i}')">
        <span class="agent-icon">\${agentIcon(a.status)}</span>
        <span class="agent-id">\${esc(a.agentId.slice(0,8))}</span>
        <span class="agent-subject">\${esc(a.subject)}</span>
        \${a.resultPreview ? \`<span class="agent-expand">▶</span>\` : ''}
      </div>
      \${a.resultPreview ? \`<div class="agent-preview">\${esc(a.resultPreview)}</div>\` : ''}
    </div>
  \`).join('')}</div>\`;
}

function toggleAgent(e, id) {
  e.stopPropagation();
  document.getElementById(id)?.classList.toggle('open');
}

function renderCurrentRun(run) {
  const el = document.getElementById('mon-current');
  if (!run) {
    el.innerHTML = '<div class="idle-card">No active run</div>';
    return;
  }
  const pct = run.totalAgents > 0 ? Math.round(run.doneAgents / run.totalAgents * 100) : 0;
  el.innerHTML = \`<div class="mon-card">
    <div class="mon-card-header">
      <div class="status-dot \${run.isRunning?'running':'idle'}"></div>
      <div class="mon-topic">\${esc(run.topic || 'Research in progress')}</div>
      <span class="mon-status-badge \${run.isRunning?'badge-running':'badge-done'}">\${run.isRunning?'Running':'Done'}</span>
    </div>
    <div class="progress-row">
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:\${pct}%"></div></div>
      <span class="progress-label">\${run.doneAgents} / \${run.totalAgents} agents</span>
    </div>
    \${renderAgentList(run.agents)}
  </div>\`;
}

function renderHistory(history) {
  const el = document.getElementById('mon-history');
  if (!history || !history.length) {
    el.innerHTML = '<div style="color:#333;font-size:13px">No past runs found</div>';
    return;
  }
  el.innerHTML = history.map((run, i) => {
    const d = new Date(run.mtime);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return \`<div class="hist-card" id="hc-\${i}" onclick="toggleHist('hc-\${i}')">
      <div class="hist-card-header">
        <div class="hist-topic">\${esc(run.topic || 'Research run')}</div>
        <span class="hist-meta">\${run.doneAgents}/\${run.totalAgents} · \${dateStr} \${timeStr}</span>
      </div>
      \${renderAgentList(run.agents)}
    </div>\`;
  }).join('');
}

function toggleHist(id) {
  document.getElementById(id)?.classList.toggle('open');
}

function applySnapshot(snap) {
  monSnapshot = snap;
  // Preserve expanded state across SSE re-renders
  const openIds = new Set(
    [...document.querySelectorAll('.hist-card.open, .agent-row.open')].map((el) => el.id)
  );
  renderCurrentRun(snap.current);
  renderHistory(snap.history);
  for (const id of openIds) {
    document.getElementById(id)?.classList.add('open');
  }
}

// ── Follow-up queue ────────────────────────────────────────────────────────
async function loadQueue() {
  try {
    const res = await fetch('/api/followups');
    const { items } = await res.json();
    renderQueue(items);
  } catch {}
}

function renderQueue(items) {
  const el = document.getElementById('mon-queue');
  const countEl = document.getElementById('queue-count');
  if (!items || !items.length) {
    el.innerHTML = '<div class="idle-card">Queue is empty — use "+ Follow up" on any research to add topics here.</div>';
    countEl.textContent = '';
    return;
  }
  countEl.textContent = \`(\${items.length})\`;
  el.innerHTML = \`<div class="queue-list">\${items.map((item, i) => \`
    <div class="queue-item">
      <div class="queue-item-text">\${esc(item)}</div>
      <button class="queue-send" onclick="sendToSage(\${i})" title="Send to Sage now">→ Sage</button>
      <button class="queue-remove" onclick="removeQueueItem(\${i})" title="Remove">×</button>
    </div>
  \`).join('')}</div>\`;
}

async function removeQueueItem(index) {
  await fetch(\`/api/followups/\${index}\`, { method: 'DELETE' });
  loadQueue();
}

async function sendToSage(index) {
  const btn = document.querySelectorAll('.queue-send')[index];
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const res = await fetch(\`/api/dispatch-queue/\${index}\`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (btn) { btn.textContent = '✓ Sent'; }
      setTimeout(() => loadQueue(), 1500);
    } else {
      if (btn) { btn.textContent = '✗ Error'; btn.disabled = false; }
    }
  } catch {
    if (btn) { btn.textContent = '✗ Error'; btn.disabled = false; }
  }
}

async function loadMonitor() {
  try {
    const res = await fetch('/api/monitor/snapshot');
    const snap = await res.json();
    applySnapshot(snap);
  } catch {}
  loadQueue();
}

function startSSE() {
  const es = new EventSource('/api/monitor/stream');
  es.onmessage = (e) => {
    try { applySnapshot(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {};
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────
loadLibrary();
loadMonitor();
startSSE();
</script>
</body>
</html>`;

// ─── Server helpers ──────────────────────────────────────────────────────────
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = req.method ?? 'GET';

  // Home
  if (url.pathname === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  // List all researches (with tags)
  if (url.pathname === '/api/researches' && method === 'GET') {
    return json(res, getEntriesWithTags());
  }

  // Get a deep-dive
  const readMatch = url.pathname.match(/^\/api\/research\/([^/]+)$/);
  if (readMatch && method === 'GET') {
    const slug = decodeURIComponent(readMatch[1]);
    const markdown = getDeepDive(slug);
    if (!markdown) return json(res, { error: 'not found' }, 404);
    return json(res, { markdown });
  }

  // Set tags for a slug
  const tagsMatch = url.pathname.match(/^\/api\/research\/([^/]+)\/tags$/);
  if (tagsMatch && method === 'POST') {
    const slug = decodeURIComponent(tagsMatch[1]);
    const body = await readBody(req);
    const { tags = [] } = JSON.parse(body || '{}') as { tags: string[] };
    const allTags = readTags();
    allTags[slug] = tags;
    writeTags(allTags);
    return json(res, { ok: true });
  }

  // Add follow-up
  const followMatch = url.pathname.match(/^\/api\/research\/([^/]+)\/follow-up$/);
  if (followMatch && method === 'POST') {
    const slug = decodeURIComponent(followMatch[1]);
    const body = await readBody(req);
    const { note = '' } = JSON.parse(body || '{}') as { note: string };
    const entries = parseCoverageLog();
    const entry = entries.find((e) => e.slug === slug);
    addFollowUp(entry?.title ?? slug, note);
    return json(res, { ok: true });
  }

  // Follow-up queue — read
  if (url.pathname === '/api/followups' && method === 'GET') {
    const items = parseFollowUps();
    return json(res, { items });
  }

  // Follow-up queue — delete by index
  const fuDeleteMatch = url.pathname.match(/^\/api\/followups\/(\d+)$/);
  if (fuDeleteMatch && method === 'DELETE') {
    const idx = Number(fuDeleteMatch[1]);
    const items = parseFollowUps();
    if (idx >= 0 && idx < items.length) {
      items.splice(idx, 1);
      writeFollowUps(items);
    }
    return json(res, { ok: true });
  }

  // Dispatch queue item to Sage immediately
  const dispatchMatch = url.pathname.match(/^\/api\/dispatch-queue\/(\d+)$/);
  if (dispatchMatch && method === 'POST') {
    const idx = Number(dispatchMatch[1]);
    const items = parseFollowUps();
    if (idx < 0 || idx >= items.length) return json(res, { ok: false, error: 'Index out of range' });
    try {
      execFileSync(
        process.execPath,
        [path.join(process.cwd(), 'node_modules/tsx/dist/cli.cjs'), path.join(process.cwd(), 'scripts/queue-check.ts')],
        { cwd: process.cwd() },
      );
      return json(res, { ok: true });
    } catch (e: unknown) {
      return json(res, { ok: false, error: String(e) });
    }
  }

  // Monitor snapshot (one-shot)
  if (url.pathname === '/api/monitor/snapshot' && method === 'GET') {
    const snapshot = await getMonitorSnapshot();
    return json(res, snapshot);
  }

  // Monitor SSE stream
  if (url.pathname === '/api/monitor/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);

    // Send current snapshot immediately
    getMonitorSnapshot()
      .then((snap) => {
        try { res.write(`data: ${JSON.stringify(snap)}\n\n`); } catch { /* ignore */ }
      })
      .catch(() => {});

    req.on('close', () => sseClients.delete(res));
    req.on('error', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSage Research Library → http://localhost:${PORT}  (Tailscale: http://100.80.171.46:${PORT})\n`);
});
