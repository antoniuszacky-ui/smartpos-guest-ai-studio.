import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  buildOwnerLocalRateLimitKey,
  cleanupExpiredRateLimitBuckets,
  createMalformedJsonErrorHandler,
  createOwnerLocalRateLimiter,
  createOwnerLocalShippingRateServerHandlers,
  ensureBackendConfigured,
  initOwnerAdminAppWithConfig,
  initOwnerFirestoreWithConfig,
  inspectOwnerFirebaseEnv,
  OWNER_LOCAL_RATES_RATE_LIMIT_MAX_REQUESTS,
  OWNER_LOCAL_RATES_RATE_LIMIT_WINDOW_MS,
  resolveExplicitOwnerFirebaseConfig,
  type RateLimitBucketEntry,
} from './server.ts';
import type { App } from 'firebase-admin/app';
import {
  createLocalShippingRateQuoteHandler,
  createOwnerLocalShippingRateHandlers,
  FirestoreLocalShippingRateRepository,
  InMemoryLocalShippingRateRepository,
  LOCAL_SHIPPING_RATE_LOCKS_COLLECTION,
  LOCAL_SHIPPING_RATES_COLLECTION,
  matchActiveLocalRatesForDistrictAndWeight,
  parseLocalShippingRateInput,
  parseStoredLocalShippingRateDocument,
  quoteLocalShippingRatesForStore,
  type LocalQuoteProductSnapshot,
  type LocalRateDocRefLike,
  type LocalRateDocSnapshotLike,
  type LocalRateQueryLike,
  type LocalRateQuerySnapshotLike,
  type LocalRateRunTransactionFn,
  type LocalRateStoreRefLike,
  type LocalRateTxLike,
} from './src/server/localShippingRates.ts';
import type { LocalShippingRate, LocalShippingRateQuoteResponse } from './src/types/pos.ts';

function makeValidRateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provinceCode: '35',
    provinceName: 'JAWA TIMUR',
    cityCode: '35.02',
    cityName: 'KAB. PONOROGO',
    districtCode: '35.02.17',
    districtName: 'PONOROGO',
    courierName: 'Kurir Toko',
    serviceName: 'Reguler Lokal',
    weightMinGram: 0,
    weightMaxGram: 1000,
    shippingFee: 12000,
    isActive: true,
    ...overrides,
  };
}

function mustParseRateInput(overrides: Partial<Record<string, unknown>> = {}) {
  const parsed = parseLocalShippingRateInput(makeValidRateInput(overrides));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function createMockFirestoreStoreRef(
  seedDocs: Array<{ id: string; data: Record<string, unknown> }> = []
): {
  storeRef: LocalRateStoreRefLike;
  rawStore: Map<string, Record<string, unknown>>;
} {
  const rawStore = new Map<string, Record<string, unknown>>();
  for (const doc of seedDocs) {
    rawStore.set(doc.id, { ...doc.data });
  }

  const makeQuery = (
    filters: Array<{ fieldPath: string; value: unknown }>
  ) => ({
    where(fieldPath: string, _op: '==', value: unknown) {
      return makeQuery([...filters, { fieldPath, value }]);
    },
    async get() {
      const matchingDocs: LocalRateDocSnapshotLike[] = [];
      for (const [id, data] of rawStore.entries()) {
        const matches = filters.every((f) => data[f.fieldPath] === f.value);
        if (matches) {
          matchingDocs.push({
            id,
            exists: true,
            data: () => ({ ...data }),
          });
        }
      }
      return {
        empty: matchingDocs.length === 0,
        docs: matchingDocs,
      };
    },
  });

  const storeRef: LocalRateStoreRefLike = {
    collection(_name: string) {
      return {
        ...makeQuery([]),
        doc(docId: string) {
          return {
            id: docId,
            async get() {
              const existing = rawStore.get(docId);
              return {
                id: docId,
                exists: Boolean(existing),
                data: () => (existing ? { ...existing } : undefined),
              };
            },
            async set(data: Record<string, unknown>) {
              rawStore.set(docId, { ...data });
            },
            async delete() {
              rawStore.delete(docId);
            },
          };
        },
      };
    },
  };

  return { storeRef, rawStore };
}

async function withLocalRatesServer(
  setup: (app: express.Express) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  setup(app);

  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    }
  );

  try {
    const addr = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('parseLocalShippingRateInput validates region hierarchy, weight range, fee, active status, and rejects invalid inputs', () => {
  const valid = parseLocalShippingRateInput(makeValidRateInput({ shippingFee: 0 }));
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.districtCode, '35.02.17');
    assert.equal(valid.value.weightMinGram, 0);
    assert.equal(valid.value.weightMaxGram, 1000);
    assert.equal(valid.value.shippingFee, 0);
    assert.equal(valid.value.isActive, true);
  }

  // Non-object payloads
  assert.equal(parseLocalShippingRateInput(null).ok, false);
  assert.equal(parseLocalShippingRateInput([]).ok, false);
  assert.equal(parseLocalShippingRateInput('invalid').ok, false);

  // Invalid or mismatched region hierarchy
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ provinceCode: '350' })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ cityCode: '31.02' })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ districtCode: '35.78.01' })).ok,
    false
  );

  // Invalid weight ranges
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ weightMinGram: -10 })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ weightMaxGram: 0 })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(
      makeValidRateInput({ weightMinGram: 2000, weightMaxGram: 1000 })
    ).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ weightMinGram: 12.5 })).ok,
    false
  );

  // Invalid / negative fees
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ shippingFee: -5000 })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ shippingFee: Number.NaN })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ shippingFee: '' })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ shippingFee: true })).ok,
    false
  );

  // Invalid isActive flag
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ isActive: 'true' })).ok,
    false
  );
  assert.equal(
    parseLocalShippingRateInput(makeValidRateInput({ isActive: undefined })).ok,
    false
  );
});

