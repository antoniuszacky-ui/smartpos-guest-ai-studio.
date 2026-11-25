import 'dotenv/config';
import express, { type NextFunction, Request, Response } from 'express';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore,
  Timestamp,
  type DocumentData,
  type Firestore,
} from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelGuestOrderInTransaction,
  deleteCancelledGuestOrderInTransaction,
  isCancelledOrderStatus,
  isOrderLinkedToCashierTransaction,
  normalizeOrderStatusUpper,
  OwnerOrderActionError,
  type StoreRefLike,
  type TxLike,
} from './src/server/ownerOrderManagement.ts';
import {
  createLocalShippingRateQuoteHandler,
  createOwnerLocalShippingRateHandlers,
  FirestoreLocalShippingRateRepository,
  type LocalQuoteProductSnapshot,
  type LocalRateStoreRefLike,
  type LocalRateTxLike,
  type LocalShippingRateRepository,
} from './src/server/localShippingRates.ts';
import type {
  Category,
  CreateGuestOrderPayload,
  FulfillmentType,
  GuestOrder,
  GuestOrderItem,
  GuestOrderShipping,
  GuestOrderStatus,
  JntRateOption,
  OwnerGuestOrder,
  OwnerOrderFilter,
  Product,
  RajaOngkirDestinationOption,
  RajaOngkirDestinationSearchResponse,
  RajaOngkirJntCostResponse,
  RegionLevel,
  RegionListResponse,
  RegionOption,
  ShippingLocationOption,
  ShippingLocationSearchResponse,
  ShippingProvider,
  ShippingRateQuoteResponse,
  ShippingStatus,
} from './src/types/pos.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

function getConfiguredStoreId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.STORE_ID || '').trim();
}

export interface ExplicitOwnerFirebaseConfig {
  projectId: string;
  databaseId: string;
}

export function inspectOwnerFirebaseEnv(
  env: NodeJS.ProcessEnv = process.env
): {
  projectId: string;
  databaseId: string;
  storeId: string;
} {
  return {
    projectId: (env.OWNER_FIREBASE_PROJECT_ID || '').trim(),
    databaseId: (env.OWNER_FIRESTORE_DATABASE_ID || '').trim(),
    storeId: (env.STORE_ID || '').trim(),
  };
}

export function resolveExplicitOwnerFirebaseConfig(
  env: NodeJS.ProcessEnv = process.env
): ExplicitOwnerFirebaseConfig {
  const { projectId, databaseId } = inspectOwnerFirebaseEnv(env);

  if (!projectId) {
    throw new Error(
      'Konfigurasi OWNER_FIREBASE_PROJECT_ID belum disetel pada environment server. Setel OWNER_FIREBASE_PROJECT_ID secara eksplisit (tidak ada fallback otomatis).'
    );
  }
  if (projectId === '(default)' || /\s/.test(projectId)) {
    throw new Error(
      'Konfigurasi OWNER_FIREBASE_PROJECT_ID tidak valid.'
    );
  }

  if (!databaseId) {
    throw new Error(
      'Konfigurasi OWNER_FIRESTORE_DATABASE_ID belum disetel pada environment server. Setel OWNER_FIRESTORE_DATABASE_ID secara eksplisit (tidak ada fallback otomatis).'
    );
  }
  if (databaseId === '(default)') {
    throw new Error(
      'Konfigurasi database Owner tidak boleh menggunakan (default). Setel OWNER_FIRESTORE_DATABASE_ID ke named database Owner secara eksplisit.'
    );
  }
  if (/\s/.test(databaseId)) {
    throw new Error(
      'Konfigurasi OWNER_FIRESTORE_DATABASE_ID tidak valid.'
    );
  }

  return { projectId, databaseId };
}

function parseServiceAccountFromEnv(
  expectedProjectId: string,
  env: NodeJS.ProcessEnv = process.env
): ServiceAccount | null {
  const rawJson = (
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    env.FIREBASE_SERVICE_ACCOUNT ||
    ''
  ).trim();
  if (rawJson) {
    let decoded = rawJson;
    if (!rawJson.startsWith('{')) {
      try {
        decoded = Buffer.from(rawJson, 'base64').toString('utf8').trim();
      } catch {
        throw new Error(
          'FIREBASE_SERVICE_ACCOUNT_JSON tidak valid (bukan JSON atau base64 yang sah).'
        );
      }
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON gagal di-parse sebagai JSON.'
      );
    }

    const clientEmail =
      typeof parsed.client_email === 'string'
        ? parsed.client_email
        : typeof parsed.clientEmail === 'string'
        ? parsed.clientEmail
        : '';
    const privateKeyRaw =
      typeof parsed.private_key === 'string'
        ? parsed.private_key
        : typeof parsed.privateKey === 'string'
        ? parsed.privateKey
        : '';
    const projectId =
      typeof parsed.project_id === 'string' && parsed.project_id.trim()
        ? parsed.project_id.trim()
        : expectedProjectId;

    if (!clientEmail || !privateKeyRaw) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON harus berisi client_email dan private_key.'
      );
    }

    if (projectId !== expectedProjectId) {
      throw new Error(
        `Project ID pada service account (${projectId}) tidak cocok dengan project Owner (${expectedProjectId}).`
      );
    }

    return {
      projectId,
      clientEmail,
      privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
    };
  }

  const clientEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = (env.FIREBASE_PRIVATE_KEY || '').trim();
  if (clientEmail || privateKey) {
    if (!clientEmail || !privateKey) {
      throw new Error(
        'FIREBASE_CLIENT_EMAIL dan FIREBASE_PRIVATE_KEY harus diisi keduanya.'
      );
    }
    return {
      projectId: expectedProjectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

export interface OwnerFirebaseSdkDeps {
  env?: NodeJS.ProcessEnv;
  getApps?: () => App[];
  getApp?: () => App;
  initializeApp?: (options: {
    credential: ReturnType<typeof cert> | ReturnType<typeof applicationDefault>;
    projectId: string;
  }) => App;
  certFn?: typeof cert;
  applicationDefaultFn?: typeof applicationDefault;
  getFirestoreFn?: (app: App, databaseId: string) => Firestore;
}

export function initOwnerAdminAppWithConfig(
  deps: OwnerFirebaseSdkDeps = {}
): { app: App; config: ExplicitOwnerFirebaseConfig } {
  const env = deps.env ?? process.env;
  const config = resolveExplicitOwnerFirebaseConfig(env);
  const serviceAccount = parseServiceAccountFromEnv(config.projectId, env);

  const getAppsFn = deps.getApps ?? getApps;
  const getAppFn = deps.getApp ?? getApp;
  const initializeAppFn =
    deps.initializeApp ?? ((opts) => initializeApp(opts));
  const certFn = deps.certFn ?? cert;
  const adcFn = deps.applicationDefaultFn ?? applicationDefault;

  const app =
    getAppsFn().length > 0
      ? getAppFn()
      : serviceAccount
      ? initializeAppFn({
          credential: certFn(serviceAccount),
          projectId: config.projectId,
        })
      : initializeAppFn({
          credential: adcFn(),
          projectId: config.projectId,
        });

  return { app, config };
}

export function initOwnerFirestoreWithConfig(
  deps: OwnerFirebaseSdkDeps = {}
): { db: Firestore; app: App; config: ExplicitOwnerFirebaseConfig } {
  const { app, config } = initOwnerAdminAppWithConfig(deps);
  const getFirestoreFn =
    deps.getFirestoreFn ?? ((a, dbId) => getFirestore(a, dbId));
  const db = getFirestoreFn(app, config.databaseId);
  return { db, app, config };
}

let cachedAdminApp: App | null = null;
let cachedAdminConfigKey: string | null = null;
let cachedAdminDb: Firestore | null = null;
let cachedDbConfigKey: string | null = null;

function getOrInitOwnerAdminApp(): App {
  const config = resolveExplicitOwnerFirebaseConfig();
  const configKey = `${config.projectId}::${config.databaseId}`;
  if (cachedAdminApp && cachedAdminConfigKey === configKey) {
    return cachedAdminApp;
  }
  const { app } = initOwnerAdminAppWithConfig();
  cachedAdminApp = app;
  cachedAdminConfigKey = configKey;
  return cachedAdminApp;
}

function getOwnerFirestore(): Firestore {
  const config = resolveExplicitOwnerFirebaseConfig();
  const configKey = `${config.projectId}::${config.databaseId}`;
  if (cachedAdminDb && cachedDbConfigKey === configKey) {
    return cachedAdminDb;
  }
  const { db } = initOwnerFirestoreWithConfig();
  cachedAdminDb = db;
  cachedDbConfigKey = configKey;
  return cachedAdminDb;
}

function toIsoString(value: unknown): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return new Date().toISOString();
}

function slugifyCategory(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'lainnya'
  );
}

// Inspects known explicit deactivation flags only if present on Owner docs.
// Does NOT assume isActive must be true when omitted.
function isProductAvailableForCatalog(data: DocumentData): boolean {
  if (data.isActive === false) return false;
  if (data.active === false) return false;
  if (data.isDeleted === true || data.deleted === true) return false;
  if (data.deletedAt !== undefined && data.deletedAt !== null && data.deletedAt !== '') {
    return false;
  }
  return true;
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(num) || num < 0) {
    return undefined;
  }
  return Math.round(num * 100) / 100;
}

export class BoundedTtlCache<T> {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(options?: { maxEntries?: number; defaultTtlMs?: number }) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? 200);
    this.defaultTtlMs = Math.max(1000, options?.defaultTtlMs ?? 60_000);
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    if (this.entries.size >= this.maxEntries) {
      for (const [k, v] of this.entries.entries()) {
        if (now > v.expiresAt) {
          this.entries.delete(k);
        }
      }
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    const safeTtl = Math.max(1, ttlMs);
    this.entries.set(key, { value, expiresAt: now + safeTtl });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// ============================================================================
// KiriminAja Server-Side Configuration, Weight Normalization & Pricing Client
// ============================================================================
const DEFAULT_KIRIMINAJA_SANDBOX_URL = 'https://tdev.kiriminaja.com';
const DEFAULT_KIRIMINAJA_TIMEOUT_MS = 8000;
const MIN_KIRIMINAJA_TIMEOUT_MS = 1000;
const MAX_KIRIMINAJA_TIMEOUT_MS = 20000;
const KIRIMINAJA_LOCATION_CACHE_MAX_ENTRIES = 200;
const KIRIMINAJA_LOCATION_CACHE_TTL_MS = 60 * 60 * 1000;
const KIRIMINAJA_RATE_CACHE_MAX_ENTRIES = 300;
const KIRIMINAJA_RATE_CACHE_TTL_MS = 10 * 60 * 1000;

const kiriminAjaLocationCache = new BoundedTtlCache<ShippingLocationOption[]>({
  maxEntries: KIRIMINAJA_LOCATION_CACHE_MAX_ENTRIES,
  defaultTtlMs: KIRIMINAJA_LOCATION_CACHE_TTL_MS,
});

const kiriminAjaRateCache = new BoundedTtlCache<JntRateOption[]>({
  maxEntries: KIRIMINAJA_RATE_CACHE_MAX_ENTRIES,
  defaultTtlMs: KIRIMINAJA_RATE_CACHE_TTL_MS,
});

export function clearKiriminAjaCaches(): void {
  kiriminAjaLocationCache.clear();
  kiriminAjaRateCache.clear();
}

export interface KiriminAjaConfigSummary {
  configured: boolean;
  apiKeyPresent: boolean;
  baseUrl: string;
  isSandbox: boolean;
  originDistrictId: number | null;
  timeoutMs: number;
  missingFields: string[];
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function isValidKiriminAjaBaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getKiriminAjaConfigSummary(
  env: Record<string, string | undefined> = process.env
): KiriminAjaConfigSummary {
  const apiKey = (env.KIRIMINAJA_API_KEY || '').trim();
  const rawBaseUrl = (env.KIRIMINAJA_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const baseUrl = rawBaseUrl || DEFAULT_KIRIMINAJA_SANDBOX_URL;
  const originDistrictId = parsePositiveInteger(env.KIRIMINAJA_ORIGIN_DISTRICT_ID);

  const parsedTimeout = parsePositiveInteger(env.KIRIMINAJA_TIMEOUT_MS);
  const timeoutMs =
    parsedTimeout !== null
      ? Math.min(
          MAX_KIRIMINAJA_TIMEOUT_MS,
          Math.max(MIN_KIRIMINAJA_TIMEOUT_MS, parsedTimeout)
        )
      : DEFAULT_KIRIMINAJA_TIMEOUT_MS;

  const missingFields: string[] = [];
  if (!apiKey) missingFields.push('KIRIMINAJA_API_KEY');
  if (!isValidKiriminAjaBaseUrl(baseUrl)) missingFields.push('KIRIMINAJA_BASE_URL');
  if (originDistrictId === null) missingFields.push('KIRIMINAJA_ORIGIN_DISTRICT_ID');

  return {
    configured: missingFields.length === 0,
    apiKeyPresent: Boolean(apiKey),
    baseUrl,
    isSandbox: baseUrl === DEFAULT_KIRIMINAJA_SANDBOX_URL,
    originDistrictId,
    timeoutMs,
    missingFields,
  };
}

export interface ServerWeighedItemInput {
  productId: string;
  weightGrams?: unknown;
  quantity: number;
}

export interface NormalizedKiriminAjaWeight {
  totalWeightGrams: number;
  normalizedWeightGrams: number | null;
  hasUnweighedItems: boolean;
  allItemsUnweighed: boolean;
  unweighedProductIds: string[];
  canCalculateAutomaticRate: boolean;
}

// Computes authoritative package weight in grams from server product records only.
// Never accepts browser weight or invents missing product weights.
export function normalizeKiriminAjaPackageWeight(
  items: ServerWeighedItemInput[]
): NormalizedKiriminAjaWeight {
  let totalWeightGrams = 0;
  let weighedItemCount = 0;
  const unweighedProductIds: string[] = [];

  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(
        `Kuantitas item tidak valid untuk kalkulasi berat (${item.productId}).`
      );
    }

    const unitWeight = parseOptionalNonNegativeNumber(item.weightGrams);
    if (unitWeight === undefined || unitWeight <= 0) {
      unweighedProductIds.push(item.productId);
      continue;
    }

    totalWeightGrams += unitWeight * qty;
    weighedItemCount += 1;
  }

  const roundedTotal = Math.round(totalWeightGrams * 100) / 100;
  const hasUnweighedItems = unweighedProductIds.length > 0;
  const allItemsUnweighed = items.length > 0 && weighedItemCount === 0;
  const normalizedWeightGrams =
    roundedTotal > 0 ? Math.max(1, Math.ceil(roundedTotal)) : null;

  return {
    totalWeightGrams: roundedTotal,
    normalizedWeightGrams,
    hasUnweighedItems,
    allItemsUnweighed,
    unweighedProductIds,
    canCalculateAutomaticRate:
      items.length > 0 &&
      !hasUnweighedItems &&
      normalizedWeightGrams !== null &&
      normalizedWeightGrams >= 1,
  };
}

export interface KiriminAjaJntRatesResult {
  ok: boolean;
  available: boolean;
  fallbackToManual: boolean;
  code:
    | 'OK'
    | 'JNT_RATE_NOT_AVAILABLE'
    | 'KIRIMINAJA_API_KEY_MISSING'
    | 'KIRIMINAJA_ORIGIN_MISSING'
    | 'KIRIMINAJA_BASE_URL_INVALID'
    | 'INVALID_DESTINATION_DISTRICT'
    | 'INVALID_PACKAGE_WEIGHT'
    | 'INVALID_ITEM_VALUE'
    | 'KIRIMINAJA_TIMEOUT'
    | 'KIRIMINAJA_HTTP_ERROR'
    | 'KIRIMINAJA_INVALID_RESPONSE';
  message: string;
  rates: JntRateOption[];
}

export function parseKiriminAjaShippingPriceResponse(
  rawPayload: unknown
): { ok: boolean; rates: JntRateOption[] } {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, rates: [] };
  }

  const payload = rawPayload as Record<string, unknown>;
  if (payload.status !== true) {
    return { ok: false, rates: [] };
  }

  const rawList = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.details)
    ? payload.details
    : Array.isArray(payload.data)
    ? payload.data
    : null;

  if (!rawList) {
    return { ok: false, rates: [] };
  }

  const rates: JntRateOption[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const rawCourier =
      typeof item.code === 'string'
        ? item.code
        : typeof item.courier === 'string'
        ? item.courier
        : undefined;
    if (rawCourier !== undefined && rawCourier.trim().toLowerCase() !== 'jnt') {
      continue;
    }

    const rawServiceCode =
      typeof item.service === 'string'
        ? item.service
        : typeof item.service_type === 'string'
        ? item.service_type
        : typeof item.service_code === 'string'
        ? item.service_code
        : '';
    const serviceCode = rawServiceCode.trim().toUpperCase();
    if (!serviceCode || !/^[A-Z0-9_-]{1,32}$/.test(serviceCode)) {
      continue;
    }

    const cost = parseOptionalNonNegativeNumber(item.cost ?? item.price);
    if (cost === undefined) {
      continue;
    }

    const rawCourierName =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 64)
        : 'J&T Express';
    const rawServiceName =
      typeof item.service_name === 'string' && item.service_name.trim()
        ? item.service_name.trim().slice(0, 80)
        : serviceCode;
    const description =
      typeof item.description === 'string' && item.description.trim()
        ? item.description.trim().slice(0, 160)
        : undefined;
    const etd =
      typeof item.etd === 'string' && item.etd.trim()
        ? item.etd.trim().slice(0, 32)
        : typeof item.etd === 'number' && Number.isFinite(item.etd)
        ? String(item.etd)
        : undefined;
    const cod = typeof item.cod === 'boolean' ? item.cod : undefined;

    rates.push({
      courier: 'jnt',
      courierName: rawCourierName,
      serviceCode,
      serviceName: rawServiceName,
      ...(description ? { description } : {}),
      cost: Math.round(cost),
      ...(etd ? { etd } : {}),
      ...(cod !== undefined ? { cod } : {}),
    });
  }

  rates.sort((a, b) => a.cost - b.cost);
  return { ok: true, rates };
}

export interface FetchKiriminAjaJntRatesParams {
  destinationDistrictId: number;
  weightGrams: number;
  itemValue: number;
  originDistrictId?: number;
}

