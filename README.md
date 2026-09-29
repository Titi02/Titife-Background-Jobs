# Titife Background Jobs

Background job processing system that takes transactional email (Resend) off the HTTP request path.

## What it does

`POST /api/jobs` writes a `pending` job and returns `202` immediately. A standalone Node worker
claims the job, sends the email via Resend, retries safely, records an append-only `JobEvent` audit
trail, and surfaces permanently failed jobs in a dead-letter view for manual retry. v1 handles one
job type (`email.send`) with one worker instance.

## Key features

- **Async jobs** — enqueue never blocks and never calls Resend inline.
- **Atomic claiming** — one raw SQL `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED … LIMIT 1) RETURNING *`.
- **Concurrency limit** — `WORKER_CONCURRENCY` in-flight jobs per worker process.
- **Retries** — retryable failures (timeout / 429 / 5xx) go `processing → pending`; exhausted or
  non-retryable (400/422/401/403) go `processing → dead`. No `failed` status.
- **Exponential backoff + jitter** — `min(30000, 2000 * 2^attempts) + random(0, backoff * 0.2)` ms.
- **Idempotency** — unique `(userId, idempotencyKey)`, a pre-send `JobOutput` check, and the job id
  as the Resend `Idempotency-Key` on every attempt. No duplicate emails.
- **Stuck-job recovery** — a sweep resets `processing` jobs older than `STUCK_JOB_TIMEOUT_MS` to `pending`.
- **Dead letters** — `/dead-letters` UI, `GET /api/jobs?status=dead`, `POST /api/jobs/:id/retry`.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · PostgreSQL via Prisma 6 · Resend
(worker process only) · Node ≥ 20 (`.nvmrc`: 22.14.0) · npm

## Prerequisites

- Node 20+ and npm
- A local PostgreSQL instance
- A Resend account and API key (no key → sends fail `401` and jobs go straight to `dead`)

## Setup

```bash
npm install
Copy-Item .env.example .env        # PowerShell; set RESEND_API_KEY in .env
createdb titife_jobs               # or point DATABASE_URL at an existing database
npm run prisma:migrate             # prisma migrate dev
npm run prisma:generate
```

## Run

```bash
npm run dev      # Terminal A — Next.js app on http://localhost:3000 (→ /jobs)
npm run worker   # Terminal B — worker process (exactly ONE instance in v1)
```

## Test

Open `/create`, submit an email, watch `pending → processing → succeeded` on `/jobs`. Or:

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" -H "x-user-id: demo-user" \
  -d '{"type":"email.send","payload":{"to":"you@example.com","subject":"Hello","text":"Body"},"idempotencyKey":"demo-001"}'
```

Other commands: `npm run build` / `start`, `npm run lint`, `npm run cleanup` (30-day retention),
`npx prisma studio`. Run `npm run cleanup` on a schedule — the audit trail only lives 30 days.

See [`DOCUMENTATION.md`](DOCUMENTATION.md) for the detailed assessment, exact code references, and
evidence. Spec: `docs/PRD_Background_Job_Processing_Email_v2.md`. Rules: `AGENTS.md`.
