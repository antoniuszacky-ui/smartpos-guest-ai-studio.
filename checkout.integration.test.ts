import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import {
  BoundedTtlCache,
  clearKiriminAjaCaches,
  clearRegionCaches,
  createGuestOrderLookupHandler,
  createGuestOrdersHandler,
  createKiriminAjaJntRatesHandler,
  createKiriminAjaLocationsHandler,
  createRegionCitiesHandler,
  createRegionDistrictsHandler,
  createRegionProvincesHandler,
  createRegionVillagesHandler,
  parseOwnerShippingUpdatePayload,
  updateGuestOrderShippingInTransaction,
  type GuestOrderStoreContext,
} from './server.ts';
import type {
  CartItem,
  GuestOrder,
  JntRateOption,
  Product,
  RegionOption,
  ShippingLocationOption,
} from './src/types/pos.ts';

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

const shippingClient = (await vite.ssrLoadModule(
  '/src/utils/shippingClient.ts'
)) as typeof import('./src/utils/shippingClient.ts');

const regionClient = (await vite.ssrLoadModule(
  '/src/utils/regionClient.ts'
)) as typeof import('./src/utils/regionClient.ts');

const checkoutUtils = (await vite.ssrLoadModule(
  '/src/utils/checkout.ts'
)) as typeof import('./src/utils/checkout.ts');

const orderShippingView = (await vite.ssrLoadModule(
  '/src/utils/orderShippingView.ts'
)) as typeof import('./src/utils/orderShippingView.ts');

const { OrderStatusPage } = (await vite.ssrLoadModule(
  '/src/components/OrderStatusPage.tsx'
)) as typeof import('./src/components/OrderStatusPage.tsx');

const { CartCheckoutDrawer } = (await vite.ssrLoadModule(
  '/src/components/CartCheckoutDrawer.tsx'
)) as typeof import('./src/components/CartCheckoutDrawer.tsx');

test.after(async () => {
  await vite.close();
});

function createLocalBridgeFetch(baseUrl: string): typeof fetch {
  return (input, init) => {
    const rawUrl = String(input);
    const targetUrl = rawUrl.startsWith('/') ? `${baseUrl}${rawUrl}` : rawUrl;
    return fetch(targetUrl, init);
  };
}

function createInMemoryGuestOrderStore(
  storeId: string,
  initialProducts: Record<string, Record<string, unknown>>,
  initialOrders: Record<string, Record<string, unknown>> = {}
) {
  const products: Record<string, Record<string, unknown>> = JSON.parse(
    JSON.stringify(initialProducts)
  );
  const guestOrders: Record<string, Record<string, unknown>> = JSON.parse(
    JSON.stringify(initialOrders)
  );
  const sales: Record<string, Record<string, unknown>> = {};
  const transactions: Record<string, Record<string, unknown>> = {};

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

  type SubCol = 'products' | 'guest_orders' | 'sales' | 'transactions';

  function getBucket(colName: SubCol): Record<string, Record<string, unknown>> {
    if (colName === 'products') return products;
    if (colName === 'guest_orders') return guestOrders;
    if (colName === 'sales') return sales;
    return transactions;
  }

  function makeDocRef(colName: SubCol, id: string) {
    return {
      id,
      _colName: colName,
      async get() {
        const bucket = getBucket(colName);
        const data = bucket[id];
        return {
          id,
          exists: data !== undefined,
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
        };
      },
    };
  }

  function makeCollection(colName: SubCol) {
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
          async get() {
            const bucket = getBucket(colName);
            const docs = Object.entries(bucket)
              .filter(([, d]) => d[field] === value)
              .map(([docId, d]) => ({
                id: docId,
                exists: true,
                data: () => JSON.parse(JSON.stringify(d)),
              }));
            return { empty: docs.length === 0, docs };
          },
        };
      },
    };
  }

  const storeRef = {
    collection(subCol: SubCol) {
      return makeCollection(subCol);
    },
  };

  let txQueue: Promise<void> = Promise.resolve();

  const db = {
    collection(name: string) {
      assert.equal(name, 'stores');
      return {
        doc(reqStoreId: string) {
          assert.equal(reqStoreId, storeId);
          return storeRef;
        },
      };
    },
    async getAll(...refs: Array<{ id: string; _colName: SubCol }>) {
      return Promise.all(refs.map((ref) => makeDocRef(ref._colName, ref.id).get()));
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      let releaseCurrent!: () => void;
      const prev = txQueue;
      txQueue = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      await prev;

      try {
        const stagedCreates: Array<{
          id: string;
          data: Record<string, unknown>;
        }> = [];
        const stagedUpdates: Array<{
          id: string;
          data: Record<string, unknown>;
        }> = [];

        const tx = {
          async get(refOrQuery: {
            id?: string;
            _colName?: SubCol;
            _field?: string;
            _value?: unknown;
          }) {
            if (refOrQuery.id && refOrQuery._colName) {
              return makeDocRef(refOrQuery._colName, refOrQuery.id).get();
            }
            const colName = refOrQuery._colName ?? 'guest_orders';
            const bucket = getBucket(colName);
            const docs = Object.entries(bucket)
              .filter(([, d]) => d[refOrQuery._field || ''] === refOrQuery._value)
              .map(([docId, d]) => ({
                id: docId,
                exists: true,
                data: () => JSON.parse(JSON.stringify(d)),
              }));
            return { empty: docs.length === 0, docs };
          },
          async getAll(...refs: Array<{ id: string; _colName: SubCol }>) {
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
              id: ref.id,
              data: sanitizeWriteValue(data) as Record<string, unknown>,
            });
          },
          update(
            ref: { id: string; _colName: 'guest_orders' },
            patch: Record<string, unknown>
          ) {
            const existing = guestOrders[ref.id];
            if (!existing) {
              throw new Error(`Document missing: ${ref.id}`);
            }
            stagedUpdates.push({
              id: ref.id,
              data: {
                ...existing,
                ...(sanitizeWriteValue(patch) as Record<string, unknown>),
              },
            });
          },
        };

        const result = await fn(tx);
        for (const item of stagedCreates) {
          guestOrders[item.id] = item.data;
        }
        for (const item of stagedUpdates) {
          guestOrders[item.id] = item.data;
        }
        return result;
      } finally {
        releaseCurrent();
      }
    },
  };

  return {
    products,
    guestOrders,
    storeRef,
    context: {
      storeId,
      db,
    } as unknown as GuestOrderStoreContext,
  };
}

function makeProductFromSeed(id: string, raw: Record<string, unknown>): Product {
  return {
    id,
    sku: String(raw.sku || id),
    name: String(raw.name || ''),
    categoryId: 'sembako',
    categoryName: 'Sembako',
    price: Number(raw.price || 0),
    stock: Number(raw.stock || 0),
    unit: String(raw.unit || 'pcs'),
    ...(typeof raw.weightGrams === 'number' ? { weightGrams: raw.weightGrams } : {}),
    imageUrl: '',
    description: '',
    isActive: true,
  };
}

