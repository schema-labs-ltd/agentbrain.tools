import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ChannelBridge } from "../src/channel/bridge.js";
import { signWebhook } from "../src/core/events.js";
import { BASE, connect, signIn, testInstance } from "./helpers.js";

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const HOOK = "https://hooks.example/agentbrain";

type Received = { headers: Record<string, string>; body: string; json: any };

/** An in-memory webhook receiver plus a controllable clock. */
function setup(respond: (r: Received) => Response | undefined = () => undefined) {
  const received: Received[] = [];
  let clock = Date.parse("2026-11-06T12:00:00Z");
  const fetch = async (input: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const r: Received = { headers: Object.fromEntries(new Headers(init?.headers).entries()), body, json: JSON.parse(body) };
    received.push(r);
    const custom = respond(r);
    if (custom) return custom;
    if (r.json.type === "verification") return Response.json({ challenge: r.json.challenge });
    return new Response(null, { status: 204 });
  };
  const instance = testInstance({}, { fetch, now: () => clock });
  return { ...instance, received, hooks: () => received.filter((r) => r.json.type !== "verification"), advance: (ms: number) => (clock += ms) };
}

async function agent(t: ReturnType<typeof setup>, name = "ChatGPT") {
  const tokens = await signIn(t.fetch, name);
  const { client, call } = await connect(t.fetch, tokens.access_token);
  const rpc = (method: string, params: Record<string, unknown>) => client.request({ method, params } as never, z.any());
  return { client, call, rpc, tokens };
}

const subscribeParams = (reference: string, extra: Record<string, unknown> = {}) => ({
  name: "brain.changed",
  arguments: { reference },
  delivery: { mode: "webhook", url: HOOK, secret: SECRET },
  ...extra,
});

