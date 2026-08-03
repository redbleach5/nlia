import 'server-only';

// ============================================================================
// summarizeLlmError — extract short diagnostic info from any LLM/AI SDK error.
// ============================================================================
//
// Problem: AI SDK errors come as objects with shape:
//   { name: 'AI_APICallError', url, requestBodyValues, statusCode,
//     responseHeaders, responseBody, isRetryable, data }
// `requestBodyValues` contains the ENTIRE system prompt + message history —
// logging the full object dumps KBs of text per error.
//
// This helper extracts only diagnostic bits (message, statusCode, url,
// isRetryable, responseBody excerpt) — safe to log without leaking prompts.
//
// Used by:
//   - src/lib/chat/pipeline.ts (streamText onError)
//   - src/lib/agent/runner.ts (streamText onError in executeStep)

export interface LlmErrorSummary {
  message: string;
  name?: string;
  statusCode?: number;
  url?: string;
  responseBody?: string;
  isRetryable?: boolean;
}

/**
 * Summarize any error (Error instance, AI SDK error object, plain object, string)
 * into a short diagnostic shape suitable for logging.
 *
 * Handles:
 *   - Error instances (uses .message + .name)
 *   - AI SDK wrapper { error: <real error> } (unwraps one level)
 *   - Errors where message is missing but data.error.message or responseBody
 *     contains the real message
 *   - Errors where Error.message contains JSON with AI_APICallError
 *     (re-parses recursively)
 *   - Plain strings
 */
export function summarizeLlmError(err: unknown): LlmErrorSummary {
  if (err instanceof Error) {
    // Sometimes Error.message contains JSON (when caller did
    // `new Error(JSON.stringify(obj))`). Re-parse to extract structured fields.
    if (err.message.startsWith('{') && err.message.includes('AI_APICallError')) {
      try {
        const parsed = JSON.parse(err.message);
        return summarizeLlmError(parsed);
      } catch { /* fall through */ }
    }
    return { message: err.message, name: err.name };
  }

  if (err && typeof err === 'object') {
    const e = err as {
      message?: string; name?: string; statusCode?: number;
      url?: string; isRetryable?: boolean;
      responseBody?: string;
      data?: { error?: { message?: string } } | { error?: { message?: string }[] };
      error?: unknown;
    };

    // AI SDK sometimes wraps in { error: <real error> }.
    // Unwrap one level if the wrapper lacks the structured fields itself.
    if (e.error && typeof e.error === 'object' && !('statusCode' in e) && !('responseBody' in e)) {
      return summarizeLlmError(e.error);
    }

    let msg = e.message;

    // AI SDK errors often nest the real message in data.error.message.
    if (!msg || msg === '(no message)') {
      const dataErr = Array.isArray(e.data) ? e.data[0]?.error : e.data?.error;
      if (dataErr?.message) msg = dataErr.message;
    }

    // Try parsing responseBody (JSON string) for error.message.
    if (!msg && e.responseBody) {
      try {
        const parsed = JSON.parse(e.responseBody);
        msg = parsed?.error?.message ?? parsed?.message;
      } catch {
        msg = e.responseBody.slice(0, 200);
      }
    }

    return {
      message: msg ?? '(no message)',
      name: e.name,
      statusCode: e.statusCode,
      url: e.url,
      responseBody: e.responseBody?.slice(0, 300),
      isRetryable: e.isRetryable,
    };
  }

  return { message: String(err) };
}
