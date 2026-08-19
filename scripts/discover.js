const res = await fetch("https://api.notion.com/v1/search", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ page_size: 50 }),
});
const data = await res.json();
if (!res.ok) { console.error("Error:", data.message); process.exit(1); }

if (!data.results?.length) {
  console.log("\nThe integration can see NOTHING.");
  console.log("No database has been connected to it yet -> Cause A.\n");
  process.exit(0);
}

console.log(`\nObjects visible to this integration: ${data.results.length}\n`);
for (const r of data.results) {
  const title =
    r.title?.[0]?.plain_text ||
    Object.values(r.properties || {}).find((p) => p.type === "title")
      ?.title?.[0]?.plain_text ||
    "(untitled)";
  console.log(`  type: ${r.object}`);
  console.log(`  name: ${title}`);
  console.log(`  id:   ${r.id.replace(/-/g, "")}`);
  if (r.parent?.database_id) {
    console.log(`  parent database: ${r.parent.database_id.replace(/-/g, "")}`);
  }
  console.log("");
}
