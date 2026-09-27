#!/usr/bin/env node
/**
 * career-ops — PostToolUse hook (Write | Edit | MultiEdit | Bash).
 *
 * The HTML report and the tailored CV must be shown to the user every time
 * they are produced. A session-start instruction is easy to lose once a long
 * mode file takes over, so this hook acts at the moment it matters:
 *   - a reports/NNN-*.md file was written or edited → render the HTML page
 *     now (.claude/hooks/report-html.mjs) and record it as pending; on-stop.mjs
 *     then makes sure it is displayed at the very end of the reply;
 *   - generate-pdf.mjs produced a CV PDF → tell the agent to display it.
 * Output is PostToolUse additionalContext, read by the agent right after the
 * tool call. Never blocks and never fails the tool call.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addPending } from './pending-report.mjs';

const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// A Bash command that merely mentions a path (cat, grep) must not trigger
// anything: only files the command actually wrote, i.e. modified just now.
const FRESH_MS = 60_000;
const fresh = (p) => { try { return Date.now() - statSync(p).mtimeMs < FRESH_MS; } catch { return false; } };

async function dataRoot() {
  try {
    // Same resolution as every career-ops script (CAREER_OPS_ROOT, marker file, repo root).
    const m = await import(pathToFileURL(join(PROJECT, 'path-resolver.mjs')).href);
    return m.getCareerOpsRoot();
  } catch {
    return PROJECT;
  }
}

const REPORT_RE = /(?:^|[\s'"`(=])((?:[^\s'"`]*\/)?reports\/\d{3,}-[^\s'"`/]+\.md)\b/g;
const PDF_ARG_RE = /generate-pdf\.mjs\s+("[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|\S+\.pdf)/;

async function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const root = await dataRoot();
  const abs = (p) => (isAbsolute(p) ? p : resolve(root, p));

  const reports = new Set();
  let cvPdf = null;
  if (['Write', 'Edit', 'MultiEdit'].includes(tool) && ti.file_path) {
    const rel = relative(join(root, 'reports'), abs(ti.file_path));
    if (!rel.startsWith('..') && /^\d{3,}-.+\.md$/.test(rel) && !/RESERVED/.test(rel)) reports.add(abs(ti.file_path));
  }
  if (tool === 'Bash' && typeof ti.command === 'string') {
    for (const m of ti.command.matchAll(REPORT_RE)) {
      const p = abs(m[1]);
      if (/^\d{3,}-.+\.md$/.test(basename(p)) && !/RESERVED/.test(p) && fresh(p)) reports.add(p);
    }
    const pdf = ti.command.match(PDF_ARG_RE);
    if (pdf) {
      const p = abs(pdf[2].replace(/^["']|["']$/g, ''));
      if (fresh(p)) cvPdf = p;
    }
  }

  const notes = [];
  for (const report of reports) {
    if (!existsSync(report)) continue;
    const run = spawnSync(process.execPath, [join(PROJECT, '.claude', 'hooks', 'report-html.mjs'), report], { cwd: PROJECT, encoding: 'utf8' });
    let html = null;
    try { html = JSON.parse(run.stdout).written?.[0]; } catch { /* reported below */ }
    if (run.status === 0 && html) {
      addPending(input.session_id, resolve(root, html));
      notes.push(`career-ops: the HTML report was (re)generated at ${html}. Do not display it now: it must be the very last thing in your reply. Finish everything else first (messages, CV PDF, questions), then, as your final action, send it with SendUserFile, display "render" (it opens in the Claude app's side panel) and write nothing after it. Never show the Markdown report instead. Without a file-sending tool, end your reply with the page path as the last line.`);
    } else {
      notes.push(`career-ops: .claude/hooks/report-html.mjs failed for ${report}: ${(run.stderr || '').trim().slice(0, 300)}. Run it yourself (node .claude/hooks/report-html.mjs ${report}) and display the page.`);
    }
  }
  if (cvPdf) {
    notes.push(`career-ops: a CV PDF was generated at ${cvPdf}. Display it to the user NOW with SendUserFile, display "render", and mention it in your message. Without a file-sending tool, open it with the default app and give the path.`);
  }
  if (notes.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } }));
  }
}

try { await main(); } catch { /* never fail the tool call */ }
process.exit(0);
