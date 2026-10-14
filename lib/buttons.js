import { config } from "./config.js";
import { getTask, updateTask } from "./notion.js";
import { editMessage, editKeyboard } from "./telegram.js";
import {
  today,
  addDays,
  hasTime,
  localDay,
  localTime,
  localDateTime,
  daysBetween,
  shiftDateTime,
  normalizeDate,
  parseInstant,
} from "./dates.js";

// ---------------------------------------------------------------------------
// Tap-to-act buttons under the brief, reminders and the evening wrap-up.
//
// Telegram gives each button 64 bytes of "callback data", which comes back
// when it is tapped. Ours is "<action>:<page id without dashes>", so a tap is
// self-contained: nothing has to be remembered between sending and tapping.
//
// A message about one task shows that task's actions directly. A message
// about several shows one button per task; tapping a task opens its actions
// underneath it (tapping it again closes them). After an action, that task's
// buttons are removed and a line saying what happened is added to the
// message, so the message itself is the record.
// ---------------------------------------------------------------------------

const MAX_ROWS = 15; // tasks with buttons per message; Telegram allows 100 buttons
const LABEL_MAX = 48;

const ACTIONS = {
  d: { label: "✅ Done", past: "✅ Done" },
  h: { label: "⏰ +1h", past: "⏰ Moved" },
  t: { label: "➡️ Tomorrow", past: "➡️ Moved" },
  s: { label: "🗂 Someday", past: "🗂 Unscheduled" },
  x: { label: "✖️ Drop", past: "✖️ Dropped" },
};
const OUTCOME_PREFIXES = Object.values(ACTIONS).map((a) => a.past.split(" ")[0]);

const compact = (id) => id.replace(/-/g, "");
const expand = (id) =>
  id.length === 32 ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id;

/**
 * Which actions a task offers. A timed task that has not started yet can be
 * pushed back an hour. Anything else (all-day, or already in the past) can
 * instead be unscheduled ("Someday"), which takes it off the overdue list
 * without pretending it was done.
 */
export function actionsFor(task, now = new Date()) {
  const upcoming = task.date && hasTime(task.date) && parseInstant(task.date) > now;
  return upcoming ? ["d", "h", "t", "x"] : ["d", "t", "s", "x"];
}

const actionRow = (task, now) =>
  actionsFor(task, now).map((a) => ({ text: ACTIONS[a].label, callback_data: `${a}:${compact(task.page_id)}` }));