test('matchActiveLocalRatesForDistrictAndWeight excludes inactive/corrupt/duplicate entries and respects weight bounds', () => {
  const activeLow: LocalShippingRate = {
    id: 'rate_1',
    ...makeValidRateInput({
      weightMinGram: 0,
      weightMaxGram: 1000,
      shippingFee: 10000,
      isActive: true,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  } as LocalShippingRate;

  const activeHigh: LocalShippingRate = {
    id: 'rate_2',
    ...makeValidRateInput({
      weightMinGram: 1001,
      weightMaxGram: 3000,
      shippingFee: 18000,
      isActive: true,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  } as LocalShippingRate;

  const inactiveCheaper: LocalShippingRate = {
    id: 'rate_3',
    ...makeValidRateInput({
      serviceName: 'Promo Mati',
      weightMinGram: 0,
      weightMaxGram: 5000,
      shippingFee: 2000,
      isActive: false,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  } as LocalShippingRate;

  const duplicateOlder: LocalShippingRate = {
    ...activeLow,
    id: 'rate_dup_old',
    shippingFee: 9000,
    updatedAt: '2026-11-20T01:00:00.000Z',
  };

  const corruptNegativeFee = {
    id: 'rate_corrupt',
    ...makeValidRateInput({ shippingFee: -1 }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  };

  const rawPool = [
    activeLow,
    activeHigh,
    inactiveCheaper,
    duplicateOlder,
    corruptNegativeFee,
  ];

  // Empty pool -> empty
  assert.deepEqual(
    matchActiveLocalRatesForDistrictAndWeight([], '35.02.17', 500),
    []
  );

  // Unknown district -> empty
  assert.deepEqual(
    matchActiveLocalRatesForDistrictAndWeight(rawPool, '35.02.99', 500),
    []
  );

  // Weight 1000g -> matches rate_1 (latest duplicate wins deduplication, inactive & corrupt excluded)
  const match1000 = matchActiveLocalRatesForDistrictAndWeight(
    rawPool,
    '35.02.17',
    1000
  );
  assert.equal(match1000.length, 1);
  assert.equal(match1000[0].id, 'rate_1');
  assert.equal(match1000[0].shippingFee, 10000);

  // Weight 1500g -> matches rate_2
  const match1500 = matchActiveLocalRatesForDistrictAndWeight(
    rawPool,
    '35.02.17',
    1500
  );
  assert.equal(match1500.length, 1);
  assert.equal(match1500[0].id, 'rate_2');
  assert.equal(match1500[0].shippingFee, 18000);

  // Weight 5000g -> out of range for all active tiers -> empty
  assert.deepEqual(
    matchActiveLocalRatesForDistrictAndWeight(rawPool, '35.02.17', 5000),
    []
  );
});

test('FirestoreLocalShippingRateRepository enforces validation, deduplication, and overlap checks using mock Firestore', async () => {
  const { storeRef, rawStore } = createMockFirestoreStoreRef([
    {
      id: 'corrupt_doc',
      data: { districtCode: '35.02.17', shippingFee: -500, isActive: true },
    },
    {
      id: 'inactive_doc',
      data: {
        ...makeValidRateInput({
          serviceName: 'Layanan Nonaktif',
          isActive: false,
          shippingFee: 5000,
        }),
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    },
  ]);

  const repo = new FirestoreLocalShippingRateRepository(storeRef);

  // Corrupt doc skipped, inactive doc excluded from active district query
  const initialAll = await repo.listAllRates();
  assert.equal(initialAll.length, 1);
  assert.equal(initialAll[0].id, 'inactive_doc');
  assert.deepEqual(await repo.listActiveRatesByDistrict('35.02.17'), []);

  // Save valid tier 0..1000g
  const saved1 = await repo.saveRate(
    mustParseRateInput({
      id: 'tier_1',
      weightMinGram: 0,
      weightMaxGram: 1000,
      shippingFee: 10000,
    })
  );
  assert.equal(saved1.id, 'tier_1');
  assert.equal(rawStore.has('tier_1'), true);

  // Contiguous non-overlapping tier 1001..3000g succeeds
  const saved2 = await repo.saveRate(
    mustParseRateInput({
      id: 'tier_2',
      weightMinGram: 1001,
      weightMaxGram: 3000,
      shippingFee: 16000,
    })
  );
  assert.equal(saved2.id, 'tier_2');

  // Exact duplicate rejected with 409
  await assert.rejects(
    () =>
      repo.saveRate(
        mustParseRateInput({
          weightMinGram: 0,
          weightMaxGram: 1000,
          shippingFee: 11000,
        })
      ),
    (err: { statusCode?: number; code?: string }) =>
      err.statusCode === 409 && err.code === 'DUPLICATE_LOCAL_SHIPPING_RATE'
  );

  // Overlapping active bracket rejected with 409
  await assert.rejects(
    () =>
      repo.saveRate(
        mustParseRateInput({
          weightMinGram: 500,
          weightMaxGram: 1500,
          shippingFee: 14000,
        })
      ),
    (err: { statusCode?: number; code?: string }) =>
      err.statusCode === 409 && err.code === 'OVERLAPPING_LOCAL_SHIPPING_RATE'
  );

  // Active district query returns only valid active tiers sorted by fee
  const activeDistrict = await repo.listActiveRatesByDistrict('35.02.17');
  assert.deepEqual(
    activeDistrict.map((r) => r.id),
    ['tier_1', 'tier_2']
  );

  // Update same rate id succeeds without overlapping against itself
  const updated1 = await repo.saveRate(
    mustParseRateInput({
      id: 'tier_1',
      weightMinGram: 0,
      weightMaxGram: 1000,
      shippingFee: 11500,
    })
  );
  assert.equal(updated1.shippingFee, 11500);

  // Delete works cleanly
  assert.equal(await repo.deleteRate('tier_2'), true);
  assert.equal(await repo.getRateById('tier_2'), null);
  assert.equal(await repo.deleteRate('non_existent'), false);

  // Stored doc parser rejects bad IDs
  assert.equal(parseStoredLocalShippingRateDocument('../bad', saved1).ok, false);
});

test('POST /api/local-shipping-rates/quote calculates authoritative weight/rates, never invents fallback rates, and protects owner CRUD routes', async () => {
  const emptyRepo = new InMemoryLocalShippingRateRepository();
  const seededRepo = new InMemoryLocalShippingRateRepository([
    {
      id: 'ponorogo_reg_1kg',
      ...makeValidRateInput({
        weightMinGram: 1,
        weightMaxGram: 1000,
        shippingFee: 10000,
        isActive: true,
      }),
      updatedAt: '2026-11-22T01:00:00.000Z',
    } as LocalShippingRate,
    {
      id: 'ponorogo_reg_3kg',
      ...makeValidRateInput({
        weightMinGram: 1001,
        weightMaxGram: 3000,
        shippingFee: 17000,
        isActive: true,
      }),
      updatedAt: '2026-11-22T01:00:00.000Z',
    } as LocalShippingRate,
    {
      id: 'ponorogo_inactive',
      ...makeValidRateInput({
        serviceName: 'Kilat Off',
        weightMinGram: 1,
        weightMaxGram: 5000,
        shippingFee: 5000,
        isActive: false,
      }),
      updatedAt: '2026-11-22T01:00:00.000Z',
    } as LocalShippingRate,
  ]);

  const products: Record<string, LocalQuoteProductSnapshot> = {
    prod_weighed: {
      id: 'prod_weighed',
      exists: true,
      available: true,
      name: 'Kopi Tubruk',
      price: 40000,
      stock: 5,
      unit: 'pcs',
      weightGrams: 600,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      exists: true,
      available: true,
      name: 'Produk Tanpa Berat',
      price: 25000,
      stock: 5,
      unit: 'pcs',
    },
  };

  const fetchProductsByIds = async (ids: string[]) =>
    ids.map(
      (id) =>
        products[id] ?? {
          id,
          exists: false,
          available: false,
          name: '',
          price: 0,
          stock: 0,
          unit: 'pcs',
        }
    );

  // Empty repository never fabricates rates
  const emptyQuote = await quoteLocalShippingRatesForStore({
    repository: emptyRepo,
    fetchProductsByIds,
    rawBody: {
      districtCode: '35.02.17',
      items: [{ productId: 'prod_weighed', quantity: 1 }],
    },
  });
  assert.equal(emptyQuote.statusCode, 200);
  assert.equal((emptyQuote.body as LocalShippingRateQuoteResponse).available, false);
  assert.deepEqual((emptyQuote.body as LocalShippingRateQuoteResponse).rates, []);

  let quoteCalls = 0;
  let ownerAuthorized = false;

  await withLocalRatesServer(
    (app) => {
      app.post(
        '/api/local-shipping-rates/quote',
        createLocalShippingRateQuoteHandler({
          checkRateLimit: () => {
            quoteCalls += 1;
            return quoteCalls <= 5;
          },
          resolveDependencies: async () => ({
            repository: seededRepo,
            fetchProductsByIds,
          }),
        })
      );

      const ownerHandlers = createOwnerLocalShippingRateHandlers({
        resolveOwnerRepository: async (_req, res) => {
          if (!ownerAuthorized) {
            res.status(401).json({
              code: 'OWNER_AUTH_REQUIRED',
              error: 'Login akun Owner diperlukan.',
            });
            return null;
          }
          return seededRepo;
        },
      });
      app.get('/api/owner/local-shipping-rates', ownerHandlers.list);
      app.post('/api/owner/local-shipping-rates', ownerHandlers.create);
      app.patch('/api/owner/local-shipping-rates/:rateId', ownerHandlers.update);
      app.delete('/api/owner/local-shipping-rates/:rateId', ownerHandlers.remove);
    },
    async (baseUrl) => {
      // 1. Browser tampered shippingFee & weightGrams are completely ignored; qty 2 x 600g = 1200g -> matches 17000 bracket
      const quoteRes = await fetch(`${baseUrl}/api/local-shipping-rates/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          districtCode: '35.02.17',
          shippingFee: 1,
          weightGrams: 10,
          items: [{ productId: 'prod_weighed', quantity: 2 }],
        }),
      });
      assert.equal(quoteRes.status, 200);
      const quoteBody = (await quoteRes.json()) as LocalShippingRateQuoteResponse;
      assert.equal(quoteBody.available, true);
      assert.equal(quoteBody.totalWeightGrams, 1200);
      assert.equal(quoteBody.normalizedWeightGrams, 1200);
      assert.equal(quoteBody.itemsSubtotal, 80000);
      assert.equal(quoteBody.rates.length, 1);
      assert.equal(quoteBody.rates[0].shippingFee, 17000);

      // 2. Unweighed product cannot falsely match a cheap bracket
      const unweighedRes = await fetch(
        `${baseUrl}/api/local-shipping-rates/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            districtCode: '35.02.17',
            items: [{ productId: 'prod_unweighed', quantity: 1 }],
          }),
        }
      );
      assert.equal(unweighedRes.status, 200);
      const unweighedBody =
        (await unweighedRes.json()) as LocalShippingRateQuoteResponse;
      assert.equal(unweighedBody.available, false);
      assert.equal(unweighedBody.hasUnweighedItems, true);
      assert.deepEqual(unweighedBody.rates, []);

      // 3. Invalid district code -> 400
      const badDistRes = await fetch(`${baseUrl}/api/local-shipping-rates/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          districtCode: '35.02',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        }),
      });
      assert.equal(badDistRes.status, 400);

      // 4. Missing product -> 404; exceeding stock -> 409
      const missingProdRes = await fetch(
        `${baseUrl}/api/local-shipping-rates/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            districtCode: '35.02.17',
            items: [{ productId: 'prod_unknown', quantity: 1 }],
          }),
        }
      );
      assert.equal(missingProdRes.status, 404);

      const overStockRes = await fetch(
        `${baseUrl}/api/local-shipping-rates/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            districtCode: '35.02.17',
            items: [{ productId: 'prod_weighed', quantity: 9 }],
          }),
        }
      );
      assert.equal(overStockRes.status, 409);

      // 5. Rate limit exceeded -> 429
      const rateLimitRes = await fetch(
        `${baseUrl}/api/local-shipping-rates/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            districtCode: '35.02.17',
            items: [{ productId: 'prod_weighed', quantity: 1 }],
          }),
        }
      );
      assert.equal(rateLimitRes.status, 429);

      // 6. Owner endpoints reject unauthenticated callers (401)
      const unauthOwnerRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates`
      );
      assert.equal(unauthOwnerRes.status, 401);

      // 7. Authenticated Owner CRUD lifecycle
      ownerAuthorized = true;
      const listRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates?districtCode=35.02.17`
      );
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as {
        rates: LocalShippingRate[];
        count: number;
      };
      assert.equal(listBody.count, 3);

      const createRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeValidRateInput({
            districtCode: '35.02.16',
            districtName: 'SIMAN',
            weightMinGram: 1,
            weightMaxGram: 2000,
            shippingFee: 15000,
          })
        ),
      });
      assert.equal(createRes.status, 201);
      const created = ((await createRes.json()) as { rate: LocalShippingRate })
        .rate;
      assert.equal(created.districtCode, '35.02.16');

      const patchRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/${encodeURIComponent(created.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shippingFee: 16500, isActive: false }),
        }
      );
      assert.equal(patchRes.status, 200);
      const updated = ((await patchRes.json()) as { rate: LocalShippingRate })
        .rate;
      assert.equal(updated.shippingFee, 16500);
      assert.equal(updated.isActive, false);

      const deleteRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/${encodeURIComponent(created.id)}`,
        { method: 'DELETE' }
      );
      assert.equal(deleteRes.status, 200);
    }
  );
});

test('Stage 14C.3 Prioritas 3 — createMalformedJsonErrorHandler returns JSON 400 INVALID_JSON without stack trace, preserves non-JSON errors, and keeps server healthy', async () => {
  const repo = new InMemoryLocalShippingRateRepository();

  await withLocalRatesServer(
    (app) => {
      app.use(express.json({ limit: '1mb' }));
      app.use(createMalformedJsonErrorHandler());
      const ownerHandlers = createOwnerLocalShippingRateHandlers({
        resolveOwnerRepository: async () => repo,
      });
      app.get('/api/owner/local-shipping-rates', ownerHandlers.list);
      app.post('/api/owner/local-shipping-rates', ownerHandlers.create);
      app.post('/api/test-non-json-error', (_req, _res, next) => {
        next(new Error('Non-JSON internal test error'));
      });
      // Confirm non-SyntaxError errors still pass through untouched
      app.use(
        (
          err: Error,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction
        ) => {
          res.status(500).json({ code: 'PASSTHROUGH_ERROR', error: err.message });
        }
      );
    },
    async (baseUrl) => {
      // 1. Malformed JSON returns 400 JSON with code INVALID_JSON and no stack trace
      const malformedRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"courierName": ',
      });
      assert.equal(malformedRes.status, 400);
      const contentType = malformedRes.headers.get('content-type') || '';
      assert.match(contentType, /application\/json/i);
      const rawBody = await malformedRes.text();
      assert.doesNotMatch(rawBody, /SyntaxError|at JSON\.parse|node_modules/i);
      const parsedErr = JSON.parse(rawBody) as { code: string; error: string };
      assert.equal(parsedErr.code, 'INVALID_JSON');
      assert.ok(parsedErr.error.length > 0);

      // 2. Non-JSON error is not intercepted by createMalformedJsonErrorHandler
      const nonJsonErrRes = await fetch(`${baseUrl}/api/test-non-json-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      });
      assert.equal(nonJsonErrRes.status, 500);
      const passthrough = (await nonJsonErrRes.json()) as { code: string };
      assert.equal(passthrough.code, 'PASSTHROUGH_ERROR');

      // 3. Subsequent valid GET and POST remain fully functional
      const validListRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`);
      assert.equal(validListRes.status, 200);

      const validPostRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeValidRateInput()),
      });
      assert.equal(validPostRes.status, 201);
    }
  );
});

test('Stage 14C.3 Prioritas 4 — PATCH accepts full non-null payload, rejects explicit null on required fields with 400, and preserves existing mock Firestore data', async () => {
  const seed = {
    id: 'lrate_patch_null_check',
    ...makeValidRateInput({
      shippingFee: 12000,
      weightMinGram: 0,
      weightMaxGram: 1000,
      isActive: true,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  };
  const { storeRef, rawStore } = createMockFirestoreStoreRef([
    { id: seed.id, data: seed },
  ]);
  const repo = new FirestoreLocalShippingRateRepository(storeRef);

  await withLocalRatesServer(
    (app) => {
      const ownerHandlers = createOwnerLocalShippingRateHandlers({
        resolveOwnerRepository: async () => repo,
      });
      app.get('/api/owner/local-shipping-rates', ownerHandlers.list);
      app.patch('/api/owner/local-shipping-rates/:rateId', ownerHandlers.update);
    },
    async (baseUrl) => {
      const nullCases: Array<{ body: Record<string, unknown>; expectedCode: string }> = [
        { body: { provinceCode: null }, expectedCode: 'INVALID_PROVINCE_CODE' },
        { body: { cityCode: null }, expectedCode: 'INVALID_CITY_CODE' },
        { body: { districtCode: null }, expectedCode: 'INVALID_DISTRICT_CODE' },
        { body: { courierName: null }, expectedCode: 'INVALID_COURIER_NAME' },
        { body: { serviceName: null }, expectedCode: 'INVALID_SERVICE_NAME' },
        { body: { weightMinGram: null }, expectedCode: 'INVALID_WEIGHT_RANGE' },
        { body: { weightMaxGram: null }, expectedCode: 'INVALID_WEIGHT_RANGE' },
        { body: { shippingFee: null }, expectedCode: 'INVALID_SHIPPING_FEE' },
        { body: { isActive: null }, expectedCode: 'INVALID_ACTIVE_STATUS' },
        {
          body: { ...makeValidRateInput({ shippingFee: null }) },
          expectedCode: 'INVALID_SHIPPING_FEE',
        },
      ];

      for (const testCase of nullCases) {
        const res = await fetch(
          `${baseUrl}/api/owner/local-shipping-rates/${seed.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testCase.body),
          }
        );
        assert.equal(res.status, 400);
        const errBody = (await res.json()) as { code: string; error: string };
        assert.equal(errBody.code, testCase.expectedCode);

        // Existing record must remain untouched
        assert.equal(rawStore.get(seed.id)?.shippingFee, 12000);
        assert.equal(rawStore.get(seed.id)?.courierName, 'Kurir Toko');
        assert.equal(rawStore.get(seed.id)?.weightMaxGram, 1000);
        assert.equal(rawStore.get(seed.id)?.isActive, true);
      }

      // Full 12-field non-null payload succeeds with 200
      const fullPatchRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/${seed.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              courierName: 'Kurir Toko Express',
              weightMinGram: 0,
              weightMaxGram: 2000,
              shippingFee: 18500,
              isActive: false,
            })
          ),
        }
      );
      assert.equal(fullPatchRes.status, 200);
      const patched = ((await fullPatchRes.json()) as { rate: LocalShippingRate }).rate;
      assert.equal(patched.id, seed.id);
      assert.equal(patched.courierName, 'Kurir Toko Express');
      assert.equal(patched.weightMaxGram, 2000);
      assert.equal(patched.shippingFee, 18500);
      assert.equal(patched.isActive, false);
    }
  );
});

