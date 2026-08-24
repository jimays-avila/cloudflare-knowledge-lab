import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export class ChatLimiter extends DurableObject<Env> {
  async consume(): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = 12;
    const state = await this.ctx.storage.get<{ startedAt: number; count: number }>("window");
    const current = !state || now - state.startedAt >= windowMs ? { startedAt: now, count: 0 } : state;
    if (current.count >= limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((windowMs - (now - current.startedAt)) / 1000) };
    }
    current.count += 1;
    await this.ctx.storage.put("window", current);
    return { allowed: true, remaining: limit - current.count, retryAfter: 0 };
  }
}