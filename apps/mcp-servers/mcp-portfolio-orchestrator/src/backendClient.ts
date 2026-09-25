/**
 * Minimal typed HTTP client for the feature backend (the ONLY data surface —
 * this server holds no database credentials).
 */

export class BackendError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.payload = payload;
  }
}

export interface BackendClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }
  return typeof payload === "string" && payload.trim().length > 0 ? payload : fallback;
}

export function createBackendClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): BackendClient {
  const request = async <T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new BackendError(
        0,
        null,
        `Backend ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      throw new BackendError(
        res.status,
        payload,
        `Backend ${method} ${path} -> ${res.status}: ${toErrorMessage(payload, res.statusText)}`,
      );
    }
    return payload as T;
  };

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}