export async function fetchKiriminAjaJntRates(
  params: FetchKiriminAjaJntRatesParams,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }
): Promise<KiriminAjaJntRatesResult> {
  const env = options?.env ?? process.env;
  const config = getKiriminAjaConfigSummary(env);
  const apiKey = (env.KIRIMINAJA_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'KIRIMINAJA_API_KEY_MISSING',
      message: 'Konfigurasi tarif pengiriman otomatis belum tersedia.',
      rates: [],
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'KIRIMINAJA_BASE_URL_INVALID',
      message: 'Konfigurasi endpoint tarif pengiriman tidak valid.',
      rates: [],
    };
  }

  const originDistrictId =
    params.originDistrictId !== undefined
      ? parsePositiveInteger(params.originDistrictId)
      : config.originDistrictId;
  if (originDistrictId === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'KIRIMINAJA_ORIGIN_MISSING',
      message: 'Lokasi kecamatan asal toko belum dikonfigurasi.',
      rates: [],
    };
  }

  const destinationDistrictId = parsePositiveInteger(params.destinationDistrictId);
  if (destinationDistrictId === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: false,
      code: 'INVALID_DESTINATION_DISTRICT',
      message: 'ID kecamatan tujuan pengiriman tidak valid.',
      rates: [],
    };
  }

  const weightGrams = parsePositiveInteger(params.weightGrams);
  if (weightGrams === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'INVALID_PACKAGE_WEIGHT',
      message: 'Berat paket untuk cek ongkir harus berupa bilangan bulat positif (gram).',
      rates: [],
    };
  }

  const rawItemValue = Number(params.itemValue);
  if (!Number.isFinite(rawItemValue) || rawItemValue < 0) {
    return {
      ok: false,
      available: false,
      fallbackToManual: false,
      code: 'INVALID_ITEM_VALUE',
      message: 'Nilai barang pesanan tidak valid.',
      rates: [],
    };
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const endpointUrl = `${config.baseUrl}/api/mitra/v6.1/shipping_price`;

  try {
    const response = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        origin: originDistrictId,
        destination: destinationDistrictId,
        weight: weightGrams,
        item_value: Math.round(rawItemValue),
        courier: ['jnt'],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      return {
        ok: false,
        available: false,
        fallbackToManual: true,
        code: 'KIRIMINAJA_HTTP_ERROR',
        message: 'Layanan tarif J&T Express sedang tidak tersedia. Ongkir akan dikonfirmasi Owner.',
        rates: [],
      };
    }

    const rawJson = (await response.json().catch(() => null)) as unknown;
    const parsed = parseKiriminAjaShippingPriceResponse(rawJson);
    if (!parsed.ok) {
      return {
        ok: false,
        available: false,
        fallbackToManual: true,
        code: 'KIRIMINAJA_INVALID_RESPONSE',
        message: 'Tarif J&T Express tidak dapat diproses saat ini. Ongkir akan dikonfirmasi Owner.',
        rates: [],
      };
    }

    if (parsed.rates.length === 0) {
      return {
        ok: true,
        available: false,
        fallbackToManual: true,
        code: 'JNT_RATE_NOT_AVAILABLE',
        message: 'Tarif J&T Express tidak tersedia untuk kecamatan tujuan ini.',
        rates: [],
      };
    }

    return {
      ok: true,
      available: true,
      fallbackToManual: false,
      code: 'OK',
      message: 'Tarif J&T Express berhasil dimuat.',
      rates: parsed.rates,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: isTimeout ? 'KIRIMINAJA_TIMEOUT' : 'KIRIMINAJA_HTTP_ERROR',
      message: isTimeout
        ? 'Permintaan tarif J&T Express melebihi batas waktu. Ongkir akan dikonfirmasi Owner.'
        : 'Gagal terhubung ke layanan tarif J&T Express. Ongkir akan dikonfirmasi Owner.',
      rates: [],
    };
  }
}

const MAX_LOCATION_SEARCH_RESULTS = 20;

export function parseShippingLocationSearchQuery(
  rawQuery: unknown
): { ok: true; query: string } | { ok: false; error: string } {
  if (typeof rawQuery !== 'string') {
    return {
      ok: false,
      error: 'Parameter pencarian lokasi (search) wajib berupa teks.',
    };
  }

  const trimmed = rawQuery.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 3 || trimmed.length > 60) {
    return {
      ok: false,
      error: 'Kata kunci pencarian lokasi harus antara 3 hingga 60 karakter.',
    };
  }

  if (!/^[a-zA-Z0-9\s.,'/-]{3,60}$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Kata kunci pencarian lokasi mengandung karakter yang tidak diizinkan.',
    };
  }

  return { ok: true, query: trimmed };
}

function resolveKiriminAjaLocationEndpoint(
  env: Record<string, string | undefined>,
  baseUrl: string
):
  | { ok: true; url: string; method: 'GET' | 'POST' }
  | {
      ok: false;
      code:
        | 'KIRIMINAJA_LOCATION_ENDPOINT_UNCONFIGURED'
        | 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID';
      message: string;
    } {
  const rawPath = (env.KIRIMINAJA_LOCATION_SEARCH_PATH || '').trim();
  if (!rawPath) {
    return {
      ok: false,
      code: 'KIRIMINAJA_LOCATION_ENDPOINT_UNCONFIGURED',
      message:
        'Endpoint pencarian lokasi KiriminAja belum dikonfigurasi pada server.',
    };
  }

  if (
    !rawPath.startsWith('/api/mitra/') ||
    rawPath.includes('..') ||
    !/^\/api\/mitra\/[a-zA-Z0-9_./-]{2,120}$/.test(rawPath)
  ) {
    return {
      ok: false,
      code: 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID',
      message: 'Konfigurasi path pencarian lokasi KiriminAja tidak valid.',
    };
  }

  const rawMethod = (env.KIRIMINAJA_LOCATION_SEARCH_METHOD || 'GET')
    .trim()
    .toUpperCase();
  const method = rawMethod === 'POST' ? 'POST' : rawMethod === 'GET' ? 'GET' : null;
  if (!method) {
    return {
      ok: false,
      code: 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID',
      message: 'Metode HTTP pencarian lokasi KiriminAja harus GET atau POST.',
    };
  }

  try {
    const baseParsed = new URL(baseUrl);
    const fullParsed = new URL(rawPath, baseParsed);
    if (fullParsed.origin !== baseParsed.origin) {
      return {
        ok: false,
        code: 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID',
        message: 'Konfigurasi endpoint pencarian lokasi tidak valid.',
      };
    }
    return { ok: true, url: fullParsed.toString(), method };
  } catch {
    return {
      ok: false,
      code: 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID',
      message: 'Konfigurasi endpoint pencarian lokasi tidak valid.',
    };
  }
}

export function parseKiriminAjaLocationResponse(rawPayload: unknown): {
  ok: boolean;
  locations: ShippingLocationOption[];
} {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, locations: [] };
  }

  const payload = rawPayload as Record<string, unknown>;
  if (payload.status !== true) {
    return { ok: false, locations: [] };
  }

  const rawList = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.results)
    ? payload.results
    : null;
  if (!rawList) {
    return { ok: false, locations: [] };
  }

  const locations: ShippingLocationOption[] = [];
  const seen = new Set<string>();

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const districtId = parsePositiveInteger(
      item.district_id ?? item.kecamatan_id ?? item.id
    );
    if (districtId === null) continue;

    const subdistrictId = parsePositiveInteger(
      item.subdistrict_id ?? item.kelurahan_id
    );
    const dedupKey = `${districtId}:${subdistrictId ?? ''}`;
    if (seen.has(dedupKey)) continue;

    const readText = (val: unknown, maxLen = 80): string | undefined =>
      typeof val === 'string' && val.trim() ? val.trim().slice(0, maxLen) : undefined;

    const provinceName = readText(item.province_name ?? item.province);
    const cityName = readText(item.city_name ?? item.city);
    const districtName = readText(item.district_name ?? item.district);
    const subdistrictName = readText(item.subdistrict_name ?? item.subdistrict);
    const postalCode = readText(item.postal_code ?? item.zip_code, 16);

    const explicitLabel = readText(item.label ?? item.full_address, 180);
    const composedLabel = [subdistrictName, districtName, cityName, provinceName]
      .filter((v): v is string => Boolean(v))
      .join(', ');
    const label = explicitLabel || composedLabel || `Kecamatan #${districtId}`;

    seen.add(dedupKey);
    locations.push({
      districtId,
      ...(subdistrictId !== null ? { subdistrictId } : {}),
      label,
      ...(provinceName ? { provinceName } : {}),
      ...(cityName ? { cityName } : {}),
      ...(districtName ? { districtName } : {}),
      ...(subdistrictName ? { subdistrictName } : {}),
      ...(postalCode ? { postalCode } : {}),
    });

    if (locations.length >= MAX_LOCATION_SEARCH_RESULTS) {
      break;
    }
  }

  return { ok: true, locations };
}

export interface KiriminAjaLocationsResult {
  ok: boolean;
  available: boolean;
  code:
    | 'OK'
    | 'LOCATIONS_EMPTY'
    | 'INVALID_LOCATION_QUERY'
    | 'KIRIMINAJA_API_KEY_MISSING'
    | 'KIRIMINAJA_BASE_URL_INVALID'
    | 'KIRIMINAJA_LOCATION_ENDPOINT_UNCONFIGURED'
    | 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID'
    | 'KIRIMINAJA_TIMEOUT'
    | 'KIRIMINAJA_HTTP_ERROR'
    | 'KIRIMINAJA_INVALID_RESPONSE';
  message: string;
  locations: ShippingLocationOption[];
}

export async function fetchKiriminAjaLocations(
  rawQuery: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }
): Promise<KiriminAjaLocationsResult> {
  const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
  if (!parsedQuery.ok) {
    return {
      ok: false,
      available: false,
      code: 'INVALID_LOCATION_QUERY',
      message: parsedQuery.error,
      locations: [],
    };
  }

  const env = options?.env ?? process.env;
  const config = getKiriminAjaConfigSummary(env);
  const apiKey = (env.KIRIMINAJA_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      code: 'KIRIMINAJA_API_KEY_MISSING',
      message: 'Pencarian lokasi otomatis belum aktif (konfigurasi API belum tersedia).',
      locations: [],
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      code: 'KIRIMINAJA_BASE_URL_INVALID',
      message: 'Konfigurasi endpoint pencarian lokasi tidak valid.',
      locations: [],
    };
  }

  const endpoint = resolveKiriminAjaLocationEndpoint(env, config.baseUrl);
  if (!endpoint.ok) {
    return {
      ok: false,
      available: false,
      code: endpoint.code,
      message: endpoint.message,
      locations: [],
    };
  }

  const fetchFn = options?.fetchImpl ?? fetch;

  try {
    let requestUrl = endpoint.url;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
    };

    if (endpoint.method === 'GET') {
      const urlObj = new URL(endpoint.url);
      urlObj.searchParams.set('search', parsedQuery.query);
      requestUrl = urlObj.toString();
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ search: parsedQuery.query });
    }

    const response = await fetchFn(requestUrl, init);
    if (!response.ok) {
      return {
        ok: false,
        available: false,
        code: 'KIRIMINAJA_HTTP_ERROR',
        message: 'Layanan pencarian lokasi pengiriman sedang tidak dapat diakses.',
        locations: [],
      };
    }

    const rawJson = (await response.json().catch(() => null)) as unknown;
    const parsed = parseKiriminAjaLocationResponse(rawJson);
    if (!parsed.ok) {
      return {
        ok: false,
        available: false,
        code: 'KIRIMINAJA_INVALID_RESPONSE',
        message: 'Respons pencarian lokasi pengiriman tidak dapat diproses.',
        locations: [],
      };
    }

    if (parsed.locations.length === 0) {
      return {
        ok: true,
        available: true,
        code: 'LOCATIONS_EMPTY',
        message: 'Lokasi tidak ditemukan untuk kata kunci tersebut.',
        locations: [],
      };
    }

    return {
      ok: true,
      available: true,
      code: 'OK',
      message: 'Lokasi berhasil ditemukan.',
      locations: parsed.locations,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      available: false,
      code: isTimeout ? 'KIRIMINAJA_TIMEOUT' : 'KIRIMINAJA_HTTP_ERROR',
      message: isTimeout
        ? 'Permintaan pencarian lokasi melebihi batas waktu.'
        : 'Gagal terhubung ke layanan pencarian lokasi pengiriman.',
      locations: [],
    };
  }
}

export function parseShippingRateQuoteRequest(
  rawBody: unknown
):
  | {
      ok: true;
      destinationDistrictId: number;
      items: Array<{ productId: string; quantity: number }>;
    }
  | { ok: false; statusCode: number; error: string } {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Payload permintaan cek ongkir harus berupa objek JSON yang valid.',
    };
  }

  const body = rawBody as Record<string, unknown>;
  const destinationDistrictId = parsePositiveInteger(body.destinationDistrictId);
  if (destinationDistrictId === null) {
    return {
      ok: false,
      statusCode: 400,
      error: 'ID kecamatan tujuan (destinationDistrictId) wajib berupa bilangan bulat positif.',
    };
  }

  const requestedItems = Array.isArray(body.items) ? body.items : [];
  if (requestedItems.length === 0 || requestedItems.length > 50) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Daftar barang untuk cek ongkir tidak boleh kosong (maksimal 50 item).',
    };
  }

  const qtyByProduct = new Map<string, number>();
  for (const entry of requestedItems) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { productId?: unknown }).productId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(
        (entry as { productId: string }).productId
      )
    ) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Format ID produk pada permintaan cek ongkir tidak valid.',
      };
    }

    const productId = (entry as { productId: string }).productId;
    const qty = Number((entry as { quantity?: unknown }).quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Jumlah setiap barang harus berupa bilangan bulat antara 1 dan 99.',
      };
    }

    const merged = (qtyByProduct.get(productId) ?? 0) + qty;
    if (merged > 99) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Jumlah maksimal per produk adalah 99 per pesanan.',
      };
    }
    qtyByProduct.set(productId, merged);
  }

  return {
    ok: true,
    destinationDistrictId,
    items: Array.from(qtyByProduct.entries()).map(([productId, quantity]) => ({
      productId,
      quantity,
    })),
  };
}

export interface ServerProductQuoteSnapshot {
  id: string;
  exists: boolean;
  data?: DocumentData;
}

export async function searchKiriminAjaLocationsWithCache(
  rawQuery: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    limit?: number;
    cache?: BoundedTtlCache<ShippingLocationOption[]>;
    cacheTtlMs?: number;
    now?: () => number;
  }
): Promise<KiriminAjaLocationsResult & { cacheHit: boolean }> {
  const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
  if (!parsedQuery.ok) {
    return {
      ok: false,
      available: false,
      code: 'INVALID_LOCATION_QUERY',
      message: parsedQuery.error,
      locations: [],
      cacheHit: false,
    };
  }

  const env = options?.env ?? process.env;
  const config = getKiriminAjaConfigSummary(env);
  const apiKey = (env.KIRIMINAJA_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      code: 'KIRIMINAJA_API_KEY_MISSING',
      message:
        'Pencarian lokasi otomatis belum aktif (konfigurasi API belum tersedia).',
      locations: [],
      cacheHit: false,
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      code: 'KIRIMINAJA_BASE_URL_INVALID',
      message: 'Konfigurasi endpoint pencarian lokasi tidak valid.',
      locations: [],
      cacheHit: false,
    };
  }

  const endpoint = resolveKiriminAjaLocationEndpoint(env, config.baseUrl);
  if (!endpoint.ok) {
    return {
      ok: false,
      available: false,
      code: endpoint.code,
      message: endpoint.message,
      locations: [],
      cacheHit: false,
    };
  }

  const requestedLimit =
    parsePositiveInteger(options?.limit) ?? MAX_LOCATION_SEARCH_RESULTS;
  const safeLimit = Math.min(MAX_LOCATION_SEARCH_RESULTS, requestedLimit);
  const cache = options?.cache ?? kiriminAjaLocationCache;
  const nowMs = (options?.now ?? Date.now)();
  const endpointUrlObj = new URL(endpoint.url);
  const cacheKey = `${config.baseUrl}|${endpoint.method}|${endpointUrlObj.pathname}|limit:${safeLimit}|q:${parsedQuery.query.toLowerCase()}`;

  const cached = cache.get(cacheKey, nowMs);
  if (cached && cached.length > 0) {
    return {
      ok: true,
      available: true,
      code: 'OK',
      message: 'Lokasi berhasil ditemukan.',
      locations: cached.map((item) => ({ ...item })),
      cacheHit: true,
    };
  }

  const result = await fetchKiriminAjaLocations(parsedQuery.query, {
    env,
    fetchImpl: options?.fetchImpl,
  });

  if (result.ok && result.available && result.code === 'OK') {
    const limitedLocations = result.locations
      .slice(0, safeLimit)
      .map((item) => ({ ...item }));
    if (limitedLocations.length > 0) {
      const effectiveTtlMs = Math.min(
        KIRIMINAJA_LOCATION_CACHE_TTL_MS,
        Math.max(1, options?.cacheTtlMs ?? KIRIMINAJA_LOCATION_CACHE_TTL_MS)
      );
      cache.set(cacheKey, limitedLocations, effectiveTtlMs, nowMs);
      return {
        ...result,
        locations: limitedLocations.map((item) => ({ ...item })),
        cacheHit: false,
      };
    }
  }

  return {
    ...result,
    cacheHit: false,
  };
}

export async function quoteJntShippingRatesForStore(
  fetchProductsByIds: (productIds: string[]) => Promise<ServerProductQuoteSnapshot[]>,
  rawBody: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    rateCache?: BoundedTtlCache<JntRateOption[]>;
    rateCacheTtlMs?: number;
    now?: () => number;
  }
): Promise<{
  statusCode: number;
  body: ShippingRateQuoteResponse | { error: string };
  cacheHit?: boolean;
}> {
  const parsed = parseShippingRateQuoteRequest(rawBody);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: { error: parsed.error } };
  }

  const qtyByProduct = new Map(
    parsed.items.map((item) => [item.productId, item.quantity])
  );
  const productSnaps = await fetchProductsByIds(Array.from(qtyByProduct.keys()));
  const snapMap = new Map(productSnaps.map((s) => [s.id, s]));

  let itemsSubtotal = 0;
  const weighedInputs: ServerWeighedItemInput[] = [];

  for (const [productId, requestedQty] of qtyByProduct.entries()) {
    const snap = snapMap.get(productId);
    if (!snap || !snap.exists || !snap.data || !isProductAvailableForCatalog(snap.data)) {
      return {
        statusCode: 404,
        body: {
          error: `Produk tidak ditemukan atau tidak tersedia (${productId}).`,
        },
      };
    }

    const publicProduct = mapOwnerProductToPublic(snap.id, snap.data);
    if (publicProduct.stock < requestedQty) {
      return {
        statusCode: 409,
        body: {
          error:
            publicProduct.stock === 0
              ? `Stok "${publicProduct.name}" saat ini habis.`
              : `Stok "${publicProduct.name}" tersisa ${publicProduct.stock} ${publicProduct.unit}. Kurangi jumlah pesanan.`,
        },
      };
    }

    itemsSubtotal += publicProduct.price * requestedQty;
    weighedInputs.push({
      productId: snap.id,
      weightGrams: publicProduct.weightGrams,
      quantity: requestedQty,
    });
  }

  const roundedSubtotal = Math.round(itemsSubtotal * 100) / 100;
  const itemValueInt = Math.round(roundedSubtotal);
  const weightSummary = normalizeKiriminAjaPackageWeight(weighedInputs);

  if (
    !weightSummary.canCalculateAutomaticRate ||
    weightSummary.normalizedWeightGrams === null
  ) {
    return {
      statusCode: 200,
      cacheHit: false,
      body: {
        available: false,
        fallbackToManual: true,
        reason:
          'Sebagian atau seluruh produk belum memiliki data berat valid. Ongkos kirim akan dikonfirmasi Owner.',
        destinationDistrictId: parsed.destinationDistrictId,
        totalWeightGrams: weightSummary.totalWeightGrams,
        normalizedWeightGrams: weightSummary.normalizedWeightGrams,
        hasUnweighedItems: weightSummary.hasUnweighedItems,
        itemsSubtotal: roundedSubtotal,
        rates: [],
      },
    };
  }

  const env = options?.env ?? process.env;
  const config = getKiriminAjaConfigSummary(env);
  const apiKey = (env.KIRIMINAJA_API_KEY || '').trim();
  const canUseCache =
    Boolean(options?.rateCache) &&
    Boolean(apiKey) &&
    config.originDistrictId !== null &&
    isValidKiriminAjaBaseUrl(config.baseUrl);
  const nowMs = (options?.now ?? Date.now)();
  const rateCacheKey = canUseCache
    ? `${config.baseUrl}|origin:${config.originDistrictId}|dest:${parsed.destinationDistrictId}|weight:${weightSummary.normalizedWeightGrams}|value:${itemValueInt}|courier:jnt`
    : '';

  if (canUseCache && options?.rateCache) {
    const cachedRates = options.rateCache.get(rateCacheKey, nowMs);
    if (cachedRates && cachedRates.length > 0) {
      return {
        statusCode: 200,
        cacheHit: true,
        body: {
          available: true,
          fallbackToManual: false,
          destinationDistrictId: parsed.destinationDistrictId,
          totalWeightGrams: weightSummary.totalWeightGrams,
          normalizedWeightGrams: weightSummary.normalizedWeightGrams,
          hasUnweighedItems: false,
          itemsSubtotal: roundedSubtotal,
          rates: cachedRates.map((rate) => ({ ...rate })),
        },
      };
    }
  }

  const rateResult = await fetchKiriminAjaJntRates(
    {
      destinationDistrictId: parsed.destinationDistrictId,
      weightGrams: weightSummary.normalizedWeightGrams,
      itemValue: itemValueInt,
    },
    options
  );

  if (!rateResult.ok || !rateResult.available) {
    return {
      statusCode: 200,
      cacheHit: false,
      body: {
        available: false,
        fallbackToManual: rateResult.fallbackToManual,
        reason: rateResult.message,
        destinationDistrictId: parsed.destinationDistrictId,
        totalWeightGrams: weightSummary.totalWeightGrams,
        normalizedWeightGrams: weightSummary.normalizedWeightGrams,
        hasUnweighedItems: weightSummary.hasUnweighedItems,
        itemsSubtotal: roundedSubtotal,
        rates: [],
      },
    };
  }

  if (
    canUseCache &&
    options?.rateCache &&
    rateResult.code === 'OK' &&
    rateResult.rates.length > 0
  ) {
    const effectiveTtlMs = Math.min(
      KIRIMINAJA_RATE_CACHE_TTL_MS,
      Math.max(1, options?.rateCacheTtlMs ?? KIRIMINAJA_RATE_CACHE_TTL_MS)
    );
    options.rateCache.set(
      rateCacheKey,
      rateResult.rates.map((rate) => ({ ...rate })),
      effectiveTtlMs,
      nowMs
    );
  }

  return {
    statusCode: 200,
    cacheHit: false,
    body: {
      available: true,
      fallbackToManual: false,
      destinationDistrictId: parsed.destinationDistrictId,
      totalWeightGrams: weightSummary.totalWeightGrams,
      normalizedWeightGrams: weightSummary.normalizedWeightGrams,
      hasUnweighedItems: false,
      itemsSubtotal: roundedSubtotal,
      rates: rateResult.rates,
    },
  };
}

