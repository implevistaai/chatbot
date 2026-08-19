import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPendingPoIntentPayload,
  detectPendingPoIntent,
  getPendingPurchaseOrderItems,
  getPendingPurchaseOrderList,
  resolvePendingPoDateRange,
} from "../src/services/procurement/pendingPurchaseOrder.service.js";

function makeRow({
  poNo,
  poItem,
  poQty = 0,
  delivered = 0,
  pending = 0,
  supplier = "ABC Ltd",
  status = "Pending",
  date = "2025-06-01",
  material = "MAT-1",
} = {}) {
  return {
    po_no: String(poNo || "").padStart(10, "0"),
    po_item: String(poItem || "").padStart(5, "0"),
    PO_Quantity: String(poQty),
    Delivered: String(delivered),
    Pending_PO_Quantity: String(pending),
    Supplier: supplier,
    Status: status,
    po_doc_date: date,
    Material: material,
    Material_Description: `${material} description`,
  };
}

function buildDataset(uniquePoCount, { itemsPerPo = 2, pendingQty = 10 } = {}) {
  const rows = [];

  for (let i = 1; i <= uniquePoCount; i += 1) {
    const poNo = String(4500000000 + i);
    for (let item = 1; item <= itemsPerPo; item += 1) {
      rows.push(
        makeRow({
          poNo,
          poItem: String(item).padStart(5, "0"),
          poQty: 100,
          delivered: 50,
          pending: pendingQty,
          supplier: `SUP-${i}`,
          date: "2025-06-15",
          material: `MAT-${item}`,
        })
      );
    }
  }

  return rows;
}

function createFetchChunkStub(rows) {
  const source = Array.isArray(rows) ? rows : [];

  return async ({ skip = 0, top = 200, poNo = "", dateFrom = "", dateTo = "" }) => {
    const normalizedPoNo = String(poNo || "").trim();

    const filtered = source
      .filter((row) => Number(row?.Pending_PO_Quantity || 0) > 0)
      .filter((row) => {
        if (!normalizedPoNo) return true;
        return String(row?.po_no || "").trim() === normalizedPoNo;
      })
      .filter((row) => {
        const dt = String(row?.po_doc_date || "").slice(0, 10);
        if (!dateFrom || !dateTo) return true;
        return dt >= dateFrom && dt <= dateTo;
      })
      .sort((a, b) => {
        const poCmp = String(a.po_no).localeCompare(String(b.po_no));
        if (poCmp !== 0) return poCmp;
        return String(a.po_item).localeCompare(String(b.po_item));
      });

    const s = Math.max(0, Number(skip) || 0);
    const t = Math.max(1, Number(top) || 200);
    const slice = filtered.slice(s, s + t);

    return {
      rows: slice,
      payload: { d: { results: slice } },
      nextLink: s + t < filtered.length ? "next" : null,
    };
  };
}

test("detects pending PO intent and ignores invoice intent", () => {
  assert.equal(detectPendingPoIntent("Show all pending POs"), true);
  assert.equal(detectPendingPoIntent("show pending purchase orders"), true);
  assert.equal(detectPendingPoIntent("show pending invoice for po"), false);
});

test("default date range uses dynamic last 2 years", () => {
  const today = new Date("2026-08-18T00:00:00Z");
  const range = resolvePendingPoDateRange("Show all pending POs", { today });

  assert.equal(range.fromDate, "2024-08-18");
  assert.equal(range.toDate, "2026-08-18");
});

