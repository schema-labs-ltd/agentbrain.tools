import { BrainError } from "./errors.js";
import { formatReference, newDocumentId, newOpaqueId, parseReference, type ParsedReference } from "./ids.js";
import { detectImage, extensionFor, IMAGE_TYPES } from "./images.js";
import { one, toBytes, type Sql, type SqlValue } from "./sql.js";

/** Errors for references and project tokens that exist but belong to another account. */
export const FORBIDDEN_BRAIN =
  "This brain belongs to another Agent Brain account. You are signed in to a different account, and brains cannot be shared between accounts.";
export const FORBIDDEN_PROJECT =
  "This project belongs to another Agent Brain account. You are signed in to a different account, and projects cannot be shared between accounts.";

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
  /** Maximum size of one image, in bytes. */
  imageBytes: number;
  /** Maximum number of live images in one brain. */
  brainImages: number;
  /** Maximum total size of all live images in one brain, in bytes. */
  brainImageBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  documentBytes: 64 * 1024,
  brainDocuments: 50,
  brainBytes: 1024 * 1024,
  revisionsPerDocument: 50,
  eventsPerBrain: 1000,
  imageBytes: 5 * 1024 * 1024,
  brainImages: 20,
  brainImageBytes: 25 * 1024 * 1024,
};

/** Image bytes are stored in chunks below the 2 MB Durable Object row limit. */
const IMAGE_CHUNK_BYTES = 1024 * 1024;
/** Upload and download links last this long. */
export const IMAGE_LINK_TTL_MS = 15 * 60 * 1000;

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

export interface ImageSummary {
  id: string;
  /** Public link to the image file. Anyone with it can view the image until it is deleted or the brain closed. */
  url: string;
  title: string;
  description: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  revision: number;
  updatedAt: string;
}

