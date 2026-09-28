# AGENTS.md — Background Job Processing System (Email via Resend)

## 1. What This Project Is

This is a background job processing system. Its only job in v1 is to send
transactional email through Resend without blocking the HTTP request that
triggers it, and to survive failure without losing or duplicating a send.

- **Product**: a job queue + worker that takes email sending off the
  request path, retries it safely, and gives humans a way to see and fix
  what died.
- **Users**: an internal requesting client (a backend service or app)
  triggers sends on behalf of an authenticated end user; an on-call
  engineer works the dead letter queue when sends fail permanently.
- **Version being built**: v1 only. v1 has exactly one job type
  (`email.send`), one worker instance, no admin role, no notifications,
  no UI beyond the dead letter view.
- **Source of truth**: `PRD_Background_Job_Processing_Email_v2.docx`.
  If this file and the PRD ever disagree on a *feature* (what to build),
  the PRD wins. If they disagree on *behavior while building* (how to
  build it), this file wins. If you find a real contradiction between
  the two, stop and flag it — do not silently pick one.

This file does not restate the PRD's features. It tells you the rules
you must not break while building them. Every rule below exists because
breaking it would be a failure even if your code compiles, runs, and
looks correct at a glance.

---

## 2. What Is Locked

These are already decided. Do not change, swap, "improve," or
second-guess any of them, even if you know a library or pattern you
consider better.

- **Framework**: Next.js, App Router only. No Pages Router.
- **Language**: TypeScript everywhere. No plain JavaScript files.
- **Database**: PostgreSQL, accessed only through Prisma ORM.
- **Email provider**: Resend. No other email provider, no abstraction
  layer that swaps providers "for flexibility." Call Resend directly via
  its HTTPS API or official Node SDK.
- **Worker runtime**: a standalone Node.js process, not a Next.js API
  route, not a serverless function, not a cron-triggered lambda. It runs
  as a persistent process because it polls.
- **Prisma schema** — reproduce these models and this enum exactly.
  Do not add fields, do not rename fields, do not add a `failed` status,
  do not split `JobOutput` or `JobEvent` into something else:

  ```prisma
  model Job {
    id              String    @id @default(cuid())
    userId          String
    type            String
    payload         Json
    status          JobStatus @default(pending)
    attempts        Int       @default(0)
    maxAttempts     Int       @default(5)
    lastError       String?
    runAt           DateTime  @default(now())
    startedAt       DateTime?
    finishedAt      DateTime?
    idempotencyKey  String
    createdAt       DateTime  @default(now())
    updatedAt       DateTime  @updatedAt

    output          JobOutput?
    events          JobEvent[]

    @@unique([userId, idempotencyKey])
    @@index([status, runAt])
  }

  enum JobStatus {
    pending
    processing
    succeeded
    dead
  }

  model JobOutput {
    id                 String   @id @default(cuid())
    jobId              String   @unique
    providerMessageId  String?
    raw                Json?
    createdAt          DateTime @default(now())

    job                Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  }

  model JobEvent {
    id            String     @id @default(cuid())
    jobId         String
    fromStatus    JobStatus?
    toStatus      JobStatus
    message       String?
    actingUserId  String?
    createdAt     DateTime   @default(now())

    job           Job        @relation(fields: [jobId], references: [id], onDelete: Cascade)

    @@index([jobId, createdAt])
  }
  ```

- **`JobStatus` has exactly four values.** There is no `failed` status
  and there is no separate retry scheduler. A retryable failure writes
  `processing → pending` directly. An exhausted failure writes
  `processing → dead` directly. Do not add a fifth status, and do not
  build a second table or cron job whose purpose is "retry scheduling" —
  the worker's own claim query is the only retry mechanism.
- **The claim query is this exact pattern** — a single atomic
  `SELECT ... FOR UPDATE SKIP LOCKED` nested inside an `UPDATE`, run as
  raw SQL through Prisma's `$queryRaw`, never a read-then-write:

  ```sql
  UPDATE "Job"
  SET status = 'processing', "startedAt" = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM "Job"
    WHERE status = 'pending' AND "runAt" <= now()
    ORDER BY "runAt" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
  ```

- **Backoff formula, exact constants**:
  `backoff(attempts) = min(30000, 2000 * 2^attempts) + random(0, backoff * 0.2)`
  milliseconds. Base 2000ms, cap 30000ms, jitter up to 20%. Do not
  substitute a different curve or library default.
- **API surface is exactly**: `POST /api/jobs`, `GET /api/jobs/:id`,
  `GET /api/jobs?status=dead`, `POST /api/jobs/:id/retry`. Do not add
  extra endpoints not named in the PRD without flagging it (see Section 7).