async function withCheckoutIntegrationServer(
  setup: (app: express.Express) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
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

test('Stage 8 Integration — Delivery J&T full flow: location search, rate quote, service switch, cart qty update, tamper resistance, Owner shipping update & OrderStatusPage render', async () => {
  clearKiriminAjaCaches();
  const secretToken = 'ka-stage8-full-flow-secret';
  const locCache = new BoundedTtlCache<ShippingLocationOption[]>({
    maxEntries: 200,
    defaultTtlMs: 60 * 60 * 1000,
  });
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const store = createInMemoryGuestOrderStore('store_stage8', {
    prod_rice: {
      id: 'prod_rice',
      sku: 'RICE-1KG',
      name: 'Beras Pandan Wangi 1kg',
      price: 65000,
      stock: 20,
      unit: 'sak',
      weightGrams: 1000,
      isActive: true,
    },
    prod_coffee: {
      id: 'prod_coffee',
      sku: 'COF-500G',
      name: 'Kopi Tubruk 500g',
      price: 35000,
      stock: 15,
      unit: 'pack',
      weightGrams: 500,
      isActive: true,
    },
  });

  const env = {
    KIRIMINAJA_API_KEY: secretToken,
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
    KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/v2/locations',
    KIRIMINAJA_LOCATION_SEARCH_METHOD: 'POST',
  };

  let upstreamLocations = 0;
  let upstreamRates = 0;
  const observedUpstreamWeights: number[] = [];

  const mockKiriminAjaFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const bodyJson = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (url.endsWith('/api/mitra/v2/locations')) {
      upstreamLocations += 1;
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            {
              district_id: 5507,
              district_name: 'Siman',
              city_name: 'Ponorogo',
              province_name: 'Jawa Timur',
              postal_code: '63471',
            },
            {
              district_id: 5508,
              district_name: 'Jetis',
              city_name: 'Ponorogo',
              province_name: 'Jawa Timur',
              postal_code: '63473',
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith('/api/mitra/v6.1/shipping_price')) {
      upstreamRates += 1;
      const weight = Number(bodyJson.weight || 0);
      observedUpstreamWeights.push(weight);
      const isHeavy = weight >= 2000;
      return new Response(
        JSON.stringify({
          status: true,
          results: [
            {
              code: 'jnt',
              name: 'J&T Express',
              service: 'EZ',
              service_name: 'J&T Reguler',
              cost: isHeavy ? 24000 : 12000,
              etd: '2-3',
            },
            {
              code: 'jnt',
              name: 'J&T Express',
              service: 'JSD',
              service_name: 'J&T Super',
              cost: isHeavy ? 42000 : 25000,
              etd: '1',
            },
          ],
        }),
        { status: 200 }
      );
    }

    throw new Error(`Unexpected upstream URL: ${url}`);
  };

  await withCheckoutIntegrationServer(
    (app) => {
      app.get(
        '/api/shipping/locations',
        createKiriminAjaLocationsHandler({
          env,
          fetchImpl: mockKiriminAjaFetch,
          cache: locCache,
          checkRateLimit: () => true,
        })
      );
      app.post(
        '/api/shipping/jnt-rates',
        createKiriminAjaJntRatesHandler({
          fetchProductsByIds: async (productIds) => {
            const storeRef = store.context.db.collection('stores').doc('store_stage8');
            const snaps = await store.context.db.getAll(
              ...productIds.map((pid) => storeRef.collection('products').doc(pid))
            );
            return snaps.map((snap) => ({
              id: snap.id,
              exists: snap.exists,
              data: snap.exists ? snap.data() : undefined,
            }));
          },
          env,
          fetchImpl: mockKiriminAjaFetch,
          rateCache,
          checkRateLimit: () => true,
        })
      );
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env,
          fetchImpl: mockKiriminAjaFetch,
          rateCache,
          checkRateLimit: () => true,
        })
      );
      app.get(
        '/api/guest-orders/:orderNumber',
        createGuestOrderLookupHandler({
          getStoreContext: () => store.context,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);

      // Step 1: Search location via frontend shippingClient -> Express -> mock KiriminAja
      const locRes = await shippingClient.searchShippingLocations({
        search: 'Siman Ponorogo',
        limit: 10,
        fetchImpl: bridgeFetch,
      });
      assert.equal(locRes.ok, true);
      assert.equal(locRes.available, true);
      assert.equal(locRes.locations.length, 2);
      const chosenLocation = locRes.locations[0];
      assert.equal(chosenLocation.districtId, 5507);
      assert.equal(upstreamLocations, 1);

      // Step 2: Initial cart (1kg + 500g = 1500g) -> quote rates -> default cheapest EZ (12000)
      const riceProduct = makeProductFromSeed('prod_rice', store.products.prod_rice);
      const coffeeProduct = makeProductFromSeed(
        'prod_coffee',
        store.products.prod_coffee
      );
      const initialCart: CartItem[] = [
        { product: riceProduct, quantity: 1 },
        { product: coffeeProduct, quantity: 1 },
      ];

      const quote1 = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: chosenLocation.districtId,
        items: initialCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(quote1.ok, true);
      assert.equal(quote1.available, true);
      assert.equal(quote1.fallbackToManual, false);
      assert.equal(quote1.totalWeightGrams, 1500);
      assert.equal(quote1.itemsSubtotal, 100000);
      const defaultRate1 = shippingClient.selectDefaultJntRate(quote1.rates);
      assert.equal(defaultRate1?.serviceCode, 'EZ');
      assert.equal(defaultRate1?.cost, 12000);

      // User switches selected service to JSD (25000)
      const switchedRate = shippingClient.selectDefaultJntRate(quote1.rates, 'JSD');
      assert.equal(switchedRate?.serviceCode, 'JSD');
      assert.equal(switchedRate?.cost, 25000);

      // Step 3: Cart changes (rice qty 1 -> 2, weight 1500g -> 2500g) -> re-quote recalculates cost (42000) while preserving JSD
      const updatedCart: CartItem[] = [
        { product: riceProduct, quantity: 2 },
        { product: coffeeProduct, quantity: 1 },
      ];
      const quote2 = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: chosenLocation.districtId,
        items: updatedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(quote2.ok, true);
      assert.equal(quote2.totalWeightGrams, 2500);
      assert.equal(quote2.itemsSubtotal, 165000);
      const preservedJsd = shippingClient.selectDefaultJntRate(
        quote2.rates,
        switchedRate?.serviceCode
      );
      assert.equal(preservedJsd?.serviceCode, 'JSD');
      assert.equal(preservedJsd?.cost, 42000);
      assert.deepEqual(observedUpstreamWeights, [1500, 2500]);

      // Step 4: Build checkout payload + intentionally tamper client financial fields
      const idempotencyKey = 'stage8-full-delivery-key-001';
      const clientPayload = checkoutUtils.buildCreateGuestOrderPayload({
        customerName: 'Rina Kusuma',
        customerPhone: '081234567890',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Diponegoro No. 18, Siman, Ponorogo',
        destinationDistrictId: chosenLocation.districtId,
        selectedServiceCode: preservedJsd?.serviceCode,
        notes: 'Mohon kemas rapat',
        idempotencyKey,
        items: updatedCart,
      });

      const tamperedSubmission = {
        ...clientPayload,
        shippingFee: 1,
        totalAmount: 1,
        total: 1,
        itemsSubtotal: 1,
        weightGrams: 1,
        originDistrictId: 999999,
      };

      const createRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tamperedSubmission),
      });
      assert.equal(createRes.status, 201);
      // Warm rate cache from quote2 must avoid an extra upstream rate HTTP call on verify
      assert.equal(upstreamRates, 2);

      const createBody = (await createRes.json()) as { order: GuestOrder };
      const createdOrder = createBody.order;
      assert.equal(createdOrder.itemsSubtotal, 165000);
      assert.equal(createdOrder.shipping?.provider, 'JNT_EXPRESS');
      assert.equal(createdOrder.shipping?.serviceCode, 'JSD');
      assert.equal(createdOrder.shipping?.destinationDistrictId, 5507);
      assert.equal(createdOrder.shipping?.status, 'READY_TO_SHIP');
      assert.equal(createdOrder.shipping?.totalWeightGrams, 2500);
      assert.equal(createdOrder.shipping?.shippingFee, 42000);
      assert.equal(createdOrder.shipping?.shippingFeeConfirmed, true);
      assert.equal(createdOrder.totalAmount, 207000);
      assert.equal(createdOrder.stockDeducted, false);
      assert.equal(createdOrder.customerPhone, '*********7890');
      assert.equal(JSON.stringify(createBody).includes(secretToken), false);

      // Step 5: Lookup order via GET /api/guest-orders/:orderNumber
      const lookupRes = await bridgeFetch(
        `/api/guest-orders/${encodeURIComponent(createdOrder.orderNumber)}?phoneLast4=7890`
      );
      assert.equal(lookupRes.status, 200);
      const lookupBody = (await lookupRes.json()) as { order: GuestOrder };
      assert.equal(lookupBody.order.shipping?.serviceCode, 'JSD');
      assert.equal(lookupBody.order.shipping?.shippingFee, 42000);
      assert.equal(lookupBody.order.totalAmount, 207000);

      // Step 6: Verify OrderStatusPage renders confirmed shipping breakdown & J&T service
      const viewModel = orderShippingView.getJntShippingViewModel(lookupBody.order);
      assert.equal(viewModel?.serviceLabel, 'J&T Express · JSD');
      assert.equal(viewModel?.statusLabel, 'Menunggu pengiriman');
      assert.equal(viewModel?.totalLabel, 'Total Pembayaran');
      assert.equal(viewModel?.confirmedShippingFee, 42000);

      const statusHtml = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: lookupBody.order,
          recentOrders: [lookupBody.order],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(statusHtml, /J&amp;T Express · JSD/);
      assert.match(statusHtml, /Menunggu pengiriman/);
      assert.match(statusHtml, /Total Pembayaran/);
      assert.match(statusHtml, /42\.000/);
      assert.match(statusHtml, /207\.000/);

      // Step 7: Owner tracking update must preserve destinationDistrictId & verified fee (Stage 8 audit fix check)
      const ownerPatch = parseOwnerShippingUpdatePayload({
        trackingNumber: 'JP9988776655',
        status: 'PICKED_UP',
      });
      await store.context.db.runTransaction(async (tx) => {
        await updateGuestOrderShippingInTransaction(
          tx as Parameters<typeof updateGuestOrderShippingInTransaction>[0],
          store.storeRef as unknown as Parameters<
            typeof updateGuestOrderShippingInTransaction
          >[1],
          'store_stage8',
          createdOrder.id,
          ownerPatch
        );
      });

      const afterOwnerLookup = await bridgeFetch(
        `/api/guest-orders/${encodeURIComponent(createdOrder.orderNumber)}?phoneLast4=7890`
      );
      assert.equal(afterOwnerLookup.status, 200);
      const afterOwnerOrder = (
        (await afterOwnerLookup.json()) as { order: GuestOrder }
      ).order;
      assert.equal(afterOwnerOrder.shipping?.destinationDistrictId, 5507);
      assert.equal(afterOwnerOrder.shipping?.serviceCode, 'JSD');
      assert.equal(afterOwnerOrder.shipping?.shippingFee, 42000);
      assert.equal(afterOwnerOrder.shipping?.trackingNumber, 'JP9988776655');
      assert.equal(afterOwnerOrder.shipping?.status, 'PICKED_UP');
    }
  );
});

