import type { Context, Next } from "hono";
import type { Env, User } from "./types";

type AppContext = { Bindings: Env; Variables: { user: User } };

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashPassword(password: string, saltBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(atob(saltBase64), (character) => character.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function createSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

export async function issueSession(env: Env, user: User): Promise<string> {
  const token = randomToken();
  await env.SESSIONS.put(`session:${token}`, JSON.stringify(user), { expirationTtl: 60 * 60 * 24 * 7 });
  return token;
}

export async function requireUser(context: Context<AppContext>, next: Next): Promise<Response | void> {
  const header = context.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const user = token ? await context.env.SESSIONS.get<User>(`session:${token}`, "json") : null;
  if (!user) return context.json({ error: "Authentication required" }, 401);
  context.set("user", user);
  await next();
}

export async function verifyTurnstile(env: Env, token: string, ip?: string): Promise<boolean> {
  if (env.ENVIRONMENT === "local" && !token) return true;
  if (!token || token.length > 2048) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  });
  const result = (await response.json()) as { success: boolean };
  return result.success;
}