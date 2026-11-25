import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  BoundedTtlCache,
  clearKiriminAjaCaches,
  createGuestOrdersHandler,
  createKiriminAjaJntRatesHandler,
  createKiriminAjaLocationsHandler,
  fetchKiriminAjaJntRates,
  fetchKiriminAjaLocations,
  getKiriminAjaConfigSummary,
  normalizeKiriminAjaPackageWeight,
  parseKiriminAjaLocationResponse,
  parseKiriminAjaShippingPriceResponse,
  parseShippingLocationSearchQuery,
  parseShippingRateQuoteRequest,
  quoteJntShippingRatesForStore,
  searchKiriminAjaLocationsWithCache,
  type GuestOrderStoreContext,
  type ServerProductQuoteSnapshot,
} from './server.ts';
import type {
  GuestOrder,
  JntRateOption,
  ShippingLocationOption,
  ShippingRateQuoteResponse,
} from './src/types/pos.ts';

test('getKiriminAjaConfigSummary defaults to sandbox, validates positive origin ID, and never exposes API key', () => {
  const unconfigured = getKiriminAjaConfigSummary({});
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.apiKeyPresent, false);
  assert.equal(unconfigured.baseUrl, 'https://tdev.kiriminaja.com');
  assert.equal(unconfigured.isSandbox, true);
  assert.equal(unconfigured.originDistrictId, null);
  assert.equal(unconfigured.timeoutMs, 8000);
  assert.deepEqual(unconfigured.missingFields, [
    'KIRIMINAJA_API_KEY',
    'KIRIMINAJA_ORIGIN_DISTRICT_ID',
  ]);

  const valid = getKiriminAjaConfigSummary({
    KIRIMINAJA_API_KEY: 'dummy-test-token-do-not-leak',
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
    KIRIMINAJA_TIMEOUT_MS: '50000',
  });
  assert.equal(valid.configured, true);
  assert.equal(valid.apiKeyPresent, true);
  assert.equal(valid.baseUrl, 'https://tdev.kiriminaja.com');
  assert.equal(valid.isSandbox, true);
  assert.equal(valid.originDistrictId, 5783);
  assert.equal(valid.timeoutMs, 20000);
  assert.deepEqual(valid.missingFields, []);
  assert.equal(
    JSON.stringify(valid).includes('dummy-test-token-do-not-leak'),
    false
  );

  const badOrigin = getKiriminAjaConfigSummary({
    KIRIMINAJA_API_KEY: 'dummy-test-token',
    KIRIMINAJA_ORIGIN_DISTRICT_ID: 'ponorogo-123',
    KIRIMINAJA_TIMEOUT_MS: '200',
  });
  assert.equal(badOrigin.configured, false);
  assert.equal(badOrigin.originDistrictId, null);
  assert.equal(badOrigin.timeoutMs, 1000);
  assert.ok(badOrigin.missingFields.includes('KIRIMINAJA_ORIGIN_DISTRICT_ID'));
});

test('normalizeKiriminAjaPackageWeight computes integer gram weight rounded up and flags unweighed items safely', () => {
  const weighed = normalizeKiriminAjaPackageWeight([
    { productId: 'p1', weightGrams: 150.2, quantity: 2 },
    { productId: 'p2', weightGrams: 50.1, quantity: 1 },
  ]);
  assert.equal(weighed.totalWeightGrams, 350.5);
  assert.equal(weighed.normalizedWeightGrams, 351);
  assert.equal(weighed.hasUnweighedItems, false);
  assert.equal(weighed.allItemsUnweighed, false);
  assert.deepEqual(weighed.unweighedProductIds, []);
  assert.equal(weighed.canCalculateAutomaticRate, true);

  const tinyFraction = normalizeKiriminAjaPackageWeight([
    { productId: 'p_tiny', weightGrams: 0.4, quantity: 1 },
  ]);
  assert.equal(tinyFraction.normalizedWeightGrams, 1);
  assert.equal(tinyFraction.canCalculateAutomaticRate, true);

  const partialUnweighed = normalizeKiriminAjaPackageWeight([
    { productId: 'p1', weightGrams: 200, quantity: 2 },
    { productId: 'p_missing', weightGrams: undefined, quantity: 1 },
    { productId: 'p_zero', weightGrams: 0, quantity: 1 },
  ]);
  assert.equal(partialUnweighed.totalWeightGrams, 400);
  assert.equal(partialUnweighed.normalizedWeightGrams, 400);
  assert.equal(partialUnweighed.hasUnweighedItems, true);
  assert.equal(partialUnweighed.allItemsUnweighed, false);
  assert.deepEqual(partialUnweighed.unweighedProductIds, ['p_missing', 'p_zero']);
  assert.equal(partialUnweighed.canCalculateAutomaticRate, false);

  const noneWeighed = normalizeKiriminAjaPackageWeight([
    { productId: 'p_none', weightGrams: null, quantity: 3 },
  ]);
  assert.equal(noneWeighed.totalWeightGrams, 0);
  assert.equal(noneWeighed.normalizedWeightGrams, null);
  assert.equal(noneWeighed.hasUnweighedItems, true);
  assert.equal(noneWeighed.allItemsUnweighed, true);
  assert.equal(noneWeighed.canCalculateAutomaticRate, false);

  assert.throws(() =>
    normalizeKiriminAjaPackageWeight([
      { productId: 'p_bad_qty', weightGrams: 100, quantity: 0 },
    ])
  );
});

test('parseKiriminAjaShippingPriceResponse filters J&T rates defensively and sorts ascending by cost', () => {
  const parsed = parseKiriminAjaShippingPriceResponse({
    status: true,
    code: 200,
    results: [
      {
        code: 'jne',
        name: 'JNE',
        service: 'REG',
        cost: 12000,
        etd: '2-3',
      },
      {
        code: 'jnt',
        name: 'J&T Express',
        service: 'jsd',
        service_name: 'J&T Super',
        description: 'Same Day',
        cost: 28000,
        etd: '1',
        cod: false,
      },
      {
        code: 'jnt',
        name: 'J&T Express',
        service: 'ez',
        service_name: 'J&T EZ',
        description: 'Reguler Service',
        cost: 15000,
        etd: '2-3',
        cod: true,
      },
      {
        code: 'jnt',
        service: 'BROKEN',
        cost: -500,
      },
    ],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.rates.length, 2);
  assert.deepEqual(parsed.rates[0], {
    courier: 'jnt',
    courierName: 'J&T Express',
    serviceCode: 'EZ',
    serviceName: 'J&T EZ',
    description: 'Reguler Service',
    cost: 15000,
    etd: '2-3',
    cod: true,
  });
  assert.equal(parsed.rates[1].serviceCode, 'JSD');
  assert.equal(parsed.rates[1].cost, 28000);

  assert.deepEqual(parseKiriminAjaShippingPriceResponse({ status: false }), {
    ok: false,
    rates: [],
  });
  assert.deepEqual(parseKiriminAjaShippingPriceResponse(null), {
    ok: false,
    rates: [],
  });
});

test('fetchKiriminAjaJntRates validates missing key, missing origin, invalid destination, invalid weight, and invalid item value without calling fetch', async () => {
  let fetchCalled = false;
  const spyFetch: typeof fetch = async () => {
    fetchCalled = true;
    throw new Error('Should not be called');
  };

  const noKey = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: 50000 },
    { env: { KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783' }, fetchImpl: spyFetch }
  );
  assert.equal(fetchCalled, false);
  assert.equal(noKey.ok, false);
  assert.equal(noKey.fallbackToManual, true);
  assert.equal(noKey.code, 'KIRIMINAJA_API_KEY_MISSING');

  const noOrigin = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: 50000 },
    { env: { KIRIMINAJA_API_KEY: 'test-key-xyz' }, fetchImpl: spyFetch }
  );
  assert.equal(fetchCalled, false);
  assert.equal(noOrigin.ok, false);
  assert.equal(noOrigin.fallbackToManual, true);
  assert.equal(noOrigin.code, 'KIRIMINAJA_ORIGIN_MISSING');

  const validEnv = {
    KIRIMINAJA_API_KEY: 'test-key-xyz',
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
  };

  const badDest = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 0, weightGrams: 500, itemValue: 50000 },
    { env: validEnv, fetchImpl: spyFetch }
  );
  assert.equal(fetchCalled, false);
  assert.equal(badDest.ok, false);
  assert.equal(badDest.code, 'INVALID_DESTINATION_DISTRICT');

  const badWeight = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: -10, itemValue: 50000 },
    { env: validEnv, fetchImpl: spyFetch }
  );
  assert.equal(fetchCalled, false);
  assert.equal(badWeight.ok, false);
  assert.equal(badWeight.code, 'INVALID_PACKAGE_WEIGHT');

  const badValue = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: -100 },
    { env: validEnv, fetchImpl: spyFetch }
  );
  assert.equal(fetchCalled, false);
  assert.equal(badValue.ok, false);
  assert.equal(badValue.code, 'INVALID_ITEM_VALUE');
});