export function createKiriminAjaLocationsHandler(deps?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  cache?: BoundedTtlCache<ShippingLocationOption[]>;
  cacheTtlMs?: number;
  now?: () => number;
  checkRateLimit?: (req: Request) => boolean;
}) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const allowed = (deps?.checkRateLimit ?? checkLocationSearchRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        available: false,
        locations: [],
        error: 'Terlalu banyak pencarian lokasi. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    const rawQuery = req.query.search ?? req.query.q;
    const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
    if (!parsedQuery.ok) {
      return res.status(400).json({
        available: false,
        locations: [],
        error: parsedQuery.error,
      });
    }

    let safeLimit = MAX_LOCATION_SEARCH_RESULTS;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && rawLimit !== '') {
      if (typeof rawLimit !== 'string') {
        return res.status(400).json({
          available: false,
          locations: [],
          error: 'Parameter limit tidak valid.',
        });
      }
      const parsedLimit = parsePositiveInteger(rawLimit);
      if (parsedLimit === null) {
        return res.status(400).json({
          available: false,
          locations: [],
          error: 'Parameter limit harus berupa bilangan bulat positif.',
        });
      }
      safeLimit = Math.min(MAX_LOCATION_SEARCH_RESULTS, parsedLimit);
    }

    const result = await searchKiriminAjaLocationsWithCache(parsedQuery.query, {
      env: deps?.env,
      fetchImpl: deps?.fetchImpl,
      limit: safeLimit,
      cache: deps?.cache ?? kiriminAjaLocationCache,
      cacheTtlMs: deps?.cacheTtlMs,
      now: deps?.now,
    });

    const body: ShippingLocationSearchResponse = {
      available: result.available,
      locations: result.locations,
      ...(result.code !== 'OK' && result.code !== 'LOCATIONS_EMPTY'
        ? { reason: result.message }
        : result.locations.length === 0
        ? { reason: result.message }
        : {}),
    };
    return res.status(200).json(body);
  };
}

export function createKiriminAjaJntRatesHandler(deps?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  rateCache?: BoundedTtlCache<JntRateOption[]>;
  rateCacheTtlMs?: number;
  now?: () => number;
  checkRateLimit?: (req: Request) => boolean;
  fetchProductsByIds?: (productIds: string[]) => Promise<ServerProductQuoteSnapshot[]>;
}) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const allowed = (deps?.checkRateLimit ?? checkRateQuoteRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        error: 'Terlalu banyak permintaan cek ongkir. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    let productFetcher = deps?.fetchProductsByIds;
    if (!productFetcher) {
      const ctx = ensureBackendConfigured(res);
      if (!ctx) return;
      const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
      productFetcher = async (productIds: string[]) => {
        const refs = productIds.map((pid) =>
          storeRef.collection('products').doc(pid)
        );
        const snaps = await ctx.db.getAll(...refs);
        return snaps.map((snap) => ({
          id: snap.id,
          exists: snap.exists,
          data: snap.exists ? snap.data() : undefined,
        }));
      };
    }

    try {
      const quoteResult = await quoteJntShippingRatesForStore(
        productFetcher,
        req.body,
        {
          env: deps?.env,
          fetchImpl: deps?.fetchImpl,
          rateCache: deps?.rateCache ?? kiriminAjaRateCache,
          rateCacheTtlMs: deps?.rateCacheTtlMs,
          now: deps?.now,
        }
      );

      return res.status(quoteResult.statusCode).json(quoteResult.body);
    } catch (err) {
      return sendConfigOrFirestoreError(res, err);
    }
  };
}

// ============================================================================
// RajaOngkir (by Komerce) Server-Side Shipping Cost & Destination Adapter
// ============================================================================
const DEFAULT_RAJAONGKIR_BASE_URL = 'https://rajaongkir.komerce.id/api/v1';
const DEFAULT_RAJAONGKIR_TIMEOUT_MS = 8000;
const MAX_RAJAONGKIR_DESTINATION_RESULTS = 20;
const RAJAONGKIR_LOCATION_CACHE_MAX_ENTRIES = 200;
const RAJAONGKIR_LOCATION_CACHE_TTL_MS = 60 * 60 * 1000;
const RAJAONGKIR_RATE_CACHE_MAX_ENTRIES = 300;
const RAJAONGKIR_RATE_CACHE_TTL_MS = 10 * 60 * 1000;

const rajaOngkirLocationCache = new BoundedTtlCache<RajaOngkirDestinationOption[]>({
  maxEntries: RAJAONGKIR_LOCATION_CACHE_MAX_ENTRIES,
  defaultTtlMs: RAJAONGKIR_LOCATION_CACHE_TTL_MS,
});

const rajaOngkirRateCache = new BoundedTtlCache<JntRateOption[]>({
  maxEntries: RAJAONGKIR_RATE_CACHE_MAX_ENTRIES,
  defaultTtlMs: RAJAONGKIR_RATE_CACHE_TTL_MS,
});

export function clearRajaOngkirCaches(): void {
  rajaOngkirLocationCache.clear();
  rajaOngkirRateCache.clear();
}

export interface RajaOngkirConfigSummary {
  configured: boolean;
  apiKeyPresent: boolean;
  baseUrl: string;
  originId: number | null;
  timeoutMs: number;
  missingFields: string[];
}

export function getRajaOngkirConfigSummary(
  env: Record<string, string | undefined> = process.env
): RajaOngkirConfigSummary {
  const apiKey = (env.RAJAONGKIR_API_KEY || '').trim();
  const rawBaseUrl = (env.RAJAONGKIR_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const baseUrl = rawBaseUrl || DEFAULT_RAJAONGKIR_BASE_URL;
  const originId = parsePositiveInteger(env.RAJAONGKIR_ORIGIN_ID);

  const parsedTimeout = parsePositiveInteger(env.RAJAONGKIR_TIMEOUT_MS);
  const timeoutMs =
    parsedTimeout !== null
      ? Math.min(
          MAX_KIRIMINAJA_TIMEOUT_MS,
          Math.max(MIN_KIRIMINAJA_TIMEOUT_MS, parsedTimeout)
        )
      : DEFAULT_RAJAONGKIR_TIMEOUT_MS;

  const missingFields: string[] = [];
  if (!apiKey) missingFields.push('RAJAONGKIR_API_KEY');
  if (!isValidKiriminAjaBaseUrl(baseUrl)) missingFields.push('RAJAONGKIR_BASE_URL');
  if (originId === null) missingFields.push('RAJAONGKIR_ORIGIN_ID');

  return {
    configured: missingFields.length === 0,
    apiKeyPresent: Boolean(apiKey),
    baseUrl,
    originId,
    timeoutMs,
    missingFields,
  };
}

export function parseRajaOngkirDestinationResponse(rawPayload: unknown): {
  ok: boolean;
  destinations: RajaOngkirDestinationOption[];
} {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, destinations: [] };
  }

  const payload = rawPayload as Record<string, unknown>;
  const meta =
    payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;

  const metaStatus =
    typeof meta?.status === 'string' ? meta.status.trim().toLowerCase() : '';
  if (!meta || metaStatus !== 'success' || !Array.isArray(payload.data)) {
    return { ok: false, destinations: [] };
  }

  const destinations: RajaOngkirDestinationOption[] = [];
  const seenIds = new Set<number>();

  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const id = parsePositiveInteger(item.id);
    if (id === null || seenIds.has(id)) continue;

    const readText = (val: unknown, maxLen = 80): string | undefined =>
      typeof val === 'string' && val.trim() ? val.trim().slice(0, maxLen) : undefined;

    const provinceName = readText(item.province_name);
    const cityName = readText(item.city_name);
    const districtName = readText(item.district_name);
    const subdistrictName = readText(item.subdistrict_name);
    const zipCode = readText(item.zip_code, 16);
    const explicitLabel = readText(item.label, 180);
    const fallbackLabel = [subdistrictName, districtName, cityName, provinceName]
      .filter((v): v is string => Boolean(v))
      .join(', ');
    const label = explicitLabel || fallbackLabel || `Lokasi #${id}`;

    seenIds.add(id);
    destinations.push({
      id,
      label,
      ...(provinceName ? { provinceName } : {}),
      ...(cityName ? { cityName } : {}),
      ...(districtName ? { districtName } : {}),
      ...(subdistrictName ? { subdistrictName } : {}),
      ...(zipCode ? { zipCode } : {}),
    });

    if (destinations.length >= MAX_RAJAONGKIR_DESTINATION_RESULTS) {
      break;
    }
  }

  return { ok: true, destinations };
}

export interface RajaOngkirDestinationsResult {
  ok: boolean;
  available: boolean;
  code:
    | 'OK'
    | 'LOCATIONS_EMPTY'
    | 'INVALID_LOCATION_QUERY'
    | 'RAJAONGKIR_API_KEY_MISSING'
    | 'RAJAONGKIR_BASE_URL_INVALID'
    | 'RAJAONGKIR_TIMEOUT'
    | 'RAJAONGKIR_HTTP_ERROR'
    | 'RAJAONGKIR_INVALID_RESPONSE';
  message: string;
  destinations: RajaOngkirDestinationOption[];
}

export async function fetchRajaOngkirDestinations(
  rawQuery: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    limit?: number;
  }
): Promise<RajaOngkirDestinationsResult> {
  const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
  if (!parsedQuery.ok) {
    return {
      ok: false,
      available: false,
      code: 'INVALID_LOCATION_QUERY',
      message: parsedQuery.error,
      destinations: [],
    };
  }

  const env = options?.env ?? process.env;
  const config = getRajaOngkirConfigSummary(env);
  const apiKey = (env.RAJAONGKIR_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      code: 'RAJAONGKIR_API_KEY_MISSING',
      message: 'Konfigurasi API RajaOngkir belum tersedia.',
      destinations: [],
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      code: 'RAJAONGKIR_BASE_URL_INVALID',
      message: 'Konfigurasi base URL RajaOngkir tidak valid.',
      destinations: [],
    };
  }

  const requestedLimit = parsePositiveInteger(options?.limit) ?? 10;
  const safeLimit = Math.min(MAX_RAJAONGKIR_DESTINATION_RESULTS, requestedLimit);
  const fetchFn = options?.fetchImpl ?? fetch;

  try {
    const endpoint = new URL(`${config.baseUrl}/destination/domestic-destination`);
    endpoint.searchParams.set('search', parsedQuery.query);
    endpoint.searchParams.set('limit', String(safeLimit));
    endpoint.searchParams.set('offset', '0');

    const response = await fetchFn(endpoint.toString(), {
      method: 'GET',
      headers: {
        key: apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      return {
        ok: false,
        available: false,
        code: 'RAJAONGKIR_HTTP_ERROR',
        message: 'Layanan pencarian lokasi RajaOngkir sedang tidak dapat diakses.',
        destinations: [],
      };
    }

    const rawJson = (await response.json().catch(() => null)) as unknown;
    const parsed = parseRajaOngkirDestinationResponse(rawJson);
    if (!parsed.ok) {
      return {
        ok: false,
        available: false,
        code: 'RAJAONGKIR_INVALID_RESPONSE',
        message: 'Respons pencarian lokasi RajaOngkir tidak dapat diproses.',
        destinations: [],
      };
    }

    if (parsed.destinations.length === 0) {
      return {
        ok: true,
        available: true,
        code: 'LOCATIONS_EMPTY',
        message: 'Lokasi tidak ditemukan untuk kata kunci tersebut.',
        destinations: [],
      };
    }

    return {
      ok: true,
      available: true,
      code: 'OK',
      message: 'Lokasi berhasil ditemukan.',
      destinations: parsed.destinations,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      available: false,
      code: isTimeout ? 'RAJAONGKIR_TIMEOUT' : 'RAJAONGKIR_HTTP_ERROR',
      message: isTimeout
        ? 'Permintaan pencarian lokasi RajaOngkir melebihi batas waktu.'
        : 'Gagal terhubung ke layanan pencarian lokasi RajaOngkir.',
      destinations: [],
    };
  }
}

export function parseRajaOngkirDomesticCostResponse(
  rawPayload: unknown
): { ok: boolean; rates: JntRateOption[] } {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, rates: [] };
  }

  const payload = rawPayload as Record<string, unknown>;
  const meta =
    payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;

  const metaStatus =
    typeof meta?.status === 'string' ? meta.status.trim().toLowerCase() : '';
  if (!meta || metaStatus !== 'success' || !Array.isArray(payload.data)) {
    return { ok: false, rates: [] };
  }

  const rates: JntRateOption[] = [];
  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const rawCode =
      typeof item.code === 'string' ? item.code.trim().toLowerCase() : '';
    if (rawCode && rawCode !== 'jnt') {
      continue;
    }

    const serviceCode =
      typeof item.service === 'string' ? item.service.trim().toUpperCase() : '';
    if (!serviceCode || !/^[A-Z0-9_-]{1,32}$/.test(serviceCode)) {
      continue;
    }

    const cost = parseOptionalNonNegativeNumber(item.cost);
    if (cost === undefined) {
      continue;
    }

    const courierName =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 64)
        : 'J&T Express';
    const description =
      typeof item.description === 'string' && item.description.trim()
        ? item.description.trim().slice(0, 160)
        : undefined;
    const etd =
      typeof item.etd === 'string' && item.etd.trim()
        ? item.etd.trim().slice(0, 32)
        : undefined;

    rates.push({
      courier: 'jnt',
      courierName,
      serviceCode,
      serviceName: description || serviceCode,
      ...(description ? { description } : {}),
      cost: Math.round(cost),
      ...(etd ? { etd } : {}),
    });
  }

  rates.sort((a, b) => a.cost - b.cost);
  return { ok: true, rates };
}

export interface RajaOngkirJntCostResult {
  ok: boolean;
  available: boolean;
  fallbackToManual: boolean;
  code:
    | 'OK'
    | 'JNT_RATE_NOT_AVAILABLE'
    | 'RAJAONGKIR_API_KEY_MISSING'
    | 'RAJAONGKIR_ORIGIN_MISSING'
    | 'RAJAONGKIR_BASE_URL_INVALID'
    | 'INVALID_DESTINATION_ID'
    | 'INVALID_PACKAGE_WEIGHT'
    | 'RAJAONGKIR_TIMEOUT'
    | 'RAJAONGKIR_HTTP_ERROR'
    | 'RAJAONGKIR_INVALID_RESPONSE';
  message: string;
  rates: JntRateOption[];
}

export async function fetchRajaOngkirJntCost(
  params: {
    destinationId: number;
    weightGrams: number;
    originId?: number;
  },
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }
): Promise<RajaOngkirJntCostResult> {
  const env = options?.env ?? process.env;
  const config = getRajaOngkirConfigSummary(env);
  const apiKey = (env.RAJAONGKIR_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'RAJAONGKIR_API_KEY_MISSING',
      message: 'Konfigurasi API RajaOngkir belum tersedia.',
      rates: [],
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'RAJAONGKIR_BASE_URL_INVALID',
      message: 'Konfigurasi endpoint RajaOngkir tidak valid.',
      rates: [],
    };
  }

  const originId =
    params.originId !== undefined
      ? parsePositiveInteger(params.originId)
      : config.originId;
  if (originId === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'RAJAONGKIR_ORIGIN_MISSING',
      message: 'ID lokasi asal toko untuk RajaOngkir belum dikonfigurasi.',
      rates: [],
    };
  }

  const destinationId = parsePositiveInteger(params.destinationId);
  if (destinationId === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: false,
      code: 'INVALID_DESTINATION_ID',
      message: 'ID lokasi tujuan pengiriman tidak valid.',
      rates: [],
    };
  }

  const weightGrams = parsePositiveInteger(params.weightGrams);
  if (weightGrams === null) {
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: 'INVALID_PACKAGE_WEIGHT',
      message: 'Berat paket untuk cek ongkir harus berupa bilangan bulat positif (gram).',
      rates: [],
    };
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const endpointUrl = `${config.baseUrl}/calculate/domestic-cost`;
  const formBody = new URLSearchParams({
    origin: String(originId),
    destination: String(destinationId),
    weight: String(weightGrams),
    courier: 'jnt',
  });

  try {
    const response = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        key: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formBody.toString(),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      return {
        ok: false,
        available: false,
        fallbackToManual: true,
        code: 'RAJAONGKIR_HTTP_ERROR',
        message: 'Layanan tarif J&T RajaOngkir sedang tidak tersedia. Ongkir akan dikonfirmasi Owner.',
        rates: [],
      };
    }

    const rawJson = (await response.json().catch(() => null)) as unknown;
    const parsed = parseRajaOngkirDomesticCostResponse(rawJson);
    if (!parsed.ok) {
      return {
        ok: false,
        available: false,
        fallbackToManual: true,
        code: 'RAJAONGKIR_INVALID_RESPONSE',
        message: 'Tarif J&T dari RajaOngkir tidak dapat diproses saat ini. Ongkir akan dikonfirmasi Owner.',
        rates: [],
      };
    }

    if (parsed.rates.length === 0) {
      return {
        ok: true,
        available: false,
        fallbackToManual: true,
        code: 'JNT_RATE_NOT_AVAILABLE',
        message: 'Tarif J&T Express tidak tersedia untuk lokasi tujuan ini.',
        rates: [],
      };
    }

    return {
      ok: true,
      available: true,
      fallbackToManual: false,
      code: 'OK',
      message: 'Tarif J&T Express berhasil dimuat.',
      rates: parsed.rates,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      available: false,
      fallbackToManual: true,
      code: isTimeout ? 'RAJAONGKIR_TIMEOUT' : 'RAJAONGKIR_HTTP_ERROR',
      message: isTimeout
        ? 'Permintaan tarif J&T RajaOngkir melebihi batas waktu. Ongkir akan dikonfirmasi Owner.'
        : 'Gagal terhubung ke layanan tarif J&T RajaOngkir. Ongkir akan dikonfirmasi Owner.',
      rates: [],
    };
  }
}

