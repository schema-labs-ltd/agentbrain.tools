import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const plugin = "plugins/agentbrain";

describe("agentbrain plugin", () => {
  const claude = json(`${plugin}/.claude-plugin/plugin.json`);
  const portable = json(`${plugin}/plugin.json`);
  const claudeMcp = json(`${plugin}/.mcp.json`);
  const portableMcp = json(`${plugin}/mcp.json`);
  const claudeMarket = json(".claude-plugin/marketplace.json");
  const openaiMarket = json(".agents/plugins/marketplace.json");

  it("keeps names and versions in step across manifests and marketplaces", () => {
    expect(portable.name).toBe(claude.name);
    expect(portable.version).toBe(claude.version);
    const claudeEntry = claudeMarket.plugins.find((p: { name: string }) => p.name === claude.name);
    expect(claudeEntry.version).toBe(claude.version);
    expect(claudeEntry.source).toBe(`./${plugin}`);
    const openaiEntry = openaiMarket.plugins.find((p: { name: string }) => p.name === claude.name);
    expect(openaiEntry.source.path).toBe(`./${plugin}`);
  });

  it("points both MCP configs at the same server", () => {
    expect(claudeMcp.mcpServers.agentbrain).toEqual({ type: "http", url: "https://agentbrain.tools/mcp" });
    expect(portableMcp.mcpServers.agentbrain.type).toBe("streamable-http");
    expect(portableMcp.mcpServers.agentbrain.url).toBe(claudeMcp.mcpServers.agentbrain.url);
  });

  it("ships a skill with only portable frontmatter keys", () => {
    const skill = readFileSync(join(root, plugin, "skills/agent-brain/SKILL.md"), "utf8");
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(front).not.toBeNull();
    const keys = front![1]!.split("\n").map((line) => line.split(":")[0]);
    expect(keys).toEqual(["name", "description"]);
    expect(skill).toContain("name: agent-brain");
  });
});

describe("guide served by the MCP server", () => {
  it("matches the plugin skill body, so `npm run sync-guide` has been run", async () => {
    const { GUIDE_MARKDOWN } = await import("../src/core/guide.js");
    const skill = readFileSync(join(root, plugin, "skills/agent-brain/SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
    expect(GUIDE_MARKDOWN).toBe(skill);
  });
});