test('fetchKiriminAjaJntRates posts valid KiriminAja v6.1 request and handles success, empty rates, HTTP errors, and timeouts safely', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  const okFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'ez',
            service_name: 'EZ',
            cost: 14000,
            etd: '2-3',
            cod: true,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const secretToken = 'secret-sandbox-token-value';
  const success = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 351, itemValue: 149990.4 },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: okFetch,
    }
  );

  assert.equal(
    capturedUrl,
    'https://tdev.kiriminaja.com/api/mitra/v6.1/shipping_price'
  );
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${secretToken}`);
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(capturedInit?.signal instanceof AbortSignal);

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    origin: 5783,
    destination: 5507,
    weight: 351,
    item_value: 149990,
    courier: ['jnt'],
  });
  assert.equal(success.ok, true);
  assert.equal(success.available, true);
  assert.equal(success.fallbackToManual, false);
  assert.equal(success.rates[0].serviceCode, 'EZ');
  assert.equal(success.rates[0].cost, 14000);

  // Empty rates -> graceful fallback
  const emptyRes = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: 50000 },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: true, results: [] }), { status: 200 }),
    }
  );
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.available, false);
  assert.equal(emptyRes.fallbackToManual, true);
  assert.equal(emptyRes.code, 'JNT_RATE_NOT_AVAILABLE');

  // Upstream HTTP 500 -> never leaks upstream text or secret token
  const httpErr = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: 50000 },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () =>
        new Response(`Upstream failure with ${secretToken}`, { status: 500 }),
    }
  );
  assert.equal(httpErr.ok, false);
  assert.equal(httpErr.fallbackToManual, true);
  assert.equal(httpErr.code, 'KIRIMINAJA_HTTP_ERROR');
  assert.equal(JSON.stringify(httpErr).includes(secretToken), false);
  assert.equal(httpErr.message.includes('Upstream failure'), false);

  // Timeout error -> safe timeout fallback
  const timeoutErr = await fetchKiriminAjaJntRates(
    { destinationDistrictId: 5507, weightGrams: 500, itemValue: 50000 },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () => {
        const err = new Error('The operation timed out');
        err.name = 'TimeoutError';
        throw err;
      },
    }
  );
  assert.equal(timeoutErr.ok, false);
  assert.equal(timeoutErr.fallbackToManual, true);
  assert.equal(timeoutErr.code, 'KIRIMINAJA_TIMEOUT');
});

// ============================================================================
// Stage 2 Tests: Location Search Proxy & Server-Validated J&T Rate Quote
// ============================================================================
test('parseShippingLocationSearchQuery rejects invalid queries and normalizes valid ones', () => {
  assert.deepEqual(parseShippingLocationSearchQuery('  ponorogo  jawa '), {
    ok: true,
    query: 'ponorogo jawa',
  });

  for (const badQuery of [
    undefined,
    null,
    123,
    '',
    'ab',
    'a'.repeat(61),
    '<script>alert(1)</script>',
    'ponorogo?foo=bar',
  ]) {
    const res = parseShippingLocationSearchQuery(badQuery);
    assert.equal(res.ok, false);
  }
});

test('parseKiriminAjaLocationResponse caps results, deduplicates, and rejects invalid payloads', () => {
  assert.deepEqual(parseKiriminAjaLocationResponse(null), {
    ok: false,
    locations: [],
  });
  assert.deepEqual(parseKiriminAjaLocationResponse({ status: false, data: [] }), {
    ok: false,
    locations: [],
  });
  assert.deepEqual(parseKiriminAjaLocationResponse({ status: true, data: 'bad' }), {
    ok: false,
    locations: [],
  });

  const manyItems = Array.from({ length: 25 }, (_, i) => ({
    district_id: 5500 + i,
    district_name: `Kecamatan ${i}`,
    city_name: 'Ponorogo',
    province_name: 'Jawa Timur',
    postal_code: '63411',
  }));
  const parsed = parseKiriminAjaLocationResponse({
    status: true,
    data: [
      { district_id: -5, district_name: 'Invalid' },
      ...manyItems,
      { district_id: 5500, district_name: 'Duplicate' },
    ],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.locations.length, 20);
  assert.equal(parsed.locations[0].districtId, 5500);
  assert.equal(
    parsed.locations[0].label,
    'Kecamatan 0, Ponorogo, Jawa Timur'
  );
});

test('fetchKiriminAjaLocations handles unconfigured path/key, valid query, empty result, invalid upstream, HTTP error, and timeout without leaking secrets', async () => {
  let called = false;
  const spyFetch: typeof fetch = async () => {
    called = true;
    throw new Error('Should not be called');
  };

  // Missing API key -> no HTTP request
  const noKey = await fetchKiriminAjaLocations('ponorogo', {
    env: { KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/test-path' },
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'KIRIMINAJA_API_KEY_MISSING');

  // Unconfigured location path -> never guesses upstream endpoint
  const secretToken = 'secret-loc-token-999';
  const noPath = await fetchKiriminAjaLocations('ponorogo', {
    env: { KIRIMINAJA_API_KEY: secretToken },
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(noPath.ok, false);
  assert.equal(noPath.code, 'KIRIMINAJA_LOCATION_ENDPOINT_UNCONFIGURED');

  // SSRF / path traversal attempt in env path -> blocked without calling fetch
  const badPath = await fetchKiriminAjaLocations('ponorogo', {
    env: {
      KIRIMINAJA_API_KEY: secretToken,
      KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/../../etc/passwd',
    },
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(badPath.ok, false);
  assert.equal(badPath.code, 'KIRIMINAJA_LOCATION_ENDPOINT_INVALID');

  const validEnv = {
    KIRIMINAJA_API_KEY: secretToken,
    KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/mock_locations_endpoint',
    KIRIMINAJA_LOCATION_SEARCH_METHOD: 'GET',
  };

  // Invalid query -> no HTTP request
  const badQueryRes = await fetchKiriminAjaLocations('ab', {
    env: validEnv,
    fetchImpl: spyFetch,
  });
  assert.equal(called, false);
  assert.equal(badQueryRes.ok, false);
  assert.equal(badQueryRes.code, 'INVALID_LOCATION_QUERY');

  // Valid query -> parses locations cleanly
  let requestedUrl = '';
  let sentAuth = '';
  const okLoc = await fetchKiriminAjaLocations('babadan', {
    env: validEnv,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      sentAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            {
              district_id: 5783,
              district_name: 'Babadan',
              city_name: 'Ponorogo',
              province_name: 'Jawa Timur',
              postal_code: '63491',
            },
          ],
        }),
        { status: 200 }
      );
    },
  });
  assert.equal(
    requestedUrl,
    'https://tdev.kiriminaja.com/api/mitra/mock_locations_endpoint?search=babadan'
  );
  assert.equal(sentAuth, `Bearer ${secretToken}`);
  assert.equal(okLoc.ok, true);
  assert.equal(okLoc.available, true);
  assert.equal(okLoc.locations.length, 1);
  assert.equal(okLoc.locations[0].districtId, 5783);
  assert.equal(JSON.stringify(okLoc).includes(secretToken), false);

  // Empty locations -> LOCATIONS_EMPTY
  const emptyLoc = await fetchKiriminAjaLocations('zzzzzz', {
    env: validEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: true, data: [] }), { status: 200 }),
  });
  assert.equal(emptyLoc.ok, true);
  assert.equal(emptyLoc.available, true);
  assert.equal(emptyLoc.code, 'LOCATIONS_EMPTY');
  assert.deepEqual(emptyLoc.locations, []);

  // Invalid upstream JSON -> KIRIMINAJA_INVALID_RESPONSE
  const invalidUpstream = await fetchKiriminAjaLocations('ponorogo', {
    env: validEnv,
    fetchImpl: async () => new Response('not-json', { status: 200 }),
  });
  assert.equal(invalidUpstream.ok, false);
  assert.equal(invalidUpstream.code, 'KIRIMINAJA_INVALID_RESPONSE');

  // HTTP 500 -> never leaks token or raw body
  const httpErr = await fetchKiriminAjaLocations('ponorogo', {
    env: validEnv,
    fetchImpl: async () =>
      new Response(`Internal Error ${secretToken}`, { status: 500 }),
  });
  assert.equal(httpErr.ok, false);
  assert.equal(httpErr.code, 'KIRIMINAJA_HTTP_ERROR');
  assert.equal(JSON.stringify(httpErr).includes(secretToken), false);

  // Timeout -> KIRIMINAJA_TIMEOUT
  const timeoutLoc = await fetchKiriminAjaLocations('ponorogo', {
    env: validEnv,
    fetchImpl: async () => {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.equal(timeoutLoc.ok, false);
  assert.equal(timeoutLoc.code, 'KIRIMINAJA_TIMEOUT');
});

test('parseShippingRateQuoteRequest validates destinationDistrictId and items strictly', () => {
  const valid = parseShippingRateQuoteRequest({
    destinationDistrictId: 5507,
    items: [
      { productId: 'prod_1', quantity: 2 },
      { productId: 'prod_1', quantity: 1 },
    ],
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.destinationDistrictId, 5507);
    assert.deepEqual(valid.items, [{ productId: 'prod_1', quantity: 3 }]);
  }

  for (const badDest of [0, -1, 'abc', null, undefined, 12.5]) {
    const res = parseShippingRateQuoteRequest({
      destinationDistrictId: badDest,
      items: [{ productId: 'prod_1', quantity: 1 }],
    });
    assert.equal(res.ok, false);
  }

  const emptyItems = parseShippingRateQuoteRequest({
    destinationDistrictId: 5507,
    items: [],
  });
  assert.equal(emptyItems.ok, false);
});

test('quoteJntShippingRatesForStore computes authoritative weight & item_value from server products and handles fallback cases safely', async () => {
  const mockStoreProducts: Record<string, Record<string, unknown>> = {
    prod_weighed_1: {
      id: 'prod_weighed_1',
      name: 'Kopi Tubruk',
      price: 25000,
      stock: 10,
      unit: 'pack',
      weightGrams: 200.4,
      cost: 15000,
    },
    prod_weighed_2: {
      id: 'prod_weighed_2',
      name: 'Gula Aren',
      price: 15000,
      stock: 5,
      unit: 'botol',
      weightGrams: 300,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      name: 'Roti Baru',
      price: 12000,
      stock: 8,
      unit: 'pcs',
    },
  };

  const fetchProductsByIds = async (
    productIds: string[]
  ): Promise<ServerProductQuoteSnapshot[]> =>
    productIds.map((id) => ({
      id,
      exists: Boolean(mockStoreProducts[id]),
      data: mockStoreProducts[id],
    }));

  const secretToken = 'secret-quote-token-777';
  let capturedRequestBody: Record<string, unknown> | null = null;

  // 1. Success case: ignores tampered browser weight/itemValue/origin/shippingFee and uses server product truth
  const successQuote = await quoteJntShippingRatesForStore(
    fetchProductsByIds,
    {
      destinationDistrictId: 5507,
      // Attempted client tampering (must be ignored by server):
      weight: 1,
      weightGrams: 1,
      itemValue: 1,
      item_value: 1,
      originDistrictId: 99999,
      shippingFee: 0,
      items: [
        { productId: 'prod_weighed_1', quantity: 2 }, // 2*25000=50000, 2*200.4=400.8g
        { productId: 'prod_weighed_2', quantity: 1 }, // 1*15000=15000, 1*300=300g -> total 700.8g -> ceil 701g
      ],
    },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async (_url, init) => {
        capturedRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            status: true,
            results: [
              {
                code: 'jnt',
                name: 'J&T Express',
                service: 'EZ',
                service_name: 'Reguler',
                cost: 16000,
                etd: '2-3',
              },
            ],
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(successQuote.statusCode, 200);
  assert.deepEqual(capturedRequestBody, {
    origin: 5783,
    destination: 5507,
    weight: 701,
    item_value: 65000,
    courier: ['jnt'],
  });
  assert.equal('error' in successQuote.body, false);
  if (!('error' in successQuote.body)) {
    assert.equal(successQuote.body.available, true);
    assert.equal(successQuote.body.fallbackToManual, false);
    assert.equal(successQuote.body.totalWeightGrams, 700.8);
    assert.equal(successQuote.body.normalizedWeightGrams, 701);
    assert.equal(successQuote.body.itemsSubtotal, 65000);
    assert.equal(successQuote.body.rates[0].cost, 16000);
    assert.equal(JSON.stringify(successQuote.body).includes(secretToken), false);
    assert.equal(JSON.stringify(successQuote.body).includes('15000'), false); // owner cost excluded
  }

  // 2. Unweighed product -> never calls KiriminAja, returns manual fallback
  let externalCalled = false;
  const unweighedQuote = await quoteJntShippingRatesForStore(
    fetchProductsByIds,
    {
      destinationDistrictId: 5507,
      items: [
        { productId: 'prod_weighed_1', quantity: 1 },
        { productId: 'prod_unweighed', quantity: 1 },
      ],
    },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () => {
        externalCalled = true;
        throw new Error('Should not call external API when unweighed items exist');
      },
    }
  );
  assert.equal(externalCalled, false);
  assert.equal(unweighedQuote.statusCode, 200);
  if (!('error' in unweighedQuote.body)) {
    assert.equal(unweighedQuote.body.available, false);
    assert.equal(unweighedQuote.body.fallbackToManual, true);
    assert.equal(unweighedQuote.body.hasUnweighedItems, true);
    assert.equal(unweighedQuote.body.itemsSubtotal, 37000);
    assert.deepEqual(unweighedQuote.body.rates, []);
  }

  // 3. Missing API key -> skips fetch and falls back safely
  const missingKeyQuote = await quoteJntShippingRatesForStore(
    fetchProductsByIds,
    {
      destinationDistrictId: 5507,
      items: [{ productId: 'prod_weighed_1', quantity: 1 }],
    },
    {
      env: { KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783' },
      fetchImpl: async () => {
        externalCalled = true;
        throw new Error('Should not call external API without key');
      },
    }
  );
  assert.equal(externalCalled, false);
  assert.equal(missingKeyQuote.statusCode, 200);
  if (!('error' in missingKeyQuote.body)) {
    assert.equal(missingKeyQuote.body.available, false);
    assert.equal(missingKeyQuote.body.fallbackToManual, true);
  }

  // 4. Empty rates from KiriminAja -> fallbackToManual: true
  const emptyRatesQuote = await quoteJntShippingRatesForStore(
    fetchProductsByIds,
    {
      destinationDistrictId: 5507,
      items: [{ productId: 'prod_weighed_1', quantity: 1 }],
    },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: true, results: [] }), { status: 200 }),
    }
  );
  assert.equal(emptyRatesQuote.statusCode, 200);
  if (!('error' in emptyRatesQuote.body)) {
    assert.equal(emptyRatesQuote.body.available, false);
    assert.equal(emptyRatesQuote.body.fallbackToManual, true);
    assert.deepEqual(emptyRatesQuote.body.rates, []);
  }

  // 5. Timeout / upstream error -> fallbackToManual: true without leaking secret
  const failedUpstreamQuote = await quoteJntShippingRatesForStore(
    fetchProductsByIds,
    {
      destinationDistrictId: 5507,
      items: [{ productId: 'prod_weighed_1', quantity: 1 }],
    },
    {
      env: {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      },
      fetchImpl: async () =>
        new Response(`Forbidden ${secretToken}`, { status: 401 }),
    }
  );
  assert.equal(failedUpstreamQuote.statusCode, 200);
  if (!('error' in failedUpstreamQuote.body)) {
    assert.equal(failedUpstreamQuote.body.available, false);
    assert.equal(failedUpstreamQuote.body.fallbackToManual, true);
    assert.equal(
      JSON.stringify(failedUpstreamQuote.body).includes(secretToken),
      false
    );
  }
});

// ============================================================================
// Stage 4 Tests: Hardened KiriminAja Public Express Endpoints & TTL Caches
// ============================================================================
async function withKiriminAjaTestServer(
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

test('GET /api/shipping/locations hardens validation, enforces Cache-Control: no-store, caches normalized valid results up to 1h, and blocks errors/empty config from cache', async () => {
  clearKiriminAjaCaches();
  const secretToken = 'ka-stage4-loc-secret-123';
  const locCache = new BoundedTtlCache<ShippingLocationOption[]>({
    maxEntries: 200,
    defaultTtlMs: 60 * 60 * 1000,
  });

  let nowMs = 100_000_000;
  let upstreamCalls = 0;
  let allowRateLimit = true;
  let currentEnv: Record<string, string | undefined> = {};
  let mode: 'ok' | 'empty' | 'error' | 'invalid' | 'timeout' = 'ok';

  const envProxy = new Proxy(
    {},
    {
      get: (_target, prop) => (typeof prop === 'string' ? currentEnv[prop] : undefined),
      ownKeys: () => Reflect.ownKeys(currentEnv),
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop in currentEnv
          ? { enumerable: true, configurable: true, value: currentEnv[prop] }
          : undefined,
    }
  ) as Record<string, string | undefined>;

  const mockFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    if (mode === 'empty') {
      return new Response(JSON.stringify({ status: true, data: [] }), { status: 200 });
    }
    if (mode === 'error') {
      return new Response(`Upstream error ${secretToken}`, { status: 500 });
    }
    if (mode === 'invalid') {
      return new Response('<html>bad-gateway</html>', { status: 200 });
    }
    if (mode === 'timeout') {
      const err = new Error(`Timed out using ${secretToken}`);
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(
      JSON.stringify({
        status: true,
        data: [
          {
            district_id: 5783,
            district_name: 'Babadan',
            city_name: 'Ponorogo',
            province_name: 'Jawa Timur',
            postal_code: '63491',
          },
          {
            district_id: 5784,
            district_name: 'Jenangan',
            city_name: 'Ponorogo',
            province_name: 'Jawa Timur',
            postal_code: '63492',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withKiriminAjaTestServer(
    (app) => {
      app.get(
        '/api/shipping/locations',
        createKiriminAjaLocationsHandler({
          env: envProxy,
          fetchImpl: mockFetch,
          cache: locCache,
          cacheTtlMs: 24 * 60 * 60 * 1000, // must clamp at 1 hour max
          now: () => nowMs,
          checkRateLimit: () => allowRateLimit,
        })
      );
    },
    async (baseUrl) => {
      // 1. Missing API key / unconfigured path -> 200 fallback, no external fetch, no-store, not cached
      const noKeyRes = await fetch(`${baseUrl}/api/shipping/locations?search=ponorogo`);
      assert.equal(noKeyRes.status, 200);
      assert.equal(noKeyRes.headers.get('cache-control'), 'no-store');
      const noKeyJson = (await noKeyRes.json()) as {
        available: boolean;
        locations: unknown[];
      };
      assert.equal(noKeyJson.available, false);
      assert.deepEqual(noKeyJson.locations, []);
      assert.equal(upstreamCalls, 0);
      assert.equal(locCache.size, 0);

      currentEnv = {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/v2/locations',
        KIRIMINAJA_LOCATION_SEARCH_METHOD: 'GET',
      };

      // 2. Invalid query & invalid limit -> HTTP 400 with Cache-Control: no-store
      for (const badPath of [
        '/api/shipping/locations?search=ab',
        '/api/shipping/locations?search=%3Cscript%3E',
        '/api/shipping/locations?search=ponorogo&limit=0',
        '/api/shipping/locations?search=ponorogo&limit=abc',
      ]) {
        const badRes = await fetch(`${baseUrl}${badPath}`);
        assert.equal(badRes.status, 400);
        assert.equal(badRes.headers.get('cache-control'), 'no-store');
      }
      assert.equal(upstreamCalls, 0);

      // 3. Valid search -> calls upstream once, respects limit=1, caches valid entry, never exposes key
      const ok1 = await fetch(`${baseUrl}/api/shipping/locations?search=ponorogo&limit=1`);
      assert.equal(ok1.status, 200);
      assert.equal(ok1.headers.get('cache-control'), 'no-store');
      const okJson1 = (await ok1.json()) as {
        available: boolean;
        locations: ShippingLocationOption[];
      };
      assert.equal(okJson1.available, true);
      assert.equal(okJson1.locations.length, 1);
      assert.equal(okJson1.locations[0].districtId, 5783);
      assert.equal(JSON.stringify(okJson1).includes(secretToken), false);
      assert.equal(upstreamCalls, 1);
      assert.equal(locCache.size, 1);

      // 4. Case/whitespace-normalized same key -> cache hit
      const ok2 = await fetch(
        `${baseUrl}/api/shipping/locations?search=%20PONOROGO%20&limit=1`
      );
      assert.equal(ok2.status, 200);
      assert.equal(upstreamCalls, 1);

      // 5. Different limit/method/path/baseUrl -> separate cache key
      const diffLimit = await fetch(
        `${baseUrl}/api/shipping/locations?search=ponorogo&limit=2`
      );
      assert.equal(diffLimit.status, 200);
      const diffLimitJson = (await diffLimit.json()) as {
        locations: ShippingLocationOption[];
      };
      assert.equal(diffLimitJson.locations.length, 2);
      assert.equal(upstreamCalls, 2);
      assert.equal(locCache.size, 2);

      // 6. Errors, timeouts, invalid JSON, empty results are NEVER cached and never leak secret
      for (const errCase of [
        ['empty', 'kosong'],
        ['error', 'madiun'],
        ['invalid', 'ngawi'],
        ['timeout', 'magetan'],
      ] as const) {
        mode = errCase[0];
        const res = await fetch(
          `${baseUrl}/api/shipping/locations?search=${errCase[1]}`
        );
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(JSON.stringify(body).includes(secretToken), false);
        assert.equal(locCache.size, 2);
      }

      // 7. Max 1 hour TTL clamp check (even though cacheTtlMs was 24h, after 61m entry expires)
      mode = 'ok';
      nowMs += 61 * 60 * 1000;
      const callsBeforeExpiry = upstreamCalls;
      const postExpiry = await fetch(
        `${baseUrl}/api/shipping/locations?search=ponorogo&limit=1`
      );
      assert.equal(postExpiry.status, 200);
      assert.equal(upstreamCalls, callsBeforeExpiry + 1);

      // 8. Rate limiter -> HTTP 429 with Cache-Control: no-store without external fetch
      allowRateLimit = false;
      const callsBeforeLimit = upstreamCalls;
      const limitedRes = await fetch(
        `${baseUrl}/api/shipping/locations?search=surabaya`
      );
      assert.equal(limitedRes.status, 429);
      assert.equal(limitedRes.headers.get('cache-control'), 'no-store');
      assert.equal(upstreamCalls, callsBeforeLimit);
    }
  );

  // Direct helper check for method/path key separation
  const helperCache = new BoundedTtlCache<ShippingLocationOption[]>();
  const getHit = await searchKiriminAjaLocationsWithCache('ponorogo', {
    env: {
      KIRIMINAJA_API_KEY: secretToken,
      KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/loc_a',
      KIRIMINAJA_LOCATION_SEARCH_METHOD: 'GET',
    },
    cache: helperCache,
    fetchImpl: mockFetch,
  });
  assert.equal(getHit.cacheHit, false);

  const postMiss = await searchKiriminAjaLocationsWithCache('ponorogo', {
    env: {
      KIRIMINAJA_API_KEY: secretToken,
      KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/loc_a',
      KIRIMINAJA_LOCATION_SEARCH_METHOD: 'POST',
    },
    cache: helperCache,
    fetchImpl: mockFetch,
  });
  assert.equal(postMiss.cacheHit, false);
});

test('POST /api/shipping/jnt-rates hardens validation (400/404/409/429), revalidates Firestore product/stock/price before cache, enforces 10m TTL, and blocks secrets', async () => {
  clearKiriminAjaCaches();
  const secretToken = 'ka-stage4-rate-secret-999';
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const storeProducts: Record<string, Record<string, unknown>> = {
    prod_ok: {
      id: 'prod_ok',
      name: 'Beras Organik',
      price: 50000,
      stock: 10,
      unit: 'kg',
      weightGrams: 1000,
      cost: 38000,
      isActive: true,
    },
    prod_inactive: {
      id: 'prod_inactive',
      name: 'Produk Nonaktif',
      price: 20000,
      stock: 10,
      unit: 'pcs',
      weightGrams: 250,
      isActive: false,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      name: 'Produk Tanpa Berat',
      price: 15000,
      stock: 10,
      unit: 'pcs',
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

  let nowMs = 200_000_000;
  let upstreamCalls = 0;
  let allowRateLimit = true;
  let currentEnv: Record<string, string | undefined> = {};
  let mode: 'ok' | 'empty' | 'error' | 'invalid' | 'timeout' = 'ok';
  let lastPayloadSent: Record<string, unknown> | null = null;

  const envProxy = new Proxy(
    {},
    {
      get: (_target, prop) => (typeof prop === 'string' ? currentEnv[prop] : undefined),
      ownKeys: () => Reflect.ownKeys(currentEnv),
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop in currentEnv
          ? { enumerable: true, configurable: true, value: currentEnv[prop] }
          : undefined,
    }
  ) as Record<string, string | undefined>;

  const mockFetch: typeof fetch = async (_url, init) => {
    upstreamCalls += 1;
    lastPayloadSent = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    if (mode === 'empty') {
      return new Response(JSON.stringify({ status: true, results: [] }), {
        status: 200,
      });
    }
    if (mode === 'error') {
      return new Response(`Unauthorized ${secretToken}`, { status: 401 });
    }
    if (mode === 'invalid') {
      return new Response('invalid-json', { status: 200 });
    }
    if (mode === 'timeout') {
      const err = new Error(`Socket timeout ${secretToken}`);
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'EZ',
            service_name: 'Reguler',
            cost: 18000,
            etd: '2-3',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withKiriminAjaTestServer(
    (app) => {
      app.post(
        '/api/shipping/jnt-rates',
        createKiriminAjaJntRatesHandler({
          env: envProxy,
          fetchImpl: mockFetch,
          rateCache,
          rateCacheTtlMs: 60 * 60 * 1000, // must clamp at 10 minutes max
          now: () => nowMs,
          checkRateLimit: () => allowRateLimit,
          fetchProductsByIds,
        })
      );
    },
    async (baseUrl) => {
      const postRates = (payload: unknown) =>
        fetch(`${baseUrl}/api/shipping/jnt-rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

      // 1. Missing API key / origin -> 200 manual fallback, no external fetch, not cached
      const noKey = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 1 }],
      });
      assert.equal(noKey.status, 200);
      assert.equal(noKey.headers.get('cache-control'), 'no-store');
      const noKeyBody = (await noKey.json()) as ShippingRateQuoteResponse;
      assert.equal(noKeyBody.available, false);
      assert.equal(noKeyBody.fallbackToManual, true);
      assert.equal(upstreamCalls, 0);
      assert.equal(rateCache.size, 0);

      currentEnv = {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
      };

      // 2. Invalid inputs -> HTTP 400 with Cache-Control: no-store
      for (const badBody of [
        [],
        { destinationDistrictId: -1, items: [{ productId: 'prod_ok', quantity: 1 }] },
        { destinationDistrictId: 5507, items: [] },
        { destinationDistrictId: 5507, items: [{ productId: 'bad id!', quantity: 1 }] },
        { destinationDistrictId: 5507, items: [{ productId: 'prod_ok', quantity: 0 }] },
      ]) {
        const res = await postRates(badBody);
        assert.equal(res.status, 400);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }

      // 3. Missing or inactive product -> HTTP 404 with Cache-Control: no-store
      for (const prodId of ['prod_does_not_exist', 'prod_inactive']) {
        const res = await postRates({
          destinationDistrictId: 5507,
          items: [{ productId: prodId, quantity: 1 }],
        });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }

      // 4. Insufficient stock -> HTTP 409 with Cache-Control: no-store
      const stockRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 15 }],
      });
      assert.equal(stockRes.status, 409);
      assert.equal(stockRes.headers.get('cache-control'), 'no-store');

      // 5. Unweighed item -> manual fallback without external fetch or caching
      const unweighedRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_unweighed', quantity: 1 }],
      });
      assert.equal(unweighedRes.status, 200);
      assert.equal(((await unweighedRes.json()) as ShippingRateQuoteResponse).fallbackToManual, true);
      assert.equal(upstreamCalls, 0);
      assert.equal(rateCache.size, 0);

      // 6. Valid request ignores tampered browser fields, calls KiriminAja once, and caches rate
      const ok1 = await postRates({
        destinationDistrictId: 5507,
        originDistrictId: 1,
        weightGrams: 1,
        itemsSubtotal: 1,
        shippingFee: 0,
        stock: 999,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(ok1.status, 200);
      assert.equal(ok1.headers.get('cache-control'), 'no-store');
      const ok1Body = (await ok1.json()) as ShippingRateQuoteResponse;
      assert.equal(ok1Body.available, true);
      assert.equal(ok1Body.fallbackToManual, false);
      assert.equal(ok1Body.itemsSubtotal, 100000);
      assert.equal(ok1Body.normalizedWeightGrams, 2000);
      assert.equal(ok1Body.rates[0].cost, 18000);
      assert.deepEqual(lastPayloadSent, {
        origin: 5783,
        destination: 5507,
        weight: 2000,
        item_value: 100000,
        courier: ['jnt'],
      });
      assert.equal(JSON.stringify(ok1Body).includes(secretToken), false);
      assert.equal(JSON.stringify(ok1Body).includes('38000'), false);
      assert.equal(upstreamCalls, 1);
      assert.equal(rateCache.size, 1);

      // 7. Identical request hits cache (upstreamCalls remains 1)
      const ok2 = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(ok2.status, 200);
      assert.equal(((await ok2.json()) as ShippingRateQuoteResponse).rates[0].cost, 18000);
      assert.equal(upstreamCalls, 1);

      // 8. Firestore stock/active/price revalidation runs EVEN when rate cache exists:
      // 8a. Stock drops -> 409 immediately
      storeProducts.prod_ok.stock = 1;
      const stockDropRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(stockDropRes.status, 409);
      assert.equal(upstreamCalls, 1);

      // 8b. Product deactivated -> 404 immediately
      storeProducts.prod_ok.stock = 10;
      storeProducts.prod_ok.isActive = false;
      const deactivatedRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(deactivatedRes.status, 404);
      assert.equal(upstreamCalls, 1);
      storeProducts.prod_ok.isActive = true;

      // 8c. Price changes (item_value changes) -> cache key misses & fetches fresh rate with new item_value
      storeProducts.prod_ok.price = 60000;
      const priceChangeRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(priceChangeRes.status, 200);
      assert.equal(lastPayloadSent?.item_value, 120000);
      assert.equal(upstreamCalls, 2);
      assert.equal(rateCache.size, 2);
      storeProducts.prod_ok.price = 50000;

      // 9. Empty rates, HTTP errors, invalid JSON, timeout are NEVER cached and leak zero secrets
      for (const failCase of [
        ['empty', 6001],
        ['error', 6002],
        ['invalid', 6003],
        ['timeout', 6004],
      ] as const) {
        mode = failCase[0];
        const res = await postRates({
          destinationDistrictId: failCase[1],
          items: [{ productId: 'prod_ok', quantity: 1 }],
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as ShippingRateQuoteResponse;
        assert.equal(body.available, false);
        assert.equal(body.fallbackToManual, true);
        assert.deepEqual(body.rates, []);
        assert.equal(JSON.stringify(body).includes(secretToken), false);
        assert.equal(rateCache.size, 2);
      }

      // 10. Config becomes empty later -> must NOT read cached rate, falls back safely
      const savedEnv = currentEnv;
      currentEnv = {};
      const callsWithNoKey = upstreamCalls;
      const noKeyAfterCache = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(noKeyAfterCache.status, 200);
      assert.equal(((await noKeyAfterCache.json()) as ShippingRateQuoteResponse).fallbackToManual, true);
      assert.equal(upstreamCalls, callsWithNoKey);
      currentEnv = savedEnv;

      // 11. 10-minute max TTL clamp check -> expires after 11 minutes
      mode = 'ok';
      nowMs += 11 * 60 * 1000;
      const callsBeforeTtl = upstreamCalls;
      const expiredRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 2 }],
      });
      assert.equal(expiredRes.status, 200);
      assert.equal(upstreamCalls, callsBeforeTtl + 1);

      // 12. Rate limit -> HTTP 429 with Cache-Control: no-store without external fetch
      allowRateLimit = false;
      const callsBeforeLimit = upstreamCalls;
      const limitedRes = await postRates({
        destinationDistrictId: 5507,
        items: [{ productId: 'prod_ok', quantity: 1 }],
      });
      assert.equal(limitedRes.status, 429);
      assert.equal(limitedRes.headers.get('cache-control'), 'no-store');
      assert.equal(upstreamCalls, callsBeforeLimit);
    }
  );
});

