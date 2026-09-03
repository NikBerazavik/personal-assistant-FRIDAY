import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Timezone handling. This file exists because of one specific bug class:
// `new Date().toISOString()` returns UTC. The nightly cron fires at 23:00 UTC,
// which is 06:00 the NEXT day in Bangkok. Using the UTC date there would fetch
// yesterday's tasks every single morning. Everything below is deliberately
// computed in the configured local timezone instead.
// ---------------------------------------------------------------------------

const OFFSET = config.utcOffset;

/** "+07:00" -> 420. Used to shift instants into local wall-clock time. */
function offsetMinutes(offset = OFFSET) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`UTC_OFFSET must look like "+07:00", got "${offset}"`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Today's date in local time, as "YYYY-MM-DD". */
export function today(tz = config.timezone) {
  // "en-CA" formats as YYYY-MM-DD, which is exactly what Notion wants.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current local wall-clock time as "YYYY-MM-DD HH:MM", for the system prompt. */
export function nowLocal(tz = config.timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // Not `hour12: false`: some Intl builds render midnight as "24:00" with
    // that option. h23 is the unambiguous 00-23 clock.
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(",", "");
}

/** Local day of week, e.g. "Wednesday". */
export function weekdayLocal(tz = config.timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(new Date());
}

/** Add N days to a "YYYY-MM-DD" string. Uses UTC math to avoid DST drift. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Start-of-day instant for a local date, e.g. "2026-08-19T00:00:00+07:00". */
export function startOfDay(dateStr) {
  return `${dateStr}T00:00:00${OFFSET}`;
}

/** Monday (by default) of the week containing `dateStr`. 0 = Sunday. */
export function startOfWeek(dateStr, weekStartsOn = 1) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return addDays(dateStr, -((dow - weekStartsOn + 7) % 7));
}

/**
 * Normalises whatever date string Claude produces into something Notion
 * accepts. Date-only stays date-only (all-day task). A datetime without an
 * offset gets the local offset appended, so "2pm" means 2pm Bangkok rather
 * than 2pm UTC.
 */
export function normalizeDate(value) {
  if (!value) return null;
  const s = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // all-day
  if (/(Z|[+-]\d{2}:\d{2})$/.test(s)) return s; // already has an offset

  let t = s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ":00"; // add seconds
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) return t + OFFSET;

  return s; // let Notion reject anything malformed, with a clear error
}

/** True when a Notion date string carries a time-of-day. */
export const hasTime = (value) => typeof value === "string" && value.includes("T");

/**
 * Shifts a datetime by the same amount another one moved. Used to preserve
 * a task's duration when only its start is rescheduled: if 14:00-15:00 moves
 * to 16:00, the end becomes 17:00. Returns a local-offset ISO string.
 */
export function shiftDateTime(value, fromStart, toStart) {
  const delta = new Date(toStart).getTime() - new Date(fromStart).getTime();
  if (!Number.isFinite(delta)) return null;
  const shifted = new Date(value).getTime() + delta;
  // Render in local wall-clock time with the fixed offset, so the stored
  // value reads naturally in Notion rather than as a UTC "Z" timestamp.
  const local = new Date(shifted + offsetMinutes() * 60_000).toISOString().slice(0, 19);
  return `${local}${OFFSET}`;
}

/** Human-friendly rendering of a Notion date value for Telegram output. */
export function formatForDisplay(dateObj) {
  if (!dateObj?.start) return "unscheduled";
  if (!hasTime(dateObj.start)) return dateObj.start;

  const fmt = (iso) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));

  return dateObj.end ? `${fmt(dateObj.start)}-${fmt(dateObj.end)}` : fmt(dateObj.start);
}