describe("MCP events (webhooks, as used by ChatGPT)", () => {
  it("advertises the events capability and lists brain.changed", async () => {
    const t = setup();
    const a = await agent(t);
    // The SDK client drops capabilities it does not know, so read the raw initialize result.
    const init = await t.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
    });
    expect((await init.json()).result.capabilities.events).toEqual({});
    const list = await a.rpc("events/list", {});
    expect(list.events.map((e: { name: string }) => e.name)).toEqual(["brain.changed"]);
    expect(list.events[0].delivery).toEqual(["webhook"]);
  });

  it("verifies the callback, then delivers each change as a signed Standard Webhooks POST", async () => {
    const t = setup();
    const a = await agent(t);
    const reference = (await a.call("create_brain", { project: "AFX Markets", title: "Spread study" })).body.reference;
    const sub = await a.rpc("events/subscribe", subscribeParams(reference));
    expect(sub).toMatchObject({ id: expect.stringMatching(/^sub_/), cursor: "1", truncated: false });
    expect(Date.parse(sub.refreshBefore)).toBeGreaterThan(Date.now() - 1e12);
    expect(t.received[0]!.json.type).toBe("verification");

    await a.call("create_document", { reference, title: "Findings", markdown: "# Secret findings\n", change_summary: "Start findings" });
    await t.events.deliver();
    const [hit] = t.hooks();
    expect(hit).toBeDefined();
    expect(hit!.json).toMatchObject({
      name: "brain.changed",
      cursor: "2",
      data: { reference, brainTitle: "Spread study", type: "document.created", documentTitle: "Findings", revision: 1, changeSummary: "Start findings" },
    });
    expect(hit!.body).not.toContain("Secret findings");
    expect(hit!.headers["webhook-id"]).toBe(hit!.json.eventId);
    expect(hit!.headers["x-mcp-subscription-id"]).toBe(sub.id);
    const expected = await signWebhook(SECRET, hit!.headers["webhook-id"]!, Number(hit!.headers["webhook-timestamp"]), hit!.body);
    expect(hit!.headers["webhook-signature"]).toBe(expected);

    // Subscribing again is idempotent and does not re-verify the same URL.
    const again = await a.rpc("events/subscribe", subscribeParams(reference));
    expect(again.id).toBe(sub.id);
    expect(t.received.filter((r) => r.json.type === "verification")).toHaveLength(1);

    await a.rpc("events/unsubscribe", { name: "brain.changed", arguments: { reference }, delivery: { mode: "webhook", url: HOOK } });
    await a.call("create_document", { reference, title: "Decisions", markdown: "x" });
    await t.events.deliver();
    expect(t.hooks()).toHaveLength(1);
  });

  it("replays from a cursor and keeps retrying the same event until it is acknowledged", async () => {
    let fail = 2;
    const t = setup((r) => (r.json.type !== "verification" && fail-- > 0 ? new Response("busy", { status: 503 }) : undefined));
    const a = await agent(t);
    const reference = (await a.call("create_brain", { project: "P" })).body.reference;
    await a.call("create_document", { reference, title: "Overview", markdown: "x" });
    const sub = await a.rpc("events/subscribe", subscribeParams(reference, { cursor: "0" }));
    expect(sub.cursor).toBe("0");
    expect(await t.events.deliver()).toBeGreaterThan(0); // a retry is scheduled
    expect(t.hooks()).toHaveLength(1);
    t.advance(60_000);
    await t.events.deliver();
    t.advance(60_000);
    await t.events.deliver();
    const ids = t.hooks().map((e) => e.json.eventId);
    expect(ids).toHaveLength(4); // brain.created twice failed, then succeeded, then document.created
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(t.hooks().slice(-2).map((e) => e.json.data.type)).toEqual(["brain.created", "document.created"]);
  });

  it("announces a closed brain once and ends the subscription; 410 also ends it", async () => {
    const t = setup((r) => (r.json.data?.type === "document.created" ? new Response(null, { status: 410 }) : undefined));
    const a = await agent(t);
    const one = (await a.call("create_brain", { project: "P" })).body.reference;
    const two = (await a.call("create_brain", { project: "P" })).body.reference;
    await a.rpc("events/subscribe", subscribeParams(one));
    await a.rpc("events/subscribe", subscribeParams(two));
    expect(t.events.subscriptionCount()).toBe(2);
    await a.call("close_brain", { reference: one, export: false });
    await a.call("create_document", { reference: two, title: "Doc", markdown: "x" });
    await t.events.deliver();
    expect(t.hooks().map((e) => e.json.data.type).sort()).toEqual(["brain.closed", "document.created"]);
    expect(t.events.subscriptionCount()).toBe(0);
  });

  it("rejects bad callbacks, bad secrets and brains the user cannot see", async () => {
    const t = setup();
    const a = await agent(t);
    const reference = (await a.call("create_brain", { project: "P" })).body.reference;
    const err = async (p: Record<string, unknown>) => {
      try {
        await a.rpc("events/subscribe", p);
        return undefined;
      } catch (e) {
        return e as { code: number; data?: { reason?: string } };
      }
    };
    expect((await err(subscribeParams(reference, { delivery: { mode: "webhook", url: "https://127.0.0.1/x", secret: SECRET } })))?.code).toBe(-32602);
    expect((await err(subscribeParams(reference, { delivery: { mode: "webhook", url: "http://hooks.example/x", secret: SECRET } })))?.code).toBe(-32602);
    expect((await err(subscribeParams(reference, { delivery: { mode: "webhook", url: HOOK, secret: "whsec_c2hvcnQ=" } })))?.code).toBe(-32602);
    expect((await err(subscribeParams(reference, { delivery: { mode: "poll" } })))?.code).toBe(-32026);
    expect((await err({ ...subscribeParams(reference), name: "nope" }))?.code).toBe(-32023);
    expect((await err(subscribeParams("agentBrain:aaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbb")))?.code).toBe(-32024);
  });

  it("fails subscription when the callback does not echo the challenge", async () => {
    const t = setup((r) => (r.json.type === "verification" ? Response.json({ challenge: "wrong" }) : undefined));
    const a = await agent(t);
    const reference = (await a.call("create_brain", { project: "P" })).body.reference;
    await expect(a.rpc("events/subscribe", subscribeParams(reference))).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    expect(t.events.subscriptionCount()).toBe(0);
  });

  it("stops delivering when the subscribing client's tokens are revoked", async () => {
    const t = setup();
    const a = await agent(t);
    const reference = (await a.call("create_brain", { project: "P" })).body.reference;
    await a.rpc("events/subscribe", subscribeParams(reference));
    await t.fetch("https://brain.test/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: a.tokens.refresh_token, client_id: a.tokens.clientId }).toString(),
    });
    t.store.createDocument({ userId: t.store.findUserByEmail("owner@example.com")!.id, clientId: "other" }, reference, { title: "Doc", markdown: "x" });
    await t.events.deliver();
    expect(t.hooks()).toHaveLength(0);
    expect(t.events.subscriptionCount()).toBe(0);
  });
});

describe("Claude Code channel bridge", () => {
  it("announces changes to watched brains, then stops when the brain closes", async () => {
    const t = setup();
    const writer = await agent(t, "ChatGPT");
    const watcher = await agent(t, "Agent Brain channel");
    const reference = (await writer.call("create_brain", { project: "AFX Markets", title: "Spread study" })).body.reference;
    const notes: { content: string; meta: Record<string, string> }[] = [];
    const bridge = new ChannelBridge(
      async (name, args) => {
        const r = await watcher.call(name, args);
        return r.isError ? { ok: false, error: r.body.error } : { ok: true, body: r.body };
      },
      async (content, meta) => void notes.push({ content, meta }),
    );
    expect(await bridge.watch(reference)).toMatchObject({ ok: true, title: "Spread study" });
    await bridge.poll();
    expect(notes).toHaveLength(0); // nothing new yet

    const doc = (await writer.call("create_document", { reference, title: "Findings", markdown: "# Findings\n" })).body.document;
    await writer.call("patch_document", { reference, document_id: doc.id, base_revision: 1, edits: [{ find: "# Findings", replace: "# Findings\n- LP2 rejects" }] });
    await bridge.poll();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain('created "Findings"');
    expect(notes[0]!.content).toContain("revision 2");
    expect(notes[0]!.content).not.toContain("LP2 rejects");
    expect(notes[0]!.meta).toMatchObject({ reference, events: "2" });
    for (const key of Object.keys(notes[0]!.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);

    await writer.call("close_brain", { reference, export: false });
    await bridge.poll();
    expect(notes[1]!.content).toContain("was closed");
    expect(bridge.watched()).toHaveLength(0);
  });
});
