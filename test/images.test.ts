import { describe, expect, it } from "vitest";
import { BrainError } from "../src/core/errors.js";
import { base64ToBytes, bytesToBase64, detectImage } from "../src/core/images.js";
import { renderMarkdown } from "../src/core/markdown.js";
import { migrate } from "../src/core/schema.js";
import { BrainStore, DEFAULT_LIMITS, IMAGE_LINK_TTL_MS, type Actor } from "../src/core/store.js";
import { openSqlite } from "../src/node/sqlite.js";
import { BASE, connect, OWNER, signIn, testInstance } from "./helpers.js";

// A real 1×1 PNG.
const PNG_1X1 = base64ToBytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!;

/** A PNG-shaped buffer of a given size and dimensions. Only the header matters for detection. */
function png(bytes: number, width = 640, height = 480): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  for (let i = 24; i < bytes; i++) b[i] = (i * 31) & 0xff;
  return b;
}

function setup(limits = DEFAULT_LIMITS, now = () => Date.now()) {
  const sql = openSqlite(":memory:");
  migrate(sql);
  const store = new BrainStore(sql, limits, now);
  const alice = store.upsertUser("alice@example.com", "x");
  const bob = store.upsertUser("bob@example.com", "x");
  const a1: Actor = { userId: alice, clientId: "client-a", clientName: "Agent A" };
  const b: Actor = { userId: bob, clientId: "client-b" };
  const ref = store.createBrain(a1, { project: "Images" }).reference;
  return { sql, store, alice, a1, b, ref };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BrainError) return e.code;
    throw e;
  }
  return undefined;
}

