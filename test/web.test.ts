import { describe, expect, it } from "vitest";
import { renderMarkdown, safeHref } from "../src/core/markdown.js";
import { hashPassword } from "../src/core/crypto.js";
import { BASE, OWNER, testInstance } from "./helpers.js";

type T = ReturnType<typeof testInstance>;

const HTML = { accept: "text/html" };

async function ready(t: T) {
  // The owner account is created on the first request.
  await t.fetch(`${BASE}/healthz`);
  return t.store.findUserByEmail(OWNER.email)!.id;
}

async function login(t: T, opts: { email?: string; password?: string; next?: string; origin?: string; ip?: string } = {}) {
  return t.fetch(`${BASE}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: opts.origin ?? BASE,
      ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}),
    },
    body: new URLSearchParams({ email: opts.email ?? OWNER.email, password: opts.password ?? OWNER.password, next: opts.next ?? "/" }).toString(),
    redirect: "manual",
  });
}

async function session(t: T): Promise<string> {
  const res = await login(t);
  expect(res.status).toBe(303);
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toMatch(/^__Host-agentbrain_session=/);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
  return cookie.split(";")[0]!;
}

async function seed(t: T) {
  const userId = await ready(t);
  const actor = { userId, clientId: "c1", clientName: "Claude Code" };
  const brain = t.store.createBrain(actor, { project: "AFX Markets", title: "Fix the export", description: "Why exports fail" });
  const markdown = [
    "# Overview",
    "",
    "| Name | Value |",
    "| --- | ---: |",
    "| a | 1 |",
    "",
    "```ts",
    "const x: number = 42;",
    "```",
    "",
    "- [x] done",
    "- [ ] todo",
    "",
    "<script>alert(1)</script>",
    "",
    "[bad](javascript:alert(1)) [good](https://example.com)",
  ].join("\n");
  const created = t.store.createDocument(actor, brain.reference, { title: "Overview", description: "Start here", markdown, summary: "first" });
  t.store.replaceDocument(actor, brain.reference, { id: created.document.id, baseRevision: 1, markdown: "Second **version**", summary: "rewrite" });
  return { userId, actor, brain, docId: created.document.id };
}

const pathOf = (reference: string) => {
  const [p, b] = reference.slice("agentBrain:".length).split(".");
  return `/brains/${p}/${b}`;
};

