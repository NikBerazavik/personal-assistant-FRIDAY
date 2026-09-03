# Telegram → Claude → Notion task agent

A personal task assistant. You message a Telegram bot in plain language; Claude
Haiku interprets it, reads and writes your Notion Tasks database, and replies.
A daily cron sends a morning brief and spawns recurring tasks.

Zero runtime dependencies — everything uses native `fetch`.

---

## Architecture

```
Telegram  ──POST──▶  /api/telegram  ──▶  Claude (tool use loop)
                          │                      │
                          │                      ├── get_tasks
                          │                      ├── create_task
                          │                      ├── update_task
                          │                      └── list_projects
                          │                      │
                          │                      ▼
                          └──◀── reply ───  Notion REST API

Vercel Cron (daily) ──▶  /api/nightly  ──▶  Notion  ──▶  Telegram
```

`/api/telegram` is conversational and uses Claude. `/api/nightly` is
deterministic and does not — a morning brief should be correct and free, not
occasionally creative.

### Files

| Path | Purpose |
|---|---|
| `lib/config.js` | All env vars, Notion property names, allowed option values |
| `lib/dates.js` | Timezone-correct date maths (see note below) |
| `lib/notion.js` | Notion REST client, data-source resolution, queries, writes |
| `lib/tools.js` | Claude tool schemas + dispatcher |
| `lib/agent.js` | System prompt and the tool-use loop |
| `lib/telegram.js` | Message sending with 4096-char chunking |
| `api/telegram.js` | Webhook endpoint |
| `api/nightly.js` | Cron endpoint: brief + recurring task generation |
| `scripts/verify.js` | Preflight check — run before deploying |
| `scripts/setup-webhook.js` | Register / inspect / delete the webhook |

---

## Two things worth understanding before you deploy

**1. Notion databases vs data sources.** As of Notion API version `2025-09-03`,
a *database* is a container holding one or more *data sources*, and the data
source holds the rows. Queries hit `/v1/data_sources/{id}/query`, and new pages
are parented to a `data_source_id`. The id in your Notion URL is the *database*
id — the two are not interchangeable. `lib/notion.js` resolves database id →
data source id at runtime and caches it, so you only ever configure the easy
one. The `Notion-Version` header is pinned in `lib/config.js`; don't bump it
without reading Notion's upgrade guide, as they ship breaking changes between
versions.

**2. Timezones.** Vercel Cron runs in **UTC**. The schedule `0 23 * * *` is
23:00 UTC = **06:00 Bangkok the following day**. More subtly, `new Date()
.toISOString()` returns a UTC date, which at 06:00 Bangkok is still *yesterday*
— so a naive "today's tasks" query would fetch the wrong day every morning.
Everything in `lib/dates.js` computes in the configured local timezone to avoid
this. If you change `TIMEZONE`, update the cron hour in `vercel.json` to match.

---

## Setup

### 1. Notion

1. **notion.so/my-integrations** → New integration (an *internal connection*).
   Capabilities: read, update, insert content. Copy the token → `NOTION_API_KEY`.
2. Build the two databases with the schema below.
3. Open each database as a full page → `···` → **Connections** → add your
   integration. **Do this for both.** The token alone grants nothing; each
   database must be shared explicitly.
4. Copy each database id from its URL:
   `notion.so/workspace/<32-char-id>?v=...`

**Tasks**

| Property | Type | Options |
|---|---|---|
| Name | Title | — |
| Status | Status | Not Started, In Progress, Blocked, Done |
| Domain | Select | Personal, Work |
| Date | Date | toggle End date / Include time per entry |
| Project | Relation | → Projects |
| Priority | Select | P1, P2, P3 |
| Tags | Multi-select | as needed |
| Recurring | Select | None, Daily, Weekly |
| Needs Scheduling | Checkbox | — |
| Source | Select | Manual, Agent-created |
| Notes | Text | — |

**Projects**

| Property | Type | Options |
|---|---|---|
| Name | Title | — |
| Status | Select | Active, On Hold, Done |
| Domain | Select | Personal, Work |
| Area | Select | your workstreams |
| Deadline | Date | — |
| Notes | Text | — |

