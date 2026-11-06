import { BrainError } from "./errors.js";
import { formatReference, newDocumentId, newOpaqueId, parseReference, type ParsedReference } from "./ids.js";
import { one, type Sql } from "./sql.js";

export interface Limits {
  /** Maximum UTF-8 size of one document body, in bytes. */
  documentBytes: number;
  /** Maximum number of live documents in one brain. */
  brainDocuments: number;
  /** Maximum total UTF-8 size of all live document bodies in one brain, in bytes. */
  brainBytes: number;
  /** Revisions kept per document while the brain is active. */
  revisionsPerDocument: number;
  /** Events kept per brain for catch-up. Older cursors must resynchronise. */
  eventsPerBrain: number;
}

export const DEFAULT_LIMITS: Limits = {
  documentBytes: 64 * 1024,
  brainDocuments: 50,
  brainBytes: 1024 * 1024,
  revisionsPerDocument: 50,
  eventsPerBrain: 1000,
};

/** Who is making a change. clientName is descriptive only and is not proof of identity. */
export interface Actor {
  userId: string;
  clientId: string;
  clientName?: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string;
  revision: number;
  bytes: number;
  updatedAt: string;
}

export interface BrainSummary {
  reference: string;
  project: { name: string; token: string };
  title: string | null;
  description: string | null;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface BrainIndex extends BrainSummary {
  cursor: string;
  documents: DocumentSummary[];
  usage: { documents: number; bytes: number; limits: { documentBytes: number; brainDocuments: number; brainBytes: number } };
}

export interface Edit {
  find: string;
  replace: string;
}

const SOFT_LIMIT_RATIO = 0.8;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function actorString(actor: Actor): string {
  return JSON.stringify({ user: actor.userId, client: actor.clientId, clientName: actor.clientName ?? null });
}

function parseActor(s: string): { client: string; clientName: string | null } {
  const a = JSON.parse(s) as { client: string; clientName: string | null };
  return { client: a.client, clientName: a.clientName };
}

/** Normalise a project name for uniqueness: trimmed, whitespace collapsed, case-insensitive. */
export function projectKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

type BrainRow = {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  description: string | null;
  status: string;
  last_seq: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  project_name: string;
};

type DocRow = {
  brain_id: string;
  id: string;
  title: string;
  description: string;
  body: string;
  bytes: number;
  revision: number;
  deleted: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
};

export class BrainStore {
  constructor(
    private readonly sql: Sql,
    readonly limits: Limits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- users

  upsertUser(email: string, passwordHash: string): string {
    const existing = one<{ id: string }>(this.sql, `SELECT id FROM users WHERE email = ?`, email.toLowerCase());
    if (existing) {
      this.sql.run(`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, existing.id);
      return existing.id;
    }
    const id = newOpaqueId();
    this.sql.run(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
      id,
      email.toLowerCase(),
      passwordHash,
      this.now(),
    );
    return id;
  }

  findUserByEmail(email: string): { id: string; email: string; password_hash: string } | undefined {
    return one(this.sql, `SELECT id, email, password_hash FROM users WHERE email = ?`, email.trim().toLowerCase());
  }

  // ---------------------------------------------------------------- projects

  /** Find a project by name within the user's account, creating it if allowed. */
  openProject(
    userId: string,
    name: string,
    create: boolean,
  ): { name: string; token: string; created: boolean; brains: BrainSummary[] } {
    const key = projectKey(name);
    if (!key) throw new BrainError("invalid_request", "A project name is required.");
    if (key.length > 200) throw new BrainError("invalid_request", "Project names are limited to 200 characters.");
    return this.sql.transaction(() => {
      const existing = one<{ id: string; name: string }>(
        this.sql,
        `SELECT id, name FROM projects WHERE user_id = ? AND name_key = ?`,
        userId,
        key,
      );
      if (existing) {
        return { name: existing.name, token: existing.id, created: false, brains: this.listBrains(userId, existing.id) };
      }
      if (!create) throw new BrainError("not_found", `No project named "${name.trim()}" exists.`);
      const id = newOpaqueId();
      this.sql.run(
        `INSERT INTO projects (id, user_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)`,
        id,
        userId,
        name.trim().replace(/\s+/g, " "),
        key,
        this.now(),
      );
      return { name: name.trim().replace(/\s+/g, " "), token: id, created: true, brains: [] };
    });
  }

  listProjects(userId: string): { name: string; token: string; activeBrains: number }[] {
    return this.sql
      .all<{ id: string; name: string; active: number }>(
        `SELECT p.id, p.name,
           (SELECT COUNT(*) FROM brains b WHERE b.project_id = p.id AND b.status = 'active') AS active
         FROM projects p WHERE p.user_id = ? ORDER BY p.name`,
        userId,
      )
      .map((r) => ({ name: r.name, token: r.id, activeBrains: r.active }));
  }

  private resolveProject(userId: string, project: string): { id: string; name: string } {
    const key = projectKey(project);
    const row = one<{ id: string; name: string }>(
      this.sql,
      `SELECT id, name FROM projects WHERE user_id = ? AND (name_key = ? OR id = ?)`,
      userId,
      key,
      project.trim().toLowerCase(),
    );
    if (!row) throw new BrainError("not_found", `No project named "${project.trim()}" exists. Open it first.`);
    return row;
  }

  // ---------------------------------------------------------------- brains

  createBrain(
    actor: Actor,
    input: { project: string; title?: string; description?: string },
  ): BrainIndex {
    return this.sql.transaction(() => {
      const opened = this.openProject(actor.userId, input.project, true);
      const id = newOpaqueId();
      const now = this.now();
      this.sql.run(
        `INSERT INTO brains (id, project_id, user_id, title, description, status, last_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
        id,
        opened.token,
        actor.userId,
        cleanOptional(input.title, 200),
        cleanOptional(input.description, 2000),
        now,
        now,
      );
      this.appendEvent(id, "brain.created", null, null, actor);
      return this.index(this.loadBrain(actor.userId, { brainId: id }));
    });
  }

  listBrains(userId: string, projectToken?: string): BrainSummary[] {
    const rows = projectToken
      ? this.sql.all<BrainRow>(
          `SELECT b.*, p.name AS project_name FROM brains b JOIN projects p ON p.id = b.project_id
           WHERE b.user_id = ? AND b.project_id = ? AND b.status = 'active' ORDER BY b.updated_at DESC`,
          userId,
          projectToken,
        )
      : this.sql.all<BrainRow>(
          `SELECT b.*, p.name AS project_name FROM brains b JOIN projects p ON p.id = b.project_id
           WHERE b.user_id = ? AND b.status = 'active' ORDER BY b.updated_at DESC`,
          userId,
        );
    return rows.map((r) => this.summary(r));
  }

  listBrainsForProject(userId: string, project: string): BrainSummary[] {
    return this.listBrains(userId, this.resolveProject(userId, project).id);
  }

  getIndex(userId: string, reference: string): BrainIndex {
    return this.index(this.loadActiveBrain(userId, reference));
  }

  updateBrain(actor: Actor, reference: string, input: { title?: string; description?: string }): BrainIndex {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const title = input.title !== undefined ? cleanOptional(input.title, 200) : brain.title;
      const description = input.description !== undefined ? cleanOptional(input.description, 2000) : brain.description;
      this.sql.run(
        `UPDATE brains SET title = ?, description = ?, updated_at = ? WHERE id = ?`,
        title,
        description,
        this.now(),
        brain.id,
      );
      this.appendEvent(brain.id, "brain.updated", null, null, actor);
      return this.index(this.loadBrain(actor.userId, { brainId: brain.id }));
    });
  }

