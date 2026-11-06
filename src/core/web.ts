import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { verifyPassword } from "./crypto.js";
import { BrainError } from "./errors.js";
import { renderMarkdown } from "./markdown.js";
import { SERVER_VERSION } from "./mcp.js";
import {
  brainPage,
  closedBrainPage,
  documentPage,
  landingPage,
  loginPage,
  messagePage,
  projectPage,
  projectsPage,
  SITE_HEADERS,
  type SiteUser,
} from "./site.js";
import type { BrainStore } from "./store.js";
import { WEB_SESSION_TTL_MS, type WebSessionService } from "./websession.js";

/**
 * The read-only website: the owner signs in with the same email and password
 * as the OAuth consent screen and can browse every project, brain and document.
 * Nothing here changes a brain. The only POSTs are sign-in and sign-out.
 */
export function registerWebsite(app: Hono, opts: { base: string; store: BrainStore; sessions: WebSessionService }): void {
  const { base, store, sessions } = opts;
  const secure = base.startsWith("https://");
  // __Host- cookies must be Secure, host-only and Path=/, which also stops subdomains from setting them.
  const cookieName = secure ? "__Host-agentbrain_session" : "agentbrain_session";
  const origin = new URL(base).origin;

  const html = (body: string, status = 200) => new Response(body, { status, headers: SITE_HEADERS });
  const redirect = (location: string, headers: Record<string, string> = {}) =>
    new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });

  const currentUser = async (c: Context) => sessions.verify(getCookie(c, cookieName));

  /** Only same-site paths may be used after sign-in, so the form cannot redirect elsewhere. */
  const safeNext = (next: unknown): string => {
    const s = typeof next === "string" ? next : "";
    return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") && !s.startsWith("/login") ? s : "/";
  };

  /** Reject cross-site form posts. Browsers send Origin on POST; Sec-Fetch-Site covers the rest. */
  const sameOrigin = (c: Context): boolean => {
    const o = c.req.header("origin");
    if (o && o !== "null") return o === origin;
    if (o === "null") return false;
    const site = c.req.header("sec-fetch-site");
    return !site || site === "same-origin" || site === "none";
  };

  const clientKey = (c: Context) => c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "direct";

  type Handler = (c: Context, user: SiteUser & { userId: string }) => Response | Promise<Response>;
  const signedIn = (handler: Handler) => async (c: Context) => {
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    try {
      return await handler(c, user);
    } catch (e) {
      if (e instanceof BrainError && (e.code === "not_found" || e.code === "invalid_request")) {
        return html(messagePage("Not found", "There is nothing at this address, or it is not available to you.", user), 404);
      }
      throw e;
    }
  };

  // ---------------------------------------------------------------- home and sign-in

  app.get("/", async (c) => {
    const user = await currentUser(c);
    if (user) return html(projectsPage(user, store.projectsOverview(user.userId)));
    // Agents and scripts that fetch the root still get the short plain-text answer.
    if (!(c.req.header("accept") ?? "").includes("text/html")) {
      return c.text(`Agent Brain ${SERVER_VERSION}\n\nThis is an MCP server. Connect your agent to ${base}/mcp\n`);
    }
    return html(landingPage(`${base}/mcp`));
  });

  app.get("/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    if (await currentUser(c)) return redirect(next);
    return html(loginPage({ next }));
  });

  app.post("/login", async (c) => {
    if (!sameOrigin(c)) return html(messagePage("Sign-in blocked", "That sign-in came from another site."), 403);
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    const email = String(form.email ?? "").slice(0, 320);
    const password = String(form.password ?? "").slice(0, 1024);
    const key = clientKey(c);
    if (!sessions.canAttempt(key)) {
      return html(loginPage({ next, email, error: "Too many failed attempts. Wait 15 minutes and try again." }), 429);
    }
    const user = store.findUserByEmail(email);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const valid = await verifyPassword(password, user?.password_hash ?? "pbkdf2-sha256$100000$00$00");
    if (!user || !valid) {
      sessions.recordFailure(key);
      return html(loginPage({ next, email, error: "That email and password do not match." }), 401);
    }
    sessions.clearFailures(key);
    const session = await sessions.create(user.id);
    setCookie(c, cookieName, session.token, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Lax",
      maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000),
    });
    c.header("cache-control", "no-store");
    return c.redirect(next, 303);
  });

  app.post("/logout", async (c) => {
    if (!sameOrigin(c)) return html(messagePage("Sign-out blocked", "That request came from another site."), 403);
    await sessions.destroy(getCookie(c, cookieName));
    deleteCookie(c, cookieName, { path: "/", secure });
    c.header("cache-control", "no-store");
    return c.redirect("/login", 303);
  });

  // ---------------------------------------------------------------- browsing

  app.get(
    "/projects/:token",
    signedIn((c, user) => {
      const { project, brains } = store.projectWithBrains(user.userId, c.req.param("token")!);
      return html(projectPage(user, project, brains));
    }),
  );

  const referenceOf = (c: Context) => `agentBrain:${c.req.param("project")}.${c.req.param("brain")}`;

  app.get(
    "/brains/:project/:brain",
    signedIn((c, user) => {
      const reference = referenceOf(c);
      const summary = store.describeBrain(user.userId, reference);
      if (summary.status !== "active") return html(closedBrainPage(user, summary));
      return html(brainPage(user, store.getIndex(user.userId, reference), store.recentActivity(user.userId, reference)));
    }),
  );

  app.get(
    "/brains/:project/:brain/documents/:doc",
    signedIn((c, user) => {
      const reference = referenceOf(c);
      const summary = store.describeBrain(user.userId, reference);
      if (summary.status !== "active") return html(closedBrainPage(user, summary));
      const id = c.req.param("doc")!;
      const current = store.readDocuments(user.userId, reference, [id]).documents[0];
      if (!current) return html(messagePage("Not found", "That document does not exist or was deleted.", user), 404);
      const history = store.documentHistory(user.userId, reference, id).revisions;
      const wanted = Number(c.req.query("revision") ?? current.revision);
      let shown = { title: current.title, markdown: current.markdown, revision: current.revision };
      if (Number.isInteger(wanted) && wanted !== current.revision) {
        shown = store.readRevision(user.userId, reference, id, wanted);
      }
      const isLatest = shown.revision === current.revision;
      return html(
        documentPage(user, {
          brain: summary,
          id,
          title: shown.title,
          description: isLatest ? current.description : "",
          html: renderMarkdown(shown.markdown),
          markdown: shown.markdown,
          revision: shown.revision,
          latestRevision: current.revision,
          bytes: new TextEncoder().encode(shown.markdown).length,
          updatedAt: current.updatedAt,
          updatedBy: current.updatedBy.clientName,
          history: history.map((h) => ({ revision: h.revision, kind: h.kind, summary: h.summary, clientName: h.clientName, at: h.at })),
        }),
      );
    }),
  );
}