test('Stage 8 Integration — All 10 Fallback & Race-Condition Scenarios degrade cleanly to PENDING_RATE', async () => {
  clearKiriminAjaCaches();
  const secretToken = 'ka-stage8-fallback-secret';
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const store = createInMemoryGuestOrderStore('store_fallback', {
    prod_weighed: {
      id: 'prod_weighed',
      sku: 'W-1',
      name: 'Gula Pasir 1kg',
      price: 18000,
      stock: 30,
      unit: 'kg',
      weightGrams: 1000,
      isActive: true,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      sku: 'U-1',
      name: 'Kerupuk Curah',
      price: 12000,
      stock: 30,
      unit: 'bungkus',
      isActive: true,
    },
  });

  let envState: Record<string, string | undefined> = {
    KIRIMINAJA_API_KEY: secretToken,
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
    KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/v2/locations',
    KIRIMINAJA_LOCATION_SEARCH_METHOD: 'POST',
  };
  const envProxy = new Proxy(
    {},
    {
      get: (_t, prop) => (typeof prop === 'string' ? envState[prop] : undefined),
      ownKeys: () => Reflect.ownKeys(envState),
      getOwnPropertyDescriptor: (_t, prop) =>
        typeof prop === 'string' && prop in envState
          ? { enumerable: true, configurable: true, value: envState[prop] }
          : undefined,
    }
  ) as Record<string, string | undefined>;

  let allowLocationRateLimit = true;
  let allowRateLimit = true;
  let rateMode: 'ok' | 'empty' | 'timeout' | 'only_jsd' = 'ok';
  let slowDelayMs = 0;

  const mockUpstreamFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const bodyJson = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (slowDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
    }

    if (url.endsWith('/api/mitra/v2/locations')) {
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            {
              district_id: Number(bodyJson.search === 'babadan' ? 5783 : 5507),
              district_name: String(bodyJson.search || 'Siman'),
              city_name: 'Ponorogo',
              province_name: 'Jawa Timur',
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (rateMode === 'empty') {
      return new Response(JSON.stringify({ status: true, results: [] }), {
        status: 200,
      });
    }
    if (rateMode === 'timeout') {
      const err = new Error(`Request timeout with ${secretToken}`);
      err.name = 'TimeoutError';
      throw err;
    }
    if (rateMode === 'only_jsd') {
      return new Response(
        JSON.stringify({
          status: true,
          results: [
            {
              code: 'jnt',
              name: 'J&T Express',
              service: 'JSD',
              service_name: 'J&T Super',
              cost: 30000,
              etd: '1',
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'EZ',
            service_name: 'J&T Reguler',
            cost: 14000,
            etd: '2-3',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withCheckoutIntegrationServer(
    (app) => {
      app.get(
        '/api/shipping/locations',
        createKiriminAjaLocationsHandler({
          env: envProxy,
          fetchImpl: mockUpstreamFetch,
          cache: new BoundedTtlCache<ShippingLocationOption[]>(),
          checkRateLimit: () => allowLocationRateLimit,
        })
      );
      app.post(
        '/api/shipping/jnt-rates',
        createKiriminAjaJntRatesHandler({
          fetchProductsByIds: async (productIds) => {
            const storeRef = store.context.db
              .collection('stores')
              .doc('store_fallback');
            const snaps = await store.context.db.getAll(
              ...productIds.map((pid) => storeRef.collection('products').doc(pid))
            );
            return snaps.map((snap) => ({
              id: snap.id,
              exists: snap.exists,
              data: snap.exists ? snap.data() : undefined,
            }));
          },
          env: envProxy,
          fetchImpl: mockUpstreamFetch,
          rateCache,
          checkRateLimit: () => allowRateLimit,
        })
      );
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env: envProxy,
          fetchImpl: mockUpstreamFetch,
          rateCache,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);
      const weighedProduct = makeProductFromSeed(
        'prod_weighed',
        store.products.prod_weighed
      );
      const unweighedProduct = makeProductFromSeed(
        'prod_unweighed',
        store.products.prod_unweighed
      );
      const weighedCart: CartItem[] = [{ product: weighedProduct, quantity: 1 }];

      // 1. Location unavailable (path missing / unconfigured)
      envState = { KIRIMINAJA_API_KEY: secretToken, KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783' };
      const locUnavailable = await shippingClient.searchShippingLocations({
        search: 'ponorogo',
        fetchImpl: bridgeFetch,
      });
      assert.equal(locUnavailable.ok, true);
      assert.equal(locUnavailable.available, false);
      assert.deepEqual(locUnavailable.locations, []);

      // Restore valid env for remaining checks
      envState = {
        KIRIMINAJA_API_KEY: secretToken,
        KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
        KIRIMINAJA_LOCATION_SEARCH_PATH: '/api/mitra/v2/locations',
        KIRIMINAJA_LOCATION_SEARCH_METHOD: 'POST',
      };

      // 2. Rate unavailable (empty results) -> fallbackToManual: true + order submits as PENDING_RATE
      rateMode = 'empty';
      const emptyRateRes = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: weighedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(emptyRateRes.ok, true);
      assert.equal(emptyRateRes.available, false);
      assert.equal(emptyRateRes.fallbackToManual, true);

      const fallbackEmptyOrderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Fallback EmptyRate',
            customerPhone: '081200000001',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Pahlawan No. 1 Ponorogo',
            destinationDistrictId: 5507,
            notes: '',
            idempotencyKey: 'stage8-fb-empty-01',
            items: weighedCart,
          })
        ),
      });
      assert.equal(fallbackEmptyOrderRes.status, 201);
      const fallbackEmptyOrder = (
        (await fallbackEmptyOrderRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(fallbackEmptyOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(fallbackEmptyOrder.shipping?.shippingFee, 0);
      assert.equal(fallbackEmptyOrder.shipping?.shippingFeeConfirmed, false);

      // 3. Timeout during rate quote & order verification -> fallback PENDING_RATE without leaking secret
      rateMode = 'timeout';
      const timeoutRateRes = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5508,
        items: weighedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(timeoutRateRes.ok, true);
      assert.equal(timeoutRateRes.fallbackToManual, true);
      assert.equal(JSON.stringify(timeoutRateRes).includes(secretToken), false);

      const timeoutOrderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Fallback Timeout',
            customerPhone: '081200000002',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Pahlawan No. 2 Ponorogo',
            destinationDistrictId: 5508,
            selectedServiceCode: 'EZ',
            notes: '',
            idempotencyKey: 'stage8-fb-timeout-01',
            items: weighedCart,
          })
        ),
      });
      assert.equal(timeoutOrderRes.status, 201);
      const timeoutOrder = (
        (await timeoutOrderRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(timeoutOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(timeoutOrder.shipping?.serviceCode, undefined);

      // 4. Rate limit HTTP 429 on locations and rates -> friendly error; manual checkout still succeeds
      allowLocationRateLimit = false;
      allowRateLimit = false;
      const loc429 = await shippingClient.searchShippingLocations({
        search: 'ponorogo',
        fetchImpl: bridgeFetch,
      });
      assert.equal(loc429.ok, false);
      assert.equal(loc429.statusCode, 429);
      assert.match(loc429.errorMessage || '', /Terlalu banyak/);

      const rate429 = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: weighedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(rate429.ok, false);
      assert.equal(rate429.statusCode, 429);
      assert.equal(rate429.fallbackToManual, true);
      allowLocationRateLimit = true;
      allowRateLimit = true;

      // 5. Unweighed product -> hasUnweighedItems: true, fallback PENDING_RATE
      rateMode = 'ok';
      const unweighedQuote = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: [{ product: unweighedProduct, quantity: 1 }],
        fetchImpl: bridgeFetch,
      });
      assert.equal(unweighedQuote.ok, true);
      assert.equal(unweighedQuote.hasUnweighedItems, true);
      assert.equal(unweighedQuote.fallbackToManual, true);

      const unweighedOrderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Fallback Unweighed',
            customerPhone: '081200000003',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Pahlawan No. 3 Ponorogo',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            notes: '',
            idempotencyKey: 'stage8-fb-unweighed-01',
            items: [{ product: unweighedProduct, quantity: 1 }],
          })
        ),
      });
      assert.equal(unweighedOrderRes.status, 201);
      const unweighedOrder = (
        (await unweighedOrderRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(unweighedOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(unweighedOrder.shipping?.hasUnweighedItems, true);

      // 6. Selected service unavailable at submit time -> PENDING_RATE, no unverified serviceCode
      rateMode = 'only_jsd';
      const unavailableSvcOrderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Fallback StaleService',
            customerPhone: '081200000004',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Pahlawan No. 4 Ponorogo',
            destinationDistrictId: 5509,
            selectedServiceCode: 'EZ',
            notes: '',
            idempotencyKey: 'stage8-fb-stale-svc-01',
            items: weighedCart,
          })
        ),
      });
      assert.equal(unavailableSvcOrderRes.status, 201);
      const unavailableSvcOrder = (
        (await unavailableSvcOrderRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(unavailableSvcOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(unavailableSvcOrder.shipping?.serviceCode, undefined);
      assert.equal(unavailableSvcOrder.shipping?.shippingFee, 0);

      // 7. Cart changes invalidating prior rate (adding unweighed item to previously weighed cart)
      rateMode = 'ok';
      const validFirst = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: weighedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(validFirst.available, true);
      const invalidatedSecond = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: [
          { product: weighedProduct, quantity: 1 },
          { product: unweighedProduct, quantity: 1 },
        ],
        fetchImpl: bridgeFetch,
      });
      assert.equal(invalidatedSecond.available, false);
      assert.equal(invalidatedSecond.fallbackToManual, true);
      assert.equal(invalidatedSecond.hasUnweighedItems, true);
      assert.deepEqual(invalidatedSecond.rates, []);

      // 8 & 9. Aborted request + Stale slow response race condition prevention via AbortController
      const slowCtrl = new AbortController();
      slowDelayMs = 80;
      const slowPromise = shippingClient.searchShippingLocations({
        search: 'babadan',
        signal: slowCtrl.signal,
        fetchImpl: bridgeFetch,
      });

      // Immediately supersede with newer fast request and abort old request
      slowCtrl.abort();
      slowDelayMs = 0;
      const fastCtrl = new AbortController();
      const fastRes = await shippingClient.searchShippingLocations({
        search: 'siman',
        signal: fastCtrl.signal,
        fetchImpl: bridgeFetch,
      });
      const slowRes = await slowPromise;

      assert.equal(slowRes.aborted, true);
      assert.equal(slowRes.errorMessage, undefined);
      assert.equal(fastRes.aborted, false);
      assert.equal(fastRes.ok, true);
      assert.equal(fastRes.locations[0]?.districtName, 'siman');

      // 10. Network failure during rate lookup -> friendly fallback message
      const netErrQuote = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: weighedCart,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      });
      assert.equal(netErrQuote.ok, false);
      assert.equal(netErrQuote.aborted, false);
      assert.equal(netErrQuote.fallbackToManual, true);
      assert.match(netErrQuote.errorMessage || '', /konfirmasi ongkir/);
    }
  );
});

