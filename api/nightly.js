import { getTasks, getRecurringTasks, createTask } from "../lib/notion.js";
import { sendMessage } from "../lib/telegram.js";
import { today, addDays, weekdayLocal } from "../lib/dates.js";

// ---------------------------------------------------------------------------
// This job is deliberately deterministic — no Claude call. At 6am you want a
// brief that is correct and free, not one that occasionally hallucinates. The
// conversational intelligence lives in the Telegram handler instead.
// ---------------------------------------------------------------------------

/**
 * Spawns the next instance of each recurring task.
 *
 * Idempotency is the whole problem here: this must be safe to run twice.
 * The approach is to group recurring tasks by name, find the newest instance
 * of each, and only create a successor if that newest instance is already in
 * the past. Once created, the newest instance is today, so a second run does
 * nothing. It also means a gap (you were away for a week) produces exactly one
 * new task, not seven backfilled ones.
 */
async function generateRecurring() {
  const recurring = await getRecurringTasks();
  const t = today();
  const created = [];

  const byName = new Map();
  for (const task of recurring) {
    if (!task.date) continue;
    const existing = byName.get(task.name);
    if (!existing || task.date > existing.date) byName.set(task.name, task);
  }

  for (const [name, latest] of byName) {
    const latestDay = latest.date.slice(0, 10);
    if (latestDay >= t) continue; // an instance already exists for today or later

    let next;
    if (latest.recurring === "Daily") {
      next = t;
    } else if (latest.recurring === "Weekly") {
      next = latestDay;
      while (next < t) next = addDays(next, 7);
    } else {
      continue;
    }

    // Preserve the time-of-day from the previous instance if it had one.
    const timePart = latest.date.length > 10 ? latest.date.slice(10, 16) : "";
    const dateStart = timePart ? `${next}T${timePart.replace("T", "")}` : next;

    try {
      await createTask({
        name,
        domain: latest.domain || "Personal",
        date_start: dateStart,
        priority: latest.priority,
        recurring: latest.recurring,
        tags: latest.tags,
        notes: latest.notes,
      });
      created.push(`${name} -> ${next}`);
    } catch (err) {
      console.error(`Failed to spawn recurring task "${name}":`, err);
    }
  }

  return created;
}

function formatBrief(tasks, overdue) {
  const lines = [`Good morning. ${weekdayLocal()}, ${today()}.`, ""];

  if (tasks.length === 0) {
    lines.push("Nothing scheduled today.");
  } else {
    lines.push(`Today (${tasks.length}):`);
    for (const task of tasks) {
      const bits = [task.date_display, task.priority, task.domain].filter(Boolean);
      lines.push(`- ${task.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
    }
  }

  if (overdue.length > 0) {
    lines.push("", `Overdue (${overdue.length}):`);
    for (const task of overdue.slice(0, 10)) {
      lines.push(`- ${task.name} (was ${task.date?.slice(0, 10)})`);
    }
  }

  return lines.join("\n");
}

export default async function handler(req, res) {
  // Vercel signs scheduled invocations with CRON_SECRET as a bearer token.
  // Without this check, the URL is public and anyone could trigger it.
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const spawned = await generateRecurring();

    const [tasks, overdue] = await Promise.all([
      getTasks({ scope: "today" }),
      getTasks({ scope: "overdue" }),
    ]);

    let brief = formatBrief(tasks, overdue);
    if (spawned.length) brief += `\n\n(Created ${spawned.length} recurring task(s).)`;

    await sendMessage(brief);
    return res.status(200).json({ ok: true, today: tasks.length, overdue: overdue.length, spawned });
  } catch (err) {
    console.error("Nightly job failed:", err);
    await sendMessage(`Morning brief failed: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
