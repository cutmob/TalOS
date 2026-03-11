import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { MemoryConfig } from './types.js';

/**
 * Semantic memory layer using Amazon Nova 2 Multimodal Embeddings.
 *
 * Model ID: amazon.nova-2-multimodal-embeddings-v1:0
 * Supports: text, image, audio, video embeddings
 * Configurable dimensions: 256 | 384 | 1024 | 3072
 *
 * Uses InvokeModel API with taskType: "SINGLE_EMBEDDING".
 * Note: Embeddings use InvokeModel (NOT Converse API).
 *
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/nova-embeddings.html
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/embeddings-schema.html
 */
export class SemanticMemory {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private dimension: number;

  constructor(config: MemoryConfig) {
    this.client = new BedrockRuntimeClient({ region: config.bedrockRegion });
    this.modelId = config.embeddingModelId;
    this.dimension = config.embeddingDimension ?? 1024;
  }

  /**
   * Generate a text embedding using the official Nova Multimodal Embeddings schema.
   *
   * Request format:
   * {
   *   "taskType": "SINGLE_EMBEDDING",
   *   "singleEmbeddingParams": {
   *     "embeddingPurpose": "GENERIC_INDEX" | "GENERIC_RETRIEVAL",
   *     "embeddingDimension": 1024,
   *     "text": { "truncationMode": "END", "value": "..." }
   *   }
   * }
   *
   * Response format:
   * { "embeddings": [{ "embeddingType": "TEXT", "embedding": [...] }] }
   */
  async embed(
    text: string,
    purpose: 'GENERIC_INDEX' | 'GENERIC_RETRIEVAL' = 'GENERIC_INDEX'
  ): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        taskType: 'SINGLE_EMBEDDING',
        singleEmbeddingParams: {
          embeddingPurpose: purpose,
          embeddingDimension: this.dimension,
          text: {
            truncationMode: 'END',
            value: text.slice(0, 8192), // Max 8192 chars for inline text
          },
        },
      }),
    });

    const response = await this.client.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embeddings?.[0]?.embedding ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Nova embeddings: one modality per request, so we parallelize
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async embedForRetrieval(text: string): Promise<number[]> {
    return this.embed(text, 'GENERIC_RETRIEVAL');
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  findMostSimilar(
    queryEmbedding: number[],
    candidates: Array<{ id: string; embedding: number[] }>,
    topK = 5
  ): Array<{ id: string; score: number }> {
    return candidates
      .map((c) => ({ id: c.id, score: this.cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
