import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { resolveUserIdFromHeaders } from "@/lib/auth";
import type { JobStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  succeeded: "Succeeded",
  dead: "Dead",
};

const STATUS_CLASS: Record<JobStatus, string> = {
  pending: "badge-pending",
  processing: "badge-processing",
  succeeded: "badge-success",
  dead: "badge-dead",
};

function getRecipient(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const to = (payload as { to?: unknown }).to;
  if (typeof to === "string") return to;
  if (Array.isArray(to)) return typeof to[0] === "string" ? to[0] : "";
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

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(value: Date | null): string {
  return value ? timestampFormatter.format(new Date(value)) : "—";
}

interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  payload: unknown;
}

export default async function JobsPage() {
  const userId = resolveUserIdFromHeaders(await headers());

  let jobs: JobRow[] = [];
  if (userId) {
    jobs = (await prisma.job.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        payload: true,
      },
    })) as JobRow[];
  }

  return (
    <div>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <span className="current" aria-current="page">
          Jobs
        </span>
        <span className="separator" aria-hidden="true">|</span>
        <Link href="/dead-letters">Dead Letter Queue</Link>
        <span className="separator" aria-hidden="true">|</span>
        <Link href="/create">Send Email</Link>
      </nav>

      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Jobs</h1>
          <p className="page-description">
            Read-only status of the current user&apos;s jobs across all states.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            Recent jobs
            {jobs.length > 0 ? (
              <span className="count-pill">{jobs.length}</span>
            ) : null}
          </div>
        </div>

        {jobs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <span aria-hidden="true">✓</span>
            </div>
            <h2 className="empty-state-title">No jobs yet</h2>
            <p className="empty-state-desc">
              Enqueue an email job to see it appear here.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Recipient</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Created</th>
                  <th scope="col">Started</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Last error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const recipient = getRecipient(job.payload);
                  return (
                    <tr key={job.id}>
                      <td>{job.type}</td>
                      <td>
                        <span title={recipient}>
                          {recipient ? maskEmail(recipient) : "—"}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${STATUS_CLASS[job.status]}`}>
                          {STATUS_LABEL[job.status]}
                        </span>
                      </td>
                      <td>
                        <span className="attempts">{job.attempts}</span>
                        <span className="attempts-sub"> / {job.maxAttempts}</span>
                      </td>
                      <td>
                        <time className="timestamp" dateTime={job.createdAt.toISOString()}>
                          {formatTimestamp(job.createdAt)}
                        </time>
                      </td>
                      <td>
                        <time className="timestamp" dateTime={job.startedAt?.toISOString()}>
                          {formatTimestamp(job.startedAt)}
                        </time>
                      </td>
                      <td>
                        <time className="timestamp" dateTime={job.finishedAt?.toISOString()}>
                          {formatTimestamp(job.finishedAt)}
                        </time>
                      </td>
                      <td>
                        <span className="error-text" title={job.lastError ?? undefined}>
                          {job.lastError
                            ? job.lastError.length > 80
                              ? `${job.lastError.slice(0, 80)}…`
                              : job.lastError
                            : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