export interface BrainIndex extends BrainSummary {
  cursor: string;
  documents: DocumentSummary[];
  images: ImageSummary[];
  usage: {
    documents: number;
    bytes: number;
    images: number;
    imageBytes: number;
    limits: { documentBytes: number; brainDocuments: number; brainBytes: number; imageBytes: number; brainImages: number; brainImageBytes: number };
  };
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

type ImageRow = {
  brain_id: string;
  id: string;
  title: string;
  description: string;
  mime_type: string;
  bytes: number;
  public_token: string;
  width: number | null;
  height: number | null;
  revision: number;
  deleted: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
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
    /** Public base URL for image links, for example https://agentbrain.tools. Empty gives site-relative links. */
    private readonly publicBase: string = "",
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

  /**
   * When OWNER_EMAIL changes, move the existing owner account to the new email
   * instead of starting an empty one. The owner is the only password account not
   * linked to Clerk; with none or several, nothing changes. Returns true when moved.
   */
  moveOwnerEmail(email: string): boolean {
    const target = email.trim().toLowerCase();
    if (one(this.sql, `SELECT id FROM users WHERE email = ?`, target)) return false;
    const owners = this.sql.all<{ id: string }>(
      `SELECT id FROM users WHERE password_hash LIKE 'pbkdf2-sha256$%' AND clerk_user_id IS NULL LIMIT 2`,
    );
    if (owners.length !== 1) return false;
    this.sql.run(`UPDATE users SET email = ? WHERE id = ?`, target, owners[0]!.id);
    return true;
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
        `SELECT id, name FROM projects WHERE user_id = ? AND (name_key = ? OR id = ?) ORDER BY name_key = ? DESC LIMIT 1`,
        userId,
        key,
        key,
        key,
      );
      if (existing) {
        return { name: existing.name, token: existing.id, created: false, brains: this.listBrains(userId, existing.id) };
      }
      this.assertNotOthersProject(userId, key);
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
    if (!row) {
      this.assertNotOthersProject(userId, project.trim().toLowerCase());
      throw new BrainError("not_found", `No project named "${project.trim()}" exists. Open it first.`);
    }
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

  // ---------------------------------------------------------------- images

  /** Add an image. The bytes must be PNG, JPEG, GIF or WebP; the format is detected, not trusted. */
  createImage(
    actor: Actor,
    reference: string,
    input: { title: string; description?: string; data: Uint8Array },
  ): ImageWriteResult {
    return this.sql.transaction(() => this.insertImage(actor, this.loadActiveBrain(actor.userId, reference), input));
  }

  /** An image's metadata and bytes. */
  readImage(userId: string, reference: string, id: string): { image: ImageSummary & { updatedBy: { client: string; clientName: string | null } }; data: Uint8Array } {
    const brain = this.loadActiveBrain(userId, reference);
    const row = this.findImage(brain.id, id);
    if (!row) throw new BrainError("not_found", `Image ${id} does not exist in this brain (it may have been deleted).`);
    return { image: { ...this.imageSummary(row), updatedBy: parseActor(row.updated_by) }, data: this.imageBytes(brain.id, row) };
  }

  /** Change an image's title or description. The image itself never changes. Revision-checked. */
  updateImage(
    actor: Actor,
    reference: string,
    input: { id: string; baseRevision: number; title?: string; description?: string },
  ): ImageWriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const row = this.checkImageRevision(brain.id, input.id, input.baseRevision);
      const title = input.title !== undefined ? requireText(input.title, "title", 200) : row.title;
      const description = input.description !== undefined ? input.description.trim().slice(0, 1000) : row.description;
      const revision = row.revision + 1;
      this.sql.run(
        `UPDATE images SET title = ?, description = ?, revision = ?, updated_at = ?, updated_by = ? WHERE brain_id = ? AND id = ?`,
        title,
        description,
        revision,
        this.now(),
        actorString(actor),
        brain.id,
        row.id,
      );
      return this.finishImageWrite(brain, row.id, "image.updated", actor);
    });
  }

  /** Delete an image and its bytes. Revision-checked; the ID is never reused. */
  deleteImage(actor: Actor, reference: string, input: { id: string; baseRevision: number }): ImageWriteResult {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const row = this.checkImageRevision(brain.id, input.id, input.baseRevision);
      const revision = row.revision + 1;
      this.sql.run(
        `UPDATE images SET deleted = 1, bytes = 0, revision = ?, updated_at = ?, updated_by = ? WHERE brain_id = ? AND id = ?`,
        revision,
        this.now(),
        actorString(actor),
        brain.id,
        row.id,
      );
      this.sql.run(`DELETE FROM image_chunks WHERE brain_id = ? AND image_id = ?`, brain.id, row.id);
      this.sql.run(`DELETE FROM image_links WHERE brain_id = ? AND image_id = ?`, brain.id, row.id);
      const seq = this.appendEvent(brain.id, "image.deleted", row.id, revision, actor);
      this.touch(brain.id);
      return { image: { id: row.id, revision, deleted: true }, cursor: String(seq), warnings: [] };
    });
  }

  /**
   * Record a single-use upload link for a new image. The caller generates the
   * secret token and passes only its hash. Checks the image count limit early
   * so an agent does not upload into a full brain.
   */
  createUploadLink(actor: Actor, reference: string, tokenHash: string, input: { title: string; description?: string }): { expiresAt: string; maxBytes: number } {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(actor.userId, reference);
      const title = requireText(input.title, "title", 200);
      const usage = this.imageUsage(brain.id);
      this.checkImageLimits(usage, 0, true);
      this.purgeLinks();
      const expires = this.now() + IMAGE_LINK_TTL_MS;
      this.sql.run(
        `INSERT INTO image_links (token_hash, kind, user_id, brain_id, image_id, title, description, actor, expires_at) VALUES (?, 'upload', ?, ?, NULL, ?, ?, ?, ?)`,
        tokenHash,
        actor.userId,
        brain.id,
        title,
        (input.description ?? "").trim().slice(0, 1000),
        actorString(actor),
        expires,
      );
      return { expiresAt: iso(expires), maxBytes: this.limits.imageBytes };
    });
  }

  /**
   * Use an upload link. The link is spent only when the image is stored, so a
   * rejected file (wrong type, too large) can be fixed and sent again.
   */
  uploadWithLink(tokenHash: string, data: Uint8Array): ImageWriteResult & { reference: string } {
    return this.sql.transaction(() => {
      const link = this.liveLink(tokenHash, "upload");
      const stored = JSON.parse(link.actor) as { user: string; client: string; clientName: string | null };
      const actor: Actor = { userId: stored.user, clientId: stored.client, clientName: stored.clientName ?? undefined };
      const brain = this.loadBrain(link.user_id, { brainId: link.brain_id });
      if (brain.status !== "active") throw new BrainError("brain_closed", "This brain has been closed and its content deleted.");
      const result = this.insertImage(actor, brain, { title: link.title ?? "Untitled image", description: link.description ?? "", data });
      this.sql.run(`DELETE FROM image_links WHERE token_hash = ?`, tokenHash);
      return { ...result, reference: formatReference(brain.project_id, brain.id) };
    });
  }

  /** Record a download link for an existing image. Usable until it expires. */
  createDownloadLink(userId: string, reference: string, id: string, tokenHash: string): { expiresAt: string; image: ImageSummary } {
    return this.sql.transaction(() => {
      const brain = this.loadActiveBrain(userId, reference);
      const row = this.findImage(brain.id, id);
      if (!row) throw new BrainError("not_found", `Image ${id} does not exist in this brain (it may have been deleted).`);
      this.purgeLinks();
      const expires = this.now() + IMAGE_LINK_TTL_MS;
      this.sql.run(
        `INSERT INTO image_links (token_hash, kind, user_id, brain_id, image_id, title, description, actor, expires_at) VALUES (?, 'download', ?, ?, ?, NULL, NULL, '{}', ?)`,
        tokenHash,
        userId,
        brain.id,
        row.id,
        expires,
      );
      return { expiresAt: iso(expires), image: this.imageSummary(row) };
    });
  }

  /** Read an image through a download link. */
  downloadWithLink(tokenHash: string): { image: ImageSummary; data: Uint8Array } {
    const link = this.liveLink(tokenHash, "download");
    const brain = this.loadBrain(link.user_id, { brainId: link.brain_id });
    const row = brain.status === "active" && link.image_id ? this.findImage(brain.id, link.image_id) : undefined;
    if (!row) throw new BrainError("not_found", "This link has expired or the image no longer exists.");
    return { image: this.imageSummary(row), data: this.imageBytes(brain.id, row) };
  }

  /** Read an image by ID for the website, which authenticates the owner itself. */
  imageForWebsite(userId: string, reference: string, id: string): { image: ImageSummary; data: Uint8Array } {
    const { image, data } = this.readImage(userId, reference, id);
    return { image, data };
  }

  /**
   * Read an image by its public token, with no sign-in. Only live images in
   * active brains are served; anything else is indistinguishable from missing.
   */
  publicImage(token: string): { image: ImageSummary; data: Uint8Array } {
    const t = token.trim().toLowerCase();
    const row = /^[0-9a-z]{20,64}$/.test(t)
      ? one<ImageRow & { status: string }>(
          this.sql,
          `SELECT i.*, b.status FROM images i JOIN brains b ON b.id = i.brain_id WHERE i.public_token = ? AND i.deleted = 0`,
          t,
        )
      : undefined;
    if (!row || row.status !== "active") throw new BrainError("not_found", "No image is available at this address.");
    return { image: this.imageSummary(row), data: this.imageBytes(row.brain_id, row) };
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
    events: ChangeEvent[];
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
        ...subjectOf(r.type, r.document_id),
        revision: r.revision,
        ...parseActor(r.actor),
        at: iso(r.created_at),
      })),
    };
  }

  /** Resolve an active brain the user owns, for event subscriptions. Throws like any other read. */
  resolveActiveBrain(userId: string, reference: string): { id: string; reference: string; lastSeq: number } {
    const brain = this.loadActiveBrain(userId, reference);
    return { id: brain.id, reference: formatReference(brain.project_id, brain.id), lastSeq: brain.last_seq };
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
      this.sql.run(`DELETE FROM images WHERE brain_id = ?`, brain.id);
      this.sql.run(`DELETE FROM image_chunks WHERE brain_id = ?`, brain.id);
      this.sql.run(`DELETE FROM image_links WHERE brain_id = ?`, brain.id);
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
      images: this.liveImages(brain.id).map((r) => this.imageSummary(r)),
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

  // ---------------------------------------------------------------- website (read-only)

  /** Every project with brain counts and last activity, newest activity first. */
  projectsOverview(userId: string): ProjectOverview[] {
    return this.sql
      .all<{ id: string; name: string; created_at: number; active: number; closed: number; last: number | null }>(
        `SELECT p.id, p.name, p.created_at,
           (SELECT COUNT(*) FROM brains b WHERE b.project_id = p.id AND b.status = 'active') AS active,
           (SELECT COUNT(*) FROM brains b WHERE b.project_id = p.id AND b.status <> 'active') AS closed,
           (SELECT MAX(b.updated_at) FROM brains b WHERE b.project_id = p.id) AS last
         FROM projects p WHERE p.user_id = ?
         ORDER BY COALESCE(last, p.created_at) DESC, p.name`,
        userId,
      )
      .map((r) => ({
        name: r.name,
        token: r.id,
        activeBrains: r.active,
        closedBrains: r.closed,
        createdAt: iso(r.created_at),
        lastActivityAt: iso(r.last ?? r.created_at),
      }));
  }

  /** One project and all its brains, active and closed. Missing and other users' projects are not found. */
  projectWithBrains(userId: string, token: string): { project: ProjectOverview; brains: BrainListing[] } {
    const project = this.projectsOverview(userId).find((p) => p.token === token.trim().toLowerCase());
    if (!project) {
      this.assertNotOthersProject(userId, token.trim().toLowerCase());
      throw new BrainError("not_found", "No project with that token is available to you.");
    }
    const rows = this.sql.all<BrainRow & { docs: number; bytes: number }>(
      `SELECT b.*, p.name AS project_name,
         (SELECT COUNT(*) FROM documents d WHERE d.brain_id = b.id AND d.deleted = 0) AS docs,
         (SELECT COALESCE(SUM(d.bytes), 0) FROM documents d WHERE d.brain_id = b.id AND d.deleted = 0) AS bytes
       FROM brains b JOIN projects p ON p.id = b.project_id
       WHERE b.user_id = ? AND b.project_id = ?
       ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END, b.updated_at DESC`,
      userId,
      project.token,
    );
    return {
      project,
      brains: rows.map((r) => ({ ...this.summary(r), closedAt: r.closed_at ? iso(r.closed_at) : null, documents: r.docs, bytes: r.bytes })),
    };
  }

  /** A brain's summary whether or not it is closed. Closed brains have no content left to show. */
  describeBrain(userId: string, reference: string): BrainSummary & { closedAt: string | null } {
    const row = this.loadBrain(userId, this.requireReference(reference));
    return { ...this.summary(row), closedAt: row.closed_at ? iso(row.closed_at) : null };
  }

  /** The latest events of an active brain, newest first, with document titles where the document still exists. */
  recentActivity(userId: string, reference: string, limit = 20): ActivityItem[] {
    const brain = this.loadActiveBrain(userId, reference);
    return this.sql
      .all<{ seq: number; type: string; document_id: string | null; revision: number | null; actor: string; created_at: number; title: string | null; deleted: number | null }>(
        `SELECT e.seq, e.type, e.document_id, e.revision, e.actor, e.created_at,
           CASE WHEN e.type LIKE 'image.%' THEN i.title ELSE d.title END AS title,
           CASE WHEN e.type LIKE 'image.%' THEN i.deleted ELSE d.deleted END AS deleted
         FROM events e
         LEFT JOIN documents d ON d.brain_id = e.brain_id AND d.id = e.document_id
         LEFT JOIN images i ON i.brain_id = e.brain_id AND i.id = e.document_id
         WHERE e.brain_id = ? ORDER BY e.seq DESC LIMIT ?`,
        brain.id,
        Math.min(Math.max(limit, 1), 100),
      )
      .map((r) => ({
        seq: r.seq,
        type: r.type,
        documentId: r.type.startsWith("image.") ? null : r.document_id,
        documentTitle: r.type.startsWith("image.") || r.deleted ? null : r.title,
        imageId: r.type.startsWith("image.") ? r.document_id : null,
        imageTitle: r.type.startsWith("image.") && !r.deleted ? r.title : null,
        revision: r.revision,
        ...parseActor(r.actor),
        at: iso(r.created_at),
      }));
  }

  // ---------------------------------------------------------------- internals

  private requireReference(reference: string): ParsedReference {
    const parsed = parseReference(reference);
    if (!parsed) {
      throw new BrainError("invalid_request", 'That is not a valid reference. Expected "agentBrain:<project>.<task>", two 26-character identifiers joined by a dot.');
    }
    return parsed;
  }

  /** Throw forbidden when a project token belongs to another account. */
  private assertNotOthersProject(userId: string, token: string): void {
    const other = one<{ user_id: string }>(this.sql, `SELECT user_id FROM projects WHERE id = ?`, token);
    if (other && other.user_id !== userId) {
      throw new BrainError("forbidden", FORBIDDEN_PROJECT);
    }
  }

  /** Load a brain the user owns. Another account's brain is forbidden; a missing one is not found. */
  private loadBrain(userId: string, ref: ParsedReference): BrainRow {
    const row = one<BrainRow>(
      this.sql,
      `SELECT b.*, p.name AS project_name FROM brains b JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND b.user_id = ?`,
      ref.brainId,
      userId,
    );
    // The project part must match too, so a reference cannot be re-pointed at another project.
    if (!row || (ref.projectId && row.project_id !== ref.projectId)) {
      const other = one<{ user_id: string; project_id: string }>(this.sql, `SELECT user_id, project_id FROM brains WHERE id = ?`, ref.brainId);
      if (other && other.user_id !== userId && (!ref.projectId || other.project_id === ref.projectId)) {
        throw new BrainError("forbidden", FORBIDDEN_BRAIN);
      }
      throw new BrainError("not_found", "No brain with that reference is available to you.");
    }
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

  private imageSummary(r: ImageRow): ImageSummary {
    return toImageSummary(r, `${this.publicBase}/i/${r.public_token}.${extensionFor(r.mime_type)}`);
  }

  private insertImage(actor: Actor, brain: BrainRow, input: { title: string; description?: string; data: Uint8Array }): ImageWriteResult {
    const title = requireText(input.title, "title", 200);
    const description = (input.description ?? "").trim().slice(0, 1000);
    const data = input.data;
    if (data.length === 0) throw new BrainError("invalid_request", "The image is empty.");
    const info = detectImage(data);
    if (!info) {
      throw new BrainError("unsupported_image", `The file is not a supported image. Upload one of: ${IMAGE_TYPES.join(", ")}. SVG is not accepted.`, {
        supported: IMAGE_TYPES,
      });
    }
    if (data.length > this.limits.imageBytes) {
      throw new BrainError("limit_exceeded", "The image exceeds the per-image size limit. Resize or compress it, then retry.", {
        limit: "imageBytes",
        maximum: this.limits.imageBytes,
        attempted: data.length,
      });
    }
    this.checkImageLimits(this.imageUsage(brain.id), data.length, true);
    const id = newDocumentId();
    const now = this.now();
    this.sql.run(
      `INSERT INTO images (brain_id, id, title, description, mime_type, bytes, public_token, width, height, revision, deleted, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      brain.id,
      id,
      title,
      description,
      info.mimeType,
      data.length,
      newOpaqueId(),
      info.width,
      info.height,
      now,
      now,
      actorString(actor),
    );
    for (let i = 0, idx = 0; i < data.length; i += IMAGE_CHUNK_BYTES, idx++) {
      this.sql.run(
        `INSERT INTO image_chunks (brain_id, image_id, idx, data) VALUES (?, ?, ?, ?)`,
        brain.id,
        id,
        idx,
        data.subarray(i, Math.min(i + IMAGE_CHUNK_BYTES, data.length)),
      );
    }
    return this.finishImageWrite(brain, id, "image.created", actor);
  }

  private finishImageWrite(brain: BrainRow, id: string, type: string, actor: Actor): ImageWriteResult {
    const row = this.findImage(brain.id, id)!;
    const seq = this.appendEvent(brain.id, type, id, row.revision, actor);
    this.touch(brain.id);
    return { image: this.imageSummary(row), cursor: String(seq), warnings: this.imageWarnings(brain.id) };
  }

  private liveImages(brainId: string): ImageRow[] {
    return this.sql.all<ImageRow>(`SELECT * FROM images WHERE brain_id = ? AND deleted = 0 ORDER BY created_at, rowid`, brainId);
  }

  private findImage(brainId: string, id: string): ImageRow | undefined {
    return one<ImageRow>(this.sql, `SELECT * FROM images WHERE brain_id = ? AND id = ? AND deleted = 0`, brainId, id);
  }

  private imageBytes(brainId: string, row: ImageRow): Uint8Array {
    const chunks = this.sql
      .all<{ data: SqlValue }>(`SELECT data FROM image_chunks WHERE brain_id = ? AND image_id = ? ORDER BY idx`, brainId, row.id)
      .map((c) => toBytes(c.data));
    const out = new Uint8Array(row.bytes);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    if (offset !== row.bytes) throw new Error(`Image ${row.id} is incomplete in storage.`);
    return out;
  }

  private checkImageRevision(brainId: string, id: string, baseRevision: number): ImageRow {
    const row = this.findImage(brainId, id);
    if (!row) throw new BrainError("not_found", `Image ${id} does not exist in this brain (it may have been deleted).`);
    if (row.revision !== baseRevision) {
      throw new BrainError(
        "conflict",
        `Image ${id} has changed since revision ${baseRevision}. Check the current details below, reapply your change and retry with baseRevision ${row.revision}.`,
        { current: { ...this.imageSummary(row), updatedBy: parseActor(row.updated_by) } },
      );
    }
    return row;
  }

  private imageUsage(brainId: string): { images: number; bytes: number } {
    const row = one<{ images: number; bytes: number | null }>(
      this.sql,
      `SELECT COUNT(*) AS images, SUM(bytes) AS bytes FROM images WHERE brain_id = ? AND deleted = 0`,
      brainId,
    )!;
    return { images: row.images, bytes: row.bytes ?? 0 };
  }

  private checkImageLimits(usage: { images: number; bytes: number }, addBytes: number, addImage: boolean): void {
    const { limits } = this;
    if (addImage && usage.images + 1 > limits.brainImages) {
      throw new BrainError("limit_exceeded", "The brain already holds the maximum number of images. Delete images that are no longer needed, then retry.", {
        limit: "brainImages",
        maximum: limits.brainImages,
        current: usage.images,
      });
    }
    if (usage.bytes + addBytes > limits.brainImageBytes) {
      throw new BrainError("limit_exceeded", "The brain would exceed its total image size limit. Delete or compress images, then retry.", {
        limit: "brainImageBytes",
        maximum: limits.brainImageBytes,
        current: usage.bytes,
        attempted: usage.bytes + addBytes,
      });
    }
  }

  private imageWarnings(brainId: string): string[] {
    const { limits } = this;
    const usage = this.imageUsage(brainId);
    const warnings: string[] = [];
    if (usage.images >= limits.brainImages * SOFT_LIMIT_RATIO) {
      warnings.push(`Brain has ${usage.images} of ${limits.brainImages} images. Delete images that no longer carry anything the documents need.`);
    }
    if (usage.bytes >= limits.brainImageBytes * SOFT_LIMIT_RATIO) {
      warnings.push(`Brain holds ${usage.bytes} of ${limits.brainImageBytes} image bytes. Delete or compress images before adding more.`);
    }
    return warnings;
  }

  private liveLink(tokenHash: string, kind: "upload" | "download"): { user_id: string; brain_id: string; image_id: string | null; title: string | null; description: string | null; actor: string } {
    const link = one<{ kind: string; user_id: string; brain_id: string; image_id: string | null; title: string | null; description: string | null; actor: string; expires_at: number }>(
      this.sql,
      `SELECT * FROM image_links WHERE token_hash = ?`,
      tokenHash,
    );
    if (!link || link.kind !== kind || link.expires_at <= this.now()) {
      throw new BrainError("not_found", `This ${kind} link is invalid, already used or expired. Ask for a new one.`);
    }
    return link;
  }

  private purgeLinks(): void {
    this.sql.run(`DELETE FROM image_links WHERE expires_at <= ?`, this.now());
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
    const images = this.imageUsage(row.id);
    return {
      ...this.summary(row),
      cursor: String(row.last_seq),
      documents: docs.map(docSummary),
      images: this.liveImages(row.id).map((r) => this.imageSummary(r)),
      usage: {
        ...usage,
        images: images.images,
        imageBytes: images.bytes,
        limits: {
          documentBytes: this.limits.documentBytes,
          brainDocuments: this.limits.brainDocuments,
          brainBytes: this.limits.brainBytes,
          imageBytes: this.limits.imageBytes,
          brainImages: this.limits.brainImages,
          brainImageBytes: this.limits.brainImageBytes,
        },
      },
    };
  }
}

export interface ProjectOverview {
  name: string;
  token: string;
  activeBrains: number;
  closedBrains: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface BrainListing extends BrainSummary {
  closedAt: string | null;
  documents: number;
  bytes: number;
}

export interface ActivityItem {
  seq: number;
  type: string;
  documentId: string | null;
  documentTitle: string | null;
  imageId: string | null;
  imageTitle: string | null;
  revision: number | null;
  client: string;
  clientName: string | null;
  at: string;
}

export interface ChangeEvent {
  id: string;
  seq: number;
  type: string;
  /** The document an event is about, for document.* events. */
  documentId: string | null;
  /** The image an event is about, for image.* events. */
  imageId: string | null;
  revision: number | null;
  client: string;
  clientName: string | null;
  at: string;
}

export interface ImageWriteResult {
  image: ImageSummary | { id: string; revision: number; deleted: true };
  cursor: string;
  warnings: string[];
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
  /** Image metadata only. The bytes are not included in an inline export. */
  images: ImageSummary[];
}

export interface CloseResult {
  reference: string;
  status: "closed";
  closedAt: string;
  alreadyClosed: boolean;
  export: BrainExport | null;
}

/** Image events keep the image ID in the events table's document_id column. */
function subjectOf(type: string, id: string | null): { documentId: string | null; imageId: string | null } {
  return type.startsWith("image.") ? { documentId: null, imageId: id } : { documentId: id, imageId: null };
}

function toImageSummary(r: ImageRow, url: string): ImageSummary {
  return {
    id: r.id,
    url,
    title: r.title,
    description: r.description,
    mimeType: r.mime_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    revision: r.revision,
    updatedAt: iso(r.updated_at),
  };
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
