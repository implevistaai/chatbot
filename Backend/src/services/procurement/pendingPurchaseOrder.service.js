import { buildEntitySetQuery, normalizeNumericId } from "../odataQueryBuilder.js";
import { fetchFromSap } from "../sap.service.js";
import { normalizeDateQuery } from "../filters/dateFilters.js";

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 50;
const FETCH_CHUNK_SIZE = 200;
export const PENDING_PO_SERVICE_NAME = "ZIV_PO_DETAILS_CDS";
export const PENDING_PO_ENTITY_SET = "ZIV_PO_DETAILS";

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeUpper(value) {
  return cleanString(value).toUpperCase();
}

export function assertPendingPoServiceCompatibility(service = {}) {
  const serviceName = normalizeUpper(service?.serviceName);
  const entitySet = normalizeUpper(service?.entitySet);

  if (!serviceName || !entitySet) {
    const err = new Error(
      `Pending PO service is not configured for this SAP system. Please map ${PENDING_PO_SERVICE_NAME} in service catalog.`
    );
    err.status = 400;
    err.code = "PENDING_PO_SERVICE_NOT_CONFIGURED";
    throw err;
  }

  return true;
}

function toNumber(value) {
  const numeric = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(numeric) ? numeric : 0;
}

function toFixed3(value) {
  return toNumber(value).toFixed(3);
}

function formatIsoDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDateString(dateText) {
  const value = cleanString(dateText);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUtcMonths(baseDate, months) {
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth();
  const day = baseDate.getUTCDate();

  const shifted = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted;
}

function getTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseLastMonthsRange(query, today) {
  const normalized = cleanString(query).toLowerCase();
  const match = normalized.match(/\b(?:last|past|previous)\s+(\d{1,2})\s+months?\b/i);
  if (!match) return null;

  const months = Math.max(1, Math.min(24, Number(match[1])));
  const fromDate = addUtcMonths(today, -months);

  return {
    fromDate: formatIsoDate(fromDate),
    toDate: formatIsoDate(today),
    reason: `last_${months}_months`,
  };
}

function parseThisMonthRange(today) {
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return {
    fromDate: formatIsoDate(from),
    toDate: formatIsoDate(today),
    reason: "this_month",
  };
}

function parseThisYearRange(today) {
  const from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  return {
    fromDate: formatIsoDate(from),
    toDate: formatIsoDate(today),
    reason: "this_year",
  };
}

function normalizeExtractedDateRange(result, today) {
  if (!result?.startDate || !result?.endDate) return null;

  const start = new Date(`${String(result.startDate).slice(0, 10)}T00:00:00Z`);
  const exclusiveEnd = new Date(`${String(result.endDate).slice(0, 10)}T00:00:00Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(exclusiveEnd.getTime())) {
    return null;
  }

  const inclusiveEnd = new Date(exclusiveEnd.getTime() - 24 * 60 * 60 * 1000);
  const normalizedTo = inclusiveEnd > today ? today : inclusiveEnd;

  if (normalizedTo < start) return null;

  return {
    fromDate: formatIsoDate(start),
    toDate: formatIsoDate(normalizedTo),
    reason: result.type || "parsed",
  };
}

export function detectPendingPoIntent(query) {
  const text = cleanString(query).toLowerCase();
  if (!text) return false;

  const normalized = text.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const hasPending = /\b(pending|open|not\s+delivered|remaining)\b/i.test(normalized);
  const hasPo = /\b(po|pos|purchase\s*order|purchase\s*orders)\b/i.test(normalized);
  const hasInvoice = /\b(invoice|invoices|invocie|inovice|invioce|invioice)\b/i.test(normalized);

  if (!hasPo || !hasPending) return false;
  if (hasInvoice) return false;

  return true;
}

export function extractPendingPoNumber(query) {
  const text = cleanString(query);
  if (!text) return "";

  const match = text.match(/\b(\d{8,12})\b/);
  if (!match) return "";

  return normalizeNumericId(match[1], 10) || cleanString(match[1]);
}

export function resolvePendingPoDateRange(query, { today = null } = {}) {
  const baseToday = today instanceof Date ? today : getTodayUtc();
  const normalizedQuery = cleanString(query).toLowerCase();

  if (/\bthis\s+month\b/i.test(normalizedQuery)) {
    return parseThisMonthRange(baseToday);
  }

  if (/\bthis\s+year\b/i.test(normalizedQuery)) {
    return parseThisYearRange(baseToday);
  }

  const lastMonths = parseLastMonthsRange(query, baseToday);
  if (lastMonths) return lastMonths;

  const parsed = normalizeDateQuery(query);
  const normalized = normalizeExtractedDateRange(parsed, baseToday);
  if (normalized) return normalized;

  const from = addUtcMonths(baseToday, -24);
  return {
    fromDate: formatIsoDate(from),
    toDate: formatIsoDate(baseToday),
    reason: "default_last_2_years",
  };
}

export function buildPendingPoIntentPayload(query, { today = null, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const dateRange = resolvePendingPoDateRange(query, { today });

  return {
    intent: "GET_PENDING_PO_LIST",
    date_from: dateRange.fromDate,
    date_to: dateRange.toDate,
    page_size: Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE)),
    pagination: {
      sourceSkip: 0,
    },
  };
}

function readPoNo(row = {}) {
  return cleanString(
    row?.po_no ||
      row?.PoNo ||
      row?.PO_NO ||
      row?.PONo ||
      row?.poNumber ||
      row?.EBELN ||
      ""
  );
}

function readPoItem(row = {}) {
  const raw =
    row?.po_item ||
    row?.PoItem ||
    row?.PO_ITEM ||
    row?.poItem ||
    row?.EBELP ||
    "";
  const normalized = normalizeNumericId(raw, 5);
  return cleanString(normalized || raw);
}

function readSupplier(row = {}) {
  return cleanString(
    row?.Supplier ||
      row?.supplier ||
      row?.Name ||
      row?.name ||
      row?.Vendor ||
      row?.vendor ||
      ""
  );
}

function readStatus(row = {}) {
  return cleanString(
    row?.Status ||
      row?.status ||
      row?.Delivery_Status ||
      row?.delivery_status ||
      "Pending"
  ) || "Pending";
}

function readPoQuantity(row = {}) {
  return row?.PO_Quantity ?? row?.PoQuantity ?? row?.po_quantity ?? row?.quantity ?? row?.Menge ?? 0;
}

function readDeliveredQuantity(row = {}) {
  return row?.Delivered ?? row?.delivered ?? row?.Wemng ?? row?.delivered_qty ?? 0;
}

function readPendingQuantity(row = {}) {
  return row?.Pending_PO_Quantity ?? row?.pending_po_quantity ?? row?.PendingQty ?? row?.pending_qty ?? row?.RelNotYet ?? 0;
}

function readPoDocDate(row = {}) {
  return cleanString(
    row?.po_doc_date ||
      row?.PoDocDate ||
      row?.PO_DOC_DATE ||
      row?.DocDate ||
      row?.CrtDate ||
      ""
  );
}

function toResultsArray(payload) {
  return Array.isArray(payload?.d?.results) ? payload.d.results : [];
}

function normalizeFieldToken(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findBestField(fieldNames = [], candidates = []) {
  const rows = Array.isArray(fieldNames) ? fieldNames : [];
  const lookup = new Map(rows.map((field) => [normalizeFieldToken(field), String(field)]));
  for (const candidate of candidates) {
    const matched = lookup.get(normalizeFieldToken(candidate));
    if (matched) return matched;
  }
  return "";
}

function getPendingPoFieldConfig(service = {}) {
  const fieldNames = Array.isArray(service?.pendingPoFields)
    ? service.pendingPoFields
    : (Array.isArray(service?.fieldNames) ? service.fieldNames : []);

  const poNoField = findBestField(fieldNames, ["po_no", "PoNo", "EBELN"]);
  const poItemField = findBestField(fieldNames, ["po_item", "PoItem", "EBELP"]);
  const dateField = findBestField(fieldNames, ["po_doc_date", "PoDocDate", "CrtDate", "BEDAT"]);
  const pendingQtyField = findBestField(fieldNames, ["Pending_PO_Quantity", "pending_qty", "PendingQty"]);
  const orderedQtyField = findBestField(fieldNames, ["PO_Quantity", "PoQuantity", "Menge"]);
  const deliveredQtyField = findBestField(fieldNames, ["Delivered", "delivered_qty", "Wemng"]);

  return {
    poNoField: poNoField || "po_no",
    poItemField: poItemField || "po_item",
    dateField: dateField || "po_doc_date",
    pendingQtyField,
    orderedQtyField,
    deliveredQtyField,
  };
}

function readFieldValue(row = {}, fieldName = "") {
  if (!fieldName) return undefined;

  if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
    return row[fieldName];
  }

  const wanted = normalizeFieldToken(fieldName);
  for (const [key, value] of Object.entries(row || {})) {
    if (normalizeFieldToken(key) === wanted) return value;
  }

  return undefined;
}

function resolvePendingQuantity(row = {}, fieldConfig = {}) {
  const pendingFromField = toNumber(readFieldValue(row, fieldConfig.pendingQtyField));
  if (pendingFromField > 0) return pendingFromField;

  const pendingFromKnown = toNumber(readPendingQuantity(row));
  if (pendingFromKnown > 0) return pendingFromKnown;

  const ordered = toNumber(readFieldValue(row, fieldConfig.orderedQtyField));
  const delivered = toNumber(readFieldValue(row, fieldConfig.deliveredQtyField));
  const fallbackPending = ordered - delivered;
  return fallbackPending > 0 ? fallbackPending : 0;
}

function makeDateFilterForOData(dateFrom, dateTo, dateField = "po_doc_date") {
  const fromTextRaw = cleanString(dateFrom);
  const toTextRaw = cleanString(dateTo);
  if (!fromTextRaw || !toTextRaw) return "";

  const from = parseIsoDateString(fromTextRaw);
  const to = parseIsoDateString(toTextRaw);

  if (!from || !to) {
    throw new Error("Invalid date range for pending PO filter.");
  }

  const fromText = `${fromTextRaw}T00:00:00`;
  const toText = `${toTextRaw}T23:59:59`;

  return `${dateField} ge datetime'${fromText}' and ${dateField} le datetime'${toText}'`;
}

function buildPendingPoFilter({ dateFrom, dateTo, poNo = "", fieldConfig = {} }) {
  const parts = [];

  const dateFilter = makeDateFilterForOData(dateFrom, dateTo, fieldConfig.dateField || "po_doc_date");
  if (dateFilter) parts.push(dateFilter);

  if (fieldConfig.pendingQtyField) {
    parts.unshift(`${fieldConfig.pendingQtyField} gt 0`);
  }

  if (cleanString(poNo)) {
    const normalizedPo = normalizeNumericId(poNo, 10) || cleanString(poNo);
    parts.push(`${fieldConfig.poNoField || "po_no"} eq '${String(normalizedPo).replace(/'/g, "''")}'`);
  }

  if (parts.length === 0) {
    throw new Error("Pending PO filter requires at least one filter condition.");
  }

  return parts.join(" and ");
}