test("supports year and month and leap-year prompts", () => {
  const yearRange = resolvePendingPoDateRange("Show pending POs for 2025", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(yearRange.fromDate, "2025-01-01");
  assert.equal(yearRange.toDate, "2025-12-31");

  const monthRange = resolvePendingPoDateRange("Show pending POs for March 2026", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(monthRange.fromDate, "2026-03-01");
  assert.equal(monthRange.toDate, "2026-03-31");

  const leapRange = resolvePendingPoDateRange("Show pending POs for February 2024", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(leapRange.fromDate, "2024-02-01");
  assert.equal(leapRange.toDate, "2024-02-29");
});

test("supports date ranges and relative month ranges", () => {
  const range = resolvePendingPoDateRange("Show pending POs from April 2025 to March 2026", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(range.fromDate, "2025-04-01");
  assert.equal(range.toDate, "2026-03-31");

  const last6 = resolvePendingPoDateRange("Show pending POs for the last 6 months", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(last6.fromDate, "2026-02-18");
  assert.equal(last6.toDate, "2026-08-18");
});

test("supports this year and this month", () => {
  const thisYear = resolvePendingPoDateRange("Show pending POs this year", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(thisYear.fromDate, "2026-01-01");
  assert.equal(thisYear.toDate, "2026-08-18");

  const thisMonth = resolvePendingPoDateRange("Show pending POs this month", { today: new Date("2026-08-18T00:00:00Z") });
  assert.equal(thisMonth.fromDate, "2026-08-01");
  assert.equal(thisMonth.toDate, "2026-08-18");
});

test("builds normalized pending PO intent payload", () => {
  const payload = buildPendingPoIntentPayload("Show all pending POs", {
    today: new Date("2026-08-18T00:00:00Z"),
    pageSize: 30,
  });

  assert.equal(payload.intent, "GET_PENDING_PO_LIST");
  assert.equal(payload.date_from, "2024-08-18");
  assert.equal(payload.date_to, "2026-08-18");
  assert.equal(payload.page_size, 30);
});

test("paginates 75 unique pending POs as 30, 30, 15", async () => {
  const rows = buildDataset(75, { itemsPerPo: 2, pendingQty: 10 });
  const fetchChunk = createFetchChunkStub(rows);

  const page1 = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk,
  });

  assert.equal(page1.rows.length, 30);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextPage);

  const page2 = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    cursor: page1.nextPage,
    fetchChunk,
  });

  assert.equal(page2.rows.length, 30);
  assert.equal(page2.hasMore, true);
  assert.ok(page2.nextPage);

  const page3 = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    cursor: page2.nextPage,
    fetchChunk,
  });

  assert.equal(page3.rows.length, 15);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextPage, null);

  const merged = [...page1.rows, ...page2.rows, ...page3.rows];
  const unique = new Set(merged.map((row) => row.poNo));
  assert.equal(unique.size, 75);
});

test("returns 18 unique POs and no load-more", async () => {
  const rows = buildDataset(18, { itemsPerPo: 3, pendingQty: 5 });
  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.rows.length, 18);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, null);
});

test("filters pending list by specific PO number when requested", async () => {
  const rows = buildDataset(20, { itemsPerPo: 2, pendingQty: 10 });
  const fetchChunk = createFetchChunkStub(rows);

  const targetPo = "4500000007";
  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    poNo: targetPo,
    pageSize: 30,
    fetchChunk,
  });

  assert.equal(result.count, 1);
  assert.equal(result.rows[0]?.poNo, targetPo);
  assert.equal(result.hasMore, false);
});

test("filters specific PO even when no date range is provided", async () => {
  const rows = buildDataset(20, { itemsPerPo: 2, pendingQty: 10 });
  const fetchChunk = createFetchChunkStub(rows);

  const targetPo = "4500000054";
  const targetRows = [
    makeRow({ poNo: targetPo, poItem: "00010", poQty: 4, delivered: 3, pending: 1, supplier: "SUP-X" }),
  ];
  const mixedRows = [...rows, ...targetRows];
  const mixedFetchChunk = createFetchChunkStub(mixedRows);

  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "",
    dateTo: "",
    poNo: targetPo,
    pageSize: 30,
    fetchChunk: mixedFetchChunk,
  });

  assert.equal(result.count, 1);
  assert.equal(result.rows[0]?.poNo, targetPo);
  assert.equal(result.rows[0]?.pendingQty, "1.000");
});

test("returns exactly 30 unique POs without extra page", async () => {
  const rows = buildDataset(30, { itemsPerPo: 2, pendingQty: 6 });
  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.rows.length, 30);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, null);
});

