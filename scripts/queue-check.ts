#!/usr/bin/env tsx
/**
 * queue-check.ts — dispatch the first follow-up item to Sage.
 *
 * Reads follow-ups.md. If empty, exits silently (0).
 * If items exist, writes a `task` message to Sage's inbound.db so the host
 * sweep wakes her within the next 60 seconds.
 *
 * Run manually: pnpm exec tsx scripts/queue-check.ts
 * Scheduled:    com.nanoclaw.queue-check.plist (StartInterval: 3600)
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SAGE_GROUP_ID = 'ag-1781833560826-hi0vjd';
const FOLLOW_UPS = join(ROOT, 'groups/dm-with-ran/follow-ups.md');
const CENTRAL_DB = join(ROOT, 'data/v2.db');

function parseFollowUps(): string[] {
  if (!existsSync(FOLLOW_UPS)) return [];
  return readFileSync(FOLLOW_UPS, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/\*\*/g, '').trim())
    .filter(Boolean);
}

function nextEvenSeq(db: Database.Database): number {
  const { m } = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number };
  return m < 2 ? 2 : m + 2 - m % 2;
}

const items = parseFollowUps();
if (items.length === 0) {
  console.log('Queue empty — nothing to dispatch.');
  process.exit(0);
}

const first = items[0];
console.log(`Dispatching to Sage: "${first}"`);

// Find Sage's most recent session
const central = new Database(CENTRAL_DB, { readonly: true });
const session = central
  .prepare(`SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1`)
  .get(SAGE_GROUP_ID) as { id: string } | undefined;
central.close();

if (!session) {
  console.error('No session found for Sage.');
  process.exit(1);
}

const inboundPath = join(ROOT, 'data/v2-sessions', SAGE_GROUP_ID, session.id, 'inbound.db');
if (!existsSync(inboundPath)) {
  console.error(`inbound.db not found: ${inboundPath}`);
  process.exit(1);
}

const db = new Database(inboundPath);
const id = `queue-check-${Date.now()}-${randomBytes(3).toString('hex')}`;
const timestamp = new Date().toISOString();
const seq = nextEvenSeq(db);

const prompt = `Hourly queue check — follow-up item:

"${first}"

Steps:
1. Parse the research title before the colon (e.g. "Psychedelic-Assisted Therapy" from "Psychedelic-Assisted Therapy: question here"). If there is no colon, treat the whole string as a new topic.
2. Check coverage-log.md — if that title matches an existing research entry, this is a follow-up: extend that deep-dive with a new chapter (see CLAUDE.local.md for chapter format). Do NOT create a new research file.
3. If no match, treat it as a fresh topic and use /sage-research normally.
4. After delivering, remove this item from follow-ups.md (the first list item).`;

db.prepare(
  `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
   VALUES (?, ?, 'task', ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL, 0)`,
).run(id, seq, timestamp, JSON.stringify({ prompt }), id);

db.close();
console.log(`Done — Sage will wake within 60 seconds.`);
