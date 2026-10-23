import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CancelFulfillmentRequestDto,
  DeliveryDocumentType,
  DispatchFulfillmentRequestDto,
  FulfillmentResponseDto,
  FulfillmentStatus,
  PageResponseDtoFulfillmentResponseDto,
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

export const FULFILLMENTS_PATH = '/rest/v1/order/seller/fulfillments';

export const FULFILLMENT_PATH = '/rest/v1/order/seller/fulfillments/%s';

export const DISPATCH_PATH = '/rest/v1/order/seller/fulfillments/%s/dispatch';

export const CANCEL_PATH = '/rest/v1/order/seller/fulfillments/%s/cancel';

export const SHIPMENT_DOCUMENT_PATH = '/rest/v1/logistics/seller/shipments/%s/document';

export const API_KEY_HEADER = 'X-API-Key';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const RETRY_AFTER_HEADER = 'Retry-After';

const JSON_TYPE = 'application/json';

const PDF_TYPE = 'application/pdf';

const NOT_FOUND = 404;

const MILLIS_PER_SECOND = 1000;

export interface FulfillmentsQuery {
  readonly statuses?: readonly FulfillmentStatus[];
  readonly from?: Date;
  readonly to?: Date;
  readonly page?: number;
  readonly size?: number;
}

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
    return decode(await response.text()) as SellerCatalogSyncResponseDto;
  }

  async archive(advertisementId: string): Promise<void> {
    try {
      await this.#send('DELETE', AD_PATH + encodeURIComponent(advertisementId));
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== NOT_FOUND) throw failure;
    }
  }

  async fulfillments(query: FulfillmentsQuery = {}): Promise<PageResponseDtoFulfillmentResponseDto> {
    const parameters = new URLSearchParams();
    if (this.#config.organizationId !== undefined) {
      parameters.set('organizationId', this.#config.organizationId);
    }
    if (query.from !== undefined) parameters.set('from', query.from.toISOString());
    if (query.to !== undefined) parameters.set('to', query.to.toISOString());
    parameters.set('page', String(query.page ?? 0));
    parameters.set('size', String(query.size ?? 20));
    for (const status of query.statuses ?? []) parameters.append('status', status);
    const response = await this.#send('GET', `${FULFILLMENTS_PATH}?${parameters}`);
    return decode(await response.text()) as PageResponseDtoFulfillmentResponseDto;
  }

  async fulfillment(fulfillmentId: string): Promise<FulfillmentResponseDto> {
    const response = await this.#send('GET', path(FULFILLMENT_PATH, fulfillmentId));
    return decode(await response.text()) as FulfillmentResponseDto;
  }

  dispatch(
    fulfillmentId: string,
    request: DispatchFulfillmentRequestDto,
  ): Promise<FulfillmentResponseDto> {
    return this.#action(DISPATCH_PATH, fulfillmentId, request);
  }

  cancel(fulfillmentId: string, reason?: string): Promise<FulfillmentResponseDto> {
    const request: CancelFulfillmentRequestDto = { reason: reason ?? null };
    return this.#action(CANCEL_PATH, fulfillmentId, request);
  }

  async shipmentDocument(shipmentId: string, type: DeliveryDocumentType): Promise<Uint8Array> {
    const query = new URLSearchParams({ type });
    const response = await this.#send(
      'GET',
      `${path(SHIPMENT_DOCUMENT_PATH, shipmentId)}?${query}`,
      undefined,
      undefined,
      PDF_TYPE,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async #action(
    pattern: string,
    fulfillmentId: string,
    request: object,
  ): Promise<FulfillmentResponseDto> {
    const body = JSON.stringify(request);
    const key = createHash('sha256').update(fulfillmentId + pattern + body).digest('hex');
    const response = await this.#send('POST', path(pattern, fulfillmentId), request, key);
    return decode(await response.text()) as FulfillmentResponseDto;
  }

  async #send(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    accept: string = JSON_TYPE,
  ): Promise<Response> {
    const times = Math.max(1, this.#config.retryTimes ?? DEFAULT_RETRY_TIMES);
    const sleep = this.#config.retrySleepMs ?? DEFAULT_RETRY_SLEEP_MS;
    const headers: Record<string, string> = {
      [API_KEY_HEADER]: this.#config.key,
      Accept: accept,
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
      if (response.ok) return response;
      const error = new ApiError(
        response.status,
        decode(await response.text()) as Problem,
        response.headers,
      );
      if (attempt >= times || !error.transient) throw error;
      await delay(pause(response.headers, sleep));
    }
  }
}

function path(pattern: string, id: string): string {
  return pattern.replace('%s', encodeURIComponent(id));
}

function pause(headers: Headers, sleep: number): number {
  const retryAfter = headers.get(RETRY_AFTER_HEADER);
  return retryAfter !== null && /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * MILLIS_PER_SECOND
    : sleep;
}
