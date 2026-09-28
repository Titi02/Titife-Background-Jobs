import { Resend } from "resend";
import { EmailPayload } from "../src/lib/jobs/types";

let resendInstance: Resend | null = null;

function getResendInstance(): Resend {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY environment variable is not defined");
    }
    resendInstance = new Resend(apiKey);
  }
  return resendInstance;
}

export interface SendEmailParams {
  jobId: string;
  payload: EmailPayload;
}

export interface SendEmailResult {
  success: boolean;
  providerMessageId?: string;
  rawResponse?: unknown;
  errorStatus?: number;
  errorMessage?: string;
}

/**
 * Wraps a promise with a timeout. Rejects with a timeout error if the promise
 * doesn't settle within the specified duration.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Resend request timed out after ${ms}ms`)),
      ms
    );
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err: unknown) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Sends transactional email via Resend API.
 * Passes jobId as Idempotency-Key header on every request (PRD FR7 & AGENTS.md §3 Rule 5).
 */
export async function sendEmailViaResend(params: SendEmailParams): Promise<SendEmailResult> {
  const { jobId, payload } = params;
  const resend = getResendInstance();

  if (!process.env.RESEND_FROM_EMAIL) {
    throw new Error("RESEND_FROM_EMAIL environment variable is not defined");
  }
  if (!process.env.RESEND_REQUEST_TIMEOUT_MS) {
    throw new Error("RESEND_REQUEST_TIMEOUT_MS environment variable is not defined");
  }
  const defaultFrom = process.env.RESEND_FROM_EMAIL;
  const resendTimeoutMs = parseInt(process.env.RESEND_REQUEST_TIMEOUT_MS, 10);
  const fromAddress = payload.from || defaultFrom;

  try {
    type CreateEmailOptions = Parameters<typeof resend.emails.send>[0];
    const emailOptions = {
      from: fromAddress,
      to: payload.to,
      subject: payload.subject,
      ...(payload.html ? { html: payload.html } : {}),
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      headers: {
        ...(payload.headers || {}),
        "Idempotency-Key": jobId,
      },
    } as CreateEmailOptions;

    const response = await withTimeout(resend.emails.send(emailOptions), resendTimeoutMs);

    if (response.error) {
      const errorMsg = response.error.message || "Resend API returned error";
      const statusCode = (response.error as { statusCode?: number }).statusCode;

      return {
        success: false,
        providerMessageId: undefined,
        rawResponse: response.error,
        errorStatus: statusCode,
        errorMessage: errorMsg,
      };
    }

    return {
      success: true,
      providerMessageId: response.data?.id,
      rawResponse: response.data,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown network error calling Resend";
    const statusCode = (err as { statusCode?: number; status?: number }).statusCode ||
      (err as { statusCode?: number; status?: number }).status;

    return {
      success: false,
      rawResponse: err,
      errorStatus: statusCode,
      errorMessage: message,
    };
  }
}
