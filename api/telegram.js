import { config } from "../lib/config.js";
import { runAgent } from "../lib/agent.js";
import { sendMessage } from "../lib/telegram.js";

const HELP = [
  "I manage your Notion tasks. Just talk to me normally:",
  "",
  '- "what\'s on today?"',
  '- "add: review 5G glossary draft, work, tomorrow 2pm"',
  '- "mark the glossary review done"',
  '- "what\'s overdue?"',
  '- "anything unscheduled?"',
  '- "what projects do I have?"',
].join("\n");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // --- Auth gate 1: the secret token Telegram echoes back on every call. ---
  // Without this, anyone who discovers your Vercel URL can POST fake updates.
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.warn("Rejected webhook call with bad or missing secret token.");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const message = req.body?.message || req.body?.edited_message;
  const text = message?.text?.trim();

  // --- Auth gate 2: only you. Your bot's username is discoverable, so this ---
  // check is what actually stops strangers from driving your Notion.
  if (!text || String(message.chat?.id) !== config.telegram.chatId()) {
    if (message?.chat?.id) {
      console.warn(`Ignoring message from unauthorised chat id ${message.chat.id}`);
    }
    // Always 200, or Telegram will retry this update indefinitely.
    return res.status(200).json({ ok: true });
  }

  try {
    // Handle these locally — no reason to spend tokens on a help message.
    if (text === "/start" || text === "/help") {
      await sendMessage(HELP);
      return res.status(200).json({ ok: true });
    }

    const { text: reply, usage } = await runAgent(text);
    console.log(`Handled message. Tokens in=${usage.input} out=${usage.output}`);
    await sendMessage(reply);
  } catch (err) {
    console.error("Handler error:", err);
    // Tell yourself what broke rather than leaving the message unanswered.
    await sendMessage(`Something went wrong: ${err.message}`).catch(() => {});
  }

  // 200 regardless of internal failure — a non-200 makes Telegram redeliver
  // the same update, which would repeat any side effects that did succeed.
  return res.status(200).json({ ok: true });
}