// ============================================================================
// Stage 6 Tests: POST /api/guest-orders Server-Side J&T Rate Verification
// ============================================================================
function createMockGuestOrderStore(
  storeId: string,
  initialProducts: Record<string, Record<string, unknown>>
) {
  const products: Record<string, Record<string, unknown>> = JSON.parse(
    JSON.stringify(initialProducts)
  );
  const guestOrders: Record<string, Record<string, unknown>> = {};

  function sanitizeWriteValue(val: unknown): unknown {
    if (val === undefined) return undefined;
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof (val as { constructor?: { name?: string } }).constructor?.name ===
        'string' &&
      (val as { constructor: { name: string } }).constructor.name !== 'Object'
    ) {
      // Converts FieldValue.serverTimestamp() sentinel to ISO string
      return new Date().toISOString();
    }
    if (Array.isArray(val)) {
      return val.map((v) => sanitizeWriteValue(v));
    }
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (v !== undefined) out[k] = sanitizeWriteValue(v);
      }
      return out;
    }
    return val;
  }

  function makeDocRef(colName: 'products' | 'guest_orders', id: string) {
    return {
      id,
      _colName: colName,
      async get() {
        const bucket = colName === 'products' ? products : guestOrders;
        const data = bucket[id];
        return {
          id,
          exists: data !== undefined,
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
        };
      },
    };
  }

  function makeCollection(colName: 'products' | 'guest_orders') {
    return {
      doc(id: string) {
        return makeDocRef(colName, id);
      },
      where(field: string, _op: string, value: unknown) {
        return {
          _colName: colName,
          _field: field,
          _value: value,
          limit() {
            return this;
          },
        };
      },
    };
  }

  const db = {
    collection(name: string) {
      assert.equal(name, 'stores');
      return {
        doc(reqStoreId: string) {
          assert.equal(reqStoreId, storeId);
          return {
            collection(subCol: 'products' | 'guest_orders') {
              return makeCollection(subCol);
            },
          };
        },
      };
    },
    async getAll(...refs: Array<{ id: string; _colName: 'products' | 'guest_orders' }>) {
      return Promise.all(
        refs.map((ref) => makeDocRef(ref._colName, ref.id).get())
      );
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const stagedCreates: Array<{
        colName: 'guest_orders';
        id: string;
        data: Record<string, unknown>;
      }> = [];

      const tx = {
        async get(refOrQuery: {
          id?: string;
          _colName?: 'products' | 'guest_orders';
          _field?: string;
          _value?: unknown;
        }) {
          if (refOrQuery.id && refOrQuery._colName) {
            return makeDocRef(refOrQuery._colName, refOrQuery.id).get();
          }
          const colName = refOrQuery._colName ?? 'guest_orders';
          const bucket = colName === 'products' ? products : guestOrders;
          const docs = Object.entries(bucket)
            .filter(([, d]) => d[refOrQuery._field || ''] === refOrQuery._value)
            .map(([docId, d]) => ({
              id: docId,
              exists: true,
              data: () => JSON.parse(JSON.stringify(d)),
            }));
          return { empty: docs.length === 0, docs };
        },
        async getAll(...refs: Array<{ id: string; _colName: 'products' | 'guest_orders' }>) {
          return Promise.all(
            refs.map((ref) => makeDocRef(ref._colName, ref.id).get())
          );
        },
        create(
          ref: { id: string; _colName: 'guest_orders' },
          data: Record<string, unknown>
        ) {
          if (guestOrders[ref.id] !== undefined) {
            throw new Error(`Document already exists: ${ref.id}`);
          }
          stagedCreates.push({
            colName: ref._colName,
            id: ref.id,
            data: sanitizeWriteValue(data) as Record<string, unknown>,
          });
        },
      };

      const result = await fn(tx);
      for (const item of stagedCreates) {
        guestOrders[item.id] = item.data;
      }
      return result;
    },
  };

  return {
    products,
    guestOrders,
    context: {
      storeId,
      db,
    } as unknown as GuestOrderStoreContext,
  };
}

