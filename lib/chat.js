// ---------------------------------------------------------------------------
// Short-term memory for the Telegram chat, kept on the state page
// (lib/state.js) because Vercel keeps nothing between messages.
//
//  - `chat`: the last few exchanges, so "add dentist Friday" followed by
//    "make it 3pm" works without replying to a message. Only what was said is
//    kept, not tool results, so the agent still looks tasks up before
//    changing them. Exchanges older than MEMORY_MINUTES are ignored: a
//    follow-up comes within minutes, and an old conversation would only
//    confuse a new request.
//  - `handled`: ids of recently processed updates. Telegram re-sends an
//    update when it thinks delivery failed (a slow or crashed run). Without
//    this, a re-sent "add X" would add X twice, and a re-sent "+1h" tap
//    would move a task two hours.
// ---------------------------------------------------------------------------

const MEMORY_EXCHANGES = 4;
const MEMORY_MINUTES = 60;
const HANDLED_KEEP = 50;
const TEXT_LIMIT = 1500;

/** Stored exchanges still inside the memory window, with their timestamps. */
function current(store, now) {
  const list = Array.isArray(store?.state.chat) ? store.state.chat : [];
  return list.filter((e) => e && now - Date.parse(e.at) < MEMORY_MINUTES * 60_000).slice(-MEMORY_EXCHANGES);
}

/** Recent exchanges as [{ user, assistant }], oldest first. */
export function recentExchanges(store, now = Date.now()) {
  return current(store, now).map(({ user, assistant }) => ({ user, assistant }));
}

/** Records one exchange. Best effort: a failed save only costs memory. */
export async function remember(store, user, assistant, now = new Date()) {
  if (!store) return;
  const list = [...current(store, now.getTime()), { at: now.toISOString(), user: clip(user), assistant: clip(assistant) }];
  await store
    .save({ chat: list.slice(-MEMORY_EXCHANGES) })
    .catch((err) => console.error("Could not save chat memory:", err.message));
}

/**
 * True if any of `keys` was already handled. Otherwise records them all as
 * handled (before the work starts, so a re-send that arrives mid-run is
 * caught too).
 */
export async function alreadyHandled(store, ...keys) {
  if (!store) return false;
  const handled = Array.isArray(store.state.handled) ? store.state.handled : [];
  if (keys.some((k) => handled.includes(k))) return true;
  await store
    .save({ handled: [...handled, ...keys].slice(-HANDLED_KEEP) })
    .catch((err) => console.error("Could not record handled update:", err.message));
  return false;
}

const clip = (s) => {
  const text = String(s || "");
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
};
