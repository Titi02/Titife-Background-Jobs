import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(
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

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      lastError: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  // PRD Rule 10: Return 404 if job does not exist or does not belong to requesting userId
  if (!job || job.userId !== user.userId) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Remove userId from output before returning to client (or format per FR10)
  const { userId: _, ...jobResponse } = job;
  return NextResponse.json(jobResponse, { status: 200 });
}
