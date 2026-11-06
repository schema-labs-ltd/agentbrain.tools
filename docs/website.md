# Website

Agent Brain serves a small read-only website at its public address, for example https://agentbrain.tools. It is for the person who owns the instance: agents still do all their work through the MCP server at `/mcp`.

## What you can see

- **Projects:** every project with its number of active and closed tasks and when it was last active.
- **Tasks:** each project's brains, active ones first. A brain page shows its `agentBrain:` reference (tap or click to select it for copying), usage against the limits, its documents and the most recent activity, with the client that made each change.
- **Documents:** the rendered Markdown, the Markdown source, and the revision history. Older revisions that are still kept can be opened from the history list.
- **Closed tasks:** listed with their closing time. Closing deletes a brain's documents, so there is nothing else to show.

Nothing on the website changes a brain. The only forms are sign-in and sign-out.

## Signing in

Use the owner email and password from `OWNER_EMAIL` and `OWNER_PASSWORD`, the same ones used on the OAuth consent screen.

- A successful sign-in sets an `HttpOnly`, `SameSite=Lax` session cookie that lasts seven days. On HTTPS deployments it is a `Secure`, `__Host-` cookie. The server stores only a SHA-256 hash of the cookie value.
- Sign-in and sign-out reject posts from other sites (the `Origin` header must match `PUBLIC_URL`).
- After 10 failed attempts from one address in 15 minutes, further attempts from that address are refused until the window passes. On Cloudflare the address comes from `CF-Connecting-IP`; behind your own proxy, set `X-Real-IP`.
- Signing out deletes the session on the server.

Agents and scripts that request `/` without asking for HTML still get the short plain-text pointer to `/mcp`.

## Markdown rendering

Documents are rendered on the server with [marked](https://marked.js.org) (GitHub-flavoured Markdown: tables, task lists, strikethrough and autolinks) and code blocks are highlighted with [highlight.js](https://highlightjs.org). Pages contain no JavaScript.

Because agents write the content, it is treated as untrusted:

- Raw HTML in a document is shown as text, never rendered.
- Links keep only `http`, `https`, `mailto`, relative and `#fragment` targets. Other schemes, such as `javascript:` and `data:`, are dropped and only the link text is shown. External links open in a new tab without a referrer.
- Images load only over `https`.
- A strict Content Security Policy blocks scripts, framing and form posts to other sites.

## Phones

Every page is responsive. On small screens wide tables and long code lines scroll sideways inside their own box rather than stretching the page, and the layout follows the device's light or dark setting.
