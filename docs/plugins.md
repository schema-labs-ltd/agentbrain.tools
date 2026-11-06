# Plugins for Claude and ChatGPT

This repository is also a plugin marketplace. It offers one plugin, **agentbrain**, which bundles:

- the Agent Brain MCP server at `https://agentbrain.tools/mcp` (OAuth sign-in on first use), and
- the **agent-brain** skill, which teaches the agent the tools, the everyday workflows (pick up a reference, start a brain, end a session, close) and the [best practices](best-practices.md).

With the plugin installed you don't need to add the connector or the [global agent rule](agent-rule.md) by hand, although the rule still helps in clients that load skills only when they seem relevant.

## Claude Code

```text
/plugin marketplace add schema-labs-ltd/agentbrain.tools
/plugin install agentbrain@agentbrain
```

Or in one step on Claude Code 2.1.275 or later: `/plugin install agentbrain --marketplace schema-labs-ltd/agentbrain.tools`. Then run `/mcp` and sign in to `agentbrain`. The skill is available as `/agentbrain:agent-brain` and loads on its own when a message contains an `agentBrain:` reference.

## Claude (web and desktop)

Open Customize → Plugins → Add → Add marketplace, enter `schema-labs-ltd/agentbrain.tools`, and install **agentbrain**. Connect the server from the plugin's Connectors tab. Plugins installed this way also sync to Claude Code.

## ChatGPT and Codex

The plugin uses the portable [Agent Plugins](https://developers.openai.com/plugins/build/plugins) format (`plugin.json`, `mcp.json` and `skills/` at the plugin root), and the repository carries `.agents/plugins/marketplace.json`.

```sh
codex plugin marketplace add schema-labs-ltd/agentbrain.tools
```

Restart the ChatGPT desktop app, open the Plugins Directory, choose the **Agent Brain** marketplace and install **agentbrain**. ChatGPT signs in with OAuth on install, identifying itself with a client metadata document (CIMD), which Agent Brain supports.

## Self-hosted servers

The plugin points at `https://agentbrain.tools/mcp`. For your own server, copy `plugins/agentbrain` into your own marketplace and change the URL in both `.mcp.json` (Claude) and `mcp.json` (ChatGPT and Codex).

## Layout

```text
.claude-plugin/marketplace.json      Claude marketplace
.agents/plugins/marketplace.json     ChatGPT and Codex marketplace
plugins/agentbrain/
  .claude-plugin/plugin.json         Claude manifest
  .mcp.json                          Claude MCP config (type "http")
  plugin.json                        Agent Plugins manifest with OpenAI display settings
  mcp.json                           Agent Plugins MCP config (type "streamable-http", OAuth via CIMD)
  skills/agent-brain/SKILL.md        The skill, shared by both
  assets/icon.svg
```

Keep the two manifests' names, versions and server URLs in step; `test/plugins.test.ts` checks this. Bump the version in both manifests and both marketplace entries when the skill or server changes, and validate with `claude plugin validate .`.
