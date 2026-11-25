import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'firebase-admin/firestore';
import {
  computeValidatedItemsSubtotalFromOrderDoc,
  parseOwnerShippingUpdatePayload,
  updateGuestOrderShippingInTransaction,
} from './server.ts';
import {
  OwnerOrderActionError,
  type StoreRefLike,
  type TxLike,
} from './src/server/ownerOrderManagement.ts';

type DocMap = Record<string, DocumentData>;

interface InMemoryStoreData {
  guest_orders: DocMap;
  products: DocMap;
  sales: DocMap;
  transactions: DocMap;
}

function cloneData<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function createInMemoryFirestore(initial: Partial<InMemoryStoreData>) {
  const state: InMemoryStoreData = {
    guest_orders: cloneData(initial.guest_orders ?? {}),
    products: cloneData(initial.products ?? {}),
    sales: cloneData(initial.sales ?? {}),
    transactions: cloneData(initial.transactions ?? {}),
  };

  let commitVersion = 0;

  function makeDocRef(
    colName: keyof InMemoryStoreData,
    id: string
  ): DocumentReference {
    return {
      id,
      path: `stores/store_owner_1/${colName}/${id}`,
      _colName: colName,
    } as unknown as DocumentReference;
  }

  function makeQuery(
    colName: keyof InMemoryStoreData,
    filters: Array<{ field: string; value: unknown }> = []
  ): Query {
    return {
      _colName: colName,
      _filters: filters,
      where(field: string, _op: string, value: unknown) {
        return makeQuery(colName, [...filters, { field, value }]);
      },
      limit() {
        return this;
      },
    } as unknown as Query;
  }

  const storeRef: StoreRefLike = {
    collection(name: string) {
      const colName = name as keyof InMemoryStoreData;
      return {
        doc(id: string) {
          return makeDocRef(colName, id);
        },
        where(field: string, _op: string, value: unknown) {
          return makeQuery(colName, [{ field, value }]);
        },
      } as unknown as CollectionReference;
    },
  };

  async function runTransaction<T>(
    fn: (tx: TxLike) => Promise<T>,
    options?: { simulateConflictBeforeFirstCommit?: () => void }
  ): Promise<T> {
    let simulatedOnce = false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const startVersion = commitVersion;
      const pendingUpdates: Array<{
        colName: keyof InMemoryStoreData;
        id: string;
        patch: Record<string, unknown>;
      }> = [];

      async function mockGet(ref: DocumentReference): Promise<DocumentSnapshot>;
      async function mockGet(query: Query): Promise<QuerySnapshot>;
      async function mockGet(
        refOrQuery: DocumentReference | Query
      ): Promise<DocumentSnapshot | QuerySnapshot> {
        const maybeRef = refOrQuery as unknown as {
          _colName?: keyof InMemoryStoreData;
          id?: string;
          _filters?: Array<{ field: string; value: unknown }>;
        };

        if (maybeRef.id && maybeRef._colName && !maybeRef._filters) {
          const raw = state[maybeRef._colName][maybeRef.id];
          return {
            id: maybeRef.id,
            ref: refOrQuery as DocumentReference,
            exists: raw !== undefined,
            data: () => (raw ? cloneData(raw) : undefined),
          } as unknown as DocumentSnapshot;
        }

        const colName = maybeRef._colName ?? 'sales';
        const filters = maybeRef._filters ?? [];
        const docs: QueryDocumentSnapshot[] = [];
        for (const [docId, docData] of Object.entries(state[colName])) {
          const matched = filters.every((f) => docData[f.field] === f.value);
          if (matched) {
            docs.push({
              id: docId,
              exists: true,
              data: () => cloneData(docData),
            } as unknown as QueryDocumentSnapshot);
          }
        }
        return {
          empty: docs.length === 0,
          docs,
        } as unknown as QuerySnapshot;
      }

      const tx: TxLike = {
        get: mockGet,
        async getAll(...refs: DocumentReference[]) {
          return Promise.all(refs.map((r) => mockGet(r)));
        },
        update(ref: DocumentReference, patch: Record<string, unknown>) {
          const meta = ref as unknown as {
            _colName: keyof InMemoryStoreData;
            id: string;
          };
          pendingUpdates.push({
            colName: meta._colName,
            id: meta.id,
            patch,
          });
        },
        delete() {
          throw new Error('delete not expected in shipping tests');
        },
      };

      const result = await fn(tx);

      if (
        !simulatedOnce &&
        options?.simulateConflictBeforeFirstCommit &&
        pendingUpdates.length > 0
      ) {
        simulatedOnce = true;
        options.simulateConflictBeforeFirstCommit();
        commitVersion += 1;
      }

      if (commitVersion !== startVersion) {
        continue;
      }

      for (const upd of pendingUpdates) {
        const existing = state[upd.colName][upd.id] || {};
        const sanitizedPatch = { ...upd.patch };
        if (
          sanitizedPatch.updatedAt &&
          typeof sanitizedPatch.updatedAt === 'object'
        ) {
          sanitizedPatch.updatedAt = new Date().toISOString();
        }
        state[upd.colName][upd.id] = {
          ...existing,
          ...cloneData(sanitizedPatch),
        };
      }
      commitVersion += 1;
      return result;
    }

    throw new Error('Transaction conflict retry limit exceeded');
  }

  return { state, storeRef, runTransaction };
}

