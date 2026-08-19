import { config } from "./config.js";
import { tools, executeTool } from "./tools.js";
import { nowLocal, weekdayLocal, today } from "./dates.js";

const MAX_TURNS = 6; // guard against a tool loop that never terminates

function systemPrompt() {
  return [
    "You are a personal task assistant operating a Notion database over Telegram.",
    "",
    `Current local time: ${nowLocal()} (${weekdayLocal()}), timezone ${config.timezone}.`,
    `Today's date is ${today()}. Resolve relative dates like "tomorrow" or "Friday" against this.`,
    "",
    "Rules:",
    "- Never state what is scheduled without calling get_tasks first. Do not answer from memory.",
    "- When creating a task, if the user did not say when, omit the date rather than inventing one.",
    "- Never guess a page_id. Get it from get_tasks.",
    "- If a tool returns an error, tell the user plainly what failed. Do not pretend it worked.",
    "- If a project link could not be matched, say so explicitly.",
    "",
    "Style: you are replying in a Telegram chat. Be brief and plain. No markdown formatting,",
    "no headers, no bold. Use simple hyphen bullets for lists. A confirmation should be one line.",
  ].join("\n");
}

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropic.apiKey(),
      "anthropic-version": config.anthropic.apiVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt(),
      tools,
      messages,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${json.error?.message || JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Runs the full tool-use loop for one user message and returns Claude's final
 * text. Note this is stateless — each Telegram message is an independent
 * conversation. See the README for how to add memory if you want follow-ups
 * like "actually move that to 3pm" to work.
 */
export async function runAgent(userText) {
  const messages = [{ role: "user", content: userText }];
  let usage = { input: 0, output: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callClaude(messages);

    usage.input += response.usage?.input_tokens || 0;
    usage.output += response.usage?.output_tokens || 0;

    if (response.stop_reason !== "tool_use") {
      const text =
        response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() ||
        "Done.";
      return { text, usage };
    }

    // Claude can emit several tool_use blocks in one response. Execute all of
    // them — handling only the first would silently drop work.
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolUses.map(async (block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(await executeTool(block.name, block.input)),
      }))
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: results });
  }

  return {
    text: "I got stuck working on that — too many steps without reaching an answer. Try rephrasing?",
    usage,
  };
}
