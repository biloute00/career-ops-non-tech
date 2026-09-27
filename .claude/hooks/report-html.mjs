#!/usr/bin/env node
/**
 * report-html.mjs — Visual, standalone HTML view of an evaluation report.
 *
 * Reads reports/{###}-{slug}-{date}.md (unchanged, still the source of truth)
 * and writes output/report-{###}-{slug}-{date}.html: verdict first, then key
 * facts, strengths, risks, chances, CV match and documents, with the full
 * report in collapsible sections. Zero LLM tokens, no network, one file that
 * opens offline in any browser. Written to output/ because it is gitignored
 * (reports/*.html is not) and it sits next to the PDFs it links to.
 *
 * Usage:
 *   node .claude/hooks/report-html.mjs reports/001-acme-2026-01-01.md [--out file.html] [--lang en|fr]
 *   node .claude/hooks/report-html.mjs --all          # every report in reports/
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

// User-layer files (reports/, output/, config/) live under the data root, which
// CAREER_OPS_ROOT / .career-ops-data can move away from the codebase.
const DATA = getCareerOpsRoot();

const LABELS = {
  en: {
    apply: 'Apply', consider: 'Think it over', skip: 'Not recommended',
    score: 'Fit score', facts: 'Key facts', remote: 'Work mode', seniority: 'Level',
    salary: 'Advertised salary', notStated: 'Not stated', legitimacy: 'Posting reliability',
    workAuth: 'Work authorization', strengths: 'Why you', prepare: 'What to prepare',
    chances: 'Your chances', match: 'CV match', documents: 'Your documents',
    cv: 'Tailored CV (PDF)', cover: 'Cover letter (PDF)', posting: 'Open the job posting',
    details: 'Full report', noDocs: 'No documents generated yet.', generated: 'Generated from',
  },
  fr: {
    apply: 'Postuler', consider: 'À réfléchir', skip: 'Déconseillé',
    score: "Score d'adéquation", facts: 'En bref', remote: 'Mode de travail', seniority: 'Niveau',
    salary: 'Salaire annoncé', notStated: 'Non indiqué', legitimacy: "Fiabilité de l'offre",
    workAuth: 'Autorisation de travail', strengths: 'Vos atouts', prepare: 'À préparer',
    chances: 'Vos chances', match: 'Correspondance avec votre CV', documents: 'Vos documents',
    cv: 'CV adapté (PDF)', cover: 'Lettre de motivation (PDF)', posting: "Voir l'offre",
    details: 'Rapport complet', noDocs: 'Aucun document généré pour le moment.', generated: 'Généré depuis',
  },
};

// ── Markdown (the subset career-ops reports use) ───────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const rowTone = (cells) => {
  const t = cells.join(' ');
  if (/❌|⛔/.test(t)) return 'bad';
  if (/⚠️/.test(t)) return 'warn';
  if (/✅/.test(t)) return 'good';
  return '';
};

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
    } else if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      out.push('<div class="table"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map((r) => `<tr class="${rowTone(r)}">` + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
    } else if (/^#{3,6}\s/.test(line)) {
      out.push(`<h4>${inline(line.replace(/^#+\s*/, ''))}</h4>`); i++;
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) item += ' ' + lines[i].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^>\s?/.test(line)) {
      const buf = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push('<hr>'); i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const buf = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|\s*\||#{1,6}\s|>\s?|\s*([-*]|\d+\.)\s+)/.test(lines[i]); i++) buf.push(lines[i].trim());
      if (!buf.length) { buf.push(lines[i].trim()); i++; }
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

// ── Report parsing ─────────────────────────────────────────────────────────
export function parseReport(md) {
  const title = (md.match(/^#\s+(.+)$/m) || [])[1] || 'Evaluation';
  const header = {};
  const headEnd = md.search(/^##\s/m);
  for (const m of md.slice(0, headEnd < 0 ? md.length : headEnd).matchAll(/^\*\*([^*:]+):\*\*\s*(.*)$/gm)) header[m[1].trim().toLowerCase()] = m[2].trim();
  const sections = [];
  const parts = md.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    sections.push({ title: (nl < 0 ? p : p.slice(0, nl)).trim(), body: nl < 0 ? '' : p.slice(nl + 1).trim() });
  }
  let summary = {};
  const ms = sections.find((s) => /^machine summary/i.test(s.title));
  const fence = ms && ms.body.match(/```ya?ml\n([\s\S]*?)```/);
  if (fence) { try { summary = yaml.load(fence[1]) || {}; } catch { summary = {}; } }
  return { title, header, sections, summary };
}

const tableValue = (body, key) => {
  const re = new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, 'im');
  return (body.match(re) || [])[1];
};

// ── Page ───────────────────────────────────────────────────────────────────
export function renderReport(md, { lang = 'en', outDir = join(DATA, 'output'), source = '' } = {}) {
  const L = LABELS[lang] || LABELS.en;
  const { title, header, sections, summary } = parseReport(md);
  const score = Number(summary.score ?? parseFloat(header.score)) || 0;
  const verdict = score >= 4 ? ['apply', L.apply] : score >= 3.5 ? ['consider', L.consider] : ['skip', L.skip];
  const find = (re) => sections.find((s) => re.test(s.title));
  const roleSummary = find(/^A\)/)?.body || '';
  const list = (arr) => (Array.isArray(arr) && arr.length ? `<ul>${arr.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : '');
  const docLink = (p, label) => {
    if (!p || /pending|—/i.test(p)) return '';
    const abs = resolve(DATA, p.replace(/^`|`$/g, ''));
    return existsSync(abs) ? `<a class="doc" href="${esc(relative(outDir, abs))}">📄 ${esc(label)}</a>` : '';
  };
  const docs = [docLink(header.pdf, L.cv), docLink(header['cover letter'], L.cover)].filter(Boolean).join('');
  const facts = [
    [L.remote, tableValue(roleSummary, 'Remote')],
    [L.seniority, tableValue(roleSummary, 'Seniority')],
    [L.salary, summary.advertised_comp || L.notStated],
    [L.legitimacy, header.legitimacy || summary.legitimacy_tier],
    [L.workAuth, header['work auth']],
  ].filter(([, v]) => v);
  const chances = find(/chances/i);
  const match = find(/^B\)/);
  const hidden = /^(machine summary|keywords)/i;
  const details = sections.filter((s) => !hidden.test(s.title) && s !== chances && s !== match)
    .map((s) => `<details><summary>${inline(s.title)}</summary><div class="md">${markdownToHtml(s.body)}</div></details>`).join('\n');

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.replace(/^Evaluation:\s*/i, ''))}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2230;--muted:#5d6678;--line:#e3e6ec;--accent:#2556d9;
--good:#1f7a4d;--good-bg:#e5f5ec;--warn:#9a6200;--warn-bg:#fdf1dc;--bad:#b3261e;--bad-bg:#fce8e6}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--ink:#e8ebf1;--muted:#a1a9b8;--line:#2c3340;--accent:#7ea2ff;
--good:#6fd39c;--good-bg:#173226;--warn:#f0bf66;--warn-bg:#3a2e17;--bad:#ff8a80;--bad-bg:#3d1c1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 4px}.meta{color:var(--muted);font-size:.95rem;margin-bottom:20px}
.meta a,a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 16px}
.card h2{font-size:1.05rem;margin:0 0 10px}
.verdict{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.score{font-size:2.6rem;font-weight:700;line-height:1}.score small{font-size:1rem;color:var(--muted);font-weight:500}
.bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden;min-width:180px;flex:1}
.bar span{display:block;height:100%}
.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700}
.apply{background:var(--good-bg);color:var(--good)}.apply-bar{background:var(--good)}
.consider{background:var(--warn-bg);color:var(--warn)}.consider-bar{background:var(--warn)}
.skip{background:var(--bad-bg);color:var(--bad)}.skip-bar{background:var(--bad)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.fact span{display:block;color:var(--muted);font-size:.85rem}.fact b{font-weight:500;font-size:.95rem}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.grid2 .card{margin:0}.strengths{border-left:4px solid var(--good)}.prepare{border-left:4px solid var(--warn)}
ul,ol{padding-left:20px;margin:6px 0}li{margin:4px 0}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}tr.good td:first-child{box-shadow:inset 4px 0 var(--good)}
tr.warn td:first-child{box-shadow:inset 4px 0 var(--warn)}tr.bad td:first-child{box-shadow:inset 4px 0 var(--bad)}
.doc{display:inline-block;margin:4px 10px 4px 0;padding:10px 14px;border:1px solid var(--line);border-radius:10px;text-decoration:none;font-weight:600}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 10px}
summary{cursor:pointer;padding:12px 16px;font-weight:600}.md{padding:0 16px 12px}
pre{white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-size:.85rem;overflow-x:auto}
blockquote{margin:8px 0;padding:6px 14px;border-left:3px solid var(--line);color:var(--muted)}
code{background:var(--bg);padding:1px 5px;border-radius:5px}h4{margin:14px 0 6px}
footer{color:var(--muted);font-size:.8rem;margin-top:24px}
</style>
</head>
<body><main>
<h1>${inline(title.replace(/^Evaluation:\s*/i, ''))}</h1>
<div class="meta">${esc(header.date || '')}${header.url ? ` · <a href="${esc(header.url)}" target="_blank" rel="noopener">${esc(L.posting)}</a>` : ''}${header.archetype ? ` · ${inline(header.archetype)}` : ''}</div>