- **Config values are environment variables, not hardcoded constants**:
  `MAX_ATTEMPTS`, `WORKER_CONCURRENCY`, `BACKOFF_BASE_MS`,
  `BACKOFF_CAP_MS`, `STUCK_JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`,
  `RESEND_API_KEY`, and the verified sending domain/from address. Their
  documented v1 defaults are: concurrency 5, maxAttempts 5, backoff base
  2s / cap 30s / jitter 20%, stuck timeout 5 min, poll interval 1s,
  sweep interval 60s, Resend request timeout 30s.

---

## 3. What Must Never Happen

Every rule below is a direct order. Breaking any one of them means the
task has **failed**, even if the app builds, the endpoint returns 200,
and the feature looks like it works. Where a PRD requirement number
exists, it is cited so you can trace the rule back to its source.

1. **Never call Resend from a Next.js API route or request handler.**
   Resend is called only from the worker process. (PRD §7, Technical
   Requirements)
2. **Never make `POST /api/jobs` do the email send inline or block on
   it.** It writes a `pending` row and returns `202` immediately.
   Nothing else. (PRD §3 Goals, FR1)
3. **Never create a second job row for a duplicate `idempotencyKey`
   from the same user.** Return the existing job instead. This is
   enforced at the database level via the unique constraint on
   `(userId, idempotencyKey)`, not just checked in application code.
   (PRD FR1, §7)
4. **Never let two workers process the same job.** The claim must be
   the single atomic `UPDATE ... SKIP LOCKED` statement in Section 2.
   A `SELECT` followed by a separate `UPDATE` is not acceptable, even
   if it "usually" works. (PRD FR2, §7)
5. **Never send the same email to a recipient twice.** Before calling
   Resend, check for an existing `JobOutput` for that job id and skip
   the call if one exists. On every call to Resend, including retries,
   pass the job id as the `Idempotency-Key` header. Both mechanisms are
   required — neither one alone satisfies this rule. (PRD FR7, §8)
6. **Never treat a `JobOutput.jobId` unique constraint violation as a
   job failure.** If the stuck job sweep caused two workers to race on
   the same job, the second write hitting the unique constraint must be
   caught and treated as a successful no-op, since output already
   exists. (PRD FR7, §9 Risks)
7. **Never retry a `400` or `422` response from Resend.** Set
   `attempts = maxAttempts` in the same write and let the job go
   directly to `dead`. Retrying a malformed request or an invalid
   recipient will fail identically every time and wastes spend. (PRD §6
   step 7, §9)
8. **Never let a `401` or `403` from Resend retry either.** Send it
   straight to `dead`, but log it with a distinct tag/prefix from a
   normal job failure — this is an API key or account problem, not a
   per-job problem, and retrying floods nothing but logs. (PRD §6 step 8)
9. **Never accept `userId` as a raw, client-supplied value.** It must
   be derived from an authenticated session or service token. The dead
   letter view and status endpoint scope visibility by `userId`; an
   unauthenticated value is a data-leak vector, letting one user read
   another user's job history and email content. (PRD §4, §7)
10. **Never let `GET /api/jobs/:id` or the dead letter view return a
    job belonging to a different user.** Return `404`, not the job, not
    an empty success. (PRD FR10)
11. **Never lose an audit event.** Every transition in FR4, FR5, FR8,
    and FR9 must write a `JobEvent` row. `JobEvent` is append-only —
    never update or delete a row in it outside of the 30-day cascade
    cleanup. (PRD FR11)
12. **Never build more than one job type in v1.** Only `email.send` is
    implemented. The `type` field exists in the schema for the future,
    but do not write validation, routing, or handler logic for any
    other value. Do not add a generic "job type registry" or "plugin
    system" — that is explicitly Phase 4 and not needed yet. (PRD §3
    Non-Goals, §13)
13. **Never run, deploy, or design for more than one worker process
    instance in v1.** `WORKER_CONCURRENCY` is enforced per-process,
    not globally. A second instance silently doubles real load against
    Resend's rate limit. If you think redundancy is needed, flag it —
    do not build it. (PRD §3 Non-Goals, §7, §9 Risks)
14. **Never build an admin role, cross-user job visibility, a
    notification system (email/webhook/Slack on dead jobs), or any
    pricing/billing/plan-tier logic.** These are explicitly out of
    scope for v1 (Phase 4 or later). Do not add them because they seem
    easy or "obviously needed." (PRD §3 Non-Goals, §8, §13)
