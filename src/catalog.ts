import type { SellerCatalogItemDto } from './api/types.gen.ts';

export interface ItemRecord {
  key(): string;
  value(path: string): unknown;
}

export interface VariantMapping {
  readonly name: string;
  readonly price: string;
  readonly files?: string;
  readonly updateMonths?: string;
  readonly includes3dModel?: boolean;
}

export interface CatalogMapping {
  readonly category?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly images?: { readonly cover?: string; readonly second?: string; readonly gallery?: string };
  readonly model3d?: { readonly url?: string; readonly orientation?: string };
  readonly package?: { readonly manager?: string; readonly name?: string; readonly git?: string };
  readonly variants?: readonly VariantMapping[];
}

export interface CatalogSource {
  mapping(): CatalogMapping;
  records(): Iterable<ItemRecord> | AsyncIterable<ItemRecord>;
}

export class ItemFailure extends Error {
  static readonly VALIDATION_ERROR = 'VALIDATION_ERROR';

  readonly error: string;
  readonly details: Record<string, unknown>;

  constructor(error: string, details: Record<string, unknown> = {}) {
    super(error);
    this.name = 'ItemFailure';
    this.error = error;
    this.details = details;
  }
}

export interface Item {
  readonly key: string;
  readonly sku: string;
  readonly payload: SellerCatalogItemDto;
  readonly fingerprint: string;
  readonly failure?: ItemFailure;
}
