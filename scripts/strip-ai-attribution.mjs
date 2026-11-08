import { readFileSync, writeFileSync } from "node:fs";

// Matched by address, not name, so a person named Claude or Devin keeps their credit.
const agentAddress = new RegExp(
  [
    String.raw`@(anthropic\.com|cursor\.com|openai\.com|ampcode\.com|aider\.chat|factory\.ai|codeium\.com|windsurf\.com)>`,
    String.raw`@(devin\.ai|cognition\.ai|opencode\.ai|sst\.dev|kilocode\.ai|cline\.bot|roocode\.com|augmentcode\.com)>`,
    String.raw`\[bot\]@users\.noreply\.github\.com>`,
    String.raw`\bcopilot@users\.noreply\.github\.com>`,
  ].join("|"),
  "i",
);
const agentName = /\b(claude|codex|cursor|copilot|gemini|amp|aider|devin|jules|windsurf|opencode|droid|cline)\b/i;

const isAttribution = (line) =>
  (/^co-authored-by:/i.test(line) && agentAddress.test(line)) ||
  /^(made-with|assisted-by|amp-thread(-id)?|generated-by):/i.test(line) ||
  (/^\W*(generated|made|created) (with|by)\b/i.test(line) && agentName.test(line));

const file = process.argv[2];
const kept = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => !isAttribution(line.trim()))
  .join("\n");
writeFileSync(file, `${kept.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
