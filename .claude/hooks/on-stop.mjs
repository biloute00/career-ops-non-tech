#!/usr/bin/env node
/**
 * career-ops — Stop hook.
 *
 * The HTML report (output/report-*.html) must be displayed at the very end of
 * the agent's reply, after everything else (verdict, CV PDF, cover letter…).
 * after-tool.mjs records every report page it renders during a turn as
 * "pending" for this session; when the agent tries to finish, this hook checks
 * the transcript of the current turn:
 *   - the last thing the agent did was send the pending page (SendUserFile with
 *     its path, no text after it), or its last text ends with the page path
 *     (fallback when no file-sending tool exists) → let the turn end;
 *   - otherwise → block the stop once and ask for the page as the final action.
 * stop_hook_active (set by Claude Code on the retry) prevents any loop. Never
 * fails: any error lets the turn end normally.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { clearPending, readPending } from './pending-report.mjs';

function lastTurnBlocks(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const entries = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  // The current turn starts after the last genuine user prompt (not a tool result).
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user' || e.isSidechain) continue;
    const c = e.message?.content;
    const isToolResult = Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
    if (!isToolResult) { start = i + 1; break; }
  }
  const blocks = [];
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant' || e.isSidechain) continue;
    for (const b of e.message?.content || []) {
      if (b?.type === 'text' && b.text.trim()) blocks.push({ kind: 'text', text: b.text });
      if (b?.type === 'tool_use') blocks.push({ kind: 'tool', name: b.name, input: b.input });
    }
  }
  return blocks;
}

function displayedLast(blocks, htmlPaths) {
  if (!blocks?.length) return false;
  const last = blocks[blocks.length - 1];
  const names = htmlPaths.map((p) => basename(p));
  const mentions = (s) => names.every((n) => String(s).includes(n));
  if (last.kind === 'tool' && /SendUserFile/.test(last.name)) return mentions(JSON.stringify(last.input?.files ?? last.input));
  if (last.kind === 'text') {
    // Fallback (no file-sending tool): the reply ends with the page path(s).
    const tail = last.text.trim().split('\n').slice(-names.length - 1).join('\n');
    return mentions(tail);
  }
  return false;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const pending = readPending(input.session_id).filter((p) => existsSync(p));
  if (pending.length) {
    const blocks = lastTurnBlocks(input.transcript_path);
    if (input.stop_hook_active || displayedLast(blocks, pending)) {
      clearPending(input.session_id);
    } else {
      clearPending(input.session_id);
      const list = pending.join(', ');
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `career-ops: the HTML report must be displayed at the very end of your reply. As your final action, send ${list} with SendUserFile, display "render" (one call, all pages; put any short note in its caption) and write nothing after it. Do not repeat your message. Without a file-sending tool, end with the page path(s) as the last line instead.`,
      }));
    }
  }
} catch { /* never block on a hook error */ }
process.exit(0);
