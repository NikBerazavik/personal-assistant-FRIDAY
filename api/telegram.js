import { config } from "../lib/config.js";
import { runAgent } from "../lib/agent.js";
import { sendMessage, sendTyping, answerCallback, downloadFile } from "../lib/telegram.js";
import { handleCallback } from "../lib/buttons.js";
import { openStore } from "../lib/state.js";
import { recentExchanges, remember, alreadyHandled } from "../lib/chat.js";

const HELP = [
  "I manage your Notion tasks. Just talk to me normally:",
  "",
  '- "what\'s on today?"',
  '- "add: review 5G glossary draft, work, tomorrow 2pm"',
  '- "remind me at 16:40 to call mum"',
  '- "move the dentist to Friday 3pm"',
  '- "mark the glossary review done"',
  '- "what\'s overdue?"',
  "",
  "Send a photo, screenshot or PDF (an invite, a poster, a booking) and I'll turn it into tasks. Add a caption to tell me what you want.",
  "",
  "Tap the buttons under my reminders to mark things done, push them an hour, move them to tomorrow, or drop them.",
  "",
  "Tasks are Personal unless you say work or it sounds like work.",
  'I remember the last few messages for an hour, so "make it 3pm" works right after adding something.',
].join("\n");

// Claude's limits are 5 MB per image and 32 MB per PDF; Telegram lets bots
// download up to 20 MB. A smaller PDF cap keeps the request quick and cheap.
const IMAGE_MAX_BYTES = 5_000_000;
const PDF_MAX_BYTES = 10_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// How a button tap appears in conversation memory; lib/agent.js explains it to the model.
const BUTTON_TURN = "(tapped a button under your message)";
const DEFAULT_ATTACHMENT_PROMPT = "(The user sent this without a caption.)";

