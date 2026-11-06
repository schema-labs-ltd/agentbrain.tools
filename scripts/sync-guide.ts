/** Copy the plugin skill's body into src/core/guide.ts so the MCP server can serve the same guidance. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
export const SKILL_PATH = join(root, "plugins/agentbrain/skills/agent-brain/SKILL.md");
const GUIDE_PATH = join(root, "src/core/guide.ts");

export function skillBody(): string {
  return readFileSync(SKILL_PATH, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const source = `// Generated from plugins/agentbrain/skills/agent-brain/SKILL.md by \`npm run sync-guide\`. Do not edit by hand.\n\nexport const GUIDE_MARKDOWN = ${JSON.stringify(skillBody())};\n`;
  writeFileSync(GUIDE_PATH, source);
  console.log(`Wrote ${GUIDE_PATH}`);
}
