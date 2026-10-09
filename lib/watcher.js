import { sendMessage } from "./telegram.js";
import { today } from "./dates.js";

// ---------------------------------------------------------------------------
// MacBook watcher. Once a day it reads CompAsia's MacBook listing page and
// messages you when a MacBook Pro you would want appears. Rules only, no AI.
// Second-hand stock is one-off units, so there is no "back in stock": a
// listing is either on the page or it is not, and "new" means its URL has
// not been seen before.
// ---------------------------------------------------------------------------

const BASE = "https://compasia.co.th";
const LISTING_PATH = "/collections/macbooks";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_PAGES = 3;
const FETCH_TIMEOUT_MS = 10_000;
const HEARTBEAT_DAYS = 7;
const EMPTY_NOTICE_DAYS = 7;
// A listing is forgotten this long after it was last on the page, so the
// stored list does not grow forever. Until then, a unit that disappears and
// comes back is not announced again.
const FORGET_DAYS = 30;

// What counts as interesting: a MacBook Pro that is a 16 inch OR has chip
// generation >= MIN_CHIP_GEN (M4, M5, M6...). Edit here to change the taste.
export const WANTED = { screenInches: 16, minChipGen: 4 };

// Product families the matcher understands (Pro, Air, Neo). Air and Neo are
// ignored on purpose; a new listing outside these three gets flagged as a new
// type instead of being silently skipped.
const KNOWN_FAMILY = /MacBook\s*(Pro|Air|Neo)\b/i;

// Words that mark an accessory ("Magic Keyboard for MacBook Pro 16 inch").
// Only trusted when the title has no machine specs, because a real listing
// can mention a keyboard layout or a free case. สำหรับ is Thai for "for".
const ACCESSORY = /\b(keyboard|charger|adapter|adaptor|case|sleeve|cover|cable|stand|hub|dock|bag|skin|film|protector|mouse|trackpad)\b|\bfor\s+MacBook|สำหรับ/i;
const MACHINE_SPEC = /\b\d+\s*(GB|TB)\b|\bintel\b|\bcore\s*i[3579]\b/i;

// ---------------------------------------------------------------------------
// Parsing (pure functions, easy to test)
// ---------------------------------------------------------------------------
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** Decodes HTML entities: the site's React renderer writes 16" as 16&quot;. */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Product cards from one HTML page: [{ slug, title, price }]. */
export function parseListings(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="(\/products\/[^"?#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const slug = m[1];
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(m[2]);
    if (!h2 || seen.has(slug)) continue;
    seen.add(slug);
    const price = /฿\s?[\d,]+/.exec(m[2]);
    out.push({ slug, title: stripTags(h2[1]), price: price ? price[0].replace(/\s/g, "") : null });
  }
  return out;
}

