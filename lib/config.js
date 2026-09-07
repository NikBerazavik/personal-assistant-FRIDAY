// ---------------------------------------------------------------------------
// Central configuration. Everything environment-dependent lives here so you
// never have to hunt through the codebase to change a property name or model.
// ---------------------------------------------------------------------------

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  anthropic: {
    apiKey: () => required("ANTHROPIC_API_KEY"),
    // Haiku is the right size for structured CRUD work. Swap to
    // "claude-sonnet-5" here if you later add real prioritisation reasoning.
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5",
    maxTokens: 1024,
    apiVersion: "2023-06-01",
  },

  notion: {
    apiKey: () => required("NOTION_API_KEY"),
    // These are the DATABASE ids you copy from the Notion URL. The code
    // resolves them to data source ids at runtime — see lib/notion.js.
    tasksDbId: () => required("NOTION_TASKS_DB_ID"),
    projectsDbId: () => required("NOTION_PROJECTS_DB_ID"),
    // Pinned deliberately. Notion ships breaking changes between versions;
    // do not bump this without reading their upgrade guide first.
    apiVersion: "2025-09-03",
  },

  telegram: {
    botToken: () => required("TELEGRAM_BOT_TOKEN"),
    chatId: () => required("TELEGRAM_CHAT_ID"),
    webhookSecret: () => required("TELEGRAM_WEBHOOK_SECRET"),
  },

  // Thailand is UTC+7 with no daylight saving, so a fixed offset is correct.
  // If you ever move somewhere with DST, this needs to become dynamic.
  timezone: process.env.TIMEZONE || "Asia/Bangkok",
  utcOffset: process.env.UTC_OFFSET || "+07:00",

  // Notion property names. If you rename a column in Notion, rename it here
  // too — these strings are matched exactly by the API.
  props: {
    tasks: {
      name: "Name",
      status: "Status",
      domain: "Domain",
      date: "Date",
      project: "Project",
      priority: "Priority",
      tags: "Tags",
      recurring: "Recurring",
      needsScheduling: "Needs Scheduling",
      source: "Source",
      notes: "Notes",
    },
    projects: {
      name: "Name",
      status: "Status",
      area: "Area",
      domain: "Domain",
      deadline: "Deadline",
    },
  },

  // Allowed option values. These must match the Select/Status options you
  // created in Notion exactly, including capitalisation.
  values: {
    status: ["Not Started", "In Progress", "Blocked", "Cancelled", "Done"],
    domain: ["Personal", "Work"],
    // Used when the user gives no domain. See the Domain rule in lib/agent.js.
    defaultDomain: "Personal",
    priority: ["P1", "P2", "P3"],
    recurring: ["None", "Daily", "Weekly"],
    source: { manual: "Manual", agent: "Agent-created" },
  },
};
