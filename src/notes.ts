import type Database from 'better-sqlite3';
import * as db from './db.js';
import * as embeds from './embeds.js';
import type { Note, NoteLink, SearchResult } from './db.js';
import { detectContext, type DetectedContext } from './context-detector.js';

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

export interface GetNoteByIdParams {
  workspace?: string;
  project?: string;
  repo_url?: string | null;
  note_id: number;
}

export interface GetNoteByIdResult {
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
}

export interface UpdateNoteMetaParams {
  note_id: number;
  topic: string;
  subtopic?: string | null;
  review_status: 'DRAFT' | 'APPROVED';
  // Optional safety: if provided, we verify the note matches this scope
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
 * Optional params: symbol=name, commit=sha
 */
function parseCodeLinksFromMarkdown(bodyMd: string): Array<Partial<NoteLink>> {
  const links: Array<Partial<NoteLink>> = [];
  const lines = bodyMd.split('\n');
  
  // Regex for [text](code:path:lines) format
  // Capture groups:
  // 1: text
  // 2: path
  // 3: start line (optional)
  // 4: end line (optional)
  // 5: extra params (optional, e.g., :symbol=foo:commit=bar)
  const linkRegex = /\[([^\]]+)\]\(code:([^:\)]+)(?::(\d+)-(\d+))?((?::[^:\)]+)*)\)/g;

  lines.forEach((line, lineIndex) => {
    let match;
    // Reset lastIndex for each line as we're reusing the regex object in a loop? 
    // No, we create a new match loop per line, but linkRegex is global stateful if reused.
    // Better to re-instantiate or reset lastIndex.
    linkRegex.lastIndex = 0;
    
    while ((match = linkRegex.exec(line)) !== null) {
      const [fullMatch, text, path, startStr, endStr, extraParams] = match;
      
      const link: Partial<NoteLink> = {
        path: path,
        markdown_context: line.trim(),
        markdown_line: lineIndex + 1, // 1-based line number
      };

      if (startStr) link.line_start = parseInt(startStr, 10);
      if (endStr) link.line_end = parseInt(endStr, 10);

      // Parse extra params
      if (extraParams) {
        const params = extraParams.split(':').filter(Boolean);
        params.forEach(param => {
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
 * Auto-detects context if workspace/project not provided
 */
export async function upsertNote(
  database: Database.Database,
  params: UpsertNoteParams,
  cwd?: string
): Promise<UpsertNoteResult> {
  // Detect context automatically
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  // Use detected or provided repo_url
  const repoUrl = params.repo_url || context.repo_url;

  // Convert tags array to JSON string
  const tagsJson = params.tags && params.tags.length > 0 
    ? JSON.stringify(params.tags) 
    : null;

  // Generate embedding from body_md
  const embedding = await embeds.embed(params.body_md);

  // Extract links from markdown
  const markdownLinks = parseCodeLinksFromMarkdown(params.body_md);
  
  // Merge with explicit links provided in params
  // Explicit links take precedence if valid, but we usually just append them
  // We'll combine both arrays
  const allLinks = [...markdownLinks, ...(params.links || [])];

  // Execute upsert in transaction
  const result = database.transaction(() => {
    // Upsert note with repo metadata
    const noteId = db.upsertNote(
      database,
      context.workspace,
      context.project,
      params.topic,
      params.subtopic || null,
      tagsJson,
      params.body_md,
      params.created_by || null,
      params.review_status || 'DRAFT',
      context.repo_url ?? undefined,
      context.repo_fingerprint ?? undefined,
      context.repo_provider ?? undefined,
      context.repo_owner ?? undefined,
      context.repo_name ?? undefined
    );

    // Upsert vector
    db.upsertVector(database, noteId, embedding);

    // Upsert combined links
    if (allLinks.length > 0) {
      db.upsertNoteLinks(database, noteId, allLinks);
    }

    // Update repo_paths if we have fingerprint
    if (context.repo_fingerprint && cwd) {
      db.upsertRepoPath(database, context.repo_fingerprint, cwd);
    }

    return { note_id: noteId };
  })();

  return {
    note_id: result.note_id,
    context,
  };
}

/**
 * Get a note by its unique key
 * Auto-detects context if workspace/project not provided
 */
export function getNote(
  database: Database.Database,
  params: GetNoteParams,
  cwd?: string
): GetNoteResult {
  // Detect context automatically
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );

  const note = db.getNote(
    database,
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );

  if (note) {
    // Fetch associated links
    const links = db.getNoteLinks(database, note.note_id);
    return { 
      note: { ...note, links }, 
      context 
    };
  }

  return { note: null, context };
}

/**
 * Get a note by its numeric ID, scoped to a workspace/project (and optionally repo_url) for safety.
 * This prevents callers from exfiltrating notes from other repositories just by guessing IDs.
 */
export function getNoteById(
  database: Database.Database,
  params: GetNoteByIdParams,
  cwd?: string
): GetNoteByIdResult {
  const note = db.getNoteById(database, params.note_id);
  if (!note) {
    // We cannot safely "detect" here without repo_url; return a minimal, explicit context.
    return {
      note: null,
      context: {
        workspace: params.workspace ?? 'unknown',
        project: params.project ?? 'unknown',
        repo_url: params.repo_url ?? undefined,
        confidence: 0.3,
        inferred: true,
        source: 'default',
      },
    };
  }

  // Optional scoping: if caller provides scope, enforce it.
  if (params.workspace && note.workspace !== params.workspace) {
    return {
      note: null,
      context: {
        workspace: note.workspace,
        project: note.project,
        repo_url: note.repo_url ?? undefined,
        repo_provider: note.repo_provider ?? undefined,
        repo_owner: note.repo_owner ?? undefined,
        repo_name: note.repo_name ?? undefined,
        repo_fingerprint: note.repo_fingerprint ?? undefined,
        confidence: 1.0,
        inferred: false,
        source: 'payload',
      },
    };
  }
  if (params.project && note.project !== params.project) {
    return {
      note: null,
      context: {
        workspace: note.workspace,
        project: note.project,
        repo_url: note.repo_url ?? undefined,
        repo_provider: note.repo_provider ?? undefined,
        repo_owner: note.repo_owner ?? undefined,
        repo_name: note.repo_name ?? undefined,
        repo_fingerprint: note.repo_fingerprint ?? undefined,
        confidence: 1.0,
        inferred: false,
        source: 'payload',
      },
    };
  }
  if (params.repo_url && note.repo_url && note.repo_url !== params.repo_url) {
    return {
      note: null,
      context: {
        workspace: note.workspace,
        project: note.project,
        repo_url: note.repo_url ?? undefined,
        repo_provider: note.repo_provider ?? undefined,
        repo_owner: note.repo_owner ?? undefined,
        repo_name: note.repo_name ?? undefined,
        repo_fingerprint: note.repo_fingerprint ?? undefined,
        confidence: 1.0,
        inferred: false,
        source: 'payload',
      },
    };
  }

  const links = db.getNoteLinks(database, note.note_id);
  return {
    note: { ...note, links },
    context: {
      workspace: note.workspace,
      project: note.project,
      repo_url: note.repo_url ?? undefined,
      repo_provider: note.repo_provider ?? undefined,
      repo_owner: note.repo_owner ?? undefined,
      repo_name: note.repo_name ?? undefined,
      repo_fingerprint: note.repo_fingerprint ?? undefined,
      confidence: 1.0,
      inferred: false,
      source: 'payload',
    },
  };
}

/**
 * Search notes using semantic similarity
 * Auto-detects context if workspace/project not provided
 */
export async function searchNotes(
  database: Database.Database,
  params: SearchNotesParams,
  cwd?: string
): Promise<SearchNotesResult> {
  // Detect context automatically
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project || undefined,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  // Generate embedding for query
  const queryEmbedding = await embeds.embed(params.query);

  // Use repo info from context
  const repoFingerprint = params.global ? undefined : (context.repo_fingerprint ?? undefined);
  const repoUrl = params.global ? undefined : (params.repo_url ?? context.repo_url ?? undefined);
  const workspace = params.global ? null : context.workspace;
  const project = params.global ? null : (params.project || context.project || null);

  // Perform KNN search
  const results = db.searchNotes(
    database,
    queryEmbedding,
    workspace,
    project,
    params.top_k || 5,
    params.tags || null,
    params.review_status || null,
    repoFingerprint,
    repoUrl
  );

  return {
    notes: results,
    context,
  };
}

/**
 * List all topics for a workspace/project
 * Auto-detects context if workspace/project not provided
 */
export function listTopics(
  database: Database.Database,
  params: ListTopicsParams,
  cwd?: string
): ListTopicsResult {
  // Detect context automatically
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
      repo_url: params.repo_url || undefined,
    },
    cwd
  );

  const topics = db.listTopics(database, context.workspace, context.project);

  return {
    topics,
    context,
  };
}

/**
 * Delete a note and all its associated data
 * Auto-detects context if workspace/project not provided
 */
export function deleteNote(
  database: Database.Database,
  params: DeleteNoteParams,
  cwd?: string
): DeleteNoteResult {
  // Detect context automatically
  const context = detectContext(
    {
      workspace: params.workspace,
      project: params.project,
    },
    cwd
  );

  const deleted = db.deleteNote(
    database,
    context.workspace,
    context.project,
    params.topic,
    params.subtopic
  );

  return {
    deleted,
    context,
  };
}

/**
 * Update note metadata by note_id (topic/subtopic/review_status).
 * This is intentionally scoped by note_id to avoid ambiguity and to support renames.
 */
export function updateNoteMeta(
  database: Database.Database,
  params: UpdateNoteMetaParams,
  cwd?: string
): UpdateNoteMetaResult {
  const existing = db.getNoteById(database, params.note_id);
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

  // Optional scope validation: prevents accidental cross-note edits when caller supplies ws/proj
  if (params.workspace && existing.workspace !== params.workspace) {
    const context = detectContext({ workspace: existing.workspace, project: existing.project, repo_url: existing.repo_url ?? undefined }, cwd);
    return { note: null, context };
  }
  if (params.project && existing.project !== params.project) {
    const context = detectContext({ workspace: existing.workspace, project: existing.project, repo_url: existing.repo_url ?? undefined }, cwd);
    return { note: null, context };
  }

  const updated = db.updateNoteMeta(
    database,
    params.note_id,
    params.topic,
    params.subtopic ?? null,
    params.review_status
  );

  const context = detectContext(
    {
      workspace: (updated?.workspace ?? existing.workspace),
      project: (updated?.project ?? existing.project),
      repo_url: (updated?.repo_url ?? existing.repo_url) ?? undefined,
    },
    cwd
  );

  return { note: updated, context };
}