test('parseOwnerShippingUpdatePayload validates valid and invalid inputs strictly', () => {
  const valid = parseOwnerShippingUpdatePayload({
    shippingFee: 18000,
    trackingNumber: 'JP1234567890',
    status: 'PICKED_UP',
    notes: 'Dijemput kurir J&T Ponorogo',
    serviceCode: 'ez',
  });
  assert.equal(valid.shippingFee, 18000);
  assert.equal(valid.trackingNumber, 'JP1234567890');
  assert.equal(valid.status, 'PICKED_UP');
  assert.equal(valid.serviceCode, 'EZ');

  assert.equal(parseOwnerShippingUpdatePayload({ shippingFee: 0 }).shippingFee, 0);

  for (const badFee of [-1, -15000, NaN, Infinity, null, '', 'abc', true, 99_000_000]) {
    assert.throws(
      () => parseOwnerShippingUpdatePayload({ shippingFee: badFee }),
      (err: unknown) => err instanceof OwnerOrderActionError && err.statusCode === 400
    );
  }

  for (const badAwb of ['', 'abc', 'JP 12345', 'JP@12345', 12345]) {
    assert.throws(
      () => parseOwnerShippingUpdatePayload({ trackingNumber: badAwb }),
      (err: unknown) => err instanceof OwnerOrderActionError && err.statusCode === 400
    );
  }

  for (const badStatus of ['PENDING_RATE', 'COMPLETED', 'CANCELLED', 'SHIPPED', 123]) {
    assert.throws(
      () => parseOwnerShippingUpdatePayload({ status: badStatus }),
      (err: unknown) => err instanceof OwnerOrderActionError && err.statusCode === 400
    );
  }

  assert.throws(
    () => parseOwnerShippingUpdatePayload({}),
    (err: unknown) => err instanceof OwnerOrderActionError && err.statusCode === 400
  );
});