export async function searchRajaOngkirDestinationsWithCache(
  rawQuery: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    limit?: number;
    cache?: BoundedTtlCache<RajaOngkirDestinationOption[]>;
    cacheTtlMs?: number;
    now?: () => number;
  }
): Promise<RajaOngkirDestinationsResult & { cacheHit: boolean }> {
  const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
  if (!parsedQuery.ok) {
    return {
      ok: false,
      available: false,
      code: 'INVALID_LOCATION_QUERY',
      message: parsedQuery.error,
      destinations: [],
      cacheHit: false,
    };
  }

  const env = options?.env ?? process.env;
  const config = getRajaOngkirConfigSummary(env);
  const apiKey = (env.RAJAONGKIR_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      available: false,
      code: 'RAJAONGKIR_API_KEY_MISSING',
      message: 'Konfigurasi API RajaOngkir belum tersedia.',
      destinations: [],
      cacheHit: false,
    };
  }

  if (!isValidKiriminAjaBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      available: false,
      code: 'RAJAONGKIR_BASE_URL_INVALID',
      message: 'Konfigurasi base URL RajaOngkir tidak valid.',
      destinations: [],
      cacheHit: false,
    };
  }

  const requestedLimit = parsePositiveInteger(options?.limit) ?? 10;
  const safeLimit = Math.min(MAX_RAJAONGKIR_DESTINATION_RESULTS, requestedLimit);
  const cache = options?.cache ?? rajaOngkirLocationCache;
  const nowMs = (options?.now ?? Date.now)();
  const cacheKey = `${config.baseUrl}|limit:${safeLimit}|q:${parsedQuery.query.toLowerCase()}`;

  const cached = cache.get(cacheKey, nowMs);
  if (cached && cached.length > 0) {
    return {
      ok: true,
      available: true,
      code: 'OK',
      message: 'Lokasi berhasil ditemukan.',
      destinations: cached.map((item) => ({ ...item })),
      cacheHit: true,
    };
  }

  const result = await fetchRajaOngkirDestinations(parsedQuery.query, {
    env,
    fetchImpl: options?.fetchImpl,
    limit: safeLimit,
  });

  if (
    result.ok &&
    result.available &&
    result.code === 'OK' &&
    result.destinations.length > 0
  ) {
    cache.set(
      cacheKey,
      result.destinations.map((item) => ({ ...item })),
      options?.cacheTtlMs,
      nowMs
    );
  }

  return {
    ...result,
    cacheHit: false,
  };
}

export async function quoteRajaOngkirJntRatesForStore(
  fetchProductsByIds: (productIds: string[]) => Promise<ServerProductQuoteSnapshot[]>,
  rawBody: unknown,
  options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    rateCache?: BoundedTtlCache<JntRateOption[]>;
    rateCacheTtlMs?: number;
    now?: () => number;
  }
): Promise<{
  statusCode: number;
  body: RajaOngkirJntCostResponse | { error: string };
  cacheHit?: boolean;
}> {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return {
      statusCode: 400,
      body: { error: 'Payload permintaan cek ongkir harus berupa objek JSON yang valid.' },
    };
  }

  const bodyObj = rawBody as Record<string, unknown>;
  if (
    bodyObj.destinationId !== undefined &&
    bodyObj.destinationDistrictId !== undefined
  ) {
    const a = parsePositiveInteger(bodyObj.destinationId);
    const b = parsePositiveInteger(bodyObj.destinationDistrictId);
    if (a === null || b === null || a !== b) {
      return {
        statusCode: 400,
        body: { error: 'ID lokasi tujuan pengiriman tidak konsisten.' },
      };
    }
  }

  const normalizedBody = {
    destinationDistrictId:
      bodyObj.destinationId !== undefined
        ? bodyObj.destinationId
        : bodyObj.destinationDistrictId,
    items: bodyObj.items,
  };

  const parsed = parseShippingRateQuoteRequest(normalizedBody);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: { error: parsed.error } };
  }

  const qtyByProduct = new Map(
    parsed.items.map((item) => [item.productId, item.quantity])
  );
  const productSnaps = await fetchProductsByIds(Array.from(qtyByProduct.keys()));
  const snapMap = new Map(productSnaps.map((s) => [s.id, s]));

  let itemsSubtotal = 0;
  const weighedInputs: ServerWeighedItemInput[] = [];

  for (const [productId, requestedQty] of qtyByProduct.entries()) {
    const snap = snapMap.get(productId);
    if (!snap || !snap.exists || !snap.data || !isProductAvailableForCatalog(snap.data)) {
      return {
        statusCode: 404,
        body: {
          error: `Produk tidak ditemukan atau tidak tersedia (${productId}).`,
        },
      };
    }

    const publicProduct = mapOwnerProductToPublic(snap.id, snap.data);
    if (publicProduct.stock < requestedQty) {
      return {
        statusCode: 409,
        body: {
          error:
            publicProduct.stock === 0
              ? `Stok "${publicProduct.name}" saat ini habis.`
              : `Stok "${publicProduct.name}" tersisa ${publicProduct.stock} ${publicProduct.unit}. Kurangi jumlah pesanan.`,
        },
      };
    }

    itemsSubtotal += publicProduct.price * requestedQty;
    weighedInputs.push({
      productId: snap.id,
      weightGrams: publicProduct.weightGrams,
      quantity: requestedQty,
    });
  }

  const roundedSubtotal = Math.round(itemsSubtotal * 100) / 100;
  const weightSummary = normalizeKiriminAjaPackageWeight(weighedInputs);

  if (
    !weightSummary.canCalculateAutomaticRate ||
    weightSummary.normalizedWeightGrams === null
  ) {
    return {
      statusCode: 200,
      cacheHit: false,
      body: {
        available: false,
        fallbackToManual: true,
        reason:
          'Sebagian atau seluruh produk belum memiliki data berat valid. Ongkos kirim akan dikonfirmasi Owner.',
        destinationId: parsed.destinationDistrictId,
        totalWeightGrams: weightSummary.totalWeightGrams,
        normalizedWeightGrams: weightSummary.normalizedWeightGrams,
        hasUnweighedItems: weightSummary.hasUnweighedItems,
        itemsSubtotal: roundedSubtotal,
        rates: [],
      },
    };
  }

  const env = options?.env ?? process.env;
  const config = getRajaOngkirConfigSummary(env);
  const apiKey = (env.RAJAONGKIR_API_KEY || '').trim();
  const canUseCache =
    Boolean(options?.rateCache) &&
    Boolean(apiKey) &&
    config.originId !== null &&
    isValidKiriminAjaBaseUrl(config.baseUrl);
  const nowMs = (options?.now ?? Date.now)();
  const rateCacheKey = canUseCache
    ? `${config.baseUrl}|origin:${config.originId}|dest:${parsed.destinationDistrictId}|weight:${weightSummary.normalizedWeightGrams}|courier:jnt`
    : '';

  if (canUseCache && options?.rateCache) {
    const cachedRates = options.rateCache.get(rateCacheKey, nowMs);
    if (cachedRates && cachedRates.length > 0) {
      return {
        statusCode: 200,
        cacheHit: true,
        body: {
          available: true,
          fallbackToManual: false,
          destinationId: parsed.destinationDistrictId,
          totalWeightGrams: weightSummary.totalWeightGrams,
          normalizedWeightGrams: weightSummary.normalizedWeightGrams,
          hasUnweighedItems: false,
          itemsSubtotal: roundedSubtotal,
          rates: cachedRates.map((rate) => ({ ...rate })),
        },
      };
    }
  }

  const rateResult = await fetchRajaOngkirJntCost(
    {
      destinationId: parsed.destinationDistrictId,
      weightGrams: weightSummary.normalizedWeightGrams,
    },
    options
  );

  if (!rateResult.ok || !rateResult.available) {
    return {
      statusCode: 200,
      cacheHit: false,
      body: {
        available: false,
        fallbackToManual: rateResult.fallbackToManual,
        reason: rateResult.message,
        destinationId: parsed.destinationDistrictId,
        totalWeightGrams: weightSummary.totalWeightGrams,
        normalizedWeightGrams: weightSummary.normalizedWeightGrams,
        hasUnweighedItems: weightSummary.hasUnweighedItems,
        itemsSubtotal: roundedSubtotal,
        rates: [],
      },
    };
  }

  if (
    canUseCache &&
    options?.rateCache &&
    rateResult.code === 'OK' &&
    rateResult.rates.length > 0
  ) {
    options.rateCache.set(
      rateCacheKey,
      rateResult.rates.map((rate) => ({ ...rate })),
      options?.rateCacheTtlMs,
      nowMs
    );
  }

  return {
    statusCode: 200,
    cacheHit: false,
    body: {
      available: true,
      fallbackToManual: false,
      destinationId: parsed.destinationDistrictId,
      totalWeightGrams: weightSummary.totalWeightGrams,
      normalizedWeightGrams: weightSummary.normalizedWeightGrams,
      hasUnweighedItems: false,
      itemsSubtotal: roundedSubtotal,
      rates: rateResult.rates,
    },
  };
}

export function createRajaOngkirLocationsHandler(deps?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  cache?: BoundedTtlCache<RajaOngkirDestinationOption[]>;
  cacheTtlMs?: number;
  now?: () => number;
  checkRateLimit?: (req: Request) => boolean;
}) {
  return async (req: Request, res: Response) => {
    const allowed = (deps?.checkRateLimit ?? checkRajaOngkirLocationSearchRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        available: false,
        destinations: [],
        error: 'Terlalu banyak pencarian lokasi. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    const rawQuery = req.query.search ?? req.query.q;
    const parsedQuery = parseShippingLocationSearchQuery(rawQuery);
    if (!parsedQuery.ok) {
      return res.status(400).json({
        available: false,
        destinations: [],
        error: parsedQuery.error,
      });
    }

    let safeLimit = 10;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && rawLimit !== '') {
      if (typeof rawLimit !== 'string') {
        return res.status(400).json({
          available: false,
          destinations: [],
          error: 'Parameter limit tidak valid.',
        });
      }
      const parsedLimit = parsePositiveInteger(rawLimit);
      if (parsedLimit === null) {
        return res.status(400).json({
          available: false,
          destinations: [],
          error: 'Parameter limit harus berupa bilangan bulat positif.',
        });
      }
      safeLimit = Math.min(MAX_RAJAONGKIR_DESTINATION_RESULTS, parsedLimit);
    }

    const result = await searchRajaOngkirDestinationsWithCache(parsedQuery.query, {
      env: deps?.env,
      fetchImpl: deps?.fetchImpl,
      limit: safeLimit,
      cache: deps?.cache ?? rajaOngkirLocationCache,
      cacheTtlMs: deps?.cacheTtlMs,
      now: deps?.now,
    });

    res.setHeader('Cache-Control', 'no-store');
    const body: RajaOngkirDestinationSearchResponse = {
      available: result.available,
      destinations: result.destinations,
      ...(result.code !== 'OK' || result.destinations.length === 0
        ? { reason: result.message }
        : {}),
    };
    return res.status(200).json(body);
  };
}

export function createRajaOngkirJntRatesHandler(deps?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  rateCache?: BoundedTtlCache<JntRateOption[]>;
  rateCacheTtlMs?: number;
  now?: () => number;
  checkRateLimit?: (req: Request) => boolean;
  fetchProductsByIds?: (productIds: string[]) => Promise<ServerProductQuoteSnapshot[]>;
}) {
  return async (req: Request, res: Response) => {
    const allowed = (deps?.checkRateLimit ?? checkRajaOngkirRateQuoteRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        error: 'Terlalu banyak permintaan cek ongkir. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    let productFetcher = deps?.fetchProductsByIds;
    if (!productFetcher) {
      const ctx = ensureBackendConfigured(res);
      if (!ctx) return;
      const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
      productFetcher = async (productIds: string[]) => {
        const refs = productIds.map((pid) =>
          storeRef.collection('products').doc(pid)
        );
        const snaps = await ctx.db.getAll(...refs);
        return snaps.map((snap) => ({
          id: snap.id,
          exists: snap.exists,
          data: snap.exists ? snap.data() : undefined,
        }));
      };
    }

    try {
      const quoteResult = await quoteRajaOngkirJntRatesForStore(
        productFetcher,
        req.body,
        {
          env: deps?.env,
          fetchImpl: deps?.fetchImpl,
          rateCache: deps?.rateCache ?? rajaOngkirRateCache,
          rateCacheTtlMs: deps?.rateCacheTtlMs,
          now: deps?.now,
        }
      );

      res.setHeader('Cache-Control', 'no-store');
      return res.status(quoteResult.statusCode).json(quoteResult.body);
    } catch (err) {
      return sendConfigOrFirestoreError(res, err);
    }
  };
}

// ============================================================================
// Administrative Region Lookup (LokaID Public API — Isolated from Shipping)
// Docs: https://lokaid.gilangpratama.id
// ============================================================================
export const LOKAID_BASE_URL = 'https://lokaid.gilangpratama.id';
const LOKAID_TIMEOUT_MS = 8000;
const REGION_CACHE_MAX_ENTRIES = 500;
const REGION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGION_MAX_ITEMS = 1000;

const lokaIdRegionCache = new BoundedTtlCache<RegionOption[]>({
  maxEntries: REGION_CACHE_MAX_ENTRIES,
  defaultTtlMs: REGION_CACHE_TTL_MS,
});

export function clearRegionCaches(): void {
  lokaIdRegionCache.clear();
}

export function validateRegionParentCode(
  level: Exclude<RegionLevel, 'provinces'>,
  rawCode: unknown
): { ok: true; code: string } | { ok: false; error: string } {
  if (typeof rawCode !== 'string') {
    return { ok: false, error: 'Kode wilayah induk wajib berupa teks.' };
  }
  const code = rawCode.trim();
  if (level === 'cities' && !/^\d{2}$/.test(code)) {
    return {
      ok: false,
      error: 'Kode provinsi tidak valid. Gunakan format 2 digit (contoh: 35).',
    };
  }
  if (level === 'districts' && !/^\d{2}\.\d{2}$/.test(code)) {
    return {
      ok: false,
      error:
        'Kode kabupaten/kota tidak valid. Gunakan format XX.YY (contoh: 35.02).',
    };
  }
  if (level === 'villages' && !/^\d{2}\.\d{2}\.\d{2}$/.test(code)) {
    return {
      ok: false,
      error:
        'Kode kecamatan tidak valid. Gunakan format XX.YY.ZZ (contoh: 35.02.17).',
    };
  }
  return { ok: true, code };
}

export function parseLokaIdRegionResponse(rawPayload: unknown):
  | { ok: true; regions: RegionOption[] }
  | { ok: false; error: string } {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return {
      ok: false,
      error: 'Respons layanan data wilayah tidak valid.',
    };
  }

  const obj = rawPayload as Record<string, unknown>;
  if (typeof obj.status === 'number' && obj.status >= 400) {
    return {
      ok: false,
      error: 'Layanan data wilayah mengembalikan status gagal.',
    };
  }

  if (!Array.isArray(obj.data)) {
    return {
      ok: false,
      error: 'Format daftar wilayah dari layanan tidak valid.',
    };
  }

  if (obj.data.length === 0) {
    return { ok: true, regions: [] };
  }

  const deduped = new Map<string, RegionOption>();
  for (const item of obj.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const rawCode = typeof entry.code === 'string' ? entry.code.trim() : '';
    const rawValue = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!/^[0-9.]{2,20}$/.test(rawCode) || !rawValue) {
      continue;
    }
    if (!deduped.has(rawCode)) {
      deduped.set(rawCode, {
        code: rawCode,
        name: rawValue.slice(0, 120),
      });
    }
    if (deduped.size >= REGION_MAX_ITEMS) break;
  }

  if (deduped.size === 0) {
    return {
      ok: false,
      error: 'Data wilayah yang diterima dari layanan tidak valid.',
    };
  }

  const regions = Array.from(deduped.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'id-ID')
  );
  return { ok: true, regions };
}

function resolveRegionEndpointPath(
  level: RegionLevel,
  parentCode?: string
): string {
  if (level === 'provinces') return '/states';
  if (level === 'cities') {
    return `/states/${encodeURIComponent(parentCode ?? '')}/cities`;
  }
  if (level === 'districts') {
    return `/cities/${encodeURIComponent(parentCode ?? '')}/districts`;
  }
  return `/districts/${encodeURIComponent(parentCode ?? '')}/villages`;
}

export async function fetchLokaIdRegions(params: {
  level: RegionLevel;
  parentCode?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<
  | { ok: true; regions: RegionOption[] }
  | { ok: false; statusCode: number; error: string }
> {
  if (params.level !== 'provinces') {
    const check = validateRegionParentCode(params.level, params.parentCode);
    if (!check.ok) {
      return { ok: false, statusCode: 400, error: check.error };
    }
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL((params.baseUrl || LOKAID_BASE_URL).trim());
  } catch {
    return {
      ok: false,
      statusCode: 500,
      error: 'Konfigurasi layanan wilayah tidak valid.',
    };
  }

  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    return {
      ok: false,
      statusCode: 500,
      error: 'Protokol layanan wilayah tidak valid.',
    };
  }

  const baseNormalized = `${parsedBase.origin}${parsedBase.pathname}`.replace(
    /\/+$/,
    ''
  );
  const endpointPath = resolveRegionEndpointPath(params.level, params.parentCode);
  const targetUrl = `${baseNormalized}${endpointPath}`;
  const fetchFn = params.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1000, params.timeoutMs ?? LOKAID_TIMEOUT_MS);

  try {
    const response = await fetchFn(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404) {
      return {
        ok: false,
        statusCode: 404,
        error: 'Data wilayah untuk kode yang dipilih tidak ditemukan.',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        statusCode: 502,
        error: 'Layanan data wilayah sedang bermasalah. Silakan coba lagi.',
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      return {
        ok: false,
        statusCode: 502,
        error: 'Respons layanan data wilayah bukan JSON yang valid.',
      };
    }

    const parsed = parseLokaIdRegionResponse(rawJson);
    if (!parsed.ok) {
      return { ok: false, statusCode: 502, error: parsed.error };
    }

    return { ok: true, regions: parsed.regions };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        /timeout|timed out/i.test(err.message));
    if (isTimeout) {
      return {
        ok: false,
        statusCode: 504,
        error: 'Permintaan data wilayah melebihi batas waktu. Silakan coba lagi.',
      };
    }
    return {
      ok: false,
      statusCode: 502,
      error: 'Gagal terhubung ke layanan data wilayah. Silakan coba lagi.',
    };
  }
}

export async function fetchRegionsWithCache(
  params: {
    level: RegionLevel;
    parentCode?: string;
  },
  deps?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    cache?: BoundedTtlCache<RegionOption[]>;
    cacheTtlMs?: number;
    now?: () => number;
    timeoutMs?: number;
  }
): Promise<
  | { statusCode: 200; body: RegionListResponse }
  | { statusCode: 400 | 404 | 500 | 502 | 504; body: { error: string } }
