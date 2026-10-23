const TOO_MANY_REQUESTS = 429;

const CONFLICT = 409;

const SERVER_ERROR = 500;

const CLIENT_ERROR = 400;

const REQUEST_IN_FLIGHT = 'IDEMPOTENCY_REQUEST_IN_FLIGHT';

export type Problem = {
  title?: string;
  status?: number;
  errors?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  readonly headers: Headers;

  constructor(status: number, problem: Problem, headers: Headers) {
    super(`${status} ${problem.title ?? ''}`.trim());
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.headers = headers;
  }

  get transient(): boolean {
    return (
      this.status === TOO_MANY_REQUESTS ||
      this.status >= SERVER_ERROR ||
      (this.status === CONFLICT && this.problem.details?.['idempotencyKey'] === REQUEST_IN_FLIGHT)
    );
  }

  get rejected(): boolean {
    return this.status >= CLIENT_ERROR && this.status < SERVER_ERROR && !this.transient;
  }
}

export function decode(text: string): Record<string, unknown> {
  if (text === '') return {};
  try {
    const decoded: unknown = JSON.parse(text);
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
