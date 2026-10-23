import { randomUUID } from 'node:crypto';
import type { SellerCatalogSyncResultDto } from './api/types.gen.ts';
import { ApiError } from './api-error.ts';
import { ItemFailure, type CatalogSource, type Item } from './catalog.ts';
import { ItemBuilder } from './item-builder.ts';
import type { ItemState, ItemStore } from './item-store.ts';
import type { SellerApiClient } from './seller-api-client.ts';
import { SyncReport } from './sync-report.ts';

export interface SyncOptions {
  readonly only?: string;
  readonly full?: boolean;
}

export class Synchronizer {
  readonly #client: SellerApiClient;
  readonly #store: ItemStore;
  readonly #batch: number;
  readonly #builder = new ItemBuilder();

  constructor(client: SellerApiClient, store: ItemStore, batch: number) {
    this.#client = client;
    this.#store = store;
    this.#batch = Math.max(1, batch);
  }

  async run(
    catalogs: Readonly<Record<string, CatalogSource>>,
    { only, full = false }: SyncOptions = {},
  ): Promise<SyncReport> {
    if (only !== undefined && !Object.hasOwn(catalogs, only)) throw new RangeError(only);
    const report = new SyncReport();
    for (const [name, catalog] of Object.entries(catalogs)) {
      if (only === undefined || only === name) await this.#catalog(name, catalog, full, report);
    }
    return report;
  }

  async #catalog(name: string, catalog: CatalogSource, full: boolean, report: SyncReport) {
    const known = new Map(await this.#store.load(name));
    const mapping = catalog.mapping();
    const seen = new Set<string>();
    let pending: Item[] = [];
    for await (const record of catalog.records()) {
      const item = this.#builder.build(record, mapping);
      seen.add(item.key);
      if (item.failure !== undefined) {
        await this.#failed(name, item, known, report, item.failure);
        continue;
      }
      const state = known.get(item.key);
      if (!full && state !== undefined && state.error === null && state.fingerprint === item.fingerprint) {
        report.skipped++;
        continue;
      }
      pending.push(item);
      if (pending.length >= this.#batch) {
        await this.#send(name, pending, known, report);
        pending = [];
      }
    }
    if (pending.length > 0) await this.#send(name, pending, known, report);

    const gone = [...known.values()].filter((state) => !seen.has(state.key));
    if (gone.length === 0) return;
    for (const state of gone) {
      if (state.advertisementId !== null) await this.#client.archive(state.advertisementId);
    }
    await this.#store.delete(
      name,
      gone.map((state) => state.key),
    );
    report.archived += gone.length;
  }

  async #send(catalog: string, items: Item[], known: Map<string, ItemState>, report: SyncReport) {
    let results: SellerCatalogSyncResultDto[];
    try {
      results = (await this.#client.sync(
        items.map((item) => item.payload),
        randomUUID(),
      )).results;
    } catch (failure) {
      if (!(failure instanceof ApiError) || !failure.rejected) throw failure;
      if (items.length > 1) {
        for (const item of items) await this.#send(catalog, [item], known, report);
        return;
      }
      const { title, errors, details } = failure.problem;
      await this.#failed(
        catalog,
        items[0] as Item,
        known,
        report,
        new ItemFailure(title ?? String(failure.status), { ...errors, ...details }),
      );
      return;
    }
    for (const [index, result] of results.entries()) {
      await this.#applied(catalog, items[index] as Item, result, known, report);
    }
  }

  async #applied(
    catalog: string,
    item: Item,
    result: SellerCatalogSyncResultDto,
    known: Map<string, ItemState>,
    report: SyncReport,
  ) {
    const state = known.get(item.key);
    const advertisementId = result.advertisementId ?? null;
    const previous = state?.advertisementId ?? null;
    if (advertisementId !== null && previous !== null && previous !== advertisementId) {
      await this.#client.archive(previous);
    }
    const error = result.error ?? null;
    const details = error === null ? null : (result.errorDetails ?? null);
    await this.#save(catalog, known, {
      key: item.key,
      sku: item.sku,
      advertisementId: advertisementId ?? previous,
      fingerprint: item.fingerprint,
      error,
      errorDetails: details,
      syncedAt: error === null ? new Date() : (state?.syncedAt ?? null),
    });
    if (result.packageGitSource !== undefined) report.gitSource(catalog, item.sku, result.packageGitSource);
    if (error !== null) report.fail(catalog, item.sku, error, details);
    else if (result.created) report.created++;
    else report.updated++;
  }

  async #failed(
    catalog: string,
    item: Item,
    known: Map<string, ItemState>,
    report: SyncReport,
    failure: ItemFailure,
  ) {
    const state = known.get(item.key);
    const details = Object.keys(failure.details).length > 0 ? failure.details : null;
    await this.#save(catalog, known, {
      key: item.key,
      sku: item.sku,
      advertisementId: state?.advertisementId ?? null,
      fingerprint: state?.fingerprint ?? null,
      error: failure.error,
      errorDetails: details,
      syncedAt: state?.syncedAt ?? null,
    });
    report.fail(catalog, item.sku, failure.error, details);
  }

  async #save(catalog: string, known: Map<string, ItemState>, state: ItemState) {
    await this.#store.save(catalog, state);
    known.set(state.key, state);
  }
}