function createSummaryFromFirstRow(poNo, firstRow) {
  return {
    poNo,
    supplier: readSupplier(firstRow) || "-",
    supplierCandidates: new Set(readSupplier(firstRow) ? [readSupplier(firstRow)] : []),
    poQty: 0,
    deliveredQty: 0,
    pendingQty: 0,
    status: readStatus(firstRow) || "Pending",
    itemCount: 0,
  };
}

function foldRowIntoSummary(summary, row, pendingQtyOverride = null) {
  summary.poQty += toNumber(readPoQuantity(row));
  summary.deliveredQty += toNumber(readDeliveredQuantity(row));
  summary.pendingQty += pendingQtyOverride == null ? toNumber(readPendingQuantity(row)) : toNumber(pendingQtyOverride);
  summary.itemCount += 1;

  const supplier = readSupplier(row);
  if (supplier) {
    summary.supplierCandidates.add(supplier);
  }

  const status = readStatus(row);
  if (status && String(status).toLowerCase() !== "pending") {
    summary.status = status;
  }
}

function finalizeSummary(summary) {
  const suppliers = Array.from(summary.supplierCandidates || []);
  const hasSupplierConflict = suppliers.length > 1;

  return {
    poNo: summary.poNo,
    supplier: hasSupplierConflict ? "Multiple Suppliers" : (suppliers[0] || summary.supplier || "-"),
    suppliers,
    poQty: toFixed3(summary.poQty),
    deliveredQty: toFixed3(summary.deliveredQty),
    pendingQty: toFixed3(summary.pendingQty),
    status: summary.pendingQty > 0 ? "Pending" : (summary.status || "Pending"),
    itemCount: summary.itemCount,
    supplierConflict: hasSupplierConflict,
  };
}