test('Stage 14C.3 Section F — POST with existing ID preserves upsert compatibility while still rejecting overlap against other rate IDs', async () => {
  const existingId = 'lrate_existing_01';
  const otherId = 'lrate_other_02';
  const initialRecord: LocalShippingRate = {
    id: existingId,
    ...makeValidRateInput({
      weightMinGram: 0,
      weightMaxGram: 1000,
      shippingFee: 10000,
      isActive: true,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  };
  const secondRecord: LocalShippingRate = {
    id: otherId,
    ...makeValidRateInput({
      weightMinGram: 1001,
      weightMaxGram: 3000,
      shippingFee: 17000,
      isActive: true,
    }),
    updatedAt: '2026-11-22T01:00:00.000Z',
  };

  for (const setupRepo of [
    () => new InMemoryLocalShippingRateRepository([initialRecord, secondRecord]),
    () => {
      const { storeRef } = createMockFirestoreStoreRef([
        { id: existingId, data: { ...initialRecord } },
        { id: otherId, data: { ...secondRecord } },
      ]);
      return new FirestoreLocalShippingRateRepository(storeRef);
    },
  ]) {
    const repo = setupRepo();
    await withLocalRatesServer(
      (app) => {
        const ownerHandlers = createOwnerLocalShippingRateHandlers({
          resolveOwnerRepository: async () => repo,
        });
        app.get('/api/owner/local-shipping-rates', ownerHandlers.list);
        app.post('/api/owner/local-shipping-rates', ownerHandlers.create);
      },
      async (baseUrl) => {
        // 1. Upsert existing ID within non-overlapping range succeeds (201)
        const upsertRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              id: existingId,
              weightMinGram: 0,
              weightMaxGram: 1000,
              shippingFee: 11500,
              isActive: true,
            })
          ),
        });
        assert.equal(upsertRes.status, 201);
        const upserted = ((await upsertRes.json()) as { rate: LocalShippingRate })
          .rate;
        assert.equal(upserted.id, existingId);
        assert.equal(upserted.shippingFee, 11500);

        // 2. Upsert existing ID into a range overlapping another ID is still rejected (409)
        const overlapUpsertRes = await fetch(
          `${baseUrl}/api/owner/local-shipping-rates`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              makeValidRateInput({
                id: existingId,
                weightMinGram: 0,
                weightMaxGram: 1500,
                shippingFee: 13000,
                isActive: true,
              })
            ),
          }
        );
        assert.equal(overlapUpsertRes.status, 409);
        const conflictErr = (await overlapUpsertRes.json()) as { code: string };
        assert.equal(conflictErr.code, 'OVERLAPPING_LOCAL_SHIPPING_RATE');

        // Existing fee remains unchanged at 11500 and count remains 2
        const listRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`);
        assert.equal(listRes.status, 200);
        const listBody = (await listRes.json()) as {
          rates: LocalShippingRate[];
          count: number;
        };
        assert.equal(listBody.count, 2);
        assert.equal(listBody.rates.find((r) => r.id === existingId)?.shippingFee, 11500);
      }
    );
  }
});

function createOptimisticTransactionalMockStore(options?: {
  onBeforeFirstAttemptWriteCheck?: (ctx: {
    attempt: number;
    stagedWrites: Array<{ colName: string; docId: string }>;
    stagedDeletes: Array<{ colName: string; docId: string }>;
  }) => Promise<void>;
}) {
  const collections = new Map<
    string,
    Map<string, { data: Record<string, unknown>; version: number }>
  >();
  const latestVersions = new Map<string, number>();

  const getVersion = (colName: string, docId: string) =>
    latestVersions.get(`${colName}/${docId}`) ?? 0;

  const bumpVersion = (colName: string, docId: string) => {
    const next = getVersion(colName, docId) + 1;
    latestVersions.set(`${colName}/${docId}`, next);
    return next;
  };

  const getColMap = (name: string) => {
    let colMap = collections.get(name);
    if (!colMap) {
      colMap = new Map();
      collections.set(name, colMap);
    }
    return colMap;
  };

  type TaggedDocRef = LocalRateDocRefLike & {
    __colName: string;
  };

  const makeDocRef = (colName: string, docId: string): TaggedDocRef => ({
    __colName: colName,
    id: docId,
    async get() {
      const entry = getColMap(colName).get(docId);
      return {
        id: docId,
        exists: Boolean(entry),
        data: () => (entry ? { ...entry.data } : undefined),
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const colMap = getColMap(colName);
      const prev = colMap.get(docId);
      const nextData =
        opts?.merge && prev ? { ...prev.data, ...data } : { ...data };
      const nextVersion = bumpVersion(colName, docId);
      colMap.set(docId, {
        data: nextData,
        version: nextVersion,
      });
    },
    async delete() {
      getColMap(colName).delete(docId);
      bumpVersion(colName, docId);
    },
  });

  const makeQuery = (
    colName: string,
    filters: Array<{ fieldPath: string; value: unknown }>
  ) => ({
    __colName: colName,
    __filters: filters,
    where(fieldPath: string, _op: '==', value: unknown) {
      return makeQuery(colName, [...filters, { fieldPath, value }]);
    },
    async get() {
      const colMap = getColMap(colName);
      const docs: LocalRateDocSnapshotLike[] = [];
      for (const [id, entry] of colMap.entries()) {
        if (filters.every((f) => entry.data[f.fieldPath] === f.value)) {
          docs.push({ id, exists: true, data: () => ({ ...entry.data }) });
        }
      }
      return { empty: docs.length === 0, docs };
    },
  });

  const storeRef: LocalRateStoreRefLike = {
    collection(colName: string) {
      return {
        ...makeQuery(colName, []),
        doc(docId: string) {
          return makeDocRef(colName, docId);
        },
      };
    },
  };

  let transactionAttempts = 0;
  let commitRetries = 0;
  const lockReadOrders: string[][] = [];

  const runTransaction: LocalRateRunTransactionFn = async (updateFn) => {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      transactionAttempts += 1;
      const readVersions = new Map<string, number>();
      const attemptLockReads: string[] = [];
      let hasWritten = false;
      const stagedWrites: Array<{
        colName: string;
        docId: string;
        data: Record<string, unknown>;
        merge?: boolean;
      }> = [];
      const stagedDeletes: Array<{ colName: string; docId: string }> = [];

      type TaggedQuery = ReturnType<typeof makeQuery>;
      function txGet(ref: LocalRateDocRefLike): Promise<LocalRateDocSnapshotLike>;
      function txGet(query: LocalRateQueryLike): Promise<LocalRateQuerySnapshotLike>;
      async function txGet(
        refOrQuery: LocalRateDocRefLike | LocalRateQueryLike
      ): Promise<LocalRateDocSnapshotLike | LocalRateQuerySnapshotLike> {
        if (hasWritten) {
          throw new Error(
            'Firestore transactions require all reads to be executed before all writes.'
          );
        }
        if ('__filters' in refOrQuery) {
          const taggedQuery = refOrQuery as TaggedQuery;
          const colMap = getColMap(taggedQuery.__colName);
          const docs: LocalRateDocSnapshotLike[] = [];
          for (const [id, entry] of colMap.entries()) {
            if (
              taggedQuery.__filters.every(
                (f) => entry.data[f.fieldPath] === f.value
              )
            ) {
              const key = `${taggedQuery.__colName}/${id}`;
              if (!readVersions.has(key)) {
                readVersions.set(key, entry.version);
              }
              docs.push({ id, exists: true, data: () => ({ ...entry.data }) });
            }
          }
          return { empty: docs.length === 0, docs };
        }
        const tagged = refOrQuery as TaggedDocRef;
        if (tagged.__colName === LOCAL_SHIPPING_RATE_LOCKS_COLLECTION) {
          attemptLockReads.push(tagged.id);
        }
        const entry = getColMap(tagged.__colName).get(tagged.id);
        const key = `${tagged.__colName}/${tagged.id}`;
        if (!readVersions.has(key)) {
          readVersions.set(key, getVersion(tagged.__colName, tagged.id));
        }
        return {
          id: tagged.id,
          exists: Boolean(entry),
          data: () => (entry ? { ...entry.data } : undefined),
        };
      }

      const tx: LocalRateTxLike = {
        get: txGet,
        set(
          ref: LocalRateDocRefLike,
          data: Record<string, unknown>,
          opts?: { merge?: boolean }
        ) {
          hasWritten = true;
          const tagged = ref as TaggedDocRef;
          stagedWrites.push({
            colName: tagged.__colName,
            docId: tagged.id,
            data: { ...data },
            merge: opts?.merge,
          });
        },
        delete(ref: LocalRateDocRefLike) {
          hasWritten = true;
          const tagged = ref as TaggedDocRef;
          stagedDeletes.push({ colName: tagged.__colName, docId: tagged.id });
        },
      };

      const result = await updateFn(tx);
      if (attemptLockReads.length > 0) {
        lockReadOrders.push(attemptLockReads);
      }

      if (attempt === 1 && options?.onBeforeFirstAttemptWriteCheck) {
        await options.onBeforeFirstAttemptWriteCheck({
          attempt,
          stagedWrites,
          stagedDeletes,
        });
      }

      // Atomic optimistic conflict verification against readVersions
      let conflicted = false;
      for (const [key, expectedVersion] of readVersions.entries()) {
        const [colName, docId] = key.split('/');
        const currentVersion = getVersion(colName, docId);
        if (currentVersion !== expectedVersion) {
          conflicted = true;
          break;
        }
      }

      if (conflicted) {
        commitRetries += 1;
        continue;
      }

      for (const w of stagedWrites) {
        const colMap = getColMap(w.colName);
        const prev = colMap.get(w.docId);
        const nextData =
          w.merge && prev ? { ...prev.data, ...w.data } : { ...w.data };
        const nextVersion = bumpVersion(w.colName, w.docId);
        colMap.set(w.docId, {
          data: nextData,
          version: nextVersion,
        });
      }
      for (const d of stagedDeletes) {
        getColMap(d.colName).delete(d.docId);
        bumpVersion(d.colName, d.docId);
      }

      return result;
    }

    throw new Error('Transaction exceeded max contention retries.');
  };

  return {
    storeRef,
    runTransaction,
    getColMap,
    stats: () => ({ transactionAttempts, commitRetries, lockReadOrders }),
  };
}

test('Stage 14C.3 Prioritas 1 — transactional district lock prevents concurrent active overlap race condition and enforces overlap rules for POST, PATCH, and inactive rates', async () => {
  // Part A: Two concurrent overlapping active POSTs under optimistic transaction concurrency + barrier
  let barrierArrivals = 0;
  let releaseBarrier!: () => void;
  const bothAttempt1ReadsDone = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  const txStore = createOptimisticTransactionalMockStore({
    onBeforeFirstAttemptWriteCheck: async () => {
      barrierArrivals += 1;
      if (barrierArrivals === 2) {
        releaseBarrier();
      }
      await bothAttempt1ReadsDone;
    },
  });

  const repo = new FirestoreLocalShippingRateRepository(
    txStore.storeRef,
    txStore.runTransaction
  );

  await withLocalRatesServer(
    (app) => {
      const ownerHandlers = createOwnerLocalShippingRateHandlers({
        resolveOwnerRepository: async () => repo,
      });
      app.get('/api/owner/local-shipping-rates', ownerHandlers.list);
      app.post('/api/owner/local-shipping-rates', ownerHandlers.create);
      app.patch('/api/owner/local-shipping-rates/:rateId', ownerHandlers.update);
    },
    async (baseUrl) => {
      // 1. Concurrent overlapping active POSTs (0..1000g & 500..1500g)
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              id: 'tx_tier_a',
              weightMinGram: 0,
              weightMaxGram: 1000,
              shippingFee: 10000,
              isActive: true,
            })
          ),
        }),
        fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              id: 'tx_tier_b',
              weightMinGram: 500,
              weightMaxGram: 1500,
              shippingFee: 14000,
              isActive: true,
            })
          ),
        }),
      ]);

      // Exactly 1 succeeds (201) and 1 is rejected (409) after lock-doc conflict retry
      const statuses = [resA.status, resB.status].sort((x, y) => x - y);
      assert.deepEqual(statuses, [201, 409]);
      assert.ok(txStore.stats().commitRetries >= 1);

      const loserBody = (resA.status === 409
        ? await resA.json()
        : await resB.json()) as { code: string };
      assert.equal(loserBody.code, 'OVERLAPPING_LOCAL_SHIPPING_RATE');

      const ratesMap = txStore.getColMap(LOCAL_SHIPPING_RATES_COLLECTION);
      const lockMap = txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION);
      assert.equal(ratesMap.size, 1);
      assert.equal(lockMap.get('35.02.17')?.data.revision, 1);

      const allAfterRace = await repo.listAllRates();
      assert.equal(allAfterRace.length, 1);
      const winner = allAfterRace[0];
      assert.equal(
        matchActiveLocalRatesForDistrictAndWeight(allAfterRace, '35.02.17', 750)
          .length,
        1
      );

      // 2. Normal non-overlapping contiguous POST succeeds (201)
      const contiguousMin = winner.weightMaxGram + 1;
      const contiguousMax = contiguousMin + 1999;
      const secondTierRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeValidRateInput({
            id: 'tx_tier_contiguous',
            weightMinGram: contiguousMin,
            weightMaxGram: contiguousMax,
            shippingFee: 18000,
            isActive: true,
          })
        ),
      });
      assert.equal(secondTierRes.status, 201);

      // 3. Sequential POST overlap rejected (409) and existing data preserved
      const seqOverlapRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeValidRateInput({
            weightMinGram: winner.weightMinGram + 100,
            weightMaxGram: winner.weightMaxGram + 200,
            shippingFee: 15000,
            isActive: true,
          })
        ),
      });
      assert.equal(seqOverlapRes.status, 409);
      assert.equal(ratesMap.size, 2);

      // 4. PATCH overlap rejected (409) and existing tier unchanged
      const patchOverlapRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/tx_tier_contiguous`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              weightMinGram: winner.weightMaxGram - 100,
              weightMaxGram: contiguousMax,
              shippingFee: 18000,
              isActive: true,
            })
          ),
        }
      );
      assert.equal(patchOverlapRes.status, 409);
      assert.equal(
        ratesMap.get('tx_tier_contiguous')?.data.weightMinGram,
        contiguousMin
      );

      // 5. Inactive rates: allowed to overlap active range (different bounds/5-tuple),
      //    but re-activating it into overlap is rejected (409), and exact inactive duplicate is rejected (409)
      const inactiveOverlapRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              id: 'tx_tier_inactive',
              weightMinGram: 200,
              weightMaxGram: 2000,
              shippingFee: 9000,
              isActive: false,
            })
          ),
        }
      );
      assert.equal(inactiveOverlapRes.status, 201);

      const inactiveExactDupRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            makeValidRateInput({
              weightMinGram: 200,
              weightMaxGram: 2000,
              shippingFee: 9500,
              isActive: false,
            })
          ),
        }
      );
      assert.equal(inactiveExactDupRes.status, 409);
      assert.equal(
        ((await inactiveExactDupRes.json()) as { code: string }).code,
        'DUPLICATE_LOCAL_SHIPPING_RATE'
      );

      const reactivateOverlapRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/tx_tier_inactive`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: true }),
        }
      );
      assert.equal(reactivateOverlapRes.status, 409);
      assert.equal(ratesMap.get('tx_tier_inactive')?.data.isActive, false);
    }
  );

  // Part B: Fallback in-process per-district serialization when runTransaction is omitted
  const fallbackStore = createMockFirestoreStoreRef();
  const fallbackRepo = new FirestoreLocalShippingRateRepository(
    fallbackStore.storeRef
  );
  const [fbA, fbB] = await Promise.allSettled([
    fallbackRepo.saveRate(
      mustParseRateInput({
        id: 'fb_a',
        weightMinGram: 0,
        weightMaxGram: 1000,
        shippingFee: 10000,
        isActive: true,
      })
    ),
    fallbackRepo.saveRate(
      mustParseRateInput({
        id: 'fb_b',
        weightMinGram: 500,
        weightMaxGram: 1500,
        shippingFee: 14000,
        isActive: true,
      })
    ),
  ]);
  const fulfilledCount = [fbA, fbB].filter((r) => r.status === 'fulfilled').length;
  const rejectedCount = [fbA, fbB].filter((r) => r.status === 'rejected').length;
  assert.equal(fulfilledCount, 1);
  assert.equal(rejectedCount, 1);
  assert.equal(fallbackStore.rawStore.size, 1);
});

test('Stage 14C.3 Prioritas 2 — requireOwnerAuth & server configuration enforce 401/403/503/500 and forward verified owner UID == STORE_ID', async () => {
  const OWNER_STORE_UID = 'owner_uid_store_001';
  let currentStoreId = OWNER_STORE_UID;
  let firestoreFailureMode: 'none' | 'config_error' | 'iam_denied' | 'generic_db' =
    'none';
  let verifyTokenMode: 'valid_owner' | 'other_uid' | 'invalid_token' | 'admin_err' =
    'valid_owner';

  const txStore = createOptimisticTransactionalMockStore();
  const fakeDb = {
    collection(name: string) {
      assert.equal(name, 'stores');
      return {
        doc(docId: string) {
          assert.equal(docId, OWNER_STORE_UID);
          return {
            collection(subCol: string) {
              if (firestoreFailureMode === 'iam_denied') {
                return {
                  where: () => ({
                    get: async () => {
                      throw Object.assign(new Error('7 PERMISSION_DENIED: missing IAM'), {
                        code: 7,
                      });
                    },
                  }),
                  get: async () => {
                    throw Object.assign(new Error('7 PERMISSION_DENIED: missing IAM'), {
                      code: 7,
                    });
                  },
                  doc: () => txStore.storeRef.collection(subCol).doc('unused'),
                };
              }
              if (firestoreFailureMode === 'generic_db') {
                return {
                  where: () => ({
                    get: async () => {
                      throw new Error('Unexpected Firestore outage');
                    },
                  }),
                  get: async () => {
                    throw new Error('Unexpected Firestore outage');
                  },
                  doc: () => txStore.storeRef.collection(subCol).doc('unused'),
                };
              }
              return txStore.storeRef.collection(subCol);
            },
          };
        },
      };
    },
    runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      return txStore.runTransaction(fn as Parameters<LocalRateRunTransactionFn>[0]);
    },
  } as unknown as Firestore;

  await withLocalRatesServer(
    (app) => {
      const handlers = createOwnerLocalShippingRateServerHandlers({
        getStoreId: () => currentStoreId,
        getFirestore: () => {
          if (firestoreFailureMode === 'config_error') {
            throw new Error(
              'FIREBASE_SERVICE_ACCOUNT_JSON harus berisi client_email dan private_key.'
            );
          }
          return fakeDb;
        },
        verifyIdToken: async (token: string) => {
          if (verifyTokenMode === 'invalid_token' || token === 'bad-token') {
            throw new Error('Firebase ID token has expired');
          }
          if (verifyTokenMode === 'admin_err') {
            throw new Error('Failed to fetch Firebase public keys');
          }
          if (verifyTokenMode === 'other_uid') {
            return { uid: 'cashier_uid_999', email: 'kasir@example.com' };
          }
          return { uid: OWNER_STORE_UID, email: 'owner@example.com' };
        },
      });
      app.get('/api/owner/local-shipping-rates', handlers.list);
      app.post('/api/owner/local-shipping-rates', handlers.create);
    },
    async (baseUrl) => {
      // 1. Missing or non-Bearer Authorization header -> 401 OWNER_AUTH_REQUIRED
      const noHeaderRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`);
      assert.equal(noHeaderRes.status, 401);
      assert.equal(
        ((await noHeaderRes.json()) as { code: string }).code,
        'OWNER_AUTH_REQUIRED'
      );

      const basicAuthRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      assert.equal(basicAuthRes.status, 401);
      assert.equal(
        ((await basicAuthRes.json()) as { code: string }).code,
        'OWNER_AUTH_REQUIRED'
      );

      // 2. Invalid Bearer token -> 401 OWNER_TOKEN_INVALID
      verifyTokenMode = 'invalid_token';
      const badTokenRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer bad-token' },
      });
      assert.equal(badTokenRes.status, 401);
      assert.equal(
        ((await badTokenRes.json()) as { code: string }).code,
        'OWNER_TOKEN_INVALID'
      );

      // 3. UID differs from STORE_ID -> 403 OWNER_FORBIDDEN
      verifyTokenMode = 'other_uid';
      const wrongUidRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-non-owner-jwt' },
      });
      assert.equal(wrongUidRes.status, 403);
      assert.equal(
        ((await wrongUidRes.json()) as { code: string }).code,
        'OWNER_FORBIDDEN'
      );

      // 4. UID matches STORE_ID -> succeeds through repository & transaction (201 + 200)
      verifyTokenMode = 'valid_owner';
      const createRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-owner-jwt',
        },
        body: JSON.stringify(makeValidRateInput({ shippingFee: 12500 })),
      });
      assert.equal(createRes.status, 201);

      const listRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-owner-jwt' },
      });
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as {
        rates: LocalShippingRate[];
        count: number;
      };
      assert.equal(listData.count, 1);
      assert.equal(listData.rates[0].shippingFee, 12500);

      // 5. Empty STORE_ID -> 503 STORE_ID_MISSING
      currentStoreId = '   ';
      const noStoreRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-owner-jwt' },
      });
      assert.equal(noStoreRes.status, 503);
      assert.equal(
        ((await noStoreRes.json()) as { code: string }).code,
        'STORE_ID_MISSING'
      );
      currentStoreId = OWNER_STORE_UID;

      // 6a. Admin SDK config error -> 503 ADMIN_SDK_CONFIG_ERROR
      firestoreFailureMode = 'config_error';
      const configErrRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-owner-jwt' },
      });
      assert.equal(configErrRes.status, 503);
      assert.equal(
        ((await configErrRes.json()) as { code: string }).code,
        'ADMIN_SDK_CONFIG_ERROR'
      );
      firestoreFailureMode = 'none';

      // 6b. Firebase Admin verifyIdToken failure -> 401 OWNER_TOKEN_INVALID
      verifyTokenMode = 'admin_err';
      const verifyErrRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-owner-jwt' },
      });
      assert.equal(verifyErrRes.status, 401);
      assert.equal(
        ((await verifyErrRes.json()) as { code: string }).code,
        'OWNER_TOKEN_INVALID'
      );
      verifyTokenMode = 'valid_owner';

      // 6c. Firestore IAM PERMISSION_DENIED -> 503 OWNER_IAM_PERMISSION_DENIED; generic outage -> 500
      firestoreFailureMode = 'iam_denied';
      const iamErrRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer valid-owner-jwt' },
      });
      assert.equal(iamErrRes.status, 503);
      assert.equal(
        ((await iamErrRes.json()) as { code: string }).code,
        'OWNER_IAM_PERMISSION_DENIED'
      );

      firestoreFailureMode = 'generic_db';
      const genericErrRes = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates`,
        {
          headers: { Authorization: 'Bearer valid-owner-jwt' },
        }
      );
      assert.equal(genericErrRes.status, 500);
      assert.equal(
        ((await genericErrRes.json()) as { code: string }).code,
        'OWNER_FIRESTORE_ERROR'
      );
    }
  );
});

test('Stage 14C.11 Bagian A & B — transactional PATCH (including cross-district moves) and DELETE maintain district lock integrity via full Owner auth handlers', async () => {
  const OWNER_UID = 'owner_uid_14c11_ab';
  const txStore = createOptimisticTransactionalMockStore();
  const fakeDb = {
    collection(name: string) {
      assert.equal(name, 'stores');
      return {
        doc(docId: string) {
          assert.equal(docId, OWNER_UID);
          return {
            collection: (subCol: string) => txStore.storeRef.collection(subCol),
          };
        },
      };
    },
    runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      return txStore.runTransaction(fn as Parameters<LocalRateRunTransactionFn>[0]);
    },
  } as unknown as Firestore;

  const ratesMap = txStore.getColMap(LOCAL_SHIPPING_RATES_COLLECTION);
  const lockMap = txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION);

  await withLocalRatesServer(
    (app) => {
      const handlers = createOwnerLocalShippingRateServerHandlers({
        getStoreId: () => OWNER_UID,
        getFirestore: () => fakeDb,
        verifyIdToken: async (token: string) => {
          assert.equal(token, 'owner-token');
          return { uid: OWNER_UID, email: 'owner@example.com' };
        },
      });
      app.get('/api/owner/local-shipping-rates', handlers.list);
      app.post('/api/owner/local-shipping-rates', handlers.create);
      app.patch('/api/owner/local-shipping-rates/:rateId', handlers.update);
      app.delete('/api/owner/local-shipping-rates/:rateId', handlers.remove);
    },
    async (baseUrl) => {
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      };

      // Seed 2 rates in district 35.02.17 (Ponorogo) and 1 rate in district 35.02.16 (Siman)
      const createA = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(
          makeValidRateInput({
            id: 'rate_ponorogo_a',
            districtCode: '35.02.17',
            districtName: 'PONOROGO',
            weightMinGram: 0,
            weightMaxGram: 1000,
            shippingFee: 10000,
          })
        ),
      });
      assert.equal(createA.status, 201);

      const createB = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(
          makeValidRateInput({
            id: 'rate_ponorogo_b',
            districtCode: '35.02.17',
            districtName: 'PONOROGO',
            weightMinGram: 1001,
            weightMaxGram: 3000,
            shippingFee: 15000,
          })
        ),
      });
      assert.equal(createB.status, 201);

      const createSiman = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(
          makeValidRateInput({
            id: 'rate_siman_c',
            districtCode: '35.02.16',
            districtName: 'SIMAN',
            weightMinGram: 2000,
            weightMaxGram: 4000,
            shippingFee: 18000,
          })
        ),
      });
      assert.equal(createSiman.status, 201);
      assert.equal(lockMap.get('35.02.17')?.data.revision, 2);
      assert.equal(lockMap.get('35.02.16')?.data.revision, 1);

      // 1. PATCH existing rate succeeds (200) and updates lock revision
      const patchOk = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ shippingFee: 11000 }),
        }
      );
      assert.equal(patchOk.status, 200);
      assert.equal(lockMap.get('35.02.17')?.data.revision, 3);

      // 2. PATCH non-existent rate -> 404 without creating doc or bumping locks
      const patchMissing = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_missing_999`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ shippingFee: 9000 }),
        }
      );
      assert.equal(patchMissing.status, 404);
      assert.equal(
        ((await patchMissing.json()) as { code: string }).code,
        'LOCAL_RATE_NOT_FOUND'
      );
      assert.equal(ratesMap.has('rate_missing_999'), false);
      assert.equal(lockMap.get('35.02.17')?.data.revision, 3);

      // 3. PATCH duplicate & overlap rejected (409), locks untouched
      const patchDup = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ weightMinGram: 1001, weightMaxGram: 3000 }),
        }
      );
      assert.equal(patchDup.status, 409);
      assert.equal(
        ((await patchDup.json()) as { code: string }).code,
        'DUPLICATE_LOCAL_SHIPPING_RATE'
      );

      const patchOverlap = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ weightMinGram: 0, weightMaxGram: 1500 }),
        }
      );
      assert.equal(patchOverlap.status, 409);
      assert.equal(
        ((await patchOverlap.json()) as { code: string }).code,
        'OVERLAPPING_LOCAL_SHIPPING_RATE'
      );
      assert.equal(lockMap.get('35.02.17')?.data.revision, 3);

      // 4. PATCH cross-district move into overlapping destination range -> rejected 409,
      //    origin rate & both locks unchanged
      const moveOverlap = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({
            districtCode: '35.02.16',
            districtName: 'SIMAN',
            weightMinGram: 1000,
            weightMaxGram: 2500,
          }),
        }
      );
      assert.equal(moveOverlap.status, 409);
      assert.equal(ratesMap.get('rate_ponorogo_a')?.data.districtCode, '35.02.17');
      assert.equal(lockMap.get('35.02.17')?.data.revision, 3);
      assert.equal(lockMap.get('35.02.16')?.data.revision, 1);

      // 5. PATCH cross-district move into non-overlapping range (35.02.17 -> 35.02.16) succeeds (200)
      //    and reads locks in deterministic sorted order ['35.02.16', '35.02.17'], updating BOTH locks
      const prevLockReadCount = txStore.stats().lockReadOrders.length;
      const moveOk = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({
            districtCode: '35.02.16',
            districtName: 'SIMAN',
          }),
        }
      );
      assert.equal(moveOk.status, 200);
      assert.equal(ratesMap.get('rate_ponorogo_a')?.data.districtCode, '35.02.16');
      assert.equal(lockMap.get('35.02.17')?.data.revision, 4);
      assert.equal(lockMap.get('35.02.16')?.data.revision, 2);
      assert.deepEqual(txStore.stats().lockReadOrders[prevLockReadCount], [
        '35.02.16',
        '35.02.17',
      ]);

      // 6. DELETE non-existent rate -> 404 without creating docs or bumping locks
      const delMissing = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_missing_999`,
        { method: 'DELETE', headers: { Authorization: 'Bearer owner-token' } }
      );
      assert.equal(delMissing.status, 404);
      assert.equal(lockMap.get('35.02.16')?.data.revision, 2);

      // 7. DELETE existing rate in 35.02.16 bumps lock('35.02.16') atomically and preserves sibling rate_siman_c
      const delOk = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_ponorogo_a`,
        { method: 'DELETE', headers: { Authorization: 'Bearer owner-token' } }
      );
      assert.equal(delOk.status, 200);
      assert.deepEqual(await delOk.json(), {
        deleted: true,
        id: 'rate_ponorogo_a',
      });
      assert.equal(ratesMap.has('rate_ponorogo_a'), false);
      assert.equal(ratesMap.has('rate_siman_c'), true);
      assert.equal(lockMap.get('35.02.16')?.data.revision, 3);
      assert.equal(lockMap.get('35.02.17')?.data.revision, 4);

      const listFinal = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer owner-token' },
      });
      assert.equal(listFinal.status, 200);
      const listFinalBody = (await listFinal.json()) as {
        rates: LocalShippingRate[];
        count: number;
      };
      assert.deepEqual(
        listFinalBody.rates.map((r) => r.id).sort(),
        ['rate_ponorogo_b', 'rate_siman_c']
      );
    }
  );
});

