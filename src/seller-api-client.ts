import { setTimeout as delay } from 'node:timers/promises';
import type {
  SellerCatalogItemDto,
  SellerCatalogSyncRequestDto,
  SellerCatalogSyncResponseDto,
} from './api/types.gen.ts';
import { ApiError, decode, type Problem } from './api-error.ts';
import {
  DEFAULT_RETRY_SLEEP_MS,
  DEFAULT_RETRY_TIMES,
  DEFAULT_TIMEOUT_MS,
  type ClientConfig,
} from './client-config.ts';

export const SYNC_PATH = '/rest/v1/advertisement/seller/ads/sync';

export const AD_PATH = '/rest/v1/advertisement/seller/ads/';

export const API_KEY_HEADER = 'X-API-Key';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const RETRY_AFTER_HEADER = 'Retry-After';

const JSON_TYPE = 'application/json';

const NOT_FOUND = 404;

const MILLIS_PER_SECOND = 1000;

export class SellerApiClient {
  readonly #config: ClientConfig;
  readonly #fetch: typeof fetch;

  constructor(config: ClientConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async sync(
    items: SellerCatalogItemDto[],
    idempotencyKey: string,
  ): Promise<SellerCatalogSyncResponseDto> {
    const body: SellerCatalogSyncRequestDto = {
      items,
      publish: this.#config.publish ?? true,
      ...(this.#config.organizationId === undefined
        ? {}
        : { organizationId: this.#config.organizationId }),
    };
    const response = await this.#send('POST', SYNC_PATH, body, idempotencyKey);
    return decode(response) as SellerCatalogSyncResponseDto;
  }

  async archive(advertisementId: string): Promise<void> {
    try {
      await this.#send('DELETE', AD_PATH + encodeURIComponent(advertisementId));
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== NOT_FOUND) throw failure;
    }
  }

  async #send(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<string> {
    const times = Math.max(1, this.#config.retryTimes ?? DEFAULT_RETRY_TIMES);
    const sleep = this.#config.retrySleepMs ?? DEFAULT_RETRY_SLEEP_MS;
    const headers: Record<string, string> = {
      [API_KEY_HEADER]: this.#config.key,
      Accept: JSON_TYPE,
      ...(body === undefined ? {} : { 'Content-Type': JSON_TYPE }),
      ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_HEADER]: idempotencyKey }),
    };
    const url = this.#config.url.replace(/\/+$/, '') + path;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (failure) {
        if (attempt >= times) throw failure;
        await delay(sleep);
        continue;
      }
      const text = await response.text();
      if (response.ok) return text;
      const error = new ApiError(response.status, decode(text) as Problem, response.headers);
      if (attempt >= times || !error.transient) throw error;
      await delay(pause(response.headers, sleep));
    }
  }
}

function pause(headers: Headers, sleep: number): number {
  const retryAfter = headers.get(RETRY_AFTER_HEADER);
  return retryAfter !== null && /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * MILLIS_PER_SECOND
    : sleep;
}