function decodeCursor(cursor) {
  if (!cursor) return { sourceSkip: 0 };

  if (typeof cursor === "object") {
    return {
      sourceSkip: Math.max(0, Number(cursor.sourceSkip) || 0),
    };
  }

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf-8"));
    return {
      sourceSkip: Math.max(0, Number(parsed?.sourceSkip) || 0),
    };
  } catch {
    return { sourceSkip: 0 };
  }
}

function encodeCursor(state) {
  return Buffer.from(JSON.stringify({ sourceSkip: Math.max(0, Number(state?.sourceSkip) || 0) }), "utf-8").toString("base64");
}

async function fetchPendingPoChunk({
  system,
  sapAuth,
  service,
  dateFrom,
  dateTo,
  skip,
  top,
  poNo = "",
}) {
  const fieldConfig = getPendingPoFieldConfig(service);

  const relativePath = buildEntitySetQuery(
    service.entitySet,
    {
      $filter: buildPendingPoFilter({ dateFrom, dateTo, poNo, fieldConfig }),
      $orderby: `${fieldConfig.poNoField} asc,${fieldConfig.poItemField} asc`,
      $top: top,
      $skip: skip,
    },
    { maxTop: FETCH_CHUNK_SIZE }
  );

  const payload = await fetchFromSap(
    {
      system,
      service,
      relativePath,
      requestMeta: {
        feature: "pending_po",
        requestedSystemId: system?.systemId || "",
        mappedSystemId: system?.systemId || "",
      },
    },
    sapAuth
  );

  return {
    payload,
    rows: toResultsArray(payload),
    nextLink: payload?.d?.__next || payload?.d?.__nextLink || null,
  };
}

export async function getPendingPurchaseOrderList({
  system,
  sapAuth,
  service,
  dateFrom,
  dateTo,
  poNo = "",
  pageSize = DEFAULT_PAGE_SIZE,
  cursor = null,
  fetchChunk = null,
}) {
  const targetPageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const cursorState = decodeCursor(cursor);
  let sourceSkip = Math.max(0, Number(cursorState.sourceSkip) || 0);
  const fieldConfig = getPendingPoFieldConfig(service);

  const summaries = [];
  const summaryByPo = new Map();
  const dataQualityIssues = [];

  let openPoNo = "";
  let openSummary = null;
  let hasMore = false;
  let guard = 0;

  while (summaries.length < targetPageSize && guard < 1000) {
    guard += 1;
    const chunk = await (typeof fetchChunk === "function" ? fetchChunk : fetchPendingPoChunk)({
      system,
      sapAuth,
      service,
      dateFrom,
      dateTo,
      poNo,
      skip: sourceSkip,
      top: FETCH_CHUNK_SIZE,
    });

    const rows = Array.isArray(chunk.rows) ? chunk.rows : [];
    if (rows.length === 0) {
      if (openSummary) {
        const finalized = finalizeSummary(openSummary);
        summaries.push(finalized);
        summaryByPo.set(finalized.poNo, finalized);
        openSummary = null;
      }
      break;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const pendingQty = resolvePendingQuantity(row, fieldConfig);
      if (!(pendingQty > 0)) continue;

      const rowPoNo = readPoNo(row);
      if (!rowPoNo) continue;

      if (!openSummary) {
        openPoNo = rowPoNo;
        openSummary = createSummaryFromFirstRow(rowPoNo, row);
      }

      if (rowPoNo !== openPoNo) {
        const finalized = finalizeSummary(openSummary);
        summaries.push(finalized);
        summaryByPo.set(finalized.poNo, finalized);

        if (summaries.length >= targetPageSize) {
          hasMore = true;
          sourceSkip += index;
          openSummary = null;
          break;
        }

        openPoNo = rowPoNo;
        openSummary = createSummaryFromFirstRow(rowPoNo, row);
      }

      foldRowIntoSummary(openSummary, row, pendingQty);
    }

    if (hasMore) {
      break;
    }

    sourceSkip += rows.length;
  }

  if (!hasMore && openSummary && summaries.length < targetPageSize) {
    const finalized = finalizeSummary(openSummary);
    summaries.push(finalized);
    summaryByPo.set(finalized.poNo, finalized);
  }

  for (const summary of summaries) {
    if (summary.supplierConflict) {
      dataQualityIssues.push({
        type: "SUPPLIER_INCONSISTENCY",
        poNo: summary.poNo,
        message: `Multiple suppliers found for PO ${summary.poNo}.`,
        suppliers: summary.suppliers,
      });
    }
  }

  return {
    viewType: "pending_po_list",
    intent: "GET_PENDING_PO_LIST",
    dateFrom,
    dateTo,
    pageSize: targetPageSize,
    rows: summaries,
    count: summaries.length,
    hasMore,
    nextPage: hasMore ? encodeCursor({ sourceSkip }) : null,
    dataQualityIssues,
    pendingFilter: fieldConfig.pendingQtyField
      ? `${fieldConfig.pendingQtyField} gt 0`
      : `${fieldConfig.orderedQtyField || "ordered_qty"} - ${fieldConfig.deliveredQtyField || "delivered_qty"} gt 0 (computed)`,
    orderBy: `${fieldConfig.poNoField} asc,${fieldConfig.poItemField} asc`,
    poNo: cleanString(poNo),
    sourceService: cleanString(service?.serviceName || PENDING_PO_SERVICE_NAME) || PENDING_PO_SERVICE_NAME,
    sourceEntitySet: cleanString(service?.entitySet || PENDING_PO_ENTITY_SET) || PENDING_PO_ENTITY_SET,
  };
}