> {
  let cleanParentCode: string | undefined;
  if (params.level !== 'provinces') {
    const check = validateRegionParentCode(params.level, params.parentCode);
    if (!check.ok) {
      return { statusCode: 400, body: { error: check.error } };
    }
    cleanParentCode = check.code;
  }

  const baseUrl = (deps?.baseUrl || LOKAID_BASE_URL).trim();
  const cache = deps?.cache ?? lokaIdRegionCache;
  const cacheTtlMs = Math.max(
    1000,
    Math.min(REGION_CACHE_TTL_MS, deps?.cacheTtlMs ?? REGION_CACHE_TTL_MS)
  );
  const nowMs = deps?.now ? deps.now() : Date.now();
  const cacheKey = `${baseUrl}|${params.level}|${cleanParentCode ?? 'root'}`;

  const cached = cache.get(cacheKey, nowMs);
  if (cached && cached.length > 0) {
    return {
      statusCode: 200,
      body: {
        available: true,
        level: params.level,
        ...(cleanParentCode ? { parentCode: cleanParentCode } : {}),
        regions: cached,
      },
    };
  }

  const upstream = await fetchLokaIdRegions({
    level: params.level,
    parentCode: cleanParentCode,
    baseUrl,
    fetchImpl: deps?.fetchImpl,
    timeoutMs: deps?.timeoutMs,
  });

  if (!upstream.ok) {
    return {
      statusCode: upstream.statusCode as 400 | 404 | 500 | 502 | 504,
      body: { error: upstream.error },
    };
  }

  if (upstream.regions.length > 0) {
    cache.set(cacheKey, upstream.regions, cacheTtlMs, nowMs);
  }

  return {
    statusCode: 200,
    body: {
      available: true,
      level: params.level,
      ...(cleanParentCode ? { parentCode: cleanParentCode } : {}),
      regions: upstream.regions,
      ...(upstream.regions.length === 0
        ? { reason: 'Data wilayah belum tersedia untuk pilihan ini.' }
        : {}),
    },
  };
}

function createRegionLevelHandler(
  level: RegionLevel,
  deps?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    cache?: BoundedTtlCache<RegionOption[]>;
    cacheTtlMs?: number;
    now?: () => number;
    timeoutMs?: number;
    checkRateLimit?: (req: Request) => boolean;
  }
) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allowed = (deps?.checkRateLimit ?? checkRegionLookupRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        error: 'Terlalu banyak permintaan data wilayah. Tunggu sebentar lalu coba lagi.',
      });
    }

    const parentCode =
      level === 'cities'
        ? req.params.stateCode
        : level === 'districts'
        ? req.params.cityCode
        : level === 'villages'
        ? req.params.districtCode
        : undefined;

    const result = await fetchRegionsWithCache({ level, parentCode }, deps);
    return res.status(result.statusCode).json(result.body);
  };
}

export function createRegionProvincesHandler(
  deps?: Parameters<typeof createRegionLevelHandler>[1]
) {
  return createRegionLevelHandler('provinces', deps);
}

export function createRegionCitiesHandler(
  deps?: Parameters<typeof createRegionLevelHandler>[1]
) {
  return createRegionLevelHandler('cities', deps);
}

export function createRegionDistrictsHandler(
  deps?: Parameters<typeof createRegionLevelHandler>[1]
) {
  return createRegionLevelHandler('districts', deps);
}

export function createRegionVillagesHandler(
  deps?: Parameters<typeof createRegionLevelHandler>[1]
) {
  return createRegionLevelHandler('villages', deps);
}

const VALID_SHIPPING_PROVIDERS = new Set<ShippingProvider>([
  'STORE_COURIER',
  'JNT_EXPRESS',
]);

const VALID_SHIPPING_STATUSES = new Set<ShippingStatus>([
  'PENDING_RATE',
  'READY_TO_SHIP',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
]);

function parseShippingProvider(value: unknown): ShippingProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim() as ShippingProvider;
  return VALID_SHIPPING_PROVIDERS.has(trimmed) ? trimmed : undefined;
}

function parseShippingStatus(value: unknown): ShippingStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim() as ShippingStatus;
  return VALID_SHIPPING_STATUSES.has(trimmed) ? trimmed : undefined;
}

