"use client";

import { useEffect, useRef } from "react";

export interface DeadJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobDetailsModalProps {
  job: DeadJob | null;
  requeuing: boolean;
  onRequeue: (jobId: string) => void;
  onClose: () => void;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
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

function getSubject(job: DeadJob): string | undefined {
  const subject = job.payload?.subject;
  return typeof subject === "string" ? subject : undefined;
}

function XIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function JobDetailsModal({
  job,
  requeuing,
  onRequeue,
  onClose,
}: JobDetailsModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!job) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [job, onClose]);

  if (!job) return null;

  const recipient = getRecipient(job);
  const subject = getSubject(job);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-details-title"
      >
        <div className="modal-header">
          <div>
            <h2 className="modal-title" id="job-details-title">
              Job details
            </h2>
            <p className="modal-subtitle">{job.id}</p>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close job details"
          >
            <XIcon />
          </button>
        </div>

        <div className="modal-body">
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-label">Status</div>
              <div className="detail-value">
                <span className="badge badge-dead">Dead</span>
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-label">Type</div>
              <div className="detail-value">{job.type}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">Attempts</div>
              <div className="detail-value">
                {job.attempts} of {job.maxAttempts} exhausted
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-label">Recipient</div>
              <div className="detail-value">{recipient || "—"}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">Created</div>
              <div className="detail-value">
                {formatTimestamp(job.createdAt)}
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-label">Last updated</div>
              <div className="detail-value">
                {formatTimestamp(job.updatedAt)}
              </div>
            </div>
            {subject ? (
              <div className="detail-item">
                <div className="detail-label">Subject</div>
                <div className="detail-value">{subject}</div>
              </div>
            ) : null}
          </div>

          <h3 className="modal-section-title">Failure reason</h3>
          <pre className="code-block code-block-wrap">
            {job.lastError ?? "No error recorded."}
          </pre>

          <h3 className="modal-section-title">Job payload</h3>
          <pre className="code-block code-block-wrap">
            {JSON.stringify(job.payload, null, 2)}
          </pre>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => onRequeue(job.id)}
            disabled={requeuing}
          >
            {requeuing ? "Requeuing…" : "Requeue job"}
          </button>
        </div>
      </div>
    </div>
  );
}
