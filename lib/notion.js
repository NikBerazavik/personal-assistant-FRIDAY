import { config } from "./config.js";
import {
  today,
  addDays,
  startOfDay,
  startOfWeek,
  normalizeDate,
  formatForDisplay,
  hasTime,
  shiftDateTime,
} from "./dates.js";

const NOTION_BASE = "https://api.notion.com/v1";
const P = config.props.tasks;
const PP = config.props.projects;

// ---------------------------------------------------------------------------
// Raw request helper. We call the REST API directly rather than using the SDK:
// the SDK's method names shifted across the data-sources migration, and this
// way the Notion-Version header is explicit and pinned in one place.
// ---------------------------------------------------------------------------
async function notionRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.notion.apiKey()}`,
      "Notion-Version": config.notion.apiVersion,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Notion returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    // Notion's error messages are genuinely useful — surface them verbatim.
    throw new Error(`Notion ${res.status} on ${method} ${path}: ${json.message || text}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Data source resolution.
//
// As of API version 2025-09-03 a "database" is a container that holds one or
// more "data sources", and it's the data source that actually holds the rows.
// The id in your Notion URL is the DATABASE id, but queries and page creation
// need the DATA SOURCE id. They are not interchangeable.
//
// Rather than make you hunt for the data source id in the Notion UI, we
// resolve it once per cold start and cache it in module scope.
// ---------------------------------------------------------------------------
const dataSourceCache = new Map();

export async function resolveDataSourceId(databaseId) {
  if (dataSourceCache.has(databaseId)) return dataSourceCache.get(databaseId);

  const db = await notionRequest(`/databases/${databaseId}`);
  const sources = db.data_sources || [];

  if (sources.length === 0) {
    throw new Error(
      `Database ${databaseId} reports no data sources. Check the integration is connected to it.`
    );
  }
  if (sources.length > 1) {
    console.warn(
      `Database ${databaseId} has ${sources.length} data sources; using the first ("${sources[0].name}").`
    );
  }

  dataSourceCache.set(databaseId, sources[0].id);
  return sources[0].id;
}

const tasksSource = () => resolveDataSourceId(config.notion.tasksDbId());
const projectsSource = () => resolveDataSourceId(config.notion.projectsDbId());

// ---------------------------------------------------------------------------
// Property builders — convert plain JS values into Notion's property shapes.
// ---------------------------------------------------------------------------
const asTitle = (v) => ({ title: [{ text: { content: String(v).slice(0, 2000) } }] });
const asSelect = (v) => ({ select: v ? { name: v } : null });
const asStatus = (v) => ({ status: { name: v } });
const asRichText = (v) => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] });
const asCheckbox = (v) => ({ checkbox: Boolean(v) });
const asMultiSelect = (arr) => ({ multi_select: (arr || []).map((name) => ({ name })) });
const asRelation = (ids) => ({ relation: (ids || []).map((id) => ({ id })) });
const asDate = (start, end) =>
  start ? { date: { start: normalizeDate(start), end: normalizeDate(end) || null } } : { date: null };