test('Stage 14C.11 Bagian C1 — interleaved PATCH vs DELETE never recreates deleted doc, DELETE tracks moved rate, and concurrent PATCHes preserve all changes', async () => {
  // Scenario 1: PATCH pauses on attempt 1 after reading rateA; DELETE commits first;
  // PATCH retries, sees !exists inside transaction, returns 404, and NEVER recreates rateA.
  let pauseFirstPatch = false;
  let notifyPatchPaused!: () => void;
  const patchPaused = new Promise<void>((resolve) => {
    notifyPatchPaused = resolve;
  });
  let releasePausedPatch!: () => void;
  const allowPatchResume = new Promise<void>((resolve) => {
    releasePausedPatch = resolve;
  });

  const store1 = createOptimisticTransactionalMockStore({
    onBeforeFirstAttemptWriteCheck: async ({ stagedWrites }) => {
      if (
        pauseFirstPatch &&
        stagedWrites.some((w) => w.docId === 'rate_race_a')
      ) {
        pauseFirstPatch = false;
        notifyPatchPaused();
        await allowPatchResume;
      }
    },
  });
  const repo1 = new FirestoreLocalShippingRateRepository(
    store1.storeRef,
    store1.runTransaction
  );
  await repo1.saveRate(mustParseRateInput({ id: 'rate_race_a', shippingFee: 10000 }));

  pauseFirstPatch = true;
  const patchPromise = repo1.patchRate('rate_race_a', { shippingFee: 22000 });
  await patchPaused;
  assert.equal(await repo1.deleteRate('rate_race_a'), true);
  releasePausedPatch();

  await assert.rejects(
    () => patchPromise,
    (err: { statusCode?: number; code?: string }) =>
      err.statusCode === 404 && err.code === 'LOCAL_RATE_NOT_FOUND'
  );
  assert.equal(store1.getColMap(LOCAL_SHIPPING_RATES_COLLECTION).has('rate_race_a'), false);
  assert.ok(store1.stats().commitRetries >= 1);

  // Scenario 2: DELETE pauses on attempt 1 after reading rateB in 35.02.17;
  // PATCH moves rateB to 35.02.16 and commits; DELETE retries, follows rateB to 35.02.16,
  // deletes rateB, and bumps lock('35.02.16').
  let pauseFirstDelete = false;
  let notifyDeletePaused!: () => void;
  const deletePaused = new Promise<void>((resolve) => {
    notifyDeletePaused = resolve;
  });
  let releasePausedDelete!: () => void;
  const allowDeleteResume = new Promise<void>((resolve) => {
    releasePausedDelete = resolve;
  });

  const store2 = createOptimisticTransactionalMockStore({
    onBeforeFirstAttemptWriteCheck: async ({ stagedDeletes }) => {
      if (
        pauseFirstDelete &&
        stagedDeletes.some((d) => d.docId === 'rate_race_b')
      ) {
        pauseFirstDelete = false;
        notifyDeletePaused();
        await allowDeleteResume;
      }
    },
  });
  const repo2 = new FirestoreLocalShippingRateRepository(
    store2.storeRef,
    store2.runTransaction
  );
  await repo2.saveRate(
    mustParseRateInput({
      id: 'rate_race_b',
      districtCode: '35.02.17',
      districtName: 'PONOROGO',
    })
  );

  pauseFirstDelete = true;
  const deletePromise = repo2.deleteRate('rate_race_b');
  await deletePaused;
  const movedRate = await repo2.patchRate('rate_race_b', {
    districtCode: '35.02.16',
    districtName: 'SIMAN',
  });
  assert.equal(movedRate.districtCode, '35.02.16');
  releasePausedDelete();

  assert.equal(await deletePromise, true);
  assert.equal(store2.getColMap(LOCAL_SHIPPING_RATES_COLLECTION).has('rate_race_b'), false);
  assert.equal(
    store2.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.16')?.data
      .revision,
    2
  );
  assert.ok(store2.stats().commitRetries >= 1);

  // Scenario 3: Two concurrent partial PATCHes on the same ID preserve both field updates
  let armed3 = false;
  let barrierArrivals = 0;
  let releaseBoth!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const store3 = createOptimisticTransactionalMockStore({
    onBeforeFirstAttemptWriteCheck: async () => {
      if (!armed3) return;
      barrierArrivals += 1;
      if (barrierArrivals === 2) releaseBoth();
      await bothReady;
    },
  });
  const repo3 = new FirestoreLocalShippingRateRepository(
    store3.storeRef,
    store3.runTransaction
  );
  await repo3.saveRate(
    mustParseRateInput({
      id: 'rate_race_c',
      shippingFee: 12000,
      isActive: true,
    })
  );
  barrierArrivals = 0;
  armed3 = true;

  const [pFee, pActive] = await Promise.all([
    repo3.patchRate('rate_race_c', { shippingFee: 19500 }),
    repo3.patchRate('rate_race_c', { isActive: false }),
  ]);
  assert.equal(pFee.id, 'rate_race_c');
  assert.equal(pActive.id, 'rate_race_c');
  assert.ok(store3.stats().commitRetries >= 1);

  const finalC = await repo3.getRateById('rate_race_c');
  assert.equal(finalC?.shippingFee, 19500);
  assert.equal(finalC?.isActive, false);
});

