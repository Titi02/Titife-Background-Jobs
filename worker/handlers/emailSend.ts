import { prisma } from "../../src/lib/db";
import { Job, EmailPayload } from "../../src/lib/jobs/types";
import { calculateBackoffMs } from "../../src/lib/jobs/backoff";
import { sendEmailViaResend } from "../resendClient";
import { JobStatus, Prisma } from "@prisma/client";

export async function handleEmailSend(job: Job): Promise<void> {
  // FR7: Check for existing JobOutput before calling Resend
  const existingOutput = await prisma.jobOutput.findUnique({
    where: { jobId: job.id },
  });

  if (existingOutput) {
    // Already sent! Mark succeeded and record event.
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.succeeded,
          finishedAt: new Date(),
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.succeeded,
          message: "Skipped Resend call; output already exists (FR7 Idempotency Guard)",
        },
      }),
    ]);
    return;
  }

  const payload = job.payload as unknown as EmailPayload;

  // Call Resend API wrapper
  const result = await sendEmailViaResend({
    jobId: job.id,
    payload,
  });

  if (result.success) {
    try {
      // Write JobOutput
      await prisma.jobOutput.create({
        data: {
          jobId: job.id,
          providerMessageId: result.providerMessageId,
          raw: result.rawResponse as Prisma.InputJsonValue,
        },
      });
    } catch (outputErr: unknown) {
      // AGENTS.md §3 Rule 6 & FR7: Unique constraint violation on JobOutput.jobId is a success no-op
      if (
        typeof outputErr === "object" &&
        outputErr !== null &&
        "code" in outputErr &&
        (outputErr as { code: string }).code === "P2002"
      ) {
        console.log(`[Worker] JobOutput already written for job ${job.id} during race condition; treating as success.`);
      } else {
        throw outputErr;
      }
    }

    // Update Job status to succeeded
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.succeeded,
          finishedAt: new Date(),
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.succeeded,
          message: `Email sent successfully. Resend message ID: ${result.providerMessageId || "N/A"}`,
        },
      }),
    ]);
    return;
  }

  // Handle Failure
  const errorMsg = (result.errorMessage || "Unknown email send error").substring(0, 2000);
  const status = result.errorStatus;

  // Rule 7: 400 or 422 immediately non-retryable -> dead
  const isBadRequest = status === 400 || status === 422;

  // Rule 8: 401 or 403 immediately non-retryable -> dead with distinct config-error tag
  const isAuthError = status === 401 || status === 403;

  const isImmediateDead = isBadRequest || isAuthError;

  if (isImmediateDead) {
    const errorPrefix = isAuthError ? "[CONFIG_ERROR] " : "[NON_RETRYABLE_400/422] ";
    const finalError = (errorPrefix + errorMsg).substring(0, 2000);

    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.dead,
          attempts: job.maxAttempts,
          lastError: finalError,
          finishedAt: new Date(),
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.dead,
          message: `Non-retryable failure (HTTP ${status || "Client Error"}): ${finalError}`,
        },
      }),
    ]);
    return;
  }

  // Retryable failure path (429, 5xx, timeout, network error)
  const isExhausted = job.attempts >= job.maxAttempts;

  if (isExhausted) {
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.dead,
          lastError: errorMsg,
          finishedAt: new Date(),
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.dead,
          message: `Retries exhausted after ${job.attempts} attempts. Final error: ${errorMsg}`,
        },
      }),
    ]);
  } else {
    // Retryable: calculate backoff delay and set status directly back to pending (FR5)
    const backoffMs = calculateBackoffMs(job.attempts);
    const nextRunAt = new Date(Date.now() + backoffMs);

    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.pending,
          runAt: nextRunAt,
          lastError: errorMsg,
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.pending,
          message: `Attempt ${job.attempts}/${job.maxAttempts} failed: ${errorMsg}. Scheduled retry in ${backoffMs}ms at ${nextRunAt.toISOString()}`,
        },
      }),
    ]);
  }
}
