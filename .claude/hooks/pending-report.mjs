/**
 * career-ops — per-session list of HTML report pages still to display.
 *
 * Written by after-tool.mjs (PostToolUse) when it renders a report page, read
 * and cleared by on-stop.mjs (Stop), which makes sure the page is the last
 * thing shown in the reply. Kept in the OS temp dir: it is transient session
 * state, never user data.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = join(tmpdir(), 'career-ops-hooks');
const file = (sessionId) => join(DIR, `pending-${String(sessionId || 'default').replace(/[^\w-]/g, '_')}.json`);

export function readPending(sessionId) {
  try {
    const list = JSON.parse(readFileSync(file(sessionId), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addPending(sessionId, htmlPath) {
  const list = readPending(sessionId).filter((p) => p !== htmlPath);
  list.push(htmlPath);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file(sessionId), JSON.stringify(list));
}

export function clearPending(sessionId) {
  rmSync(file(sessionId), { force: true });
}
