import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  BoundedTtlCache,
  clearRajaOngkirCaches,
  createRajaOngkirJntRatesHandler,
  createRajaOngkirLocationsHandler,
  fetchRajaOngkirDestinations,
  fetchRajaOngkirJntCost,
  getRajaOngkirConfigSummary,
  parseRajaOngkirDestinationResponse,
  parseRajaOngkirDomesticCostResponse,
  quoteRajaOngkirJntRatesForStore,
  searchRajaOngkirDestinationsWithCache,
  type ServerProductQuoteSnapshot,
} from './server.ts';
import type {
  JntRateOption,
  RajaOngkirDestinationOption,
  RajaOngkirJntCostResponse,
} from './src/types/pos.ts';

test('getRajaOngkirConfigSummary defaults to Komerce V1 URL, validates originId, and never exposes API key', () => {
  const empty = getRajaOngkirConfigSummary({});
  assert.equal(empty.configured, false);
  assert.equal(empty.apiKeyPresent, false);
  assert.equal(empty.baseUrl, 'https://rajaongkir.komerce.id/api/v1');
  assert.equal(empty.originId, null);
  assert.equal(empty.timeoutMs, 8000);
  assert.deepEqual(empty.missingFields, [
    'RAJAONGKIR_API_KEY',
    'RAJAONGKIR_ORIGIN_ID',
  ]);

  const secretKey = 'rajaongkir-secret-key-do-not-expose';
  const configured = getRajaOngkirConfigSummary({
    RAJAONGKIR_API_KEY: secretKey,
    RAJAONGKIR_ORIGIN_ID: '31555',
    RAJAONGKIR_TIMEOUT_MS: '6000',
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.apiKeyPresent, true);
  assert.equal(configured.originId, 31555);
  assert.equal(configured.timeoutMs, 6000);
  assert.deepEqual(configured.missingFields, []);
  assert.equal(JSON.stringify(configured).includes(secretKey), false);
});

test('RajaOngkir adapters never perform HTTP requests when API key or originId is missing or inputs are invalid', async () => {
  let called = false;
  const spyFetch: typeof fetch = async () => {
    called = true;
    throw new Error('Must not invoke external fetch');
  };

  const destNoKey = await fetchRajaOngkirDestinations('ponorogo', {
    env: {},
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(destNoKey.ok, false);
  assert.equal(destNoKey.code, 'RAJAONGKIR_API_KEY_MISSING');

  const costNoKey = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 1000 },
    { env: { RAJAONGKIR_ORIGIN_ID: '31555' }, fetchImpl: spyFetch }
  );
  assert.equal(called, false);
  assert.equal(costNoKey.ok, false);
  assert.equal(costNoKey.fallbackToManual, true);
  assert.equal(costNoKey.code, 'RAJAONGKIR_API_KEY_MISSING');

  const costNoOrigin = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 1000 },
    { env: { RAJAONGKIR_API_KEY: 'dummy-key' }, fetchImpl: spyFetch }
  );
  assert.equal(called, false);
  assert.equal(costNoOrigin.ok, false);
  assert.equal(costNoOrigin.fallbackToManual, true);
  assert.equal(costNoOrigin.code, 'RAJAONGKIR_ORIGIN_MISSING');

  const invalidInputsEnv = {
    RAJAONGKIR_API_KEY: 'dummy-key',
    RAJAONGKIR_ORIGIN_ID: '31555',
  };

  const badQuery = await fetchRajaOngkirDestinations('ab', {
    env: invalidInputsEnv,
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(badQuery.ok, false);
  assert.equal(badQuery.code, 'INVALID_LOCATION_QUERY');

  const badDest = await fetchRajaOngkirJntCost(
    { destinationId: -5, weightGrams: 1000 },
    { env: invalidInputsEnv, fetchImpl: spyFetch }
  );
  assert.equal(called, false);
  assert.equal(badDest.ok, false);
  assert.equal(badDest.code, 'INVALID_DESTINATION_ID');

  const badWeight = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 0 },
    { env: invalidInputsEnv, fetchImpl: spyFetch }
  );
  assert.equal(called, false);
  assert.equal(badWeight.ok, false);
  assert.equal(badWeight.code, 'INVALID_PACKAGE_WEIGHT');
});