test('Stage 14C.11 Bagian C2 — concurrent POST+PATCH, POST+DELETE, cross-district moves vs origin/destination, and bidirectional moves stay consistent', async () => {
  // 1. Concurrent POST and PATCH targeting overlapping range in same district -> exactly 1 wins (200/201) and 1 fails (409)
  {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_existing',
        weightMinGram: 0,
        weightMaxGram: 1000,
        shippingFee: 10000,
      })
    );
    arrivals = 0;
    armed = true;

    await withLocalRatesServer(
      (app) => {
        const handlers = createOwnerLocalShippingRateHandlers({
          resolveOwnerRepository: async () => repo,
        });
        app.post('/api/owner/local-shipping-rates', handlers.create);
        app.patch('/api/owner/local-shipping-rates/:rateId', handlers.update);
      },
      async (baseUrl) => {
        const [postRes, patchRes] = await Promise.all([
          fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              makeValidRateInput({
                id: 'rate_new_post',
                weightMinGram: 1200,
                weightMaxGram: 2500,
                shippingFee: 16000,
              })
            ),
          }),
          fetch(`${baseUrl}/api/owner/local-shipping-rates/rate_existing`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weightMaxGram: 2000 }),
          }),
        ]);

        const sortedStatuses = [postRes.status, patchRes.status].sort(
          (a, b) => a - b
        );
        assert.ok(
          (sortedStatuses[0] === 200 && sortedStatuses[1] === 409) ||
            (sortedStatuses[0] === 201 && sortedStatuses[1] === 409),
          `Expected one success (200/201) and one 409 conflict, got ${postRes.status} and ${patchRes.status}`
        );
        assert.ok(txStore.stats().commitRetries >= 1);
      }
    );
  }

  // 2. Concurrent POST (contiguous) + DELETE on same district -> lock conflict retries cleanly, both succeed, and lock revision advances deterministically
  {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });

    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_del',
        weightMinGram: 0,
        weightMaxGram: 1000,
        shippingFee: 10000,
      })
    );
    arrivals = 0;
    armed = true;

    await Promise.all([
      repo.saveRate(
        mustParseRateInput({
          id: 'rate_replacement',
          weightMinGram: 1001,
          weightMaxGram: 2000,
          shippingFee: 14000,
        })
      ),
      repo.deleteRate('rate_del'),
    ]);
    assert.equal(await repo.getRateById('rate_del'), null);
    assert.ok(await repo.getRateById('rate_replacement'));
    assert.ok(txStore.stats().commitRetries >= 1);
    assert.equal(
      txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.17')
        ?.data.revision,
      3
    );
  }

  // 3. PATCH moving rate_move from 35.02.17 -> 35.02.16 concurrently with operations on BOTH origin and destination
  {
    // 3a: Move out of 35.02.17 -> 35.02.16 + concurrent POST into destination 35.02.16 with overlapping weight -> [200/201, 409]
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_move',
        districtCode: '35.02.17',
        districtName: 'PONOROGO',
        weightMinGram: 0,
        weightMaxGram: 1000,
      })
    );
    arrivals = 0;
    armed = true;

    const [moveRes, destPostRes] = await Promise.allSettled([
      repo.patchRate('rate_move', {
        districtCode: '35.02.16',
        districtName: 'SIMAN',
      }),
      repo.saveRate(
        mustParseRateInput({
          id: 'rate_dest_overlap',
          districtCode: '35.02.16',
          districtName: 'SIMAN',
          weightMinGram: 500,
          weightMaxGram: 1500,
        })
      ),
    ]);
    const fulfilled = [moveRes, destPostRes].filter(
      (r) => r.status === 'fulfilled'
    ).length;
    const rejected = [moveRes, destPostRes].filter(
      (r) => r.status === 'rejected'
    ).length;
    assert.equal(fulfilled, 1);
    assert.equal(rejected, 1);
    assert.ok(txStore.stats().commitRetries >= 1);
  }

  // 3b: Move out of 35.02.17 -> 35.02.16 + concurrent operation on origin 35.02.17 (contiguous POST) -> both succeed and origin lock is updated by both
  {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_move_origin',
        districtCode: '35.02.17',
        districtName: 'PONOROGO',
        weightMinGram: 0,
        weightMaxGram: 1000,
      })
    );
    arrivals = 0;
    armed = true;

    const [moved, originCreated] = await Promise.all([
      repo.patchRate('rate_move_origin', {
        districtCode: '35.02.16',
        districtName: 'SIMAN',
      }),
      repo.saveRate(
        mustParseRateInput({
          id: 'rate_origin_new',
          districtCode: '35.02.17',
          districtName: 'PONOROGO',
          weightMinGram: 1001,
          weightMaxGram: 2000,
        })
      ),
    ]);
    assert.equal(moved.districtCode, '35.02.16');
    assert.equal(originCreated.districtCode, '35.02.17');
    assert.ok(txStore.stats().commitRetries >= 1);
    assert.equal(
      txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.17')
        ?.data.revision,
      3
    );
    assert.equal(
      txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.16')
        ?.data.revision,
      1
    );
  }

  // 4. Two concurrent PATCHes moving two different rates into the same destination district with overlapping ranges -> [fulfilled, rejected(409)]
  {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_from_15',
        districtCode: '35.02.15',
        districtName: 'MLARAK',
        weightMinGram: 0,
        weightMaxGram: 1000,
      })
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_from_17',
        districtCode: '35.02.17',
        districtName: 'PONOROGO',
        weightMinGram: 500,
        weightMaxGram: 1500,
      })
    );
    arrivals = 0;
    armed = true;

    const results = await Promise.allSettled([
      repo.patchRate('rate_from_15', {
        districtCode: '35.02.18',
        districtName: 'BABADAN',
      }),
      repo.patchRate('rate_from_17', {
        districtCode: '35.02.18',
        districtName: 'BABADAN',
      }),
    ]);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1
    );
    assert.equal(
      results.filter((r) => r.status === 'rejected').length,
      1
    );
    assert.ok(txStore.stats().commitRetries >= 1);
    const activeDest = await repo.listActiveRatesByDistrict('35.02.18');
    assert.equal(activeDest.length, 1);
  }

  // 5. Bidirectional concurrent moves (A -> B and B -> A) acquire locks in identical sorted order ['35.02.16', '35.02.17'] without deadlock
  {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const txStore = createOptimisticTransactionalMockStore({
      onBeforeFirstAttemptWriteCheck: async () => {
        if (!armed) return;
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    });
    const repo = new FirestoreLocalShippingRateRepository(
      txStore.storeRef,
      txStore.runTransaction
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_bidir_1',
        districtCode: '35.02.16',
        districtName: 'SIMAN',
        weightMinGram: 0,
        weightMaxGram: 1000,
      })
    );
    await repo.saveRate(
      mustParseRateInput({
        id: 'rate_bidir_2',
        districtCode: '35.02.17',
        districtName: 'PONOROGO',
        weightMinGram: 1001,
        weightMaxGram: 2000,
      })
    );
    arrivals = 0;
    armed = true;
    const beforeIndex = txStore.stats().lockReadOrders.length;

    const [m1, m2] = await Promise.all([
      repo.patchRate('rate_bidir_1', {
        districtCode: '35.02.17',
        districtName: 'PONOROGO',
      }),
      repo.patchRate('rate_bidir_2', {
        districtCode: '35.02.16',
        districtName: 'SIMAN',
      }),
    ]);
    assert.equal(m1.districtCode, '35.02.17');
    assert.equal(m2.districtCode, '35.02.16');
    assert.ok(txStore.stats().commitRetries >= 1);
    const moveLockOrders = txStore.stats().lockReadOrders.slice(beforeIndex);
    assert.ok(moveLockOrders.length >= 2);
    for (const order of moveLockOrders) {
      assert.deepEqual(order, ['35.02.16', '35.02.17']);
    }
  }
});

