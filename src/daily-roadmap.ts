import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const CHANNEL_ID = 'C0B05TYPEQH'; // trc1-admin
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SCRAP_SYNC_DIR = '/opt/axel/scrap-sync-trc-deploy';
const SESSIONS_DIR = '/var/lib/claude-slack-bridge/sessions';

async function postToSlack(text: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: CHANNEL_ID, text }),
  });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack postMessage failed: ${body.error}`);
}

async function gatherContext(): Promise<string> {
  const sections: string[] = [];

  try {
    const { execSync } = await import('child_process');
    const branches = execSync(
      'git branch -r --sort=-committerdate --format="%(refname:short) %(committerdate:relative)" 2>/dev/null | grep -v "HEAD" | head -40',
      { cwd: SCRAP_SYNC_DIR, encoding: 'utf-8', timeout: 10000 },
    ).trim();
    sections.push(`## Open Remote Branches (scrap-sync, most recent first)\n${branches}`);

    const log = execSync(
      'git log --oneline -20 origin/pilot/brian-mvp 2>/dev/null',
      { cwd: SCRAP_SYNC_DIR, encoding: 'utf-8', timeout: 10000 },
    ).trim();
    sections.push(`## Recent Commits on pilot/brian-mvp\n${log}`);
  } catch (e: any) {
    sections.push(`## Git: error reading scrap-sync — ${e?.message}`);
  }

  try {
    const { execSync } = await import('child_process');
    const tmux = execSync(
      'tmux list-sessions -F "#{session_id} #{session_name} created=#{session_created_string} attached=#{session_attached}" 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    sections.push(`## tmux Sessions\n${tmux || '(none)'}`);

    const windows = execSync(
      'tmux list-windows -a -F "#{session_name}:#{window_name} active=#{window_active} #{pane_current_command}" 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    sections.push(`## tmux Windows\n${windows || '(none)'}`);
  } catch {
    sections.push(
      '## tmux: no sessions running (NORMAL — tmux is an interactive convenience, not a service; never report this as a problem)',
    );
  }

  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    const sessions = files.map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
        return `  - channel=${raw.channelId} thread=${raw.threadTs || 'direct'} active=${raw.isActive} lastActivity=${raw.lastActivity} cwd=${raw.workingDirectory || 'unset'}`;
      } catch {
        return `  - (unreadable: ${f})`;
      }
    });
    sections.push(
      `## Persisted Claude/Slack Sessions (${files.length} total)\n` +
        `(Zero persisted sessions is NORMAL — sessions are per-conversation scratch state, not a service. Never report a count of 0 as a problem.)\n` +
        (sessions.join('\n') || '(none)'),
    );
  } catch {
    sections.push('## Claude Sessions: sessions dir not readable');
  }

  try {
    const { execSync } = await import('child_process');
    // Always-on daemons: `active` is the healthy state, anything else is a real problem.
    const daemons = ['claude-slack-bridge'];
    // Timer-driven oneshots: `inactive` is the CORRECT resting state between runs.
    // Health for these is "did the last run exit 0", never is-active. Reporting
    // is-active for a oneshot produced four consecutive days of false
    // "3 services down" red flags in this roadmap (Sep 11/12/13/18 2026).
    const oneshots = ['axel-daily-brief', 'roadie-daily-refresh', 'axel-carrier-poll'];

    const show = (svc: string, props: string[]): Record<string, string> => {
      const out = execSync(`systemctl show ${svc} --property=${props.join(',')} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const map: Record<string, string> = {};
      for (const line of out.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      return map;
    };

    const lines: string[] = [];

    for (const svc of daemons) {
      try {
        const p = show(svc, ['ActiveState', 'SubState', 'Result']);
        const healthy = p.ActiveState === 'active';
        lines.push(
          `  ${svc} (always-on): ${p.ActiveState}/${p.SubState} result=${p.Result || 'n/a'} — ${healthy ? 'HEALTHY' : 'PROBLEM: daemon is not active'}`,
        );
      } catch {
        lines.push(`  ${svc} (always-on): PROBLEM: could not query unit`);
      }
    }

    for (const svc of oneshots) {
      try {
        const p = show(svc, ['Result', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ActiveState']);
        const rc = p.ExecMainStatus || '';
        const lastRun = p.ExecMainStartTimestamp || '';
        // Has the timer actually missed its window? Compare last start against the
        // timer's own schedule rather than guessing from ActiveState.
        let overdue = false;
        let nextRun = '';
        try {
          const t = show(`${svc}.timer`, ['NextElapseUSecRealtime', 'LastTriggerUSec']);
          nextRun = t.NextElapseUSecRealtime || '';
          const lastTrigger = Date.parse(t.LastTriggerUSec || '');
          if (!Number.isNaN(lastTrigger)) {
            // Daily cadence on every one of these units; 36h gives a full cycle
            // plus slack before we call a miss.
            overdue = Date.now() - lastTrigger > 36 * 60 * 60 * 1000;
          }
        } catch {
          /* timer may not exist; fall back to last-run result only */
        }
        const failed = p.Result !== 'success' || (rc !== '' && rc !== '0');
        const verdict = failed
          ? `PROBLEM: last run failed (result=${p.Result} rc=${rc})`
          : overdue
            ? 'PROBLEM: last run succeeded but the timer has not fired in >36h'
            : 'HEALTHY (idle between scheduled runs — this is the expected state)';
        lines.push(
          `  ${svc} (timer-driven oneshot): last_run=${lastRun || 'never'} result=${p.Result || 'n/a'} rc=${rc || 'n/a'} next=${nextRun || 'unknown'} — ${verdict}`,
        );
      } catch {
        lines.push(`  ${svc} (timer-driven oneshot): PROBLEM: could not query unit`);
      }
    }

    sections.push(
      `## Key Service Health\n` +
        `(Interpretation: only report a service problem when a line says PROBLEM. ` +
        `"inactive" on a timer-driven oneshot is NOT a failure.)\n` +
        lines.join('\n'),
    );
  } catch (e: unknown) {
    sections.push(`## Service Health: error — ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const fname of ['PUNCHLIST.md', 'ROADMAP.md']) {
    const p = path.join('/opt/claude-slack-bridge', fname);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8').slice(0, 2000);
      sections.push(`## ${fname} (claude-slack-bridge)\n${content}`);
    }
  }

  for (const fname of ['PUNCHLIST.md', 'ROADMAP.md']) {
    const p = path.join(SCRAP_SYNC_DIR, fname);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8').slice(0, 3000);
      sections.push(`## ${fname} (scrap-sync)\n${content}`);
    }
  }

  // Refuted register (R1-R45+). These are claims already investigated and
  // killed with evidence, several of them by direct ruling from Andy. This
  // roadmap is a daily sweep, and daily sweeps are exactly what re-raise
  // settled items — R45 (AP email intake) was surfaced by three separate
  // sweeps before Andy ruled on it. Feeding the register in as context is
  // what stops the fourth.
  //
  // Only the `#` and `Claim` columns go in. The `Evidence` column is the bulk
  // of the file and the model does not need it to suppress an item — it needs
  // to recognize the claim. Injecting the whole table crowds the prompt.
  try {
    const stateDir = '/opt/axel/.state';
    // Glob audit-*/03-refuted*, newest last, so a future audit directory picks
    // itself up instead of silently orphaning the rule at a stale date stamp.
    const candidates: string[] = [];
    for (const dir of fs.readdirSync(stateDir).filter((d) => d.startsWith('audit-')).sort()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(path.join(stateDir, dir));
      } catch {
        continue;
      }
      for (const f of entries.filter((f) => f.startsWith('03-refuted')).sort()) {
        candidates.push(path.join(stateDir, dir, f));
      }
    }
    const registerPath = candidates[candidates.length - 1];

    if (registerPath && fs.existsSync(registerPath)) {
      const raw = fs.readFileSync(registerPath, 'utf-8');
      const claims: string[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('|')) continue;
        const cells = t.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length < 2) continue;
        const id = cells[0].replace(/\*/g, '').trim();
        const claim = cells[1].replace(/\*\*/g, '').trim();
        // Skip the header row and the |---|---| separator.
        if (!id || !claim) continue;
        if (/^#$/.test(id) || /^-+$/.test(id)) continue;
        claims.push(`- ${id}: ${claim}`);
      }
      if (claims.length > 0) {
        sections.push(
          `## REFUTED REGISTER — do not re-raise any of these (${path.basename(path.dirname(registerPath))}, ${claims.length} entries)\n` +
            `Every claim below was already investigated and killed with evidence; some are direct rulings from Andy. ` +
            `Do NOT list any of these as a finding, a red flag, a radar item, or an open decision, in ANY rewording. ` +
            `(Evidence column omitted deliberately — full register: ${registerPath})\n` +
            claims.join('\n'),
        );
      }
    }
  } catch {
    /* register absent or unparseable — proceed without it rather than failing the brief */
  }

  return sections.join('\n\n');
}

