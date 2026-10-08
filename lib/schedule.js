import { config } from "./config.js";
import { today, addDays, hasTime } from "./dates.js";

// ---------------------------------------------------------------------------
// Reminder slots. Vercel's free plan only allows one cron run per day, so an
// external scheduler (cron-job.org) calls /api/tick every 30 minutes and this
// file decides whether a slot is due. Changing a time here is a code change;
// nothing needs updating in the scheduler.
//
// The first slot is the full morning brief. Every other slot is a quiet
// reminder: it covers timed tasks starting between that slot and the next one,
// and sends nothing if there are none. The last slot runs through to the
// first slot of the following day.
// ---------------------------------------------------------------------------
export const SLOTS = ["09:00", "11:00", "12:30", "15:00", "18:00", "21:00"];
export const BRIEF_SLOT = SLOTS[0];

// The scheduler ticks every 30 minutes, so a slot is "due" for that long.
const SLOT_WINDOW_MIN = 30;

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Current local wall-clock time as "HH:MM". */
export function nowHHMM(now = new Date(), tz = config.timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

/** The slot that is due right now, or null between slots. */
export function dueSlot(now = new Date()) {
  const mins = toMinutes(nowHHMM(now));
  return (
    SLOTS.find((s) => {
      const delta = mins - toMinutes(s);
      return delta >= 0 && delta < SLOT_WINDOW_MIN;
    }) || null
  );
}

// Minimum notice. Every window is shifted this far ahead, so a task is never
// announced less than this long before it starts.
export const LEAD_MIN = 30;

export const localDate = (d, tz = config.timezone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/**
 * The reminder windows for a slot, as [start, end) instants. Window 0 runs
 * from this slot's time + lead to the next slot's time + lead; window 1 is the
 * one after that. Slots wrap past midnight into the following day.
 */
export function slotWindows(slot, date = today(), count = 2) {
  const i = SLOTS.indexOf(slot);
  if (i < 0) throw new Error(`Unknown slot "${slot}"`);
  const n = SLOTS.length;
  const instant = (k) => {
    const day = addDays(date, Math.floor(k / n));
    const base = new Date(`${day}T${SLOTS[k % n]}:00${config.utcOffset}`);
    return new Date(base.getTime() + LEAD_MIN * 60_000);
  };
  return Array.from({ length: count }, (_, j) => ({
    start: instant(i + j),
    end: instant(i + j + 1),
  }));
}

/** Parses a Notion date string; a time without an offset is local time. */
function parseStart(value) {
  const s = /(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}${config.utcOffset}`;
  return new Date(s);
}

/** Timed, unfinished tasks whose start falls in [start, end). */
export function tasksInWindow(tasks, start, end) {
  return tasks
    .filter((t) => t.status !== "Done" && t.status !== "Cancelled")
    .filter((t) => hasTime(t.date))
    .filter((t) => {
      const at = parseStart(t.date);
      return at >= start && at < end;
    })
    .sort((a, b) => parseStart(a.date) - parseStart(b.date));
}

/** "HH:MM", with " tomorrow" when the instant is not on `date`. */
function label(instant, date) {
  const t = nowHHMM(instant);
  return localDate(instant) === date ? t : `${t} tomorrow`;
}

function section(title, window, tasks, date) {
  const lines = [`${title} (${label(window.start, date)}-${label(window.end, date)}):`];
  for (const t of tasks) {
    const bits = [t.priority, t.domain].filter(Boolean);
    lines.push(`- ${t.date_display} ${t.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

/** `groups` is [{ window, tasks }, ...]; empty groups are left out. */
export function formatReminder(groups, date = today()) {
  const titles = ["Coming up", "After that"];
  return groups
    .map((g, i) => (g.tasks.length ? section(titles[i] || "Later", g.window, g.tasks, date) : null))
    .filter(Boolean)
    .join("\n\n");
}