<section class="card verdict" aria-label="${esc(L.score)}">
  <div class="score">${score.toFixed(1)}<small> / 5</small></div>
  <div class="bar" role="img" aria-label="${score.toFixed(1)} / 5"><span class="${verdict[0]}-bar" style="width:${Math.max(0, Math.min(100, score * 20))}%"></span></div>
  <span class="badge ${verdict[0]}">${esc(verdict[1])}</span>
</section>

${facts.length ? `<section class="card"><h2>${esc(L.facts)}</h2><div class="facts">${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${inline(v)}</b></div>`).join('')}</div></section>` : ''}

<div class="grid2">
${list(summary.top_strengths) ? `<section class="card strengths"><h2>✅ ${esc(L.strengths)}</h2>${list(summary.top_strengths)}</section>` : ''}
${list([...(summary.hard_stops || []), ...(summary.soft_gaps || [])]) ? `<section class="card prepare"><h2>⚠️ ${esc(L.prepare)}</h2>${list([...(summary.hard_stops || []), ...(summary.soft_gaps || [])])}</section>` : ''}
</div>
<div style="height:16px"></div>

${chances ? `<section class="card"><h2>🎯 ${esc(L.chances)}</h2><div class="md">${markdownToHtml(chances.body)}</div></section>` : ''}
${match ? `<section class="card"><h2>${esc(L.match)}</h2>${markdownToHtml(match.body)}</section>` : ''}

<section class="card"><h2>${esc(L.documents)}</h2>${docs || `<p>${esc(L.noDocs)}</p>`}</section>

<h2 style="font-size:1.05rem;margin:24px 0 10px">${esc(L.details)}</h2>
${details}
<footer>${esc(L.generated)} ${esc(source)}</footer>
</main></body></html>
`;
}

