"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import JobDetailsModal from "./JobDetailsModal";
import type { DeadJob } from "./JobDetailsModal";

interface ToastState {
  kind: "success" | "error";
  message: string;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

function getRecipient(job: DeadJob): string {
  const to = job.payload?.to;
  if (typeof to === "string") return to;
  if (Array.isArray(to)) return String(to[0] ?? "");
  return "";
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const prefix = local.length >= 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${prefix}${"*".repeat(3)}@${domain}`;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "spin" : undefined}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XCircleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  note?: string;
  icon: ReactNode;
  tone: "red" | "green" | "neutral";
}

function StatCard({ label, value, note, icon, tone }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className={`stat-icon stat-icon-${tone}`}>{icon}</div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {note ? <div className="stat-note">{note}</div> : null}
      </div>
    </div>
  );
}

function SkeletonStats() {
  return (
    <div className="stats-grid" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div className="stat-card" key={index}>
          <span className="skeleton skeleton-icon" />
          <div style={{ flex: 1 }}>
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-value" />
          </div>
        </div>
      ))}
    </div>
  );
}

const SKELETON_COLUMNS = [
  "Job ID",
  "Recipient",
  "Failure reason",
  "Attempts",
  "Status",
  "Last updated",
  "",
];

function SkeletonTable() {
  return (
    <div className="table-wrap" aria-hidden="true">
      <table className="data-table">
        <thead>
          <tr>
            {SKELETON_COLUMNS.map((column) => (
              <th scope="col" key={column}>
                {column || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {SKELETON_COLUMNS.map((_, columnIndex) => (
                <td key={columnIndex}>
                  <span
                    className="skeleton skeleton-line"
                    style={{ width: `${48 + columnIndex * 7}%` }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DeadLetterQueue() {
  const [jobs, setJobs] = useState<DeadJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedJob, setSelectedJob] = useState<DeadJob | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs?status=dead");
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const message =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "The dead letter queue could not be loaded.";
        throw new Error(message);
      }
      const data = (await response.json()) as DeadJob[];
      setJobs(data);
      setLastUpdated(new Date());
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "The dead letter queue could not be loaded.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  const handleRetry = useCallback(
    async (jobId: string) => {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.add(jobId);
        return next;
      });
      try {
        const response = await fetch(`/api/jobs/${jobId}/retry`, {
          method: "POST",
        });
        const body = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        if (!response.ok) {
          const message =
            body && typeof body.error === "string" && body.error
              ? body.error
              : "This job could not be requeued.";
          showToast({ kind: "error", message });
          return;
        }
        setJobs((prev) => prev.filter((job) => job.id !== jobId));
        setSelectedJob((prev) => (prev?.id === jobId ? null : prev));
        showToast({
          kind: "success",
          message:
            "Job requeued — the worker will pick it up on its next poll.",
        });
      } catch {
        showToast({
          kind: "error",
          message: "Could not reach the server. The job was not requeued.",
        });
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [showToast],
  );

  const filteredJobs = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) => {
      const recipient = getRecipient(job).toLowerCase();
      const lastError = (job.lastError ?? "").toLowerCase();
      return (
        job.id.toLowerCase().includes(query) ||
        recipient.includes(query) ||
        lastError.includes(query)
      );
    });
  }, [jobs, filter]);

  const queuedSince = useMemo(() => {
    if (jobs.length === 0) return null;
    const earliest = jobs.reduce(
      (min, job) => Math.min(min, new Date(job.createdAt).getTime()),
      Number.POSITIVE_INFINITY,
    );
    return earliest === Number.POSITIVE_INFINITY
      ? null
      : new Date(earliest).toISOString();
  }, [jobs]);

  const showSkeleton = loading && jobs.length === 0 && error === null;
  const showError = error !== null && jobs.length === 0;
  const showEmpty = !loading && !error && jobs.length === 0;

  const panelSubtitle =
    jobs.length > 0
      ? filteredJobs.length !== jobs.length
        ? `${filteredJobs.length} of ${jobs.length} jobs shown`
        : `${jobs.length} job${jobs.length === 1 ? "" : "s"} awaiting manual resolution`
      : undefined;

  return (
    <div>
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Dead Letter Queue</h1>
          <p className="page-description">
            Review failed jobs that have exhausted their retry attempts and
            require manual inspection or requeuing.
          </p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => void fetchQueue()}
            disabled={loading}
          >
            <RefreshIcon spinning={loading} />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {showSkeleton ? (
        <SkeletonStats />
      ) : (
        <div className="stats-grid">
          <StatCard
            label="Dead jobs"
            value={error ? "—" : String(jobs.length)}
            note={
              lastUpdated
                ? `as of ${timeFormatter.format(lastUpdated)}`
                : undefined
            }
            icon={<AlertIcon />}
            tone="red"
          />
          <StatCard
            label="Queued since"
            value={queuedSince ? formatTimestamp(queuedSince) : "—"}
            note="Oldest job in the dead letter queue"
            icon={<ClockIcon />}
            tone="neutral"
          />
          <StatCard
            label="Last refreshed"
            value={lastUpdated ? timeFormatter.format(lastUpdated) : "—"}
            note={
              error ? "Latest refresh failed" : "Queue snapshot from the API"
            }
            icon={<CheckIcon />}
            tone="green"
          />
        </div>
      )}

      <div className="panel" aria-busy={loading}>
        <div className="panel-header">
          <div>
            <div className="panel-title">
              <LayersIcon />
              Dead letter queue
              {!error && jobs.length > 0 ? (
                <span className="count-pill">{jobs.length}</span>
              ) : null}
            </div>
            {panelSubtitle ? (
              <div className="panel-subtitle">{panelSubtitle}</div>
            ) : null}
          </div>
          <div className="panel-toolbar">
            <div className="search">
              <SearchIcon />
              <input
                className="search-input"
                type="search"
                placeholder="Search by ID, recipient, or error…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                disabled={jobs.length === 0}
                aria-label="Search jobs"
              />
            </div>
            {filter ? (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setFilter("")}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {showSkeleton ? (
          <SkeletonTable />
        ) : showError ? (
          <div className="error-state">
            <div className="error-state-icon">
              <AlertIcon />
            </div>
            <h2 className="empty-state-title">Couldn’t load the queue</h2>
            <p className="empty-state-desc">
              The dead letter queue is temporarily unavailable. Check your
              connection and try again.
            </p>
            <div className="empty-state-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void fetchQueue()}
              >
                <RefreshIcon />
                Try again
              </button>
            </div>
          </div>
        ) : showEmpty ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <InboxIcon />
            </div>
            <h2 className="empty-state-title">No dead-letter jobs</h2>
            <p className="empty-state-desc">
              All jobs are currently processing, pending, or completed
              successfully.
            </p>
            <div className="empty-state-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void fetchQueue()}
              >
                <RefreshIcon />
                Refresh queue
              </button>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Job ID</th>
                  <th scope="col">Recipient</th>
                  <th scope="col">Failure reason</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last updated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => {
                  const recipient = getRecipient(job);
                  const retrying = retryingIds.has(job.id);
                  return (
                    <tr key={job.id}>
                      <td>
                        <span className="job-id" title={job.id}>
                          {job.id}
                        </span>
                      </td>
                      <td>
                        <span title={recipient}>
                          {recipient ? maskEmail(recipient) : "—"}
                        </span>
                      </td>
                      <td>
                        <div className="error-cell">
                          <span className="error-dot" aria-hidden="true" />
                          <span
                            className="error-text"
                            title={job.lastError ?? undefined}
                          >
                            {job.lastError ?? "No error recorded"}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="attempts">{job.attempts}</span>
                        <span className="attempts-sub">
                          {" "}
                          / {job.maxAttempts}
                        </span>
                      </td>
                      <td>
                        <span className="badge badge-dead">Dead</span>
                      </td>
                      <td>
                        <time className="timestamp" dateTime={job.updatedAt}>
                          {formatTimestamp(job.updatedAt)}
                        </time>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            onClick={() => setSelectedJob(job)}
                          >
                            Details
                          </button>
                          <button
                            className="btn btn-primary btn-sm"
                            type="button"
                            onClick={() => void handleRetry(job.id)}
                            disabled={retrying}
                          >
                            {retrying ? "Requeuing…" : "Requeue"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="table-empty">
                        No jobs match “{filter}”.
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => setFilter("")}
                        >
                          Clear filter
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <JobDetailsModal
        job={selectedJob}
        requeuing={selectedJob ? retryingIds.has(selectedJob.id) : false}
        onRequeue={(jobId) => void handleRetry(jobId)}
        onClose={() => setSelectedJob(null)}
      />

      {toast ? (
        <div className="toast-region" role="status" aria-live="polite">
          <div className={`toast toast-${toast.kind}`}>
            {toast.kind === "success" ? <CheckIcon /> : <XCircleIcon />}
            <span>{toast.message}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
