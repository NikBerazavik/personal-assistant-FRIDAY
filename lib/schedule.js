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
// and sends nothing if there are none. The last slot (PREVIEW_SLOT) previews
// later tonight and tomorrow morning instead.
// ---------------------------------------------------------------------------
export const SLOTS = ["09:00", "11:00", "12:30", "15:00", "18:00", "21:00"];
export const BRIEF_SLOT = SLOTS[0];

// The last slot of the day does not look at the next few hours. It previews
// tomorrow morning instead, so there is time to prepare overnight.
export const PREVIEW_SLOT = "21:00";
export const PREVIEW_END = "12:30"; // tomorrow's preview runs up to this time

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

// Once-a-day jobs (the brief, the MacBook watcher) start at BRIEF_SLOT. If a
// run is missed or fails, later ticks retry until this time.
export const DAILY_UNTIL = PREVIEW_SLOT;

/**
 * Whether a once-a-day job should run now. `doneToday` is true/false from
 * the state page; undefined means there is no state page, and then only the
 * BRIEF_SLOT window counts (no retries, as before).
 */
export function dailyDue(now = new Date(), doneToday) {
  if (doneToday === undefined) return dueSlot(now) === BRIEF_SLOT;
  const mins = toMinutes(nowHHMM(now));
  return !doneToday && mins >= toMinutes(BRIEF_SLOT) && mins < toMinutes(DAILY_UNTIL);
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
 *
 * Windows stop where PREVIEW_SLOT's window would begin: the preview message
 * already covers later tonight and tomorrow morning, so 18:00 does not repeat
 * it as "After that".
 */
export function slotWindows(slot, date = today(), count = 2) {
  const i = SLOTS.indexOf(slot);
  if (i < 0) throw new Error(`Unknown slot "${slot}"`);
  const n = SLOTS.length;
  const p = SLOTS.indexOf(PREVIEW_SLOT);
  const instant = (k) => {
    const day = addDays(date, Math.floor(k / n));
    const base = new Date(`${day}T${SLOTS[k % n]}:00${config.utcOffset}`);
    return new Date(base.getTime() + LEAD_MIN * 60_000);
  };
  const windows = [];
  for (let j = 0; j < count; j++) {
    if (j > 0 && (i + j) % n === p) break;
    windows.push({ start: instant(i + j), end: instant(i + j + 1) });
  }
  return windows;
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

const isOpen = (t) => t.status !== "Done" && t.status !== "Cancelled";

/**
 * What the PREVIEW_SLOT message covers, as [{ title, tasks }]:
 *  - "Later tonight": timed tasks from this slot + lead until midnight, so
 *    replacing the old rolling window does not drop an evening task.
 *  - "Tomorrow morning": all-day tasks for tomorrow, then timed tasks from
 *    00:00 until PREVIEW_END.
 */
export function previewGroups(tasks, date = today()) {
  const tomorrow = addDays(date, 1);
  const at = (day, hhmm) => new Date(`${day}T${hhmm}:00${config.utcOffset}`);

  const tonightStart = new Date(at(date, PREVIEW_SLOT).getTime() + LEAD_MIN * 60_000);
  const tonight = tasksInWindow(tasks, tonightStart, at(tomorrow, "00:00"));

  const allDay = tasks.filter(isOpen).filter((t) => t.date && !hasTime(t.date) && t.date.slice(0, 10) === tomorrow);
  const timed = tasksInWindow(tasks, at(tomorrow, "00:00"), at(tomorrow, PREVIEW_END));

  return [
    { title: `Later tonight (${label(tonightStart, date)}-24:00)`, tasks: tonight },
    { title: `Tomorrow ${tomorrow}, all day`, tasks: allDay },
    { title: `Tomorrow morning (00:00-${PREVIEW_END})`, tasks: timed },
  ];
}

export function formatPreview(groups) {
  return groups
    .filter((g) => g.tasks.length)
    .map((g) => {
      const lines = [`${g.title}:`];
      for (const t of g.tasks) {
        const bits = [t.priority, t.domain].filter(Boolean);
        const when = hasTime(t.date) ? `${t.date_display} ` : "";
        lines.push(`- ${when}${t.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
