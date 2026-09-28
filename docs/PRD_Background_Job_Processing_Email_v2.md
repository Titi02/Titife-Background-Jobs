**PRD: Background Job Processing System**

*Email Sending via Resend — v2 (post-review revision)*

# 1\. Product Summary

This system moves slow or unreliable work out of the HTTP request path. A client enqueues a job, gets back a job id immediately, and the actual work runs in a separate worker process. The chosen unit of work is sending a transactional email through Resend, a real third-party email provider. The system guarantees at-least-once execution, automatic retry with backoff, recovery from crashed workers, and a full audit trail of every status change. Jobs that exhaust retries land in a dead letter queue for manual review and retry.

At-least-once execution is made safe by an idempotency guard (FR7) that checks for a prior send before calling Resend again, and by passing the job id as Resend's own idempotency key on every attempt, including retries.

# 2\. Problem Statement

Calling a real email provider directly inside a request handler is unreliable. These calls are slow relative to a request-response cycle, fail intermittently (timeouts, provider rate limits, transient 5xx responses), and offer no way to recover cleanly from a partial failure. Without a job system, a failed send either hangs the user's request or silently loses the email. Without idempotency, a retried send can deliver the same email twice, which is directly visible and damaging to the recipient's trust, unlike most other kinds of duplicated background work. Without an audit trail, nobody can tell whether an email actually went out, failed, or is stuck.

# 3\. Goals and Non-Goals

## Goals

* Return control to the client within milliseconds of a job request, never blocking on the Resend API call.

* Guarantee a job either succeeds, or fails permanently in a visible dead letter state. No silent loss.

* Guarantee no two workers process the same job.

* Guarantee retries do not result in the same email being sent to the recipient twice.

* Make every state transition auditable after the fact.

## Non-Goals

* No full authentication system. User identification only, and that identification must come from an authenticated source (see Section 7).

* No admin role or cross-user visibility in v1.

* No notification system (email, webhook, Slack) alerting engineers when a job goes dead, in v1.

* No landing page or marketing UI.

* Only one job type, email.send, is implemented and validated in v1. The type field on the Job model is schema-generic to support future job types (for example, PDF generation or image resizing), but no validation, routing, or handling logic exists for any value other than email.send yet.

* No horizontal autoscaling or multiple concurrent worker instances in v1. Exactly one worker process instance is assumed to be running at any time (see Section 7 and Section 9).

# 4\. User Personas

| Persona | Description | Needs |
| :---- | :---- | :---- |
| Requesting Client | A backend service or internal application that triggers an email send on behalf of an authenticated user | Fast, non-blocking enqueue; a way to poll for the result |
| End User / Recipient | The person who will receive the email, or whose action in the product triggered it (e.g., a password reset or a receipt) | The email eventually sent exactly once, or a visible failure a human can act on, never silently lost and never duplicated |
| On-call Engineer | The person who checks in or gets paged when jobs pile up in dead status | A dead letter view with enough context (payload, error) to diagnose and retry without reading raw logs |

userId is derived from an authenticated source (session or service-to-service auth token) and is never accepted as a raw, unauthenticated client-supplied field. This matters specifically because the dead letter view (FR9) and the status endpoint (FR10) scope visibility by userId; an unauthenticated or spoofable identity would let one user read another user's job history and email content. The exact authentication mechanism is an open question (Section 14\) if none exists yet in the surrounding system.

# 5\. Functional Requirements

## FR1: Enqueue

POST /api/jobs accepts type (fixed to "email.send" in v1), payload (JSON, see Section 6 for shape), idempotencyKey, and an authenticated userId. Creates a row with status \= pending. Returns 202 Accepted with the job id. If idempotencyKey already exists for that user, returns the existing job's id and current status instead of creating a new row. Does not call Resend inline.

## FR2: Worker Claim

The worker polls on an interval (default 1 second, configurable) for jobs where status \= pending and runAt \<= now(). It claims one job per available concurrency slot using a single atomic statement that selects the oldest eligible row, locks it, and flips it to processing in one round trip, so two workers can never claim the same row. The exact SQL is specified in Section 7\.

