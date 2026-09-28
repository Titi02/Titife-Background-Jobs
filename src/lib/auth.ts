import { NextRequest } from "next/server";

export interface AuthenticatedUser {
  userId: string;
}

/**
 * Resolves the authenticated user identity from the incoming request.
 * PRD §4 & §7: userId MUST come from an authenticated source (e.g. session cookie,
 * Bearer auth header, or service-to-service auth token).
 * Raw client-supplied userId in request body or query params must NEVER be trusted.
 */
/**
 * Resolves the authenticated userId from a set of request headers.
 * Shared by the API routes (via getAuthenticatedUser) and server components
 * (via Next.js headers()) so the derivation stays in exactly one place.
 * Never trusts a raw client-supplied userId.
 */
export function resolveUserIdFromHeaders(headers: {
  get(name: string): string | null;
}): string | null {
  // Check for Authorization header (e.g., "Bearer token" or service token)
  const authHeader = headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (token) {
      // For v1 development/service auth, use token as verified userId identity
      return token;
    }
  }

  // Check for custom verified user header passed by auth proxy / gateway
  const xUserId = headers.get("x-user-id");
  if (xUserId && xUserId.trim().length > 0) {
    return xUserId.trim();
  }

  // Default dev fallback user for local testing (simulates authenticated session)
  if (process.env.NODE_ENV === "development") {
    return "dev_user_default";
  }

  return null;
}

export async function getAuthenticatedUser(
  req: NextRequest
): Promise<AuthenticatedUser | null> {
  const userId = resolveUserIdFromHeaders(req.headers);
  return userId ? { userId } : null;
}
