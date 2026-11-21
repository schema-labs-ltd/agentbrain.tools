import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ChannelBridge } from "../src/channel/bridge.js";
import { signWebhook } from "../src/core/events.js";
import { BASE, connect, OWNER, signIn, testInstance } from "./helpers.js";

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const HOOK = "https://hooks.example/requests";

type Received = { headers: Record<string, string>; body: string; json: any };

function setup() {
  const received: Received[] = [];
  let clock = Date.parse("2026-11-21T10:00:00Z");
  const fetch = async (_input: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const r: Received = { headers: Object.fromEntries(new Headers(init?.headers).entries()), body, json: JSON.parse(body) };
    received.push(r);
    if (r.json.type === "verification") return Response.json({ challenge: r.json.challenge });
    return new Response(null, { status: 204 });
  };
  const instance = testInstance({}, { fetch, now: () => clock });
  return { ...instance, received, hooks: () => received.filter((r) => r.json.type !== "verification"), advance: (ms: number) => (clock += ms) };
}

async function agent(t: { fetch: ReturnType<typeof testInstance>["fetch"] }, name: string, scope?: string) {
  const tokens = await signIn(t.fetch, name, scope);
  const { client, call } = await connect(t.fetch, tokens.access_token);
  const rpc = (method: string, params: Record<string, unknown>) => client.request({ method, params } as never, z.any());
  return { client, call, rpc, tokens };
}