test('Stage 8 Integration — Idempotency, Parallel Double-Submit, Scope Isolation & Backward Compatibility', async () => {
  clearKiriminAjaCaches();
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const store = createInMemoryGuestOrderStore('store_idem', {
    prod_rice: {
      id: 'prod_rice',
      sku: 'RICE-1KG',
      name: 'Beras Pandan Wangi 1kg',
      price: 50000,
      stock: 50,
      unit: 'sak',
      weightGrams: 1000,
      isActive: true,
    },
  });

  const env = {
    KIRIMINAJA_API_KEY: 'ka-stage8-idem-secret',
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
  };

  let upstreamRateCalls = 0;
  const mockFetch: typeof fetch = async () => {
    upstreamRateCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'EZ',
            service_name: 'Reguler',
            cost: 15000,
            etd: '2-3',
          },
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'JSD',
            service_name: 'Super',
            cost: 29000,
            etd: '1',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withCheckoutIntegrationServer(
    (app) => {
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env,
          fetchImpl: mockFetch,
          rateCache,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);
      const riceProduct = makeProductFromSeed('prod_rice', store.products.prod_rice);
      const cart: CartItem[] = [{ product: riceProduct, quantity: 1 }];

      // Client signature checks across destination, service, pickup, and legacy delivery
      const sigDest5507Ez = checkoutUtils.buildCheckoutIdempotencySignature(
        cart,
        'delivery',
        'JNT_EXPRESS',
        { destinationDistrictId: 5507, selectedServiceCode: 'EZ' }
      );
      const sigDest5508Ez = checkoutUtils.buildCheckoutIdempotencySignature(
        cart,
        'delivery',
        'JNT_EXPRESS',
        { destinationDistrictId: 5508, selectedServiceCode: 'EZ' }
      );
      const sigDest5507Jsd = checkoutUtils.buildCheckoutIdempotencySignature(
        cart,
        'delivery',
        'JNT_EXPRESS',
        { destinationDistrictId: 5507, selectedServiceCode: 'JSD' }
      );
      const sigPickup = checkoutUtils.buildCheckoutIdempotencySignature(cart, 'pickup');
      const sigLegacyDelivery = checkoutUtils.buildCheckoutIdempotencySignature(
        cart,
        'delivery',
        'JNT_EXPRESS'
      );

      assert.equal(sigPickup, 'pickup::prod_rice:1');
      assert.equal(sigLegacyDelivery, 'delivery:JNT_EXPRESS::prod_rice:1');
      assert.notEqual(sigDest5507Ez, sigDest5508Ez);
      assert.notEqual(sigDest5507Ez, sigDest5507Jsd);

      // 1 & 2. Parallel simultaneous double-submit with identical idempotencyKey + scope -> 1 created (201) + 1 deduplicated (200)
      const parallelPayload = checkoutUtils.buildCreateGuestOrderPayload({
        customerName: 'Dwi DoubleSubmit',
        customerPhone: '081355551111',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Raya Ponorogo No. 88',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        notes: '',
        idempotencyKey: 'stage8-parallel-key-001',
        items: cart,
      });

      const [resA, resB] = await Promise.all([
        bridgeFetch('/api/guest-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parallelPayload),
        }),
        bridgeFetch('/api/guest-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parallelPayload),
        }),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 201]);
      const bodyA = (await resA.json()) as {
        order: GuestOrder;
        deduplicated?: boolean;
      };
      const bodyB = (await resB.json()) as {
        order: GuestOrder;
        deduplicated?: boolean;
      };
      assert.equal(bodyA.order.id, bodyB.order.id);
      assert.equal(bodyA.order.orderNumber, bodyB.order.orderNumber);
      assert.equal(
        Boolean(bodyA.deduplicated) || Boolean(bodyB.deduplicated),
        true
      );
      assert.equal(Object.keys(store.guestOrders).length, 1);

      // 3. Same key with DIFFERENT destinationDistrictId -> separate order (201)
      const diffDestRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...parallelPayload,
          destinationDistrictId: 5508,
        }),
      });
      assert.equal(diffDestRes.status, 201);
      const diffDestOrder = (
        (await diffDestRes.json()) as { order: GuestOrder }
      ).order;
      assert.notEqual(diffDestOrder.id, bodyA.order.id);
      assert.equal(diffDestOrder.shipping?.destinationDistrictId, 5508);

      // 4. Same key with DIFFERENT selectedServiceCode -> separate order (201) & reuses warm cache
      const callsBeforeJsd = upstreamRateCalls;
      const diffSvcRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...parallelPayload,
          selectedServiceCode: 'JSD',
        }),
      });
      assert.equal(diffSvcRes.status, 201);
      const diffSvcOrder = (
        (await diffSvcRes.json()) as { order: GuestOrder }
      ).order;
      assert.notEqual(diffSvcOrder.id, bodyA.order.id);
      assert.equal(diffSvcOrder.shipping?.serviceCode, 'JSD');
      assert.equal(diffSvcOrder.shipping?.shippingFee, 29000);
      assert.equal(upstreamRateCalls, callsBeforeJsd);

      // 5. Pickup payload preserves exact contract
      const pickupRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Ambil Toko',
            customerPhone: '081355552222',
            fulfillmentType: 'pickup',
            deliveryAddress: 'Ignored when pickup',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            notes: 'Ambil jam 4 sore',
            idempotencyKey: 'stage8-pickup-001',
            items: cart,
          })
        ),
      });
      assert.equal(pickupRes.status, 201);
      const pickupOrder = ((await pickupRes.json()) as { order: GuestOrder }).order;
      assert.equal(pickupOrder.fulfillmentType, 'pickup');
      assert.equal(pickupOrder.deliveryAddress, '');
      assert.equal(pickupOrder.shipping, undefined);
      assert.equal(pickupOrder.totalAmount, 50000);

      // 6. Legacy delivery without destination/service still works cleanly
      const legacyNoProviderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Legacy Delivery',
          customerPhone: '081355553333',
          fulfillmentType: 'delivery',
          deliveryAddress: 'Jl. Soekarno Hatta No. 10',
          idempotencyKey: 'stage8-legacy-delivery-001',
          items: [{ productId: 'prod_rice', quantity: 1 }],
        }),
      });
      assert.equal(legacyNoProviderRes.status, 201);
      const legacyNoProviderOrder = (
        (await legacyNoProviderRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(legacyNoProviderOrder.shipping?.provider, 'STORE_COURIER');
      assert.equal(legacyNoProviderOrder.totalAmount, 50000);
    }
  );
});

