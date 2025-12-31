import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';
import { env } from '@xenova/transformers';

// Disable local model cache warnings
env.allowLocalModels = false;

let embedder: FeatureExtractionPipeline | null = null;

/**
 * Initialize the embedding model
 */
async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    embedder = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      {
        quantized: true,
      }
    ) as FeatureExtractionPipeline;
  }
  return embedder;
}

/**
 * Simple in-memory cache for embeddings
 */
const embeddingCache = new Map<string, Float32Array>();

/**
 * Generate embedding for text using local transformer model
 * Returns normalized 384-dimension vector (cosine-ready)
 */
export async function embed(text: string): Promise<Float32Array> {
  // Check cache first
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text)!;
  }

  const model = await getEmbedder();
  const result = await model(text, {
    pooling: 'mean',
    normalize: true,
  });

  // Extract the embedding array
  let embedding: Float32Array;
  if (result.data) {
    // Result.data might be in different formats - convert to Float32Array
    const data = result.data;
    if (data instanceof Float32Array) {
      embedding = data;
    } else if (Array.isArray(data)) {
      embedding = new Float32Array(data);
    } else {
      // Try to convert DataArray to Float32Array
      embedding = new Float32Array(Array.from(data as any));
    }
  } else if (Array.isArray(result)) {
    embedding = new Float32Array(result);
  } else if (result instanceof Float32Array) {
    embedding = result;
  } else {
    // Try to access underlying tensor data
    const tensor = result as any;
    const shape = tensor?.shape || [];
    const totalElements = shape.reduce((a: number, b: number) => a * b, 1);
    embedding = new Float32Array(totalElements);
    
    // Flatten the tensor
    if (tensor?.data) {
      const data = tensor.data;
      if (data instanceof Float32Array) {
        embedding = data;
      } else if (Array.isArray(data)) {
        embedding = new Float32Array(data);
      } else {
        // Fallback: try to convert
        for (let i = 0; i < totalElements; i++) {
          embedding[i] = (data as any)[i] || 0;
        }
      }
    }
  }

  // Ensure it's 384 dimensions (MiniLM-L6-v2 output)
  if (embedding.length !== 384) {
    // Pad or truncate if needed (shouldn't happen with MiniLM-L6-v2)
    const normalized = new Float32Array(384);
    const copyLength = Math.min(embedding.length, 384);
    normalized.set(embedding.slice(0, copyLength));
    
    // If we truncated, warn (this shouldn't happen)
    if (embedding.length < 384) {
      console.warn(`Warning: Embedding dimension mismatch. Expected 384, got ${embedding.length}`);
    }
    
    embedding = normalized;
  }

  // Normalize to ensure cosine similarity works correctly
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  // Cache the result
  embeddingCache.set(text, embedding);

  return embedding;
}




