import { config } from "./config.js";

const TELEGRAM_LIMIT = 4096;
const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_S = 10;

/**
 * One Bot API call. Retries once when Telegram asks us to slow down or has a
 * server error. Throws on failure, with the bot token kept out of the message
 * (it is part of the URL).
 */
export async function telegramApi(method, body, attempt = 1) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Telegram ${method} failed: ${err.name === "TimeoutError" ? `no response in ${TIMEOUT_MS / 1000}s` : err.name}`);
  }

  const text = await res.text();
  if (res.ok) {
    try {
      return JSON.parse(text).result;
    } catch {
      return null;
    }
  }

  if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
    let wait = 1;
    try {
      wait = JSON.parse(text).parameters?.retry_after ?? 1;
    } catch {}
    if (wait <= MAX_RETRY_WAIT_S) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return telegramApi(method, body, 2);
    }
  }
  throw new Error(`Telegram ${method} failed (${res.status}): ${text.slice(0, 200)}`);
}

/**
 * Sends a message to your chat. Deliberately sends plain text: Telegram's
 * Markdown parser rejects the whole message if it sees an unescaped "_" or
 * "*", and task names contain those often enough to matter. Reliability beats
 * formatting here.
 *
 * `keyboard` is an inline keyboard (rows of buttons, see lib/buttons.js). It
 * goes on the last chunk of a long message.
 *
 * Throws if Telegram does not accept the message, so callers never mistake
 * an undelivered message (a brief, a watcher alert) for a delivered one.
 */
export async function sendMessage(text, { keyboard, chatId = config.telegram.chatId() } = {}) {
  const chunks = splitMessage(String(text || "").trim() || "(empty response)");
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
      ...(last && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }
}

/** Replaces the text and buttons of a message the bot sent earlier. An empty keyboard removes the buttons. */
export async function editMessage(chatId, messageId, text, keyboard) {
  await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, TELEGRAM_LIMIT),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard || [] },
  });
}

/** Replaces only the buttons of a message. */
export async function editKeyboard(chatId, messageId, keyboard) {
  await telegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard || [] },
  });
}

/** Stops the loading spinner on a tapped button; `text` shows as a short toast. */
export async function answerCallback(callbackQueryId, text) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  });
}

/** The update types the webhook must receive: messages, and taps on buttons. */
export const WEBHOOK_UPDATES = ["message", "callback_query"];

/**
 * Makes sure Telegram sends button taps to the bot. A webhook registered
 * before buttons existed only subscribes to messages, and then every tap
 * just spins. Re-registers the same URL and secret with both update types.
 * Returns true if it had to fix the registration.
 */
export async function ensureButtonUpdates() {
  const info = await telegramApi("getWebhookInfo");
  // No allowed_updates in the reply means Telegram's default, which includes taps.
  if (!info?.url || !info.allowed_updates || info.allowed_updates.includes("callback_query")) return false;
  await telegramApi("setWebhook", {
    url: info.url,
    secret_token: config.telegram.webhookSecret(),
    allowed_updates: WEBHOOK_UPDATES,
  });
  console.log("Webhook re-registered to receive button taps.");
  return true;
}

/** Shows "typing..." while a slow reply is being worked on. Best effort. */
export async function sendTyping(chatId = config.telegram.chatId()) {
  await telegramApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/**
 * Downloads a file the user sent (photo, document) and returns it as base64.
 * The download URL contains the bot token, so it is fetched here and never
 * passed on to anyone else.
 */
export async function downloadFile(fileId, maxBytes) {
  const tooBig = (bytes) =>
    new Error(`the file is too large (${Math.ceil(bytes / 1_000_000)} MB, limit ${Math.round(maxBytes / 1_000_000)} MB)`);

  const file = await telegramApi("getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Telegram did not return a file path");
  if (file.file_size > maxBytes) throw tooBig(file.file_size);

  let res;
  try {
    res = await fetch(`https://api.telegram.org/file/bot${config.telegram.botToken()}/${file.file_path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (err) {
    throw new Error(`downloading the file from Telegram failed: ${err.name}`);
  }
  if (!res.ok) throw new Error(`downloading the file from Telegram failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw tooBig(buffer.length);
  return buffer.toString("base64");
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
