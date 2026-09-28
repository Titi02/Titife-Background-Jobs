# Titife Background Jobs

A background job processing system that takes transactional email (via Resend) off the HTTP request path. `POST /api/jobs` returns `202` immediately; a standalone worker sends the email, retries with backoff, records a `JobEvent` audit trail, and surfaces permanently failed jobs in a dead-letter view for manual retry.

Spec: `docs/PRD_Background_Job_Processing_Email_v2.md`. Engineering rules: `AGENTS.md`.

## Overview

- **v1 scope**: one job type (`email.send`), one worker instance, no admin role, no notifications.
- **Guarantees**: atomic claim (no two workers on one job), backoff + jitter retries, no duplicate emails, recovery of jobs stuck in `processing`, full audit trail.
- **Retry model**: no `failed` status; retryable failure → `processing → pending`, exhausted → `processing → dead`. Terminal states: `succeeded`, `dead`.

## Main Features

- **Non-blocking enqueue** — returns `202`; never calls Resend inline.
- **Atomic claim** — single raw SQL `UPDATE ... FOR UPDATE SKIP LOCKED`.
- **Concurrency cap** — `WORKER_CONCURRENCY` (default 5) per worker process.
- **Backoff** — `min(30000, 2000 * 2^attempts) + random(0, backoff * 0.2)` ms; retryable = timeout / 429 / 5xx.
- **Idempotency** — unique `(userId, idempotencyKey)`, pre-send `JobOutput` check, job id as Resend `Idempotency-Key` on every attempt.
- **Immediate dead-letter** — Resend `400`/`422` and `401`/`403` (tagged `[CONFIG_ERROR]`) go straight to `dead`.
- **Stuck-job sweep** — resets `processing` jobs past `STUCK_JOB_TIMEOUT_MS` to `pending` with a distinct audit event.
- **Dead letter view + retry** — UI and `POST /api/jobs/:id/retry`.
- **Audit trail** — every transition writes an append-only `JobEvent`.
- **30-day cleanup** — `scripts/cleanup.ts` deletes old jobs (cascade-deletes outputs/events).

## Technology Stack

Next.js (App Router) · React 19 · TypeScript (strict) · PostgreSQL via Prisma · Resend (worker only) · Node ≥ 20 (`.nvmrc` pins `22.14.0`) · npm · ESLint · Prettier

## Repository Layout

```
prisma/schema.prisma    Job, JobOutput, JobEvent models + JobStatus enum
prisma/migrations/      committed migrations
src/app/                API routes, /jobs, /create, /dead-letters
src/lib/                db client, auth (userId), job helpers
worker/                 the worker process (index, claim, sweep, Resend client, handlers)
scripts/cleanup.ts      30-day retention cleanup
.env.example            all config variables, no real secrets
```

## Prerequisites

- Node 20+ (`.nvmrc`: 22.14.0) and npm.
- PostgreSQL running locally (default `postgres://postgres:postgres@localhost:5432/titife_jobs`).
- A Resend account + API key. Without one, sends fail with `401` → jobs go straight to `dead` (a valid way to exercise the dead-letter flow).

## Quick Start

Run from the project root. Steps 1–4 get a working set-up; 5–6 run both processes.

```bash
# 1. Install dependencies
npm install

# 2. Configure the environment (copy .env.example to .env), set your Resend key
Copy-Item .env.example .env            # Windows (PowerShell)

# 3. Create the database, apply migrations, generate the Prisma client
createdb titife_jobs
npm run prisma:migrate
npm run prisma:generate

# 4. Terminal A — start the Next.js app (http://localhost:3000, / redirects to /jobs)
npm run dev

# 5. Terminal B — start the worker (exactly ONE instance in v1)
npm run worker

# 6. Verify: open /create, submit an email, watch Pending → Processing → Succeeded on /jobs
```

Production alternative: `npm run build` then `npm run start`.

## Environment Variables

All values live in `.env` (the app loads it; the worker via `dotenv`). See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/titife_jobs?schema=public` | Prisma connection string |
| `RESEND_API_KEY` | (placeholder) | Resend key — required for real sends; never commit a real value |
| `RESEND_FROM_EMAIL` | `onboarding@resend.dev` | Verified sending address |
| `MAX_ATTEMPTS` | `5` | Total attempts per job (counting the first) |
| `WORKER_CONCURRENCY` | `5` | Max in-flight jobs per worker |
| `BACKOFF_BASE_MS` | `2000` | Backoff base (ms) |
| `BACKOFF_CAP_MS` | `30000` | Backoff cap (ms) |
| `STUCK_JOB_TIMEOUT_MS` | `300000` | `processing` job older than this is swept to `pending` |
| `POLL_INTERVAL_MS` | `1000` | Claim-poll interval (ms) |
| `SWEEP_INTERVAL_MS` | `60000` | Stuck-job sweep interval (ms) |
| `RESEND_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout to Resend (ms) |

Extra: `npx prisma studio` opens a browser over the DB (handy for inspecting `Job`/`JobOutput`/`JobEvent`).

## npm Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm run lint` | `next lint` |
| `npm run worker` | Start the worker (`tsx worker/index.ts`) |
| `npm run cleanup` | 30-day retention cleanup (`tsx scripts/cleanup.ts`) |
| `npm run prisma:generate` / `prisma:migrate` | `prisma generate` / `prisma migrate dev` |

## API Endpoints

| Endpoint | Behavior |
| --- | --- |
| `POST /api/jobs` | Enqueue `email.send`: `{ "type", "payload": { "to", "subject", "text"/"html" }, "idempotencyKey" }` → `202` + job id. Duplicate `idempotencyKey` for the same user returns the existing job. Never sends inline. |
| `GET /api/jobs/:id` | Job fields; `404` if it doesn't belong to the authenticated user. |
| `GET /api/jobs?status=dead` | The user's dead-letter jobs. |
| `POST /api/jobs/:id/retry` | Dead → `pending` (`attempts = 0`, `runAt = now()`), logging the acting userId. |

`userId` is derived from `Authorization: Bearer <token>`, `x-user-id`, or (dev only) `dev_user_default` — never from the body/path. Example:

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" -H "x-user-id: demo-user" \
  -d '{"type":"email.send","payload":{"to":"you@example.com","subject":"Hello","text":"Body"},"idempotencyKey":"demo-001"}'
```

## Usage / Testing Flow

Enqueue (`/create` or `POST /api/jobs`) → worker claims (`processing`, `attempts+1`) → idempotency check → Resend send → `succeeded` with `JobOutput`+`JobEvent`. Retryable failures (`processing → pending`, backoff); exhausted → `dead`.

Ways to exercise paths without a real recipient: an invalid API key → `401 → dead` (`[CONFIG_ERROR]`); a `400`/`422` → straight to `dead`; killing the worker mid-send or setting `RESEND_REQUEST_TIMEOUT_MS` very low → retryable path.

## Operations Notes

- Run **exactly one worker instance** — `WORKER_CONCURRENCY` is per-process; a second instance doubles load against Resend's rate limit.
- The `JobEvent` trail lives at most **30 days**; run `npm run cleanup` on a schedule.