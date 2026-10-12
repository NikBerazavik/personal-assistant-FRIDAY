# F.R.I.D.A.Y.

Personal Telegram → Claude → Notion task bot, deployed on Vercel (free plan).
Architecture, setup and the reminder schedule are in README.md; read it before
changing scheduling or deployment.

## How the bot gets triggered

Nothing runs unless something calls it. Check these before blaming code:

- `/api/telegram`: called by Telegram's webhook whenever the user messages the bot.
- `/api/tick`: must be called every 30 minutes by an **external scheduler**
  (cron-job.org) with `Authorization: Bearer <CRON_SECRET>`. It sends the morning
  brief, the slot reminders, the 21:00 preview and runs the MacBook watcher.
  There is no Vercel cron (free plan = once a day, ±1h). If the scheduler is
  missing or misconfigured, all of these go silent with no error anywhere.
- The state page (`NOTION_STATE_PAGE_ID`) records what went out each day. If it
  has no recent `done` entries, ticks are not arriving or not succeeding.

When the user reports a message that did not arrive, first confirm the trigger
actually fired (Vercel logs, the scheduler's history, the state page), then look
at code.

## Explaining changes to the user

The user is not a developer and does not read diffs. For every change:

1. **What you must do yourself**: accounts, sign-ups, Vercel env vars, Notion
   pages, dashboard settings, redeploys, step by step. If nothing, say "Nothing".
2. **What stops working**, or is removed or replaced, if that is not done.
3. **How to check it works.**

Rules:

- Ask before introducing any new outside service or account, and offer an
  option that does not need one.
- If a change removes something that used to work on its own (a cron, a
  default, an automatic step), say so plainly in the chat and at the top of the PR.
- Put user actions at the top of the PR under **"You must do this before it
  works"**, not in notes. Never write "already added" or "done" for a setup
  step you did not verify.
- New required setup also goes into the README's numbered Setup steps.
- Commit messages: say what changed in behaviour, not just a title.
