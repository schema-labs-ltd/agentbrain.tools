# API keys

Most agents connect to Agent Brain with OAuth: the first tool call opens a sign-in page in the browser. Agents that run without a browser cannot do that. A server that calls the Claude API with [Anthropic's MCP connector](https://docs.claude.com/en/docs/agents-and-tools/mcp-connector), for example, can only send a fixed `Authorization: Bearer <token>` header. For those agents, create an API key.

A key acts as the person who created it on the MCP endpoint (`/mcp`), within the limits set on the key. OAuth sign-in keeps working exactly as before; the server accepts either.

## Creating a key

1. Sign in to the website (for example https://agentbrain.tools) and open **API keys** in the top bar.
2. Give the key a name that says which agent uses it, for example "Change Request intake agent". The name appears in document history and events as `API key "<name>"`, so changes made with the key can be traced.
3. Choose its access:
   - **Read and write**: read, create and change projects, brains, documents and images.
   - **Read-only**: read only.

   No key can close a brain, because closing permanently deletes it. Close brains from an agent signed in with OAuth.
4. Optionally tick the projects the key may use. A key limited to projects sees only those projects in `list_projects` and `list_brains`, and cannot create or open any other project. Leave them all unticked to allow every project, including new ones.
5. Select **Create key** and copy the key straight away. It starts with `abk_` and is shown only once: the server stores only its SHA-256 hash.

The list on the same page shows each key's name, first few characters, access, projects, creation time and when it was last used (updated at most once a minute). **Revoke** stops a key immediately: the next request that uses it gets HTTP 401. A key also stops working if its owner's account is removed or suspended. Each account can have up to 50 keys.

Treat a key like a password. Keep it in a secret store (for example `npx wrangler secret put AGENTBRAIN_API_KEY` for a Cloudflare Worker), never in a repository, a brain or a prompt.

## Using a key

Send the key as a bearer token to the MCP endpoint. Each request is independent: no session or `initialize` call is needed, and responses are plain JSON.

```sh
curl https://agentbrain.tools/mcp \
  -H "Authorization: Bearer $AGENTBRAIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "create_brain",
      "arguments": { "project": "Change Requests", "title": "CR-1042 new export format" }
    }
  }'
```

The result's text content is JSON with the new brain's `reference`. Pass it to `create_document`, `read_index` and the other tools in the same way.

With Anthropic's MCP connector, give the key as the server's `authorization_token`:

```json
"mcp_servers": [
  { "type": "url", "url": "https://agentbrain.tools/mcp", "name": "agentbrain", "authorization_token": "abk_..." }
]
```

Every tool works with a key except `close_brain`, including `read_guide`, `list_projects`, `open_project`, `list_brains`, `create_brain`, `read_index`, `read_documents`, `create_document`, `patch_document`, `replace_document` and `upload_image`.

## Errors

- **HTTP 401** with `error: "invalid_token"`: the key is wrong, revoked, or its account has been switched off.
- **HTTP 403**: the call is outside the key's limits. The body is still the JSON-RPC response, and its tool result is an error with code `forbidden`, `limit: "api_key"` and a message saying which limit applied: the key is read-only, it is limited to other projects (with `allowedProjects`), or it tried to close a brain. Nothing is changed. Ask the person who owns the key for a key with the access you need rather than retrying.

## Audit

There is no separate audit log. Every change already records who made it: changes made with a key show as `API key "<name>"` in document history, the website's activity list and change events, and each key records when it was last used.