test('confirms manual J&T shipping fee, recalculates total from Firestore items, and never touches status or stock', async () => {
  const { state, storeRef, runTransaction } = createInMemoryFirestore({
    products: {
      prod_1: { id: 'prod_1', stock: 12, price: 20000 },
    },
    guest_orders: {
      ord_jnt_1: {
        orderId: 'ord_jnt_1',
        orderNumber: 'SPG-261120-JNT001',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'PENDING',
        stockDeducted: false,
        itemsSubtotal: 999999, // tampered value should be ignored in favor of items
        total: 40000,
        totalAmount: 40000,
        items: [
          { productId: 'prod_1', unitPrice: 20000, quantity: 2, subtotal: 40000 },
        ],
        shipping: {
          provider: 'JNT_EXPRESS',
          status: 'PENDING_RATE',
          totalWeightGrams: 400,
          hasUnweighedItems: false,
          shippingFee: 0,
          shippingFeeConfirmed: false,
        },
      },
      ord_other: {
        orderId: 'ord_other',
        orderNumber: 'SPG-261120-OTHER',
        storeId: 'store_owner_1',
        fulfillmentType: 'pickup',
        status: 'PENDING',
        total: 15000,
        totalAmount: 15000,
        items: [{ productId: 'prod_1', unitPrice: 15000, quantity: 1 }],
      },
    },
  });

  const payload = parseOwnerShippingUpdatePayload({
    shippingFee: 14000,
    notes: 'Tarif J&T EZ reguler',
  });

  const res = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_jnt_1',
      payload
    )
  );

  assert.equal(res.updatedData.itemsSubtotal, 40000);
  assert.equal(res.updatedData.total, 54000);
  assert.equal(res.updatedData.totalAmount, 54000);
  assert.equal(res.updatedData.status, 'PENDING');
  assert.equal(res.updatedData.stockDeducted, false);

  const ship = res.updatedData.shipping as Record<string, unknown>;
  assert.equal(ship.provider, 'JNT_EXPRESS');
  assert.equal(ship.status, 'READY_TO_SHIP');
  assert.equal(ship.shippingFee, 14000);
  assert.equal(ship.shippingFeeConfirmed, true);
  assert.equal(ship.totalWeightGrams, 400);
  assert.equal(ship.hasUnweighedItems, false);
  assert.equal(typeof ship.updatedAt, 'string');
  assert.equal(ship.shippedAt, undefined);
  assert.equal(ship.deliveredAt, undefined);

  // Unrelated order and product stock remain untouched
  assert.equal(state.products.prod_1.stock, 12);
  assert.equal(state.guest_orders.ord_other.totalAmount, 15000);
});

test('updates AWB and shipping statuses with valid shippedAt/deliveredAt timestamps and blocks invalid regression', async () => {
  const { storeRef, runTransaction } = createInMemoryFirestore({
    guest_orders: {
      ord_jnt_2: {
        orderId: 'ord_jnt_2',
        orderNumber: 'SPG-261120-JNT002',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'ACCEPTED',
        stockDeducted: false,
        total: 50000,
        totalAmount: 50000,
        items: [{ productId: 'prod_1', unitPrice: 25000, quantity: 2 }],
        shipping: {
          provider: 'JNT_EXPRESS',
          status: 'READY_TO_SHIP',
          totalWeightGrams: 600,
          hasUnweighedItems: false,
          shippingFee: 12000,
          shippingFeeConfirmed: true,
        },
      },
    },
  });

  // 1. Update AWB + PICKED_UP -> populates shippedAt
  const picked = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_jnt_2',
      parseOwnerShippingUpdatePayload({
        trackingNumber: 'JP9988776655',
        status: 'PICKED_UP',
      })
    )
  );
  const s1 = picked.updatedData.shipping as Record<string, unknown>;
  assert.equal(s1.trackingNumber, 'JP9988776655');
  assert.equal(s1.status, 'PICKED_UP');
  assert.equal(typeof s1.shippedAt, 'string');
  assert.equal(s1.deliveredAt, undefined);
  assert.equal(picked.updatedData.totalAmount, 62000);

  // 2. IN_TRANSIT -> preserves initial shippedAt
  const transit = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_jnt_2',
      parseOwnerShippingUpdatePayload({ status: 'IN_TRANSIT' })
    )
  );
  const s2 = transit.updatedData.shipping as Record<string, unknown>;
  assert.equal(s2.status, 'IN_TRANSIT');
  assert.equal(s2.shippedAt, s1.shippedAt);
  assert.equal(s2.deliveredAt, undefined);

  // 3. DELIVERED -> sets deliveredAt, preserves shippedAt
  const delivered = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_jnt_2',
      parseOwnerShippingUpdatePayload({ status: 'DELIVERED' })
    )
  );
  const s3 = delivered.updatedData.shipping as Record<string, unknown>;
  assert.equal(s3.status, 'DELIVERED');
  assert.equal(s3.shippedAt, s1.shippedAt);
  assert.equal(typeof s3.deliveredAt, 'string');

  // 4. Idempotent repeat DELIVERED preserves deliveredAt
  const deliveredRepeat = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_jnt_2',
      parseOwnerShippingUpdatePayload({ status: 'DELIVERED' })
    )
  );
  assert.equal(
    (deliveredRepeat.updatedData.shipping as Record<string, unknown>).deliveredAt,
    s3.deliveredAt
  );

  // 5. Regressing DELIVERED -> READY_TO_SHIP is blocked
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_jnt_2',
          parseOwnerShippingUpdatePayload({ status: 'READY_TO_SHIP' })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError &&
      err.statusCode === 409 &&
      err.code === 'INVALID_SHIPPING_STATUS_TRANSITION'
  );
});

