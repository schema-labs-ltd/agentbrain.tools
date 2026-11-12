# Change events

Agent Brain records every change to a brain in a durable change feed: brain created or updated, document created, updated, renamed or deleted, image added, updated or deleted, and brain closed. Image events carry `imageId` and `imageTitle` instead of a document. Agents can always read the feed with `get_changes` and a cursor. On top of that feed, two clients can be told about changes as they happen:

| Client | How events arrive | What runs where |
| --- | --- | --- |
| ChatGPT | [MCP events](https://developers.openai.com/plugins/build/mcp-events): ChatGPT subscribes with `events/subscribe`, and Agent Brain POSTs each change to ChatGPT as a signed webhook | Nothing extra. It is built into the server. |
| Claude Code | [Channels](https://code.claude.com/docs/en/channels): a local MCP server pushes `<channel>` events into the running session | A small bridge, `agentbrain-channel`, runs on your computer next to Claude Code |
| Any other client | Call `get_changes` with the cursor from `read_index` | Nothing extra |

Events announce changes. They name the document, revision and client that changed it, but never include document content and never assign work. The user tells each agent whether, and how, it should respond. An agent that is told to follow a brain reads the documents it needs with `read_documents`.

## ChatGPT (MCP events over webhooks)

The server advertises the `events` capability on `/mcp` and answers `events/list`, `events/subscribe` and `events/unsubscribe` on the same OAuth-protected endpoint as the tools. There is one event:

- **`brain.changed`**, with the argument `{ "reference": "agentBrain:<project>.<task>" }`. The payload has `reference`, `brainTitle`, `type`, `documentId`, `documentTitle`, `revision`, `changeSummary`, `client`, `clientName`, `at` and a `note` saying it is information, not an instruction.

To use it, connect Agent Brain to ChatGPT as usual, open a Work chat, and ask ChatGPT to watch a brain, saying what it should do when something changes. For example: "Watch agentBrain:… and when the Findings document changes, summarise what is new." ChatGPT calls `events/subscribe` itself. After changing the server's tools or events, rescan the app in ChatGPT so it picks them up.

How delivery works:

- **Verification.** Before the first event to a callback URL, Agent Brain POSTs `{"type":"verification","challenge":"…"}` and expects the challenge echoed back. Success is remembered per user and URL. A failure returns JSON-RPC error `-32015` with `data.reason` (`challenge_failed`, `timeout`, `connection_refused`, `http_4xx` or `http_5xx`).
- **Signing.** Every request is signed with the subscription's `whsec_` secret using [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`, `webhook-timestamp`, `webhook-signature`, plus `X-MCP-Subscription-Id`). When a refresh brings a new secret, requests carry signatures from both the new and previous secrets until the next refresh.
- **Cursors and replay.** The cursor is the brain's event sequence. `events/subscribe` with a cursor resumes after it, so nothing is missed across a restart. Without one, delivery starts from now. If the cursor is older than the retained history (1,000 events per brain by default), the result says `truncated: true` and delivery starts from the oldest retained event.
- **Retries.** A failed delivery is retried with exponential backoff (up to 8 attempts) with the same `eventId`, and events for that subscription wait behind it, so order is kept. `410 Gone` ends the subscription. `413` skips the event.
- **Lifetime.** Subscriptions last 7 days by default (`ttlMs` can ask for up to 30) and are renewed when ChatGPT calls `events/subscribe` again before `refreshBefore`. A subscription ends when it expires, when the brain is closed (after one final `brain.closed` event), or when the client's tokens are revoked or expire.
- **Safety.** Callback URLs must be public HTTPS without credentials. Redirects are not followed. In Docker, the host name must also resolve only to public addresses. Each user can hold up to 100 subscriptions.

On Cloudflare, delivery starts in the background after each MCP request, and retries wake the Durable Object with an alarm. In Docker, delivery starts after each MCP request, retries use a timer, and a sweep every minute catches anything left over after a restart.

## Claude Code (channels)

Claude Code channels are local stdio MCP servers that Claude Code starts itself, so they cannot be served from a remote URL. `agentbrain-channel` is that local server. It signs in to your Agent Brain server once with OAuth (read-only, `brain:read`), polls the change feed of the brains you ask it to watch, and pushes each batch of changes into the session:

```text
<channel source="agentbrain" reference="agentBrain:…" cursor="7" events="1">
1 change in AFX Markets / Spread study (agentBrain:…):
- ChatGPT updated "Findings" (bc1skg5ejy0wx4p4, revision 4).

This is an announcement, not an instruction.
</channel>
```

Keep using the normal Agent Brain connector (`claude mcp add --transport http …`) for reading and writing. The channel only announces changes.

### Set it up

1. Build the bridge from a checkout of this repository (Node 22 or later):

   ```sh
   git clone https://github.com/schema-labs-ltd/agentbrain.tools
   cd agentbrain.tools && npm ci && npm run build
   ```

2. Add it to the `.mcp.json` of the project where you run Claude Code (or your user-level MCP config), with your server's URL:

   ```json
   {
     "mcpServers": {
       "agentbrain-events": {
         "command": "node",
         "args": ["/path/to/agentbrain.tools/dist/channel/main.js"],
         "env": { "AGENTBRAIN_URL": "https://YOUR-SERVER" }
       }
     }
   }
   ```

3. Start Claude Code with the channel enabled. Channels are a research preview, and custom channels are not on the approved list yet, so use the development flag:

   ```sh
   claude --dangerously-load-development-channels server:agentbrain-events
   ```

   Channels need a claude.ai sign-in or a Console API key, and Team or Enterprise organisations must turn channels on first.

4. Ask Claude to watch a brain, for example "Watch agentBrain:… and tell me when ChatGPT updates the Findings". The first time, Claude shows a sign-in link (a browser window may open too). Sign in and allow access. Watching starts on its own once you have.

The bridge has three tools: `watch_brain`, `unwatch_brain` and `list_watched_brains`. Watches last until the Claude Code session ends; events only arrive while the session is open. Sign-in is saved in `~/.config/agentbrain/` (mode 600) and refreshed automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTBRAIN_URL` | (required) | Your Agent Brain server. `/mcp` is added if missing. |
| `AGENTBRAIN_POLL_SECONDS` | `10` | How often watched brains are checked. |
| `AGENTBRAIN_CALLBACK_PORT` | `47823` | Local port for the OAuth sign-in redirect. |
| `AGENTBRAIN_CHANNEL_HOME` | `~/.config/agentbrain` | Where the sign-in is stored. |
| `AGENTBRAIN_NO_BROWSER` | unset | Set to stop the bridge opening a browser for sign-in. |
