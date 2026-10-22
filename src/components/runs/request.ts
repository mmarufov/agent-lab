export interface Job {
  id: string;
  kind: string;
  status: string;
  runId: string | null;
  reviewId: string | null;
  error: string | null;
  cancelRequested: boolean;
}
export interface Runner {
  busy: boolean;
  online: boolean;
  enabled: boolean;
  activeJob: Job | null;
}
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      data.error?.message ??
        "The local service could not complete the request.",
      response.status,
    );
  return data;
}
