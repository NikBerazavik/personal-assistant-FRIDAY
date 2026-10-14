import { runMorningBrief } from "../lib/brief.js";
import { getTasks } from "../lib/notion.js";
import { sendMessage, ensureButtonUpdates } from "../lib/telegram.js";
import { taskKeyboard } from "../lib/buttons.js";
import { authorized } from "../lib/auth.js";
import { today, addDays, daysBetween } from "../lib/dates.js";
import { runWatcher } from "../lib/watcher.js";
import { openStore } from "../lib/state.js";
import {
  BRIEF_SLOT,
  PREVIEW_SLOT,
  previewGroups,
  formatPreview,
  SLOTS,
  dueSlot,
  dailyDue,
  slotWindows,
  localDate,
  tasksInWindow,
  formatReminder,
  wrapUpGroups,
  formatWrapUp,
  tasksToPing,
  pingKey,
  formatPing,
} from "../lib/schedule.js";

// Called every 30 minutes by an external scheduler (see README). Deterministic,
// no Claude call. Each tick does up to five independent jobs, in this order,
// so a failure or a slow site in one never blocks the others:
//  1. the morning brief (once a day, from 09:00);
//  2. the MacBook watcher (once a day, after the brief);
//  3. the reminder for the slot that is due now, if any (at 21:00: the
//     evening wrap-up and the preview of tomorrow);
//  4. a ping for timed tasks starting in this half hour;
//  5. once a day, a check that Telegram delivers button taps.
//
// What already ran today is recorded on the state page (lib/state.js). That
// record is what lets a missed or failed 09:00 brief go out on a later tick,
// and stops a repeated tick from sending the same message twice. Without the
// state page, jobs run only inside their slot window.
//
// Testing: ?slot=11:00 forces a slot (ignoring what already ran today);
// &dry=1 returns the messages instead of sending them, and records nothing.
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const url = new URL(req.url, "http://localhost");
  const forced = url.searchParams.get("slot");
  const dry = url.searchParams.get("dry") === "1";
  if (forced && !SLOTS.includes(forced)) {
    return res.status(400).json({ error: `slot must be one of ${SLOTS.join(", ")}` });
  }

  const now = new Date();
  const date = today();

  let storeError = null;
  const store = await openStore().catch((err) => {
    storeError = err;
    console.error("State page unavailable:", err.message);
    return null;
  });
  // true/false from the state page; undefined when there is no state page.
  const doneToday = (key) => (store ? store.state.done?.[key] === date : undefined);
  const markDone = async (key) => {
    if (dry || !store) return;
    await store
      .save({ done: { ...store.state.done, [key]: date } })
      .catch((err) => console.error(`Could not record ${key} as done:`, err.message));
  };
  // A failing job is retried on later ticks; report it once a day, not on every retry.
  const reportFailure = async (key, text) => {
    if (dry || doneToday(`${key} failure reported`)) return;
    try {
      await sendMessage(text);
      await markDone(`${key} failure reported`);
    } catch {} // Telegram itself is failing; the next retry tries again
  };
  const retryNote = store ? " (retrying every 30 minutes until 21:00)" : "";

  const slot = forced || dueSlot(now);
  const result = { ok: true, slot };
  let failed = false;
  // Tasks already listed by this tick's brief; they are not pinged on top.
  const shown = new Set();

  // 1. Morning brief.
  if (forced ? forced === BRIEF_SLOT : dailyDue(now, doneToday("brief"))) {
    if (dry) {
      result.brief = "due (dry run, not generated)";
    } else {
      try {
        result.brief = await runMorningBrief({ late: !forced && dueSlot(now) !== BRIEF_SLOT });
        result.brief.shown.forEach((id) => shown.add(id));
        await markDone("brief");
      } catch (err) {
        failed = true;
        console.error("Morning brief failed:", err);
        result.brief = { error: err.message };
        await reportFailure("brief", `Morning brief failed: ${err.message}${retryNote}`);
      }
    }
  }

  // 2. MacBook watcher. Runs after the brief so it can never hold the brief up.
  if (forced ? forced === BRIEF_SLOT : dailyDue(now, doneToday("watcher"))) {
    try {
      if (!store) throw storeError;
      result.watcher = await runWatcher({ store, dry });
      await markDone("watcher");
    } catch (err) {
      console.error("MacBook watcher failed:", err);
      result.watcher = { error: err.message };
      await reportFailure("watcher", `MacBook watcher failed: ${err.message}${retryNote}`);
    }
  }

  // 3. Reminder or preview for the slot due now.
  if (slot && slot !== BRIEF_SLOT && (forced || !doneToday(slot))) {
    try {
      result.reminder = await runReminder(slot, date, { dry, store, now });
      if (result.reminder.sent) await markDone(slot);
    } catch (err) {
      failed = true;
      console.error(`Tick ${slot} failed:`, err);
      result.reminder = { error: err.message };
      await reportFailure(slot, `Reminder check (${slot}) failed: ${err.message}`);
    }
  }

  // 4. Exact-time pings. Not retried: a ping that misses its half hour is late.
  try {
    result.pings = await runPings(date, { dry, store, now, shown });
  } catch (err) {
    failed = true;
    console.error("Pings failed:", err);
    result.pings = { error: err.message };
    await reportFailure("pings", `Reminder pings failed: ${err.message}`);
  }

  // 5. Buttons only work if Telegram sends taps to the bot. A webhook
  // registered before buttons existed only asks for messages; fix that here
  // rather than relying on a manual step.
  if (!dry && doneToday("webhook check") !== true) {
    try {
      result.webhookFixed = await ensureButtonUpdates();
      await markDone("webhook check");
    } catch (err) {
      console.error("Webhook check failed:", err.message);
      result.webhookFixed = { error: err.message };
    }
  }

  return res.status(failed ? 500 : 200).json(result);
}

