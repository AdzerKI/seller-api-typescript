import type { PackageGitSourceDto } from './api/types.gen.ts';

export interface SyncFailure {
  readonly catalog: string;
  readonly sku: string;
  readonly error: string;
  readonly details: Record<string, unknown>;
}

export interface SyncGitSource {
  readonly catalog: string;
  readonly sku: string;
  readonly source: PackageGitSourceDto;
}

export class SyncReport {
  created = 0;
  updated = 0;
  skipped = 0;
  archived = 0;
  readonly failures: SyncFailure[] = [];
  readonly gitSources: SyncGitSource[] = [];

  fail(catalog: string, sku: string, error: string, details: Record<string, unknown> | null): void {
    this.failures.push({ catalog, sku, error, details: details ?? {} });
  }

  gitSource(catalog: string, sku: string, source: PackageGitSourceDto): void {
    this.gitSources.push({ catalog, sku, source });
  }
}
