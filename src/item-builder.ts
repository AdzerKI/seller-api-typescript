import { createHash } from 'node:crypto';
import type { Model3dOrientationDto, SellerCatalogItemDto } from './api/types.gen.ts';
import { ItemFailure, type CatalogMapping, type Item, type ItemRecord } from './catalog.ts';

const URL_PATTERN = /^https?:\/\//;

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

const NUMERIC_FIELDS = new Set(['price', 'quantity', 'updateMonths']);

const ORIENTATION_AXES = ['rollDeg', 'pitchDeg', 'yawDeg'] as const;

const YES = 'да';

const NO = 'нет';

const URL_REQUIRED = 'URL_REQUIRED';

export class ItemBuilder {
  build(record: ItemRecord, mapping: CatalogMapping): Item {
    const key = record.key();
    const payload: Record<string, unknown> = {};
    for (const [field, path] of Object.entries(mapping.fields ?? {})) {
      const value = fieldValue(field, record.value(path));
      if (value !== undefined) payload[field] = value;
    }
    const sku = String(payload['sku'] ?? '');
    try {
      return item(record, mapping, key, sku, payload);
    } catch (failure) {
      if (!(failure instanceof ItemFailure)) throw failure;
      return { key, sku, payload: payload as SellerCatalogItemDto, fingerprint: '', failure };
    }
  }
}

function item(
  record: ItemRecord,
  mapping: CatalogMapping,
  key: string,
  sku: string,
  payload: Record<string, unknown>,
): Item {
  const categoryId = text(valueAt(record, mapping.category));
  if (categoryId !== undefined) payload['categoryId'] = categoryId;

  const attributes: Record<string, string> = {};
  for (const [name, path] of Object.entries(mapping.attributes ?? {})) {
    const value = text(record.value(path));
    if (value !== undefined) attributes[name] = value;
  }
  if (Object.keys(attributes).length > 0) payload['attributes'] = attributes;

  const roles = mapping.images ?? {};
  const cover = media(record, roles.cover).slice(0, 1);
  const second = media(record, roles.second)[0];
  const images = [
    ...new Set([...cover, ...media(record, roles.gallery), ...(second === undefined ? [] : [second])]),
  ];
  if (images.length > 0) payload['imageUrls'] = images;
  if (second !== undefined) payload['secondImageUrl'] = second;

  const model3dUrl = text(valueAt(record, mapping.model3d?.url));
  if (model3dUrl !== undefined) {
    payload['model3dUrl'] = model3dUrl;
    const orientation = orientationOf(valueAt(record, mapping.model3d?.orientation));
    if (orientation !== undefined) payload['model3dOrientation'] = orientation;
  }

  const manager = text(valueAt(record, mapping.package?.manager));
  const packageName = text(valueAt(record, mapping.package?.name));
  if (manager !== undefined || packageName !== undefined) {
    payload['repositoryPackage'] = {
      ...(manager === undefined ? {} : { manager }),
      ...(packageName === undefined ? {} : { name: packageName }),
    };
  }
  const repositoryUrl = text(valueAt(record, mapping.package?.git));
  if (repositoryUrl !== undefined) payload['packageGitSource'] = { repositoryUrl };

  const variants = (mapping.variants ?? []).flatMap((variant) => {
    const price = fieldValue('price', valueAt(record, variant.price));
    if (price === undefined) return [];
    const fileUrls = media(record, variant.files);
    const updateMonths = fieldValue('updateMonths', valueAt(record, variant.updateMonths));
    return [
      {
        name: variant.name,
        price,
        includes3dModel: variant.includes3dModel ?? false,
        ...(fileUrls.length > 0 ? { fileUrls } : {}),
        ...(updateMonths === undefined ? {} : { updateMonths }),
      },
    ];
  });
  if (variants.length > 0) payload['variants'] = variants;

  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { key, sku, payload: payload as SellerCatalogItemDto, fingerprint };
}

function valueAt(record: ItemRecord, path: string | undefined): unknown {
  return path === undefined ? undefined : record.value(path);
}

function media(record: ItemRecord, path: string | undefined): string[] {
  if (path === undefined) return [];
  const value = record.value(path);
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (entry === null || entry === undefined || entry === '') return [];
    const url = String(entry);
    if (!URL_PATTERN.test(url)) {
      throw new ItemFailure(ItemFailure.VALIDATION_ERROR, { [path]: URL_REQUIRED });
    }
    return [url];
  });
}

function fieldValue(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const textValue = String(value);
  return NUMERIC_FIELDS.has(field) && NUMBER_PATTERN.test(textValue) ? Number(textValue) : textValue;
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value ? YES : NO;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object' && value.toString !== Object.prototype.toString) {
    return String(value);
  }
  return undefined;
}

function orientationOf(value: unknown): Model3dOrientationDto | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const axes = parsed as Record<string, unknown>;
  const orientation: Record<string, number> = {};
  for (const axis of ORIENTATION_AXES) {
    const angle = Number(axes[axis]);
    if (axes[axis] === null || axes[axis] === '' || !Number.isFinite(angle)) return undefined;
    orientation[axis] = Math.trunc(angle);
  }
  return orientation as Model3dOrientationDto;
}
