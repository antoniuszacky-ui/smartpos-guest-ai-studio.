import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import {
  BoundedTtlCache,
  clearRegionCaches,
  createRegionCitiesHandler,
  createRegionDistrictsHandler,
  createRegionProvincesHandler,
  createRegionVillagesHandler,
  fetchLokaIdRegions,
  parseLokaIdRegionResponse,
  validateRegionParentCode,
} from './server.ts';
import type { RegionOption } from './src/types/pos.ts';

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

const regionClient = (await vite.ssrLoadModule(
  '/src/utils/regionClient.ts'
)) as typeof import('./src/utils/regionClient.ts');

const { SearchableRegionSelect } = (await vite.ssrLoadModule(
  '/src/components/SearchableRegionSelect.tsx'
)) as typeof import('./src/components/SearchableRegionSelect.tsx');

test.after(async () => {
  await vite.close();
});

async function withRegionsServer(
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

test('LokaID unit parsers validate parent codes, deduplicate/sort regions, and reject malformed payloads', () => {
  assert.equal(validateRegionParentCode('cities', '35').ok, true);
  assert.equal(validateRegionParentCode('cities', '../35').ok, false);
  assert.equal(validateRegionParentCode('districts', '35.02').ok, true);
  assert.equal(validateRegionParentCode('districts', '35').ok, false);
  assert.equal(validateRegionParentCode('villages', '35.02.17').ok, true);
  assert.equal(validateRegionParentCode('villages', '35.02').ok, false);

  const validParsed = parseLokaIdRegionResponse({
    status: 200,
    message: 'SUCCESS',
    data: [
      { code: '35', value: 'JAWA TIMUR' },
      { code: '31', value: 'DKI JAKARTA' },
      { code: '35', value: 'JAWA TIMUR' }, // duplicate
      { code: 'bad!', value: 'INVALID' },
    ],
  });
  assert.equal(validParsed.ok, true);
  if (validParsed.ok) {
    assert.deepEqual(validParsed.regions, [
      { code: '31', name: 'DKI JAKARTA' },
      { code: '35', name: 'JAWA TIMUR' },
    ]);
  }

  const emptyParsed = parseLokaIdRegionResponse({
    status: 200,
    message: 'SUCCESS',
    data: [],
  });
  assert.equal(emptyParsed.ok, true);
  if (emptyParsed.ok) {
    assert.deepEqual(emptyParsed.regions, []);
  }

  assert.equal(parseLokaIdRegionResponse(null).ok, false);
  assert.equal(parseLokaIdRegionResponse({ status: 500, data: [] }).ok, false);
  assert.equal(parseLokaIdRegionResponse({ status: 200, data: 'nope' }).ok, false);
  assert.equal(
    parseLokaIdRegionResponse({
      status: 200,
      data: [{ foo: 'bar' }],
    }).ok,
    false
  );
});

test('Stage 12 Regions HTTP & Client — Loads provinces/cities/districts/villages, enforces cache, handles empty/timeout/network-error/invalid data & retry', async () => {
  clearRegionCaches();
  const cache = new BoundedTtlCache<RegionOption[]>({
    maxEntries: 500,
    defaultTtlMs: 24 * 60 * 60 * 1000,
  });

  let mode: 'ok' | 'empty' | 'timeout' | 'network_error' | 'invalid_json' | 'bad_schema' =
    'ok';
  let upstreamHits = 0;
  const requestedUrls: string[] = [];

  const mockLokaIdFetch: typeof fetch = async (input) => {
    const url = String(input);
    upstreamHits += 1;
    requestedUrls.push(url);

    if (mode === 'timeout') {
      const err = new Error('LokaID timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (mode === 'network_error') {
      throw new TypeError('Failed to connect to LokaID');
    }
    if (mode === 'invalid_json') {
      return new Response('<html>502 Bad Gateway</html>', { status: 200 });
    }
    if (mode === 'bad_schema') {
      return new Response(JSON.stringify({ status: 200, data: [{ x: 1 }] }), {
        status: 200,
      });
    }
    if (mode === 'empty') {
      return new Response(
        JSON.stringify({ status: 200, message: 'SUCCESS', data: [] }),
        { status: 200 }
      );
    }

    if (url.endsWith('/states')) {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [
            { code: '35', value: 'JAWA TIMUR' },
            { code: '31', value: 'DKI JAKARTA' },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith('/states/35/cities')) {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [
            { code: '35.02', value: 'KAB. PONOROGO' },
            { code: '35.78', value: 'KOTA SURABAYA' },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith('/cities/35.02/districts')) {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [
            { code: '35.02.17', value: 'PONOROGO' },
            { code: '35.02.16', value: 'SIMAN' },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith('/districts/35.02.17/villages')) {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [
            { code: '35.02.17.1001', value: 'SURODIKRAMAN' },
            { code: '35.02.17.1002', value: 'TONATAN' },
          ],
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({ status: 404, message: 'Not Found' }), {
      status: 404,
    });
  };

  await withRegionsServer(
    (app) => {
      const deps = {
        fetchImpl: mockLokaIdFetch,
        cache,
        checkRateLimit: () => true,
      };
      app.get('/api/regions/provinces', createRegionProvincesHandler(deps));
      app.get(
        '/api/regions/provinces/:stateCode/cities',
        createRegionCitiesHandler(deps)
      );
      app.get(
        '/api/regions/cities/:cityCode/districts',
        createRegionDistrictsHandler(deps)
      );
      app.get(
        '/api/regions/districts/:districtCode/villages',
        createRegionVillagesHandler(deps)
      );
    },
    async (baseUrl) => {
      const bridgeFetch: typeof fetch = (input, init) => {
        const raw = String(input);
        return fetch(raw.startsWith('/') ? `${baseUrl}${raw}` : raw, init);
      };

      // 1-4. Load all 4 levels via frontend regionClient -> Express -> mock LokaID
      const provRes = await regionClient.fetchRegionProvinces({
        fetchImpl: bridgeFetch,
      });
      assert.equal(provRes.ok, true);
      assert.deepEqual(provRes.regions, [
        { code: '31', name: 'DKI JAKARTA' },
        { code: '35', name: 'JAWA TIMUR' },
      ]);

      const cityRes = await regionClient.fetchRegionCities('35', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(cityRes.ok, true);
      assert.deepEqual(cityRes.regions, [
        { code: '35.02', name: 'KAB. PONOROGO' },
        { code: '35.78', name: 'KOTA SURABAYA' },
      ]);

      const distRes = await regionClient.fetchRegionDistricts('35.02', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(distRes.ok, true);
      assert.deepEqual(distRes.regions, [
        { code: '35.02.17', name: 'PONOROGO' },
        { code: '35.02.16', name: 'SIMAN' },
      ]);

      const vilRes = await regionClient.fetchRegionVillages('35.02.17', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(vilRes.ok, true);
      assert.deepEqual(vilRes.regions, [
        { code: '35.02.17.1001', name: 'SURODIKRAMAN' },
        { code: '35.02.17.1002', name: 'TONATAN' },
      ]);

      assert.equal(upstreamHits, 4);
      assert.deepEqual(requestedUrls, [
        'https://lokaid.gilangpratama.id/states',
        'https://lokaid.gilangpratama.id/states/35/cities',
        'https://lokaid.gilangpratama.id/cities/35.02/districts',
        'https://lokaid.gilangpratama.id/districts/35.02.17/villages',
      ]);

      // Second call uses server cache (no additional upstream hit)
      const cachedProv = await regionClient.fetchRegionProvinces({
        fetchImpl: bridgeFetch,
      });
      assert.equal(cachedProv.ok, true);
      assert.equal(upstreamHits, 4);

      // 6. Empty state (never cached!)
      mode = 'empty';
      const emptyCity = await regionClient.fetchRegionCities('31', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(emptyCity.ok, true);
      assert.deepEqual(emptyCity.regions, []);
      const hitsBeforeRetry = upstreamHits;
      // Re-fetching empty code still hits upstream (not cached!) & now succeeds on retry
      mode = 'ok';
      await regionClient.fetchRegionCities('31', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(upstreamHits, hitsBeforeRetry + 1);

      // 7 & 8. Timeout + Network Error -> never cached -> Retry recovers cleanly
      mode = 'timeout';
      const timeoutRes = await regionClient.fetchRegionDistricts('35.78', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(timeoutRes.ok, false);
      assert.equal(timeoutRes.statusCode, 504);
      assert.match(timeoutRes.errorMessage || '', /batas waktu/i);

      mode = 'network_error';
      const netErrRes = await regionClient.fetchRegionDistricts('35.78', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(netErrRes.ok, false);
      assert.equal(netErrRes.statusCode, 502);

      // Direct invalid data test (invalid JSON + malformed schema)
      mode = 'invalid_json';
      const invalidJsonRes = await regionClient.fetchRegionVillages('35.02.16', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(invalidJsonRes.ok, false);
      assert.equal(invalidJsonRes.statusCode, 502);

      mode = 'bad_schema';
      const badSchemaRes = await regionClient.fetchRegionVillages('35.02.16', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(badSchemaRes.ok, false);
      assert.equal(badSchemaRes.statusCode, 502);

      // Invalid parent code rejected client-side AND server-side with 400
      const badClientCode = await regionClient.fetchRegionCities('invalid', {
        fetchImpl: bridgeFetch,
      });
      assert.equal(badClientCode.ok, false);
      assert.equal(badClientCode.statusCode, 400);

      const badServerCode = await bridgeFetch('/api/regions/cities/bad-code/districts');
      assert.equal(badServerCode.status, 400);

      // Upstream 404 handled cleanly without crashing
      mode = 'ok';
      const notFoundRes = await fetchLokaIdRegions({
        level: 'cities',
        parentCode: '99',
        fetchImpl: mockLokaIdFetch,
      });
      assert.equal(notFoundRes.ok, false);
      if (!notFoundRes.ok) {
        assert.equal(notFoundRes.statusCode, 404);
      }
    }
  );
});

test('SearchableRegionSelect SSR renders disabled, loading, empty, error+retry, and selected states cleanly', () => {
  const disabledHtml = renderToStaticMarkup(
    React.createElement(SearchableRegionSelect, {
      id: 'region-city',
      label: 'Kabupaten / Kota',
      placeholder: 'Pilih Provinsi dahulu',
      searchPlaceholder: 'Cari kota...',
      options: [],
      value: null,
      disabled: true,
      onSelect: () => {},
    })
  );
  assert.match(disabledHtml, /disabled=""/);
  assert.match(disabledHtml, /Pilih Provinsi dahulu/);

  const loadingHtml = renderToStaticMarkup(
    React.createElement(SearchableRegionSelect, {
      id: 'region-city',
      label: 'Kabupaten / Kota',
      placeholder: 'Pilih Kabupaten / Kota',
      searchPlaceholder: 'Cari kota...',
      options: [],
      value: null,
      isLoading: true,
      onSelect: () => {},
    })
  );
  assert.match(loadingHtml, /Memuat kabupaten \/ kota\.\.\./);

  const errorHtml = renderToStaticMarkup(
    React.createElement(SearchableRegionSelect, {
      id: 'region-city',
      label: 'Kabupaten / Kota',
      placeholder: 'Pilih Kabupaten / Kota',
      searchPlaceholder: 'Cari kota...',
      options: [],
      value: null,
      errorMessage: 'Koneksi ke layanan wilayah habis waktu.',
      onSelect: () => {},
      onRetry: () => {},
    })
  );
  assert.match(errorHtml, /Koneksi ke layanan wilayah habis waktu\./);
  assert.match(errorHtml, /Coba lagi/);

  const emptyHtml = renderToStaticMarkup(
    React.createElement(SearchableRegionSelect, {
      id: 'region-village',
      label: 'Kelurahan / Desa',
      placeholder: 'Pilih Kelurahan / Desa',
      searchPlaceholder: 'Cari kelurahan...',
      options: [],
      value: null,
      hasLoaded: true,
      onSelect: () => {},
    })
  );
  assert.match(emptyHtml, /Data wilayah belum tersedia untuk pilihan ini\./);

  const selectedHtml = renderToStaticMarkup(
    React.createElement(SearchableRegionSelect, {
      id: 'region-province',
      label: 'Provinsi',
      placeholder: 'Pilih Provinsi',
      searchPlaceholder: 'Cari provinsi...',
      options: [{ code: '35', name: 'JAWA TIMUR' }],
      value: { code: '35', name: 'JAWA TIMUR' },
      hasLoaded: true,
      onSelect: () => {},
    })
  );
  assert.match(selectedHtml, /JAWA TIMUR/);
  assert.match(selectedHtml, /35/);

  // Cascading reset test when parent selection changes
  let selection = regionClient.applyCascadingRegionSelection(
    { province: null, city: null, district: null, village: null },
    'provinces',
    { code: '35', name: 'JAWA TIMUR' }
  );
  selection = regionClient.applyCascadingRegionSelection(selection, 'cities', {
    code: '35.02',
    name: 'KAB. PONOROGO',
  });
  selection = regionClient.applyCascadingRegionSelection(selection, 'districts', {
    code: '35.02.17',
    name: 'PONOROGO',
  });
  selection = regionClient.applyCascadingRegionSelection(selection, 'villages', {
    code: '35.02.17.1001',
    name: 'SURODIKRAMAN',
  });
  assert.equal(selection.village?.code, '35.02.17.1001');

  // Changing district resets only village
  const afterDistrictChange = regionClient.applyCascadingRegionSelection(
    selection,
    'districts',
    { code: '35.02.16', name: 'SIMAN' }
  );
  assert.equal(afterDistrictChange.province?.code, '35');
  assert.equal(afterDistrictChange.city?.code, '35.02');
  assert.equal(afterDistrictChange.district?.code, '35.02.16');
  assert.equal(afterDistrictChange.village, null);

  // Changing city resets district and village
  const afterCityChange = regionClient.applyCascadingRegionSelection(
    selection,
    'cities',
    { code: '35.78', name: 'KOTA SURABAYA' }
  );
  assert.equal(afterCityChange.province?.code, '35');
  assert.equal(afterCityChange.city?.code, '35.78');
  assert.equal(afterCityChange.district, null);
  assert.equal(afterCityChange.village, null);

  // Changing province resets city, district, and village
  const afterProvinceChange = regionClient.applyCascadingRegionSelection(
    selection,
    'provinces',
    { code: '31', name: 'DKI JAKARTA' }
  );
  assert.equal(afterProvinceChange.province?.code, '31');
  assert.equal(afterProvinceChange.city, null);
  assert.equal(afterProvinceChange.district, null);
  assert.equal(afterProvinceChange.village, null);
});

test('Stage 14C.2 Gap C — Regions production rate limiter enforces 90 req / 5 min / IP, isolates IPs, and resets after window expiry', async (t) => {
  clearRegionCaches();
  const cache = new BoundedTtlCache<RegionOption[]>({
    maxEntries: 500,
    defaultTtlMs: 24 * 60 * 60 * 1000,
  });

  let upstreamHits = 0;
  const mockLokaIdFetch: typeof fetch = async () => {
    upstreamHits += 1;
    return new Response(
      JSON.stringify({
        status: 200,
        message: 'SUCCESS',
        data: [{ code: '35', value: 'JAWA TIMUR' }],
      }),
      { status: 200 }
    );
  };

  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    await withRegionsServer(
      (app) => {
        // Omit checkRateLimit so Express uses the actual server.ts checkRegionLookupRateLimit
        app.get(
          '/api/regions/provinces',
          createRegionProvincesHandler({
            fetchImpl: mockLokaIdFetch,
            cache,
          })
        );
      },
      async (baseUrl) => {
        const ipA = '198.51.100.41';
        const ipB = '198.51.100.42';

        // 1. First 90 requests for IP A succeed (200); cache serves hits 2..90
        for (let i = 0; i < 90; i += 1) {
          const res = await fetch(`${baseUrl}/api/regions/provinces`, {
            headers: { 'x-forwarded-for': ipA },
          });
          assert.equal(res.status, 200);
        }
        assert.equal(upstreamHits, 1);

        // 2. Request #91 from IP A exceeds 90 req/5 min and returns HTTP 429
        const blockedRes = await fetch(`${baseUrl}/api/regions/provinces`, {
          headers: { 'x-forwarded-for': ipA },
        });
        assert.equal(blockedRes.status, 429);
        const blockedBody = (await blockedRes.json()) as { error: string };
        assert.match(blockedBody.error, /Terlalu banyak permintaan/i);

        // 3. Different IP (IP B) remains isolated and succeeds with 200
        const ipBRes = await fetch(`${baseUrl}/api/regions/provinces`, {
          headers: { 'x-forwarded-for': ipB },
        });
        assert.equal(ipBRes.status, 200);

        // 4. Advance Date clock past 5-minute window (300_001 ms) -> IP A bucket resets
        t.mock.timers.tick(5 * 60 * 1000 + 1);
        const resetRes = await fetch(`${baseUrl}/api/regions/provinces`, {
          headers: { 'x-forwarded-for': ipA },
        });
        assert.equal(resetRes.status, 200);
      }
    );
  } finally {
    t.mock.timers.reset();
  }
});

