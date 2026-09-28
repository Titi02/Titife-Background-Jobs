import { Job, JobEvent, JobOutput, JobStatus } from "@prisma/client";

export type { Job, JobEvent, JobOutput, JobStatus };

export interface EmailPayload {
  to: string | string[];
  from?: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | string[];
  headers?: Record<string, string>;
}

export interface EnqueueJobInput {
  type: "email.send";
  payload: EmailPayload;
  idempotencyKey: string;
}

export interface JobResponse {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}
