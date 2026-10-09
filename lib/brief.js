import { getTasks, getRecurringTasks, getNewestTaskByName, createTask } from "./notion.js";
import { sendMessage } from "./telegram.js";
import {
  today,
  addDays,
  weekdayLocal,
  hasTime,
  localDay,
  localTime,
  daysBetween,
  normalizeDate,
  shiftDateTime,
} from "./dates.js";

// ---------------------------------------------------------------------------
// This job is deliberately deterministic — no Claude call. In the morning you want a
// brief that is correct and free, not one that occasionally hallucinates. The
// conversational intelligence lives in the Telegram handler instead.
// ---------------------------------------------------------------------------

const CADENCES = ["Daily", "Weekly"];

/**
 * Where the next copy of a recurring task goes: same time of day and same
 * duration as `latest`, on day `next`. Returns { start, end }.
 */
function nextDates(latest, next) {
  const timed = hasTime(latest.date);
  const start = timed ? `${next}T${localTime(latest.date)}` : next;
  if (!latest.date_end) return { start };

  if (timed && hasTime(latest.date_end)) {
    return { start, end: shiftDateTime(latest.date_end, latest.date, normalizeDate(start)) };
  }
  if (!timed && !hasTime(latest.date_end)) {
    // A multi-day all-day task: keep its length in days.
    return { start, end: addDays(latest.date_end, daysBetween(latest.date, next)) };
  }
  return { start };
}

/**
 * Spawns the next instance of each recurring task.
 *
 * Idempotency is the whole problem here: this must be safe to run twice.
 * The approach is to group recurring tasks by name, find the newest instance
 * of each, and only create a successor if that newest instance is already in
 * the past. Once created, the newest instance is today, so a second run does
 * nothing. It also means a gap (you were away for a week) produces exactly one
 * new task, not seven backfilled ones.
 *
 * The newest instance is looked up by name regardless of its Recurring value,
 * and that value decides: set the newest copy's Recurring to None and the
 * series stops, even though older copies still say Daily or Weekly.
 * Cancelling or completing one copy does not stop the series.
 */
async function generateRecurring() {
  const recurring = await getRecurringTasks();
  const t = today();
  const created = [];

  // Newest flagged copy per name; the fallback if the name lookup finds nothing.
  const byName = new Map();
  for (const task of recurring) {
    if (!task.date) continue;
    const existing = byName.get(task.name);
    if (!existing || task.date > existing.date) byName.set(task.name, task);
  }

  for (const [name, flagged] of byName) {
    try {
      const latest = (await getNewestTaskByName(name)) || flagged;
      if (!CADENCES.includes(latest.recurring)) continue; // series stopped

      const latestDay = localDay(latest.date);
      if (latestDay >= t) continue; // an instance already exists for today or later

      let next = t;
      if (latest.recurring === "Weekly") {
        next = latestDay;
        while (next < t) next = addDays(next, 7);
      }

      const { start, end } = nextDates(latest, next);
      await createTask({
        name,
        domain: latest.domain || "Personal",
        date_start: start,
        date_end: end,
        priority: latest.priority,
        recurring: latest.recurring,
        tags: latest.tags,
        notes: latest.notes,
        project_ids: latest.project_ids,
      });
      created.push(`${name} -> ${next}`);
    } catch (err) {
      console.error(`Failed to spawn recurring task "${name}":`, err);
    }
  }

  return created;
}

function formatBrief(tasks, ongoing, overdue, { late = false } = {}) {
  const lines = [`Good morning. ${weekdayLocal()}, ${today()}.`];
  if (late) lines.push("(Sent late: the 09:00 run did not go through.)");
  lines.push("");

  const count = tasks.length + ongoing.length;
  if (count === 0) {
    lines.push("Nothing scheduled today.");
  } else {
    lines.push(`Today (${count}):`);
    for (const task of tasks) {
      const bits = [task.date_display, task.priority, task.domain].filter(Boolean);
      lines.push(`- ${task.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
    }
    // Multi-day tasks that started earlier and are still running.
    for (const task of ongoing) {
      const bits = [`ongoing until ${localDay(task.date_end)}`, task.priority, task.domain].filter(Boolean);
      lines.push(`- ${task.name} (${bits.join(", ")})`);
    }
  }

  if (overdue.length > 0) {
    lines.push("", `Overdue (${overdue.length}):`);
    for (const task of overdue.slice(0, 10)) {
      lines.push(`- ${task.name} (was ${localDay(task.date)})`);
    }
    if (overdue.length > 10) lines.push(`- ...and ${overdue.length - 10} more`);
  }

  return lines.join("\n");
}

/**
 * Spawns recurring tasks, builds the morning brief and sends it.
 * `late` adds a note that the brief missed its 09:00 slot.
 */
export async function runMorningBrief({ late = false } = {}) {
  const spawned = await generateRecurring();

  const [todayAll, ongoing, overdue] = await Promise.all([
    getTasks({ scope: "today" }),
    getTasks({ scope: "ongoing" }),
    getTasks({ scope: "overdue" }),
  ]);
  // The "today" query returns finished tasks too; the brief shouldn't list them.
  const tasks = todayAll.filter((t) => t.status !== "Done" && t.status !== "Cancelled");

  let brief = formatBrief(tasks, ongoing, overdue, { late });
  if (spawned.length) brief += `\n\n(Created ${spawned.length} recurring task(s).)`;

  await sendMessage(brief);
  return { today: tasks.length, ongoing: ongoing.length, overdue: overdue.length, spawned };
}
