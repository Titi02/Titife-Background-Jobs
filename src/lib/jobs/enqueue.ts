import { prisma } from "../db";
import { EmailPayload, Job } from "./types";
import { Prisma } from "@prisma/client";

export interface EnqueueParams {
  userId: string;
  type: string;
  payload: EmailPayload;
  idempotencyKey: string;
}

export async function enqueueJob(params: EnqueueParams): Promise<{ job: Job; created: boolean }> {
  const { userId, type, payload, idempotencyKey } = params;

  if (type !== "email.send") {
    throw new Error("Invalid job type. Only 'email.send' is supported in v1.");
  }

  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new Error("idempotencyKey is required.");
  }

  if (!payload || !payload.to || !payload.subject || (!payload.html && !payload.text)) {
    throw new Error("Invalid payload: 'to', 'subject', and either 'html' or 'text' are required.");
  }

  if (!process.env.MAX_ATTEMPTS) {
    throw new Error("MAX_ATTEMPTS environment variable is not defined");
  }
  const maxAttempts = parseInt(process.env.MAX_ATTEMPTS, 10);

  try {
    const job = await prisma.job.create({
      data: {
        userId,
        type,
        payload: payload as unknown as Prisma.InputJsonValue,
        idempotencyKey,
        maxAttempts,
        status: "pending",
      },
    });

    return { job, created: true };
  } catch (error: unknown) {
    // Check for Prisma unique constraint violation on (userId, idempotencyKey)
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const existingJob = await prisma.job.findUnique({
        where: {
          userId_idempotencyKey: {
            userId,
            idempotencyKey,
          },
        },
      });

      if (existingJob) {
        return { job: existingJob, created: false };
      }
    }
    throw error;
  }
}
