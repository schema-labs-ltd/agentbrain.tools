import { clerkScripts, type ClerkPage } from "./clerkui.js";
import { escapeHtml as esc } from "./markdown.js";
import type { ActivityItem, BrainIndex, BrainListing, BrainSummary, DocumentSummary, ImageSummary, ProjectOverview } from "./store.js";

/** HTML for the read-only website. No JavaScript: everything is server-rendered. */

export const SITE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on form posts, which the CSRF check rejects.
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `
:root { color-scheme: light dark;
  --bg:#f7f7f5; --fg:#1b1b1a; --muted:#64645f; --card:#fff; --line:#e2e2dc; --soft:#f0f0ec; --accent:#2f5d50; --accent-fg:#fff; --err:#a3322b; --warn-bg:#fbf3dc; --warn-line:#e7d49a;
  --k:#a0365e; --s:#2f6f3e; --n:#9a5b00; --c:#7a7a74; --t:#2a5aa8; --a:#7a4fb0; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#141413; --fg:#ececea; --muted:#a3a39e; --card:#1e1e1d; --line:#33332f; --soft:#262624; --accent:#7cc0aa; --accent-fg:#10201b; --err:#ef8a80; --warn-bg:#3a3220; --warn-line:#6b5a2c;
  --k:#f08bb0; --s:#9fd08a; --n:#f0b86a; --c:#8d8d87; --t:#8fb6f2; --a:#c6a3f0; } }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; overflow-wrap:break-word; }
a { color:var(--accent); }
.top { position:sticky; top:0; z-index:5; background:var(--card); border-bottom:1px solid var(--line); }
.top-in { max-width:920px; margin:0 auto; padding:10px 16px; display:flex; align-items:center; gap:12px; }
.brand { font-weight:700; color:var(--fg); text-decoration:none; margin-right:auto; white-space:nowrap; }
.top form { margin:0; }
.btn { display:inline-block; padding:8px 14px; min-height:40px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); font:inherit; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.wrap { max-width:920px; margin:0 auto; padding:20px 16px 64px; }
.crumbs { font-size:14px; color:var(--muted); margin:0 0 12px; display:flex; flex-wrap:wrap; gap:4px 6px; }
.crumbs a { color:var(--muted); }
h1 { font-size:26px; line-height:1.25; margin:0 0 6px; }
h2.section { font-size:18px; margin:32px 0 10px; }
.lead { color:var(--muted); margin:0 0 16px; }
.meta { color:var(--muted); font-size:14px; display:flex; flex-wrap:wrap; gap:4px 14px; margin:0 0 16px; }
.pill { display:inline-block; font-size:12px; font-weight:600; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); vertical-align:middle; }
.pill.active { color:var(--accent); border-color:var(--accent); }
.list { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.item { background:var(--card); border:1px solid var(--line); border-radius:12px; }
.item > a, .item > div { display:block; padding:14px 16px; color:inherit; text-decoration:none; }
.item > a:hover { background:var(--soft); border-radius:12px; }
.item .name { font-weight:600; color:var(--accent); }
.item .desc { color:var(--muted); font-size:15px; margin-top:2px; }
.item .meta { margin:6px 0 0; font-size:13px; }
.ref { display:block; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:8px 10px; user-select:all; -webkit-user-select:all; word-break:break-all; margin:0 0 16px; }
.notice { background:var(--warn-bg); border:1px solid var(--warn-line); border-radius:10px; padding:10px 14px; margin:0 0 16px; font-size:15px; }
.empty { color:var(--muted); background:var(--card); border:1px dashed var(--line); border-radius:12px; padding:20px 16px; }
.activity { list-style:none; margin:0; padding:0; font-size:14px; }
.activity li { padding:8px 0; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:2px 10px; }
.activity time, .activity .who { color:var(--muted); }
details.source { margin:28px 0 0; background:var(--card); border:1px solid var(--line); border-radius:12px; }
details.source summary { cursor:pointer; padding:12px 16px; font-weight:600; font-size:15px; }
details.source pre { margin:0; border-radius:0 0 12px 12px; border:0; border-top:1px solid var(--line); white-space:pre-wrap; }
.history { list-style:none; margin:0; padding:0; font-size:14px; }
.history li { padding:8px 0; border-bottom:1px solid var(--line); }
.history .cur { font-weight:700; }
.history .sum { color:var(--muted); display:block; }
.card { max-width:420px; margin:40px auto 0; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
.card:has(.clerk) { max-width:480px; }
.clerk { display:flex; justify-content:center; margin:8px 0 16px; }
.clerk:empty { min-height:120px; }
.clerk[hidden], [hidden] { display:none !important; }
.muted { color:var(--muted); font-size:14px; }
.card label { display:block; font-size:14px; font-weight:600; margin:12px 0 4px; }
.card input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; font-size:16px; }
.card .btn { width:100%; margin-top:20px; }
.error { color:var(--err); margin:8px 0 0; }
.gallery { list-style:none; margin:0; padding:0; display:grid; gap:10px; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); }
.gallery .item > a { padding:0; height:100%; }
.gallery .thumb { display:block; width:100%; aspect-ratio:4/3; object-fit:contain; background:var(--soft); border-radius:12px 12px 0 0; border-bottom:1px solid var(--line); }
.gallery .cap { padding:10px 12px; }
.gallery .desc { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-size:14px; }
.figure { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin:0 0 16px; text-align:center; }
.figure img { max-width:100%; height:auto; border-radius:6px; background:var(--soft); }
.md a.brain-image { display:inline-block; }

/* Rendered Markdown */
.md { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; font-size:16px; }
.md > :first-child { margin-top:0; }
.md > :last-child { margin-bottom:0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { line-height:1.3; margin:1.6em 0 .5em; position:relative; scroll-margin-top:64px; }
.md h1 { font-size:1.6em; } .md h2 { font-size:1.35em; padding-bottom:.25em; border-bottom:1px solid var(--line); } .md h3 { font-size:1.15em; } .md h4, .md h5, .md h6 { font-size:1em; }
.md .anchor { position:absolute; left:-0.9em; color:var(--muted); text-decoration:none; opacity:0; padding-right:.2em; }
.md h1:hover .anchor, .md h2:hover .anchor, .md h3:hover .anchor, .md h4:hover .anchor { opacity:1; }
.md p, .md ul, .md ol, .md blockquote, .md .table-wrap, .md .code { margin:0 0 1em; }
.md ul, .md ol { padding-left:1.5em; }
.md li + li { margin-top:.25em; }
.md li > ul, .md li > ol { margin:.25em 0 0; }
.md li:has(> input[type=checkbox]) { list-style:none; margin-left:-1.3em; }
.md input[type=checkbox] { margin:0 .4em 0 0; vertical-align:-1px; }
.md blockquote { padding:.2em 1em; border-left:4px solid var(--line); color:var(--muted); }
.md hr { border:0; border-top:1px solid var(--line); margin:1.6em 0; }
.md img { max-width:100%; height:auto; border-radius:6px; }
.md code { font:.875em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--soft); border-radius:5px; padding:.1em .35em; }
.md .code { position:relative; }
.md .code-lang { position:absolute; top:6px; right:10px; font:12px ui-monospace,monospace; color:var(--muted); pointer-events:none; }
.md .code.labelled pre { padding-top:30px; }
pre { background:var(--soft); border:1px solid var(--line); border-radius:10px; padding:14px 16px; overflow-x:auto; -webkit-overflow-scrolling:touch; font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; tab-size:2; margin:0; }
.md pre code { background:none; padding:0; font-size:inherit; border-radius:0; }
.table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--line); border-radius:10px; }
.md table { border-collapse:collapse; width:100%; font-size:15px; }
.md th, .md td { padding:8px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; min-width:7em; }
.md tr > :not(:last-child) { border-right:1px solid var(--line); }
.md tbody tr:last-child > * { border-bottom:0; }
.md thead th { background:var(--soft); font-weight:600; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-doctag, .hljs-meta .hljs-keyword { color:var(--k); }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-template-tag, .hljs-template-variable { color:var(--s); }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet, .hljs-variable.constant_ { color:var(--n); }
.hljs-comment, .hljs-quote, .hljs-meta { color:var(--c); font-style:italic; }
.hljs-title, .hljs-section, .hljs-name, .hljs-selector-id, .hljs-selector-class, .hljs-type { color:var(--t); }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-params, .hljs-variable { color:var(--a); }
.hljs-deletion { color:var(--err); }
.hljs-emphasis { font-style:italic; } .hljs-strong { font-weight:700; }

@media (max-width:600px) {
  body { font-size:16px; }
  h1 { font-size:22px; }
  .wrap { padding:14px 12px 48px; }
  .top-in { padding:8px 12px; }
  .md { padding:14px; border-radius:10px; }
  .md .anchor { display:none; }
  pre { font-size:12.5px; padding:12px; }
  .md table { width:max-content; min-width:100%; }
  .md th, .md td { padding:6px 10px; font-size:14px; min-width:5em; max-width:15em; }
}
`;