15. **Never hardcode a config value that the PRD lists as
    environment-driven** (see the list in Section 2 above). Hardcoding
    any of them is a rule violation even if the value matches the
    documented default.
16. **A duplicate email reaching a real recipient is a severity-1
    defect, not a routine bug.** If you find or suspect a gap that
    could cause this, stop and flag it rather than shipping around it.
    (PRD §9 Risks)

---

## 4. How the Work Is Arranged

The PRD does not specify a folder layout. This is the required
structure. It exists specifically to keep the rule in Section 3, item 1
(Resend is worker-only) structurally enforced, not just remembered:

```
/
├── prisma/
│   └── schema.prisma              # exact models from Section 2 — do not diverge
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── jobs/
│   │   │       ├── route.ts               # POST /api/jobs (enqueue only, no Resend import allowed)
│   │   │       └── [id]/
│   │   │           ├── route.ts           # GET /api/jobs/:id
│   │   │           └── retry/
│   │   │               └── route.ts       # POST /api/jobs/:id/retry
│   │   └── dead-letters/
│   │       └── page.tsx                   # dead letter UI (GET /api/jobs?status=dead consumer)
│   ├── lib/
│   │   ├── db.ts                          # single shared Prisma client
│   │   ├── auth.ts                        # userId derivation — the ONLY place userId is resolved
│   │   └── jobs/
│   │       ├── enqueue.ts                 # idempotency-key check + insert
│   │       ├── backoff.ts                 # the exact formula from Section 2
│   │       └── types.ts                   # shared Job/JobEvent/JobOutput types
│   └── components/                        # dead letter UI components only
├── worker/
│   ├── index.ts                           # polling loop entrypoint — the only process that imports resendClient.ts
│   ├── claim.ts                           # the exact SKIP LOCKED SQL from Section 2
│   ├── sweep.ts                           # FR8 stuck job sweep
│   ├── resendClient.ts                    # Resend SDK wrapper — imported ONLY by worker/
│   └── handlers/
│       └── emailSend.ts                   # the one v1 job type handler; new handlers go in new files here, never inline in index.ts
├── scripts/
│   └── cleanup.ts                         # 30-day cascade retention job
├── .env.example                           # every config var from Section 2, no real secrets
├── AGENTS.md
└── package.json
```

Rules that follow from this layout, not just suggestions:

- Anything under `src/app/api/` must never import `worker/resendClient.ts`
  or call Resend directly. If a route needs email-send logic, it enqueues
  a job — it does not reach into the worker's code.
- `worker/` must never import anything from `src/app/` (no Next.js
  request/response types, no React). The worker is a plain Node process
  and must be runnable with `node worker/index.ts` alone, independent of
  the Next.js app.
- `src/lib/auth.ts` is the single place `userId` gets resolved from an
  authenticated source. No file outside it may read a raw `userId` off a
  request body or header and trust it.
- A new job type (Phase 4, not now) gets its own file under
  `worker/handlers/`, never added as a branch inside `emailSend.ts`.

---

## 5. How the Code Should Look

- **Runtime**: Node.js LTS (current active LTS at time of build). Pin
  the version in `.nvmrc` / `engines` in `package.json`. Do not target a
  non-LTS or bleeding-edge version.
- **TypeScript**: `strict: true` in `tsconfig.json`. No `any` — use
  `unknown` and narrow, or define a real type. No `@ts-ignore` to make
  an error disappear; fix the type or flag why it's unavoidable.
- **Style**: Prettier for formatting, ESLint for linting, both run
  clean before you consider anything done. Consistent naming: `camelCase`
  for variables/functions, `PascalCase` for types/components, files
  named for what they export.
- **Functions**: small, single-purpose, named for what they do
  (`claimNextJob`, not `doStuff`). Prefer `async`/`await` over raw
  Promise chains. No deeply nested callbacks.
- **No magic numbers.** Every numeric constant that appears in Section 2
  (backoff base, cap, jitter, timeouts, concurrency) comes from
  `process.env`, not a literal typed into the middle of a function.
- **No dead code, no commented-out code, no speculative abstractions**
  ("just in case we need multiple providers later"). Build what the PRD
  and this file specify, nothing more.
- **Errors**: never swallow an error silently. Every `catch` either
  handles the specific case it's designed for (like the `JobOutput`
  unique-constraint no-op in Section 3, item 6) or re-throws with
  context. No empty `catch {}` blocks.
