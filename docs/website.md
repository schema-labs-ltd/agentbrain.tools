# Website

Agent Brain serves a small read-only website at its public address, for example https://agentbrain.tools. Each person sees only their own projects and brains: agents still do all their work through the MCP server at `/mcp`.

## What you can see

- **Projects:** every project with its number of active and closed tasks and when it was last active.
- **Tasks:** each project's brains, active ones first. A brain page shows its `agentBrain:` reference (tap or click to select it for copying), usage against the limits, its documents, a gallery of its images and the most recent activity, with the client that made each change.
- **Images:** each image on its own page with its description, type, size and dimensions, the `image:<id>` reference to use in documents, and its public link.

Every image also has a public link, `/i/<token>.<ext>`, that anyone can open without signing in, so agents can show images in GitHub and other tools. The token is random and unrelated to the project or brain. The link returns 404 once the image is deleted or its brain is closed; caches may keep it for up to an hour.
- **Documents:** the rendered Markdown, the Markdown source, and the revision history. Older revisions that are still kept can be opened from the history list.
- **Closed tasks:** listed with their closing time. Closing deletes a brain's documents, so there is nothing else to show.

Nothing on the website changes a brain. The only forms are sign-in, sign-out and the **API keys** page, where you create and revoke keys for agents that cannot sign in through a browser (see [API keys](api-keys.md)).

## Signing in

With Clerk configured, the sign-in page shows Clerk's sign-in and anyone invited in Clerk can sign in (see [accounts](accounts.md)). Otherwise, use the owner email and password from `OWNER_EMAIL` and `OWNER_PASSWORD`, the same ones used on the OAuth consent screen.

Opening a project or brain that belongs to another account shows a "Belongs to another account" page (HTTP 403).

- A successful sign-in sets an `HttpOnly`, `SameSite=Lax` session cookie that lasts seven days. On HTTPS deployments it is a `Secure`, `__Host-` cookie. The server stores only a SHA-256 hash of the cookie value.
- Sign-in and sign-out reject posts from other sites (the `Origin` header must match `PUBLIC_URL`).
- After 10 failed attempts from one address in 15 minutes, further attempts from that address are refused until the window passes. On Cloudflare the address comes from `CF-Connecting-IP`; behind your own proxy, set `X-Real-IP`.
- Signing out deletes the session on the server, and with Clerk also signs the browser out of Clerk.
- With Clerk, a session ends within 15 minutes of the person being removed, banned or locked in Clerk.

Agents and scripts that request `/` without asking for HTML still get the short plain-text pointer to `/mcp`.

## Markdown rendering

Documents are rendered on the server with [marked](https://marked.js.org) (GitHub-flavoured Markdown: tables, task lists, strikethrough and autolinks) and code blocks are highlighted with [highlight.js](https://highlightjs.org). Pages contain no JavaScript, except the sign-in page when Clerk is configured.

Because agents write the content, it is treated as untrusted:

- Raw HTML in a document is shown as text, never rendered.
- Links keep only `http`, `https`, `mailto`, relative and `#fragment` targets. Other schemes, such as `javascript:` and `data:`, are dropped and only the link text is shown. External links open in a new tab without a referrer.
- Images load only over `https`, or from the brain itself when a document refers to one as `![alt](image:<id>)`. Brain images are served only to the signed-in owner, with `nosniff` and a sandboxing Content Security Policy, and only PNG, JPEG, GIF and WebP are ever stored.
- A strict Content Security Policy blocks scripts, framing and form posts to other sites.

## Phones

Every page is responsive. On small screens wide tables and long code lines scroll sideways inside their own box rather than stretching the page, and the layout follows the device's light or dark setting.
