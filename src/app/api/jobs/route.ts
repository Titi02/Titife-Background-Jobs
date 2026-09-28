import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs/enqueue";
import { prisma } from "@/lib/db";
import { JobStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const { type, payload, idempotencyKey } = body;

  if (type !== "email.send") {
    return NextResponse.json({ error: "Only 'email.send' job type is supported in v1" }, { status: 400 });
  }

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return NextResponse.json({ error: "idempotencyKey string parameter is required" }, { status: 400 });
  }

  try {
    const { job, created } = await enqueueJob({
      userId: user.userId,
      type,
      payload,
      idempotencyKey,
    });

    return NextResponse.json(
      {
        id: job.id,
        status: job.status,
        idempotencyKey: job.idempotencyKey,
        createdAt: job.createdAt,
        duplicate: !created,
      },
      { status: 202 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to enqueue job";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");

  if (statusParam === "dead") {
    const deadJobs = await prisma.job.findMany({
      where: {
        userId: user.userId,
        status: JobStatus.dead,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        type: true,
        payload: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(deadJobs, { status: 200 });
  }

  return NextResponse.json({ error: "Filter query parameter status=dead is required" }, { status: 400 });
}