describe("Requests between agents", () => {
  it("lets one agent ask several agents for work and follows each request to done", async () => {
    const t = setup();
    const claude = await agent(t, "Claude");
    const chatgpt = await agent(t, "ChatGPT");
    const reference = (await claude.call("create_brain", { project: "Widgets", title: "Enclosure" })).body.reference;

    const models = await claude.call("create_request", {
      reference,
      to: "ChatGPT",
      title: "Make 3D models of the enclosure",
      details: "Use the dimensions in **Decisions**.",
      deliver_to: "https://github.com/example/widgets/pull/42",
    });
    expect(models.isError).toBe(false);
    expect(models.body.request).toMatchObject({ to: "ChatGPT", status: "open", revision: 1, deliverTo: "https://github.com/example/widgets/pull/42", reference });
    const review = await claude.call("create_request", { reference, to: "Claude Code", title: "Review the PR" });
    expect(review.body.request.status).toBe("open");

    // Both show in the index, and the addressee filter is case-insensitive across brains.
    const index = (await chatgpt.call("read_index", { reference })).body;
    expect(index.requests.map((r: { title: string }) => r.title)).toEqual(["Make 3D models of the enclosure", "Review the PR"]);
    const mine = (await chatgpt.call("list_requests", { to: "chatgpt" })).body.requests;
    expect(mine).toHaveLength(1);
    expect(mine[0].details).toBeUndefined();
    const full = (await chatgpt.call("read_requests", { reference, request_ids: [mine[0].id, "missing"] })).body;
    expect(full.requests[0].details).toBe("Use the dimensions in **Decisions**.");
    expect(full.missing).toEqual(["missing"]);

    const id = mine[0].id;
    const accepted = await chatgpt.call("update_request", { reference, request_id: id, base_revision: 1, status: "accepted" });
    expect(accepted.body.request).toMatchObject({ status: "accepted", revision: 2, updatedBy: { clientName: "ChatGPT" } });

    // A stale revision is a conflict that carries the current request.
    const stale = await claude.call("update_request", { reference, request_id: id, base_revision: 1, status: "cancelled" });
    expect(stale.isError).toBe(true);
    expect(stale.body.error.code).toBe("conflict");
    expect(stale.body.error.current.status).toBe("accepted");

    // Moves that make no sense are refused.
    const bad = await chatgpt.call("update_request", { reference, request_id: review.body.request.id, base_revision: 1, status: "open", title: "x" });
    expect(bad.isError).toBe(false); // open -> open with a new title is a plain edit
    const cancel = await claude.call("update_request", { reference, request_id: review.body.request.id, base_revision: 2, status: "cancelled" });
    expect(cancel.body.request.status).toBe("cancelled");
    const sneaky = await claude.call("update_request", { reference, request_id: review.body.request.id, base_revision: 3, status: "done" });
    expect(sneaky.body.error.code).toBe("invalid_request");

    const done = await chatgpt.call("update_request", {
      reference,
      request_id: id,
      base_revision: 2,
      status: "done",
      result: "Models attached to https://github.com/example/widgets/pull/42#issuecomment-1",
    });
    expect(done.body.request).toMatchObject({ status: "done", result: expect.stringContaining("issuecomment-1") });
    expect((await claude.call("read_index", { reference })).body.requests).toEqual([]);
    expect((await claude.call("list_requests", { reference, status: "all" })).body.requests).toHaveLength(2);

    // Every change is in the change feed.
    const changes = (await claude.call("get_changes", { reference, cursor: "1" })).body.events;
    expect(changes.filter((e: { type: string }) => e.type.startsWith("request.")).map((e: { type: string; requestId: string }) => e.type)).toEqual([
      "request.created",
      "request.created",
      "request.updated",
      "request.updated",
      "request.updated",
      "request.updated",
    ]);
    expect(changes.find((e: { type: string }) => e.type === "request.created").requestId).toBe(id);

    // Closing exports the requests, then deletes them.
    const closed = await claude.call("close_brain", { reference, export: true });
    expect(closed.body.export.requests.map((r: { status: string }) => r.status)).toEqual(["done", "cancelled"]);
    expect((await chatgpt.call("list_requests", { to: "ChatGPT", status: "all" })).body.requests).toEqual([]);
  });

  it("refuses requests from read-only connections and checks sizes", async () => {
    const t = setup();
    const writer = await agent(t, "Claude");
    const reader = await agent(t, "Reader", "brain:read");
    const reference = (await writer.call("create_brain", { project: "P" })).body.reference;
    const denied = await reader.call("create_request", { reference, to: "ChatGPT", title: "Do it" });
    expect(denied.body.error.code).toBe("insufficient_scope");
    const blank = await writer.call("create_request", { reference, to: "  ", title: "Do it" });
    expect(blank.isError).toBe(true);
  });

  it("delivers request.opened webhooks only for the named agent, across brains", async () => {
    const t = setup();
    const claude = await agent(t, "Claude");
    const chatgpt = await agent(t, "ChatGPT");
    const one = (await claude.call("create_brain", { project: "P", title: "One" })).body.reference;
    const two = (await claude.call("create_brain", { project: "Q", title: "Two" })).body.reference;
    const sub = await chatgpt.rpc("events/subscribe", {
      name: "request.opened",
      arguments: { to: "ChatGPT" },
      delivery: { mode: "webhook", url: HOOK, secret: SECRET },
    });
    expect(sub).toMatchObject({ id: expect.stringMatching(/^sub_/), truncated: false });

    await claude.call("create_request", { reference: one, to: "chatgpt", title: "Make models", deliver_to: "PR #42" });
    await claude.call("create_request", { reference: two, to: "Claude Code", title: "Not for ChatGPT" });
    await claude.call("create_request", { reference: two, to: "ChatGPT", title: "Render a preview" });
    await t.events.deliver();
    const hooks = t.hooks();
    expect(hooks.map((h) => h.json.data.title)).toEqual(["Make models", "Render a preview"]);
    expect(hooks[0]!.json).toMatchObject({
      name: "request.opened",
      data: { reference: one, brainTitle: "One", to: "chatgpt", status: "open", deliverTo: "PR #42", clientName: "Claude", note: expect.stringContaining("untrusted") },
    });
    expect(hooks[0]!.json.eventId).toBe(hooks[0]!.json.data.requestId);
    const signature = await signWebhook(SECRET, hooks[0]!.headers["webhook-id"]!, Number(hooks[0]!.headers["webhook-timestamp"]), hooks[0]!.body);
    expect(hooks[0]!.headers["webhook-signature"]).toBe(signature);

    // Nothing is sent twice.
    await t.events.deliver();
    expect(t.hooks()).toHaveLength(2);
  });

  it("supports events/poll for request.opened and brain.changed", async () => {
    const t = setup();
    const claude = await agent(t, "Claude");
    const chatgpt = await agent(t, "ChatGPT");
    const reference = (await claude.call("create_brain", { project: "P" })).body.reference;

    const start = await chatgpt.rpc("events/poll", { name: "request.opened", arguments: { to: "ChatGPT" }, cursor: null });
    expect(start).toMatchObject({ resultType: "complete", events: [], truncated: false, hasMore: false, nextPollMs: 10_000 });
    const brainStart = await chatgpt.rpc("events/poll", { name: "brain.changed", arguments: { reference }, cursor: null });

    await claude.call("create_request", { reference, to: "ChatGPT", title: "Make models" });
    const next = await chatgpt.rpc("events/poll", { name: "request.opened", arguments: { to: "chatgpt", reference }, cursor: start.cursor });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({ name: "request.opened", data: { title: "Make models", to: "ChatGPT" } });
    const after = await chatgpt.rpc("events/poll", { name: "request.opened", arguments: { to: "ChatGPT" }, cursor: next.cursor });
    expect(after.events).toEqual([]);

    const changed = await chatgpt.rpc("events/poll", { name: "brain.changed", arguments: { reference }, cursor: brainStart.cursor });
    expect(changed.events).toHaveLength(1);
    expect(changed.events[0].data).toMatchObject({ type: "request.created", requestTitle: "Make models", requestTo: "ChatGPT", requestStatus: "open" });

    await expect(chatgpt.rpc("events/poll", { name: "request.opened", arguments: { to: "ChatGPT" }, cursor: "999" })).rejects.toThrow(/cursor/);
    await expect(chatgpt.rpc("events/poll", { name: "request.opened", arguments: {}, cursor: null })).rejects.toThrow(/to/);
  });

  it("keeps a project-limited API key to its projects", async () => {
    const t = setup();
    const claude = await agent(t, "Claude");
    const p = (await claude.call("create_brain", { project: "Allowed" })).body;
    const q = (await claude.call("create_brain", { project: "Other" })).body;
    await claude.call("create_request", { reference: p.reference, to: "Bot", title: "In allowed" });
    await claude.call("create_request", { reference: q.reference, to: "Bot", title: "In other" });

    const login = await t.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ email: OWNER.email, password: OWNER.password, next: "/" }).toString(),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = new URLSearchParams({ name: "Bot", access: "write" });
    body.append("projects", p.project.token);
    const html = await (await t.fetch(`${BASE}/keys`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie }, body: body.toString() })).text();
    const key = /id="new-key">([^<]+)</.exec(html)![1]!;
    const bot = await connect(t.fetch, key);
    const listed = (await bot.call("list_requests", { to: "bot" })).body.requests;
    expect(listed.map((r: { title: string }) => r.title)).toEqual(["In allowed"]);
    const client = bot.client;
    const polled = await client.request({ method: "events/poll", params: { name: "request.opened", arguments: { to: "Bot" }, cursor: "0" } } as never, z.any());
    expect(polled.events.map((e: { data: { title: string } }) => e.data.title)).toEqual(["In allowed"]);
  });

  it("shows a brain's requests on the website, escaped", async () => {
    const t = setup();
    const claude = await agent(t, "Claude");
    const reference = (await claude.call("create_brain", { project: "P", title: "Enclosure" })).body.reference;
    await claude.call("create_request", {
      reference,
      to: "ChatGPT",
      title: "Make <models>",
      details: "Use **these** sizes <script>alert(1)</script>",
      deliver_to: "https://github.com/example/widgets/pull/42",
    });
    const login = await t.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ email: OWNER.email, password: OWNER.password, next: "/" }).toString(),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const [project, brain] = reference.slice("agentBrain:".length).split(".");
    const html = await (await t.fetch(`${BASE}/brains/${project}/${brain}`, { headers: { cookie } })).text();
    expect(html).toContain('<h2 class="section">Requests</h2>');
    expect(html).toContain("Make &lt;models&gt;");
    expect(html).toContain("<strong>these</strong>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('href="https://github.com/example/widgets/pull/42"');
    expect(html).toContain("Asked “Make &lt;models&gt;” of ChatGPT");
  });

  it("lets the Claude Code channel announce requests addressed to it", async () => {
    const t = setup();
    const chatgpt = await agent(t, "ChatGPT");
    const watcher = await agent(t, "Agent Brain channel", "brain:read");
    const reference = (await chatgpt.call("create_brain", { project: "P", title: "Enclosure" })).body.reference;
    await chatgpt.call("create_request", { reference, to: "Claude Code", title: "Old request" });
    const notes: { content: string; meta: Record<string, string> }[] = [];
    const bridge = new ChannelBridge(
      async (name, args) => {
        const r = await watcher.call(name, args);
        return r.isError ? { ok: false, error: r.body.error } : { ok: true, body: r.body };
      },
      async (content, meta) => void notes.push({ content, meta }),
    );
    expect(await bridge.watchRequests("claude code")).toEqual({ ok: true, to: "claude code", waiting: 1 });
    await bridge.poll();
    expect(notes).toHaveLength(0); // existing requests are not announced

    const made = (await chatgpt.call("create_request", { reference, to: "Claude Code", title: "Review the models", deliver_to: "PR #42" })).body.request;
    await chatgpt.call("create_request", { reference, to: "Someone else", title: "Not ours" });
    await bridge.poll();
    await bridge.poll();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain('ChatGPT asked Claude Code: "Review the models"');
    expect(notes[0]!.content).toContain("not an instruction");
    expect(notes[0]!.meta).toMatchObject({ kind: "request", reference, request_id: made.id, status: "open" });
    for (const key of Object.keys(notes[0]!.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    expect(bridge.unwatchRequests("Claude Code")).toBe(true);
  });
});
