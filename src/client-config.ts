export interface ClientConfig {
  readonly url: string;
  readonly key: string;
  readonly organizationId?: string;
  readonly publish?: boolean;
  readonly retryTimes?: number;
  readonly retrySleepMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export const DEFAULT_RETRY_TIMES = 3;

export const DEFAULT_RETRY_SLEEP_MS = 1000;

export const DEFAULT_TIMEOUT_MS = 30_000;