## FR3: Concurrency Cap

The worker holds at most N jobs in flight, N read from configuration (default 5). It does not claim a new job until a slot frees up. N is enforced per worker process instance; see Section 7 for why v1 assumes exactly one running instance.

## FR4: Execution and Success

On a successful send, the worker writes the Resend message id and the raw provider response to the JobOutput relation, sets status \= succeeded, sets finishedAt \= now(), and writes a JobEvent row recording the transition.

## FR5: Execution and Failure

On a thrown error, the worker increments attempts, writes the error message to lastError (truncated to 2000 characters), and writes a JobEvent row for the failure. The failure flow has exactly two outcomes, and there is no intermediate "failed" status and no separate retry scheduler:

* Retryable failure: if attempts \< maxAttempts, status goes directly from processing back to pending, and runAt is set to now() plus a backoff delay (FR6). The same worker claim query (FR2) picks the job back up once runAt has passed.

* Exhausted failure: if attempts \>= maxAttempts, status goes directly from processing to dead. No further automatic retry occurs; the job now requires a manual retry from the dead letter view (FR9).

attempts counts total execution tries, including the first. It is incremented at claim time (FR2), not only on failure, so that maxAttempts \= 5 means exactly 5 total tries, no more and no less.

## FR6: Backoff Calculation

backoff(attempts) \= min(30000, 2000 \* 2^attempts) \+ random(0, backoff \* 0.2) milliseconds. Base 2000ms, cap 30000ms, jitter up to 20 percent, applied whenever a job returns from processing to pending under FR5.

## FR7: Idempotent Work

Before calling Resend, the worker checks whether a JobOutput already exists for this job id. If it does, the worker skips the API call and marks the job succeeded. This covers the case where a worker crashes after Resend has already accepted the send but before the local row was updated.

On every call to Resend, including retries, the worker passes the job's id as the Idempotency-Key header on the request. This lets Resend itself de-duplicate a retried request that it already processed, even if the worker's own local check did not catch it, for example because the worker crashed before writing JobOutput at all.

Race from the stuck job sweep: if the stuck job sweep (FR8) resets a job that was actually still being processed by a live worker, two workers can end up completing the same send and both attempting to write JobOutput. JobOutput.jobId is unique, so the second write will throw a database constraint violation. The worker must catch that specific violation and treat it as a successful no-op, since the job already has output, rather than as a job failure.

## FR8: Stuck Job Sweep

A scheduled sweep (runs every 60 seconds) finds jobs where status \= processing and startedAt \< now() \- timeout (default timeout 5 minutes). It resets them to status \= pending, increments attempts, and writes a JobEvent row noting the reset was due to timeout, distinct from a normal execution failure.

## FR9: Dead Letter View

GET /api/jobs?status=dead returns the current user's dead jobs with payload, lastError, attempts, type, and createdAt. Each has a POST /api/jobs/:id/retry action that sets attempts \= 0, status \= pending, runAt \= now(), and writes a JobEvent row noting the manual retry and the acting userId.

## FR10: Status Endpoint

GET /api/jobs/:id returns id, status, attempts, maxAttempts, lastError, createdAt, startedAt, finishedAt. Returns 404 if the job does not belong to the requesting (authenticated) user.

## FR11: Audit Trail

Every transition in FR4, FR5, FR8, and FR9 writes a JobEvent row with jobId, fromStatus, toStatus, message, and createdAt. This table is append-only. It is the mechanism for reconstructing what happened to any job, subject to the 30-day retention limit described in Section 12\.

# 6\. Email Sending Pipeline

This section replaces the prior AI-processing pipeline. The unit of work is a single transactional email sent through the Resend API.

1. Client submits a request via POST /api/jobs with type \= "email.send" and a payload containing to, from, subject, and either html or text body content (plus optional replyTo and headers).

2. Job is written as pending. Client receives the job id immediately.

3. Worker claims the job (FR2), checks for an existing JobOutput by jobId (FR7 idempotency guard).