test('Stage 8 Integration — Regression Matrix across Pickup, Manual J&T (PENDING_RATE), Legacy Orders, Verified READY_TO_SHIP & CartCheckoutDrawer SSR', async () => {
  const legacyOrderId = 'gord_legacy_no_shipping_001';
  const legacyStoreCourierId = 'gord_legacy_store_courier_001';

  const store = createInMemoryGuestOrderStore(
    'store_regression',
    {
      prod_1: {
        id: 'prod_1',
        sku: 'SKU-01',
        name: 'Minyak Goreng 1L',
        price: 20000,
        stock: 20,
        unit: 'pouch',
        weightGrams: 1000,
        isActive: true,
      },
    },
    {
      [legacyOrderId]: {
        orderId: legacyOrderId,
        orderNumber: 'SPG-250101-LEG001',
        storeId: 'store_regression',
        customerName: 'Pelanggan Lama',
        customerPhone: '6281999990001',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Lama No. 9 Ponorogo',
        notes: '',
        items: [
          {
            productId: 'prod_1',
            sku: 'SKU-01',
            name: 'Minyak Goreng 1L',
            productName: 'Minyak Goreng 1L',
            quantity: 2,
            price: 20000,
            unitPrice: 20000,
            subtotal: 40000,
          },
        ],
        total: 40000,
        totalAmount: 40000,
        status: 'ACCEPTED',
        stockDeducted: false,
        createdAt: '2025-01-01T08:00:00.000Z',
        updatedAt: '2025-01-01T08:05:00.000Z',
      },
      [legacyStoreCourierId]: {
        orderId: legacyStoreCourierId,
        orderNumber: 'SPG-250101-LEG002',
        storeId: 'store_regression',
        customerName: 'Pelanggan Kurir Toko',
        customerPhone: '6281999990002',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Merdeka No. 2 Ponorogo',
        notes: '',
        items: [
          {
            productId: 'prod_1',
            sku: 'SKU-01',
            name: 'Minyak Goreng 1L',
            productName: 'Minyak Goreng 1L',
            quantity: 1,
            price: 20000,
            unitPrice: 20000,
            subtotal: 20000,
          },
        ],
        total: 20000,
        totalAmount: 20000,
        status: 'READY',
        stockDeducted: false,
        shipping: {
          provider: 'STORE_COURIER',
          shippingFee: 0,
          shippingFeeConfirmed: true,
        },
        createdAt: '2025-01-01T09:00:00.000Z',
        updatedAt: '2025-01-01T09:05:00.000Z',
      },
    }
  );

  await withCheckoutIntegrationServer(
    (app) => {
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env: {},
          checkRateLimit: () => true,
        })
      );
      app.get(
        '/api/guest-orders/:orderNumber',
        createGuestOrderLookupHandler({
          getStoreContext: () => store.context,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);

      // 1. Legacy order lookup without shipping field
      const legacy1Res = await bridgeFetch(
        '/api/guest-orders/SPG-250101-LEG001?phoneLast4=0001'
      );
      assert.equal(legacy1Res.status, 200);
      const legacy1 = ((await legacy1Res.json()) as { order: GuestOrder }).order;
      assert.equal(orderShippingView.getJntShippingViewModel(legacy1), null);
      const legacy1Html = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: legacy1,
          recentOrders: [legacy1],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(legacy1Html, /SPG-250101-LEG001/);
      assert.match(legacy1Html, /Total Pembayaran/);

      // 2. Legacy STORE_COURIER order lookup
      const legacy2Res = await bridgeFetch(
        '/api/guest-orders/SPG-250101-LEG002?phoneLast4=0002'
      );
      assert.equal(legacy2Res.status, 200);
      const legacy2 = ((await legacy2Res.json()) as { order: GuestOrder }).order;
      assert.equal(orderShippingView.getJntShippingViewModel(legacy2), null);

      // 3. Pickup order create + OrderStatusPage render
      const pickupCreateRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Hana Pickup',
            customerPhone: '081999990003',
            fulfillmentType: 'pickup',
            deliveryAddress: '',
            notes: '',
            idempotencyKey: 'stage8-reg-pickup-01',
            items: [
              {
                product: makeProductFromSeed('prod_1', store.products.prod_1),
                quantity: 1,
              },
            ],
          })
        ),
      });
      assert.equal(pickupCreateRes.status, 201);
      const pickupOrder = (
        (await pickupCreateRes.json()) as { order: GuestOrder }
      ).order;
      const pickupHtml = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: pickupOrder,
          recentOrders: [pickupOrder],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(pickupHtml, /Ambil di Toko/);
      assert.match(pickupHtml, /Total Pembayaran/);

      // 4. Manual J&T delivery (PENDING_RATE) renders "Total Sementara" & Owner confirmation copy
      const manualJntRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Joko Manual',
            customerPhone: '081999990004',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Basuki Rahmat No. 12 Ponorogo',
            notes: '',
            idempotencyKey: 'stage8-reg-manual-jnt-01',
            items: [
              {
                product: makeProductFromSeed('prod_1', store.products.prod_1),
                quantity: 2,
              },
            ],
          })
        ),
      });
      assert.equal(manualJntRes.status, 201);
      const manualJntOrder = (
        (await manualJntRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(manualJntOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(manualJntOrder.shipping?.shippingFeeConfirmed, false);

      const manualHtml = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: manualJntOrder,
          recentOrders: [manualJntOrder],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(manualHtml, /Menunggu konfirmasi ongkir/);
      assert.match(manualHtml, /Menunggu konfirmasi Owner/);
      assert.match(manualHtml, /Total Sementara/);

      // 5. CartCheckoutDrawer SSR renders cleanly without errors
      const drawerHtml = renderToStaticMarkup(
        React.createElement(CartCheckoutDrawer, {
          isOpen: true,
          items: [
            {
              product: makeProductFromSeed('prod_1', store.products.prod_1),
              quantity: 2,
            },
          ],
          onClose: () => {},
          onUpdateQty: () => {},
          onRemoveItem: () => {},
          onOrderCreated: () => {},
        })
      );
      assert.match(drawerHtml, /Keranjang Belanja/);
      assert.match(drawerHtml, /Minyak Goreng 1L/);
    }
  );
});