test('fetchRajaOngkirDestinations parses mock Komerce destination results and handles empty, invalid, HTTP error, and timeout responses', async () => {
  const secretKey = 'ro-dest-secret-999';
  const env = { RAJAONGKIR_API_KEY: secretKey };

  let capturedUrl = '';
  let capturedKeyHeader = '';
  const okDest = await fetchRajaOngkirDestinations('ponorogo', {
    env,
    limit: 5,
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedKeyHeader = (init?.headers as Record<string, string>)?.key ?? '';
      return new Response(
        JSON.stringify({
          meta: {
            message: 'Success Get Domestic Destinations',
            code: 200,
            status: 'success',
          },
          data: [
            {
              id: 31555,
              label: 'Babadan, Ponorogo, Jawa Timur',
              province_name: 'Jawa Timur',
              city_name: 'Ponorogo',
              district_name: 'Babadan',
              subdistrict_name: 'Babadan',
              zip_code: '63491',
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(
    capturedUrl,
    'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=ponorogo&limit=5&offset=0'
  );
  assert.equal(capturedKeyHeader, secretKey);
  assert.equal(okDest.ok, true);
  assert.equal(okDest.destinations.length, 1);
  assert.deepEqual(okDest.destinations[0], {
    id: 31555,
    label: 'Babadan, Ponorogo, Jawa Timur',
    provinceName: 'Jawa Timur',
    cityName: 'Ponorogo',
    districtName: 'Babadan',
    subdistrictName: 'Babadan',
    zipCode: '63491',
  });
  assert.equal(JSON.stringify(okDest).includes(secretKey), false);

  const emptyDest = await fetchRajaOngkirDestinations('zzzzzz', {
    env,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ meta: { code: 200, status: 'success' }, data: [] }),
        { status: 200 }
      ),
  });
  assert.equal(emptyDest.ok, true);
  assert.equal(emptyDest.code, 'LOCATIONS_EMPTY');
  assert.deepEqual(emptyDest.destinations, []);

  const invalidDest = await fetchRajaOngkirDestinations('ponorogo', {
    env,
    fetchImpl: async () => new Response('invalid-json', { status: 200 }),
  });
  assert.equal(invalidDest.ok, false);
  assert.equal(invalidDest.code, 'RAJAONGKIR_INVALID_RESPONSE');

  const httpErrDest = await fetchRajaOngkirDestinations('ponorogo', {
    env,
    fetchImpl: async () => new Response(`Denied ${secretKey}`, { status: 401 }),
  });
  assert.equal(httpErrDest.ok, false);
  assert.equal(httpErrDest.code, 'RAJAONGKIR_HTTP_ERROR');
  assert.equal(JSON.stringify(httpErrDest).includes(secretKey), false);

  const timeoutDest = await fetchRajaOngkirDestinations('ponorogo', {
    env,
    fetchImpl: async () => {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.equal(timeoutDest.ok, false);
  assert.equal(timeoutDest.code, 'RAJAONGKIR_TIMEOUT');

  assert.deepEqual(
    parseRajaOngkirDestinationResponse({ meta: { status: 'error' }, data: [] }),
    { ok: false, destinations: [] }
  );
});

test('fetchRajaOngkirJntCost sends form-urlencoded request with key header and handles mock J&T rates, empty, invalid, HTTP error, and timeout', async () => {
  const secretKey = 'ro-cost-secret-888';
  const env = {
    RAJAONGKIR_API_KEY: secretKey,
    RAJAONGKIR_ORIGIN_ID: '31555',
  };

  let capturedUrl = '';
  let capturedMethod = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = '';

  const okCost = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 750 },
    {
      env,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = String(init?.method || '');
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        capturedBody = String(init?.body || '');
        return new Response(
          JSON.stringify({
            meta: {
              message: 'Success Calculate Domestic Shipping cost',
              code: 200,
              status: 'success',
            },
            data: [
              {
                name: 'J&T Express',
                code: 'jnt',
                service: 'JSD',
                description: 'J&T Super',
                cost: 32000,
                etd: '1 hari',
              },
              {
                name: 'J&T Express',
                code: 'jnt',
                service: 'EZ',
                description: 'Reguler Service',
                cost: 17000,
                etd: '2-3 hari',
              },
              {
                name: 'JNE',
                code: 'jne',
                service: 'REG',
                description: 'Reguler',
                cost: 15000,
                etd: '2-3 hari',
              },
            ],
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(
    capturedUrl,
    'https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost'
  );
  assert.equal(capturedMethod, 'POST');
  assert.equal(capturedHeaders.key, secretKey);
  assert.equal(
    capturedHeaders['Content-Type'],
    'application/x-www-form-urlencoded'
  );
  const bodyParams = new URLSearchParams(capturedBody);
  assert.equal(bodyParams.get('origin'), '31555');
  assert.equal(bodyParams.get('destination'), '68423');
  assert.equal(bodyParams.get('weight'), '750');
  assert.equal(bodyParams.get('courier'), 'jnt');

  assert.equal(okCost.ok, true);
  assert.equal(okCost.available, true);
  assert.equal(okCost.fallbackToManual, false);
  assert.equal(okCost.rates.length, 2);
  assert.deepEqual(okCost.rates[0], {
    courier: 'jnt',
    courierName: 'J&T Express',
    serviceCode: 'EZ',
    serviceName: 'Reguler Service',
    description: 'Reguler Service',
    cost: 17000,
    etd: '2-3 hari',
  });
  assert.equal(okCost.rates[1].serviceCode, 'JSD');
  assert.equal(JSON.stringify(okCost).includes(secretKey), false);

  const emptyRates = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 750 },
    {
      env,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ meta: { code: 200, status: 'success' }, data: [] }),
          { status: 200 }
        ),
    }
  );
  assert.equal(emptyRates.ok, true);
  assert.equal(emptyRates.available, false);
  assert.equal(emptyRates.fallbackToManual, true);
  assert.equal(emptyRates.code, 'JNT_RATE_NOT_AVAILABLE');

  const invalidJson = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 750 },
    {
      env,
      fetchImpl: async () => new Response('<html>502</html>', { status: 200 }),
    }
  );
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.fallbackToManual, true);
  assert.equal(invalidJson.code, 'RAJAONGKIR_INVALID_RESPONSE');

  const upstream500 = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 750 },
    {
      env,
      fetchImpl: async () =>
        new Response(`Upstream crash ${secretKey}`, { status: 500 }),
    }
  );
  assert.equal(upstream500.ok, false);
  assert.equal(upstream500.fallbackToManual, true);
  assert.equal(upstream500.code, 'RAJAONGKIR_HTTP_ERROR');
  assert.equal(JSON.stringify(upstream500).includes(secretKey), false);

  const timeoutRes = await fetchRajaOngkirJntCost(
    { destinationId: 68423, weightGrams: 750 },
    {
      env,
      fetchImpl: async () => {
        const err = new Error('Timed out');
        err.name = 'TimeoutError';
        throw err;
      },
    }
  );
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.fallbackToManual, true);
  assert.equal(timeoutRes.code, 'RAJAONGKIR_TIMEOUT');

  assert.deepEqual(
    parseRajaOngkirDomesticCostResponse({ meta: { status: 'failed' } }),
    { ok: false, rates: [] }
  );
});

