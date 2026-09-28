import { prisma } from "../src/lib/db";
import { JobStatus } from "@prisma/client";

/**
 * Runs scheduled sweep for stuck jobs (FR8).
 * Resets jobs in 'processing' state past STUCK_JOB_TIMEOUT_MS back to 'pending'.
 */
export async function sweepStuckJobs(): Promise<number> {
  if (!process.env.STUCK_JOB_TIMEOUT_MS) {
    throw new Error("STUCK_JOB_TIMEOUT_MS environment variable is not defined");
  }
  const timeoutMs = parseInt(process.env.STUCK_JOB_TIMEOUT_MS, 10);
  const cutoff = new Date(Date.now() - timeoutMs);

  const stuckJobs = await prisma.job.findMany({
    where: {
      status: JobStatus.processing,
      startedAt: {
        lt: cutoff,
      },
    },
  });

  if (stuckJobs.length === 0) {
    return 0;
  }

  console.log(`[Sweep] Found ${stuckJobs.length} stuck jobs processing past timeout (${timeoutMs}ms)`);

  let resetCount = 0;
  for (const job of stuckJobs) {
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.pending,
          attempts: {
            increment: 1,
          },
          runAt: new Date(),
          lastError: `[STUCK_JOB_SWEEP] Reset to pending after timeout exceeding ${timeoutMs}ms`,
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: job.id,
          fromStatus: JobStatus.processing,
          toStatus: JobStatus.pending,
          message: `Stuck job sweep reset job to pending after processing timeout exceeding ${timeoutMs}ms`,
        },
      }),
    ]);
    resetCount++;
  }

  return resetCount;
}
