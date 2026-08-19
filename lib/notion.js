import { config } from "./config.js";
import { today, addDays, startOfDay, normalizeDate, formatForDisplay } from "./dates.js";

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
// ---------------------------------------------------------------------------
export function flattenTask(page) {
  const p = page.properties || {};
  return {
    page_id: page.id,
    name: p[P.name]?.title?.[0]?.plain_text || "(untitled)",
    status: p[P.status]?.status?.name || null,
    domain: p[P.domain]?.select?.name || null,
    date: p[P.date]?.date?.start || null,
    date_display: formatForDisplay(p[P.date]?.date),
    priority: p[P.priority]?.select?.name || null,
    recurring: p[P.recurring]?.select?.name || null,
    tags: (p[P.tags]?.multi_select || []).map((t) => t.name),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function queryTasks(filter, sorts, pageSize = 50) {
  const sourceId = await tasksSource();
  const res = await notionRequest(`/data_sources/${sourceId}/query`, {
    method: "POST",
    body: {
      filter,
      sorts: sorts || [{ property: P.date, direction: "ascending" }],
      page_size: pageSize,
    },
  });
  return (res.results || []).map(flattenTask);
}

const notDone = { property: P.status, status: { does_not_equal: "Done" } };

/**
 * Builds a filter for a named time window. All boundaries are computed in
 * local time (see lib/dates.js) rather than UTC.
 */
function scopeFilter(scope) {
  const t = today();

  switch (scope) {
    case "today":
      return {
        and: [
          { property: P.date, date: { on_or_after: startOfDay(t) } },
          { property: P.date, date: { before: startOfDay(addDays(t, 1)) } },
        ],
      };
    case "tomorrow":
      return {
        and: [
          { property: P.date, date: { on_or_after: startOfDay(addDays(t, 1)) } },
          { property: P.date, date: { before: startOfDay(addDays(t, 2)) } },
        ],
      };
    case "this_week":
      return {
        and: [
          { property: P.date, date: { on_or_after: startOfDay(t) } },
          { property: P.date, date: { before: startOfDay(addDays(t, 7)) } },
        ],
      };
    case "overdue":
      return {
        and: [{ property: P.date, date: { before: startOfDay(t) } }, notDone],
      };
    case "unscheduled":
      return {
        and: [{ property: P.date, date: { is_empty: true } }, notDone],
      };
    case "all_open":
    default:
      return notDone;
  }
}

export async function getTasks({ scope = "today", domain, status } = {}) {
  const conditions = [scopeFilter(scope)];
  if (domain) conditions.push({ property: P.domain, select: { equals: domain } });
  if (status) conditions.push({ property: P.status, status: { equals: status } });

  const filter = conditions.length === 1 ? conditions[0] : { and: conditions };
  return queryTasks(filter);
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

  const exact = projects.find((p) => p.name.toLowerCase() === needle);
  if (exact) return { id: exact.page_id, matched: exact.name };

  const partial = projects.find(
    (p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase())
  );
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
    [P.source]: asSelect(config.values.source.agent),
    [P.needsScheduling]: asCheckbox(!date_start),
  };

  if (domain) properties[P.domain] = asSelect(domain);
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
    project_linked: matchedProject,
    project_requested: project_name || null,
    warning:
      project_name && !matchedProject
        ? `No project matching "${project_name}" was found, so the task was created without a project link.`
        : undefined,
  };
}

export async function updateTask({ page_id, status, date_start, date_end, priority, domain }) {
  const properties = {};
  if (status) properties[P.status] = asStatus(status);
  if (priority) properties[P.priority] = asSelect(priority);
  if (domain) properties[P.domain] = asSelect(domain);
  if (date_start) {
    properties[P.date] = asDate(date_start, date_end);
    properties[P.needsScheduling] = asCheckbox(false);
  }

  if (Object.keys(properties).length === 0) {
    return { updated: false, error: "No fields were supplied to update." };
  }

  await notionRequest(`/pages/${page_id}`, { method: "PATCH", body: { properties } });
  return { updated: true, page_id, fields: Object.keys(properties) };
}

/** Used by the nightly job to spawn the next instance of a recurring task. */
export async function getRecurringTasks() {
  return queryTasks(
    { property: P.recurring, select: { does_not_equal: "None" } },
    [{ property: P.date, direction: "descending" }],
    100
  );
}

export { notionRequest };
