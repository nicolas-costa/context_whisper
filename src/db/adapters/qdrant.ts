/**
 * Qdrant Adapter for context-whisper
 * Uses Qdrant for vector search operations
 * Can be combined with SQLite, PostgreSQL, or MySQL for relational data
 */

import type {
  VectorAdapter,
  DatabaseAdapter,
  RelationalAdapter,
  SearchResult,
  QdrantConfig,
} from './interface.js';

const DEFAULT_COLLECTION_NAME = 'context_whisper_notes';
const VECTOR_DIMENSION = 384; // MiniLM-L6-v2 output dimension

interface QdrantPoint {
  id: number;
  vector: number[];
  payload?: Record<string, any>;
}

interface QdrantSearchResult {
  id: number;
  score: number;
  payload?: Record<string, any>;
}

/**
 * Qdrant Vector Adapter
 */
export class QdrantVectorAdapter implements VectorAdapter {
  readonly type = 'qdrant' as const;
  private baseUrl: string;
  private apiKey?: string;
  private collectionName: string;

  constructor(config: QdrantConfig) {
    const protocol = config.https ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this.apiKey = config.apiKey;
    this.collectionName = config.collection || DEFAULT_COLLECTION_NAME;
  }

  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['api-key'] = this.apiKey;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qdrant API error (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }

    return null;
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.request('GET', '/');
      return true;
    } catch {
      return false;
    }
  }

  async initSchema(): Promise<void> {
    // Check if collection exists
    try {
      await this.request('GET', `/collections/${this.collectionName}`);
      // Collection exists, nothing to do
      return;
    } catch (error: any) {
      // Collection doesn't exist, create it
      if (!error.message?.includes('404') && !error.message?.includes('Not found')) {
        throw error;
      }
    }

    // Create collection with cosine distance (matches MiniLM-L6-v2 embeddings)
    await this.request('PUT', `/collections/${this.collectionName}`, {
      vectors: {
        size: VECTOR_DIMENSION,
        distance: 'Cosine',
      },
    });

    // Create payload index for note_id (for efficient filtering)
    await this.request('PUT', `/collections/${this.collectionName}/index`, {
      field_name: 'note_id',
      field_schema: 'integer',
    });
  }

  async close(): Promise<void> {
    // No persistent connection to close
  }

  async upsertVector(noteId: number, embedding: Float32Array): Promise<void> {
    const point: QdrantPoint = {
      id: noteId,
      vector: Array.from(embedding),
      payload: {
        note_id: noteId,
      },
    };

    await this.request('PUT', `/collections/${this.collectionName}/points`, {
      points: [point],
    });
  }

  async deleteVector(noteId: number): Promise<void> {
    await this.request('POST', `/collections/${this.collectionName}/points/delete`, {
      points: [noteId],
    });
  }

  async searchVectors(
    queryVector: Float32Array,
    topK: number,
    filter?: { noteIds?: number[] }
  ): Promise<Array<{ noteId: number; distance: number }>> {
    const searchParams: any = {
      vector: Array.from(queryVector),
      limit: topK,
      with_payload: true,
    };

    // Add filter if noteIds provided
    if (filter?.noteIds && filter.noteIds.length > 0) {
      searchParams.filter = {
        must: [
          {
            has_id: filter.noteIds,
          },
        ],
      };
    }

    const result = await this.request(
      'POST',
      `/collections/${this.collectionName}/points/search`,
      searchParams
    );

    // Qdrant returns similarity scores (higher is better for cosine)
    // Convert to distance (lower is better) for consistency with other adapters
    return (result.result || []).map((item: QdrantSearchResult) => ({
      noteId: item.id,
      distance: 1 - item.score, // Convert cosine similarity to distance
    }));
  }

  /**
   * Batch upsert vectors
   */
  async upsertVectors(vectors: Array<{ noteId: number; embedding: Float32Array }>): Promise<void> {
    const points: QdrantPoint[] = vectors.map(v => ({
      id: v.noteId,
      vector: Array.from(v.embedding),
      payload: {
        note_id: v.noteId,
      },
    }));

    await this.request('PUT', `/collections/${this.collectionName}/points`, {
      points,
    });
  }

  /**
   * Delete multiple vectors
   */
  async deleteVectors(noteIds: number[]): Promise<void> {
    if (noteIds.length === 0) return;

    await this.request('POST', `/collections/${this.collectionName}/points/delete`, {
      points: noteIds,
    });
  }

  /**
   * Get collection info (for debugging/health checks)
   */
  async getCollectionInfo(): Promise<any> {
    return this.request('GET', `/collections/${this.collectionName}`);
  }
}

