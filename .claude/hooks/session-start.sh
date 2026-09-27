#!/bin/bash
# career-ops — SessionStart hook for Claude Code on the web.
# Installs dependencies, makes Node scripts use the egress proxy, maps the
# Playwright Chromium revision to the preinstalled browser, and checks that the
# job-board APIs used by scan/discover are reachable. Never fails the session.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
ENV_FILE="${CLAUDE_ENV_FILE:-/dev/null}"

# 1. Dependencies. --ignore-scripts skips the postinstall browser download,
#    which the sandbox blocks; Chromium is preinstalled under /opt/pw-browsers.
npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
  || echo "career-ops setup: npm install failed; run it manually if a script reports a missing package."

# 2. Node's fetch() ignores HTTPS_PROXY unless told otherwise. The proxy agent
#    prints an "experimental" warning on stderr, which breaks scripts and tests
#    that expect a clean stderr, so silence that one warning.
echo 'export NODE_USE_ENV_PROXY=1' >> "$ENV_FILE"
echo 'export NODE_OPTIONS="${NODE_OPTIONS:-} --disable-warning=UNDICI-EHPA"' >> "$ENV_FILE"

# 3. Playwright expects a specific Chromium revision; point it at the installed one.
BROWSERS=/opt/pw-browsers
BJSON=$(ls node_modules/playwright-core/browsers.json node_modules/playwright/node_modules/playwright-core/browsers.json 2>/dev/null | head -1)
WANT=$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).browsers;console.log(b.find(x=>x.name==="chromium").revision)' "$BJSON" 2>/dev/null || true)
if [ -n "$WANT" ] && [ -d "$BROWSERS" ] && [ ! -d "$BROWSERS/chromium-$WANT" ]; then
  HAVE_FULL=$(ls -d "$BROWSERS"/chromium-[0-9]* 2>/dev/null | sort -V | tail -1)
  HAVE_SHELL=$(ls -d "$BROWSERS"/chromium_headless_shell-[0-9]* 2>/dev/null | sort -V | tail -1)
  SHIM="$HOME/.cache/career-ops/pw-browsers"
  mkdir -p "$SHIM"
  if [ -x "$HAVE_FULL/chrome-linux/chrome" ]; then
    mkdir -p "$SHIM/chromium-$WANT"
    ln -sfn "$HAVE_FULL/chrome-linux" "$SHIM/chromium-$WANT/chrome-linux64"
    touch "$SHIM/chromium-$WANT/INSTALLATION_COMPLETE" "$SHIM/chromium-$WANT/DEPENDENCIES_VALIDATED"
  fi
  if [ -x "$HAVE_SHELL/chrome-linux/headless_shell" ]; then
    mkdir -p "$SHIM/chromium_headless_shell-$WANT/chrome-headless-shell-linux64"
    ln -sfn "$HAVE_SHELL/chrome-linux/headless_shell" \
      "$SHIM/chromium_headless_shell-$WANT/chrome-headless-shell-linux64/chrome-headless-shell"
    touch "$SHIM/chromium_headless_shell-$WANT/INSTALLATION_COMPLETE" \
      "$SHIM/chromium_headless_shell-$WANT/DEPENDENCIES_VALIDATED"
  fi
  echo "export PLAYWRIGHT_BROWSERS_PATH=\"$SHIM\"" >> "$ENV_FILE"
fi