function mapFirestoreShippingToGuestShipping(
  rawShipping: unknown
): GuestOrderShipping | undefined {
  if (!rawShipping || typeof rawShipping !== 'object' || Array.isArray(rawShipping)) {
    return undefined;
  }
  const s = rawShipping as Record<string, unknown>;
  const mapped: GuestOrderShipping = {};

  const provider = parseShippingProvider(s.provider);
  if (provider) mapped.provider = provider;

  if (typeof s.serviceCode === 'string' && s.serviceCode.trim()) {
    mapped.serviceCode = s.serviceCode.trim().slice(0, 32);
  }

  const destinationDistrictId = parsePositiveInteger(s.destinationDistrictId);
  if (destinationDistrictId !== null) {
    mapped.destinationDistrictId = destinationDistrictId;
  }

  const status = parseShippingStatus(s.status);
  if (status) mapped.status = status;

  const totalWeightGrams = parseOptionalNonNegativeNumber(s.totalWeightGrams);
  if (totalWeightGrams !== undefined) mapped.totalWeightGrams = totalWeightGrams;

  if (typeof s.hasUnweighedItems === 'boolean') {
    mapped.hasUnweighedItems = s.hasUnweighedItems;
  }

  const shippingFee = parseOptionalNonNegativeNumber(s.shippingFee);
  if (shippingFee !== undefined) mapped.shippingFee = shippingFee;

  if (typeof s.shippingFeeConfirmed === 'boolean') {
    mapped.shippingFeeConfirmed = s.shippingFeeConfirmed;
  }

  if (typeof s.trackingNumber === 'string' && s.trackingNumber.trim()) {
    mapped.trackingNumber = s.trackingNumber.trim().slice(0, 64);
  }

  if (typeof s.notes === 'string' && s.notes.trim()) {
    mapped.notes = s.notes.trim().slice(0, 300);
  }

  if (s.updatedAt !== undefined && s.updatedAt !== null && s.updatedAt !== '') {
    mapped.updatedAt = toIsoString(s.updatedAt);
  }
  if (s.shippedAt !== undefined && s.shippedAt !== null && s.shippedAt !== '') {
    mapped.shippedAt = toIsoString(s.shippedAt);
  }
  if (s.deliveredAt !== undefined && s.deliveredAt !== null && s.deliveredAt !== '') {
    mapped.deliveredAt = toIsoString(s.deliveredAt);
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

// Maps Owner Product document into public Guest DTO.
// NEVER reads or forwards `cost`, supplier fields, or internal Owner stock thresholds.
function mapOwnerProductToPublic(id: string, data: DocumentData): Product {
  const categoryLabel =
    typeof data.category === 'string' && data.category.trim()
      ? data.category.trim()
      : 'Lainnya';
  const categoryId = slugifyCategory(categoryLabel);
  const price = Number(data.price ?? 0);
  const stock = Number(data.stock ?? 0);
  const weightGrams = parseOptionalNonNegativeNumber(data.weightGrams);

  return {
    id: typeof data.id === 'string' && data.id.trim() ? data.id : id,
    sku: typeof data.sku === 'string' ? data.sku : '',
    brand: typeof data.brand === 'string' ? data.brand : undefined,
    name: typeof data.name === 'string' ? data.name : 'Produk Tanpa Nama',
    categoryId,
    categoryName: categoryLabel,
    subCategory:
      typeof data.subCategory === 'string' ? data.subCategory : undefined,
    size: typeof data.size === 'string' ? data.size : undefined,
    price: Number.isFinite(price) && price >= 0 ? price : 0,
    stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
    unit:
      typeof data.unit === 'string' && data.unit.trim()
        ? data.unit.trim()
        : 'pcs',
    ...(weightGrams !== undefined ? { weightGrams } : {}),
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
    description: [data.brand, data.subCategory, data.size]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .join(' · '),
    featured: false,
    isActive: isProductAvailableForCatalog(data),
  };
}

// Masks customer phone number for public Guest API responses, preserving only
// the last 4 digits needed for client verification/polling while never exposing
// the full phone number stored in Firestore for SmartPOS Owner.
function maskPhoneNumber(rawPhone: unknown): string {
  const digits = String(rawPhone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 4) {
    return '*'.repeat(digits.length);
  }
  const visibleLast4 = digits.slice(-4);
  const maskedCount = Math.max(4, digits.length - 4);
  return `${'*'.repeat(maskedCount)}${visibleLast4}`;
}

function mapFirestoreOrderToGuestOrder(
  docId: string,
  data: DocumentData
): GuestOrder {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items: GuestOrderItem[] = rawItems.map((item: DocumentData) => {
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
    const quantity = Number(item.quantity ?? 0);
    const subtotal = Number(item.subtotal ?? unitPrice * quantity);
    const weightGrams = parseOptionalNonNegativeNumber(item.weightGrams);
    return {
      productId: String(item.productId ?? ''),
      sku: String(item.sku ?? ''),
      name: String(item.productName ?? item.name ?? 'Produk'),
      unitPrice,
      quantity,
      subtotal,
      ...(weightGrams !== undefined ? { weightGrams } : {}),
      imageUrl: String(item.imageUrl ?? ''),
    };
  });

  const totalAmount = Number(data.total ?? data.totalAmount ?? 0);
  const itemsSubtotal = parseOptionalNonNegativeNumber(data.itemsSubtotal);
  const shipping = mapFirestoreShippingToGuestShipping(data.shipping);

  return {
    id: String(data.orderId ?? docId),
    orderNumber: String(data.orderNumber ?? docId),
    customerName: String(data.customerName ?? data.guestName ?? ''),
    customerPhone: maskPhoneNumber(data.customerPhone),
    fulfillmentType:
      data.fulfillmentType === 'delivery' ? 'delivery' : 'pickup',
    deliveryAddress: String(data.deliveryAddress ?? ''),
    notes: String(data.notes ?? ''),
    items,
    ...(itemsSubtotal !== undefined ? { itemsSubtotal } : {}),
    totalAmount,
    status: String(data.status ?? 'PENDING').toUpperCase() as GuestOrderStatus,
    rejectionReason:
      typeof data.rejectionReason === 'string' ? data.rejectionReason : undefined,
    stockDeducted: Boolean(data.stockDeducted),
    stockRestored: Boolean(data.stockRestored),
    ...(shipping ? { shipping } : {}),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

function mapFirestoreOrderToOwnerOrder(
  docId: string,
  data: DocumentData,
  externalSaleLinked: boolean
): OwnerGuestOrder {
  const base = mapFirestoreOrderToGuestOrder(docId, data);
  const linkCheck = isOrderLinkedToCashierTransaction(data, externalSaleLinked);
  const isCancelled = isCancelledOrderStatus(data.status);
  const canDelete = isCancelled && !linkCheck.linked;

  let deleteBlockedReason: string | undefined;
  if (linkCheck.linked) {
    deleteBlockedReason = linkCheck.reason;
  } else if (!isCancelled) {
    deleteBlockedReason =
      'Hanya pesanan berstatus BATAL yang dapat dihapus secara permanen.';
  }

  return {
    ...base,
    customerPhone: String(data.customerPhone ?? ''),
    transactionId:
      typeof data.transactionId === 'string' ? data.transactionId : undefined,
    saleId: typeof data.saleId === 'string' ? data.saleId : undefined,
    kasirTransactionId:
      typeof data.kasirTransactionId === 'string'
        ? data.kasirTransactionId
        : undefined,
    receiptNumber:
      typeof data.receiptNumber === 'string' ? data.receiptNumber : undefined,
    convertedToSale: Boolean(data.convertedToSale),
    linkedToCashierTransaction: linkCheck.linked,
    canDelete,
    deleteBlockedReason,
  };
}

async function requireOwnerAuth(
  req: Request,
  res: Response,
  storeId: string,
  verifyIdTokenFn: (
    token: string
  ) => Promise<{ uid: string; email?: string }> = (token) =>
    getAuth(getOrInitOwnerAdminApp()).verifyIdToken(token)
): Promise<{ uid: string; email?: string } | null> {
  const authHeader = String(req.headers.authorization || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !match[1]) {
    res.status(401).json({
      code: 'OWNER_AUTH_REQUIRED',
      error: 'Login akun Owner diperlukan untuk mengelola pesanan.',
    });
    return null;
  }

  try {
    const decoded = await verifyIdTokenFn(match[1].trim());
    if (decoded.uid !== storeId) {
      res.status(403).json({
        code: 'OWNER_FORBIDDEN',
        error:
          'Akun ini bukan pemilik toko (UID tidak cocok dengan STORE_ID Owner).',
      });
      return null;
    }
    return { uid: decoded.uid, email: decoded.email };
  } catch {
    res.status(401).json({
      code: 'OWNER_TOKEN_INVALID',
      error: 'Sesi login Owner tidak valid atau kedaluwarsa. Silakan login ulang.',
    });
    return null;
  }
}

function sanitizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    return `62${digits.slice(1)}`;
  }
  return digits;
}

function generateOrderNumber(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SPG-${yy}${mm}${dd}-${randomPart}`;
}

function isPermissionDeniedError(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return (
    e?.code === 7 ||
    e?.code === 'PERMISSION_DENIED' ||
    (typeof e?.message === 'string' && e.message.includes('PERMISSION_DENIED'))
  );
}

function isMissingCredentialsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Could not load the default credentials') ||
    message.includes('Unable to detect a Project Id') ||
    message.includes('FIREBASE_SERVICE_ACCOUNT_JSON') ||
    message.includes('FIREBASE_CLIENT_EMAIL')
  );
}

function sendConfigOrFirestoreError(res: Response, err: unknown) {
  if (isMissingCredentialsError(err)) {
    return res.status(503).json({
      code: 'ADMIN_SDK_CREDENTIALS_MISSING',
      error:
        'Kredensial Google Cloud ADC / Firebase Admin SDK belum tersedia di environment server. Pada Cloud Run, pastikan runtime service account terpasang; pada hosting non-GCP, setel FIREBASE_SERVICE_ACCOUNT_JSON.',
    });
  }
  if (isPermissionDeniedError(err)) {
    return res.status(503).json({
      code: 'OWNER_IAM_PERMISSION_DENIED',
      error:
        'Akses backend Admin SDK ke database Owner ditolak (PERMISSION_DENIED). Periksa role IAM pada project Firebase Owner yang terkonfigurasi.',
    });
  }
  console.error('Owner Firestore backend error:', err);
  return res.status(500).json({
    code: 'OWNER_FIRESTORE_ERROR',
    error: 'Gagal terhubung ke database SmartPOS Owner.',
  });
}

// In-memory sliding-window rate limiters for guest order lookup & creation
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LOOKUP_PER_ORDER_MAX_ATTEMPTS = 25;
const LOOKUP_PER_IP_MAX_ATTEMPTS = 60;
const CREATE_ORDER_PER_IP_MAX_ATTEMPTS = 20;
const LOCATION_SEARCH_PER_IP_MAX_ATTEMPTS = 45;
const RATE_QUOTE_PER_IP_MAX_ATTEMPTS = 30;
const RAJAONGKIR_LOCATION_SEARCH_PER_IP_MAX_ATTEMPTS = 30;
const RAJAONGKIR_RATE_QUOTE_PER_IP_MAX_ATTEMPTS = 20;
const REGION_LOOKUP_PER_IP_MAX_ATTEMPTS = 90;
const LOCAL_RATE_QUOTE_PER_IP_MAX_ATTEMPTS = 40;

function getClientIp(req: Request): string {
  return (
    (typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip) || 'unknown'
  );
}

function consumeRateLimit(
  key: string,
  maxAttempts: number,
  windowMs = RATE_LIMIT_WINDOW_MS
): boolean {
  const now = Date.now();
  if (rateLimitBuckets.size > 5000) {
    for (const [k, v] of rateLimitBuckets.entries()) {
      if (now > v.resetAt) rateLimitBuckets.delete(k);
    }
  }

  const entry = rateLimitBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxAttempts) {
    return false;
  }

  entry.count += 1;
  return true;
}

function checkLookupRateLimit(req: Request, orderNumber: string): boolean {
  const clientIp = getClientIp(req);
  const perIpAllowed = consumeRateLimit(
    `lookup_ip:${clientIp}`,
    LOOKUP_PER_IP_MAX_ATTEMPTS
  );
  const perOrderAllowed = consumeRateLimit(
    `lookup_ord:${clientIp}:${orderNumber}`,
    LOOKUP_PER_ORDER_MAX_ATTEMPTS
  );
  return perIpAllowed && perOrderAllowed;
}

function checkCreateOrderRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `create_ord:${clientIp}`,
    CREATE_ORDER_PER_IP_MAX_ATTEMPTS
  );
}

function checkLocationSearchRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `loc_search:${clientIp}`,
    LOCATION_SEARCH_PER_IP_MAX_ATTEMPTS
  );
}

function checkRateQuoteRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `rate_quote:${clientIp}`,
    RATE_QUOTE_PER_IP_MAX_ATTEMPTS
  );
}

function checkRajaOngkirLocationSearchRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `ro_loc_search:${clientIp}`,
    RAJAONGKIR_LOCATION_SEARCH_PER_IP_MAX_ATTEMPTS
  );
}

function checkRajaOngkirRateQuoteRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `ro_rate_quote:${clientIp}`,
    RAJAONGKIR_RATE_QUOTE_PER_IP_MAX_ATTEMPTS
  );
}

function checkRegionLookupRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `region_lookup:${clientIp}`,
    REGION_LOOKUP_PER_IP_MAX_ATTEMPTS
  );
}

function checkLocalRateQuoteRateLimit(req: Request): boolean {
  const clientIp = getClientIp(req);
  return consumeRateLimit(
    `local_rate_quote:${clientIp}`,
    LOCAL_RATE_QUOTE_PER_IP_MAX_ATTEMPTS
  );
}

// Single-store Owner local shipping rate CRUD limiter (60 req / 60s per authenticated UID).
// Note: In-memory per-instance limiter; does not synchronize across multiple instances.
export const OWNER_LOCAL_RATES_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const OWNER_LOCAL_RATES_RATE_LIMIT_MAX_REQUESTS = 60;
export const OWNER_LOCAL_RATES_RATE_LIMIT_MAX_BUCKETS = 5000;
const OWNER_LOCAL_RATES_CLEANUP_THRESHOLD = 128;

export interface RateLimitBucketEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

export function buildOwnerLocalRateLimitKey(uid: string): string {
  return `owner_local_rates:uid:${uid}`;
}

export function cleanupExpiredRateLimitBuckets(
  buckets: Map<string, RateLimitBucketEntry>,
  nowMs: number,
  maxBuckets: number
): number {
  let removed = 0;
  for (const [k, v] of buckets.entries()) {
    if (nowMs >= v.resetAt) {
      buckets.delete(k);
      removed += 1;
    }
  }
  while (buckets.size >= maxBuckets) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
    removed += 1;
  }
  return removed;
}

export interface OwnerLocalRateLimiter {
  maxRequests: number;
  windowMs: number;
  maxBuckets: number;
  cleanupExpired: () => number;
  consumeForUid: (uid: string) => RateLimitConsumeResult;
}

export function createOwnerLocalRateLimiter(options?: {
  maxRequests?: number;
  windowMs?: number;
  maxBuckets?: number;
  cleanupThreshold?: number;
  buckets?: Map<string, RateLimitBucketEntry>;
  now?: () => number;
}): OwnerLocalRateLimiter {
  const maxRequests = Math.max(
    1,
    Math.floor(options?.maxRequests ?? OWNER_LOCAL_RATES_RATE_LIMIT_MAX_REQUESTS)
  );
  const windowMs = Math.max(
    1000,
    Math.floor(options?.windowMs ?? OWNER_LOCAL_RATES_RATE_LIMIT_WINDOW_MS)
  );
  const maxBuckets = Math.max(
    1,
    Math.floor(options?.maxBuckets ?? OWNER_LOCAL_RATES_RATE_LIMIT_MAX_BUCKETS)
  );
  const cleanupThreshold = Math.max(
    1,
    Math.floor(options?.cleanupThreshold ?? OWNER_LOCAL_RATES_CLEANUP_THRESHOLD)
  );
  const buckets = options?.buckets ?? rateLimitBuckets;
  const nowFn = options?.now ?? (() => Date.now());

  return {
    maxRequests,
    windowMs,
    maxBuckets,
    cleanupExpired: () =>
      cleanupExpiredRateLimitBuckets(buckets, nowFn(), maxBuckets),
    consumeForUid: (uid: string): RateLimitConsumeResult => {
      const nowMs = nowFn();
      const key = buildOwnerLocalRateLimitKey(uid);
      const existing = buckets.get(key);

      if (existing && nowMs < existing.resetAt) {
        if (existing.count >= maxRequests) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((existing.resetAt - nowMs) / 1000)
          );
          return {
            allowed: false,
            limit: maxRequests,
            remaining: 0,
            retryAfterSeconds,
            resetAt: existing.resetAt,
          };
        }

        existing.count += 1;
        return {
          allowed: true,
          limit: maxRequests,
          remaining: Math.max(0, maxRequests - existing.count),
          retryAfterSeconds: 0,
          resetAt: existing.resetAt,
        };
      }

      if (existing) {
        buckets.delete(key);
      }

      if (buckets.size >= cleanupThreshold || buckets.size >= maxBuckets) {
        cleanupExpiredRateLimitBuckets(buckets, nowMs, maxBuckets);
      }

      const resetAt = nowMs + windowMs;
      buckets.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - 1),
        retryAfterSeconds: 0,
        resetAt,
      };
    },
  };
}

const defaultOwnerLocalRateLimiter = createOwnerLocalRateLimiter();

class OrderValidationError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseOptionalSelectedServiceCode(rawValue: unknown):
  | { ok: true; value: string | undefined }
  | { ok: false; error: string } {
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: undefined };
  }
  if (typeof rawValue !== 'string') {
    return {
      ok: false,
      error: 'Kode layanan pengiriman (selectedServiceCode) harus berupa teks yang valid.',
    };
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Format kode layanan pengiriman (selectedServiceCode) tidak valid.',
    };
  }
  return { ok: true, value: trimmed.toUpperCase() };
}

function buildIdempotencyScope(
  fulfillmentType: FulfillmentType,
  shippingProvider?: ShippingProvider,
  options?: {
    destinationDistrictId?: number;
    selectedServiceCode?: string;
  }
): string {
  if (fulfillmentType === 'pickup') {
    return 'pickup';
  }
  const provider = shippingProvider ?? 'STORE_COURIER';
  const destPart =
    options?.destinationDistrictId !== undefined
      ? `:dest=${options.destinationDistrictId}`
      : '';
  const svcPart = options?.selectedServiceCode
    ? `:svc=${options.selectedServiceCode}`
    : '';
  return `delivery:${provider}${destPart}${svcPart}`;
}

function resolveOrderIdempotencyScope(data: DocumentData): string {
  if (typeof data.idempotencyScope === 'string' && data.idempotencyScope.trim()) {
    return data.idempotencyScope.trim();
  }
  const fulfillmentType: FulfillmentType =
    data.fulfillmentType === 'delivery' ? 'delivery' : 'pickup';
  const rawShipping =
    data.shipping && typeof data.shipping === 'object'
      ? (data.shipping as Record<string, unknown>)
      : undefined;
  const provider = parseShippingProvider(rawShipping?.provider);
  const destinationDistrictId =
    parsePositiveInteger(rawShipping?.destinationDistrictId) ?? undefined;
  const parsedService = parseOptionalSelectedServiceCode(rawShipping?.serviceCode);
  return buildIdempotencyScope(fulfillmentType, provider, {
    destinationDistrictId,
    selectedServiceCode: parsedService.ok ? parsedService.value : undefined,
  });
}

function buildDeterministicOrderDocId(
  storeId: string,
  idempotencyKey: string,
  idempotencyScope: string
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${storeId}:${idempotencyScope}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 24);
  return `gord_${digest}`;
}

export interface GuestOrderStoreContext {
  storeId: string;
  db: Pick<Firestore, 'collection' | 'getAll' | 'runTransaction'>;
}

export function createGuestOrdersHandler(deps?: {
  getStoreContext?: (res: Response) => GuestOrderStoreContext | null;
  checkRateLimit?: (req: Request) => boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  rateCache?: BoundedTtlCache<JntRateOption[]>;
  rateCacheTtlMs?: number;
  now?: () => number;
}) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const ctx = deps?.getStoreContext
      ? deps.getStoreContext(res)
      : ensureBackendConfigured(res);
    if (!ctx) return;

    const allowed = (deps?.checkRateLimit ?? checkCreateOrderRateLimit)(req);
    if (!allowed) {
      return res.status(429).json({
        error: 'Terlalu banyak pengiriman pesanan. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'Payload pesanan harus berupa objek JSON yang valid.',
      });
    }

    const body = req.body as Partial<CreateGuestOrderPayload>;

    const customerName =
      typeof body.customerName === 'string' ? body.customerName.trim() : '';
    const customerPhoneRaw =
      typeof body.customerPhone === 'string' ? body.customerPhone.trim() : '';
    const fulfillmentType = body.fulfillmentType;
    const rawShippingProvider = body.shippingProvider;
    const deliveryAddress =
      typeof body.deliveryAddress === 'string'
        ? body.deliveryAddress.trim().slice(0, 360)
        : '';
    const rawDestinationDistrictId = body.destinationDistrictId;
    const rawSelectedServiceCode = body.selectedServiceCode;
    const rawExpectedShippingFee = body.expectedShippingFee;
    const notes =
      typeof body.notes === 'string' ? body.notes.trim().slice(0, 300) : '';
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    const requestedItems = Array.isArray(body.items) ? body.items : [];

    if (customerName.length < 2 || customerName.length > 80) {
      return res.status(400).json({
        error: 'Nama pelanggan wajib diisi (2–80 karakter).',
      });
    }

    const sanitizedPhone = sanitizePhone(customerPhoneRaw);
    if (
      sanitizedPhone.length < 9 ||
      sanitizedPhone.length > 15 ||
      /^620/.test(sanitizedPhone) ||
      /^(?:62)?0+$/.test(sanitizedPhone)
    ) {
      return res.status(400).json({
        error: 'Nomor WhatsApp tidak valid. Gunakan format 08xx atau 628xx.',
      });
    }

    if (fulfillmentType !== 'pickup' && fulfillmentType !== 'delivery') {
      return res.status(400).json({
        error: 'Pilihan pengambilan atau pengiriman tidak valid.',
      });
    }

    let resolvedShippingProvider: ShippingProvider | undefined;
    if (
      rawShippingProvider !== undefined &&
      rawShippingProvider !== null &&
      String(rawShippingProvider).trim() !== ''
    ) {
      const parsedProvider = parseShippingProvider(rawShippingProvider);
      if (!parsedProvider) {
        return res.status(400).json({
          error:
            'Pilihan kurir pengiriman tidak valid. Gunakan STORE_COURIER atau JNT_EXPRESS.',
        });
      }
      if (fulfillmentType === 'pickup') {
        return res.status(400).json({
          error:
            'Pilihan kurir pengiriman hanya berlaku untuk metode kirim ke alamat (delivery).',
        });
      }
      resolvedShippingProvider = parsedProvider;
    } else if (fulfillmentType === 'delivery') {
      // Legacy clients omitting shippingProvider default safely to store courier
      resolvedShippingProvider = 'STORE_COURIER';
    }

    let destinationDistrictId: number | undefined;
    if (
      rawDestinationDistrictId !== undefined &&
      rawDestinationDistrictId !== null &&
      String(rawDestinationDistrictId).trim() !== ''
    ) {
      if (fulfillmentType === 'pickup') {
        return res.status(400).json({
          error:
            'ID kecamatan tujuan hanya berlaku untuk metode kirim ke alamat (delivery).',
        });
      }
      if (resolvedShippingProvider !== 'JNT_EXPRESS') {
        return res.status(400).json({
          error:
            'ID kecamatan tujuan hanya berlaku untuk pengiriman JNT_EXPRESS.',
        });
      }
      const parsedDest = parsePositiveInteger(rawDestinationDistrictId);
      if (parsedDest === null) {
        return res.status(400).json({
          error:
            'ID kecamatan tujuan (destinationDistrictId) harus berupa bilangan bulat positif.',
        });
      }
      destinationDistrictId = parsedDest;
    }

    const parsedServiceCode = parseOptionalSelectedServiceCode(
      rawSelectedServiceCode
    );
    if (!parsedServiceCode.ok) {
      return res.status(400).json({
        error: parsedServiceCode.error,
      });
    }
    const selectedServiceCode = parsedServiceCode.value;
    if (selectedServiceCode !== undefined) {
      if (fulfillmentType === 'pickup') {
        return res.status(400).json({
          error:
            'Kode layanan pengiriman hanya berlaku untuk metode kirim ke alamat (delivery).',
        });
      }
      if (resolvedShippingProvider !== 'JNT_EXPRESS') {
        return res.status(400).json({
          error:
            'Kode layanan pengiriman hanya berlaku untuk pengiriman JNT_EXPRESS.',
        });
      }
    }

    let expectedShippingFee: number | undefined;
    if (
      rawExpectedShippingFee !== undefined &&
      rawExpectedShippingFee !== null
    ) {
      if (
        typeof rawExpectedShippingFee !== 'number' ||
        !Number.isFinite(rawExpectedShippingFee) ||
        rawExpectedShippingFee < 0 ||
        rawExpectedShippingFee > MAX_MANUAL_SHIPPING_FEE
      ) {
        return res.status(400).json({
          error:
            'Perkiraan ongkos kirim (expectedShippingFee) harus berupa angka valid yang tidak negatif.',
        });
      }
      if (
        fulfillmentType !== 'delivery' ||
        resolvedShippingProvider !== 'JNT_EXPRESS' ||
        destinationDistrictId === undefined ||
        selectedServiceCode === undefined
      ) {
        return res.status(400).json({
          error:
            'Perkiraan ongkos kirim (expectedShippingFee) hanya berlaku untuk pengiriman JNT_EXPRESS dengan kecamatan tujuan dan layanan terpilih.',
        });
      }
      expectedShippingFee = Math.round(rawExpectedShippingFee * 100) / 100;
    }

    if (fulfillmentType === 'delivery' && deliveryAddress.length < 8) {
      return res.status(400).json({
        error: 'Alamat pengiriman lengkap wajib diisi untuk layanan antar.',
      });
    }

    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      return res.status(400).json({
        error: 'Kunci idempotensi pesanan tidak valid.',
      });
    }

    if (requestedItems.length === 0 || requestedItems.length > 50) {
      return res.status(400).json({
        error: 'Keranjang belanja tidak boleh kosong.',
      });
    }

    const qtyByProduct = new Map<string, number>();
    for (const entry of requestedItems) {
      if (
        !entry ||
        typeof entry.productId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.productId)
      ) {
        return res.status(400).json({
          error: 'Format ID produk pesanan tidak valid.',
        });
      }
      const qty = Number(entry.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({
          error:
            'Jumlah setiap barang harus berupa bilangan bulat antara 1 dan 99.',
        });
      }
      const nextMergedQty = (qtyByProduct.get(entry.productId) ?? 0) + qty;
      if (nextMergedQty > 99) {
        return res.status(400).json({
          error: 'Jumlah maksimal per produk adalah 99 per pesanan.',
        });
      }
      qtyByProduct.set(entry.productId, nextMergedQty);
    }

    try {
      const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
      const guestOrdersCol = storeRef.collection('guest_orders');
      const idempotencyScope = buildIdempotencyScope(
        fulfillmentType,
        resolvedShippingProvider,
        {
          destinationDistrictId,
          selectedServiceCode,
        }
      );
      const deterministicOrderId = buildDeterministicOrderDocId(
        ctx.storeId,
        idempotencyKey,
        idempotencyScope
      );
      const orderRef = guestOrdersCol.doc(deterministicOrderId);

      // Verify J&T Express tariff server-side BEFORE entering the Firestore transaction
      // (never make external HTTP calls inside runTransaction).
      let verifiedQuote:
        | {
            expectedItemsSubtotal: number;
            expectedTotalWeightGrams: number;
            matchedRate: JntRateOption;
          }
        | undefined;

      if (
        fulfillmentType === 'delivery' &&
        resolvedShippingProvider === 'JNT_EXPRESS' &&
        destinationDistrictId !== undefined &&
        selectedServiceCode !== undefined
      ) {
        const preExistingSnap = await orderRef.get();
        if (!preExistingSnap.exists) {
          const fetchProductsByIds = async (
            productIds: string[]
          ): Promise<ServerProductQuoteSnapshot[]> => {
            const refs = productIds.map((pid) =>
              storeRef.collection('products').doc(pid)
            );
            const snaps = await ctx.db.getAll(...refs);
            return snaps.map((snap) => ({
              id: snap.id,
              exists: snap.exists,
              data: snap.exists ? snap.data() : undefined,
            }));
          };

          const quoteResult = await quoteJntShippingRatesForStore(
            fetchProductsByIds,
            {
              destinationDistrictId,
              items: Array.from(qtyByProduct.entries()).map(
                ([productId, quantity]) => ({ productId, quantity })
              ),
            },
            {
              env: deps?.env,
              fetchImpl: deps?.fetchImpl,
              rateCache: deps?.rateCache ?? kiriminAjaRateCache,
              rateCacheTtlMs: deps?.rateCacheTtlMs,
              now: deps?.now,
            }
          );

          if (quoteResult.statusCode === 404 || quoteResult.statusCode === 409) {
            const errMessage =
              'error' in quoteResult.body
                ? quoteResult.body.error
                : 'Produk tidak tersedia atau stok tidak mencukupi.';
            throw new OrderValidationError(quoteResult.statusCode, errMessage);
          }

          if (
            quoteResult.statusCode === 200 &&
            'rates' in quoteResult.body &&
            quoteResult.body.available &&
            !quoteResult.body.fallbackToManual &&
            !quoteResult.body.hasUnweighedItems
          ) {
            const matchedRate = quoteResult.body.rates.find(
              (rate) =>
                rate.courier === 'jnt' &&
                rate.serviceCode.toUpperCase() === selectedServiceCode
            );
            if (
              matchedRate &&
              Number.isFinite(matchedRate.cost) &&
              matchedRate.cost >= 0
            ) {
              verifiedQuote = {
                expectedItemsSubtotal: quoteResult.body.itemsSubtotal,
                expectedTotalWeightGrams: quoteResult.body.totalWeightGrams,
                matchedRate,
              };
            }
          }

          if (expectedShippingFee !== undefined) {
            const serverVerifiedFee = verifiedQuote
              ? Math.round(verifiedQuote.matchedRate.cost * 100) / 100
              : 0;
            const willFallbackToManual = !verifiedQuote;

            if (
              willFallbackToManual ||
              Math.abs(serverVerifiedFee - expectedShippingFee) > 0.01
            ) {
              const quoteBody =
                'rates' in quoteResult.body ? quoteResult.body : undefined;
              const formattedPrev = new Intl.NumberFormat('id-ID').format(
                expectedShippingFee
              );
              const formattedNext = new Intl.NumberFormat('id-ID').format(
                serverVerifiedFee
              );
              return res.status(409).json({
                code: 'SHIPPING_RATE_CHANGED',
                error: willFallbackToManual
                  ? `Tarif J&T otomatis (Rp ${formattedPrev}) tidak dapat diverifikasi saat ini. Konfirmasi untuk melanjutkan dengan ongkos kirim manual oleh Owner.`
                  : `Tarif J&T (${selectedServiceCode}) berubah dari Rp ${formattedPrev} menjadi Rp ${formattedNext}. Konfirmasi nominal terbaru sebelum pesanan dibuat.`,
                expectedShippingFee,
                verifiedShippingFee: serverVerifiedFee,
                verifiedShippingStatus: willFallbackToManual
                  ? 'PENDING_RATE'
                  : 'READY_TO_SHIP',
                fallbackToManual: willFallbackToManual,
                ...(verifiedQuote
                  ? { selectedServiceCode: verifiedQuote.matchedRate.serviceCode }
                  : {}),
                rates: quoteBody?.rates ?? [],
                ...(quoteBody
                  ? {
                      itemsSubtotal: quoteBody.itemsSubtotal,
                      totalWeightGrams: quoteBody.totalWeightGrams,
                      hasUnweighedItems: quoteBody.hasUnweighedItems,
                    }
                  : {}),
              });
            }
          }
        }
      }

      // Atomic transaction guarantees idempotency even under simultaneous double-submits:
      // all reads precede the single order create, and stock/sales are never modified.
      const txResult = await ctx.db.runTransaction(async (tx) => {
        const existingByIdSnap = await tx.get(orderRef);
        if (existingByIdSnap.exists) {
          return {
            deduplicated: true as const,
            orderId: existingByIdSnap.id,
            data: existingByIdSnap.data() || {},
          };
        }

        const existingByKeySnap = await tx.get(
          guestOrdersCol.where('idempotencyKey', '==', idempotencyKey).limit(5)
        );
        const matchingScopeDoc = existingByKeySnap.docs.find(
          (docSnap) =>
            resolveOrderIdempotencyScope(docSnap.data() || {}) === idempotencyScope
        );
        if (matchingScopeDoc) {
          return {
            deduplicated: true as const,
            orderId: matchingScopeDoc.id,
            data: matchingScopeDoc.data() || {},
          };
        }

        const productRefs = Array.from(qtyByProduct.keys()).map((pid) =>
          storeRef.collection('products').doc(pid)
        );
        const productSnaps = await tx.getAll(...productRefs);

        const orderItemsPayload: Array<Record<string, unknown>> = [];
        let itemsSubtotal = 0;
        let totalWeightGrams = 0;
        let hasUnweighedItems = false;

        for (const snap of productSnaps) {
          const requestedQty = qtyByProduct.get(snap.id) ?? 0;
          const data = snap.data();

          if (!snap.exists || !data || !isProductAvailableForCatalog(data)) {
            throw new OrderValidationError(
              404,
              `Produk tidak ditemukan atau tidak tersedia (${snap.id}).`
            );
          }

          const publicProduct = mapOwnerProductToPublic(snap.id, data);
          if (publicProduct.stock < requestedQty) {
            throw new OrderValidationError(
              409,
              publicProduct.stock === 0
                ? `Stok "${publicProduct.name}" saat ini habis.`
                : `Stok "${publicProduct.name}" tersisa ${publicProduct.stock} ${publicProduct.unit}. Kurangi jumlah pesanan.`
            );
          }

          const subtotal = publicProduct.price * requestedQty;
          itemsSubtotal += subtotal;

          const unitWeightGrams = publicProduct.weightGrams;
          if (unitWeightGrams === undefined || unitWeightGrams <= 0) {
            hasUnweighedItems = true;
          } else {
            totalWeightGrams += unitWeightGrams * requestedQty;
          }

          orderItemsPayload.push({
            productId: snap.id,
            sku: publicProduct.sku,
            barcode: typeof data.barcode === 'string' ? data.barcode : '',
            productName: publicProduct.name,
            name: publicProduct.name,
            quantity: requestedQty,
            price: publicProduct.price,
            unitPrice: publicProduct.price,
            subtotal,
            ...(unitWeightGrams !== undefined
              ? { weightGrams: unitWeightGrams }
              : {}),
            imageUrl: publicProduct.imageUrl,
          });
        }

        const roundedItemsSubtotal = Math.round(itemsSubtotal * 100) / 100;
        const normalizedTotalWeightGrams =
          Math.round(totalWeightGrams * 100) / 100;
        const orderNumber = generateOrderNumber();
        const nowIso = new Date().toISOString();

        const canApplyVerifiedRate = Boolean(
          verifiedQuote &&
            fulfillmentType === 'delivery' &&
            resolvedShippingProvider === 'JNT_EXPRESS' &&
            !hasUnweighedItems &&
            roundedItemsSubtotal === verifiedQuote.expectedItemsSubtotal &&
            normalizedTotalWeightGrams ===
              verifiedQuote.expectedTotalWeightGrams &&
            Number.isFinite(verifiedQuote.matchedRate.cost) &&
            verifiedQuote.matchedRate.cost >= 0
        );

        if (expectedShippingFee !== undefined && !canApplyVerifiedRate) {
          throw new OrderValidationError(
            409,
            'Data produk atau tarif J&T berubah saat pesanan diproses. Silakan muat ulang dan konfirmasi ulang pesanan Anda.'
          );
        }

        const verifiedShippingFee =
          canApplyVerifiedRate && verifiedQuote
            ? Math.round(verifiedQuote.matchedRate.cost * 100) / 100
            : 0;
        const finalOrderTotal =
          Math.round((roundedItemsSubtotal + verifiedShippingFee) * 100) / 100;

        const deliveryShippingData: GuestOrderShipping | undefined =
          fulfillmentType === 'delivery'
            ? resolvedShippingProvider === 'JNT_EXPRESS'
              ? canApplyVerifiedRate && verifiedQuote
                ? {
                    provider: 'JNT_EXPRESS',
                    serviceCode: verifiedQuote.matchedRate.serviceCode,
                    ...(destinationDistrictId !== undefined
                      ? { destinationDistrictId }
                      : {}),
                    status: 'READY_TO_SHIP',
                    totalWeightGrams: normalizedTotalWeightGrams,
                    hasUnweighedItems: false,
                    shippingFee: verifiedShippingFee,
                    shippingFeeConfirmed: true,
                    updatedAt: nowIso,
                  }
                : {
                    provider: 'JNT_EXPRESS',
                    ...(destinationDistrictId !== undefined
                      ? { destinationDistrictId }
                      : {}),
                    status: 'PENDING_RATE',
                    totalWeightGrams: normalizedTotalWeightGrams,
                    hasUnweighedItems,
                    shippingFee: 0,
                    shippingFeeConfirmed: false,
                    updatedAt: nowIso,
                  }
              : {
                  provider: 'STORE_COURIER',
                  totalWeightGrams: normalizedTotalWeightGrams,
                  hasUnweighedItems,
                  shippingFee: 0,
                  shippingFeeConfirmed: true,
                }
            : undefined;

        // Store full sanitized phone in Firestore for SmartPOS Owner;
        // never deduct stock and never touch sales or stock_mutations collections.
        tx.create(orderRef, {
          orderId: deterministicOrderId,
          orderNumber,
          storeId: ctx.storeId,
          idempotencyKey,
          idempotencyScope,
          customerName,
          guestName: customerName,
          customerPhone: sanitizedPhone,
          fulfillmentType,
          deliveryAddress:
            fulfillmentType === 'delivery' ? deliveryAddress : '',
          notes,
          items: orderItemsPayload,
          ...(fulfillmentType === 'delivery'
            ? { itemsSubtotal: roundedItemsSubtotal }
            : {}),
          total: finalOrderTotal,
          totalAmount: finalOrderTotal,
          status: 'PENDING',
          stockDeducted: false,
          ...(deliveryShippingData ? { shipping: deliveryShippingData } : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          deduplicated: false as const,
          orderId: deterministicOrderId,
          data: null,
        };
      });

      if (txResult.deduplicated) {
        return res.status(200).json({
          order: mapFirestoreOrderToGuestOrder(txResult.orderId, txResult.data),
          deduplicated: true,
        });
      }

      const savedSnap = await orderRef.get();
      const savedOrder = mapFirestoreOrderToGuestOrder(
        savedSnap.id,
        savedSnap.data() || {}
      );

      return res.status(201).json({
        order: savedOrder,
      });
    } catch (err) {
      if (err instanceof OrderValidationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return sendConfigOrFirestoreError(res, err);
    }
  };
}

export function createGuestOrderLookupHandler(deps?: {
  getStoreContext?: (res: Response) => GuestOrderStoreContext | null;
  checkRateLimit?: (req: Request, orderNumber: string) => boolean;
}) {
  return async (req: Request, res: Response) => {
    const ctx = deps?.getStoreContext
      ? deps.getStoreContext(res)
      : ensureBackendConfigured(res);
    if (!ctx) return;

    const rawOrderNumber = String(req.params.orderNumber || '')
      .trim()
      .toUpperCase();
    const phoneLast4 = String(req.query.phoneLast4 || '')
      .replace(/\D/g, '')
      .trim();

    if (!/^[A-Z0-9_-]{4,40}$/.test(rawOrderNumber)) {
      return res.status(400).json({
        error: 'Nomor pesanan tidak valid.',
      });
    }

    if (!/^\d{4}$/.test(phoneLast4)) {
      return res.status(400).json({
        error: 'Masukkan 4 digit terakhir nomor WhatsApp untuk verifikasi pesanan.',
      });
    }

    const allowed = (deps?.checkRateLimit ?? checkLookupRateLimit)(
      req,
      rawOrderNumber
    );
    if (!allowed) {
      return res.status(429).json({
        error: 'Terlalu banyak percobaan pencarian. Tunggu beberapa menit lalu coba lagi.',
      });
    }

    try {
      const snap = await ctx.db
        .collection('stores')
        .doc(ctx.storeId)
        .collection('guest_orders')
        .where('orderNumber', '==', rawOrderNumber)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(404).json({
          error: 'Pesanan tidak ditemukan atau 4 digit terakhir WhatsApp tidak cocok.',
        });
      }

      const docSnap = snap.docs[0];
      const data = docSnap.data();
      const storedDigits = String(data.customerPhone || '').replace(/\D/g, '');

      if (!storedDigits.endsWith(phoneLast4)) {
        return res.status(404).json({
          error: 'Pesanan tidak ditemukan atau 4 digit terakhir WhatsApp tidak cocok.',
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        order: mapFirestoreOrderToGuestOrder(docSnap.id, data),
      });
    } catch (err) {
      return sendConfigOrFirestoreError(res, err);
    }
  };
}

export type OwnerManageableShippingStatus =
  | 'READY_TO_SHIP'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'FAILED';

const OWNER_MANAGEABLE_SHIPPING_STATUSES =
  new Set<OwnerManageableShippingStatus>([
    'READY_TO_SHIP',
    'PICKED_UP',
    'IN_TRANSIT',
    'DELIVERED',
    'FAILED',
  ]);

const MAX_MANUAL_SHIPPING_FEE = 50_000_000;

export interface ParsedOwnerShippingUpdate {
  shippingFee?: number;
  confirmExistingFee?: boolean;
  trackingNumber?: string;
  status?: OwnerManageableShippingStatus;
  notes?: string;
  serviceCode?: string;
}

export function parseOwnerShippingUpdatePayload(
  rawBody: unknown
): ParsedOwnerShippingUpdate {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new OwnerOrderActionError(
      400,
      'INVALID_SHIPPING_PAYLOAD',
      'Payload pembaruan pengiriman harus berupa objek JSON yang valid.'
    );
  }

  const body = rawBody as Record<string, unknown>;
  const parsed: ParsedOwnerShippingUpdate = {};

  if (body.shippingFee !== undefined) {
    const rawFee = body.shippingFee;
    if (
      rawFee === null ||
      typeof rawFee === 'boolean' ||
      (typeof rawFee === 'string' && rawFee.trim() === '') ||
      (typeof rawFee !== 'number' && typeof rawFee !== 'string')
    ) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_FEE',
        'Ongkos kirim harus berupa angka valid yang tidak negatif.'
      );
    }
    const numericFee =
      typeof rawFee === 'number' ? rawFee : Number(rawFee.trim());
    if (
      !Number.isFinite(numericFee) ||
      numericFee < 0 ||
      numericFee > MAX_MANUAL_SHIPPING_FEE
    ) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_FEE',
        'Ongkos kirim harus bernilai antara 0 hingga 50.000.000.'
      );
    }
    parsed.shippingFee = Math.round(numericFee * 100) / 100;
  }

  if (body.shippingFeeConfirmed !== undefined) {
    if (typeof body.shippingFeeConfirmed !== 'boolean') {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_CONFIRMATION',
        'Nilai shippingFeeConfirmed harus berupa boolean.'
      );
    }
    if (body.shippingFeeConfirmed === false && parsed.shippingFee !== undefined) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_CONFIRMATION',
        'Ongkos kirim yang ditetapkan tidak dapat ditandai belum terkonfirmasi.'
      );
    }
    if (body.shippingFeeConfirmed === true && parsed.shippingFee === undefined) {
      parsed.confirmExistingFee = true;
    }
  }

  const rawTracking =
    body.trackingNumber !== undefined ? body.trackingNumber : body.awb;
  if (rawTracking !== undefined) {
    if (typeof rawTracking !== 'string') {
      throw new OwnerOrderActionError(
        400,
        'INVALID_TRACKING_NUMBER',
        'Nomor resi / AWB harus berupa teks.'
      );
    }
    const cleanTracking = rawTracking.trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(cleanTracking)) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_TRACKING_NUMBER',
        'Nomor resi / AWB harus 4–64 karakter (huruf, angka, tanda hubung, atau garis bawah).'
      );
    }
    parsed.trackingNumber = cleanTracking;
  }

  if (
    body.status !== undefined &&
    body.shippingStatus !== undefined &&
    body.status !== body.shippingStatus
  ) {
    throw new OwnerOrderActionError(
      400,
      'INVALID_SHIPPING_STATUS',
      'Field status dan shippingStatus tidak boleh bertentangan.'
    );
  }
  const rawStatus =
    body.status !== undefined ? body.status : body.shippingStatus;
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== 'string') {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_STATUS',
        'Status pengiriman harus berupa teks yang valid.'
      );
    }
    const normalizedStatus =
      rawStatus.trim().toUpperCase() as OwnerManageableShippingStatus;
    if (!OWNER_MANAGEABLE_SHIPPING_STATUSES.has(normalizedStatus)) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_STATUS',
        'Status pengiriman tidak valid. Pilihan yang diizinkan: READY_TO_SHIP, PICKED_UP, IN_TRANSIT, DELIVERED, FAILED.'
      );
    }
    parsed.status = normalizedStatus;
  }

  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_NOTES',
        'Catatan pengiriman harus berupa teks.'
      );
    }
    const cleanNotes = body.notes.trim();
    if (cleanNotes.length > 300) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SHIPPING_NOTES',
        'Catatan pengiriman maksimal 300 karakter.'
      );
    }
    parsed.notes = cleanNotes;
  }

  if (body.serviceCode !== undefined) {
    if (typeof body.serviceCode !== 'string') {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SERVICE_CODE',
        'Kode layanan kurir harus berupa teks.'
      );
    }
    const cleanServiceCode = body.serviceCode.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}$/.test(cleanServiceCode)) {
      throw new OwnerOrderActionError(
        400,
        'INVALID_SERVICE_CODE',
        'Kode layanan kurir tidak valid (1–32 karakter alfanumerik).'
      );
    }
    parsed.serviceCode = cleanServiceCode;
  }

  if (
    parsed.shippingFee === undefined &&
    !parsed.confirmExistingFee &&
    parsed.trackingNumber === undefined &&
    parsed.status === undefined &&
    parsed.notes === undefined &&
    parsed.serviceCode === undefined
  ) {
    throw new OwnerOrderActionError(
      400,
      'EMPTY_SHIPPING_UPDATE',
      'Minimal satu data pengiriman (ongkir, resi/AWB, status, atau catatan) harus diisi.'
    );
  }

  return parsed;
}

export function computeValidatedItemsSubtotalFromOrderDoc(
  orderData: DocumentData
): number {
  const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
  let sum = 0;
  let hasPricedItem = false;

  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    const qty = Number(item.quantity ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
    if (
      Number.isFinite(qty) &&
      qty > 0 &&
      Number.isFinite(unitPrice) &&
      unitPrice >= 0
    ) {
      sum += unitPrice * qty;
      hasPricedItem = true;
    }
  }

  if (hasPricedItem) {
    return Math.round(sum * 100) / 100;
  }

  const storedSubtotal = parseOptionalNonNegativeNumber(orderData.itemsSubtotal);
  if (storedSubtotal !== undefined) {
    return storedSubtotal;
  }

  const existingTotal =
    parseOptionalNonNegativeNumber(orderData.total ?? orderData.totalAmount) ?? 0;
  const existingShippingFee =
    parseOptionalNonNegativeNumber(
      (orderData.shipping as Record<string, unknown> | undefined)?.shippingFee
    ) ?? 0;
  return Math.max(
    0,
    Math.round((existingTotal - existingShippingFee) * 100) / 100
  );
}

export async function updateGuestOrderShippingInTransaction(
  tx: TxLike,
  storeRef: StoreRefLike,
  authorizedStoreId: string,
  orderId: string,
  input: ParsedOwnerShippingUpdate
): Promise<{
  orderId: string;
  updatedData: DocumentData;
  linkedToCashierTransaction: boolean;
}> {
  const orderRef = storeRef.collection('guest_orders').doc(orderId);
  const orderSnap = await tx.get(orderRef);

  if (!orderSnap.exists) {
    throw new OwnerOrderActionError(
      404,
      'ORDER_NOT_FOUND',
      'Pesanan tamu tidak ditemukan.'
    );
  }

  const orderData = orderSnap.data() || {};
  const docStoreId =
    typeof orderData.storeId === 'string' ? orderData.storeId.trim() : '';
  if (docStoreId && docStoreId !== authorizedStoreId) {
    throw new OwnerOrderActionError(
      403,
      'ORDER_STORE_MISMATCH',
      'Pesanan ini bukan milik toko yang berwenang.'
    );
  }

  if (isCancelledOrderStatus(orderData.status)) {
    throw new OwnerOrderActionError(
      409,
      'ORDER_CANCELLED',
      'Pesanan berstatus batal/ditolak tidak dapat diperbarui pengirimannya.'
    );
  }

  if (orderData.fulfillmentType !== 'delivery') {
    throw new OwnerOrderActionError(
      409,
      'ORDER_NOT_DELIVERY',
      'Pesanan ambil di toko (pickup) tidak menggunakan pengiriman kurir.'
    );
  }

  const orderNumber = String(orderData.orderNumber ?? '').trim();
  const linkQueries = [
    storeRef.collection('sales').where('guestOrderId', '==', orderId).limit(1),
    storeRef
      .collection('transactions')
      .where('guestOrderId', '==', orderId)
      .limit(1),
  ];
  if (orderNumber) {
    linkQueries.push(
      storeRef.collection('sales').where('orderNumber', '==', orderNumber).limit(1),
      storeRef
        .collection('transactions')
        .where('orderNumber', '==', orderNumber)
        .limit(1)
    );
  }

  const linkSnapshots = await Promise.all(linkQueries.map((q) => tx.get(q)));
  const hasExternalSaleRef = linkSnapshots.some((snap) => !snap.empty);
  const linkCheck = isOrderLinkedToCashierTransaction(
    orderData,
    hasExternalSaleRef
  );

  const existingShipping =
    mapFirestoreShippingToGuestShipping(orderData.shipping) ?? {};
  const existingShippingFee = existingShipping.shippingFee ?? 0;
  const existingFeeConfirmed = Boolean(existingShipping.shippingFeeConfirmed);

  const attemptsFinancialChange =
    (input.shippingFee !== undefined &&
      (input.shippingFee !== existingShippingFee || !existingFeeConfirmed)) ||
    (Boolean(input.confirmExistingFee) && !existingFeeConfirmed);

  if (linkCheck.linked && attemptsFinancialChange) {
    throw new OwnerOrderActionError(
      409,
      'ORDER_LINKED_TO_TRANSACTION',
      'Pesanan sudah terhubung dengan transaksi penjualan Kasir yang selesai, sehingga ongkos kirim dan total pembayaran tidak dapat diubah.'
    );
  }

  if (
    input.status !== undefined &&
    existingShipping.status === 'DELIVERED' &&
    input.status !== 'DELIVERED'
  ) {
    throw new OwnerOrderActionError(
      409,
      'INVALID_SHIPPING_STATUS_TRANSITION',
      'Status pengiriman yang sudah DELIVERED tidak dapat dikembalikan ke status sebelumnya.'
    );
  }

  const nowIso = new Date().toISOString();
  const validatedItemsSubtotal =
    computeValidatedItemsSubtotalFromOrderDoc(orderData);
  const nextShippingFee =
    input.shippingFee !== undefined ? input.shippingFee : existingShippingFee;
  const nextShippingFeeConfirmed =
    input.shippingFee !== undefined
      ? true
      : input.confirmExistingFee
      ? true
      : existingFeeConfirmed;
  const nextTotal =
    Math.round((validatedItemsSubtotal + nextShippingFee) * 100) / 100;

  let nextShippingStatus: ShippingStatus | undefined = input.status;
  if (!nextShippingStatus) {
    if (
      existingShipping.status === 'PENDING_RATE' &&
      (input.shippingFee !== undefined || input.confirmExistingFee)
    ) {
      nextShippingStatus = 'READY_TO_SHIP';
    } else {
      nextShippingStatus = existingShipping.status;
    }
  }

  const nextProvider: ShippingProvider =
    existingShipping.provider ?? 'STORE_COURIER';

  let nextShippedAt = existingShipping.shippedAt;
  if (
    !nextShippedAt &&
    (nextShippingStatus === 'PICKED_UP' ||
      nextShippingStatus === 'IN_TRANSIT' ||
      nextShippingStatus === 'DELIVERED')
  ) {
    nextShippedAt = nowIso;
  }

  let nextDeliveredAt = existingShipping.deliveredAt;
  if (!nextDeliveredAt && nextShippingStatus === 'DELIVERED') {
    nextDeliveredAt = nowIso;
  }

  const nextServiceCode =
    input.serviceCode !== undefined
      ? input.serviceCode
      : existingShipping.serviceCode;
  const nextTrackingNumber =
    input.trackingNumber !== undefined
      ? input.trackingNumber
      : existingShipping.trackingNumber;
  const nextNotes =
    input.notes !== undefined
      ? input.notes || undefined
      : existingShipping.notes;

  const nextShippingDoc: Record<string, unknown> = {
    provider: nextProvider,
    ...(nextServiceCode !== undefined ? { serviceCode: nextServiceCode } : {}),
    ...(existingShipping.destinationDistrictId !== undefined
      ? { destinationDistrictId: existingShipping.destinationDistrictId }
      : {}),
    ...(nextShippingStatus !== undefined ? { status: nextShippingStatus } : {}),
    ...(existingShipping.totalWeightGrams !== undefined
      ? { totalWeightGrams: existingShipping.totalWeightGrams }
      : {}),
    ...(existingShipping.hasUnweighedItems !== undefined
      ? { hasUnweighedItems: existingShipping.hasUnweighedItems }
      : {}),
    shippingFee: nextShippingFee,
    shippingFeeConfirmed: nextShippingFeeConfirmed,
    ...(nextTrackingNumber !== undefined
      ? { trackingNumber: nextTrackingNumber }
      : {}),
    ...(nextNotes !== undefined ? { notes: nextNotes } : {}),
    updatedAt: nowIso,
    ...(nextShippedAt !== undefined ? { shippedAt: nextShippedAt } : {}),
    ...(nextDeliveredAt !== undefined ? { deliveredAt: nextDeliveredAt } : {}),
  };

  // Never alter top-level GuestOrderStatus, product stock, or unrelated orders.
  tx.update(orderRef, {
    itemsSubtotal: validatedItemsSubtotal,
    total: nextTotal,
    totalAmount: nextTotal,
    shipping: nextShippingDoc,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    orderId: orderSnap.id,
    updatedData: {
      ...orderData,
      itemsSubtotal: validatedItemsSubtotal,
      total: nextTotal,
      totalAmount: nextTotal,
      shipping: nextShippingDoc,
      updatedAt: nowIso,
    },
    linkedToCashierTransaction: linkCheck.linked,
  };
}

export function ensureBackendConfigured(
  res: Response,
  deps?: {
    getStoreId?: () => string;
    getFirestore?: () => Firestore;
  }
): {
  storeId: string;
  db: Firestore;
} | null {
  const storeId = (
    deps?.getStoreId ? deps.getStoreId() : getConfiguredStoreId()
  ).trim();
  if (!storeId) {
    res.status(503).json({
      code: 'STORE_ID_MISSING',
      error:
        'Konfigurasi STORE_ID belum disetel pada environment server. Setel environment variable STORE_ID dengan UID pemilik SmartPOS Owner.',
    });
    return null;
  }

  try {
    const db = deps?.getFirestore ? deps.getFirestore() : getOwnerFirestore();
    return { storeId, db };
  } catch (err) {
    res.status(503).json({
      code: 'ADMIN_SDK_CONFIG_ERROR',
      error:
        err instanceof Error
          ? err.message
          : 'Konfigurasi Firebase Admin SDK belum lengkap.',
    });
    return null;
  }
}

export function createMalformedJsonErrorHandler() {
  return (
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const jsonErr = err as {
      type?: string;
      status?: number;
      statusCode?: number;
    };
    if (
      err instanceof SyntaxError &&
      (jsonErr.type === 'entity.parse.failed' ||
        jsonErr.status === 400 ||
        jsonErr.statusCode === 400)
    ) {
      return res.status(400).json({
        code: 'INVALID_JSON',
        error: 'Format body JSON tidak valid.',
      });
    }
    return next(err);
  };
}

export function createOwnerLocalShippingRateServerHandlers(deps?: {
  getStoreId?: () => string;
  getFirestore?: () => Firestore;
  verifyIdToken?: (token: string) => Promise<{ uid: string; email?: string }>;
  createRepository?: (
    db: Firestore,
    storeId: string
  ) => LocalShippingRateRepository;
  rateLimiter?: OwnerLocalRateLimiter;
  rateLimitOptions?: Parameters<typeof createOwnerLocalRateLimiter>[0];
}) {
  const rateLimiter =
    deps?.rateLimiter ??
    (deps?.rateLimitOptions
      ? createOwnerLocalRateLimiter(deps.rateLimitOptions)
      : defaultOwnerLocalRateLimiter);

  return createOwnerLocalShippingRateHandlers({
    resolveOwnerRepository: async (req, res) => {
      const ctx = ensureBackendConfigured(res, {
        getStoreId: deps?.getStoreId,
        getFirestore: deps?.getFirestore,
      });
      if (!ctx) return null;
      const owner = await requireOwnerAuth(
        req,
        res,
        ctx.storeId,
        deps?.verifyIdToken
      );
      if (!owner) return null;

      const limitResult = rateLimiter.consumeForUid(owner.uid);
      if (!limitResult.allowed) {
        res.setHeader('Retry-After', String(limitResult.retryAfterSeconds));
        res.status(429).json({
          code: 'OWNER_RATE_LIMIT_EXCEEDED',
          error:
            'Terlalu banyak permintaan pengelolaan tarif lokal. Tunggu beberapa saat lalu coba lagi.',
          retryAfterSeconds: limitResult.retryAfterSeconds,
        });
        return null;
      }

      if (deps?.createRepository) {
        return deps.createRepository(ctx.db, ctx.storeId);
      }
      const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
      return new FirestoreLocalShippingRateRepository(
        storeRef as unknown as LocalRateStoreRefLike,
        (fn) =>
          ctx.db.runTransaction((tx) =>
            fn(tx as unknown as LocalRateTxLike)
          )
      );
    },
    onError: sendConfigOrFirestoreError,
  });
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(createMalformedJsonErrorHandler());

  app.use((req, res, next) => {
    // Collapse accidental leading double-slashes from reverse proxies (e.g. //api/catalog)
    if (req.url.startsWith('//')) {
      req.url = req.url.replace(/^\/+/, '/');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const reqOrigin =
      typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization'
      );
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
    }

    next();
  });

  // Root API index so visiting /api or /api/ directly returns clean discovery metadata
  app.get(['/api', '/api/'], (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'smartpos-guest',
      endpoints: {
        health: '/api/health',
        catalog: '/api/catalog',
        shippingLocations: 'GET /api/shipping/locations?search=...',
        shippingJntRates: 'POST /api/shipping/jnt-rates',
        rajaOngkirLocations: 'GET /api/shipping/rajaongkir/locations?search=...',
        rajaOngkirJntRates: 'POST /api/shipping/rajaongkir/jnt-rates',
        regionsProvinces: 'GET /api/regions/provinces',
        regionsCities: 'GET /api/regions/provinces/:stateCode/cities',
        regionsDistricts: 'GET /api/regions/cities/:cityCode/districts',
        regionsVillages: 'GET /api/regions/districts/:districtCode/villages',
        localShippingRateQuote: 'POST /api/local-shipping-rates/quote',
        createOrder: 'POST /api/guest-orders',
        orderStatus: 'GET /api/guest-orders/:orderNumber?phoneLast4=XXXX',
      },
    });
  });

  // Healthcheck endpoint for Cloud Run / Render (never exposes secrets or STORE_ID)
  app.get('/api/health', (_req: Request, res: Response) => {
    const {
      storeId,
      projectId,
      databaseId,
    } = inspectOwnerFirebaseEnv();
    const storeConfigured = Boolean(storeId);
    const projectConfigured = Boolean(
      projectId && projectId !== '(default)' && !/\s/.test(projectId)
    );
    const databaseConfigured = Boolean(
      databaseId && databaseId !== '(default)' && !/\s/.test(databaseId)
    );
    const hasServiceAccountEnv = Boolean(
      (
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        process.env.FIREBASE_SERVICE_ACCOUNT ||
        ''
      ).trim() ||
        ((process.env.FIREBASE_CLIENT_EMAIL || '').trim() &&
          (process.env.FIREBASE_PRIVATE_KEY || '').trim())
    );
    const hasGoogleAppCreds = Boolean(
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
    );
    const authMode = hasServiceAccountEnv
      ? 'service_account_env'
      : hasGoogleAppCreds
      ? 'google_application_credentials'
      : 'adc';

    res.status(200).json({
      status: 'ok',
      service: 'smartpos-guest',
      mode: IS_PROD ? 'production' : 'development',
      authMode,
      storeConfigured,
      projectConfigured,
      databaseConfigured,
      explicitCredsConfigured: hasServiceAccountEnv || hasGoogleAppCreds,
      projectId: projectConfigured ? projectId : null,
      databaseId: databaseConfigured ? databaseId : null,
    });
  });

  // Read-only catalog endpoint backed directly by Owner Firestore: stores/{STORE_ID}/products
  app.get('/api/catalog', async (_req: Request, res: Response) => {
    const ctx = ensureBackendConfigured(res);
    if (!ctx) return;

    try {
      const snapshot = await ctx.db
        .collection('stores')
        .doc(ctx.storeId)
        .collection('products')
        .get();

      const products: Product[] = [];
      const categoryMap = new Map<string, Category>();

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (!isProductAvailableForCatalog(data)) return;

        const product = mapOwnerProductToPublic(docSnap.id, data);
        products.push(product);

        if (!categoryMap.has(product.categoryId)) {
          categoryMap.set(product.categoryId, {
            id: product.categoryId,
            name: product.categoryName,
            slug: product.categoryId,
            sortOrder: categoryMap.size + 1,
          });
        }
      });

      const categories = Array.from(categoryMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name, 'id-ID')
      );

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        categories,
        products,
        source: 'owner_firestore',
      });
    } catch (err) {
      return sendConfigOrFirestoreError(res, err);
    }
  });

  // Server-validated guest order creation -> stores/{STORE_ID}/guest_orders/{orderId}
  // Browser never sets price/total/weight/shippingFee, never deducts stock, and never writes to Firestore directly.
  app.post('/api/guest-orders', createGuestOrdersHandler());

  // Order status lookup requiring orderNumber + last 4 WhatsApp digits (rate-limited, non-leaking)
  app.get('/api/guest-orders/:orderNumber', createGuestOrderLookupHandler());

  // Never expose order list on public GET /api/guest-orders without an orderNumber
  app.get('/api/guest-orders', (_req: Request, res: Response) => {
    return res.status(400).json({
      error:
        'Sertakan nomor pesanan dan 4 digit terakhir WhatsApp untuk memeriksa status pesanan.',
    });
  });

  // ============================================================================
  // Guest Shipping Helper Endpoints (KiriminAja Proxy — Server-Validated + Cached)
  // ============================================================================
  app.get('/api/shipping/locations', createKiriminAjaLocationsHandler());

  app.post('/api/shipping/jnt-rates', createKiriminAjaJntRatesHandler());

  // ============================================================================
  // Guest Shipping Helper Endpoints (RajaOngkir / Komerce — Server-Validated + Cached)
  // ============================================================================
  app.get(
    '/api/shipping/rajaongkir/locations',
    createRajaOngkirLocationsHandler()
  );

  app.post(
    '/api/shipping/rajaongkir/jnt-rates',
    createRajaOngkirJntRatesHandler()
  );

  // ============================================================================
  // Administrative Region Endpoints (LokaID — Isolated from Shipping & Tariffs)
  // ============================================================================
  app.get('/api/regions/provinces', createRegionProvincesHandler());
  app.get('/api/regions/provinces/:stateCode/cities', createRegionCitiesHandler());
  app.get('/api/regions/cities/:cityCode/districts', createRegionDistrictsHandler());
  app.get(
    '/api/regions/districts/:districtCode/villages',
    createRegionVillagesHandler()
  );

  // ============================================================================
  // Local Shipping Rate Foundation (Server-Authoritative Repository + Owner Prep)
  // Isolated from KiriminAja, RajaOngkir, and active Guest checkout flows.
  // ============================================================================
  app.post(
    '/api/local-shipping-rates/quote',
    createLocalShippingRateQuoteHandler({
      checkRateLimit: checkLocalRateQuoteRateLimit,
      resolveDependencies: async (_req, res) => {
        const ctx = ensureBackendConfigured(res);
        if (!ctx) return null;
        const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
        const repository = new FirestoreLocalShippingRateRepository(
          storeRef as unknown as LocalRateStoreRefLike
        );
        const fetchProductsByIds = async (
          productIds: string[]
        ): Promise<LocalQuoteProductSnapshot[]> => {
          const refs = productIds.map((pid) =>
            storeRef.collection('products').doc(pid)
          );
          const snaps = await ctx.db.getAll(...refs);
          return snaps.map((snap) => {
            const data = snap.exists ? snap.data() : undefined;
            const available = Boolean(
              snap.exists && data && isProductAvailableForCatalog(data)
            );
            const publicProduct =
              snap.exists && data
                ? mapOwnerProductToPublic(snap.id, data)
                : null;
            return {
              id: snap.id,
              exists: snap.exists,
              available,
              name: publicProduct?.name ?? 'Produk',
              price: publicProduct?.price ?? 0,
              stock: publicProduct?.stock ?? 0,
              unit: publicProduct?.unit ?? 'pcs',
              weightGrams: publicProduct?.weightGrams,
            };
          });
        };
        return { repository, fetchProductsByIds };
      },
      onError: sendConfigOrFirestoreError,
    })
  );

  const ownerLocalRateHandlers = createOwnerLocalShippingRateServerHandlers();

  app.get('/api/owner/local-shipping-rates', ownerLocalRateHandlers.list);
  app.post('/api/owner/local-shipping-rates', ownerLocalRateHandlers.create);
  app.patch(
    '/api/owner/local-shipping-rates/:rateId',
    ownerLocalRateHandlers.update
  );
  app.delete(
    '/api/owner/local-shipping-rates/:rateId',
    ownerLocalRateHandlers.remove
  );

  // ============================================================================
  // Owner-only Guest Order Management (requires Firebase ID token with uid === STORE_ID)
  // ============================================================================
  app.get('/api/owner/guest-orders', async (req: Request, res: Response) => {
    const ctx = ensureBackendConfigured(res);
    if (!ctx) return;

    const owner = await requireOwnerAuth(req, res, ctx.storeId);
    if (!owner) return;

    const filterParam = String(req.query.filter || 'cancelled')
      .trim()
      .toLowerCase();
    const filter: OwnerOrderFilter =
      filterParam === 'all' ||
      filterParam === 'active' ||
      filterParam === 'completed' ||
      filterParam === 'cancelled'
        ? filterParam
        : 'cancelled';

    try {
      const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
      const [ordersSnap, salesSnap, txSnap] = await Promise.all([
        storeRef.collection('guest_orders').get(),
        storeRef.collection('sales').get(),
        storeRef.collection('transactions').get(),
      ]);

      const linkedIds = new Set<string>();
      const linkedOrderNumbers = new Set<string>();

      for (const snap of [salesSnap, txSnap]) {
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          if (typeof d.guestOrderId === 'string' && d.guestOrderId.trim()) {
            linkedIds.add(d.guestOrderId.trim());
          }
          if (typeof d.orderNumber === 'string' && d.orderNumber.trim()) {
            linkedOrderNumbers.add(d.orderNumber.trim().toUpperCase());
          }
        });
      }

      const allOrders: OwnerGuestOrder[] = [];
      ordersSnap.forEach((docSnap) => {
        const data = docSnap.data();
        const orderNumberUpper = String(data.orderNumber ?? '')
          .trim()
          .toUpperCase();
        const externalSaleLinked =
          linkedIds.has(docSnap.id) ||
          (orderNumberUpper.length > 0 &&
            linkedOrderNumbers.has(orderNumberUpper));
        allOrders.push(
          mapFirestoreOrderToOwnerOrder(docSnap.id, data, externalSaleLinked)
        );
      });

      allOrders.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const counts = {
        all: allOrders.length,
        cancelled: allOrders.filter((o) => isCancelledOrderStatus(o.status)).length,
        active: allOrders.filter((o) =>
          ['PENDING', 'ACCEPTED', 'READY'].includes(
            normalizeOrderStatusUpper(o.status)
          )
        ).length,
        completed: allOrders.filter(
          (o) =>
            normalizeOrderStatusUpper(o.status) === 'COMPLETED' ||
            o.linkedToCashierTransaction
        ).length,
      };

      const filteredOrders = allOrders.filter((o) => {
        if (filter === 'all') return true;
        if (filter === 'cancelled') return isCancelledOrderStatus(o.status);
        if (filter === 'active') {
          return ['PENDING', 'ACCEPTED', 'READY'].includes(
            normalizeOrderStatusUpper(o.status)
          );
        }
        return (
          normalizeOrderStatusUpper(o.status) === 'COMPLETED' ||
          o.linkedToCashierTransaction
        );
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        orders: filteredOrders,
        counts,
        filter,
      });
    } catch (err) {
      return sendConfigOrFirestoreError(res, err);
    }
  });

  app.post(
    '/api/owner/guest-orders/:orderId/cancel',
    async (req: Request, res: Response) => {
      const ctx = ensureBackendConfigured(res);
      if (!ctx) return;

      const owner = await requireOwnerAuth(req, res, ctx.storeId);
      if (!owner) return;

      const orderId = String(req.params.orderId || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
        return res.status(400).json({ error: 'ID pesanan tidak valid.' });
      }

      const reason =
        typeof (req.body as { reason?: unknown })?.reason === 'string'
          ? (req.body as { reason: string }).reason
          : undefined;

      try {
        const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
        const result = await ctx.db.runTransaction((tx) =>
          cancelGuestOrderInTransaction(tx, storeRef, orderId, reason)
        );

        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          order: mapFirestoreOrderToOwnerOrder(
            result.orderId,
            result.updatedData,
            false
          ),
          alreadyCancelled: result.alreadyCancelled,
          restoredProductCount: result.restoredProductCount,
        });
      } catch (err) {
        if (err instanceof OwnerOrderActionError) {
          return res.status(err.statusCode).json({
            code: err.code,
            error: err.message,
          });
        }
        return sendConfigOrFirestoreError(res, err);
      }
    }
  );

  app.patch(
    '/api/owner/guest-orders/:orderId/shipping',
    async (req: Request, res: Response) => {
      const ctx = ensureBackendConfigured(res);
      if (!ctx) return;

      const owner = await requireOwnerAuth(req, res, ctx.storeId);
      if (!owner) return;

      const orderId = String(req.params.orderId || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
        return res.status(400).json({ error: 'ID pesanan tidak valid.' });
      }

      let parsedUpdate: ParsedOwnerShippingUpdate;
      try {
        parsedUpdate = parseOwnerShippingUpdatePayload(req.body);
      } catch (err) {
        if (err instanceof OwnerOrderActionError) {
          return res.status(err.statusCode).json({
            code: err.code,
            error: err.message,
          });
        }
        return res.status(400).json({
          code: 'INVALID_SHIPPING_PAYLOAD',
          error: 'Data pembaruan pengiriman tidak valid.',
        });
      }

      try {
        const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
        const result = await ctx.db.runTransaction((tx) =>
          updateGuestOrderShippingInTransaction(
            tx,
            storeRef,
            ctx.storeId,
            orderId,
            parsedUpdate
          )
        );

        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          order: mapFirestoreOrderToOwnerOrder(
            result.orderId,
            result.updatedData,
            result.linkedToCashierTransaction
          ),
        });
      } catch (err) {
        if (err instanceof OwnerOrderActionError) {
          return res.status(err.statusCode).json({
            code: err.code,
            error: err.message,
          });
        }
        return sendConfigOrFirestoreError(res, err);
      }
    }
  );

  app.delete(
    '/api/owner/guest-orders/:orderId',
    async (req: Request, res: Response) => {
      const ctx = ensureBackendConfigured(res);
      if (!ctx) return;

      const owner = await requireOwnerAuth(req, res, ctx.storeId);
      if (!owner) return;

      const orderId = String(req.params.orderId || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
        return res.status(400).json({ error: 'ID pesanan tidak valid.' });
      }

      try {
        const storeRef = ctx.db.collection('stores').doc(ctx.storeId);
        const result = await ctx.db.runTransaction((tx) =>
          deleteCancelledGuestOrderInTransaction(tx, storeRef, orderId)
        );

        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          deleted: true,
          deletedOrderId: result.deletedOrderId,
          orderNumber: result.orderNumber,
          restoredProductCount: result.restoredProductCount,
        });
      } catch (err) {
        if (err instanceof OwnerOrderActionError) {
          return res.status(err.statusCode).json({
            code: err.code,
            error: err.message,
          });
        }
        return sendConfigOrFirestoreError(res, err);
      }
    }
  );

  // Ensure unknown /api/* paths return JSON 404 rather than SPA HTML fallback
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      console.error('Production build dist/index.html not found. Run npm run build first.');
    }
    app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `SmartPOS Guest server running on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`
    );
  });
}

const isDirectExecution = (() => {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(entryPath) === path.resolve(__filename);
  }
})();

if (isDirectExecution || process.env.START_SERVER === 'true') {
  startServer().catch((err) => {
    console.error('Failed to start SmartPOS Guest server:', err);
    process.exit(1);
  });
}
