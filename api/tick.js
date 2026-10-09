import { runMorningBrief } from "../lib/brief.js";
import { getTasks } from "../lib/notion.js";
import { sendMessage } from "../lib/telegram.js";
import { authorized } from "../lib/auth.js";
import { today, addDays } from "../lib/dates.js";
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
} from "../lib/schedule.js";

// Called every 30 minutes by an external scheduler (see README). Deterministic,
// no Claude call. Each tick does up to three independent jobs, in this order,
// so a failure or a slow site in one never blocks the others:
//  1. the morning brief (once a day, from 09:00);
//  2. the MacBook watcher (once a day, after the brief);
//  3. the reminder or preview for the slot that is due now, if any.
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

  // 1. Morning brief.
  if (forced ? forced === BRIEF_SLOT : dailyDue(now, doneToday("brief"))) {
    if (dry) {
      result.brief = "due (dry run, not generated)";
    } else {
      try {
        result.brief = await runMorningBrief({ late: !forced && dueSlot(now) !== BRIEF_SLOT });
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
      result.reminder = await runReminder(slot, date, dry);
      if (result.reminder.sent) await markDone(slot);
    } catch (err) {
      failed = true;
      console.error(`Tick ${slot} failed:`, err);
      result.reminder = { error: err.message };
      await reportFailure(slot, `Reminder check (${slot}) failed: ${err.message}`);
    }
  }

  return res.status(failed ? 500 : 200).json(result);
}

/** Builds and sends the reminder (or, at PREVIEW_SLOT, the preview) for `slot`. */
async function runReminder(slot, date, dry) {
  let groups, message;
  if (slot === PREVIEW_SLOT) {
    const tasks = await getTasks({ date_from: date, date_to: addDays(date, 1) });
    groups = previewGroups(tasks, date);
    message = () => formatPreview(groups);
  } else {
    const windows = slotWindows(slot, date);
    const lastEnd = windows[windows.length - 1].end;
    const tasks = await getTasks({ date_from: date, date_to: localDate(lastEnd) });
    groups = windows.map((window) => ({ window, tasks: tasksInWindow(tasks, window.start, window.end) }));
    message = () => formatReminder(groups, date);
  }

  const count = groups.reduce((n, g) => n + g.tasks.length, 0);
  if (count === 0) return { sent: false, count };
  if (dry) return { sent: false, count, message: message() };
  await sendMessage(message());
  return { sent: true, count };
}