test('Stage 10 Integration — Shipping Fee Confirmation Guard, 409 Conflict Matrix, Zero Temp Orders, Anti-Tamper & Honest UI Copy', async () => {
  clearKiriminAjaCaches();
  let fakeNowMs = 1_700_000_000_000;
  const secretToken = 'ka-stage10-secret-token';
  const rateCache = new BoundedTtlCache<JntRateOption[]>({
    maxEntries: 300,
    defaultTtlMs: 10 * 60 * 1000,
  });

  const store = createInMemoryGuestOrderStore('store_stage10', {
    prod_weighed: {
      id: 'prod_weighed',
      sku: 'S10-W',
      name: 'Beras Setra Ramos 1kg',
      price: 50000,
      stock: 40,
      unit: 'sak',
      weightGrams: 1000,
      isActive: true,
    },
    prod_unweighed: {
      id: 'prod_unweighed',
      sku: 'S10-U',
      name: 'Kue Kering Toples',
      price: 25000,
      stock: 40,
      unit: 'toples',
      isActive: true,
    },
  });

  const env = {
    KIRIMINAJA_API_KEY: secretToken,
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
  };

  type UpstreamScenario =
    | 'initial_15k'
    | 'changed_18k'
    | 'only_jsd'
    | 'empty'
    | 'timeout'
    | 'network_error';
  let scenario: UpstreamScenario = 'initial_15k';

  const mockFetch: typeof fetch = async () => {
    if (scenario === 'timeout') {
      const err = new Error(`Upstream timeout with ${secretToken}`);
      err.name = 'TimeoutError';
      throw err;
    }
    if (scenario === 'network_error') {
      throw new TypeError(`ECONNREFUSED ${secretToken}`);
    }
    if (scenario === 'empty') {
      return new Response(JSON.stringify({ status: true, results: [] }), {
        status: 200,
      });
    }
    if (scenario === 'only_jsd') {
      return new Response(
        JSON.stringify({
          status: true,
          results: [
            {
              code: 'jnt',
              name: 'J&T Express',
              service: 'JSD',
              service_name: 'J&T Super',
              cost: 29000,
              etd: '1',
            },
          ],
        }),
        { status: 200 }
      );
    }
    const ezCost = scenario === 'changed_18k' ? 18000 : 15000;
    return new Response(
      JSON.stringify({
        status: true,
        results: [
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'EZ',
            service_name: 'J&T Reguler',
            cost: ezCost,
            etd: '2-3',
          },
          {
            code: 'jnt',
            name: 'J&T Express',
            service: 'JSD',
            service_name: 'J&T Super',
            cost: 29000,
            etd: '1',
          },
        ],
      }),
      { status: 200 }
    );
  };

  await withCheckoutIntegrationServer(
    (app) => {
      app.post(
        '/api/shipping/jnt-rates',
        createKiriminAjaJntRatesHandler({
          fetchProductsByIds: async (productIds) => {
            const storeRef = store.context.db
              .collection('stores')
              .doc('store_stage10');
            const snaps = await store.context.db.getAll(
              ...productIds.map((pid) => storeRef.collection('products').doc(pid))
            );
            return snaps.map((snap) => ({
              id: snap.id,
              exists: snap.exists,
              data: snap.exists ? snap.data() : undefined,
            }));
          },
          env,
          fetchImpl: mockFetch,
          rateCache,
          now: () => fakeNowMs,
          checkRateLimit: () => true,
        })
      );
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env,
          fetchImpl: mockFetch,
          rateCache,
          now: () => fakeNowMs,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);
      const weighedProduct = makeProductFromSeed(
        'prod_weighed',
        store.products.prod_weighed
      );
      const unweighedProduct = makeProductFromSeed(
        'prod_unweighed',
        store.products.prod_unweighed
      );
      const weighedCart: CartItem[] = [{ product: weighedProduct, quantity: 1 }];

      // Scenario 1: Server verified fee equals browser expectedShippingFee -> 201 READY_TO_SHIP
      scenario = 'initial_15k';
      const q1 = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: weighedCart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(q1.ok, true);
      assert.equal(q1.rates[0]?.cost, 15000);

      const matchPayload = checkoutUtils.buildCreateGuestOrderPayload({
        customerName: 'Nadia Cocok',
        customerPhone: '081277770001',
        fulfillmentType: 'delivery',
        deliveryAddress: 'Jl. Ahmad Yani No. 5 Ponorogo',
        destinationDistrictId: 5507,
        selectedServiceCode: 'EZ',
        expectedShippingFee: 15000,
        notes: '',
        idempotencyKey: 'stage10-match-001',
        items: weighedCart,
      });
      const matchRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(matchPayload),
      });
      assert.equal(matchRes.status, 201);
      const matchOrder = ((await matchRes.json()) as { order: GuestOrder }).order;
      assert.equal(matchOrder.shipping?.status, 'READY_TO_SHIP');
      assert.equal(matchOrder.shipping?.shippingFee, 15000);
      assert.equal(matchOrder.shipping?.shippingFeeConfirmed, true);
      assert.equal(matchOrder.totalAmount, 65000);
      assert.equal(Object.keys(store.guestOrders).length, 1);

      // Verify OrderStatusPage honesty on READY_TO_SHIP without AWB (no false AWB/handoff claim)
      const readyHtml = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: matchOrder,
          recentOrders: [matchOrder],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(readyHtml, /Terkonfirmasi/);
      assert.match(readyHtml, /Total Pembayaran/);
      assert.match(readyHtml, /Menunggu pengiriman/);
      assert.match(readyHtml, /Nomor resi belum tersedia/);

      // Scenario 2: Cache expires (>10m) & rate shifts 15000 -> 18000 => 409 conflict & ZERO temp order, then approve => 1 order created
      fakeNowMs += 11 * 60 * 1000;
      scenario = 'changed_18k';

      // Tampering attempt with fake low expectedShippingFee=1 also blocked cleanly by 409
      const tamperRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Tama Berubah',
            customerPhone: '081277770002',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Ahmad Yani No. 6 Ponorogo',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            expectedShippingFee: 1,
            notes: '',
            idempotencyKey: 'stage10-tamper-001',
            items: weighedCart,
          }),
          shippingFee: 1,
          totalAmount: 1,
          itemsSubtotal: 1,
        }),
      });
      assert.equal(tamperRes.status, 409);
      const tamperBody = (await tamperRes.json()) as Record<string, unknown>;
      assert.equal(tamperBody.code, 'SHIPPING_RATE_CHANGED');
      assert.equal(tamperBody.verifiedShippingFee, 18000);
      assert.equal(Object.keys(store.guestOrders).length, 1);

      // Genuine stale estimate 15000 -> 409 SHIPPING_RATE_CHANGED, still 0 new orders in DB
      const driftConflictRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Tama Berubah',
            customerPhone: '081277770002',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Ahmad Yani No. 6 Ponorogo',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            expectedShippingFee: 15000,
            notes: '',
            idempotencyKey: 'stage10-drift-001',
            items: weighedCart,
          })
        ),
      });
      assert.equal(driftConflictRes.status, 409);
      const driftConflict = (await driftConflictRes.json()) as Record<string, unknown>;
      assert.equal(driftConflict.code, 'SHIPPING_RATE_CHANGED');
      assert.equal(driftConflict.expectedShippingFee, 15000);
      assert.equal(driftConflict.verifiedShippingFee, 18000);
      assert.equal(driftConflict.verifiedShippingStatus, 'READY_TO_SHIP');
      assert.equal(driftConflict.fallbackToManual, false);
      assert.equal(Object.keys(store.guestOrders).length, 1);

      // Customer approves new tariff (18000) -> 201 created once
      const driftApproveRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Tama Berubah',
            customerPhone: '081277770002',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Ahmad Yani No. 6 Ponorogo',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            expectedShippingFee: 18000,
            notes: '',
            idempotencyKey: 'stage10-drift-002',
            items: weighedCart,
          })
        ),
      });
      assert.equal(driftApproveRes.status, 201);
      const driftOrder = ((await driftApproveRes.json()) as { order: GuestOrder }).order;
      assert.equal(driftOrder.shipping?.shippingFee, 18000);
      assert.equal(driftOrder.totalAmount, 68000);
      assert.equal(Object.keys(store.guestOrders).length, 2);

      // Scenario 9 (Idempotency after confirmed creation): retrying SAME key 'stage10-match-001' even after rate/network shifts returns 200 deduplicated without firing 409!
      const retryConfirmedRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(matchPayload),
      });
      assert.equal(retryConfirmedRes.status, 200);
      const retryBody = (await retryConfirmedRes.json()) as {
        order: GuestOrder;
        deduplicated?: boolean;
      };
      assert.equal(retryBody.deduplicated, true);
      assert.equal(retryBody.order.id, matchOrder.id);
      assert.equal(retryBody.order.shipping?.shippingFee, 15000);
      assert.equal(Object.keys(store.guestOrders).length, 2);

      // Scenarios 3, 4, 5, 6: Fallback causes when browser expected auto-rate -> 409 fallbackToManual=true, zero temp orders; approving manual creates PENDING_RATE
      const fallbackScenarios: Array<{
        name: string;
        mode: UpstreamScenario;
        serviceCode: string;
      }> = [
        { name: 'missing-service', mode: 'only_jsd', serviceCode: 'EZ' },
        { name: 'empty-rates', mode: 'empty', serviceCode: 'EZ' },
        { name: 'timeout', mode: 'timeout', serviceCode: 'EZ' },
        { name: 'network-error', mode: 'network_error', serviceCode: 'EZ' },
      ];

      for (const fb of fallbackScenarios) {
        fakeNowMs += 11 * 60 * 1000;
        scenario = fb.mode;

        const ordersBefore = Object.keys(store.guestOrders).length;
        const conflictRes = await bridgeFetch('/api/guest-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            checkoutUtils.buildCreateGuestOrderPayload({
              customerName: `Fallback ${fb.name}`,
              customerPhone: '081277770009',
              fulfillmentType: 'delivery',
              deliveryAddress: 'Jl. Surodikraman No. 12 Ponorogo',
              destinationDistrictId: 5507,
              selectedServiceCode: fb.serviceCode,
              expectedShippingFee: 18000,
              notes: '',
              idempotencyKey: `stage10-fb-${fb.name}-1`,
              items: weighedCart,
            })
          ),
        });
        assert.equal(conflictRes.status, 409, `${fb.name} should return 409`);
        const conflictJson = (await conflictRes.json()) as Record<string, unknown>;
        assert.equal(conflictJson.code, 'SHIPPING_RATE_CHANGED');
        assert.equal(conflictJson.fallbackToManual, true);
        assert.equal(conflictJson.verifiedShippingStatus, 'PENDING_RATE');
        assert.equal(conflictJson.verifiedShippingFee, 0);
        assert.equal(JSON.stringify(conflictJson).includes(secretToken), false);
        assert.equal(Object.keys(store.guestOrders).length, ordersBefore);

        // User approves manual shipping fallback
        const manualApproveRes = await bridgeFetch('/api/guest-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            checkoutUtils.buildCreateGuestOrderPayload({
              customerName: `Fallback ${fb.name}`,
              customerPhone: '081277770009',
              fulfillmentType: 'delivery',
              deliveryAddress: 'Jl. Surodikraman No. 12 Ponorogo',
              destinationDistrictId: 5507,
              notes: '',
              idempotencyKey: `stage10-fb-${fb.name}-2`,
              items: weighedCart,
            })
          ),
        });
        assert.equal(manualApproveRes.status, 201);
        const manualOrder = (
          (await manualApproveRes.json()) as { order: GuestOrder }
        ).order;
        assert.equal(manualOrder.shipping?.status, 'PENDING_RATE');
        assert.equal(manualOrder.shipping?.shippingFee, 0);
        assert.equal(manualOrder.shipping?.shippingFeeConfirmed, false);
        assert.equal(manualOrder.totalAmount, 50000);
        assert.equal(Object.keys(store.guestOrders).length, ordersBefore + 1);
      }

      // Scenario 7: Unweighed item included while submitting expectedShippingFee -> 409 fallbackToManual=true + hasUnweighedItems=true; manual approval saves PENDING_RATE
      fakeNowMs += 11 * 60 * 1000;
      scenario = 'initial_15k';
      const mixedCart: CartItem[] = [
        { product: weighedProduct, quantity: 1 },
        { product: unweighedProduct, quantity: 1 },
      ];
      const ordersBeforeUnweighed = Object.keys(store.guestOrders).length;
      const unweighedConflictRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Unweighed Conflict',
            customerPhone: '081277770010',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Merdeka No. 99 Ponorogo',
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            expectedShippingFee: 15000,
            notes: '',
            idempotencyKey: 'stage10-unweighed-1',
            items: mixedCart,
          })
        ),
      });
      assert.equal(unweighedConflictRes.status, 409);
      const unweighedConflict = (await unweighedConflictRes.json()) as Record<
        string,
        unknown
      >;
      assert.equal(unweighedConflict.code, 'SHIPPING_RATE_CHANGED');
      assert.equal(unweighedConflict.fallbackToManual, true);
      assert.equal(unweighedConflict.hasUnweighedItems, true);
      assert.equal(Object.keys(store.guestOrders).length, ordersBeforeUnweighed);

      const unweighedManualRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Unweighed Conflict',
            customerPhone: '081277770010',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Merdeka No. 99 Ponorogo',
            destinationDistrictId: 5507,
            notes: '',
            idempotencyKey: 'stage10-unweighed-2',
            items: mixedCart,
          })
        ),
      });
      assert.equal(unweighedManualRes.status, 201);
      const unweighedOrder = (
        (await unweighedManualRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(unweighedOrder.shipping?.status, 'PENDING_RATE');
      assert.equal(unweighedOrder.shipping?.hasUnweighedItems, true);
      assert.equal(unweighedOrder.shipping?.shippingFeeConfirmed, false);

      // Scenario 8: Invalid expectedShippingFee combinations rejected 400 (pickup, STORE_COURIER, negative)
      const invalidCases = [
        {
          customerName: 'Invalid Pickup Fee',
          customerPhone: '081277770011',
          fulfillmentType: 'pickup',
          deliveryAddress: '',
          expectedShippingFee: 15000,
          idempotencyKey: 'stage10-invalid-pickup',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
        {
          customerName: 'Invalid Manual Fee',
          customerPhone: '081277770011',
          fulfillmentType: 'delivery',
          deliveryAddress: 'Jl. Invalid No. 1 Ponorogo',
          shippingProvider: 'STORE_COURIER',
          expectedShippingFee: 15000,
          idempotencyKey: 'stage10-invalid-store',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
        {
          customerName: 'Negative Fee',
          customerPhone: '081277770011',
          fulfillmentType: 'delivery',
          deliveryAddress: 'Jl. Invalid No. 2 Ponorogo',
          shippingProvider: 'JNT_EXPRESS',
          destinationDistrictId: 5507,
          selectedServiceCode: 'EZ',
          expectedShippingFee: -100,
          idempotencyKey: 'stage10-invalid-neg',
          items: [{ productId: 'prod_weighed', quantity: 1 }],
        },
      ];

      for (const badBody of invalidCases) {
        const badRes = await bridgeFetch('/api/guest-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(badBody),
        });
        assert.equal(badRes.status, 400);
      }
    }
  );
});