- **Comments**: explain *why*, not *what* the code already says.
  Reserve comments for non-obvious decisions (e.g., "must be raw SQL,
  see AGENTS.md §2 — Prisma's query builder can't express SKIP LOCKED").

---

## 6. What Counts as Done

Before calling any task complete, produce a checklist and verify every
line against the actual code, not from memory. A task is not done if
any box below is unchecked.

- [ ] `pnpm build` (or equivalent) completes with **zero** errors and
      zero TypeScript errors.
- [ ] `pnpm lint` completes with zero errors.
- [ ] Prisma schema matches Section 2 exactly — models, enum values,
      relations, `onDelete: Cascade`, indexes.
- [ ] `POST /api/jobs` returns `202` immediately, never awaits a Resend
      call, and honors the `(userId, idempotencyKey)` uniqueness rule
      (duplicate key returns the existing job, no new row created).
- [ ] Worker claim uses the exact `SKIP LOCKED` raw SQL from Section 2 —
      confirm no read-then-write path exists anywhere in `worker/`.
- [ ] `WORKER_CONCURRENCY` is respected — no more than N jobs in flight
      at once.
- [ ] On success: `JobOutput` written with `providerMessageId` + raw
      response, status → `succeeded`, `finishedAt` set, `JobEvent`
      written.
- [ ] On retryable failure (timeout / 429 / 5xx): `attempts` incremented,
      `lastError` set, status → `pending` directly (never through a
      `failed` state), `runAt` set using the exact backoff formula,
      `JobEvent` written.
- [ ] On exhausted failure (`attempts >= maxAttempts`): status →
      `dead` directly, `JobEvent` written.
- [ ] On 400/422 from Resend: job goes straight to `dead`, no retry
      attempted.
- [ ] On 401/403 from Resend: job goes straight to `dead`, logged with
      a distinct configuration-error tag.
- [ ] Every Resend call, including retries, sends the job id as the
      `Idempotency-Key` header.
- [ ] Before any Resend call, the worker checks for an existing
      `JobOutput` and skips the call if one exists.
- [ ] The `JobOutput.jobId` unique-constraint violation path is
      implemented and treated as a success no-op, not a failure.
- [ ] Stuck job sweep (FR8) resets `processing` jobs past the timeout
      to `pending`, increments `attempts`, writes a distinct `JobEvent`.
- [ ] `GET /api/jobs/:id` returns `404` for jobs not owned by the
      requesting `userId`.
- [ ] `GET /api/jobs?status=dead` and `POST /api/jobs/:id/retry` are
      scoped to the requesting `userId`; retry resets `attempts = 0`,
      status → `pending`, `runAt = now()`, and logs `actingUserId`.
- [ ] `userId` is derived only through `src/lib/auth.ts` — grep for any
      other place a raw `userId` is read from a request.
- [ ] All config values in Section 2 are environment variables with no
      hardcoded fallback values baked into logic.
- [ ] Scheduled cleanup script deletes `Job` rows older than 30 days and
      cascade-deletes their `JobOutput`/`JobEvent` rows without a
      foreign-key error.
- [ ] No code exists for: a second job type, an admin role,
      cross-user visibility, notifications on dead jobs, spend caps, or
      multiple worker instance coordination. If any of these exist in
      the codebase, remove them — they are Phase 4 or later.
- [ ] Final checklist output includes a plain list of which PRD FRs
      (FR1–FR11) and which Section 3 rules above were verified, not
      just "looks good."

---

## 7. What to Do When Unsure

- **Never invent a feature, endpoint, field, or scope that isn't in the
  PRD or this file.** If the PRD is silent and you need to make a call
  to move forward, choose the narrowest interpretation that satisfies
  the explicit requirement, implement only that, and say plainly in
  your output what you assumed and why.
- **Never write speculative or "just in case" code** — extra
  abstraction layers, unused config hooks, provider-swapping interfaces,
  half-built handlers for job types that don't exist yet. This is the
  spaghetti this file exists to prevent. If it isn't required by an FR
  or a locked choice, don't write it.
- **If a PRD Open Question (Section 14 of the PRD) blocks a concrete
  implementation decision** — for example, the verified sending domain,
  the worker's deployment target, or the `userId` auth mechanism — do
  not guess a production value. Use a clearly-named placeholder
  environment variable, note the open question in your output, and
  move on to what you can build without it.
- **If you find a genuine contradiction** between the PRD and this
  file, or between two parts of this file, stop and surface it instead
  of silently picking a side.
- **When truly stuck between two valid approaches**, pick the one that
  is simplest, smallest, and most directly satisfies the specific FR or
  rule in front of you — not the one that's most "extensible" or
  "future-proof." Future phases are not your problem today.