function nameLabel(task) {
  const time = task.date && hasTime(task.date) ? `${localTime(task.date)} ` : "";
  const label = `${time}${task.name}`;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** The keyboard for a message listing `tasks` (in display order). Empty when there is nothing to act on. */
export function taskKeyboard(tasks, now = new Date()) {
  const seen = new Set();
  const unique = tasks.filter((t) => t?.page_id && !seen.has(t.page_id) && seen.add(t.page_id));
  if (unique.length === 0) return [];
  if (unique.length === 1) return [actionRow(unique[0], now)];
  return unique.slice(0, MAX_ROWS).map((t) => [{ text: nameLabel(t), callback_data: `o:${compact(t.page_id)}` }]);
}

// --- Handling a tap ---------------------------------------------------------

const isNameRow = (row) => row.length === 1 && row[0].callback_data?.startsWith("o:");
const rowId = (row) => row[0]?.callback_data?.split(":")[1];

/** The keyboard with every open action row closed. */
const collapsed = (keyboard) => keyboard.filter(isNameRow);

/** The keyboard without any buttons for task `id`. */
const without = (keyboard, id) =>
  keyboard.filter((row) => !row.some((b) => b.callback_data?.split(":")[1] === id));

/** Adds an outcome line under the message, after a blank line the first time. */
export function appendOutcome(text, line) {
  const lines = String(text || "").trimEnd().split("\n");
  const last = lines[lines.length - 1] || "";
  const separator = OUTCOME_PREFIXES.some((p) => last.startsWith(p)) ? "\n" : "\n\n";
  return `${lines.join("\n")}${separator}${line}`;
}

const fmtWhen = (date) => {
  const day = localDay(date);
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${day}T12:00:00${config.utcOffset}`));
  return hasTime(date) ? `${label} ${localTime(date)}` : label;
};

/**
 * New dates for moving `task` to `day` at the same time of day, keeping its
 * length (a timed block keeps its duration, a multi-day range its days).
 */
export function datesOnDay(task, day) {
  if (!hasTime(task.date)) {
    const end = task.date_end && !hasTime(task.date_end) ? addDays(task.date_end, daysBetween(task.date, day)) : undefined;
    return { date_start: day, date_end: end };
  }
  const start = `${day}T${localTime(task.date)}`;
  const end = task.date_end ? shiftDateTime(task.date_end, task.date, normalizeDate(start)) : undefined;
  return { date_start: start, date_end: end || undefined };
}

/**
 * One hour later than the task's start, or one hour from now if the start
 * has already passed (so the new time is never in the past).
 */
export function datesPlusHour(task, now = new Date()) {
  const start = parseInstant(task.date);
  const base = start > now ? start : now;
  // Rounded up to the next 5 minutes when counting from now.
  const next = new Date(Math.ceil((base.getTime() + 60 * 60_000) / (5 * 60_000)) * 5 * 60_000);
  const local = localDateTime(next);
  const end = task.date_end ? shiftDateTime(task.date_end, task.date, normalizeDate(local)) : undefined;
  return { date_start: local, date_end: end || undefined };
}

/** Applies action `a` to `task` in Notion. Returns the outcome line for the message. */
async function apply(a, task, now) {
  switch (a) {
    case "d":
      await updateTask({ page_id: task.page_id, status: "Done" });
      return `✅ Done: ${task.name}`;
    case "x":
      await updateTask({ page_id: task.page_id, status: "Cancelled" });
      return `✖️ Dropped: ${task.name}`;
    case "s":
      await updateTask({ page_id: task.page_id, clear_date: true });
      return `🗂 Unscheduled: ${task.name}`;
    case "t": {
      const dates = datesOnDay(task, addDays(today(), 1));
      await updateTask({ page_id: task.page_id, ...dates });
      return `➡️ Moved: ${task.name}, ${fmtWhen(normalizeDate(dates.date_start))}`;
    }
    case "h": {
      if (!task.date || !hasTime(task.date)) throw new Error("this task has no time to move");
      const dates = datesPlusHour(task, now);
      await updateTask({ page_id: task.page_id, ...dates });
      return `⏰ Moved: ${task.name}, ${fmtWhen(normalizeDate(dates.date_start))}`;
    }
    default:
      throw new Error(`unknown action "${a}"`);
  }
}

/**
 * Handles one button tap. `query` is Telegram's callback_query. Returns
 * { toast, outcome }: `toast` is the short pop-up text, `outcome` the line
 * added to the message (or null when nothing changed in Notion), which the
 * caller also keeps as conversation memory.
 */
export async function handleCallback(query, now = new Date()) {
  const message = query.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const keyboard = message?.reply_markup?.inline_keyboard || [];
  const [a, rawId] = String(query.data || "").split(":");
  if (!rawId) return { toast: null, outcome: null };

  // Open or close a task's actions (several-task messages).
  if (a === "o") {
    const i = keyboard.findIndex((row) => isNameRow(row) && rowId(row) === rawId);
    const isOpen = i >= 0 && keyboard[i + 1] && !isNameRow(keyboard[i + 1]);
    const base = collapsed(keyboard);
    if (isOpen) {
      await editKeyboard(chatId, messageId, base);
      return { toast: null, outcome: null };
    }
    const task = await getTask(expand(rawId));
    if (!task) {
      await editKeyboard(chatId, messageId, without(base, rawId));
      return { toast: "That task no longer exists.", outcome: null };
    }
    const next = [];
    for (const row of base) {
      next.push(row);
      if (rowId(row) === rawId) next.push(actionRow(task, now));
    }
    await editKeyboard(chatId, messageId, next);
    return { toast: null, outcome: null };
  }

  if (!ACTIONS[a]) return { toast: null, outcome: null };

  const task = await getTask(expand(rawId));
  const remaining = collapsed(without(keyboard, rawId));
  if (!task) {
    await editKeyboard(chatId, messageId, remaining);
    return { toast: "That task no longer exists.", outcome: null };
  }

  const outcome = await apply(a, task, now);
  try {
    await editMessage(chatId, messageId, appendOutcome(message.text, outcome), remaining);
  } catch (err) {
    // The change is saved in Notion; a failed edit only leaves stale buttons.
    console.error("Could not update the message after a button tap:", err.message);
  }
  return { toast: outcome, outcome };
}
