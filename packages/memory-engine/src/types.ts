export interface MemoryEntry {
  id: string;
  type: 'short_term' | 'long_term' | 'semantic';
  category: 'task' | 'workflow' | 'ui_snapshot' | 'preference' | 'correction';
  content: Record<string, unknown>;
  embedding?: number[];
  sessionId?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface UISnapshot {
  app: string;
  page: string;
  elements: UIElement[];
  capturedAt: number;
  screenshotUrl?: string;
}

export interface UIElement {
  label: string;
  type: 'button' | 'input' | 'dropdown' | 'link' | 'text' | 'other';
  selector?: string;
  embedding?: number[];
}

export interface MemoryQuery {
  text?: string;
  embedding?: number[];
  category?: MemoryEntry['category'];
  limit?: number;
  minScore?: number;
}

/** Minimal config needed by SemanticMemory to call Nova 2 Multimodal Embeddings. */
export interface EmbeddingConfig {
  bedrockRegion: string;
  embeddingModelId: string;
  /** Embedding vector dimension: 256 | 384 | 1024 | 3072 (default 1024) */
  embeddingDimension: number;
}

/** Full memory system config — extends EmbeddingConfig with memory-management settings. */
export interface MemoryConfig extends EmbeddingConfig {
  shortTermTTL: number; // ms
  maxShortTermEntries: number;
}

export interface MemoryStore {
  save(entry: MemoryEntry): Promise<void>;
  query(query: MemoryQuery): Promise<Array<{ entry: MemoryEntry; score: number }>>;
  delete(id: string): Promise<void>;
  getBySession(sessionId: string): Promise<MemoryEntry[]>;
  cleanup(): Promise<number>;
}