4. If no output exists, the worker calls Resend's send endpoint with the payload, passing the job id as the Idempotency-Key header, and a request timeout (30 seconds).

5. On a successful (2xx) response, the worker writes the returned Resend message id and the raw response body to JobOutput, then marks the job succeeded.

6. On a timeout, a 429 (rate limited), or a 5xx response from Resend, the worker throws, and FR5's retryable failure path applies (processing to pending with backoff).

7. On a 400 or 422 response indicating a malformed request or an invalid recipient address, the worker treats this as immediately non-retryable: attempts is set to maxAttempts in the same failure write, so the job goes directly from processing to dead rather than retrying a request that will fail identically every time.

8. On a 401 or 403 response, the worker also treats this as immediately non-retryable and dead, but logs it distinctly (a message prefix or a separate lastError tag) since this indicates an API key or account configuration problem, not a per-job problem, and flooding retries will not fix it.

9. Client polls GET /api/jobs/:id until status is succeeded, dead, or the client gives up.

# 7\. Technical Requirements

* Framework: Next.js (App Router) for the API routes and dead letter UI. TypeScript throughout.

* Database: PostgreSQL, accessed via Prisma ORM.

* Email provider: Resend, called via its HTTPS API (or official Node SDK) from the worker process only. The Next.js request handlers never call Resend directly.

* Worker process: a standalone Node.js script, not a Next.js API route and not a serverless function, run as a persistent process, since serverless execution environments cannot sustain a polling loop. Deployed as a long-running process (container or VM); the exact hosting target is an open question (Section 14).

* Atomicity: the claim query selects and locks a single eligible row and marks it processing in one statement, executed as raw SQL through Prisma's \$queryRaw, not a read-then-write pattern:

UPDATE "Job"  
SET status \= 'processing', "startedAt" \= now(), attempts \= attempts \+ 1  
WHERE id \= (  
  SELECT id FROM "Job"  
  WHERE status \= 'pending' AND "runAt" \<= now()  
  ORDER BY "runAt" ASC  
  FOR UPDATE SKIP LOCKED  
  LIMIT 1  
)  
RETURNING \*;

SELECT ... FOR UPDATE SKIP LOCKED selects and locks one eligible row per call, in runAt order, so concurrent workers never block on or double-claim the same row, and older jobs are served first.

* Idempotency enforcement: idempotencyKey has a unique constraint in the database, scoped per userId. Enforced at the schema level, not just application logic.

* Provider-side idempotency: the job id is passed as Resend's Idempotency-Key header on every send attempt, including retries (FR7).

* Concurrency: WORKER\_CONCURRENCY (N) is enforced per worker process instance. v1 assumes exactly one worker process instance running at a time. Running multiple instances is explicitly out of scope for v1 and would exceed the intended Resend rate limit, since N is not coordinated globally. If redundancy is needed later, N must become a globally coordinated limit (for example, a count tracked in the database or a distributed semaphore), not a per-process config value.

* Configuration: MAX\_ATTEMPTS, WORKER\_CONCURRENCY, BACKOFF\_BASE\_MS, BACKOFF\_CAP\_MS, STUCK\_JOB\_TIMEOUT\_MS, POLL\_INTERVAL\_MS, RESEND\_API\_KEY, and the verified sending domain/from address are all environment-driven, not hardcoded.

* Identity: userId is derived from an authenticated session or service token, never accepted as a raw client-supplied field (see Section 4).

* Scheduled cleanup: a daily cron-triggered job deletes Job rows (and their related JobEvent and JobOutput rows, via cascade) older than 30 days, to bound table growth. See Section 12 for the audit-retention tradeoff this creates.

# 8\. Business Model

This is internal infrastructure, not a directly monetized product. Its value is indirect: it reduces wasted Resend spend from unnecessary or duplicated sends, prevents user-facing requests from hanging on a slow provider call, and gives engineering a single place to diagnose failures instead of grepping logs. It also directly protects the product's reputation with recipients: because the idempotency guard (FR7) is specifically designed to prevent the same email being sent twice, this system avoids a failure mode that, unlike most background-job duplication, is immediately visible to and damaging with the end user. There is no pricing, billing, or plan-tier logic in this PRD's scope. See Section 11 for the metric that substantiates the cost-avoidance claim.