test('POST /api/guest-orders verifies J&T tariff server-side, protects against tampering, preserves idempotency, and falls back safely to PENDING_RATE', async () => {
  clearKiriminAjaCaches();
  const secretToken = 'ka-stage6-order-secret-555';
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const store = createMockGuestOrderStore('store_owner_1', {
    prod_weighed: {
      id: 'prod_weighed',
      sku: 'SKU-W1',
      name: 'Beras Premium 1kg',
      price: 50000,
      stock: 10,
      unit: 'kg',
      weightGrams: 1000,
      isActive: true,
      cost: 39000,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      sku: 'SKU-U1',
      name: 'Roti Tanpa Berat',
      price: 15000,
      stock: 10,
      unit: 'pcs',
      isActive: true,
    },
    prod_inactive: {
      id: 'prod_inactive',
      sku: 'SKU-INACT',
      name: 'Produk Nonaktif',
      price: 20000,
      stock: 10,
      unit: 'pcs',
      weightGrams: 500,
      isActive: false,
    },
  });

  let nowMs = 300_000_000;
  let upstreamCalls = 0;
  let mode: 'ok' | 'empty' | 'error' | 'timeout' = 'ok';
  let currentEnv: Record<string, string | undefined> = {
    KIRIMINAJA_API_KEY: secretToken,
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
  };

  const envProxy = new Proxy(
    {},
    {
      get: (_target, prop) => (typeof prop === 'string' ? currentEnv[prop] : undefined),
      ownKeys: () => Reflect.ownKeys(currentEnv),
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop in currentEnv
          ? { enumerable: true, configurable: true, value: currentEnv[prop] }
          : undefined,
    }
  ) as Record<string, string | undefined>;

  const mockFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    if (mode === 'empty') {
      return new Response(JSON.stringify({ status: true, results: [] }), {
        status: 200,
      });
    }
    if (mode === 'error') {
      return new Response(`Upstream error ${secretToken}`, { status: 500 });
    }
    if (mode === 'timeout') {
      const err = new Error(`Timed out ${secretToken}`);
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'EZ',
            service_name: 'Reguler',
            cost: 18000,
            etd: '2-3',
          },
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'JSD',
            service_name: 'Super',
            cost: 32000,
            etd: '1',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withKiriminAjaTestServer(
    (app) => {
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          checkRateLimit: () => true,
          env: envProxy,
          fetchImpl: mockFetch,
          rateCache,
          now: () => nowMs,
        })
      );
    },
    async (baseUrl) => {
      const postOrder = (payload: Record<string, unknown>) =>
        fetch(`${baseUrl}/api/guest-orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

      // 1. Valid J&T automatic rate with tampered browser fields -> server ignores client values, verifies KiriminAja rate
      const verifiedRes = await postOrder({
        customerName: 'Siti Aminah',
        customerPhone: '081234567890',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Jenderal Sudirman No. 45 Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'ez',
        idempotencyKey: 'idem-stage6-verified-01',
        // Browser tampering attempts (must ALL be ignored):
        shippingFee: 1,
        total: 1,
        totalAmount: 1,
        itemsSubtotal: 1,
        subtotal: 1,
        weight: 1,
        weightGrams: 1,
        originDistrictId: 99999,
        items: [{ productId: 'prod_weighed', quantity: 2 }],
      });
      assert.equal(verifiedRes.status, 201);
      assert.equal(verifiedRes.headers.get('cache-control'), 'no-store');
      const verifiedBody = (await verifiedRes.json()) as { order: GuestOrder };
      assert.equal(verifiedBody.order.itemsSubtotal, 100000);
      assert.equal(verifiedBody.order.totalAmount, 118000);
      assert.equal(verifiedBody.order.stockDeducted, false);
      assert.equal(verifiedBody.order.customerPhone, '*********7890');
      assert.deepEqual(
        {
          provider: verifiedBody.order.shipping?.provider,
          serviceCode: verifiedBody.order.shipping?.serviceCode,
          destinationDistrictId: verifiedBody.order.shipping?.destinationDistrictId,
          status: verifiedBody.order.shipping?.status,
          totalWeightGrams: verifiedBody.order.shipping?.totalWeightGrams,
          hasUnweighedItems: verifiedBody.order.shipping?.hasUnweighedItems,
          shippingFee: verifiedBody.order.shipping?.shippingFee,
          shippingFeeConfirmed: verifiedBody.order.shipping?.shippingFeeConfirmed,
        },
        {
          provider: 'JNT_EXPRESS',
          serviceCode: 'EZ',
          destinationDistrictId: 5507,
          status: 'READY_TO_SHIP',
          totalWeightGrams: 2000,
          hasUnweighedItems: false,
          shippingFee: 18000,
          shippingFeeConfirmed: true,
        }
      );
      assert.equal(store.products.prod_weighed.stock, 10); // stock not deducted
      assert.equal(store.guestOrders[verifiedBody.order.id].customerPhone, '6281234567890');
      assert.equal(upstreamCalls, 1);

      // 2. Duplicate submit with same idempotencyKey + same scope -> 200 deduplicated without extra upstream calls
      const dupRes = await postOrder({
        customerName: 'Siti Aminah',
        customerPhone: '081234567890',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Jenderal Sudirman No. 45 Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        idempotencyKey: 'idem-stage6-verified-01',
        items: [{ productId: 'prod_weighed', quantity: 2 }],
      });
      assert.equal(dupRes.status, 200);
      const dupBody = (await dupRes.json()) as {
        order: GuestOrder;
        deduplicated: boolean;
      };
      assert.equal(dupBody.deduplicated, true);
      assert.equal(dupBody.order.id, verifiedBody.order.id);
      assert.equal(upstreamCalls, 1);

      // 3. Changing selectedServiceCode even with same idempotencyKey -> separate scope & hits warm rateCache!
      const jsdRes = await postOrder({
        customerName: 'Siti Aminah',
        customerPhone: '081234567890',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Jenderal Sudirman No. 45 Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'JSD',
        idempotencyKey: 'idem-stage6-verified-01',
        items: [{ productId: 'prod_weighed', quantity: 2 }],
      });
      assert.equal(jsdRes.status, 201);
      const jsdBody = (await jsdRes.json()) as { order: GuestOrder };
      assert.notEqual(jsdBody.order.id, verifiedBody.order.id);
      assert.equal(jsdBody.order.shipping?.serviceCode, 'JSD');
      assert.equal(jsdBody.order.shipping?.shippingFee, 32000);
      assert.equal(jsdBody.order.totalAmount, 132000);
      assert.equal(upstreamCalls, 1); // served from rateCache!

      // 4. Mismatched selectedServiceCode -> fallback to PENDING_RATE, shippingFee=0, unconfirmed
      const mismatchRes = await postOrder({
        customerName: 'Siti Aminah',
        customerPhone: '081234567890',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Jenderal Sudirman No. 45 Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'NONEXISTENT_SVC',
        idempotencyKey: 'idem-stage6-mismatch-01',
        items: [{ productId: 'prod_weighed', quantity: 2 }],
      });
      assert.equal(mismatchRes.status, 201);
      const mismatchBody = (await mismatchRes.json()) as { order: GuestOrder };
      assert.equal(mismatchBody.order.shipping?.status, 'PENDING_RATE');
      assert.equal(mismatchBody.order.shipping?.serviceCode, undefined);
      assert.equal(mismatchBody.order.shipping?.shippingFee, 0);
      assert.equal(mismatchBody.order.shipping?.shippingFeeConfirmed, false);
      assert.equal(mismatchBody.order.totalAmount, 100000);

      // 5. Legacy JNT delivery without destinationDistrictId -> PENDING_RATE
      const legacyJntRes = await postOrder({
        customerName: 'Budi Legacy',
        customerPhone: '081234567891',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Ahmad Yani No. 12 Ponorogo',
        idempotencyKey: 'idem-stage6-legacy-jnt',
        items: [{ productId: 'prod_weighed', quantity: 1 }],
      });
      assert.equal(legacyJntRes.status, 201);
      const legacyJntBody = (await legacyJntRes.json()) as { order: GuestOrder };
      assert.equal(legacyJntBody.order.shipping?.provider, 'JNT_EXPRESS');
      assert.equal(legacyJntBody.order.shipping?.status, 'PENDING_RATE');
      assert.equal(legacyJntBody.order.shipping?.shippingFee, 0);
      assert.equal(legacyJntBody.order.shipping?.shippingFeeConfirmed, false);
      assert.equal(legacyJntBody.order.totalAmount, 50000);

      // 6. destinationDistrictId without selectedServiceCode -> PENDING_RATE, no upstream call
      const callsBeforeDestOnly = upstreamCalls;
      const destOnlyRes = await postOrder({
        customerName: 'Budi DestOnly',
        customerPhone: '081234567892',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Ahmad Yani No. 14 Ponorogo',
        destinationDistrictId: 5507,
        idempotencyKey: 'idem-stage6-dest-only',
        items: [{ productId: 'prod_weighed', quantity: 1 }],
      });
      assert.equal(destOnlyRes.status, 201);
      const destOnlyBody = (await destOnlyRes.json()) as { order: GuestOrder };
      assert.equal(destOnlyBody.order.shipping?.destinationDistrictId, 5507);
      assert.equal(destOnlyBody.order.shipping?.status, 'PENDING_RATE');
      assert.equal(destOnlyBody.order.shipping?.shippingFee, 0);
      assert.equal(destOnlyBody.order.shipping?.shippingFeeConfirmed, false);
      assert.equal(upstreamCalls, callsBeforeDestOnly);

      // 7. Pickup remains unchanged, and legacy STORE_COURIER remains compatible
      const pickupRes = await postOrder({
        customerName: 'Ani Pickup',
        customerPhone: '081234567893',
        fulfillmentType: 'pickup',
        idempotencyKey: 'idem-stage6-pickup-01',
        items: [{ productId: 'prod_weighed', quantity: 1 }],
      });
      assert.equal(pickupRes.status, 201);
      const pickupBody = (await pickupRes.json()) as { order: GuestOrder };
      assert.equal(pickupBody.order.fulfillmentType, 'pickup');
      assert.equal(pickupBody.order.shipping, undefined);
      assert.equal(pickupBody.order.totalAmount, 50000);

      const legacyStoreCourierRes = await postOrder({
        customerName: 'Tono StoreCourier',
        customerPhone: '081234567894',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Thamrin No. 3 Ponorogo',
        idempotencyKey: 'idem-stage6-store-courier',
        items: [{ productId: 'prod_weighed', quantity: 1 }],
      });
      assert.equal(legacyStoreCourierRes.status, 201);
      const legacyStoreBody = (await legacyStoreCourierRes.json()) as { order: GuestOrder };
      assert.equal(legacyStoreBody.order.shipping?.provider, 'STORE_COURIER');
      assert.equal(legacyStoreBody.order.shipping?.shippingFeeConfirmed, true);

      // 8. Reject invalid destinationDistrictId / selectedServiceCode / pickup+destination (400)
      for (const badPayload of [
        {
          customerName: 'Bad Input',
          customerPhone: '081234567895',
          fulfillmentType: 'pickup',
          destinationDistrictId: 5507,
          idempotencyKey: 'idem-stage6-bad-1',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
        {
          customerName: 'Bad Input',
          customerPhone: '081234567895',
          fulfillmentType: 'delivery',
          shippingProvider: 'JNT_EXPRESS',
          deliveryAddress: 'Jl. Valid Panjang Ponorogo',
          destinationDistrictId: -10,
          idempotencyKey: 'idem-stage6-bad-2',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
        {
          customerName: 'Bad Input',
          customerPhone: '081234567895',
          fulfillmentType: 'delivery',
          shippingProvider: 'JNT_EXPRESS',
          deliveryAddress: 'Jl. Valid Panjang Ponorogo',
          destinationDistrictId: 5507,
          selectedServiceCode: '<script>',
          idempotencyKey: 'idem-stage6-bad-3',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
      ]) {
        const badRes = await postOrder(badPayload);
        assert.equal(badRes.status, 400);
      }

      // 9. Missing/inactive product -> 404; insufficient stock -> 409
      const missingRes = await postOrder({
        customerName: 'Siti 404',
        customerPhone: '081234567896',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Valid Panjang Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        idempotencyKey: 'idem-stage6-404-01',
        items: [{ productId: 'prod_inactive', quantity: 1 }],
      });
      assert.equal(missingRes.status, 404);

      const stockRes = await postOrder({
        customerName: 'Siti 409',
        customerPhone: '081234567896',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Valid Panjang Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        idempotencyKey: 'idem-stage6-409-01',
        items: [{ productId: 'prod_weighed', quantity: 99 }],
      });
      assert.equal(stockRes.status, 409);

      // 10. Unweighed item -> skips KiriminAja, falls back to PENDING_RATE
      const callsBeforeUnweighed = upstreamCalls;
      const unweighedRes = await postOrder({
        customerName: 'Siti Unweighed',
        customerPhone: '081234567897',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Valid Panjang Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        idempotencyKey: 'idem-stage6-unweighed-01',
        items: [{ productId: 'prod_unweighed', quantity: 2 }],
      });
      assert.equal(unweighedRes.status, 201);
      const unweighedBody = (await unweighedRes.json()) as { order: GuestOrder };
      assert.equal(unweighedBody.order.shipping?.status, 'PENDING_RATE');
      assert.equal(unweighedBody.order.shipping?.hasUnweighedItems, true);
      assert.equal(unweighedBody.order.shipping?.shippingFee, 0);
      assert.equal(unweighedBody.order.shipping?.shippingFeeConfirmed, false);
      assert.equal(unweighedBody.order.totalAmount, 30000);
      assert.equal(upstreamCalls, callsBeforeUnweighed);

      // 11. KiriminAja empty rates, HTTP error, timeout, or unconfigured -> safe PENDING_RATE without leaking secret
      for (const [idx, failMode] of (
        ['empty', 'error', 'timeout'] as const
      ).entries()) {
        mode = failMode;
        const failRes = await postOrder({
          customerName: `Fail ${failMode}`,
          customerPhone: '081234567898',
          fulfillmentType: 'delivery',
          shippingProvider: 'JNT_EXPRESS',
          deliveryAddress: 'Jl. Valid Panjang Ponorogo',
          destinationDistrictId: 6100 + idx,
          selectedServiceCode: 'EZ',
          idempotencyKey: `idem-stage6-fail-${failMode}`,
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        });
        assert.equal(failRes.status, 201);
        const failBody = (await failRes.json()) as { order: GuestOrder };
        assert.equal(failBody.order.shipping?.status, 'PENDING_RATE');
        assert.equal(failBody.order.shipping?.shippingFee, 0);
        assert.equal(failBody.order.shipping?.shippingFeeConfirmed, false);
        assert.equal(failBody.order.totalAmount, 50000);
        assert.equal(JSON.stringify(failBody).includes(secretToken), false);
      }

      currentEnv = {};
      const noConfigRes = await postOrder({
        customerName: 'No Config',
        customerPhone: '081234567899',
        fulfillmentType: 'delivery',
        shippingProvider: 'JNT_EXPRESS',
        deliveryAddress: 'Jl. Valid Panjang Ponorogo',
        destinationDistrictId: 6200,
        selectedServiceCode: 'EZ',
        idempotencyKey: 'idem-stage6-noconfig',
        items: [{ productId: 'prod_weighed', quantity: 1 }],
      });
      assert.equal(noConfigRes.status, 201);
      const noConfigBody = (await noConfigRes.json()) as { order: GuestOrder };
      assert.equal(noConfigBody.order.shipping?.status, 'PENDING_RATE');
      assert.equal(noConfigBody.order.shipping?.shippingFee, 0);
      assert.equal(noConfigBody.order.shipping?.shippingFeeConfirmed, false);
      assert.equal(noConfigBody.order.totalAmount, 50000);
    }
  );
});
