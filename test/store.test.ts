import { describe, expect, it } from "vitest";
import { BrainError } from "../src/core/errors.js";
import { parseReference } from "../src/core/ids.js";
import { migrate } from "../src/core/schema.js";
import { BrainStore, DEFAULT_LIMITS, type Actor } from "../src/core/store.js";
import { openSqlite } from "../src/node/sqlite.js";

function setup(limits = DEFAULT_LIMITS) {
  const sql = openSqlite(":memory:");
  migrate(sql);
  const store = new BrainStore(sql, limits);
  const alice = store.upsertUser("alice@example.com", "x");
  const bob = store.upsertUser("bob@example.com", "x");
  const a1: Actor = { userId: alice, clientId: "client-a", clientName: "Agent A" };
  const a2: Actor = { userId: alice, clientId: "client-b", clientName: "Agent B" };
  const b: Actor = { userId: bob, clientId: "client-c" };
  return { sql, store, alice, bob, a1, a2, b };
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

describe("references", () => {
  it("take the form agentBrain:<project token>.<task>", () => {
    const { store, a1 } = setup();
    const brain = store.createBrain(a1, { project: "AFX Markets" });
    expect(brain.reference).toMatch(/^agentBrain:[0-9a-hjkmnp-tv-z]{26}\.[0-9a-hjkmnp-tv-z]{26}$/);
    const parsed = parseReference(brain.reference)!;
    expect(parsed.projectId).toBe(brain.project.token);
    expect(brain.reference).toBe(`agentBrain:${brain.project.token}.${parsed.brainId}`);
    expect(parseReference("agentBrain:" + "I".repeat(26))).toBeUndefined();
    expect(parseReference("agentBrain:short")).toBeUndefined();
    expect(parseReference(`agentBrain:${brain.project.token}.`)).toBeUndefined();
  });

  it("share the project part across every brain in the same project", () => {
    const { store, a1 } = setup();
    const first = parseReference(store.createBrain(a1, { project: "AFX Markets" }).reference)!;
    const second = parseReference(store.createBrain(a1, { project: "afx markets" }).reference)!;
    const other = parseReference(store.createBrain(a1, { project: "Other" }).reference)!;
    expect(second.projectId).toBe(first.projectId);
    expect(second.brainId).not.toBe(first.brainId);
    expect(other.projectId).not.toBe(first.projectId);
  });

  it("reject a task paired with the wrong project, and still accept legacy single-identifier references", () => {
    const { store, a1 } = setup();
    const brain = parseReference(store.createBrain(a1, { project: "A" }).reference)!;
    const otherProject = store.openProject(a1.userId, "B", true).token;
    expect(code(() => store.getIndex(a1.userId, `agentBrain:${otherProject}.${brain.brainId}`))).toBe("not_found");
    const legacy = store.getIndex(a1.userId, `agentBrain:${brain.brainId}`);
    expect(legacy.reference).toBe(`agentBrain:${brain.projectId}.${brain.brainId}`);
  });
});

describe("projects", () => {
  it("reuses the existing project token when the same name is used again", () => {
    const { store, alice, a1 } = setup();
    const first = store.openProject(alice, "AFX Markets", true);
    const again = store.openProject(alice, "  afx   markets ", true);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.token).toBe(first.token);
    const brain = store.createBrain(a1, { project: "AFX MARKETS" });
    expect(brain.project.token).toBe(first.token);
    expect(store.listProjects(alice)).toHaveLength(1);
  });

  it("keeps same-named projects of different users separate", () => {
    const { store, alice, bob } = setup();
    const a = store.openProject(alice, "Shared Name", true);
    const b = store.openProject(bob, "Shared Name", true);
    expect(a.token).not.toBe(b.token);
  });

  it("does not create a project without permission to write", () => {
    const { store, alice } = setup();
    expect(code(() => store.openProject(alice, "Nope", false))).toBe("not_found");
  });
});

describe("access", () => {
  it("does not reveal another user's brain to someone holding its reference", () => {
    const { store, a1, bob, b } = setup();
    const brain = store.createBrain(a1, { project: "Secret" });
    expect(code(() => store.getIndex(bob, brain.reference))).toBe("not_found");
    expect(code(() => store.createDocument(b, brain.reference, { title: "x", markdown: "y" }))).toBe("not_found");
    expect(code(() => store.closeBrain(b, brain.reference, false))).toBe("not_found");
    expect(store.listBrains(bob)).toHaveLength(0);
  });
});