test('blocks financial shipping fee changes on completed or cashier-linked orders while allowing non-financial tracking updates', async () => {
  const { storeRef, runTransaction } = createInMemoryFirestore({
    guest_orders: {
      ord_completed: {
        orderId: 'ord_completed',
        orderNumber: 'SPG-261120-COMP1',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'COMPLETED',
        stockDeducted: true,
        itemsSubtotal: 30000,
        total: 42000,
        totalAmount: 42000,
        items: [{ productId: 'prod_1', unitPrice: 30000, quantity: 1 }],
        shipping: {
          provider: 'JNT_EXPRESS',
          status: 'READY_TO_SHIP',
          shippingFee: 12000,
          shippingFeeConfirmed: true,
        },
      },
      ord_sales_linked: {
        orderId: 'ord_sales_linked',
        orderNumber: 'SPG-261120-SALE2',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'ACCEPTED',
        stockDeducted: true,
        itemsSubtotal: 25000,
        total: 25000,
        totalAmount: 25000,
        items: [{ productId: 'prod_1', unitPrice: 25000, quantity: 1 }],
        shipping: {
          provider: 'JNT_EXPRESS',
          status: 'PENDING_RATE',
          shippingFee: 0,
          shippingFeeConfirmed: false,
        },
      },
    },
    sales: {
      sale_99: {
        guestOrderId: 'ord_sales_linked',
        orderNumber: 'SPG-261120-SALE2',
      },
    },
  });

  // Changing fee on COMPLETED order is blocked
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_completed',
          parseOwnerShippingUpdatePayload({ shippingFee: 20000 })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError &&
      err.statusCode === 409 &&
      err.code === 'ORDER_LINKED_TO_TRANSACTION'
  );

  // Changing fee on externally sales-linked order is also blocked
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_sales_linked',
          parseOwnerShippingUpdatePayload({ shippingFee: 15000 })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError &&
      err.statusCode === 409 &&
      err.code === 'ORDER_LINKED_TO_TRANSACTION'
  );

  // Non-financial AWB & status update on COMPLETED order succeeds without altering total
  const tracked = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_completed',
      parseOwnerShippingUpdatePayload({
        trackingNumber: 'JP1122334455',
        status: 'IN_TRANSIT',
      })
    )
  );
  assert.equal(tracked.updatedData.totalAmount, 42000);
  assert.equal(
    (tracked.updatedData.shipping as Record<string, unknown>).trackingNumber,
    'JP1122334455'
  );
});

