import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Timezone handling. This file exists because of one specific bug class:
// `new Date().toISOString()` returns UTC. The nightly cron fires at 23:00 UTC,
// which is 06:00 the NEXT day in Bangkok. Using the UTC date there would fetch
// yesterday's tasks every single morning. Everything below is deliberately
// computed in the configured local timezone instead.
// ---------------------------------------------------------------------------

const OFFSET = config.utcOffset;

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
    hour12: false,
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

export function startOfWeek(dateStr, weekStartsOn = 1) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); //0=Sunday
  return addDays(dateStr, -((dow - weekStartsOn + 7) %7));
}

/** Human-friendly rendering of a Notion date value for Telegram output. */
export function formatForDisplay(dateObj) {
  if (!dateObj?.start) return "unscheduled";
  const hasTime = dateObj.start.includes("T");
  if (!hasTime) return dateObj.start;

  const fmt = (iso) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));

  return dateObj.end ? `${fmt(dateObj.start)}-${fmt(dateObj.end)}` : fmt(dateObj.start);
}