describe("documents", () => {
  it("rejects stale writes and returns the current version", () => {
    const { store, a1, a2 } = setup();
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const created = store.createDocument(a1, ref, { title: "Findings", markdown: "# Findings\n" });
    const id = created.document.id;
    const fromA = store.replaceDocument(a1, ref, { id, baseRevision: 1, markdown: "# Findings\n- A found X\n" });
    expect(fromA.document.revision).toBe(2);
    try {
      store.replaceDocument(a2, ref, { id, baseRevision: 1, markdown: "# Findings\n- B found Y\n" });
      expect.fail("expected conflict");
    } catch (e) {
      const err = e as BrainError;
      expect(err.code).toBe("conflict");
      const current = err.details.current as { revision: number; markdown: string; updatedBy: { clientName: string } };
      expect(current.revision).toBe(2);
      expect(current.markdown).toContain("A found X");
      expect(current.updatedBy.clientName).toBe("Agent A");
    }
    // B reapplies its change on top of A's.
    const fromB = store.patchDocument(a2, ref, { id, baseRevision: 2, edits: [{ find: "- A found X\n", replace: "- A found X\n- B found Y\n" }] });
    expect(fromB.document.revision).toBe(3);
    const [doc] = store.readDocuments(a1.userId, ref, [id]).documents;
    expect(doc!.markdown).toBe("# Findings\n- A found X\n- B found Y\n");
  });

  it("requires patch text to match exactly once", () => {
    const { store, a1 } = setup();
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const id = store.createDocument(a1, ref, { title: "D", markdown: "a a b" }).document.id;
    expect(code(() => store.patchDocument(a1, ref, { id, baseRevision: 1, edits: [{ find: "a", replace: "c" }] }))).toBe("invalid_request");
    expect(code(() => store.patchDocument(a1, ref, { id, baseRevision: 1, edits: [{ find: "z", replace: "c" }] }))).toBe("invalid_request");
    expect(store.patchDocument(a1, ref, { id, baseRevision: 1, edits: [{ find: "b", replace: "c" }] }).document.revision).toBe(2);
  });

  it("revision-checks renames and deletes, keeps IDs on rename and never reuses deleted IDs", () => {
    const { store, a1, a2 } = setup();
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const id = store.createDocument(a1, ref, { title: "Notes", markdown: "n" }).document.id;
    store.replaceDocument(a2, ref, { id, baseRevision: 1, markdown: "n2" });
    expect(code(() => store.deleteDocument(a1, ref, { id, baseRevision: 1 }))).toBe("conflict");
    expect(code(() => store.renameDocument(a1, ref, { id, baseRevision: 1, title: "Findings" }))).toBe("conflict");
    const renamed = store.renameDocument(a1, ref, { id, baseRevision: 2, title: "Findings", description: "Evidence" });
    expect(renamed.document).toMatchObject({ id, title: "Findings", description: "Evidence", revision: 3 });
    store.deleteDocument(a1, ref, { id, baseRevision: 3 });
    expect(store.getIndex(a1.userId, ref).documents).toHaveLength(0);
    expect(store.readDocuments(a1.userId, ref, [id]).missing).toEqual([id]);
    expect(code(() => store.replaceDocument(a1, ref, { id, baseRevision: 4, markdown: "x" }))).toBe("not_found");
  });

  it("keeps a bounded revision history", () => {
    const { store, a1 } = setup({ ...DEFAULT_LIMITS, revisionsPerDocument: 3 });
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const id = store.createDocument(a1, ref, { title: "D", markdown: "1" }).document.id;
    for (let r = 1; r <= 5; r++) store.replaceDocument(a1, ref, { id, baseRevision: r, markdown: String(r + 1), summary: `rev ${r + 1}` });
    const history = store.documentHistory(a1.userId, ref, id);
    expect(history.revisions.map((r) => r.revision)).toEqual([6, 5, 4]);
    expect(store.readRevision(a1.userId, ref, id, 5).markdown).toBe("5");
    expect(code(() => store.readRevision(a1.userId, ref, id, 2))).toBe("not_found");
  });
});

describe("limits", () => {
  const small = { ...DEFAULT_LIMITS, documentBytes: 100, brainDocuments: 5, brainBytes: 300 };

  it("warns at 80% and rejects past the hard limit without changing anything", () => {
    const { store, a1 } = setup(small);
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const big = store.createDocument(a1, ref, { title: "D", markdown: "x".repeat(85) });
    expect(big.warnings.join(" ")).toContain("85 of 100 bytes");
    try {
      store.replaceDocument(a1, ref, { id: big.document.id, baseRevision: 1, markdown: "x".repeat(101) });
      expect.fail("expected limit error");
    } catch (e) {
      expect((e as BrainError).code).toBe("limit_exceeded");
      expect((e as BrainError).details).toMatchObject({ limit: "documentBytes", maximum: 100, attempted: 101 });
    }
    expect(store.getIndex(a1.userId, ref).documents[0]!.revision).toBe(1);
  });

  it("enforces document count and total size per brain", () => {
    const { store, a1 } = setup(small);
    const ref = store.createBrain(a1, { project: "P" }).reference;
    for (let i = 0; i < 3; i++) store.createDocument(a1, ref, { title: `D${i}`, markdown: "x".repeat(90) });
    expect(code(() => store.createDocument(a1, ref, { title: "too big", markdown: "x".repeat(40) }))).toBe("limit_exceeded");
    store.createDocument(a1, ref, { title: "D3", markdown: "" });
    store.createDocument(a1, ref, { title: "D4", markdown: "" });
    expect(code(() => store.createDocument(a1, ref, { title: "D5", markdown: "" }))).toBe("limit_exceeded");
  });
});

