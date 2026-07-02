#!/usr/bin/env tsx
/**
 * memory-sync.ts — snapshot Sage's memory to ranamar16/sage-memory.
 *
 * Copies groups/dm-with-ran/{memory files, research/} into a local clone
 * of sage-memory, commits with a timestamp, and pushes.
 *
 * Run manually: pnpm run memory-sync
 * Scheduled:    com.nanoclaw.memory-sync.plist (e.g. daily at 3am)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SAGE_DIR = path.join(ROOT, 'groups', 'dm-with-ran');
const CLONE_DIR = path.join(ROOT, 'data', 'sage-memory-sync');
const REPO_URL = 'https://github.com/ranamar16/sage-memory.git';

const MEMORY_FILES = [
  'about-ran.md',
  'backlog.md',
  'coverage-log.md',
  'follow-ups.md',
  'playbook.md',
  'CLAUDE.local.md',
];

function run(cmd: string, cwd = CLONE_DIR) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copyFile(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Clone if missing, pull if present
if (!fs.existsSync(CLONE_DIR)) {
  console.log('Cloning sage-memory…');
  execSync(`git clone ${REPO_URL} ${CLONE_DIR}`, { stdio: 'inherit' });
} else {
  console.log('Pulling latest…');
  run('git pull --ff-only');
}

// Sync memory files
for (const file of MEMORY_FILES) {
  const src = path.join(SAGE_DIR, file);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(CLONE_DIR, 'memory', file));
  }
}

// Sync research — deep-dive.md + chapter-*.md for each slug
const researchSrc = path.join(SAGE_DIR, 'research');
const researchDest = path.join(CLONE_DIR, 'research');
if (fs.existsSync(researchSrc)) {
  for (const slug of fs.readdirSync(researchSrc)) {
    const slugSrc = path.join(researchSrc, slug);
    const slugDest = path.join(researchDest, slug);
    if (!fs.statSync(slugSrc).isDirectory()) continue;
    fs.mkdirSync(slugDest, { recursive: true });
    for (const file of fs.readdirSync(slugSrc)) {
      if (file.endsWith('.md')) {
        copyFile(path.join(slugSrc, file), path.join(slugDest, file));
      }
    }
  }
}

// Commit and push if anything changed
run('git add -A');
const status = execSync('git status --porcelain', { cwd: CLONE_DIR }).toString().trim();
if (!status) {
  console.log('Nothing changed — already up to date.');
  process.exit(0);
}

const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
run(`git commit -m "sync: ${timestamp}"`);
run('git push');
console.log('Done.');
