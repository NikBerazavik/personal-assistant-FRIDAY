// ---------------------------------------------------------------------------
// Preflight check. Run this BEFORE deploying:  npm run verify
//
// It catches the failures that would otherwise surface as a silent 6am
// no-message: a typo'd property name, a database the integration was never
// connected to, a bad token.
// ---------------------------------------------------------------------------

import { config } from "../lib/config.js";
import { notionRequest, resolveDataSourceId, getTasks, listProjects } from "../lib/notion.js";
import { today, nowLocal } from "../lib/dates.js";

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
let failures = 0;

function check(name, fn) {
  return (async () => {
    try {
      const detail = await fn();
      ok(`${name}${detail ? ` — ${detail}` : ""}`);
    } catch (err) {
      bad(`${name} — ${err.message}`);
      failures++;
    }
  })();
}

const REQUIRED_TASK_PROPS = Object.values(config.props.tasks);
const REQUIRED_PROJECT_PROPS = [
  config.props.projects.name,
  config.props.projects.status,
];

async function schemaCheck(dbId, expected, label) {
  const sourceId = await resolveDataSourceId(dbId);
  const source = await notionRequest(`/data_sources/${sourceId}`);
  const actual = Object.keys(source.properties || {});
  const missing = expected.filter((p) => !actual.includes(p));
  if (missing.length) {
    throw new Error(`${label} is missing properties: ${missing.join(", ")}`);
  }
  return `${actual.length} properties found`;
}

console.log("\nEnvironment");
await check("Environment variables present", () => {
  config.anthropic.apiKey();
  config.notion.apiKey();
  config.notion.tasksDbId();
  config.notion.projectsDbId();
  config.telegram.botToken();
  config.telegram.chatId();
  config.telegram.webhookSecret();
  return `model ${config.anthropic.model}`;
});
await check("Local time resolves", async () => `${nowLocal()} (today = ${today()})`);

console.log("\nNotion");
await check("Token is valid", async () => {
  const me = await notionRequest("/users/me");
  return me.name || me.bot?.owner?.type || "authenticated";
});
await check("Tasks database reachable", async () => {
  const id = await resolveDataSourceId(config.notion.tasksDbId());
  return `data source ${id.slice(0, 8)}...`;
});
await check("Projects database reachable", async () => {
  const id = await resolveDataSourceId(config.notion.projectsDbId());
  return `data source ${id.slice(0, 8)}...`;
});
await check("Tasks schema matches config", () =>
  schemaCheck(config.notion.tasksDbId(), REQUIRED_TASK_PROPS, "Tasks")
);
await check("Projects schema matches config", () =>
  schemaCheck(config.notion.projectsDbId(), REQUIRED_PROJECT_PROPS, "Projects")
);
await check("Can query today's tasks", async () => {
  const tasks = await getTasks({ scope: "today" });
  return `${tasks.length} task(s) today`;
});
await check("Can list projects", async () => {
  const projects = await listProjects();
  return `${projects.length} project(s)`;
});

console.log("\nAnthropic");
await check("API key works", async () => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropic.apiKey(),
      "anthropic-version": config.anthropic.apiVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return `${config.anthropic.model} responded`;
});

console.log("\nTelegram");
await check("Bot token works", async () => {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken()}/getMe`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description);
  return `@${json.result.username}`;
});

console.log(
  failures === 0
    ? "\nAll checks passed. Safe to deploy.\n"
    : `\n${failures} check(s) failed. Fix these before deploying.\n`
);
process.exit(failures === 0 ? 0 : 1);