/**
 * Combined Database Adapter using Qdrant for vectors + any relational adapter
 */
export class QdrantCombinedAdapter implements DatabaseAdapter {
  readonly relational: RelationalAdapter;
  readonly vector: QdrantVectorAdapter;
  readonly environmentName: string;

  constructor(
    relationalAdapter: RelationalAdapter,
    qdrantConfig: QdrantConfig,
    environmentName: string = 'default'
  ) {
    this.relational = relationalAdapter;
    this.vector = new QdrantVectorAdapter(qdrantConfig);
    this.environmentName = environmentName;
  }

  async isHealthy(): Promise<{ relational: boolean; vector: boolean }> {
    return {
      relational: await this.relational.isHealthy(),
      vector: await this.vector.isHealthy(),
    };
  }

  async initSchema(): Promise<void> {
    await this.relational.initSchema();
    await this.vector.initSchema();
  }

  async close(): Promise<void> {
    await this.relational.close();
    await this.vector.close();
  }

  async searchNotes(
    queryVector: Float32Array,
    options: {
      workspace?: string | null;
      project?: string | null;
      topK?: number;
      tags?: string[] | null;
      reviewStatus?: string | null;
      repoFingerprint?: string | null;
      repoUrl?: string | null;
    }
  ): Promise<SearchResult[]> {
    const topK = options.topK || 5;

    // Strategy: First get filtered note IDs from relational DB, then search vectors
    // This ensures consistency with filters
    
    // Check if we have any filters
    const hasFilters = options.workspace || options.project || 
                       options.tags?.length || options.reviewStatus ||
                       options.repoFingerprint || options.repoUrl;

    let filteredNoteIds: number[] | undefined;

    if (hasFilters) {
      // Get filtered note IDs from relational adapter
      // We need to implement a method for this - cast to extended interface
      const adapter = this.relational as any;
      if (typeof adapter.getFilteredNoteIds === 'function') {
        const ids = await adapter.getFilteredNoteIds(options);
        
        // If no notes match filters, return empty
        if (ids.length === 0) {
          return [];
        }
        filteredNoteIds = ids;
      }
    }

    // Search vectors with filter
    const vectorResults = await this.vector.searchVectors(
      queryVector,
      // Request more results if filtering, to ensure we get enough after filtering
      filteredNoteIds ? Math.min(topK * 3, 100) : topK,
      filteredNoteIds ? { noteIds: filteredNoteIds } : undefined
    );

    // Get full notes from relational DB
    const noteIds = vectorResults.map(r => r.noteId);
    
    // Build a map of distances
    const distanceMap = new Map<number, number>();
    vectorResults.forEach(r => distanceMap.set(r.noteId, r.distance));

    // Fetch notes
    const adapter = this.relational as any;
    let notes: any[] = [];
    
    if (typeof adapter.getNotesByIds === 'function') {
      notes = await adapter.getNotesByIds(noteIds);
    } else {
      // Fallback: fetch one by one
      for (const noteId of noteIds) {
        const note = await this.relational.getNoteById(noteId);
        if (note) notes.push(note);
      }
    }

    // Combine notes with distances and sort by distance
    const results: SearchResult[] = notes
      .map(note => ({
        ...note,
        distance: distanceMap.get(note.note_id) ?? 1,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);

    return results;
  }
}

/**
 * Create Qdrant vector adapter
 */
export function createQdrantAdapter(config: QdrantConfig): QdrantVectorAdapter {
  return new QdrantVectorAdapter(config);
}

/**
 * Create combined adapter with Qdrant + any relational adapter
 */
export function createQdrantCombinedAdapter(
  relationalAdapter: RelationalAdapter,
  qdrantConfig: QdrantConfig,
  environmentName: string = 'default'
): QdrantCombinedAdapter {
  return new QdrantCombinedAdapter(relationalAdapter, qdrantConfig, environmentName);
}
