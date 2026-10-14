import { notionRequest } from "./notion.js";

// ---------------------------------------------------------------------------
// Persistent state. Vercel keeps nothing between runs, so what needs
// remembering lives as JSON in code blocks on a Notion page
// (NOTION_STATE_PAGE_ID):
//  - which daily jobs and reminder slots already ran today (api/tick.js);
//  - which tasks were already pinged or asked about (api/tick.js);
//  - which CompAsia listings the MacBook watcher has seen (lib/watcher.js);
//  - the last few chat exchanges and handled updates (lib/chat.js).
//
// Each key has its own code block, captioned "state:<key>". The tick and the
// Telegram webhook can run at the same moment; with one shared block, each
// would write back its own stale copy of the other's keys and undo it. With
// a block per key, a writer only touches the keys it changed.
//
// An uncaptioned code block is the older single-block format. It is still
// read, and a key saved since then overrides it.
// ---------------------------------------------------------------------------
const statePageId = () => {
  const id = process.env.NOTION_STATE_PAGE_ID;
  if (!id) throw new Error("NOTION_STATE_PAGE_ID is not set (see README, MacBook watcher)");
  return id;
};

const CAPTION_PREFIX = "state:";

// Notion caps each rich_text object at 2000 characters.
const toRichText = (json) =>
  json.match(/[\s\S]{1,1900}/g).map((content) => ({ type: "text", text: { content } }));

const plain = (richText) => (richText || []).map((r) => r.plain_text).join("");

function parse(block) {
  try {
    return JSON.parse(plain(block.code.rich_text));
  } catch {
    console.warn(`State block ${block.id} is not valid JSON; ignoring it.`);
    return undefined;
  }
}

async function listBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notionRequest(
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`
    );
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return blocks.filter((b) => b.type === "code");
}

/**
 * Loads the state. Returns { state, save }: `state` is a plain object ({} on
 * first use), and `save(patch)` merges `patch` into it and writes only the
 * keys in `patch` back.
 */
export async function openStore() {
  const pageId = statePageId();
  const blocks = await listBlocks(pageId);

  const state = {};
  const blockIds = {}; // key -> block id
  for (const block of blocks) {
    const caption = plain(block.code.caption);
    if (!caption.startsWith(CAPTION_PREFIX)) {
      // Legacy single block: every key at once. Keyed blocks override it.
      const legacy = parse(block);
      if (legacy && typeof legacy === "object") {
        for (const [k, v] of Object.entries(legacy)) if (!(k in blockIds)) state[k] = v;
      }
      continue;
    }
    const key = caption.slice(CAPTION_PREFIX.length);
    // Two writers creating the same key at once can leave two blocks; the
    // first one wins for reading and writing, so the result stays consistent.
    if (key in blockIds) continue;
    blockIds[key] = block.id;
    const value = parse(block);
    if (value !== undefined) state[key] = value;
  }

  return {
    state,
    async save(patch) {
      Object.assign(state, patch);
      for (const [key, value] of Object.entries(patch)) {
        const code = {
          rich_text: toRichText(JSON.stringify(value ?? null)),
          language: "json",
          caption: [{ type: "text", text: { content: `${CAPTION_PREFIX}${key}` } }],
        };
        if (blockIds[key]) {
          await notionRequest(`/blocks/${blockIds[key]}`, { method: "PATCH", body: { code } });
        } else {
          const created = await notionRequest(`/blocks/${pageId}/children`, {
            method: "PATCH",
            body: { children: [{ object: "block", type: "code", code }] },
          });
          blockIds[key] = created.results?.[0]?.id;
        }
      }
    },
  };
}
