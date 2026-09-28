import { prisma } from "../src/lib/db";
import { Job } from "../src/lib/jobs/types";

/**
 * Claims the next eligible pending job using atomic SELECT ... FOR UPDATE SKIP LOCKED.
 * AGENTS.md §2 & §3 Rule 4: Must be a single atomic UPDATE nested SQL query, never read-then-write.
 */
export async function claimNextJob(): Promise<Job | null> {
  const result = await prisma.$queryRaw<Job[]>`
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
  `;

  if (Array.isArray(result) && result.length > 0) {
    return result[0];
  }

  return null;
}
