export interface ItemState {
  readonly key: string;
  readonly sku: string;
  readonly advertisementId: string | null;
  readonly fingerprint: string | null;
  readonly error: string | null;
  readonly errorDetails: Record<string, unknown> | null;
  readonly syncedAt: Date | null;
}

export interface ItemStore {
  load(catalog: string): Promise<ReadonlyMap<string, ItemState>>;
  save(catalog: string, state: ItemState): Promise<void>;
  delete(catalog: string, keys: readonly string[]): Promise<void>;
}
