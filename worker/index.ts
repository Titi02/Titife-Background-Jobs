import dotenv from "dotenv";
dotenv.config();

import { claimNextJob } from "./claim";
import { handleEmailSend } from "./handlers/emailSend";
import { sweepStuckJobs } from "./sweep";
import { prisma } from "../src/lib/db";
import { JobStatus } from "@prisma/client";

if (!process.env.WORKER_CONCURRENCY) throw new Error("WORKER_CONCURRENCY environment variable is not defined");
if (!process.env.POLL_INTERVAL_MS) throw new Error("POLL_INTERVAL_MS environment variable is not defined");
if (!process.env.SWEEP_INTERVAL_MS) throw new Error("SWEEP_INTERVAL_MS environment variable is not defined");

const concurrencyLimit = parseInt(process.env.WORKER_CONCURRENCY, 10);
const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS, 10);
const sweepIntervalMs = parseInt(process.env.SWEEP_INTERVAL_MS, 10);

let activeJobsCount = 0;
let isShuttingDown = false;

console.log(`[Worker] Process started.`);
console.log(`[Worker] Concurrency Cap: ${concurrencyLimit}`);
console.log(`[Worker] Poll Interval: ${pollIntervalMs}ms`);
console.log(`[Worker] Sweep Interval: ${sweepIntervalMs}ms`);

async function pollLoop() {
  if (isShuttingDown) return;

  // FR3: Enforce concurrency cap per worker process
  while (activeJobsCount < concurrencyLimit && !isShuttingDown) {
    try {
      const job = await claimNextJob();
      if (!job) {
        // No pending jobs eligible right now
        break;
      }

      activeJobsCount++;
      console.log(`[Worker] Claimed job ${job.id} (type: ${job.type}, attempt: ${job.attempts}) [Active: ${activeJobsCount}/${concurrencyLimit}]`);

      // Process job asynchronously without blocking polling loop slot iteration
      (async () => {
        try {
          // Rule 11: Write JobEvent for pending → processing transition
          await prisma.jobEvent.create({
            data: {
              jobId: job.id,
              fromStatus: JobStatus.pending,
              toStatus: JobStatus.processing,
              message: `Job claimed by worker (attempt ${job.attempts})`,
            },
          });

          if (job.type === "email.send") {
            await handleEmailSend(job);
          } else {
            console.error(`[Worker] Unsupported job type '${job.type}' for job ${job.id}`);
          }
        } catch (err: unknown) {
          console.error(`[Worker] Unhandled handler error processing job ${job.id}:`, err);
        } finally {
          activeJobsCount--;
        }
      })();
    } catch (claimErr: unknown) {
      console.error("[Worker] Error during claim query:", claimErr);
      break;
    }
  }

  if (!isShuttingDown) {
    setTimeout(pollLoop, pollIntervalMs);
  }
}

// Scheduled stuck job sweep interval (FR8)
setInterval(async () => {
  if (isShuttingDown) return;
  try {
    await sweepStuckJobs();
  } catch (sweepErr: unknown) {
    console.error("[Worker] Error running stuck job sweep:", sweepErr);
  }
}, sweepIntervalMs);

// Start polling loop
pollLoop();

// Handle graceful shutdown
const shutdown = () => {
  console.log("[Worker] Shutdown signal received. Stopping worker polling...");
  isShuttingDown = true;
  setTimeout(() => {
    console.log("[Worker] Process exiting.");
    process.exit(0);
  }, 2000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