// ---------------------------------------------------------------------------
// Reading a Notion page back into a flat object the model can reason about.
// We deliberately return a SMALL shape: every field here costs input tokens on
// every turn, so we drop everything Claude doesn't need to make decisions.
// Optional keys (date_end, notes) are only present when non-empty.
// ---------------------------------------------------------------------------
export function flattenTask(page, { notesLimit = 300 } = {}) {
  const p = page.properties || {};
  const date = p[P.date]?.date || null;
  const notes = (p[P.notes]?.rich_text || []).map((r) => r.plain_text).join("").trim();
  return {
    page_id: page.id,
    name: p[P.name]?.title?.[0]?.plain_text || "(untitled)",
    status: p[P.status]?.status?.name || null,
    domain: p[P.domain]?.select?.name || null,
    date: date?.start || null,
    ...(date?.end ? { date_end: date.end } : {}),
    date_display: formatForDisplay(date),
    priority: p[P.priority]?.select?.name || null,
    recurring: p[P.recurring]?.select?.name || null,
    tags: (p[P.tags]?.multi_select || []).map((t) => t.name),
    ...(notes ? { notes: notes.slice(0, notesLimit) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function queryTasks(filter, sorts, pageSize = 50, flattenOpts) {
  const sourceId = await tasksSource();
  const res = await notionRequest(`/data_sources/${sourceId}/query`, {
    method: "POST",
    body: {
      filter,
      sorts: sorts || [{ property: P.date, direction: "ascending" }],
      page_size: pageSize,
    },
  });
  return (res.results || []).map((page) => flattenTask(page, flattenOpts));
}

const notDone = { 
  and: [
    { property: P.status, status: { does_not_equal: "Done" } },
    { property: P.status, status: { does_not_equal: "Cancelled" } },
  ]
};

// Half-open interval [from, toExclusive) — the only correct way to express a
// day boundary when tasks can carry a time-of-day.
//
// Notion's date filter matches a ranged property (one with both start and
// end) by OVERLAP: on_or_after can be satisfied by the range's end, before
// by its start. So a task starting well before `from` but ending inside
// [from, toExclusive) passes this filter even though its start date is
// outside the window. We still send this to Notion to narrow the query, but
// callers that care about "does this task's date fall in the window" must
// also post-filter on the returned start date — see getTasks.
const between = (from, toExclusive) => ({
  filter: {
    and: [
      { property: P.date, date: { on_or_after: startOfDay(from) } },
      { property: P.date, date: { before: startOfDay(toExclusive) } },
    ],
  },
  from,
  toExclusive,
});

const noWindow = (filter) => ({ filter, from: null, toExclusive: null });

/**
 * Builds a filter for a named time window. All boundaries are computed in
 * local time (see lib/dates.js) rather than UTC.
 */
function scopeFilter(scope, { date_from, date_to } = {}) {
  const t = today();

  // An explicit range always wins over the named scope.
  if (date_from || date_to) {
    const from = date_from || t;
    const to = date_to || from; // only date_from => that single day
    return between(from, addDays(to, 1)); // date_to is INCLUSIVE for the model
  }

  switch (scope) {
    case "today":
      return between(t, addDays(t, 1));
    case "tomorrow":
      return between(addDays(t, 1), addDays(t, 2));
    case "this_week": {
      // Today through Sunday. Earlier days of this week belong to "overdue".
      const monday = startOfWeek(t);
      return between(t, addDays(monday, 7));
    }
    case "next_week": {
      const monday = addDays(startOfWeek(t), 7);
      return between(monday, addDays(monday, 7)); // Mon 00:00 -> next Mon 00:00
    }
    case "next_7_days":
      return between(t, addDays(t, 8)); // today plus the following seven
    case "overdue":
      return noWindow({ and: [{ property: P.date, date: { before: startOfDay(t) } }, notDone] });
    case "unscheduled":
      return noWindow({ and: [{ property: P.date, date: { is_empty: true } }, notDone] });
    case "all_open":
    default:
      return noWindow(notDone);
  }
}

export async function getTasks({ scope = "today", domain, status, date_from, date_to } = {}) {
  const { filter: scopeF, from, toExclusive } = scopeFilter(scope, { date_from, date_to });
  const conditions = [scopeF];
  if (domain) conditions.push({ property: P.domain, select: { equals: domain } });
  if (status) conditions.push({ property: P.status, status: { equals: status } });

  const filter = conditions.length === 1 ? conditions[0] : { and: conditions };
  const tasks = await queryTasks(filter);

  // Notion's range-overlap matching (see `between` above) can return tasks
  // whose start date falls outside the requested window. Trim those here so
  // "next week" only ever contains tasks that actually start next week.
  if (!from || !toExclusive) return tasks;
  return tasks.filter((task) => {
    if (!task.date) return true;
    const day = task.date.slice(0, 10);
    return day >= from && day < toExclusive;
  });
}

export async function listProjects() {
  const sourceId = await projectsSource();
  const res = await notionRequest(`/data_sources/${sourceId}/query`, {
    method: "POST",
    body: { page_size: 50 },
  });
  return (res.results || []).map((page) => ({
    page_id: page.id,
    name: page.properties?.[PP.name]?.title?.[0]?.plain_text || "(untitled)",
    status: page.properties?.[PP.status]?.select?.name || null,
    domain: page.properties?.[PP.domain]?.select?.name || null,
    area: page.properties?.[PP.area]?.select?.name || null,
  }));
}

/**
 * Resolves a project name to its page id. This is the "extra API call" —
 * relations must be set by id, not by name, so linking a task to a project
 * costs one lookup. We match case-insensitively and prefer an exact match
 * over a partial one to reduce the chance of linking the wrong project.
 */
export async function findProjectId(name) {
  if (!name) return null;
  const projects = await listProjects();
  const needle = name.trim().toLowerCase();
  if (!needle) return null;

  const exact = projects.find((p) => p.name.toLowerCase() === needle);
  if (exact) return { id: exact.page_id, matched: exact.name };

  const partial = projects.find((p) => {
    const n = p.name.toLowerCase();
    // Reverse containment only for names long enough to be meaningful, so a
    // project called "AI" doesn't match every request containing "ai".
    return n.includes(needle) || (n.length >= 4 && needle.includes(n));
  });
  return partial ? { id: partial.page_id, matched: partial.name } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export async function createTask({
  name,
  domain,
  date_start,
  date_end,
  priority,
  project_name,
  tags,
  recurring,
  notes,
}) {
  const sourceId = await tasksSource();

  const properties = {
    [P.name]: asTitle(name),
    [P.status]: asStatus("Not Started"),
    [P.domain]: asSelect(domain || config.values.defaultDomain),
    [P.source]: asSelect(config.values.source.agent),
    [P.needsScheduling]: asCheckbox(!date_start),
  };

  if (date_start) properties[P.date] = asDate(date_start, date_end);
  if (priority) properties[P.priority] = asSelect(priority);
  if (tags?.length) properties[P.tags] = asMultiSelect(tags);
  if (recurring && recurring !== "None") properties[P.recurring] = asSelect(recurring);
  if (notes) properties[P.notes] = asRichText(notes);

  let matchedProject = null;
  if (project_name) {
    const hit = await findProjectId(project_name);
    if (hit) {
      properties[P.project] = asRelation([hit.id]);
      matchedProject = hit.matched;
    }
  }

  const page = await notionRequest("/pages", {
    method: "POST",
    body: {
      // Note the parent type: as of 2025-09-03 pages are parented to a data
      // source, not to a database.
      parent: { type: "data_source_id", data_source_id: sourceId },
      properties,
    },
  });

  return {
    created: true,
    page_id: page.id,
    domain: domain || config.values.defaultDomain,
    notes_saved: Boolean(notes),
    project_linked: matchedProject,
    project_requested: project_name || null,
    warning:
      project_name && !matchedProject
        ? `No project matching "${project_name}" was found, so the task was created without a project link.`
        : undefined,
  };
}

/**
 * Partial update. Only the supplied fields change. A few cases need the
 * page's current state, which costs one extra GET:
 *  - moving the start alone keeps the original duration (14:00-15:00 moved
 *    to 16:00 becomes 16:00-17:00);
 *  - setting only the end keeps the existing start;
 *  - notes are appended by default so nothing already saved is lost.
 */
export async function updateTask({
  page_id,
  name,
  status,
  date_start,
  date_end,
  clear_date,
  priority,
  domain,
  notes,
  notes_mode = "append",
  tags,
  recurring,
  project_name,
}) {
  const properties = {};
  const info = {};

  if (name) properties[P.name] = asTitle(name);
  if (status) properties[P.status] = asStatus(status);
  if (priority) properties[P.priority] = asSelect(priority);
  if (domain) properties[P.domain] = asSelect(domain);
  if (tags?.length) properties[P.tags] = asMultiSelect(tags);
  if (recurring) properties[P.recurring] = asSelect(recurring === "None" ? null : recurring);

  const needsCurrent =
    (notes && notes_mode === "append") ||
    (date_start && !date_end && !clear_date) ||
    (date_end && !date_start && !clear_date);
  const current = needsCurrent
    ? flattenTask(await notionRequest(`/pages/${page_id}`), { notesLimit: 2000 })
    : null;

  if (clear_date) {
    properties[P.date] = asDate(null);
    properties[P.needsScheduling] = asCheckbox(true);
  } else if (date_start) {
    let end = date_end;
    if (!end && current?.date_end && hasTime(current.date) && hasTime(date_start)) {
      end = shiftDateTime(current.date_end, current.date, normalizeDate(date_start));
      if (end) info.duration_preserved = true;
    }
    properties[P.date] = asDate(date_start, end);
    properties[P.needsScheduling] = asCheckbox(false);
  } else if (date_end) {
    if (!current?.date) {
      return {
        updated: false,
        error: "This task has no start date, so an end time alone cannot be set. Pass date_start as well.",
      };
    }
    properties[P.date] = asDate(current.date, date_end);
  }

  if (notes) {
    const merged =
      notes_mode === "append" && current?.notes ? `${current.notes}\n${notes}` : notes;
    properties[P.notes] = asRichText(merged);
  }

  if (project_name) {
    const hit = await findProjectId(project_name);
    if (hit) {
      properties[P.project] = asRelation([hit.id]);
      info.project_linked = hit.matched;
    } else {
      info.warning = `No project matching "${project_name}" was found; the project link was left unchanged.`;
    }
  }

  if (Object.keys(properties).length === 0) {
    return { updated: false, error: "No fields were supplied to update." };
  }

  await notionRequest(`/pages/${page_id}`, { method: "PATCH", body: { properties } });
  return { updated: true, page_id, fields: Object.keys(properties), ...info };
}

/** Used by the nightly job to spawn the next instance of a recurring task. */
export async function getRecurringTasks() {
  // Match the real cadences explicitly. `does_not_equal: "None"` would also
  // match every task whose Recurring field is simply empty, which is most of
  // them, and could push genuine recurring tasks past the page-size limit.
  const kinds = config.values.recurring.filter((v) => v !== "None");
  return queryTasks(
    { or: kinds.map((k) => ({ property: P.recurring, select: { equals: k } })) },
    [{ property: P.date, direction: "descending" }],
    100,
    { notesLimit: 2000 }
  );
}

export { notionRequest };
