import { config } from "./config.js";
import { getTasks, createTask, updateTask, listProjects } from "./notion.js";

// ---------------------------------------------------------------------------
// Tool schemas.
//
// Two deliberate design choices here:
//
// 1. Every constrained field uses `enum`, populated from config.values, which
//    mirrors your Notion Select/Status options. This means the model cannot
//    invent a status like "Complete" that Notion would reject — the constraint
//    lives in the schema rather than in prose the model might ignore.
//
// 2. There are only four tools. Small models degrade as the tool surface
//    grows, and every schema is re-sent as input tokens on every single turn.
//    Resist adding a fifth unless it earns its place.
// ---------------------------------------------------------------------------

const NOTES_DESCRIPTION =
  "Any detail with no dedicated field: location, building, floor, room, meeting link, attendees, agenda. If the user says WHERE something happens, it belongs here.";

const DOMAIN_DESCRIPTION =
  `Defaults to ${config.values.defaultDomain}. Use Work only when the user says "work" or the task is clearly job-related (meetings with colleagues or clients, deliverables, office, deadlines for their job). When unsure, ${config.values.defaultDomain}.`;

export const tools = [
  {
    name: "get_tasks",
    description:
      "Read tasks from Notion. Use this before answering any question about what is scheduled, due, or outstanding, and to find a task's page_id before updating it. Always call this rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["today", "tomorrow", "this_week", "next_week", "next_7_days", "overdue", "unscheduled", "all_open"],
          description:
            "Which time window to read. 'this_week' is today through Sunday. 'next_week' is the following Monday-Sunday. 'next_7_days' is a rolling window from today. 'unscheduled' means tasks with no date. 'all_open' means everything not Done.",
        },
        date_from: {
          type: "string",
          description:
            "YYYY-MM-DD. Use for a specific date or span instead of a named scope. For a single day, set date_from and date_to to the same value. Overrides scope.",
        },
        date_to: {
          type: "string",
          description: "YYYY-MM-DD, INCLUSIVE. Defaults to date_from when omitted.",
        },
        domain: { type: "string", enum: config.values.domain },
        status: { type: "string", enum: config.values.status },
      },
      required: ["scope"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a new task in Notion. Omit date_start if the user did not specify when — do not invent a date.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The task title. Keep it short and concrete." },
        domain: { type: "string", enum: config.values.domain, description: DOMAIN_DESCRIPTION },
        date_start: {
          type: "string",
          description:
            "When the task starts, as YYYY-MM-DD for an all-day task or YYYY-MM-DDTHH:MM for a timed one. Local time; do not add a timezone offset. Omit entirely if unscheduled.",
        },
        date_end: {
          type: "string",
          description:
            "Optional end of a time block, same format as date_start. Only use when the user gave a duration or end time.",
        },
        priority: { type: "string", enum: config.values.priority },
        project_name: {
          type: "string",
          description:
            "Optional name of an existing project to link. Only pass this if the user named a project or it is obvious. Call list_projects first if unsure what exists.",
        },
        tags: { type: "array", items: { type: "string" } },
        recurring: { type: "string", enum: config.values.recurring },
        notes: { type: "string", description: NOTES_DESCRIPTION },
      },
      required: ["name", "domain"],
    },
  },
  {
    name: "update_task",
    description:
      "Update an existing task. Only the fields you pass change. You must have its page_id from a previous get_tasks call — never guess a page_id. Moving date_start alone keeps the task's original duration.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by get_tasks." },
        name: { type: "string", description: "Rename the task." },
        status: { type: "string", enum: config.values.status },
        date_start: {
          type: "string",
          description:
            "Reschedule to this date/time. YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time, no offset.",
        },
        date_end: {
          type: "string",
          description: "New end time, same format. Can be passed alone to change only the end.",
        },
        clear_date: {
          type: "boolean",
          description: "true to remove the date entirely and mark the task as needing scheduling.",
        },
        priority: { type: "string", enum: config.values.priority },
        domain: { type: "string", enum: config.values.domain, description: DOMAIN_DESCRIPTION },
        notes: { type: "string", description: `${NOTES_DESCRIPTION} Appended to existing notes unless notes_mode is replace.` },
        notes_mode: {
          type: "string",
          enum: ["append", "replace"],
          description: "append (default) keeps existing notes and adds to them. replace overwrites them; use when the user corrects a detail.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Replaces the tag list." },
        recurring: { type: "string", enum: config.values.recurring },
        project_name: { type: "string", description: "Link to an existing project by name." },
      },
      required: ["page_id"],
    },
  },
  {
    name: "list_projects",
    description:
      "List existing projects. Use this when the user mentions a project you need to link to, or asks what projects exist.",
    input_schema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher. Errors are caught and returned as data rather than thrown, so
// the model can see what went wrong and correct itself (e.g. retry with a
// valid status) instead of the whole request failing.
// ---------------------------------------------------------------------------
export async function executeTool(name, input) {
  console.log(`Tool call: ${name}`, JSON.stringify(input));
  try {
    switch (name) {
      case "get_tasks": {
        const tasks = await getTasks(input);
        console.log(
          `get_tasks returned ${tasks.length}:`,
          JSON.stringify(tasks.map((t) => ({ name: t.name, date: t.date, status: t.status })))
        );
        return { tasks };
      }
      case "create_task":
        return await createTask(input);
      case "update_task":
        return await updateTask(input);
      case "list_projects":
        return { projects: await listProjects() };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return { error: err.message };
  }
}
