import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { JobStatus } from "@prisma/client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
  }

  const existingJob = await prisma.job.findUnique({
    where: { id },
  });

  if (!existingJob || existingJob.userId !== user.userId) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (existingJob.status !== JobStatus.dead) {
    return NextResponse.json(
      { error: `Only jobs with status 'dead' can be retried. Current status is '${existingJob.status}'.` },
      { status: 400 }
    );
  }

  const [updatedJob] = await prisma.$transaction([
    prisma.job.update({
      where: { id },
      data: {
        status: JobStatus.pending,
        attempts: 0,
        runAt: new Date(),
        lastError: null,
      },
    }),
    prisma.jobEvent.create({
      data: {
        jobId: id,
        fromStatus: JobStatus.dead,
        toStatus: JobStatus.pending,
        message: "Manual retry triggered via API",
        actingUserId: user.userId,
      },
    }),
  ]);

  return NextResponse.json(
    {
      id: updatedJob.id,
      status: updatedJob.status,
      attempts: updatedJob.attempts,
      runAt: updatedJob.runAt,
      message: "Job manually requeued for retry",
    },
    { status: 200 }
  );
}