export async function getPendingPurchaseOrderItems({
  system,
  sapAuth,
  service,
  poNo,
  dateFrom,
  dateTo,
  fetchChunk = null,
}) {
  const normalizedPoNo = normalizeNumericId(poNo, 10) || cleanString(poNo);
  if (!normalizedPoNo) {
    throw new Error("poNo is required");
  }
  const fieldConfig = getPendingPoFieldConfig(service);

  let skip = 0;
  let guard = 0;
  const rows = [];

  while (guard < 1000) {
    guard += 1;

    const chunk = await (typeof fetchChunk === "function" ? fetchChunk : fetchPendingPoChunk)({
      system,
      sapAuth,
      service,
      dateFrom,
      dateTo,
      skip,
      top: FETCH_CHUNK_SIZE,
      poNo: normalizedPoNo,
    });

    const resultRows = Array.isArray(chunk.rows) ? chunk.rows : [];
    if (resultRows.length === 0) break;

    for (const row of resultRows) {
      const pendingQty = resolvePendingQuantity(row, fieldConfig);
      if (!(pendingQty > 0)) continue;

      const rowPoNo = normalizeNumericId(readPoNo(row), 10) || readPoNo(row);
      if (rowPoNo !== normalizedPoNo) continue;

      rows.push({
        poNo: normalizedPoNo,
        poItem: readPoItem(row) || "-",
        supplier: readSupplier(row) || "-",
        material: cleanString(row?.Material || row?.material || row?.MATNR || "") || "-",
        materialDescription: cleanString(row?.Material_Description || row?.material_description || row?.MAKTX || "") || "-",
        poQty: toFixed3(readPoQuantity(row)),
        deliveredQty: toFixed3(readDeliveredQuantity(row)),
        pendingQty: toFixed3(pendingQty),
        status: readStatus(row) || "Pending",
        poDocDate: readPoDocDate(row) || "-",
      });
    }

    if (!chunk.nextLink && resultRows.length < FETCH_CHUNK_SIZE) {
      break;
    }

    skip += resultRows.length;
  }

  return {
    viewType: "pending_po_items",
    intent: "GET_PENDING_PO_ITEMS",
    poNo: normalizedPoNo,
    dateFrom,
    dateTo,
    items: rows,
    count: rows.length,
    pendingFilter: fieldConfig.pendingQtyField
      ? `${fieldConfig.pendingQtyField} gt 0`
      : `${fieldConfig.orderedQtyField || "ordered_qty"} - ${fieldConfig.deliveredQtyField || "delivered_qty"} gt 0 (computed)`,
    sourceService: cleanString(service?.serviceName || PENDING_PO_SERVICE_NAME) || PENDING_PO_SERVICE_NAME,
    sourceEntitySet: cleanString(service?.entitySet || PENDING_PO_ENTITY_SET) || PENDING_PO_ENTITY_SET,
  };
}