export interface SiteUser {
  email: string;
}

function page(title: string, body: string, user?: SiteUser): string {
  const header = `<header class="top"><div class="top-in"><a class="brand" href="/">Agent Brain</a>${
    user ? `<form method="post" action="/logout"><button class="btn" type="submit">Sign out</button></form>` : ""
  }</div></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin"><title>${esc(title)} · Agent Brain</title><style>${STYLE}</style></head><body>${header}<main class="wrap">${body}</main></body></html>`;
}

function when(isoString: string): string {
  const d = new Date(isoString);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `<time datetime="${esc(isoString)}">${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC</time>`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function brainPath(reference: string): string {
  const [project, brain] = reference.slice("agentBrain:".length).split(".");
  return `/brains/${project}/${brain}`;
}

function brainTitle(b: { title: string | null }): string {
  return b.title ?? "Untitled task";
}

function crumbs(parts: { href?: string; label: string }[]): string {
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts
    .map((p) => (p.href ? `<a href="${esc(p.href)}">${esc(p.label)}</a>` : `<span>${esc(p.label)}</span>`))
    .join("<span aria-hidden=\"true\">/</span>")}</nav>`;
}

export function landingPage(mcpUrl: string): string {
  return page(
    "Welcome",
    `<div class="card"><h1>Agent Brain</h1><p class="lead">Shared Markdown context for AI agents. Connect your agent to the MCP server at</p><code class="ref">${esc(mcpUrl)}</code><a class="btn primary" href="/login">Sign in to browse your brains</a></div>`,
  );
}

export function loginPage(opts: { next: string; error?: string; email?: string; clerk?: ClerkPage; signedOut?: boolean }): string {
  if (opts.clerk) {
    return page(
      "Sign in",
      `<div class="card"><h1>Sign in</h1><p class="lead">Browse your projects, tasks and documents. The website is read-only.</p>
${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
<p class="error" id="clerk-status" role="alert" hidden></p>
<div id="clerk-mount" class="clerk"></div>
<form method="post" action="/login" id="login">
<input type="hidden" name="next" value="${esc(opts.next)}">
<input type="hidden" name="clerk_token" value="">
<p class="muted" hidden>Signing in as <strong id="clerk-who"></strong>…</p>
</form>
<p class="muted">Accounts are by invitation. Ask the person who runs this Agent Brain to add you.</p>
${clerkScripts(opts.clerk, { mode: "login", form: "login", signOut: opts.signedOut })}</div>`,
    );
  }
  return page(
    "Sign in",
    `<div class="card"><h1>Sign in</h1><p class="lead">Browse your projects, tasks and documents. The website is read-only.</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(opts.next)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" required value="${esc(opts.email ?? "")}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
<button class="btn primary" type="submit">Sign in</button>
</form></div>`,
  );
}

export function messagePage(title: string, message: string, user?: SiteUser): string {
  return page(title, `<h1>${esc(title)}</h1><p class="lead">${esc(message)}</p><p><a href="/">Back to projects</a></p>`, user);
}

export function projectsPage(user: SiteUser, projects: ProjectOverview[]): string {
  const items = projects.length
    ? `<ul class="list">${projects
        .map(
          (p) => `<li class="item"><a href="/projects/${esc(p.token)}"><div class="name">${esc(p.name)}</div><div class="meta"><span>${plural(p.activeBrains, "active task")}</span>${
            p.closedBrains ? `<span>${p.closedBrains} closed</span>` : ""
          }<span>Last activity ${when(p.lastActivityAt)}</span></div></a></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">No projects yet. Ask an agent to create a brain and it will appear here.</p>`;
  return page("Projects", `<h1>Projects</h1><p class="lead">Signed in as ${esc(user.email)}. Everything here is read-only.</p>${items}`, user);
}

export function projectPage(user: SiteUser, project: ProjectOverview, brains: BrainListing[]): string {
  const items = brains.length
    ? `<ul class="list">${brains
        .map((b) => {
          const active = b.status === "active";
          const meta = active
            ? `<span>${plural(b.documents, "document")}</span><span>${size(b.bytes)}</span><span>Updated ${when(b.updatedAt)}</span>`
            : `<span>Closed ${b.closedAt ? when(b.closedAt) : ""}</span>`;
          const inner = `<div class="name">${esc(brainTitle(b))} <span class="pill${active ? " active" : ""}">${active ? "active" : "closed"}</span></div>${
            b.description ? `<div class="desc">${esc(b.description)}</div>` : ""
          }<div class="meta">${meta}</div>`;
          return `<li class="item"><a href="${esc(brainPath(b.reference))}">${inner}</a></li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">This project has no tasks yet.</p>`;
  return page(
    project.name,
    `${crumbs([{ href: "/", label: "Projects" }, { label: project.name }])}<h1>${esc(project.name)}</h1>
<div class="meta"><span>${plural(project.activeBrains, "active task")}</span>${project.closedBrains ? `<span>${project.closedBrains} closed</span>` : ""}<span>Created ${when(project.createdAt)}</span></div>
<h2 class="section">Tasks</h2>${items}`,
    user,
  );
}

const EVENT_LABELS: Record<string, string> = {
  "brain.created": "Created the brain",
  "brain.updated": "Updated the task details",
  "document.created": "Created",
  "document.updated": "Updated",
  "document.renamed": "Renamed",
  "document.deleted": "Deleted a document",
  "image.created": "Added image",
  "image.updated": "Updated image details",
  "image.deleted": "Deleted an image",
};

function dimensions(i: ImageSummary): string {
  return i.width && i.height ? `${i.width} × ${i.height}` : "";
}

function imageType(mimeType: string): string {
  return mimeType.replace(/^image\//, "").toUpperCase();
}

export function closedBrainPage(user: SiteUser, brain: BrainSummary & { closedAt: string | null }): string {
  return page(
    brainTitle(brain),
    `${crumbs([{ href: "/", label: "Projects" }, { href: `/projects/${brain.project.token}`, label: brain.project.name }, { label: brainTitle(brain) }])}
<h1>${esc(brainTitle(brain))} <span class="pill">closed</span></h1>
<code class="ref">${esc(brain.reference)}</code>
<p class="notice">This task was closed${brain.closedAt ? ` on ${when(brain.closedAt)}` : ""}. Closing deletes a brain's documents, so there is nothing left to show.</p>`,
    user,
  );
}

export function brainPage(user: SiteUser, brain: BrainIndex, activity: ActivityItem[]): string {
  const base = brainPath(brain.reference);
  const docs = brain.documents.length
    ? `<ul class="list">${brain.documents
        .map(
          (d: DocumentSummary) =>
            `<li class="item"><a href="${esc(`${base}/documents/${d.id}`)}"><div class="name">${esc(d.title)}</div>${
              d.description ? `<div class="desc">${esc(d.description)}</div>` : ""
            }<div class="meta"><span>Revision ${d.revision}</span><span>${size(d.bytes)}</span><span>Updated ${when(d.updatedAt)}</span></div></a></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">No documents yet.</p>`;
  const images = brain.images.length
    ? `<ul class="gallery">${brain.images
        .map((i) => {
          const href = `${base}/images/${i.id}`;
          return `<li class="item"><a href="${esc(href)}"><img class="thumb" src="${esc(`${href}/raw`)}" alt="${esc(i.description || i.title)}" loading="lazy"><div class="cap"><div class="name">${esc(i.title)}</div>${
            i.description ? `<div class="desc">${esc(i.description)}</div>` : ""
          }<div class="meta"><span>${esc(imageType(i.mimeType))}</span>${dimensions(i) ? `<span>${dimensions(i)}</span>` : ""}<span>${size(i.bytes)}</span></div></div></a></li>`;
        })
        .join("")}</ul>`
    : "";
  const events = activity.length
    ? `<ul class="activity">${activity
        .map((e) => {
          const label = EVENT_LABELS[e.type] ?? e.type;
          const doc =
            e.documentId && e.documentTitle
              ? ` <a href="${esc(`${base}/documents/${e.documentId}`)}">${esc(e.documentTitle)}</a>${e.revision ? ` (revision ${e.revision})` : ""}`
              : e.imageId && e.imageTitle
                ? ` <a href="${esc(`${base}/images/${e.imageId}`)}">${esc(e.imageTitle)}</a>`
                : "";
          return `<li><span>${esc(label)}${doc}</span><span class="who">${esc(e.clientName ?? "Unnamed client")}</span>${when(e.at)}</li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">No activity yet.</p>`;
  return page(
    brainTitle(brain),
    `${crumbs([{ href: "/", label: "Projects" }, { href: `/projects/${brain.project.token}`, label: brain.project.name }, { label: brainTitle(brain) }])}
<h1>${esc(brainTitle(brain))} <span class="pill active">active</span></h1>
${brain.description ? `<p class="lead">${esc(brain.description)}</p>` : ""}
<code class="ref" title="Paste this reference into another agent's conversation">${esc(brain.reference)}</code>
<div class="meta"><span>${plural(brain.usage.documents, "document")} of ${brain.usage.limits.brainDocuments}</span><span>${size(brain.usage.bytes)} of ${size(brain.usage.limits.brainBytes)}</span>${
      brain.usage.images ? `<span>${plural(brain.usage.images, "image")} (${size(brain.usage.imageBytes)})</span>` : ""
    }<span>Created ${when(brain.createdAt)}</span><span>Updated ${when(brain.updatedAt)}</span></div>
<h2 class="section">Documents</h2>${docs}
${images ? `<h2 class="section">Images</h2>${images}` : ""}
<h2 class="section">Recent activity</h2>${events}`,
    user,
  );
}

export interface DocumentView {
  brain: BrainSummary;
  id: string;
  title: string;
  description: string;
  html: string;
  markdown: string;
  revision: number;
  latestRevision: number;
  bytes: number;
  updatedAt: string;
  updatedBy: string | null;
  history: { revision: number; kind: string; summary: string | null; clientName: string | null; at: string }[];
}

export function documentPage(user: SiteUser, d: DocumentView): string {
  const base = `${brainPath(d.brain.reference)}/documents/${d.id}`;
  const old = d.revision !== d.latestRevision;
  const history = d.history.length
    ? `<ul class="history">${d.history
        .map((h) => {
          const label = `Revision ${h.revision}`;
          const link = h.revision === d.revision ? `<span class="cur">${label}</span>` : `<a href="${esc(h.revision === d.latestRevision ? base : `${base}?revision=${h.revision}`)}">${label}</a>`;
          return `<li>${link} · ${esc(h.kind)} by ${esc(h.clientName ?? "Unnamed client")} · ${when(h.at)}${h.summary ? `<span class="sum">${esc(h.summary)}</span>` : ""}</li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">No earlier revisions are kept.</p>`;
  return page(
    d.title,
    `${crumbs([
      { href: "/", label: "Projects" },
      { href: `/projects/${d.brain.project.token}`, label: d.brain.project.name },
      { href: brainPath(d.brain.reference), label: brainTitle(d.brain) },
      { label: d.title },
    ])}
<h1>${esc(d.title)}</h1>
${d.description ? `<p class="lead">${esc(d.description)}</p>` : ""}
<div class="meta"><span>Revision ${d.revision}${old ? ` of ${d.latestRevision}` : ""}</span><span>${size(d.bytes)}</span>${
      old ? "" : `<span>Updated ${when(d.updatedAt)}${d.updatedBy ? ` by ${esc(d.updatedBy)}` : ""}</span>`
    }</div>
${old ? `<p class="notice">You are viewing an older revision. <a href="${esc(base)}">See the latest (revision ${d.latestRevision})</a>.</p>` : ""}
<article class="md">${d.html || `<p class="lead">This document is empty.</p>`}</article>
<details class="source"><summary>Markdown source</summary><pre>${esc(d.markdown)}</pre></details>
<h2 class="section">History</h2>${history}`,
    user,
  );
}

export function imagePage(user: SiteUser, brain: BrainSummary, i: ImageSummary): string {
  const raw = `${brainPath(brain.reference)}/images/${i.id}/raw`;
  return page(
    i.title,
    `${crumbs([
      { href: "/", label: "Projects" },
      { href: `/projects/${brain.project.token}`, label: brain.project.name },
      { href: brainPath(brain.reference), label: brainTitle(brain) },
      { label: i.title },
    ])}
<h1>${esc(i.title)}</h1>
${i.description ? `<p class="lead">${esc(i.description)}</p>` : ""}
<div class="meta"><span>${esc(imageType(i.mimeType))}</span>${dimensions(i) ? `<span>${dimensions(i)}</span>` : ""}<span>${size(i.bytes)}</span><span>Revision ${i.revision}</span><span>Updated ${when(i.updatedAt)}</span></div>
<figure class="figure"><a href="${esc(raw)}"><img src="${esc(raw)}" alt="${esc(i.description || i.title)}"></a></figure>
<p class="lead">Reference it from a document as <code>![${esc(i.title)}](image:${esc(i.id)})</code></p>
<p class="lead">Public link, for GitHub and other tools (anyone with it can view the image):</p>
<code class="ref">${esc(i.url)}</code>`,
    user,
  );
}
