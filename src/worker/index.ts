import { Hono } from "hono";
import { cors } from "hono/cors";
import { createSalt, hashPassword, issueSession, requireUser, verifyTurnstile } from "./auth";
import { ChatLimiter } from "./chat-limiter";
import type { Env, IngestMessage, User } from "./types";

export { ChatLimiter };

type Variables = { user: User };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const model = "@cf/meta/llama-3.1-8b-instruct";
const embeddingModel = "@cf/baai/bge-base-en-v1.5";

app.use("/api/*", cors({ origin: (origin) => origin, allowHeaders: ["Content-Type", "Authorization"] }));

app.get("/api/config", (context) => context.json({ turnstileSiteKey: context.env.TURNSTILE_SITE_KEY }));

app.post("/api/auth/register", async (context) => {
  const body = await context.req.json<{ email?: string; password?: string; turnstileToken?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email) || (body.password?.length ?? 0) < 10) {
    return context.json({ error: "Use a valid email and a password of at least 10 characters" }, 400);
  }
  const valid = await verifyTurnstile(context.env, body.turnstileToken ?? "", context.req.header("CF-Connecting-IP"));
  if (!valid) return context.json({ error: "Human verification failed" }, 400);
  const id = crypto.randomUUID();
  const salt = createSalt();
  const passwordHash = await hashPassword(body.password!, salt);
  try {
    await context.env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)")
      .bind(id, email, passwordHash, salt).run();
  } catch {
    return context.json({ error: "An account with that email already exists" }, 409);
  }
  const user = { id, email };
  return context.json({ token: await issueSession(context.env, user), user }, 201);
});