# 9\. Risks

| Risk | Impact | Mitigation |
| :---- | :---- | :---- |
| Worker process crashes and is not restarted | Jobs pile up as pending; no emails send | Run the worker under a process supervisor with auto-restart; monitor pending queue depth |
| Resend cost or rate-limit pressure from retries on genuinely bad input | Wasted spend and API quota on jobs that will never succeed | 400/422 errors are treated as immediately non-retryable (Section 6, step 7\) |
| Thundering herd on Resend after an outage | Backoff without jitter would retry every failed job at the same instant | Jitter is included in FR6 specifically to prevent this |
| Idempotency key collision across unrelated jobs | A legitimate new job silently merges into an old one | The unique constraint is scoped to (userId, idempotencyKey), not global |
| Dead letter queue grows unnoticed | Failed sends go undetected without a human actively checking the UI | Out of scope for v1 since notifications are excluded; flagged as an open question |
| Stuck job sweep falsely resets a job whose worker was merely slow, not dead | Two workers can both complete the same send and both attempt to write JobOutput | FR7 requires catching the JobOutput.jobId unique constraint violation as a no-op success, not a failure |
| Multiple worker instances run in the same deployment | Concurrency cap N is per-process only; real load against Resend becomes N times the number of instances, breaking the intended rate limit | v1 is explicitly restricted to one running worker instance (Section 7); global coordination is required before adding redundancy |
| A duplicate email reaches the recipient despite the idempotency guard | Directly visible, reputational harm; unlike most job duplication this is not an internal-only defect | Both the local JobOutput check and the Resend Idempotency-Key header (FR7) must be present; treat any future evidence of a duplicate send as a severity-1 defect, not a routine bug |

# 10\. Prisma Data Model

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
  events          JobEvent\[\]  
   
  @@unique(\[userId, idempotencyKey\])  
  @@index(\[status, runAt\])  
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
   
  job                Job      @relation(fields: \[jobId\], references: \[id\], onDelete: Cascade)  
}  
   
model JobEvent {  
  id            String     @id @default(cuid())  
  jobId         String  
  fromStatus    JobStatus?  
  toStatus      JobStatus  
  message       String?  
  actingUserId  String?  
  createdAt     DateTime   @default(now())  
   
  job           Job        @relation(fields: \[jobId\], references: \[id\], onDelete: Cascade)  
   
  @@index(\[jobId, createdAt\])  
}

Note: the JobStatus enum has four values, not five. There is no stored "failed" state. A retryable failure writes directly from processing back to pending (FR5); an exhausted failure writes directly from processing to dead. This is a deliberate simplification: it avoids a separate retry scheduler and keeps the state machine to two terminal states (succeeded, dead) and two working states (pending, processing).

Both JobOutput and JobEvent cascade-delete when their parent Job is deleted, so the scheduled cleanup in Section 7 can delete a Job row without a foreign-key failure. This also means the audit trail does not outlive the 30-day retention window; see Section 12\.

# 11\. Success Metrics

| Metric | Definition | Target |
| :---- | :---- | :---- |
| Job success rate | succeeded / (succeeded \+ dead), counted only for jobs that have reached a terminal state | No fixed target until 2 weeks of production data establish a baseline |
| Dead rate | dead / (succeeded \+ dead), the same denominator as success rate, excluding jobs still pending or processing | No fixed target until 2 weeks of production data establish a baseline |
| Time to completion (p50) | finishedAt minus createdAt for succeeded jobs | Under 15 seconds |
| Time to completion (p95) | same, 95th percentile | Under 60 seconds |
| Retry rate | jobs with attempts \> 1 divided by total jobs | Under 20 percent |
| Stuck job sweep triggers per day | count of jobs reset by FR8 | Near zero; a sustained nonzero rate signals a worker health problem |
| Resend spend attributable to retries | (total provider cost across all attempts for a job) minus (cost of a single successful attempt), summed across all jobs, tracked weekly | Track from day one; this is the metric that substantiates the cost-avoidance claim in Section 8 |