# 3b. Chromium ignores the system CA store and reads its own NSS database, so it
#     rejects the proxy's TLS certificate. Trust the locally added CAs there.
if [ -d /usr/local/share/ca-certificates ]; then
  command -v certutil >/dev/null 2>&1 \
    || timeout 120 apt-get install -y -q libnss3-tools >/dev/null 2>&1 || true
  if command -v certutil >/dev/null 2>&1; then
    NSS="$HOME/.pki/nssdb"
    mkdir -p "$NSS"
    [ -f "$NSS/cert9.db" ] || certutil -d "sql:$NSS" -N --empty-password 2>/dev/null
    CADIR=$(mktemp -d)
    node -e '
      const fs=require("fs"),path=require("path");const dir="/usr/local/share/ca-certificates";let n=0;
      for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".crt")))
        for(const p of (fs.readFileSync(path.join(dir,f),"utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[]))
          fs.writeFileSync(path.join(process.argv[1],"ca"+(++n)+".pem"),p+"\n");' "$CADIR" 2>/dev/null
    for f in "$CADIR"/*.pem; do
      [ -f "$f" ] && certutil -d "sql:$NSS" -A -t "C,," -n "local-$(basename "$f" .pem)" -i "$f" 2>/dev/null
    done
    rm -rf "$CADIR"
  fi
fi

# 4. Job-board APIs used by scan.mjs / discover-ats.mjs / audit-portals.mjs.
#    Any HTTP answer (even 404) means reachable; no answer means the environment's
#    network policy blocks the host.
HOSTS="boards-api.greenhouse.io api.ashbyhq.com api.lever.co apply.workable.com api.smartrecruiters.com"
TMP=$(mktemp -d)
for h in $HOSTS; do
  ( code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$h/" 2>/dev/null || true)
    [ "${code:-000}" = "000" ] && echo "$h" > "$TMP/$h" ) &
done
wait
BLOCKED=$(cat "$TMP"/* 2>/dev/null | sort | tr '\n' ' ')
rm -rf "$TMP"

if [ -n "$BLOCKED" ]; then
  cat <<EOF
career-ops setup: the job-board sites below are blocked by this cloud environment's network settings, so portal scans cannot run: $BLOCKED
Tell the user once, in plain French, before running scan/discover/audit (other features keep working). Suggested message:
"Pour que je puisse chercher des offres, autorisez une fois ces sites : ouvrez le menu de l'environnement cloud (barre de titre de la session) → Modifier → Accès réseau, puis ajoutez : $BLOCKED (ou choisissez un accès plus large). Dites-moi quand c'est fait."
EOF
fi

# 5. First run (no CV yet): steer the first reply to a simple, French-language
#    onboarding for non-technical users. Claude cannot speak first, so this
#    applies to the reply to whatever the user sends first (e.g. "Bonjour").
if [ ! -f cv.md ]; then
  cat <<'EOF'
career-ops first run: no cv.md yet. Whatever the user's first message is, start this onboarding (it replaces the English onboarding wording in AGENTS.md; its rules still apply):
- Speak French, short sentences, no jargon (the user is not technical). Ask at most 5 questions at a time. Explain your plan and wait for their OK before writing files. Never commit or push.
- First, greet them and ask for their CV as a .docx file (or pasted text).
- Convert it to cv.md word for word; list inconsistencies and fix only what they confirm.
- Then ask in one message: target roles and level; cities and work mode (on-site, hybrid, full remote); document language (French or English); target and minimum gross annual salary; work authorization in France.
- After their OK, set up the profile, targeting, job portals (adapted to their roles and market) and the tracker, then check with node doctor.mjs --json.
<<<<<<< HEAD
- End with a short table of what was set up, remind them this cloud session is temporary and offer to send their files, then ask: « Donne-moi l'URL d'une offre d'emploi pour lancer ta première évaluation. »
=======
- End with a short table of what was set up, $KEEP_FILES, then ask: « Donne-moi l'URL d'une offre d'emploi pour lancer ta première évaluation. »
EOF
else
  # 6. After onboarding: one use case only — a job URL in, a decision and
  #    application documents out.
  cat <<'EOF'
career-ops simple mode: the user is not technical and has one use case: they send a job posting URL, you tell them whether it fits, prepare their documents and tell them their chances. Speak French to them, short sentences, no jargon, never list other commands (answer if asked, then steer back to sending a URL). All AGENTS.md rules still apply (nothing invented, nothing submitted, every gate of the modes you run).
When they send a URL:
1. Run the auto-pipeline evaluation (report + tracker). In the report, add a "## Your Chances" section before "## Keywords extracted": what raises and lowers their odds (fit, posting reliability, how demanding the process is, company context). Never give a percentage.
2. Run `node .claude/hooks/report-html.mjs <report.md>` to render the HTML page (output/report-*.html); it is shown at the very end of your reply (see the display rule), never the Markdown.
3. Score below 3.5: advise against applying and stop; make the CV and letter only if they insist.
4. Otherwise, in ONE message: verdict + score, 3 reasons, 3 risks, then the cover-letter question « Qu'est-ce qui vous attire dans cette entreprise ? », with your pre-filled proposals for the other three modes/cover.md prompts (problem, approach, tone) so they only answer and correct if they want.
5. After their answer: generate the tailored CV PDF and display it, show the letter text in chat, and ask « Je la génère en PDF ? (oui / vos modifications) ». On « oui », generate the letter PDF, add "**Cover Letter:** <path>" to the report header, re-run .claude/hooks/report-html.mjs, display the CV again, send the letter, and end with the updated page.
Documents (CV and letter) use the job posting's language; your messages stay in French. If the company forbids AI-generated application content, warn them and give the letter as notes instead.
6. Close with « Une fois envoyé, dites-moi "c'est envoyé" ». Then run node set-status.mjs --report <report#> Applied --json (it also schedules the follow-up) and tell them the follow-up date (followupSeeded.nextDate).
Display rule (mandatory, whole flow): display the tailored CV PDF right away each time it is created or updated, and display the HTML report (output/report-*.html) at the very end of every reply in which it was created or updated: your final action, after all your text and other files, with nothing written after it. Use the file-sending tool (SendUserFile) with display "render" for both, so they open in the Claude app's side panel (desktop and web). Never deliver these two as a download-only attachment, and never skip them. The cover letter PDF is sent normally. If no file-sending tool is available (e.g. in a terminal), open the CV with the default app (macOS: open <file>; Windows: start "" <file>; Linux: xdg-open <file>) and give its path, and end your reply with the HTML report path as the last line. In your message, confirm both are shown; if one could not be displayed, name the file and its path.
>>>>>>> 851c6fbc (Hooks: display the HTML report at the very end of the reply)
EOF
fi

exit 0