test('maintains backward compatibility for legacy delivery orders and enforces pickup/cancelled/store guards', async () => {
  const { storeRef, runTransaction } = createInMemoryFirestore({
    guest_orders: {
      ord_legacy_delivery: {
        orderId: 'ord_legacy_delivery',
        orderNumber: 'SPG-261120-LEG01',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'PENDING',
        stockDeducted: false,
        total: 50000,
        totalAmount: 50000,
        items: [{ productId: 'prod_1', price: 25000, quantity: 2 }],
      },
      ord_pickup: {
        orderId: 'ord_pickup',
        orderNumber: 'SPG-261120-PKP01',
        storeId: 'store_owner_1',
        fulfillmentType: 'pickup',
        status: 'PENDING',
        total: 10000,
        items: [{ productId: 'prod_1', price: 10000, quantity: 1 }],
      },
      ord_cancelled: {
        orderId: 'ord_cancelled',
        orderNumber: 'SPG-261120-CAN01',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'CANCELLED',
        total: 10000,
        items: [{ productId: 'prod_1', price: 10000, quantity: 1 }],
      },
      ord_other_store: {
        orderId: 'ord_other_store',
        orderNumber: 'SPG-261120-STR02',
        storeId: 'different_store_uid',
        fulfillmentType: 'delivery',
        status: 'PENDING',
        total: 10000,
        items: [{ productId: 'prod_1', price: 10000, quantity: 1 }],
      },
    },
  });

  // Legacy delivery without `shipping` or `itemsSubtotal` works seamlessly
  const legacyRes = await runTransaction((tx) =>
    updateGuestOrderShippingInTransaction(
      tx,
      storeRef,
      'store_owner_1',
      'ord_legacy_delivery',
      parseOwnerShippingUpdatePayload({
        shippingFee: 5000,
        status: 'READY_TO_SHIP',
      })
    )
  );
  assert.equal(legacyRes.updatedData.itemsSubtotal, 50000);
  assert.equal(legacyRes.updatedData.totalAmount, 55000);
  assert.equal(
    (legacyRes.updatedData.shipping as Record<string, unknown>).provider,
    'STORE_COURIER'
  );

  // Pickup rejected
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_pickup',
          parseOwnerShippingUpdatePayload({ status: 'READY_TO_SHIP' })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError && err.code === 'ORDER_NOT_DELIVERY'
  );

  // Cancelled rejected
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_cancelled',
          parseOwnerShippingUpdatePayload({ status: 'READY_TO_SHIP' })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError && err.code === 'ORDER_CANCELLED'
  );

  // Cross-store rejected
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'ord_other_store',
          parseOwnerShippingUpdatePayload({ status: 'READY_TO_SHIP' })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError &&
      err.statusCode === 403 &&
      err.code === 'ORDER_STORE_MISMATCH'
  );

  // Missing order rejected
  await assert.rejects(
    () =>
      runTransaction((tx) =>
        updateGuestOrderShippingInTransaction(
          tx,
          storeRef,
          'store_owner_1',
          'does_not_exist',
          parseOwnerShippingUpdatePayload({ status: 'READY_TO_SHIP' })
        )
      ),
    (err: unknown) =>
      err instanceof OwnerOrderActionError && err.statusCode === 404
  );
});

test('retries cleanly on concurrent transaction conflict without losing parallel updates or double-adding fee', async () => {
  const { state, storeRef, runTransaction } = createInMemoryFirestore({
    guest_orders: {
      ord_race: {
        orderId: 'ord_race',
        orderNumber: 'SPG-261120-RACE1',
        storeId: 'store_owner_1',
        fulfillmentType: 'delivery',
        status: 'PENDING',
        stockDeducted: false,
        itemsSubtotal: 40000,
        total: 40000,
        totalAmount: 40000,
        items: [{ productId: 'prod_1', unitPrice: 20000, quantity: 2 }],
        shipping: {
          provider: 'JNT_EXPRESS',
          status: 'PENDING_RATE',
          shippingFee: 0,
          shippingFeeConfirmed: false,
        },
      },
    },
  });

  // Simulate another request adding AWB while fee confirmation is in flight
  const result = await runTransaction(
    (tx) =>
      updateGuestOrderShippingInTransaction(
        tx,
        storeRef,
        'store_owner_1',
        'ord_race',
        parseOwnerShippingUpdatePayload({ shippingFee: 16000 })
      ),
    {
      simulateConflictBeforeFirstCommit: () => {
        state.guest_orders.ord_race.shipping = {
          ...(state.guest_orders.ord_race.shipping as Record<string, unknown>),
          trackingNumber: 'JP5556667778',
          status: 'PICKED_UP',
          shippedAt: '2026-11-20T10:00:00.000Z',
        };
      },
    }
  );

  const ship = result.updatedData.shipping as Record<string, unknown>;
  assert.equal(ship.shippingFee, 16000);
  assert.equal(ship.shippingFeeConfirmed, true);
  assert.equal(ship.trackingNumber, 'JP5556667778');
  assert.equal(ship.status, 'PICKED_UP');
  assert.equal(result.updatedData.totalAmount, 56000);

  // Fallback subtotal calculation check when itemsSubtotal missing
  assert.equal(
    computeValidatedItemsSubtotalFromOrderDoc({
      items: [],
      totalAmount: 56000,
      shipping: { shippingFee: 16000 },
    }),
    40000
  );
});
