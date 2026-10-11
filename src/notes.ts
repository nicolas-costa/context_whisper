import type { DatabaseAdapter, Note, NoteLink, SearchResult } from './db.js';
import type { Account } from './db/adapters/interface.js';
import * as embeds from './embeds.js';
import { detectContext, type DetectedContext } from './context-detector.js';
import {
  assertAccountWorkspace,
  assertCanApprove,
  assertCanPurge,
  reviewStatusForUpsert,
} from './accounts.js';

export interface UpsertNoteParams {
  workspace?: string;
  project?: string;
  topic: string;
  subtopic?: string | null;
  tags?: string[];
  body_md: string;
  created_by?: string | null;
  review_status?: 'DRAFT' | 'APPROVED';
  repo_url?: string | null;
  links?: Array<Partial<NoteLink>>;
}

export interface UpsertNoteResult {
  note_id: number;
  context: DetectedContext;
}

export interface GetNoteParams {
  workspace?: string;
  project?: string;
  topic: string;
  subtopic?: string | null;
}

export interface GetNoteResult {
  note: (Note & { links?: NoteLink[] }) | null;
  context: DetectedContext;
}

export interface SearchNotesParams {
  workspace?: string;
  query: string;
  project?: string | null;
  top_k?: number;
  tags?: string[];
  review_status?: string | null;
  repo_url?: string | null;
  global?: boolean;
}

export interface SearchNotesResult {
  notes: SearchResult[];
  context: DetectedContext;
}

export interface ListTopicsParams {
  workspace?: string;
  project?: string;
  repo_url?: string | null;
}

export interface ListTopicsResult {
  topics: Array<{ topic: string; subtopic: string | null }>;
  context: DetectedContext;
}

export interface DeleteNoteParams {
  workspace?: string;
  project?: string;
  topic: string;
  subtopic?: string | null;
}

export interface DeleteNoteResult {
  deleted: boolean;
  context: DetectedContext;
  vector_deleted?: boolean;
  warnings?: string[];
}

export interface UpdateNoteMetaParams {
  note_id: number;
  topic: string;
  subtopic?: string | null;
  review_status: 'DRAFT' | 'APPROVED';
  workspace?: string;
  project?: string;
}

export interface UpdateNoteMetaResult {
  note: Note | null;
  context: DetectedContext;
}

/**
 * Parse markdown to extract code links
 * Format: [text](code:path/to/file.ext:start-end)
 */
function parseCodeLinksFromMarkdown(bodyMd: string): Array<Partial<NoteLink>> {
  const links: Array<Partial<NoteLink>> = [];
  const lines = bodyMd.split('\n');

  const linkRegex = /\[([^\]]+)\]\(code:([^:\)]+)(?::(\d+)-(\d+))?((?::[^:\)]+)*)\)/g;

  lines.forEach((line, lineIndex) => {
    let match;
    linkRegex.lastIndex = 0;

    while ((match = linkRegex.exec(line)) !== null) {
      const [fullMatch, text, path, startStr, endStr, extraParams] = match;

      const link: Partial<NoteLink> = {
        path: path,
        markdown_context: line.trim(),
        markdown_line: lineIndex + 1,
      };

      if (startStr) link.line_start = parseInt(startStr, 10);
      if (endStr) link.line_end = parseInt(endStr, 10);

      if (extraParams) {
        const params = extraParams.split(':').filter(Boolean);
        params.forEach((param) => {
          if (param.startsWith('symbol=')) {
            link.symbol = param.replace('symbol=', '');
          } else if (param.startsWith('commit=')) {
            link.commit_sha = param.replace('commit=', '');
          }
        });
      }

      links.push(link);
    }
  });

  return links;
}

/**
 * Upsert a note: creates or updates note, generates embedding, and stores vector
 */
