import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/db";

/**
 * 30-day retention cleanup script (PRD §7 & AGENTS.md §4).
 * Deletes Job rows older than 30 days. Related JobOutput and JobEvent rows
 * are automatically deleted via onDelete: Cascade foreign keys.
 */
async function runCleanup() {
  const retentionDays = 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  console.log(`[Cleanup Script] Purging jobs created before ${cutoff.toISOString()} (older than ${retentionDays} days)...`);

  const result = await prisma.job.deleteMany({
    where: {
      createdAt: {
        lt: cutoff,
      },
    },
  });

  console.log(`[Cleanup Script] Successfully purged ${result.count} expired job(s) and their cascading outputs/events.`);
}

runCleanup()
  .catch((err) => {
    console.error("[Cleanup Script] Error running cleanup job:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
