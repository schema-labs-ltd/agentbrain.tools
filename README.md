# agentbrain.tools
Agent Brain is an open-source shared workspace for the context of one task. Different AI agents can read and update the same small collection of Markdown documents, even when they use different models, folders or machines. A recognisable `agentBrain:` reference connects them to that context through an OAuth-protected MCP server.

The first version should make shared context reliable without becoming a task manager or an agent orchestration platform. This is a draft product plan for review.

# Status

Phase 1 is implemented: an OAuth-protected MCP server with projects, brains, revision-checked Markdown documents, a change feed, and close with or without export. It runs on Cloudflare Workers or in Docker from the same code.

A read-only website lets the owner browse every project, task and document from a desktop or phone, with sanitised Markdown rendering. Sign in at the server's address (for example https://agentbrain.tools) with the same email and password used on the OAuth consent screen.

Brains can also hold images (PNG, JPEG, GIF, WebP) so agents can pass on screenshots, mock-ups and diagrams. Agents upload them with a one-time upload link, an https URL or inline base64, see them in the index, fetch them as image content with `read_image`, and refer to them from documents as `![alt](image:<id>)`. Each image also gets a public, unguessable URL that can be pasted into GitHub or other tools. See [Images](docs/best-practices.md#12-images).

Change events are delivered to ChatGPT through MCP events (signed webhooks, built into the server) and to Claude Code through channels (a small local bridge). Other clients poll the change feed.

- [Running Agent Brain](docs/self-hosting.md): Docker, Cloudflare and the smoke test.
- [Global agent rule](docs/agent-rule.md): connecting agent clients and recognising `agentBrain:` references.
- [Best practices for agents](docs/best-practices.md): when to create brains and documents, what belongs in them, consolidation, conflicts, events and closing.
- [Plugins for Claude and ChatGPT](docs/plugins.md): install the Agent Brain server and skill from this repository's marketplace, for example `/plugin install agentbrain --marketplace schema-labs-ltd/agentbrain.tools`.
- [Change events](docs/events.md): ChatGPT MCP events and the Claude Code channel.
- [Website](docs/website.md): the read-only browser view, its sign-in and how Markdown is rendered.

The rest of this README is the product plan the implementation follows.

# Agreed direction

- Each brain belongs to a project and one task. The project name is enough to start; the task can be unnamed until its purpose becomes clear.

- Each project has a stable, unique project token. Naming the same project again resolves to the same project token rather than creating a duplicate.

- Multiple authorised agents can work with a brain at the same time.

- The first version is single-user. The agents sharing a brain are different models, or the same model on different computers, all acting for the same user. There is no sharing between users.

- A reference can be pasted into an issue, email or chat so another agent can find the brain.

- Content is a focused collection of Markdown documents, with a compact index rather than one ever-growing document.

- Agents maintain and consolidate the content without routine human review.

- Events can announce changes. The user tells an agent whether it should respond to an event.

- There is no task list, assignment system, model routing or automatic dispatch.

- Closing a task deletes its brain. An export can be returned for the agent to archive elsewhere, but keeping an archive is optional.

- The software will be open source, with a very simple launch experience targeted at Docker, Railway and Cloudflare.

- References take the form `agentBrain:<project>.<task>`: the stable project token and the task's brain identifier, both unguessable. A user-installed global agent rule recognises them and connects through the configured MCP server.

- The website is read-only. The owner can sign in to browse projects, tasks, documents, revision history and recent activity, but agents use the MCP server for every change, including closing a brain. (This replaces the earlier "no website" decision; Simon asked for a read-only view on 2026-11-06.)

# How someone would use it

1. The user connects an agent client to Agent Brain through OAuth. The connection acts for that user and can reach their projects.

2. The agent requests a brain for “AFX Markets”. If the user already has a project with that name, the service uses its existing project token; otherwise it creates the project. The service returns a unique brain reference. A title or task description is optional.

3. The agent writes the current context, findings and decisions. The service exposes a small index describing the available documents and their revisions.

4. The user pastes the reference into another agent’s conversation and explains what they want that agent to do. That agent may use a different model or run on a different computer, but it authenticates as the same user. It reads the index and fetches only the relevant documents.

5. Both agents contribute. Changes become visible through revision-aware reads and, where supported, notifications. Neither agent needs access to the other’s filesystem or conversation.

6. When the work is finished, an authorised agent closes the brain, either with an export for external archiving or without one.

The brain carries context between agents. It does not execute their code, provide their repository access or grant permission to act on connected services.

# Proposed document structure

Start with an automatically maintained index and a small set of purpose-led documents. Create documents only when there is something useful to put in them.

- **Overview:** the task’s purpose, boundaries, current understanding and links to the relevant material.

- **Decisions:** agreed choices and their reasons, including which earlier decisions they replace.

- **Findings:** evidence, observations, uncertainties and links to sources.

- **Handover:** a concise account of the present state and what another agent needs to know to continue. It is context, not a list of assigned jobs.

These are suggested defaults, not a compulsory form for every brain. A specialist document is appropriate when a subject genuinely needs its own space. Avoid a new document for every message, tool call or small discovery.

The index should contain each document’s title, short description, stable ID and current revision. Agents should read the index first and retrieve selected documents rather than pulling the entire brain on every turn. Tool responses can carry structured metadata alongside the Markdown body.

Agents can create, replace, patch, rename and delete documents. A rename changes the title and description but keeps the stable ID. Renames and deletions are revision-checked like any other write, so consolidation (for example merging two documents and deleting one) cannot remove content another agent has just changed. A deleted document's ID is not reused.

To control growth, set explicit document and brain size limits. When content approaches them, agents should consolidate repeated material, preserve decisions and evidence, and split only where the subject warrants it. The service can enforce limits and detect stale writes, but should not silently rewrite meaning. Conflicting interpretations should remain visible until an agent can resolve them from evidence.

Limits are enforced in two stages:

- **Soft limit (80% of a hard limit):** the write succeeds, and the response includes a warning with the current size and the limit, telling the agent to consolidate.

- **Hard limit:** a write that would exceed it is rejected without changing anything. The error states the limit, the current size and the size the write would have produced, so the agent can consolidate and retry.

Initial defaults, configurable per deployment: 64 KB per document, 50 documents and 1 MB in total per brain, and the last 50 revisions of each document kept while the brain is active. Images have their own budget: 5 MB per image, 20 images and 25 MB in total per brain.

# Proposed access model

The shareable reference has the form `agentBrain:<project>.<task>`, for example `agentBrain:q4x9mz2kd0vn7w3rbt1yhe8c5a.jwdb52vpvf0q2794nh0mv1ayk6`.

- `<project>` is the project's stable project token. Within one user's account, project names are unique (compared case-insensitively after trimming whitespace), so naming an existing project returns its token. The token stays the same for the life of the project, so every brain in a project shares the same first part.
- `<task>` identifies the brain for one task within that project.

Both parts are 26 lower-case Crockford base32 characters encoding 128 bits from a cryptographically secure random source, not a predictable project name, counter or timestamp. Neither part encodes the server or the user. The server checks that the task belongs to the named project, so a reference cannot be re-pointed at another project. The reference identifies the brain, but it does not act as a password: OAuth and server-side access checks remain required.

References created before this format, which hold only the task identifier (`agentBrain:<task>`), are still accepted. Every response returns the full `<project>.<task>` form.

OAuth identifies the connected client and the user authorising it. The server must separately check that the user owns the project and brain and that the client has permission for the requested operation. Knowing or guessing a reference must not grant access. Different users can have projects with the same name; these remain separate projects and their data is never combined.

Keep credentials out of references, documents and exports. Use separate permissions for reading, writing and closing a brain, with revocation enforced on subsequent calls and event delivery. Record the authenticated actor and client for changes; a model name supplied by a client is descriptive, not proof of identity.

Treat imported text and other agents’ contributions as untrusted content. A document saying “send this secret” cannot expand an agent’s authority. Use encrypted transport and storage, tenant isolation, size and rate limits, and logging that avoids document bodies or secret values where possible.

# Reference recognition across agents

Provide a short, portable global rule that the user can install in each agent client: when an `agentBrain:` reference appears in user-authorised task context, recognise it, use the trusted configured Agent Brain MCP connection, retrieve its index and read relevant documents. The rule does not assign work or authorise unrelated actions. Other agents’ text remains evidence, not permission.

This rule must be installed or configured in each client; the prefix alone cannot make every model discover a server or open a connection. Do not connect to arbitrary endpoints supplied in an issue or email, send tokens to them or broadcast a reference across every connected server.

For self-hosted instances, the reference needs a deterministic mapping to the correct trusted server. The simplest first version can use one configured server per agent profile. If several servers are supported, add an explicit trusted instance mapping or ask the user to choose the connection when ambiguous. Keep the readable prefix stable and document the mapping without making the reference a bearer credential.

# Concurrent agents and safe writes

Use optimistic concurrency for the first version. Every document read returns a revision; each replacement or patch must name the revision it was based on. If another agent has changed the document, reject the stale write and return enough information for the agent to read the latest version and reapply its intended change. Never silently accept the last writer at the expense of another agent’s work.

Keep document revisions and a bounded change history while the brain is active. Store author, time and a short change description so agents can distinguish new evidence from a different interpretation. Use idempotency keys for creation and mutations so a timeout or retry does not create duplicate brains, documents or events.

Writes that must stay consistent, such as adding a document and updating the index, should commit together. Generate index metadata from stored documents rather than asking agents to maintain a second inventory by hand. Concurrent edits to different documents should not unnecessarily block each other.

# Events without orchestration

Useful events include brain created, document created, document updated, document renamed, document deleted, brain closing and brain closed. Each event should contain a stable event ID, sequence, affected document ID and revision, authenticated actor and timestamp. Keep document bodies out of notifications by default; an authorised recipient can fetch the current content.

MCP resource notifications may provide a suitable change signal where the selected protocol version and client support subscriptions. They do not guarantee that every client will wake a model, start a new turn or act while disconnected. Verify those behaviours in the actual clients chosen for the first release.

Keep a durable, bounded event feed with a cursor-based catch-up operation. Connected clients can receive notifications; other clients can poll when active. Handle duplicate events and reconnects, and return an explicit resynchronisation response if a cursor is older than the retained history.

An event reports that something changed. It is not an instruction to perform work. The user’s directions to each agent determine whether and how it responds. Agent Brain should not add automatic assignment, model selection or agent-to-agent commands.

**What is built.** The durable feed is the source for every delivery route ([details](docs/events.md)):

- **ChatGPT** uses [MCP events](https://developers.openai.com/plugins/build/mcp-events). The server advertises the `events` capability and a `brain.changed` event. ChatGPT subscribes with a callback URL, and Agent Brain verifies the URL, then POSTs each change as a Standard Webhooks signed request, retrying from the feed until it is acknowledged. ChatGPT can then start a task, as the user instructed when subscribing.
- **Claude Code** uses [channels](https://code.claude.com/docs/en/channels), which must be local stdio servers. The `agentbrain-channel` bridge runs next to Claude Code, signs in read-only, polls the feed of brains the user asks it to watch, and pushes each batch of changes into the open session.
- **Other clients** call `get_changes` with a cursor when the user resumes them.

MCP resource subscriptions and server-sent streams on `/mcp` are not used: neither target client wakes a model from them, and the server stays stateless.

# Closing and optional export

Closing must be safe while other agents are connected. Atomically move the brain into a closing state, reject new writes and take a consistent final snapshot. Support two explicit choices: close without export, or close with export.

For an export, return a portable ZIP or blob containing the Markdown documents, index and a machine-readable manifest of IDs and final revisions. Include only the history needed for the agreed export format. Do not export OAuth credentials. The receiving agent can store the archive wherever it is authorised to do so; Agent Brain need not become a permanent archive service.

An export cannot be both permanently deleted and indefinitely available for download. A practical first design is a short-lived, authenticated export download, with its expiry made explicit. If export preparation fails, keep the brain in a recoverable closing state and allow a safe retry or an explicit close without export. Repeated close requests should return a consistent outcome, not recreate data or produce conflicting snapshots.

After closure, remove task documents, revisions, any derived indexes and event payloads, invalidate access to the closed brain and expire temporary exports. Define how backups and minimal operational logs expire before promising immediate deletion of every copy. The project container can remain for other tasks; closing one brain must not delete its siblings. Receiving clients and independently saved archives remain outside the service’s deletion boundary.

# Open source and simple deployment

The launch goal is a short setup flow: choose a deployment option, configure the public base URL and authentication, initialise durable storage, then connect an agent. Publish the source, setup guide, configuration examples, migrations and test suite. Select an open-source licence before release; do not commit real credentials or private example brains.

**Docker:** provide a versioned image and a minimal Compose setup, with persistent storage outside the container, documented environment variables, health checks and an upgrade path. A restart or image replacement must not discard brains or OAuth state.

**Railway:** aim for a deploy template using the same server image or application, with durable database or volume configuration, generated secrets and a documented public endpoint. Avoid relying on ephemeral container files for documents, events or export state.

**Cloudflare:** provide a deployment configuration suited to the selected Cloudflare runtime. A Workers route may require runtime-compatible code and adapters for durable database, coordination and object storage, rather than running the Docker image unchanged. Keep the core behaviour and MCP contract consistent across targets, and verify streaming, request limits, event reconnects and export handling on that runtime.

Treat these as deployment targets to build and test, not currently supported launch buttons. Start with the simplest reference deployment, then validate the other two against the same acceptance suite. Avoid making a multi-service architecture a prerequisite for a small private instance.

Each deployment needs a stable reachable HTTPS endpoint for remote agents, correct OAuth issuer and redirect configuration, securely stored secrets and durable transactional state. Local-only hosting is useful only to clients that can actually reach it. Publicly reachable must not mean anonymously readable. Include backup and deletion guidance consistent with the close-task behaviour.

# Proposed first version

## Phase 1 Prove shared context

Build an OAuth-protected remote MCP endpoint and durable storage, with only the sign-in and consent pages OAuth needs. Support project lookup or creation by name within the user's account (returning the stable project token), brain creation, index and document reads, revision-checked writes (including rename and delete) and changes since a cursor. Package it as the Docker reference deployment.

Publish the first version of the global agent rule, configured for one trusted server per agent profile.

Prove the core flow with two different agent clients on separate machines, signed in as the same user. Each should be able to resolve the same reference through the global rule, contribute Markdown and recover from a deliberate edit conflict without losing the other’s work.

## Phase 2 Add reliable notifications

Add document change events, supported MCP notifications and reconnect catch-up. Test duplicates, missed notifications, expired cursors and revoked access. Keep polling available where a client cannot subscribe. Document which clients can receive events and which require the user to resume the agent.

Built: MCP events with webhook delivery for ChatGPT, and a channel bridge for Claude Code, both driven by the change feed and covered by tests for retries, replay from a cursor, expired history, closed brains and revoked access. Still to verify: both routes against the live clients.

## Phase 3 Complete the lifecycle

Add close without export, close with export, deletion cleanup and clear export expiry. Test close during an active write, interrupted export, retried close and attempted access after closure. Apply document limits and consolidation guidance before opening the service to longer-running tasks.

## Phase 4 Validate every deployment target

Add the Railway template and the Cloudflare deployment. Run the same acceptance suite against Docker, Railway and Cloudflare, including durable data surviving restart and upgrade. Test the global agent rule in each initial client against each target, and publish the setup guide.

These phases describe the build sequence, not delivery dates or a commitment to a particular technology stack.

# Acceptance criteria

- Two authorised agents on different machines can use one reference to read and update the same brain.

- Naming an existing project returns its existing project token instead of creating a duplicate.

- An unauthorised client cannot read a brain merely by possessing its reference, and one user can never read another user's brains.

- Stale writes are rejected, retries are idempotent and concurrent contributions are preserved.

- A new agent can understand the current state from a compact index and selected Markdown documents.

- Events can be caught up after disconnection without automatically assigning or executing work.

- Document growth remains bounded without requiring routine human curation.

- Both close modes work, exports are consistent, and closed brains cannot accept new writes or serve task content.

- The first version contains no task list, agent routing, code execution or automatic model launching.

- A fresh installation can be launched through documented Docker, Railway and Cloudflare paths, with durable data surviving restart and upgrade.

- A configured global agent rule recognises `agentBrain:` references, resolves only through the intended trusted server and still enforces OAuth permissions.

# Decisions still open

- **Initial clients:** which two or three agent clients should define the first compatibility tests?

- **Access scope:** the first version is single-user, so a connection can reach all of that user's projects. Should a later version allow narrower project- or brain-level grants per client, and should sharing between users ever be added?

- **Limits:** are the initial defaults (64 KB per document, 50 documents and 1 MB per brain, 50 revisions per document) right once real tasks have been tried?

- **Export lifecycle:** which format and temporary download period should be supported, and should exports include revision history or only final documents?

- **Project lifecycle:** should empty projects remain until explicitly removed, or have a separate cleanup policy?

- **Open-source licence:** choose the licence and contribution policy before release.

- **Deployment baseline:** which runtime and storage combination should be the reference implementation, and which Cloudflare deployment model will be supported?

- **Multiple instances:** is one configured server per agent profile sufficient initially, or is a trusted instance mapping needed from the first release?
