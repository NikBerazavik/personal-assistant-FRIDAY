import { runMorningBrief } from "../lib/brief.js";
import { getTasks } from "../lib/notion.js";
import { sendMessage } from "../lib/telegram.js";
import { authorized } from "../lib/auth.js";
import { today, addDays } from "../lib/dates.js";
import { runWatcher } from "../lib/watcher.js";
import {
  BRIEF_SLOT,
  PREVIEW_SLOT,
  previewGroups,
  formatPreview,
  SLOTS,
  dueSlot,
  slotWindows,
  localDate,
  tasksInWindow,
  formatReminder,
} from "../lib/schedule.js";

// Called every 30 minutes by an external scheduler (see README). Does nothing
// unless a slot is due. Deterministic, no Claude call.
//
// Testing: ?slot=11:00 forces a slot; &dry=1 returns the message instead of
// sending it.
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const url = new URL(req.url, "http://localhost");
  const forced = url.searchParams.get("slot");
  const dry = url.searchParams.get("dry") === "1";
  if (forced && !SLOTS.includes(forced)) {
    return res.status(400).json({ error: `slot must be one of ${SLOTS.join(", ")}` });
  }

  const slot = forced || dueSlot();
  if (!slot) return res.status(200).json({ ok: true, slot: null });

  try {
    if (slot === BRIEF_SLOT) {
      // The watcher is a separate message and must never block the brief.
      const watcher = await runWatcher({ dry }).catch(async (err) => {
        console.error("MacBook watcher failed:", err);
        if (!dry) await sendMessage(`MacBook watcher failed: ${err.message}`).catch(() => {});
        return { error: err.message };
      });
      if (dry) return res.status(200).json({ ok: true, slot, note: "brief (dry run, not generated)", watcher });
      return res.status(200).json({ ok: true, slot, ...(await runMorningBrief()), watcher });
    }

    const date = today();

    if (slot === PREVIEW_SLOT) {
      const tasks = await getTasks({ date_from: date, date_to: addDays(date, 1) });
      const groups = previewGroups(tasks, date);
      const count = groups.reduce((n, g) => n + g.tasks.length, 0);
      if (count === 0) return res.status(200).json({ ok: true, slot, sent: false });

      const message = formatPreview(groups);
      if (dry) return res.status(200).json({ ok: true, slot, sent: false, message });
      await sendMessage(message);
      return res.status(200).json({ ok: true, slot, sent: true, count });
    }

    const windows = slotWindows(slot, date);
    const lastEnd = windows[windows.length - 1].end;
    const tasks = await getTasks({ date_from: date, date_to: localDate(lastEnd) });
    const groups = windows.map((window) => ({
      window,
      tasks: tasksInWindow(tasks, window.start, window.end),
    }));
    const count = groups.reduce((n, g) => n + g.tasks.length, 0);

    if (count === 0) return res.status(200).json({ ok: true, slot, sent: false });

    const message = formatReminder(groups, date);
    if (dry) return res.status(200).json({ ok: true, slot, sent: false, message });
    await sendMessage(message);
    return res.status(200).json({ ok: true, slot, sent: true, count });
  } catch (err) {
    console.error(`Tick ${slot} failed:`, err);
    await sendMessage(`Reminder check (${slot}) failed: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
