import { buildEntitySetQuery } from "../odataQueryBuilder.js";
import { fetchFromSap } from "../sap.service.js";
import { normalizeDateQuery } from "../filters/dateFilters.js";

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value, width) {
  const text = cleanString(value);
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  return digits ? digits.padStart(width, "0") : text;
}

function parseDecimal(value, fieldName) {
  const text = cleanString(value).replace(/,/g, "");
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`${fieldName} is invalid`);
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(`${whole || "0"}${fraction}` || "0");
  return { units: negative ? -units : units, scale: fraction.length };
}

function align(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const factor = (value) => value.units * 10n ** BigInt(scale - value.scale);
  return { left: factor(left), right: factor(right), scale };
}

function decimalToString(value, minimumScale = 0) {
  const scale = Math.max(value.scale, minimumScale);
  const units = value.units * 10n ** BigInt(scale - value.scale);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  if (!scale) return `${negative ? "-" : ""}${digits}`;
  const splitAt = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

function getInvoiceKey(row) {
  const poNo = normalizeKey(row?.purch_doc_no, 10);
  const poItem = normalizeKey(row?.purch_item_no, 5);
  return poNo && poItem ? `${poNo}:${poItem}` : "";
}

export function aggregateInvoiceQuantities(invoiceRows = [], { logger = console } = {}) {
  const totals = new Map();
  for (const row of Array.isArray(invoiceRows) ? invoiceRows : []) {
    const key = getInvoiceKey(row);
    if (!key) {
      logger?.warn?.("Skipping invoice record with missing PO number or item", { accountingDocument: row?.acc_doc_no || null });
      continue;
    }
    const rawQuantity = row?.qty_inv_purchse_ordr_uom;
    if (rawQuantity === null || rawQuantity === undefined || cleanString(rawQuantity) === "") {
      logger?.warn?.("Invoice quantity is missing", { poNumber: row?.purch_doc_no, poItem: row?.purch_item_no, accountingDocument: row?.acc_doc_no || null });
      continue;
    }
    try {
      const quantity = parseDecimal(rawQuantity, "Invoice quantity");
      const existing = totals.get(key) || { units: 0n, scale: 0 };
      const aligned = align(existing, quantity);
      totals.set(key, { units: aligned.left + aligned.right, scale: aligned.scale });
    } catch (error) {
      logger?.warn?.(error.message, { poNumber: row?.purch_doc_no, poItem: row?.purch_item_no, accountingDocument: row?.acc_doc_no || null });
    }
  }
  return totals;
}

export function calculatePendingInvoiceQuantity({ poRow = {}, invoiceRows = [], invoiceTotals = null, logger = console } = {}) {
  const poNo = normalizeKey(poRow?.PoNo, 10);
  const poItem = normalizeKey(poRow?.PoItem, 5);
  const result = { poNo: cleanString(poRow?.PoNo), poItem: cleanString(poRow?.PoItem), poQuantity: null, invoicedQuantity: "0", pendingInvoiceQuantity: null, valid: true, error: null };

  if (poRow?.PoQuantity === null || poRow?.PoQuantity === undefined || cleanString(poRow?.PoQuantity) === "") {
    result.valid = false;
    result.error = "PO quantity is missing";
    logger?.warn?.("PO quantity is missing", { poNumber: poRow?.PoNo, poItem: poRow?.PoItem });
    return result;
  }

  let poQuantity;
  try {
    poQuantity = parseDecimal(poRow.PoQuantity, "PO quantity");
  } catch (error) {
    result.valid = false;
    result.error = error.message;
    logger?.warn?.(error.message, { poNumber: poRow?.PoNo, poItem: poRow?.PoItem });
    return result;
  }

  const totals = invoiceTotals || aggregateInvoiceQuantities(invoiceRows, { logger });
  const invoiced = totals.get(`${poNo}:${poItem}`) || { units: 0n, scale: 0 };
  const aligned = align(poQuantity, invoiced);
  const pendingUnits = aligned.left - aligned.right;
  const pending = pendingUnits < 0n ? 0n : pendingUnits;
  const outputScale = Math.max(poQuantity.scale, invoiced.scale);

  result.poQuantity = decimalToString(poQuantity, poQuantity.scale);
  result.invoicedQuantity = decimalToString(invoiced, outputScale);
  result.pendingInvoiceQuantity = decimalToString({ units: pending, scale: aligned.scale }, outputScale);
  if (pendingUnits < 0n) {
    logger?.warn?.(`Invoice quantity exceeds PO quantity for PO ${result.poNo} item ${result.poItem}.`, { poNumber: result.poNo, poItem: result.poItem });
  }
  return result;
}

export function calculatePendingInvoiceRows({ poRows = [], invoiceRows = [], logger = console } = {}) {
  const invoiceTotals = aggregateInvoiceQuantities(invoiceRows, { logger });
  return (Array.isArray(poRows) ? poRows : []).map((poRow) => calculatePendingInvoiceQuantity({ poRow, invoiceTotals, logger }));
}

function normalizeField(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function serviceField(service, candidates, fallback) {
  const fields = Array.isArray(service?.fields)
    ? service.fields
    : Array.isArray(service?.pendingPoFields)
      ? service.pendingPoFields.map((name) => ({ name }))
      : Array.isArray(service?.fieldNames)
        ? service.fieldNames.map((name) => ({ name }))
        : [];
  for (const candidate of candidates) {
    const match = fields.find((field) => normalizeField(field?.name) === normalizeField(candidate));
    if (match?.name) return match.name;
  }
  return fallback;
}

function parseDateOnly(value) {
  const text = cleanString(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

export function resolvePendingInvoiceScope(query, { today = new Date() } = {}) {
  const text = cleanString(query);
  const baseToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayText = baseToday.toISOString().slice(0, 10);
  const poMatch = text.match(/\b(?:po|purchase\s*order)\s*(?:number|no\.?|#)?\s*(\d{8,12})\b/i) || text.match(/\b(\d{8,12})\b/);
  const itemMatch = text.match(/\b(?:item|line\s*item)\s*(\d{1,6})\b/i);
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const dateResult = normalizeDateQuery(text);
  const hasExplicitDateRange = /\b(?:from|between)\b.+\b(?:to|and)\b/i.test(text);
  const relativeMatch = text.match(/\blast\s+(\d+)\s+(day|days|month|months|year|years)\b/i);
  const poNumber = poMatch?.[1] || null;
  const poItem = itemMatch?.[1] || null;

  let fromDate = "";
  let toDate = "";
  let relativePeriod = null;
  let dateScope = "LAST_2_YEARS";

  if (hasExplicitDateRange && dateResult?.startDate && dateResult?.endDate) {
    fromDate = parseDateOnly(dateResult.startDate);
    const exclusiveEnd = parseDateOnly(dateResult.endDate);
    toDate = exclusiveEnd ? new Date(`${exclusiveEnd}T00:00:00Z`).getTime() > baseToday.getTime() ? todayText : new Date(new Date(`${exclusiveEnd}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10) : "";
    dateScope = "EXPLICIT_DATE_RANGE";
  } else if (yearMatch) {
    const year = Number(yearMatch[0]);
    fromDate = `${year}-01-01`;
    toDate = `${year}-12-31`;
    dateScope = `YEAR_${year}`;
  } else if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const from = new Date(baseToday);
    if (unit.startsWith("day")) from.setUTCDate(from.getUTCDate() - amount);
    else if (unit.startsWith("month")) from.setUTCMonth(from.getUTCMonth() - amount);
    else from.setUTCFullYear(from.getUTCFullYear() - amount);
    fromDate = from.toISOString().slice(0, 10);
    toDate = todayText;
    relativePeriod = `LAST_${amount}_${unit.toUpperCase().replace(/S$/, "")}${amount === 1 ? "" : "S"}`;
    dateScope = relativePeriod;
  } else {
    const from = new Date(baseToday);
    from.setUTCFullYear(from.getUTCFullYear() - 2);
    fromDate = from.toISOString().slice(0, 10);
    toDate = todayText;
  }

  return {
    intent: "PENDING_INVOICE_STATUS",
    scope: poNumber ? "SINGLE_PO" : "ALL_PO_ITEMS",
    poNumber,
    poItem,
    year: yearMatch ? Number(yearMatch[0]) : null,
    fromDate,
    toDate,
    relativePeriod,
    dateScope,
    dateAppliedTo: "PO_DATE",
  };
}

export function buildSafeODataFilter(parts = []) {
  return (Array.isArray(parts) ? parts : []).filter((part) => part && typeof part === "string" && !/\b(?:null|undefined)\b/i.test(part)).join(" and ");
}

export function getPendingInvoiceFieldConfig(poService = {}, rsegService = {}) {
  return {
    poNoField: serviceField(poService, ["PoNo", "po_no", "EBELN"], poService.idField || "PoNo"),
    poItemField: serviceField(poService, ["PoItem", "po_item", "EBELP"], poService.itemField || "PoItem"),
    poQuantityField: serviceField(poService, ["PoQuantity", "PO_Quantity", "Menge"], "PoQuantity"),
    deliveredField: serviceField(poService, ["Delivered", "Wemng"], "Delivered"),
    poDateField: serviceField(poService, ["PoDocDate", "po_doc_date", "CrtDate", "BEDAT"], "PoDocDate"),
    rsegPoNoField: serviceField(rsegService, ["purch_doc_no"], "purch_doc_no"),
    rsegPoItemField: serviceField(rsegService, ["purch_item_no"], "purch_item_no"),
  };
}

export function buildPendingInvoicePoQuery({ service, scope, fieldConfig = getPendingInvoiceFieldConfig(service) }) {
  const filters = [`${fieldConfig.poDateField} ge datetime'${scope.fromDate}T00:00:00'`, `${fieldConfig.poDateField} le datetime'${scope.toDate}T23:59:59'`];
  if (scope.poNumber) filters.push(`${fieldConfig.poNoField} eq '${String(scope.poNumber).replace(/'/g, "''")}'`);
  if (scope.poItem) filters.push(`${fieldConfig.poItemField} eq '${String(scope.poItem).replace(/'/g, "''")}'`);
  return buildEntitySetQuery(service.entitySet, { $filter: buildSafeODataFilter(filters), $top: 200 }, { maxTop: 200 });
}

export function buildPendingInvoiceRsegQuery({ service, scope, poRows = [], fieldConfig = getPendingInvoiceFieldConfig({}, service) }) {
  const filters = [];
  if (scope.poNumber) filters.push(`${fieldConfig.rsegPoNoField} eq '${String(scope.poNumber).replace(/'/g, "''")}'`);
  if (scope.poItem) filters.push(`${fieldConfig.rsegPoItemField} eq '${String(scope.poItem).replace(/'/g, "''")}'`);
  if (!scope.poNumber && poRows.length) {
    const poNumbers = [...new Set(poRows.map((row) => cleanString(row?.PoNo)).filter(Boolean))];
    if (poNumbers.length > 0) {
      filters.push(`(${poNumbers.map((poNumber) => `${fieldConfig.rsegPoNoField} eq '${poNumber.replace(/'/g, "''")}'`).join(" or ")})`);
    }
  }
  return buildEntitySetQuery(service.entitySet, { $filter: buildSafeODataFilter(filters), $top: 200 }, { maxTop: 200 });
}

export async function executePendingInvoiceFlow({ system, sapAuth, poService, rsegService, scope, logger = console, fetchSap = fetchFromSap } = {}) {
  const fieldConfig = getPendingInvoiceFieldConfig(poService, rsegService);
  const pageSize = Math.max(1, Math.min(30, Number(scope?.pageSize) || 30));
  const cursor = Math.max(0, Number(scope?.cursor) || 0);
  const poQuery = buildPendingInvoicePoQuery({ service: poService, scope, fieldConfig });
  logger?.log?.("[PENDING_INVOICE_PO_REQUEST]", { scope, query: poQuery });

  let poResponse;
  try {
    poResponse = await fetchSap({ system, service: poService, relativePath: poQuery, requestMeta: { feature: "pending_invoice" } }, sapAuth);
  } catch (error) {
    logger?.error?.("[PENDING_INVOICE_ERROR] PO API failed", { poNumber: scope.poNumber, reason: error?.message });
    return { ok: false, status: "SAP_API_ERROR", scope, poRows: [], rsegRows: [], error };
  }

  const poRows = Array.isArray(poResponse?.d?.results) ? poResponse.d.results.map((row) => ({
    ...row,
    PoNo: row?.PoNo ?? row?.po_no ?? row?.EBELN,
    PoItem: row?.PoItem ?? row?.po_item ?? row?.EBELP,
    PoQuantity: row?.PoQuantity ?? row?.PO_Quantity ?? row?.Menge,
    Delivered: row?.Delivered ?? row?.Wemng,
  })) : [];
  if (!poRows.length) return { ok: true, status: scope.scope === "SINGLE_PO" ? "PO_NOT_FOUND" : "NO_PO_RECORDS_IN_DATE_RANGE", scope, poRows, rsegRows: [], statusRows: [] };

  const rsegQuery = buildPendingInvoiceRsegQuery({ service: rsegService, scope, poRows, fieldConfig });
  logger?.log?.("[PENDING_INVOICE_RSEG_REQUEST]", { scope, query: rsegQuery });
  let rsegResponse;
  try {
    rsegResponse = await fetchSap({ system, service: rsegService, relativePath: rsegQuery, requestMeta: { feature: "pending_invoice" } }, sapAuth);
  } catch (error) {
    logger?.error?.("[PENDING_INVOICE_ERROR] RSEG API failed", { poNumber: scope.poNumber, reason: error?.message });
    return { ok: false, status: "INCOMPLETE_INVOICE_DATA", scope, poRows, rsegRows: [], error };
  }

  const selectedKeys = new Set(poRows.map((row) => getInvoiceKey({ purch_doc_no: row?.PoNo, purch_item_no: row?.PoItem })).filter(Boolean));
  const rsegRows = (Array.isArray(rsegResponse?.d?.results) ? rsegResponse.d.results : []).filter((row) => selectedKeys.has(getInvoiceKey(row)));
  const allStatusRows = calculatePendingInvoiceRows({ poRows, invoiceRows: rsegRows, logger }).map((row) => ({ ...row, dateScope: scope }));
  const statusRows = allStatusRows.slice(cursor, cursor + pageSize);
  const nextPage = cursor + pageSize < allStatusRows.length ? { cursor: cursor + pageSize } : null;
  const hasMore = Boolean(nextPage);
  logger?.log?.("[PENDING_INVOICE_AGGREGATION]", { poCount: poRows.length, invoiceCount: rsegRows.length, returned: statusRows.length, total: allStatusRows.length });
  return { ok: true, status: "SUCCESS", scope, poRows, rsegRows, statusRows, hasMore, nextPage, totalCount: allStatusRows.length, poQuery, rsegQuery };
}