  // ---------------------------------------------------------------- documents

  readDocuments(
    userId: string,
    reference: string,
    ids: string[],
  ): { documents: (DocumentSummary & { markdown: string; updatedBy: { client: string; clientName: string | null } })[]; missing: string[] } {
    const brain = this.loadActiveBrain(userId, reference);
    const documents = [];
    const missing: string[] = [];
    for (const id of [...new Set(ids)]) {
      const doc = this.findDoc(brain.id, id);
      if (!doc) {
        missing.push(id);
        continue;
      }
      documents.push({ ...docSummary(doc), markdown: doc.body, updatedBy: parseActor(doc.updated_by) });
    }
    return { documents, missing };
  }

  createDocument(
    actor: Actor,
    reference: string,
    input: { title: string; description?: string; markdown: string; summary?: string },
  ): WriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const title = requireText(input.title, "title", 200);
      const description = (input.description ?? "").trim().slice(0, 500);
      const bytes = byteLength(input.markdown);
      const usage = this.usage(brain.id);
      this.checkLimits(usage, { addDocuments: 1, deltaBytes: bytes, documentBytes: bytes });
      const id = newDocumentId();
      const now = this.now();
      this.sql.run(
        `INSERT INTO documents (brain_id, id, title, description, body, bytes, revision, deleted, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
        brain.id,
        id,
        title,
        description,
        input.markdown,
        bytes,
        now,
        now,
        actorString(actor),
      );
      this.recordRevision(brain.id, id, 1, "created", title, description, input.markdown, input.summary, actor);
      return this.finishWrite(brain, id, "document.created", actor);
    });
  }

  replaceDocument(
    actor: Actor,
    reference: string,
    input: { id: string; baseRevision: number; markdown: string; summary?: string },
  ): WriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const doc = this.checkRevision(brain.id, input.id, input.baseRevision);
      return this.writeBody(brain, doc, input.markdown, input.summary, actor);
    });
  }

  patchDocument(
    actor: Actor,
    reference: string,
    input: { id: string; baseRevision: number; edits: Edit[]; summary?: string },
  ): WriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const doc = this.checkRevision(brain.id, input.id, input.baseRevision);
      if (input.edits.length === 0) throw new BrainError("invalid_request", "At least one edit is required.");
      let body = doc.body;
      input.edits.forEach((edit, i) => {
        if (!edit.find) throw new BrainError("invalid_request", `Edit ${i + 1} has an empty "find" string.`);
        const first = body.indexOf(edit.find);
        if (first === -1) {
          throw new BrainError("invalid_request", `Edit ${i + 1}: the "find" text does not occur in the document.`, { edit: i + 1 });
        }
        if (body.indexOf(edit.find, first + 1) !== -1) {
          throw new BrainError(
            "invalid_request",
            `Edit ${i + 1}: the "find" text occurs more than once. Include more surrounding text so it is unique.`,
            { edit: i + 1 },
          );
        }
        body = body.slice(0, first) + edit.replace + body.slice(first + edit.find.length);
      });
      return this.writeBody(brain, doc, body, input.summary, actor);
    });
  }

  renameDocument(
    actor: Actor,
    reference: string,
    input: { id: string; baseRevision: number; title: string; description?: string; summary?: string },
  ): WriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const doc = this.checkRevision(brain.id, input.id, input.baseRevision);
      const title = requireText(input.title, "title", 200);
      const description = input.description !== undefined ? input.description.trim().slice(0, 500) : doc.description;
      const revision = doc.revision + 1;
      this.sql.run(
        `UPDATE documents SET title = ?, description = ?, revision = ?, updated_at = ?, updated_by = ? WHERE brain_id = ? AND id = ?`,
        title,
        description,
        revision,
        this.now(),
        actorString(actor),
        brain.id,
        doc.id,
      );
      this.recordRevision(brain.id, doc.id, revision, "renamed", title, description, doc.body, input.summary, actor);
      return this.finishWrite(brain, doc.id, "document.renamed", actor);
    });
  }

  deleteDocument(
    actor: Actor,
    reference: string,
    input: { id: string; baseRevision: number; summary?: string },
  ): WriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const doc = this.checkRevision(brain.id, input.id, input.baseRevision);
      const revision = doc.revision + 1;
      // Keep a tombstone row so the ID is never reused; drop the content and history.
      this.sql.run(
        `UPDATE documents SET deleted = 1, body = '', bytes = 0, revision = ?, updated_at = ?, updated_by = ? WHERE brain_id = ? AND id = ?`,
        revision,
        this.now(),
        actorString(actor),
        brain.id,
        doc.id,
      );
      this.sql.run(`DELETE FROM revisions WHERE brain_id = ? AND document_id = ?`, brain.id, doc.id);
      const seq = this.appendEvent(brain.id, "document.deleted", doc.id, revision, actor);
      this.touch(brain.id);
      return { document: { id: doc.id, revision, deleted: true }, cursor: String(seq), warnings: [] };
    });
  }

  documentHistory(
    userId: string,
    reference: string,
    id: string,
  ): { id: string; revisions: { revision: number; kind: string; title: string; summary: string | null; bytes: number; client: string; clientName: string | null; at: string }[] } {
    const brain = this.loadActiveBrain(userId, reference);
    if (!this.findDoc(brain.id, id)) throw new BrainError("not_found", `Document ${id} does not exist in this brain.`);
    const rows = this.sql.all<{ revision: number; kind: string; title: string; summary: string | null; body: string; actor: string; created_at: number }>(
      `SELECT revision, kind, title, summary, body, actor, created_at FROM revisions
       WHERE brain_id = ? AND document_id = ? ORDER BY revision DESC`,
      brain.id,
      id,
    );
    return {
      id,
      revisions: rows.map((r) => ({
        revision: r.revision,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        bytes: byteLength(r.body),
        ...parseActor(r.actor),
        at: iso(r.created_at),
      })),
    };
  }

  readRevision(userId: string, reference: string, id: string, revision: number): { id: string; revision: number; title: string; markdown: string } {
    const brain = this.loadActiveBrain(userId, reference);
    const row = one<{ title: string; body: string }>(
      this.sql,
      `SELECT title, body FROM revisions WHERE brain_id = ? AND document_id = ? AND revision = ?`,
      brain.id,
      id,
      revision,
    );
    if (!row) throw new BrainError("not_found", `Revision ${revision} of document ${id} is not available.`);
    return { id, revision, title: row.title, markdown: row.body };
  }

  // ---------------------------------------------------------------- changes

  getChanges(
    userId: string,
    reference: string,
    cursor: string | undefined,
    limit = 100,
  ): {
    cursor: string;
    hasMore: boolean;
    resyncRequired?: boolean;
    events: { id: string; seq: number; type: string; documentId: string | null; revision: number | null; client: string; clientName: string | null; at: string }[];
  } {
    const brain = this.loadActiveBrain(userId, reference);
    const after = cursor === undefined || cursor === "" ? 0 : Number(cursor);
    if (!Number.isInteger(after) || after < 0 || after > brain.last_seq) {
      throw new BrainError("invalid_request", "The cursor is not valid for this brain.", { latestCursor: String(brain.last_seq) });
    }
    const oldest = one<{ seq: number }>(this.sql, `SELECT MIN(seq) AS seq FROM events WHERE brain_id = ?`, brain.id)?.seq ?? brain.last_seq + 1;
    if (after < oldest - 1) {
      return { cursor: String(brain.last_seq), hasMore: false, resyncRequired: true, events: [] };
    }
    const size = Math.min(Math.max(limit, 1), 500);
    const rows = this.sql.all<{ id: string; seq: number; type: string; document_id: string | null; revision: number | null; actor: string; created_at: number }>(
      `SELECT id, seq, type, document_id, revision, actor, created_at FROM events
       WHERE brain_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      brain.id,
      after,
      size + 1,
    );
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    return {
      cursor: String(page.length ? page[page.length - 1]!.seq : after),
      hasMore,
      events: page.map((r) => ({
        id: r.id,
        seq: r.seq,
        type: r.type,
        documentId: r.document_id,
        revision: r.revision,
        ...parseActor(r.actor),
        at: iso(r.created_at),
      })),
    };
  }

  // ---------------------------------------------------------------- close

  /**
   * Close a brain: atomically stop writes, take a consistent snapshot (when an
   * export is requested) and delete the task content. Repeating the call on a
   * closed brain returns the same closed outcome without an export.
   */
  closeBrain(actor: Actor, reference: string, withExport: boolean): CloseResult {
    return this.sql.transaction(() => {
      const brain = this.loadBrain(actor.userId, this.requireReference(reference));
      if (brain.status === "closed") {
        return { reference: formatReference(brain.project_id, brain.id), status: "closed", closedAt: iso(brain.closed_at!), alreadyClosed: true, export: null };
      }
      this.sql.run(`UPDATE brains SET status = 'closing' WHERE id = ?`, brain.id);
      const snapshot = withExport ? this.buildExport(brain) : null;
      const now = this.now();
      this.sql.run(`DELETE FROM documents WHERE brain_id = ?`, brain.id);
      this.sql.run(`DELETE FROM revisions WHERE brain_id = ?`, brain.id);
      this.sql.run(`DELETE FROM events WHERE brain_id = ?`, brain.id);
      this.sql.run(`DELETE FROM idempotency WHERE brain_id = ?`, brain.id);
      this.sql.run(
        `UPDATE brains SET status = 'closed', title = NULL, description = NULL, closed_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        brain.id,
      );
      return { reference: formatReference(brain.project_id, brain.id), status: "closed", closedAt: iso(now), alreadyClosed: false, export: snapshot };
    });
  }

  private buildExport(brain: BrainRow): BrainExport {
    const docs = this.sql.all<DocRow>(
      `SELECT * FROM documents WHERE brain_id = ? AND deleted = 0 ORDER BY created_at, rowid`,
      brain.id,
    );
    return {
      format: "agentbrain-export/1",
      reference: formatReference(brain.project_id, brain.id),
      project: { name: brain.project_name, token: brain.project_id },
      title: brain.title,
      description: brain.description,
      createdAt: iso(brain.created_at),
      exportedAt: iso(this.now()),
      finalCursor: String(brain.last_seq),
      documents: docs.map((d) => ({ ...docSummary(d), markdown: d.body })),
    };
  }

  // ---------------------------------------------------------------- idempotency

  /**
   * Run a mutation once per idempotency key. A retry with the same key and the
   * same request returns the stored response; a different request is rejected.
   */
  idempotent<T>(userId: string, key: string | undefined, requestHash: string, brainRef: string | undefined, fn: () => T): T {
    if (!key) return fn();
    if (key.length > 200) throw new BrainError("invalid_request", "Idempotency keys are limited to 200 characters.");
    return this.sql.transaction(() => {
      this.sql.run(`DELETE FROM idempotency WHERE created_at < ?`, this.now() - IDEMPOTENCY_TTL_MS);
      const prior = one<{ request_hash: string; response: string }>(
        this.sql,
        `SELECT request_hash, response FROM idempotency WHERE user_id = ? AND key = ?`,
        userId,
        key,
      );
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new BrainError("idempotency_mismatch", "This idempotency key was already used for a different request.");
        }
        return { ...(JSON.parse(prior.response) as object), replayed: true } as T;
      }
      const result = fn();
      const brainId = (result as { reference?: string }).reference
        ? parseReference((result as { reference: string }).reference)?.brainId
        : brainRef
          ? parseReference(brainRef)?.brainId
          : undefined;
      this.sql.run(
        `INSERT INTO idempotency (user_id, key, request_hash, brain_id, response, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        userId,
        key,
        requestHash,
        brainId ?? null,
        JSON.stringify(result),
        this.now(),
      );
      return result;
    });
  }

  // ---------------------------------------------------------------- internals

  private requireReference(reference: string): ParsedReference {
    const parsed = parseReference(reference);
    if (!parsed) {
      throw new BrainError("invalid_request", 'That is not a valid reference. Expected "agentBrain:<project>.<task>", two 26-character identifiers joined by a dot.');
    }
    return parsed;
  }

  /** Load a brain the user owns. Other users' brains are indistinguishable from missing ones. */
  private loadBrain(userId: string, ref: ParsedReference): BrainRow {
    const row = one<BrainRow>(
      this.sql,
      `SELECT b.*, p.name AS project_name FROM brains b JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND b.user_id = ?`,
      ref.brainId,
      userId,
    );
    // The project part must match too, so a reference cannot be re-pointed at another project.
    if (!row || (ref.projectId && row.project_id !== ref.projectId)) throw new BrainError("not_found", "No brain with that reference is available to you.");
    return row;
  }

  private loadActiveBrain(userId: string, reference: string): BrainRow {
    const brain = this.loadBrain(userId, this.requireReference(reference));
    if (brain.status !== "active") {
      throw new BrainError("brain_closed", "This brain has been closed and its content deleted.", {
        closedAt: brain.closed_at ? iso(brain.closed_at) : null,
      });
    }
    return brain;
  }

  private findDoc(brainId: string, id: string): DocRow | undefined {
    return one<DocRow>(this.sql, `SELECT * FROM documents WHERE brain_id = ? AND id = ? AND deleted = 0`, brainId, id);
  }

  private checkRevision(brainId: string, id: string, baseRevision: number): DocRow {
    const doc = this.findDoc(brainId, id);
    if (!doc) throw new BrainError("not_found", `Document ${id} does not exist in this brain (it may have been deleted).`);
    if (doc.revision !== baseRevision) {
      throw new BrainError(
        "conflict",
        `Document ${id} has changed since revision ${baseRevision}. Read the current version below, reapply your change to it and retry with baseRevision ${doc.revision}.`,
        {
          current: {
            ...docSummary(doc),
            markdown: doc.body,
            updatedBy: parseActor(doc.updated_by),
          },
        },
      );
    }
    return doc;
  }

  private writeBody(brain: BrainRow, doc: DocRow, body: string, summary: string | undefined, actor: Actor): WriteResult {
    const bytes = byteLength(body);
    const usage = this.usage(brain.id);
    this.checkLimits(usage, { addDocuments: 0, deltaBytes: bytes - doc.bytes, documentBytes: bytes });
    const revision = doc.revision + 1;
    this.sql.run(
      `UPDATE documents SET body = ?, bytes = ?, revision = ?, updated_at = ?, updated_by = ? WHERE brain_id = ? AND id = ?`,
      body,
      bytes,
      revision,
      this.now(),
      actorString(actor),
      brain.id,
      doc.id,
    );
    this.recordRevision(brain.id, doc.id, revision, "updated", doc.title, doc.description, body, summary, actor);
    return this.finishWrite(brain, doc.id, "document.updated", actor);
  }

  private finishWrite(brain: BrainRow, docId: string, type: string, actor: Actor): WriteResult {
    const doc = this.findDoc(brain.id, docId)!;
    const seq = this.appendEvent(brain.id, type, docId, doc.revision, actor);
    this.touch(brain.id);
    return { document: docSummary(doc), cursor: String(seq), warnings: this.softWarnings(brain.id, doc) };
  }

  private usage(brainId: string): { documents: number; bytes: number } {
    const row = one<{ documents: number; bytes: number | null }>(
      this.sql,
      `SELECT COUNT(*) AS documents, SUM(bytes) AS bytes FROM documents WHERE brain_id = ? AND deleted = 0`,
      brainId,
    )!;
    return { documents: row.documents, bytes: row.bytes ?? 0 };
  }

  private checkLimits(
    usage: { documents: number; bytes: number },
    change: { addDocuments: number; deltaBytes: number; documentBytes: number },
  ): void {
    const { limits } = this;
    if (change.documentBytes > limits.documentBytes) {
      throw new BrainError("limit_exceeded", "The document would exceed the per-document size limit. Consolidate or split it, then retry.", {
        limit: "documentBytes",
        maximum: limits.documentBytes,
        attempted: change.documentBytes,
      });
    }
    if (usage.documents + change.addDocuments > limits.brainDocuments) {
      throw new BrainError("limit_exceeded", "The brain already holds the maximum number of documents. Merge related documents, then retry.", {
        limit: "brainDocuments",
        maximum: limits.brainDocuments,
        current: usage.documents,
      });
    }
    if (usage.bytes + change.deltaBytes > limits.brainBytes) {
      throw new BrainError("limit_exceeded", "The brain would exceed its total size limit. Consolidate repeated material, then retry.", {
        limit: "brainBytes",
        maximum: limits.brainBytes,
        current: usage.bytes,
        attempted: usage.bytes + change.deltaBytes,
      });
    }
  }

  private softWarnings(brainId: string, doc: DocRow): string[] {
    const { limits } = this;
    const usage = this.usage(brainId);
    const warnings: string[] = [];
    if (doc.bytes >= limits.documentBytes * SOFT_LIMIT_RATIO) {
      warnings.push(`Document is ${doc.bytes} of ${limits.documentBytes} bytes. Consolidate repeated material before it reaches the limit.`);
    }
    if (usage.documents >= limits.brainDocuments * SOFT_LIMIT_RATIO) {
      warnings.push(`Brain has ${usage.documents} of ${limits.brainDocuments} documents. Merge related documents where the subject allows.`);
    }
    if (usage.bytes >= limits.brainBytes * SOFT_LIMIT_RATIO) {
      warnings.push(`Brain holds ${usage.bytes} of ${limits.brainBytes} bytes. Consolidate repeated material, keeping decisions and evidence.`);
    }
    return warnings;
  }

  private recordRevision(
    brainId: string,
    docId: string,
    revision: number,
    kind: string,
    title: string,
    description: string,
    body: string,
    summary: string | undefined,
    actor: Actor,
  ): void {
    this.sql.run(
      `INSERT INTO revisions (brain_id, document_id, revision, kind, title, description, body, summary, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      brainId,
      docId,
      revision,
      kind,
      title,
      description,
      body,
      summary?.trim().slice(0, 500) || null,
      actorString(actor),
      this.now(),
    );
    this.sql.run(
      `DELETE FROM revisions WHERE brain_id = ? AND document_id = ? AND revision <= ?`,
      brainId,
      docId,
      revision - this.limits.revisionsPerDocument,
    );
  }

  private appendEvent(brainId: string, type: string, docId: string | null, revision: number | null, actor: Actor): number {
    const seq = one<{ last_seq: number }>(this.sql, `SELECT last_seq FROM brains WHERE id = ?`, brainId)!.last_seq + 1;
    this.sql.run(`UPDATE brains SET last_seq = ? WHERE id = ?`, seq, brainId);
    this.sql.run(
      `INSERT INTO events (brain_id, seq, id, type, document_id, revision, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      brainId,
      seq,
      newOpaqueId(),
      type,
      docId,
      revision,
      actorString(actor),
      this.now(),
    );
    this.sql.run(`DELETE FROM events WHERE brain_id = ? AND seq <= ?`, brainId, seq - this.limits.eventsPerBrain);
    return seq;
  }

  private touch(brainId: string): void {
    this.sql.run(`UPDATE brains SET updated_at = ? WHERE id = ?`, this.now(), brainId);
  }

  private summary(row: BrainRow): BrainSummary {
    return {
      reference: formatReference(row.project_id, row.id),
      project: { name: row.project_name, token: row.project_id },
      title: row.title,
      description: row.description,
      status: row.status === "active" ? "active" : "closed",
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private index(row: BrainRow): BrainIndex {
    const docs = this.sql.all<DocRow>(
      `SELECT * FROM documents WHERE brain_id = ? AND deleted = 0 ORDER BY created_at, rowid`,
      row.id,
    );
    const usage = this.usage(row.id);
    return {
      ...this.summary(row),
      cursor: String(row.last_seq),
      documents: docs.map(docSummary),
      usage: {
        ...usage,
        limits: {
          documentBytes: this.limits.documentBytes,
          brainDocuments: this.limits.brainDocuments,
          brainBytes: this.limits.brainBytes,
        },
      },
    };
  }
}

export interface WriteResult {
  document: DocumentSummary | { id: string; revision: number; deleted: true };
  cursor: string;
  warnings: string[];
}

export interface BrainExport {
  format: "agentbrain-export/1";
  reference: string;
  project: { name: string; token: string };
  title: string | null;
  description: string | null;
  createdAt: string;
  exportedAt: string;
  finalCursor: string;
  documents: (DocumentSummary & { markdown: string })[];
}

export interface CloseResult {
  reference: string;
  status: "closed";
  closedAt: string;
  alreadyClosed: boolean;
  export: BrainExport | null;
}

function docSummary(d: DocRow): DocumentSummary {
  return { id: d.id, title: d.title, description: d.description, revision: d.revision, bytes: d.bytes, updatedAt: iso(d.updated_at) };
}

function cleanOptional(value: string | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}

function requireText(value: string, field: string, max: number): string {
  const v = value.trim();
  if (!v) throw new BrainError("invalid_request", `A ${field} is required.`);
  if (v.length > max) throw new BrainError("invalid_request", `The ${field} is limited to ${max} characters.`);
  return v;
}
