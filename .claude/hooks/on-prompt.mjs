#!/usr/bin/env node
/**
 * career-ops — UserPromptSubmit hook.
 *
 * 1. Cloud sessions: when a URL in the message points to a host the
 *    environment blocks, tell the agent to find the posting elsewhere or ask
 *    for the pasted text instead of stopping (it cannot change the network).
 * 2. When onboarding is done (cv.md exists) and the message contains a URL,
 * restate the simple-mode flow right next to that message, so it is fresh when
 * the long career-ops mode files load. Plain stdout becomes agent context.
 * Never blocks the prompt.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// In a cloud session, is this host blocked by the environment's network
// policy? A blocked CONNECT gives no HTTP status at all ("000"); any status,
// even 403/404, means the site itself answered.
function blocked(host) {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '6', `https://${host}/`], { encoding: 'utf8' });
  return r.error ? false : (r.stdout || '000').trim() === '000';
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const prompt = String(input.prompt || '');
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const urls = prompt.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const out = [];

  if (process.env.CLAUDE_CODE_REMOTE === 'true') {
    const hosts = [...new Set(urls.map((u) => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean))];
    for (const host of hosts.filter(blocked)) {
      out.push([
        `career-ops blocked-link fallback: ${host} is blocked by this cloud environment's network settings (only the user can change them; never ask for full access).`,
        'Do not stop and do not ask first:',
        '1) Find the same posting on a reachable source: use WebSearch with the company and job title (read them from the link) and prefer the company\'s own careers page or its application platform (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Welcome to the Jungle). Use a copy only if it is clearly the same posting (same company, title and location, or the same job ID); companies often have several near-identical postings, so if more than one candidate fits, do not guess: go to step 2 and show the candidates. If you find it, evaluate from there, put that page as the report URL (with the original link in the notes), and tell the user in one short French sentence which page you used.',
        '2) Only if that fails, ask in French: « Je n\'arrive pas à ouvrir ce lien. Copiez-collez ici le texte complet de l\'offre », then evaluate the pasted text (liveness unverified, say so in the report).',
        `3) In the same message, once, offer the one-time fix: allow ${host} (menu de l'environnement cloud → Modifier → Accès réseau → domaines autorisés), plus the job-sites list from the career-ops network note if you have it.`,
      ].join(' '));
    }
  }

  if (urls.length && existsSync(join(project, 'cv.md'))) {
    out.push([
      'career-ops simple mode reminder (job URL received): run the auto-pipeline evaluation;',
      'add "## Your Chances" to the report; the HTML report is generated automatically when the report is written —',
      'display it with SendUserFile display "render" as the very last action of your reply, with nothing after it; score < 3.5 → advise against and stop;',
      'otherwise one message (verdict, 3 reasons, 3 risks, « Qu\'est-ce qui vous attire dans cette entreprise ? » with pre-filled proposals);',
      'every tailored CV PDF must also be displayed with display "render". Messages in French, documents in the posting\'s language.',
    ].join(' '));
  }
  if (out.length) process.stdout.write(out.join('\n'));
} catch { /* never block the prompt */ }
process.exit(0);
