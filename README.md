# Atlas: Cloudflare Knowledge Lab

Atlas is a deployable reference application for learning Cloudflare's developer platform through one coherent RAG workflow. Users can create accounts, upload text documents, wait for asynchronous indexing, ask grounded questions, revisit chats, rate responses, and inspect usage analytics.

## Service map

| Service | Responsibility |
| --- | --- |
| Workers + Static Assets | Hono API and React application at the edge |
| Workers AI | `bge-base-en-v1.5` embeddings and Llama response generation |
| AI Gateway | Observability and policy layer for generation requests |
| Vectorize | Per-user semantic document search |
| D1 | Users, document metadata, conversations, messages, and ratings |
| KV | Seven-day bearer sessions |
| R2 | Original uploaded documents |
| Queues | Asynchronous document chunking and embedding |
| Durable Objects | Strongly consistent per-user chat rate limiter |
| Turnstile | Signup and login bot challenge with server-side validation |
| WAF / Rate Limiting | Deployment exercises documented below |

## Local setup

Prerequisites: Node.js 20 or newer and a Cloudflare account. Workers AI and Vectorize require remote Cloudflare resources even while most bindings are locally emulated.

After installing Node.js, restart VS Code so new terminals receive the updated `PATH`. If PowerShell reports that `npm.ps1` cannot run because script execution is disabled, use the `.cmd` shims shown below; no execution-policy change is required.

```powershell
npm.cmd install
Copy-Item .dev.vars.example .dev.vars
npx.cmd wrangler login
npx.cmd wrangler vectorize create knowledge-lab-index --dimensions=768 --metric=cosine
npx.cmd wrangler vectorize create-metadata-index knowledge-lab-index --property-name=userId --type=string
npm.cmd run db:local
npm.cmd run dev
```

Open the URL printed by Vite. The local environment accepts an empty Turnstile token; production does not.

## Deploy

Create the cloud resources, then replace the placeholder D1 and KV IDs in `wrangler.jsonc` with the IDs emitted by Wrangler. R2 and Queue resources can be provisioned automatically on first deploy in current Wrangler releases.

```powershell
npx.cmd wrangler d1 create knowledge-lab-db
npx.cmd wrangler kv namespace create SESSIONS
npx.cmd wrangler r2 bucket create knowledge-lab-documents
npx.cmd wrangler queues create knowledge-lab-ingest
npx.cmd wrangler queues create knowledge-lab-ingest-dlq
npx.cmd wrangler secret put TURNSTILE_SECRET_KEY
npm.cmd run db:remote
npm.cmd run deploy
```

Set `ENVIRONMENT` to `production` and replace `TURNSTILE_SITE_KEY` with a real widget key before deployment. The included testing keys always pass; production must use a matching site key and secret from the Turnstile dashboard.

## Security exercises

1. **Turnstile:** Replace the testing keys, then confirm replayed callback tokens fail because Siteverify tokens are single-use.
2. **WAF:** Attach a custom domain, create a rule that blocks non-`POST` requests to `/api/auth/*`, and inspect Security Events.
3. **Rate Limiting:** Create a zone rate-limit rule for `/api/auth/*`. Compare it with the application-level Durable Object limiter on `/api/chat`.
4. **Bot protection:** Enable Bot Fight Mode on a test zone, generate scripted requests, and compare `cf.botManagement` signals on an eligible plan.
5. **AI Gateway:** Open the `knowledge-lab` gateway dashboard to inspect model latency, token usage, and cached requests.

## Deliberate lab constraints

- Uploads are limited to 5 MB text, Markdown, and CSV files. Add a PDF extraction service or browser parser as a follow-up exercise.
- Authentication is educational rather than a replacement for an identity provider. Production systems should consider Cloudflare Access, Clerk, Auth0, or another audited provider.
- Vectorize mutations are asynchronous. A document can briefly show `queued` after its Queue consumer has started.