/** The photo or document in a message, as { fileId, kind, mediaType, maxBytes }, or null. */
function attachmentOf(message) {
  if (message.photo?.length) {
    // Telegram sends several sizes; the last is the largest.
    const photo = message.photo[message.photo.length - 1];
    return { fileId: photo.file_id, kind: "image", mediaType: "image/jpeg", maxBytes: IMAGE_MAX_BYTES };
  }
  const doc = message.document;
  if (doc?.mime_type === "application/pdf") {
    return { fileId: doc.file_id, kind: "pdf", mediaType: "application/pdf", maxBytes: PDF_MAX_BYTES };
  }
  if (IMAGE_TYPES.includes(doc?.mime_type)) {
    return { fileId: doc.file_id, kind: "image", mediaType: doc.mime_type, maxBytes: IMAGE_MAX_BYTES };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // --- Auth gate 1: the secret token Telegram echoes back on every call. ---
  // Without this, anyone who discovers your Vercel URL can POST fake updates.
  // The config getter throws if the secret is unset, so a missing env var
  // fails closed instead of matching a missing header.
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!secret || secret !== config.telegram.webhookSecret()) {
    console.warn("Rejected webhook call with bad or missing secret token.");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Edits are ignored on purpose: re-running an edited "add task X" would
  // create it a second time. The webhook only subscribes to "message" and
  // "callback_query", but an older registration may still deliver edits.
  if (req.body?.edited_message) {
    return res.status(200).json({ ok: true });
  }

  try {
    if (req.body?.callback_query) await onButton(req.body);
    else if (req.body?.message) await onMessage(req.body);
  } catch (err) {
    console.error("Handler error:", err);
    // Tell yourself what broke rather than leaving the message unanswered.
    await sendMessage(`Something went wrong: ${err.message}`).catch(() => {});
  }

  // 200 regardless of internal failure — a non-200 makes Telegram redeliver
  // the same update, which would repeat any side effects that did succeed.
  return res.status(200).json({ ok: true });
}

// --- Auth gate 2: only you. Your bot's username is discoverable, so this ---
// check is what actually stops strangers from driving your Notion.
const isOwner = (chatId) => String(chatId) === config.telegram.chatId();

/** The state page, or null if it is not set up or unreachable (then: no memory, no redelivery check). */
const loadStore = () =>
  openStore().catch((err) => {
    console.warn("State page unavailable; continuing without memory:", err.message);
    return null;
  });

async function onButton(update) {
  const query = update.callback_query;
  if (!isOwner(query.message?.chat?.id) || !isOwner(query.from?.id)) {
    console.warn(`Ignoring button tap from unauthorised user ${query.from?.id}`);
    return;
  }

  const store = await loadStore();
  // A fast double tap sends two updates with the same button and message;
  // only the first may act, or "+1h" would move the task two hours.
  const tapKey = `tap:${query.message.message_id}:${query.data}`;
  if (await alreadyHandled(store, `u:${update.update_id}`, tapKey)) {
    await answerCallback(query.id).catch(() => {});
    return;
  }

  let result;
  try {
    result = await handleCallback(query);
  } catch (err) {
    console.error("Button action failed:", err);
    await answerCallback(query.id, `Failed: ${err.message}`).catch(() => {});
    return;
  }
  await answerCallback(query.id, result.toast).catch(() => {});
  if (result.outcome) {
    await remember(store, BUTTON_TURN, result.outcome);
  }
  console.log(`Button ${query.data}: ${result.outcome || "no change"}`);
}

async function onMessage(update) {
  const message = update.message;
  if (!isOwner(message.chat?.id)) {
    if (message.chat?.id) console.warn(`Ignoring message from unauthorised chat id ${message.chat.id}`);
    return;
  }

  const text = (message.text || message.caption || "").trim();
  const attachment = attachmentOf(message);

  // Handle these locally — no reason to spend tokens on a help message.
  if (text === "/start" || text === "/help") return sendMessage(HELP);

  if (!text && !attachment) {
    if (message.voice || message.audio || message.video_note) {
      await sendMessage(
        "I can't listen to voice notes yet. Tip: tap the microphone on your phone keyboard and send the words as text instead."
      );
    } else if (message.document) {
      await sendMessage("I can read photos, screenshots and PDFs, but not this kind of file.");
    }
    return;
  }

  const store = await loadStore();
  if (await alreadyHandled(store, `u:${update.update_id}`)) {
    console.log(`Skipping update ${update.update_id}: already handled (Telegram re-sent it).`);
    return;
  }

  await sendTyping();

  const attachments = [];
  if (attachment) {
    try {
      const data = await downloadFile(attachment.fileId, attachment.maxBytes);
      attachments.push({ kind: attachment.kind, mediaType: attachment.mediaType, data });
    } catch (err) {
      await sendMessage(`I couldn't read that ${attachment.kind === "pdf" ? "PDF" : "image"}: ${err.message}.`);
      return;
    }
  }

  // When the user replies to a message, Telegram attaches the original.
  // Forwarding it is what makes "move it to 4pm" resolvable.
  const quoted = message.reply_to_message;
  const quotedText = quoted?.text || quoted?.caption;
  const replyTo = quotedText ? { text: quotedText, fromBot: Boolean(quoted.from?.is_bot) } : undefined;

  const userText = text || DEFAULT_ATTACHMENT_PROMPT;
  const { text: reply, usage } = await runAgent(userText, {
    replyTo,
    history: recentExchanges(store),
    attachments,
  });
  console.log(
    `Handled message${replyTo ? " (with reply context)" : ""}${attachments.length ? ` (with ${attachment.kind})` : ""}. Tokens in=${usage.input} out=${usage.output}`
  );
  await sendMessage(reply);

  // Memory keeps only the words: an attachment is noted, not stored.
  const remembered = attachments.length ? `[sent ${attachment.kind === "pdf" ? "a PDF" : "a photo"}] ${text}`.trim() : text;
  await remember(store, remembered, reply);
}