describe("image formats", () => {
  it("detects PNG, JPEG, GIF and WebP with dimensions", () => {
    expect(detectImage(PNG_1X1)).toEqual({ mimeType: "image/png", width: 1, height: 1 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0, 0]);
    expect(detectImage(jpeg)).toEqual({ mimeType: "image/jpeg", width: 300, height: 200 });
    const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 10, 0, 20, 0, 0, 0]);
    expect(detectImage(gif)).toEqual({ mimeType: "image/gif", width: 10, height: 20 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(detectImage(webp)).toEqual({ mimeType: "image/webp", width: 100, height: 50 });
  });

  it("rejects SVG and other files", () => {
    expect(detectImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(detectImage(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectImage(new Uint8Array())).toBeNull();
  });

  it("round-trips base64, including URL-safe and data: URLs", () => {
    const data = png(70_000);
    const b64 = bytesToBase64(data);
    expect(base64ToBytes(b64)).toEqual(data);
    expect(base64ToBytes(`data:image/png;base64,${b64}`)).toEqual(data);
    expect(base64ToBytes(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))).toEqual(data);
    expect(base64ToBytes("not base64!")).toBeNull();
  });
});

describe("image store", () => {
  it("stores, lists, reads, updates and deletes an image across chunks", () => {
    const { store, a1, ref } = setup();
    const data = png(2_500_000, 1920, 1080); // three chunks
    const created = store.createImage(a1, ref, { title: "Checkout mock-up", description: "New layout", data });
    const image = created.image as { id: string; revision: number; mimeType: string; width: number; height: number; bytes: number };
    expect(image).toMatchObject({ mimeType: "image/png", width: 1920, height: 1080, bytes: 2_500_000, revision: 1 });

    const index = store.getIndex(a1.userId, ref);
    expect(index.images.map((i) => i.id)).toEqual([image.id]);
    expect(index.usage).toMatchObject({ images: 1, imageBytes: 2_500_000, limits: { imageBytes: DEFAULT_LIMITS.imageBytes } });
    expect(index.usage.bytes).toBe(0); // document byte budget is separate

    const read = store.readImage(a1.userId, ref, image.id);
    expect(read.data).toEqual(data);
    expect(read.image.updatedBy).toEqual({ client: "client-a", clientName: "Agent A" });

    expect(code(() => store.updateImage(a1, ref, { id: image.id, baseRevision: 2, title: "x" }))).toBe("conflict");
    const updated = store.updateImage(a1, ref, { id: image.id, baseRevision: 1, description: "Approved layout" });
    expect(updated.image).toMatchObject({ revision: 2, title: "Checkout mock-up", description: "Approved layout" });

    expect(code(() => store.deleteImage(a1, ref, { id: image.id, baseRevision: 1 }))).toBe("conflict");
    store.deleteImage(a1, ref, { id: image.id, baseRevision: 2 });
    expect(code(() => store.readImage(a1.userId, ref, image.id))).toBe("not_found");
    expect(store.getIndex(a1.userId, ref).images).toEqual([]);

    const changes = store.getChanges(a1.userId, ref, "0").events.filter((e) => e.type.startsWith("image."));
    expect(changes.map((e) => [e.type, e.imageId, e.documentId])).toEqual([
      ["image.created", image.id, null],
      ["image.updated", image.id, null],
      ["image.deleted", image.id, null],
    ]);
  });

  it("rejects unsupported files and enforces limits without storing anything", () => {
    const limits = { ...DEFAULT_LIMITS, brainImages: 2, brainImageBytes: 3000 };
    const { store, sql, a1, ref } = setup(limits);
    const svg = new TextEncoder().encode("<svg/>");
    expect(code(() => store.createImage(a1, ref, { title: "svg", data: svg }))).toBe("unsupported_image");
    expect(code(() => store.createImage(a1, ref, { title: "big", data: png(DEFAULT_LIMITS.imageBytes + 1) }))).toBe("limit_exceeded");
    store.createImage(a1, ref, { title: "one", data: png(1000) });
    expect(code(() => store.createImage(a1, ref, { title: "two", data: png(2500) }))).toBe("limit_exceeded"); // total bytes
    store.createImage(a1, ref, { title: "two", data: png(1000) });
    expect(code(() => store.createImage(a1, ref, { title: "three", data: png(100) }))).toBe("limit_exceeded"); // count
    expect(sql.all(`SELECT COUNT(*) AS n FROM images`)[0]).toEqual({ n: 2 });
    expect(sql.all(`SELECT COUNT(*) AS n FROM image_chunks`)[0]).toEqual({ n: 2 });
  });

  it("hides images from other users and deletes them on close", () => {
    const { store, sql, a1, b, ref } = setup();
    const id = (store.createImage(a1, ref, { title: "x", data: PNG_1X1 }).image as { id: string }).id;
    expect(code(() => store.readImage(b.userId, ref, id))).toBe("not_found");
    const closed = store.closeBrain(a1, ref, true);
    expect(closed.export!.images).toEqual([expect.objectContaining({ id, title: "x", mimeType: "image/png" })]);
    expect(sql.all(`SELECT COUNT(*) AS n FROM image_chunks`)[0]).toEqual({ n: 0 });
    expect(sql.all(`SELECT COUNT(*) AS n FROM images`)[0]).toEqual({ n: 0 });
  });

  it("uses an upload link once, keeps it after a rejected file, and expires it", () => {
    let now = 1_000_000;
    const { store, a1, ref } = setup(DEFAULT_LIMITS, () => now);
    store.createUploadLink(a1, ref, "hash-1", { title: "Diagram" });
    expect(code(() => store.uploadWithLink("hash-1", new TextEncoder().encode("<svg/>")))).toBe("unsupported_image");
    const result = store.uploadWithLink("hash-1", PNG_1X1);
    expect(result.reference).toBe(ref);
    expect(result.image).toMatchObject({ title: "Diagram", width: 1, height: 1 });
    expect(code(() => store.uploadWithLink("hash-1", PNG_1X1))).toBe("not_found");

    store.createUploadLink(a1, ref, "hash-2", { title: "Late" });
    now += IMAGE_LINK_TTL_MS + 1;
    expect(code(() => store.uploadWithLink("hash-2", PNG_1X1))).toBe("not_found");
  });
});

describe("images over MCP and HTTP", () => {
  async function agent(fetchDeps?: Parameters<typeof testInstance>[1]) {
    const t = testInstance({}, fetchDeps);
    const { access_token } = await signIn(t.fetch, "Agent A");
    const { client, call } = await connect(t.fetch, access_token);
    const ref = (await call("create_brain", { project: "Images" })).body.reference as string;
    return { t, client, call, ref };
  }

  it("uploads inline base64 and returns the picture from read_image", async () => {
    const { client, call, ref } = await agent();
    const up = await call("upload_image", { reference: ref, title: "Pixel", description: "A single pixel", data_base64: bytesToBase64(PNG_1X1) });
    expect(up.isError).toBe(false);
    const id = up.body.image.id as string;

    const index = await call("read_index", { reference: ref });
    expect(index.body.images).toEqual([expect.objectContaining({ id, title: "Pixel", mimeType: "image/png", width: 1, height: 1 })]);

    const result = (await client.callTool({ name: "read_image", arguments: { reference: ref, image_id: id } })) as {
      content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
    };
    const picture = result.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(picture.mimeType).toBe("image/png");
    expect(base64ToBytes(picture.data)).toEqual(PNG_1X1);

    const both = await call("upload_image", { reference: ref, title: "x" });
    expect(both.isError).toBe(true);
    const svg = await call("upload_image", { reference: ref, title: "x", data_base64: bytesToBase64(new TextEncoder().encode("<svg/>")) });
    expect(svg.body.error.code).toBe("unsupported_image");
  });

  it("uploads through a one-time link and downloads through a short-lived link", async () => {
    const { t, call, ref } = await agent();
    const link = await call("create_image_upload", { reference: ref, title: "Architecture", description: "Request flow" });
    expect(link.body.uploadUrl).toMatch(new RegExp(`^${BASE}/images/upload/`));

    const put = await t.fetch(link.body.uploadUrl, { method: "PUT", body: PNG_1X1 });
    expect(put.status).toBe(201);
    const uploaded = (await put.json()) as { image: { id: string; title: string }; reference: string };
    expect(uploaded).toMatchObject({ reference: ref, image: { title: "Architecture" } });
    expect((await t.fetch(link.body.uploadUrl, { method: "PUT", body: PNG_1X1 })).status).toBe(404);

    const tooBig = await call("create_image_upload", { reference: ref, title: "Big" });
    const big = await t.fetch(tooBig.body.uploadUrl, { method: "PUT", body: png(DEFAULT_LIMITS.imageBytes + 10) });
    expect(big.status).toBe(413);

    const dl = await call("read_image", { reference: ref, image_id: uploaded.image.id, as: "url" });
    const res = await t.fetch(dl.body.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_1X1);
    expect((await t.fetch(`${BASE}/images/download/not-a-token`)).status).toBe(404);
  });

  it("downloads from a public https source_url and refuses private hosts", async () => {
    const fetched: string[] = [];
    const { call, ref } = await agent({
      fetch: async (url) => {
        fetched.push(url);
        if (url === "https://files.example/redirect") return new Response(null, { status: 302, headers: { location: "https://cdn.example/pixel.png" } });
        if (url === "https://cdn.example/pixel.png") return new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
        return new Response("nope", { status: 404 });
      },
    });
    const ok = await call("upload_image", { reference: ref, title: "Remote", source_url: "https://files.example/redirect" });
    expect(ok.isError).toBe(false);
    expect(ok.body.image).toMatchObject({ mimeType: "image/png" });
    expect(fetched).toContain("https://cdn.example/pixel.png");

    for (const url of ["http://cdn.example/pixel.png", "https://127.0.0.1/x.png", "https://localhost/x.png"]) {
      const bad = await call("upload_image", { reference: ref, title: "Bad", source_url: url });
      expect(bad.body.error.code).toBe("invalid_request");
    }
  });

  it("shows images on the website only to the signed-in owner", async () => {
    const { t, call, ref } = await agent();
    const id = (await call("upload_image", { reference: ref, title: "Pixel", data_base64: bytesToBase64(PNG_1X1) })).body.image.id as string;
    await call("create_document", { reference: ref, title: "Overview", markdown: `See ![the pixel](image:${id}).` });
    const [project, brain] = ref.slice("agentBrain:".length).split(".");
    const raw = `${BASE}/brains/${project}/${brain}/images/${id}/raw`;

    const anonymous = await t.fetch(raw, { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("content-type") ?? "").not.toContain("image");

    const login = await t.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ email: OWNER.email, password: OWNER.password, next: "/" }).toString(),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const brainPage = await (await t.fetch(`${BASE}/brains/${project}/${brain}`, { headers: { cookie } })).text();
    expect(brainPage).toContain(`/images/${id}/raw`);
    const docId = (await call("read_index", { reference: ref })).body.documents[0].id;
    const docPage = await (await t.fetch(`${BASE}/brains/${project}/${brain}/documents/${docId}`, { headers: { cookie } })).text();
    expect(docPage).toContain(`<img src="/brains/${project}/${brain}/images/${id}/raw" alt="the pixel"`);
    const imagePage = await t.fetch(`${BASE}/brains/${project}/${brain}/images/${id}`, { headers: { cookie } });
    expect(imagePage.status).toBe(200);
    const bytes = await t.fetch(raw, { headers: { cookie } });
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG_1X1);
  });
});