describe("website", () => {
  it("keeps the plain-text root for agents and shows a landing page to browsers", async () => {
    const t = testInstance();
    expect(await (await t.fetch(`${BASE}/`)).text()).toContain("This is an MCP server");
    const page = await t.fetch(`${BASE}/`, { headers: HTML });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain('href="/login"');
  });

  it("sends signed-out visitors to the sign-in page and back afterwards", async () => {
    const t = testInstance();
    const { brain } = await seed(t);
    const res = await t.fetch(`${BASE}${pathOf(brain.reference)}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(pathOf(brain.reference))}`);
    const signedIn = await login(t, { next: pathOf(brain.reference) });
    expect(signedIn.headers.get("location")).toBe(pathOf(brain.reference));
  });

  it("never redirects off-site after sign-in", async () => {
    const t = testInstance();
    await ready(t);
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      expect((await login(t, { next })).headers.get("location")).toBe("/");
    }
  });

  it("rejects wrong passwords, cross-site posts and repeated guessing", async () => {
    const t = testInstance();
    await ready(t);
    expect((await login(t, { password: "wrong password!" })).status).toBe(401);
    expect((await login(t, { email: "nobody@example.com" })).status).toBe(401);
    expect((await login(t, { origin: "https://evil.example" })).status).toBe(403);
    for (let i = 0; i < 10; i++) await login(t, { password: "nope nope nope", ip: "203.0.113.9" });
    expect((await login(t, { ip: "203.0.113.9" })).status).toBe(429);
    // Another address is unaffected.
    expect((await login(t, { ip: "203.0.113.10" })).status).toBe(303);
  });

  it("lists projects, tasks and documents for the signed-in owner", async () => {
    const t = testInstance();
    const { brain, docId } = await seed(t);
    const cookie = await session(t);
    const get = async (path: string) => {
      const res = await t.fetch(`${BASE}${path}`, { headers: { cookie, ...HTML } });
      expect(res.status).toBe(200);
      return res.text();
    };
    const home = await get("/");
    expect(home).toContain("AFX Markets");
    expect(home).toContain(`/projects/${brain.project.token}`);
    const project = await get(`/projects/${brain.project.token}`);
    expect(project).toContain("Fix the export");
    expect(project).toContain(pathOf(brain.reference));
    const brainHtml = await get(pathOf(brain.reference));
    expect(brainHtml).toContain(brain.reference);
    expect(brainHtml).toContain(`${pathOf(brain.reference)}/documents/${docId}`);
    expect(brainHtml).toContain("Claude Code");
    const doc = await get(`${pathOf(brain.reference)}/documents/${docId}`);
    expect(doc).toContain("<strong>version</strong>");
    expect(doc).toContain("Revision 2");
    expect(doc).toContain("rewrite");
  });

  it("renders an older revision with sanitised Markdown", async () => {
    const t = testInstance();
    const { brain, docId } = await seed(t);
    const cookie = await session(t);
    const res = await t.fetch(`${BASE}${pathOf(brain.reference)}/documents/${docId}?revision=1`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain("You are viewing an older revision");
    expect(html).toContain("<table>");
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
  });

  it("shows closed brains without content and hides other users' data", async () => {
    const t = testInstance();
    const { actor, brain, docId } = await seed(t);
    const cookie = await session(t);
    const otherId = t.store.upsertUser("other@example.com", await hashPassword("another long password"));
    const other = t.store.createBrain({ userId: otherId, clientId: "c2" }, { project: "Secret" });
    for (const path of [`/projects/${other.project.token}`, pathOf(other.reference), "/projects/nope", "/brains/a/b"]) {
      expect((await t.fetch(`${BASE}${path}`, { headers: { cookie } })).status).toBe(404);
    }
    expect(await (await t.fetch(`${BASE}/`, { headers: { cookie } })).text()).not.toContain("Secret");
    t.store.closeBrain(actor, brain.reference, false);
    const closed = await (await t.fetch(`${BASE}${pathOf(brain.reference)}/documents/${docId}`, { headers: { cookie } })).text();
    expect(closed).toContain("This task was closed");
    expect(closed).not.toContain("Second");
  });

  it("signs out and invalidates the session", async () => {
    const t = testInstance();
    await ready(t);
    const cookie = await session(t);
    const blocked = await t.fetch(`${BASE}/logout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
    expect(blocked.status).toBe(403);
    const out = await t.fetch(`${BASE}/logout`, { method: "POST", headers: { cookie, origin: BASE }, redirect: "manual" });
    expect(out.status).toBe(303);
    const after = await t.fetch(`${BASE}/projects/x`, { headers: { cookie }, redirect: "manual" });
    expect(after.status).toBe(303);
  });

  it("expires sessions after a week", async () => {
    let now = Date.now();
    const t = testInstance({}, { now: () => now });
    await ready(t);
    const cookie = await session(t);
    expect((await t.fetch(`${BASE}/`, { headers: { cookie, ...HTML } })).headers.get("content-type")).toContain("html");
    now += 8 * 24 * 60 * 60 * 1000;
    expect(await (await t.fetch(`${BASE}/`, { headers: { cookie, ...HTML } })).text()).toContain('href="/login"');
  });
});

describe("markdown", () => {
  it("escapes raw HTML and unsafe URLs", () => {
    const out = renderMarkdown(
      [
        '<img src=x onerror="alert(1)">',
        "",
        "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](java\tscript:alert(1)) [d](data:text/html,x) [e](//evil.example)",
        "",
        "![img](http://insecure.example/x.png) ![ok](https://example.com/x.png)",
        "",
        "<https://example.com/auto>",
        "",
        '[q](https://example.com "a\\" onmouseover=\\"x")',
      ].join("\n"),
    );
    expect(out).not.toMatch(/<img src=x/);
    expect(out).not.toMatch(/href="(javascript|data|\/\/)/i);
    expect(out).not.toContain("http://insecure.example");
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('href="https://example.com/auto"');
    expect(out).not.toMatch(/" onmouseover=/);
  });

  it("allows relative links, fragments and mailto", () => {
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("/projects")).toBe("/projects");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("vbscript:x")).toBeNull();
  });

  it("gives headings unique anchors and labels code blocks", () => {
    const out = renderMarkdown("## Notes\n\n## Notes\n\n```python\nprint('hi')\n```\n\n```\nplain <b>\n```");
    expect(out).toContain('id="h-notes"');
    expect(out).toContain('id="h-notes-1"');
    expect(out).toContain('<span class="code-lang">python</span>');
    expect(out).toContain("plain &lt;b&gt;");
  });
});