async function runClaude(context: string): Promise<string> {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' });

  const prompt = `You are generating a daily morning roadmap message for Andy Hayes, a solo developer/founder working on scrap-sync (a SaaS repairs & operations platform for recycling centers). Today is ${now} Central Time.

Below is a snapshot of the current state of work across his server. Your job is to synthesize this into a concise, prioritized *Suggested Roadmap for Today* that he'll read in Slack over morning coffee.

FORMAT RULES:
- HARD RULE — the refuted register: if a "REFUTED REGISTER" section appears in the context, read it FIRST. Anything listed there is settled. Never surface it as a finding, red flag, radar item, open question, or "worth a look", no matter how you would word it. Re-raising a settled item costs Andy attention, which is the scarcest thing this message spends. If your draft contains one, delete the line.
- Lead with a 1-2 sentence plain-English "state of play" summary — what's the overall situation?
- Then: *Today's Suggested Focus* — a numbered priority list, max 5 items. Each item: bold title, one sentence on what/why.
- Then: *On the Radar (don't lose track)* — a short bullet list of things that are open/stalled but not today's focus.
- Then: *Heads Up* — genuine red flags only. Omit this section entirely if there are none; an empty Heads Up is a good morning, not a formatting failure.
  - Service health: report a service ONLY if its line in "Key Service Health" literally contains the word PROBLEM. A timer-driven oneshot sitting "inactive"/"idle between scheduled runs" is working correctly — never call it down, dead, failed, or stopped.
  - Never raise a heads-up about: zero tmux sessions, zero persisted Claude/Slack sessions, or a normal idle oneshot. These are expected states, not incidents.
  - Do not re-raise the same standing item as a red flag every day. Long-lived known items (e.g. an unshipped punchlist entry) belong in *On the Radar*, not *Heads Up*. *Heads Up* is for what changed or what is actually broken right now.
- Use Slack mrkdwn formatting (*bold*, bullet -, numbered lists). Keep it scannable — no walls of text.
- Do NOT list every branch or session verbatim. Synthesize.
- Today's date/time header at the top: *📅 Daily Roadmap — [date]*

CONTEXT DATA:
${context}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((b) => b.type === 'text')?.text ?? '';
  if (!text) throw new Error('Anthropic returned no text content');
  return text.trim();
}

async function main() {
  console.log('[daily-roadmap] starting');
  try {
    const context = await gatherContext();
    console.log('[daily-roadmap] context gathered, calling Claude API');
    const roadmap = await runClaude(context);
    if (!roadmap) throw new Error('Claude returned empty result');
    await postToSlack(roadmap);
    console.log('[daily-roadmap] posted to Slack successfully');
  } catch (err: any) {
    const msg = `⚠️ *Daily Roadmap failed to generate*\n\`${err?.message || String(err)}\``;
    try { await postToSlack(msg); } catch { /* best-effort */ }
    console.error('[daily-roadmap] error:', err);
    process.exit(1);
  }
}

main();