describe("public image links", () => {
  it("serves each image at its own unguessable public URL until it is deleted", async () => {
    const t = testInstance();
    const { access_token } = await signIn(t.fetch, "Agent A");
    const { call } = await connect(t.fetch, access_token);
    const ref = (await call("create_brain", { project: "Images" })).body.reference as string;
    const up = await call("upload_image", { reference: ref, title: "Pixel", data_base64: bytesToBase64(PNG_1X1) });
    const image = up.body.image as { id: string; url: string; revision: number };
    expect(image.url).toMatch(new RegExp(`^${BASE}/i/[0-9a-z]{26}\\.png$`));
    const [project, brain] = ref.slice("agentBrain:".length).split(".");
    for (const id of [project!, brain!, image.id]) expect(image.url).not.toContain(id);

    // No cookie, no token: anyone with the link can view it.
    const res = await t.fetch(image.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_1X1);

    // The same URL is reported everywhere the agent sees the image.
    expect((await call("read_index", { reference: ref })).body.images[0].url).toBe(image.url);
    const link = await call("create_image_upload", { reference: ref, title: "Second" });
    const put = (await (await t.fetch(link.body.uploadUrl, { method: "PUT", body: PNG_1X1 })).json()) as { image: { url: string } };
    expect(put.image.url).toMatch(/\/i\/[0-9a-z]{26}\.png$/);
    expect(put.image.url).not.toBe(image.url);

    expect((await t.fetch(`${BASE}/i/0000000000000000000000000a.png`)).status).toBe(404);
    expect((await t.fetch(`${BASE}/i/not-a-token`)).status).toBe(404);
    await call("delete_image", { reference: ref, image_id: image.id, base_revision: image.revision });
    expect((await t.fetch(image.url)).status).toBe(404);
    await call("close_brain", { reference: ref, export: false });
    expect((await t.fetch(put.image.url)).status).toBe(404);
  });

  it("gives images stored before the migration a public link", () => {
    const sql = openSqlite(":memory:");
    migrate(sql);
    const store = new BrainStore(sql, DEFAULT_LIMITS, Date.now, "https://brain.test");
    const user = store.upsertUser("a@example.com", "x");
    const actor: Actor = { userId: user, clientId: "c" };
    const ref = store.createBrain(actor, { project: "P" }).reference;
    const id = (store.createImage(actor, ref, { title: "Old", data: PNG_1X1 }).image as { id: string }).id;
    // Simulate a row from before the column existed, then re-run the backfill statement.
    sql.run(`UPDATE images SET public_token = NULL`);
    sql.run(`UPDATE images SET public_token = lower(hex(randomblob(16))) WHERE public_token IS NULL`);
    const url = store.getIndex(user, ref).images.find((i) => i.id === id)!.url;
    expect(url).toMatch(/^https:\/\/brain\.test\/i\/[0-9a-f]{32}\.png$/);
    expect(store.publicImage(url.split("/i/")[1]!.replace(".png", "")).data).toEqual(PNG_1X1);
  });
});

describe("markdown image references", () => {
  it("renders image:<id> from the brain and nothing without a base", () => {
    const html = renderMarkdown("![diagram](image:0123456789abcdef)", { imageBase: "/brains/p/b/images" });
    expect(html).toContain('<a class="brain-image" href="/brains/p/b/images/0123456789abcdef"><img src="/brains/p/b/images/0123456789abcdef/raw" alt="diagram"');
    expect(renderMarkdown("![diagram](image:0123456789abcdef)")).not.toContain("<img");
    expect(renderMarkdown("![x](image:../../etc)", { imageBase: "/b" })).not.toContain("<img");
  });
});