export async function upsertNote(
  adapter: DatabaseAdapter,
  params: UpsertNoteParams,
  cwd?: string,
  account?: Account | null
): Promise<UpsertNoteResult> {
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  assertAccountWorkspace(account ?? null, context.workspace);
  const reviewStatus = reviewStatusForUpsert(account ?? null, params.review_status);

  const tagsJson = params.tags && params.tags.length > 0 ? JSON.stringify(params.tags) : null;

  const embedding = await embeds.embed(params.body_md);

  const markdownLinks = parseCodeLinksFromMarkdown(params.body_md);
  const allLinks = [...markdownLinks, ...(params.links || [])];

  // Upsert note
  const noteId = await adapter.relational.upsertNote({
    workspace: context.workspace,
    project: context.project,
    topic: params.topic,
    subtopic: params.subtopic || null,
    tagsJson,
    bodyMd: params.body_md,
    createdBy: account?.name || params.created_by || null,
    reviewStatus,
    repoUrl: context.repo_url ?? undefined,
    repoFingerprint: context.repo_fingerprint ?? undefined,
    repoProvider: context.repo_provider ?? undefined,
    repoOwner: context.repo_owner ?? undefined,
    repoName: context.repo_name ?? undefined,
  });

  // Upsert vector
  await adapter.vector.upsertVector(noteId, embedding);

  // Upsert links
  if (allLinks.length > 0) {
    await adapter.relational.upsertNoteLinks(noteId, allLinks);
  }

  // Update repo_paths if we have fingerprint
  if (context.repo_fingerprint && cwd) {
    await adapter.relational.upsertRepoPath(context.repo_fingerprint, cwd);
  }

  return {
    note_id: noteId,
    context,
  };
}

/**
 * Get a note by its unique key
 */
export async function getNote(
  adapter: DatabaseAdapter,
  params: GetNoteParams,
  cwd?: string,
  account?: Account | null
): Promise<GetNoteResult> {
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );

  assertAccountWorkspace(account ?? null, context.workspace);

  const note = await adapter.relational.getNote(
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );

  if (note) {
    const links = await adapter.relational.getNoteLinks(note.note_id);
    return {
      note: { ...note, links },
      context,
    };
  }

  return { note: null, context };
}

/**
 * Search notes using semantic similarity
 */
export async function searchNotes(
  adapter: DatabaseAdapter,
  params: SearchNotesParams,
  cwd?: string,
  account?: Account | null
): Promise<SearchNotesResult> {
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project || undefined,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  const queryEmbedding = await embeds.embed(params.query);

  if (params.global && account?.workspaces && account.workspaces.length > 0) {
    throw new Error(
      `Account '${account.name}' cannot search across workspaces. Allowed: ${account.workspaces.join(', ')}`
    );
  }
  if (!params.global) {
    assertAccountWorkspace(account ?? null, context.workspace);
  }

  const repoFingerprint = params.global ? undefined : (context.repo_fingerprint ?? undefined);
  const repoUrl = params.global ? undefined : (params.repo_url ?? context.repo_url ?? undefined);
  const workspace = params.global ? null : context.workspace;
  const project = params.global ? null : params.project || context.project || null;

  const results = await adapter.searchNotes(queryEmbedding, {
    workspace,
    project,
    topK: params.top_k || 5,
    tags: params.tags || null,
    reviewStatus: params.review_status ?? (account ? 'APPROVED' : null),
    repoFingerprint,
    repoUrl,
  });

  return {
    notes: results,
    context,
  };
}

/**
 * List all topics for a workspace/project
 */
export async function listTopics(
  adapter: DatabaseAdapter,
  params: ListTopicsParams,
  cwd?: string,
  account?: Account | null
): Promise<ListTopicsResult> {
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  assertAccountWorkspace(account ?? null, context.workspace);

  const topics = await adapter.relational.listTopics(context.workspace, context.project);

  return {
    topics,
    context,
  };
}

/**
 * Delete a note and all its associated data
 */