Job success rate and Dead rate previously used inconsistent denominators (one counted only terminal jobs, the other counted all jobs ever created) and both carried a fixed numeric target with no baseline data to support it. Both issues are corrected above: the denominators now match, and both targets are deferred until two weeks of real production data exist.

# 12\. Assumptions

* Single job type in v1: email.send, sent through Resend.

* Client generates the idempotency key; it is also passed to Resend as the Idempotency-Key header on every attempt.

* Worker is a standalone Node process, not serverless, and v1 assumes exactly one running worker instance at a time.

* Config defaults: concurrency 5, maxAttempts 5, backoff base 2s capped at 30s with 20 percent jitter, stuck job timeout 5 minutes, poll interval 1 second, sweep interval 60 seconds, Resend request timeout 30 seconds.

* There is no stored "failed" status and no separate retry scheduler. A retryable failure moves a job directly from processing to pending; an exhausted failure moves it directly from processing to dead. attempts is incremented at claim time and counts total tries, including the first.

* Job output is a provider message id and raw response, stored in a JobOutput row separate from the input payload.

* Resend response codes 429 and 5xx, and request timeouts, are retryable. Codes 400 and 422 are treated as immediately dead. Codes 401 and 403 are treated as immediately dead and logged as a distinct configuration-error category.

* JobOutput and JobEvent cascade-delete with their parent Job. The audit trail (JobEvent) is retained for the same 30 days as the parent Job, then permanently deleted. This system does not provide a permanent or long-term audit record. If audit requirements exceed 30 days, retention must be extended before this ships.

* A stuck job reset by the sweep (FR8) can race with a still-live worker completing the same job. This is handled by catching the JobOutput.jobId unique constraint violation as a no-op success, not a failure (FR7).

* No notifications in v1. Status is pull-only via polling.

* No admin role in v1; users see only their own jobs, and userId must come from an authenticated source, never a raw client-supplied value.

* Concurrency cap N is enforced per worker process instance, not globally; this is only safe as long as exactly one instance runs.

# 13\. Phased Roadmap

## Phase 1: Core engine

Job table, JobEvent table, enqueue endpoint with idempotency enforcement, worker with atomic SKIP LOCKED claim, direct success/pending/dead failure handling (FR5), backoff with jitter, Resend integration with the Idempotency-Key header.

Note: without the Phase 2 stuck job sweep, a crashed worker mid-send leaves that job stuck in processing indefinitely until Phase 2 ships. Acceptable for an initial internal deployment; do not treat Phase 1 alone as production-ready for external, customer-facing use.

## Phase 2: Reliability

Stuck job sweep (FR8), the JobOutput unique-constraint race handling it requires (FR7), and concurrency cap enforcement.

## Phase 3: Operability

Dead letter view, manual retry endpoint, status endpoint polish, scheduled 30-day cleanup job with cascading deletes.

## Phase 4 (post-v1, not in current scope)

Admin cross-user view, notifications on dead jobs, per-user or per-org Resend spend caps, globally coordinated concurrency for multiple worker instances, and additional job types beyond email.send (for example, PDF generation or image resizing).

# 14\. Open Questions

* Which verified sending domain and default from address should the worker use for Resend sends?

* Does the product need email templates managed in Resend, or is fully rendered HTML always supplied in the payload?

* Is attachment support required for v1, or can it be deferred to Phase 4 alongside additional job types?

* What is the actual deployment target for the worker process: container, VM, specific PaaS?

* Is a notification (email, webhook, Slack) needed when a job goes dead, given there is currently no way to know without checking the UI?

* Is there a budget or spend cap per job or per user needed to bound Resend cost from retries?

* Does audit retention (JobEvent) need to exceed 30 days, now that cascade delete makes that limit explicit and permanent?

* Will multiple worker instances ever be needed for redundancy, given the concurrency cap is currently per-process only and not globally coordinated?

* What is the actual mechanism for deriving userId (session, service token, or something else), since the current PRD requires it be authenticated but does not specify how?