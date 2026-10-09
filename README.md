# Telegram → Claude → Notion task agent

A personal task assistant. You message a Telegram bot in plain language; Claude
Haiku interprets it, reads and writes your Notion Tasks database, and replies.
A scheduler calls it every 30 minutes; at 09:00 it sends a morning brief and
spawns recurring tasks, and later in the day it sends short reminders.

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

cron-job.org (every 30 min) ──▶  /api/tick  ──▶  Notion  ──▶  Telegram
```

`/api/telegram` is conversational and uses Claude. `/api/tick` (and `/api/nightly`) are
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
| `api/tick.js` | Called every 30 min; sends the 09:00 brief or a quiet reminder for the due slot |
| `api/nightly.js` | Manual trigger for the morning brief |
| `lib/schedule.js` | Reminder slots and window logic (edit times here) |
| `lib/brief.js` | Brief + recurring task generation |
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

**2. Timezones.** Servers run in **UTC**: 06:00 Bangkok is 23:00 UTC the
previous day. So `new Date().toISOString()` returns a UTC date, which in the
Bangkok early morning is still *yesterday*
— so a naive "today's tasks" query would fetch the wrong day every morning.
Everything in `lib/dates.js` computes in the configured local timezone to avoid
this. Slot times in `lib/schedule.js` are local times too, so the external
scheduler only has to call every 30 minutes; its own timezone does not matter.

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
that fails before deploying — otherwise the first symptom is silence at 9am.

### 5. Deploy

```bash
git init && git add . && git commit -m "initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

On **vercel.com** → Add New Project → import the repo. Then
**Settings → Environment Variables**: add everything from `.env` *except*
`DEPLOY_URL`. Also add `CRON_SECRET` yourself (e.g. `openssl rand -hex 32`);
Vercel does not generate it, and the cron endpoints reject requests without it.
Deploy.

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
- **Recurring tasks** only support Daily and Weekly, generated by the morning
  brief. The next copy keeps the time, duration, tags, notes and project of
  the newest one. To stop a series, set Recurring to None on its **newest**
  copy (older copies can keep their Daily/Weekly). Marking a copy Done or
  Cancelled skips that occurrence only. Grouping is by task name, so two
  recurring tasks with the same name will collide.
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
| No brief at all | cron-job.org → the job's history: a 401 means the `Authorization` header does not match `CRON_SECRET` in Vercel (env changes need a redeploy); no entries or a disabled job means it never ran. Then Vercel Logs for `/api/tick` |
| Brief arrives late with "(Sent late...)" | The 09:00 call failed or never arrived; a later tick caught up. Check cron-job.org history around 09:00 |

---

## Reminder schedule

Vercel's free plan allows one cron run per day with up to an hour of drift, so
there is no `crons` entry in `vercel.json`. Instead an external scheduler
(cron-job.org, free) calls `GET <DEPLOY_URL>/api/tick` every 30 minutes with the
header `Authorization: Bearer <CRON_SECRET>`. `CRON_SECRET` must be set in
Vercel; endpoints reject requests without it.

Slots live in `lib/schedule.js`: 09:00 (full brief), 11:00, 12:30, 15:00, 18:00,
21:00. Each later slot sends two parts: "Coming up" (timed tasks starting between
that slot + 30 min and the next slot + 30 min) and "After that" (the window
following it). The 21:00 slot is different: it previews tomorrow morning
(all-day tasks plus timed tasks from 00:00 to 12:30), plus anything timed later
tonight. Because of that, the 18:00 slot stops its "After that" part at 21:30
instead of repeating what the preview will say. The 30-minute lead (`LEAD_MIN`)
means nothing is announced with less than 30 minutes notice. A slot stays
silent if it has nothing to list. Give a task a time in Notion's Date field for
it to be reminded; all-day tasks only appear in the 09:00 brief and the 21:00
preview. Multi-day tasks (a date range) appear in the brief as "ongoing" every
day they run, not as overdue.

**Nothing is sent twice, and a missed brief is caught up.** Each tick records
on the state page (`NOTION_STATE_PAGE_ID`, see MacBook watcher) what already
went out today. A repeated call in the same slot sends nothing. If the 09:00
brief does not go out (the call never arrived, Notion or Telegram failed), the
next tick tries again, every 30 minutes until 21:00, and the brief says it is
late. A failure is reported once a day, not on every retry. The brief always
runs before the MacBook watcher, so a slow CompAsia page cannot hold it up, and
every outside request has a timeout. Without the state page, jobs only run in
their slot window, with no catch-up.

Test without sending: `/api/tick?slot=11:00&dry=1`. Forcing a slot ignores what
already ran today; a dry run records nothing.

## MacBook watcher

At the 09:00 tick, `lib/watcher.js` reads https://compasia.co.th/collections/macbooks
and sends a separate Telegram message when a new MacBook Pro appears that is a
16 inch OR has an M4 or newer chip (edit `WANTED` in the file to change this).
No AI involved. It also messages when the page lists products it cannot read
(layout changed, scraper broken), when a product that is not a MacBook Pro, Air or
Neo shows up (Air and Neo are ignored), and once a week as a "still alive" check
if nothing else was sent. An empty shop (0 listings) is mentioned once a week, not
daily.

It remembers what it has already seen in a Notion page, since Vercel keeps no
files between runs. An empty or blocked page does not erase that memory, and a
listing is forgotten 30 days after it was last on the page. Accessories (a
keyboard or charger "for MacBook Pro 16 inch") are ignored. If the watcher
fails it is retried on later ticks, with one failure message per day. One-time setup: create an empty standalone page in Notion (not inside the Tasks or Projects database), share it with
the FRIDAY integration (Connections), copy its id from the URL and set
`NOTION_STATE_PAGE_ID` in Vercel (and in `.env`, so `npm run verify` can check it). The same page
also holds the record of which messages went out today. The first run sends a "watcher started"
message and does not alert on listings already there.

Test without sending or saving: `/api/tick?slot=09:00&dry=1` (the `watcher` field
shows what would be sent).