app.post("/api/auth/login", async (context) => {
  const body = await context.req.json<{ email?: string; password?: string; turnstileToken?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const valid = await verifyTurnstile(context.env, body.turnstileToken ?? "", context.req.header("CF-Connecting-IP"));
  if (!valid) return context.json({ error: "Human verification failed" }, 400);
  const row = await context.env.DB.prepare(
    "SELECT id, email, password_hash, password_salt FROM users WHERE email = ?",
  ).bind(email).first<{ id: string; email: string; password_hash: string; password_salt: string }>();
  if (!row || await hashPassword(body.password ?? "", row.password_salt) !== row.password_hash) {
    return context.json({ error: "Invalid email or password" }, 401);
  }
  const user = { id: row.id, email: row.email };
  return context.json({ token: await issueSession(context.env, user), user });
});

app.use("/api/*", requireUser);

app.get("/api/documents", async (context) => {
  const user = context.get("user");
  const result = await context.env.DB.prepare(
    "SELECT id, name, content_type, size, status, chunk_count, created_at FROM documents WHERE user_id = ? ORDER BY created_at DESC",
  ).bind(user.id).all();
  return context.json(result.results);
});

app.post("/api/documents", async (context) => {
  const user = context.get("user");
  const form = await context.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return context.json({ error: "Choose a file" }, 400);
  if (file.size > 5 * 1024 * 1024) return context.json({ error: "Files must be 5 MB or smaller" }, 413);
  if (!file.type.startsWith("text/") && !file.name.match(/\.(md|txt|csv)$/i)) {
    return context.json({ error: "This lab currently indexes TXT, Markdown, and CSV files" }, 415);
  }
  const id = crypto.randomUUID();
  const r2Key = `${user.id}/${id}/${file.name}`;
  await context.env.DOCUMENTS.put(r2Key, file.stream(), { httpMetadata: { contentType: file.type || "text/plain" } });
  await context.env.DB.prepare(
    "INSERT INTO documents (id, user_id, name, r2_key, content_type, size) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, user.id, file.name, r2Key, file.type || "text/plain", file.size).run();
  await context.env.INGEST_QUEUE.send({ documentId: id, userId: user.id, r2Key });
  return context.json({ id, name: file.name, status: "queued" }, 202);
});

app.get("/api/conversations", async (context) => {
  const user = context.get("user");
  const result = await context.env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30",
  ).bind(user.id).all();
  return context.json(result.results);
});

app.get("/api/conversations/:id/messages", async (context) => {
  const user = context.get("user");
  const result = await context.env.DB.prepare(
    "SELECT m.id, m.role, m.content, m.sources, m.rating, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.id = ? AND c.user_id = ? ORDER BY m.created_at",
  ).bind(context.req.param("id"), user.id).all();
  return context.json(result.results);
});

app.post("/api/chat", async (context) => {
  const startedAt = Date.now();
  const user = context.get("user");
  const body = await context.req.json<{ message?: string; conversationId?: string }>();
  const question = body.message?.trim() ?? "";
  if (!question || question.length > 3000) return context.json({ error: "Enter a question under 3,000 characters" }, 400);
  const limiter = context.env.CHAT_LIMITER.getByName(user.id) as unknown as { consume(): Promise<{ allowed: boolean; retryAfter: number }> };
  const rate = await limiter.consume();
  if (!rate.allowed) return context.json({ error: `Rate limit reached. Try again in ${rate.retryAfter}s.` }, 429);

  let conversationId = body.conversationId;
  if (conversationId) {
    const owner = await context.env.DB.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
      .bind(conversationId, user.id).first();
    if (!owner) return context.json({ error: "Conversation not found" }, 404);
  } else {
    conversationId = crypto.randomUUID();
    await context.env.DB.prepare("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)")
      .bind(conversationId, user.id, question.slice(0, 64)).run();
  }

  const embedding = await context.env.AI.run(embeddingModel, { text: [question] }) as { data: number[][] };
  const matches = await context.env.VECTOR_INDEX.query(embedding.data[0], {
    topK: 5,
    returnMetadata: "all",
    filter: { userId: user.id },
  });
  const sources = matches.matches.map((match) => ({
    documentId: String(match.metadata?.documentId ?? ""),
    name: String(match.metadata?.name ?? "Document"),
    text: String(match.metadata?.text ?? ""),
    score: match.score,
  })).filter((source) => source.text);
  const contextText = sources.map((source, index) => `[${index + 1}] ${source.name}\n${source.text}`).join("\n\n");
  const prompt = `You are a careful knowledge assistant. Answer using only the supplied document context. Cite sources as [1], [2], etc. If the answer is absent, say so plainly.\n\nContext:\n${contextText || "No matching context was found."}\n\nQuestion: ${question}`;
  const answer = await context.env.AI.run(model, { prompt }, {
    gateway: { id: context.env.AI_GATEWAY_ID },
  }) as { response?: string };
  const responseText = answer.response ?? "I could not generate a response.";
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  await context.env.DB.batch([
    context.env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)")
      .bind(userMessageId, conversationId, question),
    context.env.DB.prepare("INSERT INTO messages (id, conversation_id, role, content, sources, latency_ms) VALUES (?, ?, 'assistant', ?, ?, ?)")
      .bind(assistantMessageId, conversationId, responseText, JSON.stringify(sources), Date.now() - startedAt),
    context.env.DB.prepare("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(conversationId),
  ]);
  return context.json({ conversationId, message: { id: assistantMessageId, role: "assistant", content: responseText, sources } });
});

app.post("/api/messages/:id/rating", async (context) => {
  const user = context.get("user");
  const { rating } = await context.req.json<{ rating?: number }>();
  if (rating !== 1 && rating !== -1) return context.json({ error: "Rating must be 1 or -1" }, 400);
  const result = await context.env.DB.prepare(
    "UPDATE messages SET rating = ? WHERE id = ? AND role = 'assistant' AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)",
  ).bind(rating, context.req.param("id"), user.id).run();
  return context.json({ updated: result.meta.changes > 0 });
});

app.get("/api/analytics", async (context) => {
  const user = context.get("user");
  const row = await context.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents WHERE user_id = ?) AS documents,
      (SELECT COUNT(*) FROM conversations WHERE user_id = ?) AS conversations,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'assistant') AS responses,
      (SELECT ROUND(AVG(m.latency_ms)) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'assistant') AS avg_latency,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.rating = 1) AS helpful
  `).bind(user.id, user.id, user.id, user.id, user.id).first();
  return context.json(row);
});

async function ingest(message: IngestMessage, env: Env): Promise<void> {
  const object = await env.DOCUMENTS.get(message.r2Key);
  if (!object) throw new Error(`Missing R2 object: ${message.r2Key}`);
  const document = await env.DB.prepare("SELECT name FROM documents WHERE id = ? AND user_id = ?")
    .bind(message.documentId, message.userId).first<{ name: string }>();
  if (!document) throw new Error(`Missing document: ${message.documentId}`);
  const text = await object.text();
  const chunks = text.match(/[\s\S]{1,1200}(?:\s|$)/g)?.map((chunk) => chunk.trim()).filter(Boolean) ?? [];
  for (let offset = 0; offset < chunks.length; offset += 20) {
    const batch = chunks.slice(offset, offset + 20);
    const embeddings = await env.AI.run(embeddingModel, { text: batch }) as { data: number[][] };
    await env.VECTOR_INDEX.upsert(batch.map((chunk, index) => ({
      id: `${message.documentId}:${offset + index}`,
      values: embeddings.data[index],
      namespace: message.userId,
      metadata: { userId: message.userId, documentId: message.documentId, name: document.name, text: chunk },
    })));
  }
  await env.DB.prepare("UPDATE documents SET status = 'ready', chunk_count = ? WHERE id = ?")
    .bind(chunks.length, message.documentId).run();
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await ingest(message.body, env);
        message.ack();
      } catch (error) {
        console.error("Document ingestion failed", error);
        await env.DB.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").bind(message.body.documentId).run();
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, IngestMessage>;