test('Stage 12 Integration — Cascading LokaID Regions, Structured Delivery Address Persistence, Isolation from J&T Tariffs & Legacy/Pickup Compatibility', async () => {
  clearKiriminAjaCaches();
  clearRegionCaches();

  const store = createInMemoryGuestOrderStore('store_stage12', {
    prod_1: {
      id: 'prod_1',
      sku: 'S12-1',
      name: 'Beras Organik 2kg',
      price: 45000,
      stock: 20,
      unit: 'pack',
      weightGrams: 2000,
      isActive: true,
    },
  });

  const env = {
    KIRIMINAJA_API_KEY: 'ka-stage12-secret',
    KIRIMINAJA_ORIGIN_DISTRICT_ID: '5783',
  };

  let kiriminAjaRateCalls = 0;

  const mockUpstreamFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://lokaid.gilangpratama.id/states') {
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
    if (url === 'https://lokaid.gilangpratama.id/states/35/cities') {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [{ code: '35.02', value: 'KAB. PONOROGO' }],
        }),
        { status: 200 }
      );
    }
    if (url === 'https://lokaid.gilangpratama.id/cities/35.02/districts') {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [{ code: '35.02.17', value: 'PONOROGO' }],
        }),
        { status: 200 }
      );
    }
    if (url === 'https://lokaid.gilangpratama.id/districts/35.02.17/villages') {
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'SUCCESS',
          data: [{ code: '35.02.17.1001', value: 'SURODIKRAMAN' }],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith('/api/mitra/v6.1/shipping_price')) {
      kiriminAjaRateCalls += 1;
      return new Response(
        JSON.stringify({
          status: true,
          results: [
            {
              code: 'jnt',
              name: 'J&T Express',
              service: 'EZ',
              service_name: 'J&T Reguler',
              cost: 22000,
              etd: '2-3',
            },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };

  await withCheckoutIntegrationServer(
    (app) => {
      const regionDeps = {
        fetchImpl: mockUpstreamFetch,
        cache: new BoundedTtlCache<RegionOption[]>(),
        checkRateLimit: () => true,
      };
      app.get('/api/regions/provinces', createRegionProvincesHandler(regionDeps));
      app.get(
        '/api/regions/provinces/:stateCode/cities',
        createRegionCitiesHandler(regionDeps)
      );
      app.get(
        '/api/regions/cities/:cityCode/districts',
        createRegionDistrictsHandler(regionDeps)
      );
      app.get(
        '/api/regions/districts/:districtCode/villages',
        createRegionVillagesHandler(regionDeps)
      );
      app.post(
        '/api/shipping/jnt-rates',
        createKiriminAjaJntRatesHandler({
          fetchProductsByIds: async (productIds) => {
            const storeRef = store.context.db
              .collection('stores')
              .doc('store_stage12');
            const snaps = await store.context.db.getAll(
              ...productIds.map((pid) => storeRef.collection('products').doc(pid))
            );
            return snaps.map((snap) => ({
              id: snap.id,
              exists: snap.exists,
              data: snap.exists ? snap.data() : undefined,
            }));
          },
          env,
          fetchImpl: mockUpstreamFetch,
          rateCache: new BoundedTtlCache<JntRateOption[]>(),
          checkRateLimit: () => true,
        })
      );
      app.post(
        '/api/guest-orders',
        createGuestOrdersHandler({
          getStoreContext: () => store.context,
          env,
          fetchImpl: mockUpstreamFetch,
          rateCache: new BoundedTtlCache<JntRateOption[]>(),
          checkRateLimit: () => true,
        })
      );
      app.get(
        '/api/guest-orders/:orderNumber',
        createGuestOrderLookupHandler({
          getStoreContext: () => store.context,
          checkRateLimit: () => true,
        })
      );
    },
    async (baseUrl) => {
      const bridgeFetch = createLocalBridgeFetch(baseUrl);
      const product1 = makeProductFromSeed('prod_1', store.products.prod_1);
      const cart: CartItem[] = [{ product: product1, quantity: 1 }];

      // 1. Cascading region selection never triggers KiriminAja rate calls
      const provinces = await regionClient.fetchRegionProvinces({
        fetchImpl: bridgeFetch,
      });
      const jawaTimur = provinces.regions.find((p) => p.code === '35')!;
      assert.equal(jawaTimur.name, 'JAWA TIMUR');

      const cities = await regionClient.fetchRegionCities(jawaTimur.code, {
        fetchImpl: bridgeFetch,
      });
      const ponorogoCity = cities.regions[0];
      assert.equal(ponorogoCity.code, '35.02');

      const districts = await regionClient.fetchRegionDistricts(ponorogoCity.code, {
        fetchImpl: bridgeFetch,
      });
      const ponorogoDist = districts.regions[0];
      assert.equal(ponorogoDist.code, '35.02.17');

      const villages = await regionClient.fetchRegionVillages(ponorogoDist.code, {
        fetchImpl: bridgeFetch,
      });
      const surodikramanVillage = villages.regions[0];
      assert.equal(surodikramanVillage.code, '35.02.17.1001');
      assert.equal(kiriminAjaRateCalls, 0);

      // 2. Compose structured delivery address (street + 4 region levels, no houseNumber/RT-RW/patokan)
      const structuredAddress = checkoutUtils.formatStructuredDeliveryAddress({
        province: jawaTimur,
        city: ponorogoCity,
        district: ponorogoDist,
        village: surodikramanVillage,
        streetAddress: 'Jl. Jenderal Sudirman Barat Perumahan Graha Indah Asri',
      });
      assert.equal(
        structuredAddress,
        'Jl. Jenderal Sudirman Barat Perumahan Graha Indah Asri, Kel./Desa SURODIKRAMAN (35.02.17.1001), Kec. PONOROGO (35.02.17), KAB. PONOROGO (35.02), Prov. JAWA TIMUR (35)'
      );
      assert.ok(!structuredAddress.includes('RT/RW'));
      assert.ok(!structuredAddress.includes('Patokan:'));

      // 3. J&T shipping tariff remains strictly isolated from region selection
      const quoteRes = await shippingClient.quoteJntShippingRates({
        destinationDistrictId: 5507,
        items: cart,
        fetchImpl: bridgeFetch,
      });
      assert.equal(quoteRes.ok, true);
      assert.equal(quoteRes.rates[0]?.cost, 22000);

      const orderRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Budi Wilayah',
            customerPhone: '081288880001',
            fulfillmentType: 'delivery',
            deliveryAddress: structuredAddress,
            destinationDistrictId: 5507,
            selectedServiceCode: 'EZ',
            expectedShippingFee: 22000,
            notes: '',
            idempotencyKey: 'stage12-structured-addr-01',
            items: cart,
          })
        ),
      });
      assert.equal(orderRes.status, 201);
      const createdOrder = ((await orderRes.json()) as { order: GuestOrder }).order;
      assert.equal(createdOrder.deliveryAddress, structuredAddress);
      assert.equal(createdOrder.shipping?.status, 'READY_TO_SHIP');
      assert.equal(createdOrder.shipping?.shippingFee, 22000);
      assert.equal(createdOrder.totalAmount, 67000);

      // 4. Lookup & OrderStatusPage display full structured address cleanly
      const lookupRes = await bridgeFetch(
        `/api/guest-orders/${encodeURIComponent(createdOrder.orderNumber)}?phoneLast4=0001`
      );
      assert.equal(lookupRes.status, 200);
      const loadedOrder = ((await lookupRes.json()) as { order: GuestOrder }).order;
      assert.equal(loadedOrder.deliveryAddress, structuredAddress);
      const statusHtml = renderToStaticMarkup(
        React.createElement(OrderStatusPage, {
          activeOrder: loadedOrder,
          recentOrders: [loadedOrder],
          onOrderLoaded: () => {},
          onBackToCatalog: () => {},
        })
      );
      assert.match(statusHtml, /SURODIKRAMAN \(35\.02\.17\.1001\)/);
      assert.match(statusHtml, /JAWA TIMUR \(35\)/);

      // 5. Legacy manual address format & pickup remain unaffected
      const legacyManualRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Legacy Manual',
            customerPhone: '081288880002',
            fulfillmentType: 'delivery',
            deliveryAddress: 'Jl. Alamat Bebas Tanpa Dropdown No. 7',
            notes: '',
            idempotencyKey: 'stage12-legacy-addr-01',
            items: cart,
          })
        ),
      });
      assert.equal(legacyManualRes.status, 201);
      const legacyOrder = (
        (await legacyManualRes.json()) as { order: GuestOrder }
      ).order;
      assert.equal(
        legacyOrder.deliveryAddress,
        'Jl. Alamat Bebas Tanpa Dropdown No. 7'
      );
      assert.equal(legacyOrder.shipping?.status, 'PENDING_RATE');

      const pickupRes = await bridgeFetch('/api/guest-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkoutUtils.buildCreateGuestOrderPayload({
            customerName: 'Ambil Langsung',
            customerPhone: '081288880003',
            fulfillmentType: 'pickup',
            deliveryAddress: 'Should stay empty',
            notes: '',
            idempotencyKey: 'stage12-pickup-01',
            items: cart,
          })
        ),
      });
      assert.equal(pickupRes.status, 201);
      const pickupOrder = ((await pickupRes.json()) as { order: GuestOrder }).order;
      assert.equal(pickupOrder.deliveryAddress, '');
      assert.equal(pickupOrder.shipping, undefined);
    }
  );
});