Property names are matched **exactly**. If you rename a column in Notion,
update `config.props` to match.

**Domain default.** Tasks are `Personal` unless you say "work" or the task is
clearly job-related (client meetings, deliverables, office). Change
`config.values.defaultDomain` to flip the default; the wording the model
follows lives in `lib/agent.js` and the `domain` field description in
`lib/tools.js`.

**Updates.** `update_task` changes only the fields you pass. Moving the start
of a timed block keeps its duration, an end time can be changed on its own,
notes are appended by default (`notes_mode: replace` overwrites), and
`clear_date` unschedules a task.

### 2. Telegram

1. Message **@BotFather** → `/newbot` → copy the token → `TELEGRAM_BOT_TOKEN`.
2. Message **@userinfobot** → copy your numeric id → `TELEGRAM_CHAT_ID`.
   This is what restricts the bot to you; bot usernames are discoverable.
3. Generate a webhook secret: `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET`.

### 3. Anthropic

**console.anthropic.com** → API Keys → Create Key → `ANTHROPIC_API_KEY`.
This is pay-as-you-go and billed separately from any Claude.ai subscription.

### 4. Verify locally

```bash
cp .env.example .env      # fill it in
npm run verify
```

This checks every token, confirms both databases are reachable, and compares
your actual Notion schema against the property names in config. Fix anything
that fails before deploying — otherwise the first symptom is silence at 6am.

### 5. Deploy

```bash
git init && git add . && git commit -m "initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

On **vercel.com** → Add New Project → import the repo. Then
**Settings → Environment Variables**: add everything from `.env` *except*
`DEPLOY_URL` and `CRON_SECRET` (Vercel generates `CRON_SECRET` itself once it
sees the `crons` block). Deploy.

### 6. Register the webhook

Put your deployment URL in `.env` as `DEPLOY_URL`, then:

```bash
npm run webhook:set
```

Message your bot `/help`, then try "what's on today?".

If you had registered the webhook before, re-run `npm run webhook:set` once:
the registration now subscribes to new messages only (not edits).

---

## Cost

Haiku 4.5 is $1 / $5 per million input / output tokens. A typical exchange runs
two Claude calls (one to pick a tool, one to phrase the reply) at roughly
2–4k tokens total, so on the order of **$0.01–0.03 per conversation**. Heavy
daily use lands around **$1–2/month**. Notion's API is free; it is rate-limited
to about 3 requests/second, which this will never approach. Vercel Hobby covers
the hosting, with cron limited to once per day.

To switch models, set `CLAUDE_MODEL=claude-sonnet-5` — exactly 2× the Haiku
rate. Worth it only if you add genuine prioritisation reasoning; for structured
CRUD, Haiku is the right size.

---

## Known limitations

- **Memory is reply-based only.** Each message is independent, except that
  when you *reply* to a message in Telegram (yours or the bot's), the quoted
  text is forwarded to Claude as context. So reply to "Added: Dentist, Fri 5
  Sep 14:00 (Personal)." with "move it to 4pm" and it resolves. A bare
  follow-up without a reply still needs the task named. Anything beyond that
  needs external state (Vercel KV, Upstash Redis) keyed by chat id.
- **Edited messages are ignored.** Editing a sent message does not re-run it,
  because re-running "add task X" would create X twice. Send a new message.
- **Recurring tasks** only support Daily and Weekly, generated by the nightly
  job. Grouping is by task name, so two recurring tasks with the same name
  will collide.
- **Multi-data-source databases** aren't supported; the first data source is
  used and a warning is logged.
- **Single user.** Both auth gates assume one chat id.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Bot silent | `npm run webhook:info` — shows Telegram's last delivery error |
| Any runtime error | Vercel → project → **Logs** |
| Notion 404 | The integration isn't connected to that database |
| Notion 400 on write | An option value doesn't exist in Notion; check `config.values` |
| Missing property errors | `npm run verify` compares config against the live schema |
| Brief arrives at the wrong hour | Cron is UTC; subtract 7 from your Bangkok target |
| No brief at all | Hobby cron timing is only guaranteed within the hour |