test('Stage 14C.13 — Environment Isolation Guard fails closed on missing or default Project ID / Database ID without triggering Firebase Admin or Firestore initialization', async () => {
  // A & B: Project ID & Database ID explicit validation (no automatic fallback)
  const emptyInspection = inspectOwnerFirebaseEnv({});
  assert.deepEqual(emptyInspection, {
    projectId: '',
    databaseId: '',
    storeId: '',
  });

  assert.throws(
    () =>
      resolveExplicitOwnerFirebaseConfig({
        OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db',
      }),
    /OWNER_FIREBASE_PROJECT_ID/
  );

  assert.throws(
    () =>
      resolveExplicitOwnerFirebaseConfig({
        OWNER_FIREBASE_PROJECT_ID: '   ',
        OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db',
      }),
    /OWNER_FIREBASE_PROJECT_ID/
  );

  assert.throws(
    () =>
      resolveExplicitOwnerFirebaseConfig({
        OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
      }),
    /OWNER_FIRESTORE_DATABASE_ID/
  );

  assert.throws(
    () =>
      resolveExplicitOwnerFirebaseConfig({
        OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
        OWNER_FIRESTORE_DATABASE_ID: '   ',
      }),
    /OWNER_FIRESTORE_DATABASE_ID/
  );

  assert.throws(
    () =>
      resolveExplicitOwnerFirebaseConfig({
        OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
        OWNER_FIRESTORE_DATABASE_ID: '(default)',
      }),
    /\(default\)/
  );

  const validConfig = resolveExplicitOwnerFirebaseConfig({
    OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
    OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db',
  });
  assert.deepEqual(validConfig, {
    projectId: 'mock-isolated-project',
    databaseId: 'mock-isolated-db',
  });

  // C: Initialization guard prevents Admin App / Firestore SDK calls when config is invalid
  let initAppCalls = 0;
  let getFirestoreCalls = 0;
  let adcCalls = 0;
  let certCalls = 0;
  let capturedInitProjectId: string | null = null;
  let capturedDbId: string | null = null;

  const fakeApp = { name: '[DEFAULT]-mock' } as unknown as App;
  const txStore = createOptimisticTransactionalMockStore();
  const fakeDb = {
    collection: (name: string) => {
      assert.equal(name, 'stores');
      return {
        doc: (docId: string) => {
          assert.equal(docId, 'owner_uid_isolated');
          return txStore.storeRef;
        },
      };
    },
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      txStore.runTransaction(fn as Parameters<LocalRateRunTransactionFn>[0]),
  } as unknown as Firestore;

  const makeMockSdkDeps = (env: NodeJS.ProcessEnv) => ({
    env,
    getApps: () => [],
    getApp: () => fakeApp,
    certFn: ((sa: unknown) => {
      certCalls += 1;
      return { mockCert: sa };
    }) as unknown as typeof import('firebase-admin/app').cert,
    applicationDefaultFn: (() => {
      adcCalls += 1;
      return { mockAdc: true };
    }) as unknown as typeof import('firebase-admin/app').applicationDefault,
    initializeApp: (opts: { credential: unknown; projectId: string }) => {
      initAppCalls += 1;
      capturedInitProjectId = opts.projectId;
      return fakeApp;
    },
    getFirestoreFn: (_app: App, databaseId: string) => {
      getFirestoreCalls += 1;
      capturedDbId = databaseId;
      return fakeDb;
    },
  });

  // Missing project ID / missing database ID / (default) DB -> ZERO SDK calls
  assert.throws(
    () =>
      initOwnerAdminAppWithConfig(
        makeMockSdkDeps({ OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db' })
      ),
    /OWNER_FIREBASE_PROJECT_ID/
  );
  assert.throws(
    () =>
      initOwnerFirestoreWithConfig(
        makeMockSdkDeps({ OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project' })
      ),
    /OWNER_FIRESTORE_DATABASE_ID/
  );
  assert.throws(
    () =>
      initOwnerFirestoreWithConfig(
        makeMockSdkDeps({
          OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
          OWNER_FIRESTORE_DATABASE_ID: '(default)',
        })
      ),
    /\(default\)/
  );
  assert.equal(initAppCalls, 0);
  assert.equal(getFirestoreCalls, 0);
  assert.equal(adcCalls, 0);
  assert.equal(certCalls, 0);

  // HTTP end-to-end verification via Owner handlers + ensureBackendConfigured
  let currentEnv: NodeJS.ProcessEnv = {
    OWNER_FIREBASE_PROJECT_ID: '',
    OWNER_FIRESTORE_DATABASE_ID: '',
  };

  await withLocalRatesServer(
    (app) => {
      app.get('/api/public-env-probe', (_req, res) => {
        const snapshot = inspectOwnerFirebaseEnv(currentEnv);
        res.status(200).json({ ok: true, projectId: snapshot.projectId || null });
      });

      const handlers = createOwnerLocalShippingRateServerHandlers({
        getStoreId: () => 'owner_uid_isolated',
        getFirestore: () =>
          initOwnerFirestoreWithConfig(makeMockSdkDeps(currentEnv)).db,
        verifyIdToken: async () => ({
          uid: 'owner_uid_isolated',
          email: 'owner@mock.local',
        }),
      });
      app.get('/api/owner/local-shipping-rates', handlers.list);

      // Direct ensureBackendConfigured check when process.env lacks explicit config
      app.get('/api/test-ensure-default-env', (_req, res) => {
        const prevProj = process.env.OWNER_FIREBASE_PROJECT_ID;
        const prevDb = process.env.OWNER_FIRESTORE_DATABASE_ID;
        const prevStore = process.env.STORE_ID;
        process.env.STORE_ID = 'owner_uid_isolated';
        delete process.env.OWNER_FIREBASE_PROJECT_ID;
        delete process.env.OWNER_FIRESTORE_DATABASE_ID;
        try {
          const ctx = ensureBackendConfigured(res);
          if (!ctx) return;
          res.status(200).json({ configured: true });
        } finally {
          if (prevProj === undefined) delete process.env.OWNER_FIREBASE_PROJECT_ID;
          else process.env.OWNER_FIREBASE_PROJECT_ID = prevProj;
          if (prevDb === undefined) delete process.env.OWNER_FIRESTORE_DATABASE_ID;
          else process.env.OWNER_FIRESTORE_DATABASE_ID = prevDb;
          if (prevStore === undefined) delete process.env.STORE_ID;
          else process.env.STORE_ID = prevStore;
        }
      });
    },
    async (baseUrl) => {
      // Public endpoint unaffected even when Firebase Owner env is empty
      const pubRes = await fetch(`${baseUrl}/api/public-env-probe`);
      assert.equal(pubRes.status, 200);
      assert.deepEqual(await pubRes.json(), { ok: true, projectId: null });

      // Real ensureBackendConfigured path without explicit OWNER_FIREBASE_* -> 503 ADMIN_SDK_CONFIG_ERROR
      const defaultEnsureRes = await fetch(`${baseUrl}/api/test-ensure-default-env`);
      assert.equal(defaultEnsureRes.status, 503);
      const defaultEnsureBody = (await defaultEnsureRes.json()) as {
        code: string;
        error: string;
      };
      assert.equal(defaultEnsureBody.code, 'ADMIN_SDK_CONFIG_ERROR');
      assert.match(defaultEnsureBody.error, /OWNER_FIREBASE_PROJECT_ID/);

      // Owner route fails closed with 503 when Project ID / Database ID invalid
      for (const badEnv of [
        { OWNER_FIREBASE_PROJECT_ID: '', OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db' },
        { OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project', OWNER_FIRESTORE_DATABASE_ID: '' },
        { OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project', OWNER_FIRESTORE_DATABASE_ID: '(default)' },
      ]) {
        currentEnv = badEnv;
        const failRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
          headers: { Authorization: 'Bearer mock-owner-token' },
        });
        assert.equal(failRes.status, 503);
        const failBody = (await failRes.json()) as { code: string };
        assert.equal(failBody.code, 'ADMIN_SDK_CONFIG_ERROR');
        assert.equal(initAppCalls, 0);
        assert.equal(getFirestoreCalls, 0);
      }

      // Valid explicit mock env initializes exactly with configured Project ID and Database ID
      currentEnv = {
        OWNER_FIREBASE_PROJECT_ID: 'mock-isolated-project',
        OWNER_FIRESTORE_DATABASE_ID: 'mock-isolated-db',
      };
      const okRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer mock-owner-token' },
      });
      assert.equal(okRes.status, 200);
      assert.deepEqual(await okRes.json(), { rates: [], count: 0 });
      assert.equal(initAppCalls, 1);
      assert.equal(getFirestoreCalls, 1);
      assert.equal(adcCalls, 1);
      assert.equal(capturedInitProjectId, 'mock-isolated-project');
      assert.equal(capturedDbId, 'mock-isolated-db');
    }
  );
});

test('Stage 14C.14 Bagian A — Owner local rate limiter enforces per-UID limits, mock-clock reset, independent UID buckets, and active-safe bounded cleanup', () => {
  assert.equal(OWNER_LOCAL_RATES_RATE_LIMIT_MAX_REQUESTS, 60);
  assert.equal(OWNER_LOCAL_RATES_RATE_LIMIT_WINDOW_MS, 60_000);

  let fakeNow = 1_700_000_000_000;
  const buckets = new Map<string, RateLimitBucketEntry>();
  const limiter = createOwnerLocalRateLimiter({
    maxRequests: 3,
    windowMs: 60_000,
    maxBuckets: 5,
    cleanupThreshold: 4,
    buckets,
    now: () => fakeNow,
  });

  // Requests within limit succeed for uid_alpha
  assert.deepEqual(limiter.consumeForUid('uid_alpha'), {
    allowed: true,
    limit: 3,
    remaining: 2,
    retryAfterSeconds: 0,
    resetAt: fakeNow + 60_000,
  });
  assert.equal(limiter.consumeForUid('uid_alpha').remaining, 1);
  assert.equal(limiter.consumeForUid('uid_alpha').remaining, 0);

  // 4th request within same window is rejected with accurate Retry-After
  fakeNow += 15_000; // 45s remaining
  const blocked = limiter.consumeForUid('uid_alpha');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 45);

  // Different UID gets completely separate bucket
  const betaFirst = limiter.consumeForUid('uid_beta');
  assert.equal(betaFirst.allowed, true);
  assert.equal(betaFirst.remaining, 2);

  // After advancing mock clock past window, uid_alpha bucket resets cleanly
  fakeNow += 45_000; // total +60_000ms from window start
  const resetRes = limiter.consumeForUid('uid_alpha');
  assert.equal(resetRes.allowed, true);
  assert.equal(resetRes.remaining, 2);

  // Cleanup removes expired buckets ONLY and preserves active buckets
  const cleanupBuckets = new Map<string, RateLimitBucketEntry>([
    [buildOwnerLocalRateLimitKey('expired_1'), { count: 2, resetAt: fakeNow - 1000 }],
    [buildOwnerLocalRateLimitKey('expired_2'), { count: 3, resetAt: fakeNow }],
    [buildOwnerLocalRateLimitKey('active_uid'), { count: 2, resetAt: fakeNow + 30_000 }],
  ]);
  const removed = cleanupExpiredRateLimitBuckets(cleanupBuckets, fakeNow, 5);
  assert.equal(removed, 2);
  assert.equal(cleanupBuckets.has(buildOwnerLocalRateLimitKey('expired_1')), false);
  assert.equal(cleanupBuckets.has(buildOwnerLocalRateLimitKey('expired_2')), false);
  assert.deepEqual(cleanupBuckets.get(buildOwnerLocalRateLimitKey('active_uid')), {
    count: 2,
    resetAt: fakeNow + 30_000,
  });

  // Bounded cap prevents unbounded memory growth even under many distinct UIDs
  const boundedBuckets = new Map<string, RateLimitBucketEntry>();
  const boundedLimiter = createOwnerLocalRateLimiter({
    maxRequests: 2,
    windowMs: 60_000,
    maxBuckets: 3,
    cleanupThreshold: 3,
    buckets: boundedBuckets,
    now: () => fakeNow,
  });
  boundedLimiter.consumeForUid('u1');
  boundedLimiter.consumeForUid('u2');
  boundedLimiter.consumeForUid('u3');
  boundedLimiter.consumeForUid('u4');
  assert.ok(boundedBuckets.size <= 3);
});

test('Stage 14C.14 Bagian B — all 4 Owner local rate endpoints enforce per-UID rate limiting with Retry-After, preserve auth & transactions, and leak no secrets', async () => {
  let fakeNow = 1_700_100_000_000;
  const buckets = new Map<string, RateLimitBucketEntry>();
  const limiter = createOwnerLocalRateLimiter({
    maxRequests: 4,
    windowMs: 60_000,
    maxBuckets: 50,
    cleanupThreshold: 25,
    buckets,
    now: () => fakeNow,
  });

  const UID_A = 'secret_owner_uid_A_9988';
  const UID_B = 'secret_owner_uid_B_7766';
  let activeStoreId = UID_A;
  let dbAccessCount = 0;

  const txStore = createOptimisticTransactionalMockStore();
  const fakeDb = {
    collection: (name: string) => {
      assert.equal(name, 'stores');
      return {
        doc: () => {
          dbAccessCount += 1;
          return {
            collection: (subCol: string) => txStore.storeRef.collection(subCol),
          };
        },
      };
    },
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      txStore.runTransaction(fn as Parameters<LocalRateRunTransactionFn>[0]),
  } as unknown as Firestore;

  await withLocalRatesServer(
    (app) => {
      const handlers = createOwnerLocalShippingRateServerHandlers({
        getStoreId: () => activeStoreId,
        getFirestore: () => fakeDb,
        verifyIdToken: async (token: string) => {
          if (token === 'token-uid-a') {
            return { uid: UID_A, email: 'a@example.com' };
          }
          if (token === 'token-uid-b') {
            return { uid: UID_B, email: 'b@example.com' };
          }
          throw new Error('Invalid token');
        },
        rateLimiter: limiter,
      });
      app.get('/api/owner/local-shipping-rates', handlers.list);
      app.post('/api/owner/local-shipping-rates', handlers.create);
      app.patch('/api/owner/local-shipping-rates/:rateId', handlers.update);
      app.delete('/api/owner/local-shipping-rates/:rateId', handlers.remove);
    },
    async (baseUrl) => {
      // Unauthenticated / invalid / forbidden requests fail auth FIRST without consuming UID_A quota
      const noAuth = await fetch(`${baseUrl}/api/owner/local-shipping-rates`);
      assert.equal(noAuth.status, 401);
      const badAuth = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(badAuth.status, 401);
      const wrongUid = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer token-uid-b' }, // activeStoreId is UID_A -> 403
      });
      assert.equal(wrongUid.status, 403);
      assert.equal(buckets.has(buildOwnerLocalRateLimitKey(UID_A)), false);
      assert.equal(buckets.has(buildOwnerLocalRateLimitKey(UID_B)), false);

      const authA = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-uid-a',
      };

      // Consume 4 requests across ALL 4 endpoints (POST, GET, PATCH, DELETE) -> all succeed normally & keep locks accurate
      const r1Post = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify(
          makeValidRateInput({ id: 'rate_lim_1', shippingFee: 11000 })
        ),
      });
      assert.equal(r1Post.status, 201);

      const r2Get = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: authA,
      });
      assert.equal(r2Get.status, 200);
      assert.equal(((await r2Get.json()) as { count: number }).count, 1);

      const r3Patch = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_lim_1`,
        {
          method: 'PATCH',
          headers: authA,
          body: JSON.stringify({ shippingFee: 13500 }),
        }
      );
      assert.equal(r3Patch.status, 200);
      assert.equal(
        ((await r3Patch.json()) as { rate: LocalShippingRate }).rate.shippingFee,
        13500
      );

      const r4Delete = await fetch(
        `${baseUrl}/api/owner/local-shipping-rates/rate_lim_1`,
        {
          method: 'DELETE',
          headers: authA,
        }
      );
      assert.equal(r4Delete.status, 200);
      assert.equal(
        txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.17')
          ?.data.revision,
        3
      );

      const dbAccessBefore429 = dbAccessCount;
      const lockRevBefore429 = txStore
        .getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION)
        .get('35.02.17')?.data.revision;

      // Advance mock clock 10s (50s left in window) and test ALL 4 endpoints return consistent 429 + Retry-After
      fakeNow += 10_000;
      const blockedCalls = await Promise.all([
        fetch(`${baseUrl}/api/owner/local-shipping-rates`, { headers: authA }),
        fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
          method: 'POST',
          headers: authA,
          body: JSON.stringify(makeValidRateInput({ id: 'rate_blocked' })),
        }),
        fetch(`${baseUrl}/api/owner/local-shipping-rates/rate_lim_1`, {
          method: 'PATCH',
          headers: authA,
          body: JSON.stringify({ shippingFee: 99000 }),
        }),
        fetch(`${baseUrl}/api/owner/local-shipping-rates/rate_lim_1`, {
          method: 'DELETE',
          headers: authA,
        }),
      ]);

      for (const res of blockedCalls) {
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '50');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const rawText = await res.text();
        assert.equal(rawText.includes(UID_A), false);
        assert.equal(rawText.includes('token-uid-a'), false);
        assert.equal(rawText.includes('owner_local_rates'), false);
        const body = JSON.parse(rawText) as {
          code: string;
          error: string;
          retryAfterSeconds: number;
        };
        assert.equal(body.code, 'OWNER_RATE_LIMIT_EXCEEDED');
        assert.equal(body.retryAfterSeconds, 50);
        assert.ok(body.error.length > 0);
      }

      // Blocked 429 requests never hit Firestore or altered locks
      assert.equal(dbAccessCount, dbAccessBefore429);
      assert.equal(
        txStore.getColMap(LOCAL_SHIPPING_RATE_LOCKS_COLLECTION).get('35.02.17')
          ?.data.revision,
        lockRevBefore429
      );

      // Auth still works normally even while UID_A is rate-limited
      const still401 = await fetch(`${baseUrl}/api/owner/local-shipping-rates`);
      assert.equal(still401.status, 401);

      // Different UID (UID_B) from the same localhost IP is unaffected (proves per-UID isolation)
      activeStoreId = UID_B;
      const uidBRes = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: { Authorization: 'Bearer token-uid-b' },
      });
      assert.equal(uidBRes.status, 200);

      // Advance mock clock past window -> UID_A works again normally
      activeStoreId = UID_A;
      fakeNow += 50_000;
      const recovered = await fetch(`${baseUrl}/api/owner/local-shipping-rates`, {
        headers: authA,
      });
      assert.equal(recovered.status, 200);
    }
  );
});





