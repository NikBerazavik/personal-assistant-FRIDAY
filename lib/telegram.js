import { config } from "./config.js";

const TELEGRAM_LIMIT = 4096;
const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_S = 10;

/**
 * Sends a message to your chat. Deliberately sends plain text: Telegram's
 * Markdown parser rejects the whole message if it sees an unescaped "_" or
 * "*", and task names contain those often enough to matter. Reliability beats
 * formatting here.
 *
 * Throws if Telegram does not accept the message, so callers never mistake
 * an undelivered message (a brief, a watcher alert) for a delivered one.
 */
export async function sendMessage(text, chatId = config.telegram.chatId()) {
  const chunks = splitMessage(String(text || "").trim() || "(empty response)");
  for (const chunk of chunks) await sendChunk(chunk, chatId);
}

/** One sendMessage call. Retries once when Telegram asks us to slow down or has a server error. */
async function sendChunk(text, chatId, attempt = 1) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Not the raw error: keep the bot token (it is in the URL) out of logs.
    throw new Error(`Telegram sendMessage failed: ${err.name === "TimeoutError" ? `no response in ${TIMEOUT_MS / 1000}s` : err.name}`);
  }
  if (res.ok) return;

  const body = await res.text();
  if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
    let wait = 1;
    try {
      wait = JSON.parse(body).parameters?.retry_after ?? 1;
    } catch {}
    if (wait <= MAX_RETRY_WAIT_S) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return sendChunk(text, chatId, 2);
    }
  }
  throw new Error(`Telegram sendMessage failed (${res.status}): ${body.slice(0, 200)}`);
}

function splitMessage(text) {
  if (text.length <= TELEGRAM_LIMIT) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_LIMIT) {
    // Prefer breaking on a newline so we don't cut a task name in half.
    let cut = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT * 0.5) cut = TELEGRAM_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