/** What a title says about the machine. */
export function describe(title) {
  const isPro = /MacBook\s*Pro/i.test(title);
  const chip = /\bM(\d{1,2})\b(?:\s*(Pro|Max|Ultra))?/i.exec(title);
  const chipGen = chip ? Number(chip[1]) : null;
  // 16 inch, 16-inch, 16", 16”, 16 นิ้ว. "\\b" keeps "116" from matching.
  const screen = /\b(1[0-9])(?:\.\d)?\s*(?:-?\s*inch|"|”|″|นิ้ว)/i.exec(title);
  const inches = screen ? Number(screen[1]) : null;
  const accessory = ACCESSORY.test(title) && !chip && !MACHINE_SPEC.test(title);
  return { isPro, chipGen, chip: chip ? chip[0].trim() : null, inches, accessory, known: KNOWN_FAMILY.test(title) };
}

/** Returns the reasons a listing is wanted ([] when it is not). */
export function matchReasons(title) {
  const d = describe(title);
  if (!d.isPro || d.accessory) return [];
  const reasons = [];
  if (d.inches === WANTED.screenInches) reasons.push(`${d.inches} inch`);
  if (d.chipGen !== null && d.chipGen >= WANTED.minChipGen) reasons.push(`${d.chip} chip`);
  return reasons;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
async function fetchPage(page) {
  const url = `${BASE}${LISTING_PATH}${page > 1 ? `?page=${page}` : ""}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "th,en;q=0.8" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`CompAsia did not respond: ${err.name === "TimeoutError" ? `no response in ${FETCH_TIMEOUT_MS / 1000}s` : err.message}`);
  }
  if (!res.ok) throw new Error(`CompAsia returned HTTP ${res.status}`);
  return res.text();
}

/**
 * All listings across pages; stops as soon as a page adds nothing new.
 * `looksBroken` is true when nothing parsed although the page links to
 * products, which means the layout changed (as opposed to an empty shop).
 */
export async function fetchListings() {
  const all = new Map();
  let looksBroken = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const before = all.size;
    const html = await fetchPage(page);
    const found = parseListings(html);
    if (page === 1 && found.length === 0 && html.includes('href="/products/')) looksBroken = true;
    for (const l of found) all.set(l.slug, l);
    if (all.size === before) break;
  }
  return { listings: [...all.values()], looksBroken };
}

// ---------------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------------
const line = (l) => `- ${l.title}${l.price ? ` ${l.price}` : ""}\n  ${BASE}${l.slug}`;

/**
 * Fetches, diffs against what was seen before, and messages only when there
 * is something to say. `store` comes from lib/state.js; the watcher keeps its
 * keys (seen, lastHeartbeat, lastEmptyNotice) in it. With dry = true nothing
 * is sent or saved; the messages that would have gone out are returned.
 */
export async function runWatcher({ store, dry = false }) {
  const t = today();
  const state = store.state;
  const { listings, looksBroken } = await fetchListings();
  const messages = [];

  // 1. Page links to products but none parsed: the layout changed. Say so
  // right away and keep the old snapshot untouched.
  if (looksBroken) {
    messages.push("MacBook watcher: the CompAsia page lists products but none could be read. The page layout probably changed and the scraper needs fixing.");
    if (!dry) await sendMessage(messages[0]);
    return { listings: 0, broken: true, messages };
  }

  const firstRun = !state.seen;
  const known = state.seen || {};
  const fresh = listings.filter((l) => !known[l.slug]);
  const matches = fresh.filter((l) => matchReasons(l.title).length);
  const odd = fresh.filter((l) => {
    const d = describe(l.title);
    return !d.known && !d.accessory;
  });

  const daysSince = (d) => (d ? (Date.parse(t) - Date.parse(d)) / 86_400_000 : Infinity);
  let lastEmptyNotice = state.lastEmptyNotice;

  if (firstRun) {
    // First ever run: record what is there and say hello, without alerting
    // on everything that was already listed.
    const wanted = listings.filter((l) => matchReasons(l.title).length);
    messages.push(
      `MacBook watcher started. ${listings.length} listing(s) on CompAsia right now, ${wanted.length} matching (16 inch or M${WANTED.minChipGen}+ MacBook Pro).` +
        (wanted.length ? `\n${wanted.map(line).join("\n")}` : "")
    );
  } else if (listings.length === 0) {
    // A second-hand shop can be bare for weeks: mention it once a week, not
    // daily. This is also what a blocked or error page looks like, which is
    // why the seen list below is kept rather than replaced.
    if (daysSince(lastEmptyNotice) >= EMPTY_NOTICE_DAYS) {
      messages.push("MacBook watcher: CompAsia has no MacBook listings at the moment. Still checking daily; this note repeats weekly while it stays empty.");
      lastEmptyNotice = t;
    }
  } else {
    if (matches.length) {
      messages.push(
        `MacBook Pro spotted on CompAsia:\n${matches.map((l) => `${line(l)}\n  matches: ${matchReasons(l.title).join(", ")}`).join("\n")}`
      );
    }
    if (odd.length) messages.push(`New type of product on CompAsia (not MacBook Pro, Air or Neo):\n${odd.map(line).join("\n")}`);

    lastEmptyNotice = undefined;
    if (!messages.length && daysSince(state.lastHeartbeat) >= HEARTBEAT_DAYS) {
      messages.push(`MacBook watcher is alive: ${listings.length} listing(s) checked, no new matches this week.`);
    }
  }

  // Listings not on the page today stay remembered: an empty or blocked page
  // must not wipe the memory (or every listing would be announced again the
  // next day). Old entries are dropped FORGET_DAYS after they were last seen,
  // but only on days the page actually showed listings.
  const seen = {};
  for (const [slug, info] of Object.entries(known)) {
    const lastSeen = info.lastSeen || info.firstSeen;
    if (listings.length === 0 || daysSince(lastSeen) < FORGET_DAYS) seen[slug] = info;
  }
  for (const l of listings) {
    seen[l.slug] = { title: l.title, firstSeen: known[l.slug]?.firstSeen || t, lastSeen: t };
  }

  if (!dry) {
    // Send first, then save: if a message fails, the listing is still "new"
    // tomorrow and the alert is retried instead of lost.
    for (const m of messages) await sendMessage(m);
    await store.save({
      seen,
      lastHeartbeat: messages.length || firstRun ? t : state.lastHeartbeat || t,
      lastEmptyNotice,
    });
  }
  return { listings: listings.length, new: fresh.length, messages };
}