test('quoteRajaOngkirJntRatesForStore derives weight & subtotal strictly from server products and ignores tampered browser values', async () => {
  const mockProducts: Record<string, Record<string, unknown>> = {
    prod_a: {
      id: 'prod_a',
      name: 'Madu Hutan',
      price: 45000,
      stock: 10,
      unit: 'botol',
      weightGrams: 350.2,
      cost: 30000,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      name: 'Item Belum Ditimbang',
      price: 10000,
      stock: 5,
      unit: 'pcs',
    },
  };

  const fetchProductsByIds = async (
    ids: string[]
  ): Promise<ServerProductQuoteSnapshot[]> =>
    ids.map((id) => ({
      id,
      exists: Boolean(mockProducts[id]),
      data: mockProducts[id],
    }));

  const secretKey = 'ro-store-secret-111';
  let capturedFormBody = '';

  const quoteOk = await quoteRajaOngkirJntRatesForStore(
    fetchProductsByIds,
    {
      destinationId: 68423,
      weightGrams: 1, // tampered browser field must be ignored
      originId: 999, // tampered browser field must be ignored
      shippingFee: 0, // tampered browser field must be ignored
      items: [{ productId: 'prod_a', quantity: 2 }], // 700.4g -> 701g, subtotal 90000
    },
    {
      env: {
        RAJAONGKIR_API_KEY: secretKey,
        RAJAONGKIR_ORIGIN_ID: '31555',
      },
      fetchImpl: async (_url, init) => {
        capturedFormBody = String(init?.body || '');
        return new Response(
          JSON.stringify({
            meta: { code: 200, status: 'success' },
            data: [
              {
                name: 'J&T Express',
                code: 'jnt',
                service: 'EZ',
                description: 'Reguler Service',
                cost: 18000,
                etd: '2-3 hari',
              },
            ],
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(quoteOk.statusCode, 200);
  const sentParams = new URLSearchParams(capturedFormBody);
  assert.equal(sentParams.get('origin'), '31555');
  assert.equal(sentParams.get('destination'), '68423');
  assert.equal(sentParams.get('weight'), '701');
  if (!('error' in quoteOk.body)) {
    assert.equal(quoteOk.body.available, true);
    assert.equal(quoteOk.body.fallbackToManual, false);
    assert.equal(quoteOk.body.totalWeightGrams, 700.4);
    assert.equal(quoteOk.body.normalizedWeightGrams, 701);
    assert.equal(quoteOk.body.itemsSubtotal, 90000);
    assert.equal(quoteOk.body.rates[0].cost, 18000);
    assert.equal(JSON.stringify(quoteOk.body).includes(secretKey), false);
    assert.equal(JSON.stringify(quoteOk.body).includes('30000'), false);
  }

  let fetchCalled = false;
  const quoteUnweighed = await quoteRajaOngkirJntRatesForStore(
    fetchProductsByIds,
    {
      destinationId: 68423,
      items: [
        { productId: 'prod_a', quantity: 1 },
        { productId: 'prod_unweighed', quantity: 1 },
      ],
    },
    {
      env: {
        RAJAONGKIR_API_KEY: secretKey,
        RAJAONGKIR_ORIGIN_ID: '31555',
      },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('Should not call fetch when unweighed items exist');
      },
    }
  );
  assert.equal(fetchCalled, false);
  assert.equal(quoteUnweighed.statusCode, 200);
  if (!('error' in quoteUnweighed.body)) {
    assert.equal(quoteUnweighed.body.available, false);
    assert.equal(quoteUnweighed.body.fallbackToManual, true);
    assert.equal(quoteUnweighed.body.hasUnweighedItems, true);
  }
});

// ============================================================================
// Stage 3 Tests: Bounded TTL Cache & Public RajaOngkir Express Endpoints
// ============================================================================
test('BoundedTtlCache enforces maxEntries eviction and TTL expiration deterministically', () => {
  const cache = new BoundedTtlCache<string>({ maxEntries: 2, defaultTtlMs: 5000 });
  let now = 1_000_000;

  cache.set('k1', 'v1', 5000, now);
  cache.set('k2', 'v2', 5000, now);
  assert.equal(cache.size, 2);
  // Touch k1 so k2 becomes least-recently-used
  assert.equal(cache.get('k1', now + 100), 'v1');

  cache.set('k3', 'v3', 5000, now + 200);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('k2', now + 200), undefined);
  assert.equal(cache.get('k1', now + 200), 'v1');
  assert.equal(cache.get('k3', now + 200), 'v3');

  // Advance past TTL -> entry expires automatically
  assert.equal(cache.get('k1', now + 6000), undefined);
  assert.equal(cache.size, 1);

  cache.clear();
  assert.equal(cache.size, 0);
});

async function withTestHttpServer(
  setupRoutes: (app: express.Express) => void,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  setupRoutes(app);

  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('GET /api/shipping/rajaongkir/locations caches valid results, rejects invalid queries, never caches errors/empty config, and enforces rate limits', async () => {
  clearRajaOngkirCaches();
  const secretKey = 'ro-public-loc-secret-123';
  const locCache = new BoundedTtlCache<RajaOngkirDestinationOption[]>({
    maxEntries: 10,
    defaultTtlMs: 60_000,
  });

  let nowMs = 10_000_000;
  let upstreamCalls = 0;
  let allowRateLimit = true;
  let currentEnv: Record<string, string | undefined> = {};
  let nextMockMode: 'ok' | 'empty' | 'error' | 'invalid' = 'ok';

  const mockFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    if (nextMockMode === 'empty') {
      return new Response(
        JSON.stringify({ meta: { code: 200, status: 'success' }, data: [] }),
        { status: 200 }
      );
    }
    if (nextMockMode === 'error') {
      return new Response(`Upstream error ${secretKey}`, { status: 502 });
    }
    if (nextMockMode === 'invalid') {
      return new Response('not-json', { status: 200 });
    }
    return new Response(
      JSON.stringify({
        meta: { code: 200, status: 'success' },
        data: [
          {
            id: 31555,
            label: 'Babadan, Ponorogo, Jawa Timur',
            province_name: 'Jawa Timur',
            city_name: 'Ponorogo',
            district_name: 'Babadan',
            zip_code: '63491',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withTestHttpServer(
    (app) => {
      app.get(
        '/api/shipping/rajaongkir/locations',
        createRajaOngkirLocationsHandler({
          env: new Proxy(
            {},
            {
              get: (_target, prop) =>
                typeof prop === 'string' ? currentEnv[prop] : undefined,
              ownKeys: () => Reflect.ownKeys(currentEnv),
              getOwnPropertyDescriptor: (_target, prop) =>
                typeof prop === 'string' && prop in currentEnv
                  ? {
                      enumerable: true,
                      configurable: true,
                      value: currentEnv[prop],
                    }
                  : undefined,
            }
          ) as Record<string, string | undefined>,
          fetchImpl: mockFetch,
          cache: locCache,
          now: () => nowMs,
          checkRateLimit: () => allowRateLimit,
        })
      );
    },
    async (baseUrl) => {
      // 1. Missing API key -> no external request, not cached
      const noKeyRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=ponorogo`
      );
      assert.equal(noKeyRes.status, 200);
      assert.equal(noKeyRes.headers.get('cache-control'), 'no-store');
      const noKeyJson = (await noKeyRes.json()) as {
        available: boolean;
        destinations: unknown[];
        reason?: string;
      };
      assert.equal(noKeyJson.available, false);
      assert.deepEqual(noKeyJson.destinations, []);
      assert.equal(upstreamCalls, 0);
      assert.equal(locCache.size, 0);

      // Configure API key now -> request succeeds and populates cache
      currentEnv = { RAJAONGKIR_API_KEY: secretKey };

      // 2. Invalid queries & limit -> 400 without calling fetch
      for (const badPath of [
        '/api/shipping/rajaongkir/locations?search=ab',
        '/api/shipping/rajaongkir/locations?search=%3Cscript%3E',
        '/api/shipping/rajaongkir/locations?search=ponorogo&limit=abc',
      ]) {
        const badRes = await fetch(`${baseUrl}${badPath}`);
        assert.equal(badRes.status, 400);
      }
      assert.equal(upstreamCalls, 0);

      // 3. Valid search -> fetches once, caches normalized result
      const okRes1 = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=ponorogo&limit=5`
      );
      assert.equal(okRes1.status, 200);
      const okJson1 = (await okRes1.json()) as {
        available: boolean;
        destinations: RajaOngkirDestinationOption[];
      };
      assert.equal(okJson1.available, true);
      assert.equal(okJson1.destinations.length, 1);
      assert.equal(okJson1.destinations[0].id, 31555);
      assert.equal(JSON.stringify(okJson1).includes(secretKey), false);
      assert.equal(upstreamCalls, 1);
      assert.equal(locCache.size, 1);

      // 4. Normalized duplicate search -> served from server cache (upstreamCalls remains 1)
      const okRes2 = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=%20PONOROGO%20&limit=5`
      );
      assert.equal(okRes2.status, 200);
      const okJson2 = (await okRes2.json()) as {
        available: boolean;
        destinations: RajaOngkirDestinationOption[];
      };
      assert.equal(okJson2.available, true);
      assert.equal(okJson2.destinations[0].id, 31555);
      assert.equal(upstreamCalls, 1);

      // 5. Upstream errors, invalid responses, and empty results are NEVER cached
      nextMockMode = 'error';
      const errRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=madiun`
      );
      assert.equal(errRes.status, 200);
      const errJson = (await errRes.json()) as {
        available: boolean;
        destinations: unknown[];
      };
      assert.equal(errJson.available, false);
      assert.equal(JSON.stringify(errJson).includes(secretKey), false);
      assert.equal(locCache.size, 1);

      nextMockMode = 'invalid';
      const invRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=magetan`
      );
      assert.equal(invRes.status, 200);
      assert.equal(((await invRes.json()) as { available: boolean }).available, false);
      assert.equal(locCache.size, 1);

      nextMockMode = 'empty';
      const emptyRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=zzzzzz`
      );
      assert.equal(emptyRes.status, 200);
      assert.equal(locCache.size, 1);

      // 6. TTL expiry causes fresh upstream lookup
      nextMockMode = 'ok';
      nowMs += 61_000;
      const beforeCalls = upstreamCalls;
      const expiredRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=ponorogo&limit=5`
      );
      assert.equal(expiredRes.status, 200);
      assert.equal(upstreamCalls, beforeCalls + 1);

      // 7. Rate limit enforcement -> 429 without upstream call
      allowRateLimit = false;
      const preLimitCalls = upstreamCalls;
      const limitedRes = await fetch(
        `${baseUrl}/api/shipping/rajaongkir/locations?search=surabaya`
      );
      assert.equal(limitedRes.status, 429);
      assert.equal(upstreamCalls, preLimitCalls);
    }
  );

  // Also check searchRajaOngkirDestinationsWithCache metadata directly
  const directCache = new BoundedTtlCache<RajaOngkirDestinationOption[]>();
  const direct1 = await searchRajaOngkirDestinationsWithCache('ponorogo', {
    env: { RAJAONGKIR_API_KEY: secretKey },
    cache: directCache,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          meta: { code: 200, status: 'success' },
          data: [{ id: 31555, label: 'Ponorogo' }],
        }),
        { status: 200 }
      ),
  });
  assert.equal(direct1.cacheHit, false);
  const direct2 = await searchRajaOngkirDestinationsWithCache('PONOROGO', {
    env: { RAJAONGKIR_API_KEY: secretKey },
    cache: directCache,
    fetchImpl: async () => {
      throw new Error('Must serve from cache');
    },
  });
  assert.equal(direct2.cacheHit, true);
  assert.equal(direct2.destinations[0].id, 31555);
});

test('POST /api/shipping/rajaongkir/jnt-rates enforces server truth, caches safe identical quotes, validates stock/weight, falls back safely, and enforces rate limits', async () => {
  clearRajaOngkirCaches();
  const secretKey = 'ro-public-cost-secret-456';
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 20,
    defaultTtlMs: 60_000,
  });

  const storeProducts: Record<string, Record<string, unknown>> = {
    prod_1: {
      id: 'prod_1',
      name: 'Kopi Ponorogo',
      price: 25000,
      stock: 10,
      unit: 'pack',
      weightGrams: 500,
      cost: 17500,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      name: 'Madu Tanpa Berat',
      price: 40000,
      stock: 5,
      unit: 'botol',
    },
  };

  const fetchProductsByIds = async (
    ids: string[]
  ): Promise<ServerProductQuoteSnapshot[]> =>
    ids.map((id) => ({
      id,
      exists: Boolean(storeProducts[id]),
      data: storeProducts[id],
    }));

  let nowMs = 20_000_000;
  let upstreamCalls = 0;
  let allowRateLimit = true;
  let currentEnv: Record<string, string | undefined> = {};
  let costMode: 'ok' | 'empty' | 'error' | 'timeout' = 'ok';
  let lastFormSent = '';

  const mockFetch: typeof fetch = async (_url, init) => {
    upstreamCalls += 1;
    lastFormSent = String(init?.body || '');
    if (costMode === 'empty') {
      return new Response(
        JSON.stringify({ meta: { code: 200, status: 'success' }, data: [] }),
        { status: 200 }
      );
    }
    if (costMode === 'error') {
      return new Response(`Forbidden ${secretKey}`, { status: 403 });
    }
    if (costMode === 'timeout') {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(
      JSON.stringify({
        meta: { code: 200, status: 'success' },
        data: [
          {
            name: 'J&T Express',
            code: 'jnt',
            service: 'EZ',
            description: 'Reguler',
            cost: 19000,
            etd: '2-3 hari',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withTestHttpServer(
    (app) => {
      app.post(
        '/api/shipping/rajaongkir/jnt-rates',
        createRajaOngkirJntRatesHandler({
          env: new Proxy(
            {},
            {
              get: (_target, prop) =>
                typeof prop === 'string' ? currentEnv[prop] : undefined,
              ownKeys: () => Reflect.ownKeys(currentEnv),
              getOwnPropertyDescriptor: (_target, prop) =>
                typeof prop === 'string' && prop in currentEnv
                  ? {
                      enumerable: true,
                      configurable: true,
                      value: currentEnv[prop],
                    }
                  : undefined,
            }
          ) as Record<string, string | undefined>,
          fetchImpl: mockFetch,
          rateCache,
          now: () => nowMs,
          checkRateLimit: () => allowRateLimit,
          fetchProductsByIds,
        })
      );
    },
    async (baseUrl) => {
      const postQuote = (payload: unknown) =>
        fetch(`${baseUrl}/api/shipping/rajaongkir/jnt-rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

      // 1. Missing API key -> fallbackToManual without external fetch or caching
      const noKeyRes = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_1', quantity: 2 }],
      });
      assert.equal(noKeyRes.status, 200);
      const noKeyBody = (await noKeyRes.json()) as RajaOngkirJntCostResponse;
      assert.equal(noKeyBody.available, false);
      assert.equal(noKeyBody.fallbackToManual, true);
      assert.equal(noKeyBody.itemsSubtotal, 50000);
      assert.equal(upstreamCalls, 0);
      assert.equal(rateCache.size, 0);

      currentEnv = {
        RAJAONGKIR_API_KEY: secretKey,
        RAJAONGKIR_ORIGIN_ID: '31555',
      };

      // 2. Validation stops cleanly without calling external API
      assert.equal(
        (await postQuote({ destinationId: -1, items: [{ productId: 'prod_1', quantity: 1 }] }))
          .status,
        400
      );
      assert.equal(
        (await postQuote({ destinationId: 68423, items: [{ productId: 'missing', quantity: 1 }] }))
          .status,
        404
      );
      assert.equal(
        (await postQuote({ destinationId: 68423, items: [{ productId: 'prod_1', quantity: 99 }] }))
          .status,
        409
      );
      const unweighedRes = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_unweighed', quantity: 1 }],
      });
      assert.equal(unweighedRes.status, 200);
      assert.equal(((await unweighedRes.json()) as RajaOngkirJntCostResponse).fallbackToManual, true);
      assert.equal(upstreamCalls, 0);

      // 3. Valid quote ignores tampered browser fields, calls upstream once, and caches rate
      const okRes1 = await postQuote({
        destinationId: 68423,
        originId: 1,
        weightGrams: 1,
        itemsSubtotal: 100,
        shippingFee: 0,
        totalAmount: 100,
        courier: 'jne',
        items: [{ productId: 'prod_1', quantity: 2 }],
      });
      assert.equal(okRes1.status, 200);
      assert.equal(okRes1.headers.get('cache-control'), 'no-store');
      const okBody1 = (await okRes1.json()) as RajaOngkirJntCostResponse;
      assert.equal(okBody1.available, true);
      assert.equal(okBody1.fallbackToManual, false);
      assert.equal(okBody1.itemsSubtotal, 50000);
      assert.equal(okBody1.normalizedWeightGrams, 1000);
      assert.equal(okBody1.rates[0].cost, 19000);
      assert.equal(upstreamCalls, 1);
      assert.equal(rateCache.size, 1);
      const formParams = new URLSearchParams(lastFormSent);
      assert.equal(formParams.get('origin'), '31555');
      assert.equal(formParams.get('courier'), 'jnt');
      assert.equal(JSON.stringify(okBody1).includes(secretKey), false);
      assert.equal(JSON.stringify(okBody1).includes('17500'), false);

      // 4. Server product price changes -> cache hits J&T rate for identical weight/dest while returning fresh server subtotal!
      storeProducts.prod_1.price = 30000;
      const okRes2 = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_1', quantity: 2 }],
      });
      assert.equal(okRes2.status, 200);
      const okBody2 = (await okRes2.json()) as RajaOngkirJntCostResponse;
      assert.equal(okBody2.itemsSubtotal, 60000);
      assert.equal(okBody2.rates[0].cost, 19000);
      assert.equal(upstreamCalls, 1);

      // 5. Server product stock drops -> 409 immediately even if weight/dest rate was cached
      storeProducts.prod_1.stock = 1;
      const outOfStockRes = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_1', quantity: 2 }],
      });
      assert.equal(outOfStockRes.status, 409);
      assert.equal(upstreamCalls, 1);
      storeProducts.prod_1.stock = 10;

      // 6. Upstream empty/error/timeout -> fallbackToManual and NEVER cached
      costMode = 'empty';
      const emptyRateRes = await postQuote({
        destinationId: 70001,
        items: [{ productId: 'prod_1', quantity: 1 }],
      });
      assert.equal(emptyRateRes.status, 200);
      assert.equal(((await emptyRateRes.json()) as RajaOngkirJntCostResponse).fallbackToManual, true);
      assert.equal(rateCache.size, 1);

      costMode = 'error';
      const errRateRes = await postQuote({
        destinationId: 70002,
        items: [{ productId: 'prod_1', quantity: 1 }],
      });
      assert.equal(errRateRes.status, 200);
      const errRateBody = (await errRateRes.json()) as RajaOngkirJntCostResponse;
      assert.equal(errRateBody.fallbackToManual, true);
      assert.equal(JSON.stringify(errRateBody).includes(secretKey), false);
      assert.equal(rateCache.size, 1);

      costMode = 'timeout';
      const timeoutRateRes = await postQuote({
        destinationId: 70003,
        items: [{ productId: 'prod_1', quantity: 1 }],
      });
      assert.equal(timeoutRateRes.status, 200);
      assert.equal(((await timeoutRateRes.json()) as RajaOngkirJntCostResponse).fallbackToManual, true);
      assert.equal(rateCache.size, 1);

      // 7. TTL expires -> fetches fresh rate
      costMode = 'ok';
      nowMs += 61_000;
      const callsBeforeExpiry = upstreamCalls;
      const postExpiryRes = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_1', quantity: 2 }],
      });
      assert.equal(postExpiryRes.status, 200);
      assert.equal(upstreamCalls, callsBeforeExpiry + 1);

      // 8. Rate limit -> 429 before hitting upstream
      allowRateLimit = false;
      const callsBeforeLimit = upstreamCalls;
      const limitRes = await postQuote({
        destinationId: 68423,
        items: [{ productId: 'prod_1', quantity: 1 }],
      });
      assert.equal(limitRes.status, 429);
      assert.equal(upstreamCalls, callsBeforeLimit);
    }
  );
});
