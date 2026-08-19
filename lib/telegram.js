import { config } from "./config.js";

const TELEGRAM_LIMIT = 4096;

/**
 * Sends a message to your chat. Deliberately sends plain text: Telegram's
 * Markdown parser rejects the whole message if it sees an unescaped "_" or
 * "*", and task names contain those often enough to matter. Reliability beats
 * formatting here.
 */
export async function sendMessage(text, chatId = config.telegram.chatId()) {
  const chunks = splitMessage(String(text || "").trim() || "(empty response)");

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      }
    );

    if (!res.ok) {
      console.error("Telegram sendMessage failed:", res.status, await res.text());
    }
  }
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
