"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";

type JobStatus = "pending" | "processing" | "succeeded" | "dead";

interface JobDetail {
  id: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface EnqueueResponse {
  id: string;
  status: JobStatus;
  idempotencyKey: string;
  createdAt: string;
  duplicate: boolean;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

function StatusBadge({ status }: { status: JobStatus }) {
  switch (status) {
    case "pending":
      return <span className="badge badge-pending">Pending</span>;
    case "processing":
      return <span className="badge badge-processing">Processing</span>;
    case "succeeded":
      return <span className="badge badge-success">Succeeded</span>;
    case "dead":
      return <span className="badge badge-dead">Dead</span>;
    default:
      return <span className="badge badge-neutral">{status}</span>;
  }
}

export default function CreateJobPage() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<EnqueueResponse | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [polling, setPolling] = useState(false);
  const pollCount = useRef(0);

  const generateKey = useCallback(() => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `key-${Date.now()}`;
  }, []);

  useEffect(() => {
    setIdempotencyKey(generateKey());
  }, [generateKey]);

  const fetchJob = useCallback(async (jobId: string): Promise<JobDetail | null> => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      const body = (await response.json().catch(() => null)) as JobDetail | null;
      return response.ok && body ? body : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!result) return;
    setPolling(true);
    pollCount.current = 0;
    void fetchJob(result.id).then((initial) => {
      if (initial) setJob(initial);
    });
    const timer = window.setInterval(async () => {
      pollCount.current += 1;
      const latest = await fetchJob(result.id);
      if (latest) setJob(latest);
      if (
        latest?.status === "succeeded" ||
        latest?.status === "dead" ||
        pollCount.current >= MAX_POLLS
      ) {
        setPolling(false);
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [result, fetchJob]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const recipient = to.trim();
    const subjectLine = subject.trim();
    const message = text.trim();

    if (!recipient || !subjectLine || !message) {
      setFormError("Recipient, subject, and message are required.");
      return;
    }
    if (!idempotencyKey) {
      setFormError("Idempotency key is not ready yet. Regenerate it and try again.");
      return;
    }

    setFormError(null);
    setSubmitting(true);
    setResult(null);
    setJob(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "email.send",
          payload: {
            to: recipient,
            subject: subjectLine,
            text: message,
          },
          idempotencyKey,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (EnqueueResponse & { error?: unknown })
        | null;
      if (!response.ok || !body) {
        const message =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "Enqueue failed. Check the server logs.";
        setFormError(message);
        return;
      }
      setResult({
        id: body.id,
        status: body.status,
        idempotencyKey: body.idempotencyKey,
        createdAt: body.createdAt,
        duplicate: body.duplicate,
      });
    } catch {
      setFormError("Could not reach the server. The job was not enqueued.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefreshStatus = async () => {
    if (!result) return;
    const latest = await fetchJob(result.id);
    if (latest) setJob(latest);
  };

  return (
    <div>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/jobs">Jobs</Link>
        <span className="separator" aria-hidden="true">
          /
        </span>
        <Link href="/dead-letters">Dead Letter Queue</Link>
        <span className="separator" aria-hidden="true">
          /
        </span>
        <span className="current" aria-current="page">
          Send Email
        </span>
      </nav>

      <div className="page-header">
        <div className="page-heading">
          <div className="title-row">
            <h1 className="page-title">Send Email</h1>
          </div>
          <p className="page-description">
            Enqueue an <span className="mono">email.send</span> job through the{" "}
            <span className="mono">POST /api/jobs</span> endpoint. The job is picked up by
            the worker and delivered via Resend.
          </p>
        </div>
      </div>

      <div className="panel panel-narrow">
        <div className="panel-header">
          <div className="panel-title">Enqueue an email.send job</div>
        </div>
        <div className="panel-body">
          <form onSubmit={handleSubmit} noValidate>
            <div className="form-field">
              <label className="form-label" htmlFor="recipient">
                Recipient
              </label>
              <input
                id="recipient"
                className="form-input"
                type="email"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="recipient@example.com"
                autoComplete="email"
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="subject">
                Subject
              </label>
              <input
                id="subject"
                className="form-input"
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Subject line"
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="message">
                Message
              </label>
              <textarea
                id="message"
                className="form-textarea"
                rows={5}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Plain-text email body (sent as payload.text)"
                required
              />
            </div>

            <div className="form-field">
              <div className="form-label-inline">
                <label className="form-label" htmlFor="idempotencyKey">
                  Idempotency key
                </label>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setIdempotencyKey(generateKey())}
                >
                  Regenerate
                </button>
              </div>
              <input
                id="idempotencyKey"
                className="form-input mono"
                type="text"
                value={idempotencyKey}
                readOnly
                aria-describedby="idempotency-hint"
              />
              <p className="form-hint" id="idempotency-hint">
                Auto-generated with crypto.randomUUID(). Re-enqueuing with the same key returns the existing
                job instead of creating a duplicate.
              </p>
            </div>

            {formError ? (
              <div className="form-error" role="alert">
                {formError}
              </div>
            ) : null}

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Enqueuing…" : "Enqueue Job"}
              </button>
              {result ? (
                <span className="form-hint" aria-live="polite">
                  {polling ? "Watching status…" : "Status polling stopped."}
                </span>
              ) : null}
            </div>
          </form>

          {result ? (
            <div className="result-block">
              <h2 className="modal-section-title">Enqueue result</h2>
              <div className="detail-grid">
                <div className="detail-item">
                  <div className="detail-label">Job ID</div>
                  <div className="detail-value mono">{result.id}</div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Initial status</div>
                  <div className="detail-value">
                    <StatusBadge status={result.status} />
                  </div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Duplicate</div>
                  <div className="detail-value">
                    {result.duplicate ? "Yes — existing job returned" : "No — new job created"}
                  </div>
                </div>
                <div className="detail-item">
                  <div className="detail-label">Created</div>
                  <div className="detail-value">{formatTimestamp(result.createdAt)}</div>
                </div>
              </div>

              <div className="result-block">
                <div className="result-heading">
                  <h2 className="modal-section-title">Live status</h2>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => void handleRefreshStatus()}
                    disabled={polling}
                  >
                    Refresh status
                  </button>
                </div>
                {job ? (
                  <>
                    <div className="detail-grid">
                      <div className="detail-item">
                        <div className="detail-label">Status</div>
                        <div className="detail-value">
                          <StatusBadge status={job.status} />
                        </div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Attempts</div>
                        <div className="detail-value">
                          {job.attempts} / {job.maxAttempts}
                        </div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Started</div>
                        <div className="detail-value">{job.startedAt ? formatTimestamp(job.startedAt) : "—"}</div>
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Finished</div>
                        <div className="detail-value">{job.finishedAt ? formatTimestamp(job.finishedAt) : "—"}</div>
                      </div>
                    </div>
                    {job.lastError ? (
                      <div className="field-gap">
                        <div className="detail-label">Last error</div>
                        <pre className="code-block code-block-wrap">{job.lastError}</pre>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="form-hint">Waiting for the worker to pick up the job…</p>
                )}
              </div>
            </div>
          ) : null}

          <p className="form-hint field-gap">
            Jobs only appear in the{" "}
            <Link className="btn-link" href="/dead-letters">
              Dead Letter Queue
            </Link>{" "}
            if they fail permanently and exhaust their retries.
          </p>
        </div>
      </div>
    </div>
  );
}