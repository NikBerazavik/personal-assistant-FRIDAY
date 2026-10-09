import { notionRequest } from "./notion.js";

// ---------------------------------------------------------------------------
// Persistent state. Vercel keeps nothing between runs, so what needs
// remembering lives as JSON in a code block on a Notion page
// (NOTION_STATE_PAGE_ID):
//  - which daily jobs and reminder slots already ran today (api/tick.js);
//  - which CompAsia listings the MacBook watcher has seen (lib/watcher.js).
// ---------------------------------------------------------------------------
const statePageId = () => {
  const id = process.env.NOTION_STATE_PAGE_ID;
  if (!id) throw new Error("NOTION_STATE_PAGE_ID is not set (see README, MacBook watcher)");
  return id;
};

// Notion caps each rich_text object at 2000 characters.
const toRichText = (json) =>
  json.match(/[\s\S]{1,1900}/g).map((content) => ({ type: "text", text: { content } }));

/**
 * Loads the state. Returns { state, save }: `state` is a plain object ({} on
 * first use or if the block is unreadable), and `save(patch)` merges `patch`
 * into it and writes the whole object back.
 */
export async function openStore() {
  const pageId = statePageId();
  const res = await notionRequest(`/blocks/${pageId}/children?page_size=50`);
  const block = (res.results || []).find((b) => b.type === "code");

  let blockId = block?.id || null;
  let state = {};
  if (block) {
    try {
      state = JSON.parse(block.code.rich_text.map((r) => r.plain_text).join("")) || {};
    } catch {
      console.warn("State block is not valid JSON; starting from empty state.");
    }
  }

  return {
    state,
    async save(patch) {
      Object.assign(state, patch);
      const code = { rich_text: toRichText(JSON.stringify(state)), language: "json" };
      if (blockId) {
        await notionRequest(`/blocks/${blockId}`, { method: "PATCH", body: { code } });
      } else {
        const created = await notionRequest(`/blocks/${pageId}/children`, {
          method: "PATCH",
          body: { children: [{ object: "block", type: "code", code }] },
        });
        blockId = created.results?.[0]?.id || null;
      }
    },
  };
}