function profileLang() {
  try {
    const p = yaml.load(readFileSync(join(DATA, 'config', 'profile.yml'), 'utf8'));
    return String(p?.language?.output || 'en').slice(0, 2).toLowerCase();
  } catch { return 'en'; }
}

function convert(file, { out, lang }) {
  const md = readFileSync(file, 'utf8');
  const outFile = out || join(DATA, 'output', `report-${basename(file, '.md')}.html`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderReport(md, { lang, outDir: dirname(resolve(outFile)), source: relative(DATA, resolve(file)) }));
  return outFile;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const lang = opt('--lang') || profileLang();
  const files = args.includes('--all')
    ? readdirSync(join(DATA, 'reports')).filter((f) => /^\d+-.+\.md$/.test(f)).map((f) => join(DATA, 'reports', f))
    : args.filter((a, i) => !a.startsWith('--') && !['--out', '--lang'].includes(args[i - 1]));
  if (!files.length || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node .claude/hooks/report-html.mjs <reports/NNN-slug-date.md> [--out file.html] [--lang en|fr]\n       node .claude/hooks/report-html.mjs --all [--lang en|fr]');
    process.exit(files.length || args.includes('--help') || args.includes('-h') ? 0 : 1);
  }
  const written = files.map((f) => convert(f, { out: files.length === 1 ? opt('--out') : undefined, lang }));
  console.log(JSON.stringify({ written: written.map((w) => relative(DATA, w)) }));
}