/**
 * Builds and sends the reminder for `slot`. At PREVIEW_SLOT that is two
 * messages: the evening wrap-up (with buttons), then the preview of later
 * tonight and tomorrow morning.
 */
async function runReminder(slot, date, { dry, store, now }) {
  if (slot === PREVIEW_SLOT) return runEvening(date, { dry, store, now });

  const windows = slotWindows(slot, date);
  const lastEnd = windows[windows.length - 1].end;
  const tasks = await getTasks({ date_from: date, date_to: localDate(lastEnd) });
  const groups = windows.map((window) => ({ window, tasks: tasksInWindow(tasks, window.start, window.end) }));

  const listed = groups.flatMap((g) => g.tasks);
  if (listed.length === 0) return { sent: false, count: 0 };
  const message = formatReminder(groups, date);
  if (dry) return { sent: false, count: listed.length, message };
  await sendMessage(message, { keyboard: taskKeyboard(listed, now) });
  return { sent: true, count: listed.length };
}

async function runEvening(date, { dry, store, now }) {
  const [tasks, overdue] = await Promise.all([
    getTasks({ date_from: date, date_to: addDays(date, 1) }),
    getTasks({ scope: "overdue" }),
  ]);

  const asked = store?.state.staleAsked || {};
  const wrap = wrapUpGroups(tasks, overdue, { date, now, asked });
  const wrapTasks = [...wrap.leftover, ...wrap.stale];
  const wrapMessage = wrapTasks.length ? formatWrapUp(wrap) : null;

  const groups = previewGroups(tasks, date);
  const previewCount = groups.reduce((n, g) => n + g.tasks.length, 0);
  const previewMessage = previewCount ? formatPreview(groups) : null;

  const result = { sent: false, wrapUp: wrapTasks.length, preview: previewCount };
  if (dry) return { ...result, wrapMessage, previewMessage };

  if (wrapMessage) {
    await sendMessage(wrapMessage, { keyboard: taskKeyboard(wrapTasks, now) });
    result.sent = true;
    if (store && wrap.stale.length) {
      // Remember who was asked; forget entries older than a month.
      const kept = Object.fromEntries(Object.entries(asked).filter(([, d]) => daysBetween(d, date) < 30));
      for (const t of wrap.stale) kept[t.page_id] = date;
      await store.save({ staleAsked: kept }).catch((err) => console.error("Could not save staleAsked:", err.message));
    }
  }
  if (previewMessage) {
    await sendMessage(previewMessage);
    result.sent = true;
  }
  return result;
}

/** Pings timed tasks starting in this half hour (see lib/schedule.js). */
async function runPings(date, { dry, store, now, shown }) {
  const tasks = await getTasks({ date_from: date, date_to: addDays(date, 1) });
  const pinged = store?.state.pinged || {};
  const due = tasksToPing(tasks, now, pinged);
  const toSend = due.filter((t) => !shown.has(t.page_id));
  if (due.length === 0) return { sent: 0 };
  if (dry) return { sent: 0, message: toSend.length ? formatPing(toSend) : null };

  if (toSend.length) await sendMessage(formatPing(toSend), { keyboard: taskKeyboard(toSend, now) });
  if (store) {
    // Tasks the brief just listed count as pinged too. Forget entries after two days.
    const kept = Object.fromEntries(Object.entries(pinged).filter(([, d]) => daysBetween(d, date) < 2));
    for (const t of due) kept[pingKey(t)] = date;
    await store.save({ pinged: kept }).catch((err) => console.error("Could not save pinged:", err.message));
  }
  return { sent: toSend.length };
}