describe("idempotency", () => {
  it("replays a retried mutation instead of repeating it", () => {
    const { store, a1 } = setup();
    const ref = store.createBrain(a1, { project: "P" }).reference;
    const make = () => store.createDocument(a1, ref, { title: "D", markdown: "x" });
    const first = store.idempotent(a1.userId, "key-1", "hash-a", ref, make);
    const retry = store.idempotent(a1.userId, "key-1", "hash-a", ref, make) as typeof first & { replayed?: boolean };
    expect(retry.document.id).toBe(first.document.id);
    expect(retry.replayed).toBe(true);
    expect(store.getIndex(a1.userId, ref).documents).toHaveLength(1);
    expect(code(() => store.idempotent(a1.userId, "key-1", "hash-b", ref, make))).toBe("idempotency_mismatch");
  });

  it("does not create duplicate brains on retry", () => {
    const { store, a1 } = setup();
    const make = () => store.createBrain(a1, { project: "P" });
    const first = store.idempotent(a1.userId, "brain-key", "h", undefined, make);
    const again = store.idempotent(a1.userId, "brain-key", "h", undefined, make);
    expect(again.reference).toBe(first.reference);
    expect(store.listBrains(a1.userId)).toHaveLength(1);
  });
});

describe("changes", () => {
  it("lists events after a cursor and asks for a resync when the cursor is too old", () => {
    const { store, a1, a2 } = setup({ ...DEFAULT_LIMITS, eventsPerBrain: 5 });
    const brain = store.createBrain(a1, { project: "P" });
    const cursor = brain.cursor;
    const id = store.createDocument(a2, brain.reference, { title: "D", markdown: "1" }).document.id;
    const changes = store.getChanges(a1.userId, brain.reference, cursor);
    expect(changes.events).toHaveLength(1);
    expect(changes.events[0]).toMatchObject({ type: "document.created", documentId: id, revision: 1, client: "client-b", clientName: "Agent B" });
    expect(changes.events[0]).not.toHaveProperty("markdown");
    for (let r = 1; r <= 8; r++) store.replaceDocument(a1, brain.reference, { id, baseRevision: r, markdown: String(r) });
    const stale = store.getChanges(a1.userId, brain.reference, changes.cursor);
    expect(stale.resyncRequired).toBe(true);
    const latest = store.getChanges(a1.userId, brain.reference, stale.cursor);
    expect(latest.events).toHaveLength(0);
    expect(code(() => store.getChanges(a1.userId, brain.reference, "999"))).toBe("invalid_request");
  });

  it("pages through events", () => {
    const { store, a1 } = setup();
    const brain = store.createBrain(a1, { project: "P" });
    for (let i = 0; i < 5; i++) store.createDocument(a1, brain.reference, { title: `D${i}`, markdown: "" });
    const page1 = store.getChanges(a1.userId, brain.reference, "0", 3);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page1.hasMore).toBe(true);
    const page2 = store.getChanges(a1.userId, brain.reference, page1.cursor, 3);
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(page2.hasMore).toBe(false);
  });
});

describe("closing", () => {
  it("closes with an export, deletes content and rejects further use", () => {
    const { sql, store, a1 } = setup();
    const brain = store.createBrain(a1, { project: "P", title: "Task" });
    const sibling = store.createBrain(a1, { project: "P" });
    store.createDocument(a1, brain.reference, { title: "Overview", markdown: "# Overview" });
    store.idempotent(a1.userId, "k", "h", brain.reference, () => store.createDocument(a1, brain.reference, { title: "Decisions", markdown: "d" }));
    const closed = store.closeBrain(a1, brain.reference, true);
    expect(closed.export?.documents.map((d) => d.title)).toEqual(["Overview", "Decisions"]);
    expect(closed.export?.documents[0]!.markdown).toBe("# Overview");
    expect(closed.export?.project.name).toBe("P");
    const id = parseReference(brain.reference)!.brainId;
    for (const table of ["documents", "revisions", "events", "idempotency"]) {
      expect(sql.all(`SELECT * FROM ${table} WHERE brain_id = ?`, id)).toHaveLength(0);
    }
    expect(code(() => store.getIndex(a1.userId, brain.reference))).toBe("brain_closed");
    expect(code(() => store.createDocument(a1, brain.reference, { title: "x", markdown: "" }))).toBe("brain_closed");
    const again = store.closeBrain(a1, brain.reference, true);
    expect(again).toMatchObject({ status: "closed", alreadyClosed: true, export: null, closedAt: closed.closedAt });
    expect(store.getIndex(a1.userId, sibling.reference).status).toBe("active");
  });

  it("closes without an export", () => {
    const { store, a1 } = setup();
    const brain = store.createBrain(a1, { project: "P" });
    expect(store.closeBrain(a1, brain.reference, false).export).toBeNull();
  });
});