export async function deleteNote(
  adapter: DatabaseAdapter,
  params: DeleteNoteParams,
  cwd?: string,
  account?: Account | null
): Promise<DeleteNoteResult> {
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );

  assertAccountWorkspace(account ?? null, context.workspace);

  // Fetch note first so we can delete vectors even when vectors live outside the relational DB (e.g., Qdrant).
  const existing = await adapter.relational.getNote(
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );

  if (!existing) {
    return { deleted: false, context };
  }

  const warnings: string[] = [];

  const isPermissionDenied = (err: any): boolean => {
    const code = err?.code ? String(err.code) : '';
    const msg = err?.message ? String(err.message) : String(err);

    // Postgres: insufficient_privilege = 42501
    if (code === '42501') return true;

    // MySQL common permission errors (best-effort)
    if (
      code.includes('ACCESS_DENIED') ||
      code.includes('ER_TABLEACCESS_DENIED') ||
      code.includes('ER_DBACCESS_DENIED')
    ) {
      return true;
    }

    // Generic messages
    if (
      /permission denied/i.test(msg) ||
      /not authorized/i.test(msg) ||
      /insufficient privilege/i.test(msg)
    ) {
      return true;
    }
    // Qdrant may encode status in message
    if (msg.includes('Qdrant API error (401)') || msg.includes('Qdrant API error (403)')) {
      return true;
    }

    return false;
  };

  // Step 1: delete the relational note (authoritative source of truth)
  let deleted: boolean;
  try {
    deleted = await adapter.relational.deleteNote(
      context.workspace,
      context.project,
      params.topic,
      params.subtopic
    );
  } catch (err: any) {
    if (isPermissionDenied(err)) {
      throw new Error(
        `Delete not permitted by relational database credentials for environment '${adapter.environmentName}'.`
      );
    }
    throw err;
  }

  if (!deleted) {
    return { deleted: false, context };
  }

  // Step 2: best-effort delete vector (required for external stores like Qdrant)
  try {
    await adapter.vector.deleteVector(existing.note_id);
    return { deleted: true, context, vector_deleted: true };
  } catch (err: any) {
    if (isPermissionDenied(err)) {
      warnings.push(
        `Vector delete not permitted by vector store credentials for environment '${adapter.environmentName}'. ` +
        `The note was deleted from the relational database but the vector may remain orphaned.`
      );
      return { deleted: true, context, vector_deleted: false, warnings };
    }
    // Non-permission error: surface but keep deletion result (note already deleted).
    warnings.push(
      `Vector delete failed after relational delete: ${err?.message ? String(err.message) : String(err)}`
    );
    return { deleted: true, context, vector_deleted: false, warnings };
  }

  return {
    deleted,
    context,
  };
}

/**
 * Update note metadata by note_id
 */
export async function updateNoteMeta(
  adapter: DatabaseAdapter,
  params: UpdateNoteMetaParams,
  cwd?: string,
  account?: Account | null
): Promise<UpdateNoteMetaResult> {
  if (params.review_status === 'APPROVED') {
    assertCanApprove(account ?? null);
  }
  const existing = await adapter.relational.getNoteById(params.note_id);
  if (!existing) {
    const context = detectContext(
      {
        workspace: params.workspace,
        project: params.project,
      },
      cwd
    );
    return { note: null, context };
  }

  assertAccountWorkspace(account ?? null, existing.workspace);

  if (params.workspace && existing.workspace !== params.workspace) {
    const context = detectContext(
      {
        workspace: existing.workspace,
        project: existing.project,
        repo_url: existing.repo_url ?? undefined,
      },
      cwd
    );
    return { note: null, context };
  }
  if (params.project && existing.project !== params.project) {
    const context = detectContext(
      {
        workspace: existing.workspace,
        project: existing.project,
        repo_url: existing.repo_url ?? undefined,
      },
      cwd
    );
    return { note: null, context };
  }

  const updated = await adapter.relational.updateNoteMeta(
    params.note_id,
    params.topic,
    params.subtopic ?? null,
    params.review_status
  );

  const context = detectContext(
    {
      workspace: updated?.workspace ?? existing.workspace,
      project: updated?.project ?? existing.project,
      repo_url: updated?.repo_url ?? existing.repo_url ?? undefined,
    },
    cwd
  );

  return { note: updated, context };
}

export async function approveNote(
  adapter: DatabaseAdapter,
  params: DeleteNoteParams,
  cwd?: string,
  account?: Account | null
): Promise<{ note: Note | null; context: DetectedContext }> {
  assertCanApprove(account ?? null);
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );
  assertAccountWorkspace(account ?? null, context.workspace);
  const existing = await adapter.relational.getNote(
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );
  if (!existing) return { note: null, context };
  const note = await adapter.relational.approveNote(existing.note_id);
  return { note, context };
}

export async function purgeNote(
  adapter: DatabaseAdapter,
  params: DeleteNoteParams,
  cwd?: string,
  account?: Account | null
): Promise<DeleteNoteResult> {
  assertCanPurge(account ?? null);
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );
  assertAccountWorkspace(account ?? null, context.workspace);
  const deleted = await adapter.relational.purgeNote(
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );
  return { deleted, context };
}
