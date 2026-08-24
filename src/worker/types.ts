export type IngestMessage = { documentId: string; userId: string; r2Key: string };

export interface Env {
  AI: Ai;
  DB: D1Database;
  SESSIONS: KVNamespace;
  DOCUMENTS: R2Bucket;
  VECTOR_INDEX: VectorizeIndex;
  INGEST_QUEUE: Queue<IngestMessage>;
  CHAT_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  AI_GATEWAY_ID: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}

export type User = { id: string; email: string };