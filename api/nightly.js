import { runMorningBrief } from "../lib/brief.js";
import { sendMessage } from "../lib/telegram.js";
import { authorized } from "../lib/auth.js";

// Manual trigger for the morning brief. The scheduled run now goes through
// /api/tick at 09:00; this stays so you can fire the brief on demand.
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    return res.status(200).json({ ok: true, ...(await runMorningBrief()) });
  } catch (err) {
    console.error("Morning brief failed:", err);
    await sendMessage(`Morning brief failed: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