test("groups multiple item rows under one PO summary and aggregates quantities", async () => {
  const rows = [
    makeRow({ poNo: "4500000002", poItem: "00010", poQty: 100, delivered: 60, pending: 40, supplier: "ABC Ltd" }),
    makeRow({ poNo: "4500000002", poItem: "00020", poQty: 200, delivered: 150, pending: 50, supplier: "ABC Ltd" }),
  ];

  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].poNo, "4500000002");
  assert.equal(result.rows[0].poQty, "300.000");
  assert.equal(result.rows[0].deliveredQty, "210.000");
  assert.equal(result.rows[0].pendingQty, "90.000");
});

test("excludes fully delivered rows with pending quantity zero", async () => {
  const rows = [
    makeRow({ poNo: "4500000001", poItem: "00001", poQty: 49, delivered: 49, pending: 0 }),
    makeRow({ poNo: "4500000002", poItem: "00001", poQty: 100, delivered: 60, pending: 40 }),
  ];

  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].poNo, "4500000002");
  assert.equal(result.rows[0].pendingQty, "40.000");
});

test("item drill-down returns only pending items for selected PO", async () => {
  const rows = [
    makeRow({ poNo: "4500000002", poItem: "00001", poQty: 100, delivered: 60, pending: 40, material: "MAT-001" }),
    makeRow({ poNo: "4500000002", poItem: "00002", poQty: 200, delivered: 150, pending: 50, material: "MAT-002" }),
    makeRow({ poNo: "4500000002", poItem: "00003", poQty: 100, delivered: 100, pending: 0, material: "MAT-003" }),
  ];

  const result = await getPendingPurchaseOrderItems({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    poNo: "4500000002",
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].pendingQty, "40.000");
  assert.equal(result.items[1].pendingQty, "50.000");
});

test("item drill-down supports specific PO without date range", async () => {
  const targetPo = "4500000054";
  const rows = [
    makeRow({ poNo: targetPo, poItem: "00010", poQty: 4, delivered: 3, pending: 1, supplier: "Domestic US Supplier 1" }),
    makeRow({ poNo: targetPo, poItem: "00020", poQty: 2, delivered: 2, pending: 0, supplier: "Domestic US Supplier 1" }),
  ];

  const result = await getPendingPurchaseOrderItems({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    poNo: targetPo,
    dateFrom: "",
    dateTo: "",
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.poNo, targetPo);
  assert.equal(result.items[0]?.poItem, "00010");
  assert.equal(result.items[0]?.pendingQty, "1.000");
});

test("supplier inconsistency is surfaced instead of silently picking one", async () => {
  const rows = [
    makeRow({ poNo: "4500000009", poItem: "00001", poQty: 10, delivered: 2, pending: 8, supplier: "ABC Ltd" }),
    makeRow({ poNo: "4500000009", poItem: "00002", poQty: 10, delivered: 5, pending: 5, supplier: "XYZ Ltd" }),
  ];

  const result = await getPendingPurchaseOrderList({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    pageSize: 30,
    fetchChunk: createFetchChunkStub(rows),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].supplier, "Multiple Suppliers");
  assert.equal(result.dataQualityIssues.length, 1);
  assert.equal(result.dataQualityIssues[0].type, "SUPPLIER_INCONSISTENCY");
});

test("preserves date context for item drill-down calls", async () => {
  let capturedDateFrom = "";
  let capturedDateTo = "";

  const rows = [
    makeRow({ poNo: "4500000025", poItem: "00001", poQty: 10, delivered: 1, pending: 9 }),
  ];

  const fetchChunk = async (params) => {
    capturedDateFrom = params.dateFrom;
    capturedDateTo = params.dateTo;
    return createFetchChunkStub(rows)(params);
  };

  await getPendingPurchaseOrderItems({
    system: {},
    sapAuth: {},
    service: { entitySet: "ZIV_PO_DETAILS" },
    poNo: "4500000025",
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    fetchChunk,
  });

  assert.equal(capturedDateFrom, "2025-01-01");
  assert.equal(capturedDateTo, "2025-12-31");
});
