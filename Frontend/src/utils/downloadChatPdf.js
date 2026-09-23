import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

function cleanString(value) {
  return String(value || "").trim();
}

function formatFriendlyDate(value) {
  const s = cleanString(value);
  if (!s) return "";

  const compact = s.replace(/[^0-9]/g, "");
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}/${compact.slice(4, 6)}/${compact.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s.replaceAll("-", "/");
  }

  return s;
}

function formatCellValue(value) {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map(formatCellValue).join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function parseDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const s = cleanString(value);
  if (!s) return null;

  const compact = s.replace(/[^0-9]/g, "");
  if (/^\d{8}$/.test(compact)) {
    return new Date(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const date = new Date(`${s}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) {
    const normalized = s.replaceAll("/", "-");
    const date = new Date(`${normalized}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : new Date(native.getFullYear(), native.getMonth(), native.getDate());
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function extractRowDateValue(row) {
  if (!row || typeof row !== "object") return null;

  const candidateKeys = [
    "CrtDate",
    "CREATED_ON",
    "CREATEDON",
    "CREATED_AT",
    "CreatedOn",
    "createdOn",
    "CreatedAt",
    "createdAt",
    "DATE",
    "Date",
    "date",
    "DOC_DATE",
    "DocumentDate",
    "documentDate",
    "POST_DATE",
    "PostingDate",
    "postingDate",
  ];

  for (const key of candidateKeys) {
    const value = row?.[key];
    if (value != null && cleanString(value)) return value;
  }

  for (const key of Object.keys(row)) {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized.includes("date") && !normalized.includes("created") && !normalized.includes("crt")) {
      continue;
    }

    const value = row?.[key];
    if (value != null && cleanString(value)) return value;
  }

  return null;
}

export function filterRowsByDateRange(rows = [], fromDate, toDate) {
  const from = parseDateValue(fromDate);
  const to = parseDateValue(toDate);

  if (!from || !to) return [];

  const start = startOfDay(from).getTime();
  const end = endOfDay(to).getTime();

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const rowDate = extractRowDateValue(row);
    const parsed = parseDateValue(rowDate);
    if (!parsed) return false;

    const ts = parsed.getTime();
    return ts >= start && ts <= end;
  });
}

function formatExportDate(value) {
  const date = parseDateValue(value);
  if (!date) return cleanString(value).replace(/\//g, "-");

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildExportFileName(baseName, fromDate, toDate, extension) {
  const safeBase = cleanString(baseName || "report").replace(/\.[^.]+$/, "") || "report";
  const from = formatExportDate(fromDate) || "from-date";
  const to = formatExportDate(toDate) || "to-date";
  return `${safeBase}_${from}_to_${to}.${extension}`;
}

function summarizeFilters(filters = {}) {
  const parts = [];

  const businessScope = cleanString(filters.businessScope);
  const processType = cleanString(filters.processType);
  const createdBy = cleanString(filters.createdBy);
  const status = cleanString(filters.status);
  const fromDate = formatFriendlyDate(filters.fromDate);
  const toDate = formatFriendlyDate(filters.toDate);

  if (businessScope) parts.push(`Landscape: ${businessScope}`);
  if (processType) parts.push(`Process Type: ${processType}`);
  if (createdBy) parts.push(`Created By: ${createdBy}`);
  if (status) parts.push(`Status: ${status}`);
  if (fromDate || toDate) {
    parts.push(`Date Range: ${fromDate || "-"} to ${toDate || "-"}`);
  }

  return parts;
}

function buildTableColumns(rows = []) {
  const firstRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!firstRow || typeof firstRow !== "object") {
    return [];
  }

  const hasSolmanShape =
    "OBJECT_ID" in firstRow ||
    "OBJ_ID" in firstRow ||
    "SHORT_DESC" in firstRow ||
    "PROCESS_TYPE" in firstRow ||
    "CREATED_ON" in firstRow;

  if (hasSolmanShape) {
    return ["S.N", "CR Number", "Status", "Created On", "Short Description"];
  }

  const hasPoShape =
    "PoNo" in firstRow ||
    "PoItem" in firstRow ||
    "UserCreated" in firstRow ||
    "SuppAcoutNo" in firstRow ||
    "CurKey" in firstRow ||
    "CrtDate" in firstRow;

  if (hasPoShape) {
    return [
      "S.N",
      "PoNo",
      "PoItem",
      "UserCreated",
      "SuppAcoutNo",
      "CurKey",
      "CrtDate",
    ];
  }

  return [
    "S.N",
    ...Object.keys(firstRow).filter((key) => {
    const normalized = String(key || "").trim().toLowerCase();

    if (["_id", "__v"].includes(normalized)) return false;
    if (normalized.includes("url")) return false;
    if (normalized.includes("link")) return false;
    if (normalized.includes("metadata")) return false;

    return true;
    }),
  ];
}

function buildTableRows(rows = [], columns = []) {
  const isSolmanColumns =
    columns.length === 5 &&
    columns[0] === "S.N" &&
    columns[1] === "CR Number" &&
    columns[2] === "Status" &&
    columns[3] === "Created On" &&
    columns[4] === "Short Description";

  if (isSolmanColumns) {
    return rows.map((row, index) => [
      String(index + 1),
      cleanString(row?.OBJECT_ID || row?.OBJ_ID || row?.CR_NUMBER || row?.CR_NO || row?.CR || "-"),
      cleanString(row?.STATUS || row?.STATU || row?.STATUS_TEXT || "-"),
      formatFriendlyDate(row?.CREATED_ON || row?.CREATEDON || row?.CREATED_AT || "-"),
      cleanString(row?.SHORT_DESC || row?.SHORT_DESCRIPTION || row?.DESCRIPTION || "-"),
    ]);
  }

  const isPoColumns =
    columns.length === 7 &&
    columns[0] === "S.N" &&
    columns[1] === "PoNo" &&
    columns[2] === "PoItem" &&
    columns[3] === "UserCreated" &&
    columns[4] === "SuppAcoutNo" &&
    columns[5] === "CurKey" &&
    columns[6] === "CrtDate";

  if (isPoColumns) {
    return rows.map((row, index) => [
      String(index + 1),
      cleanString(row?.PoNo || row?.PONo || row?.PO_NO || row?.poNo || row?.po_number || row?.poNumber || ""),
      cleanString(row?.PoItem || row?.POItem || row?.poItem || row?.item || ""),
      cleanString(row?.UserCreated || row?.USERCREATED || row?.CreatedBy || row?.CREATED_BY || ""),
      cleanString(row?.SuppAcoutNo || row?.SuppAccountNo || row?.SupplierAccountNo || row?.supplierAccountNo || ""),
      cleanString(row?.CurKey || row?.CurrencyKey || row?.currencyKey || row?.CURRENCY || ""),
      formatFriendlyDate(row?.CrtDate || row?.CreatedOn || row?.createdOn || row?.CreationDate || ""),
    ]);
  }

  return rows.map((row, index) => {
    const cells = columns
      .slice(1)
      .map((column) => formatCellValue(row?.[column] ?? "-"));
    return [String(index + 1), ...cells];
  });
}

function buildChartRows(chartData = null, rows = []) {
  if (chartData && Array.isArray(chartData.data)) {
    return chartData.data.map((item) => [
      cleanString(item?.status || item?.label || "-"),
      String(item?.count ?? 0),
      item?.percentage != null ? `${item.percentage}%` : "-",
    ]);
  }

  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = cleanString(row?.STATUS || row?.status || "Unknown") || "Unknown";
    counts.set(status, (counts.get(status) || 0) + 1);
  }

  if (counts.size === 0) return [];

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts.entries()].map(([status, count]) => [
    status,
    String(count),
    total > 0 ? `${Math.round((count / total) * 100)}%` : "0%",
  ]);
}

function buildPdfDocument({
  title = "SAP Chat Export",
  sectionLabel = "Current section",
  summary = "",
  rows = [],
  chartData = null,
  filters = {},
  includeResultTable = true,
} = {}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 40;
  let cursorY = 44;

  const safeRows = Array.isArray(rows) ? rows : [];
  const tableColumns = buildTableColumns(safeRows);
  const exportSummary = buildExportSummary({ summary, totalCount: safeRows.length, filters });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title, marginX, cursorY);

  cursorY += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(sectionLabel, marginX, cursorY);

  cursorY += 22;
  doc.setFontSize(11);
  const wrappedSummary = doc.splitTextToSize(exportSummary, pageWidth - marginX * 2);
  doc.text(wrappedSummary, marginX, cursorY);
  cursorY += wrappedSummary.length * 14 + 10;

  const chartRows = buildChartRows(chartData, safeRows);
  if (chartRows.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Chart Summary", marginX, cursorY);
    cursorY += 10;

    autoTable(doc, {
      startY: cursorY + 10,
      head: [["Status", "Count", "Percent"]],
      body: chartRows,
      theme: "grid",
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [38, 100, 55] },
      margin: { left: marginX, right: marginX },
    });

    cursorY = doc.lastAutoTable?.finalY || cursorY;
    cursorY += 20;
  }

  if (includeResultTable && tableColumns.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Result Table", marginX, cursorY);
    cursorY += 10;

    autoTable(doc, {
      startY: cursorY + 10,
      head: [[...tableColumns]],
      body: buildTableRows(safeRows, tableColumns),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 3, valign: "top" },
      headStyles: { fillColor: [38, 100, 55] },
      margin: { left: marginX, right: marginX },
    });
  }

  return doc;
}

export function buildExportSummary({ summary = "", totalCount = 0, filters = {} } = {}) {
  const trimmed = cleanString(summary);
  if (trimmed) return trimmed;

  const filterParts = summarizeFilters(filters);
  const filterText = filterParts.length ? ` ${filterParts.join(". ")}.` : ".";

  if (Number(totalCount) <= 0) {
    return `No records were found${filterText}`;
  }

  return `I found ${totalCount} records${filterText}`;
}

export function downloadChatSectionPdf({
  title = "SAP Chat Export",
  sectionLabel = "Current section",
  summary = "",
  rows = [],
  chartData = null,
  filters = {},
  includeResultTable = true,
  filename = "sap-chat-export.pdf",
} = {}) {
  const doc = buildPdfDocument({ title, sectionLabel, summary, rows, chartData, filters, includeResultTable });
  doc.save(filename);
}

export function createChatExportPdfBlob({
  title = "SAP Chat Export",
  sectionLabel = "Current section",
  summary = "",
  rows = [],
  chartData = null,
  filters = {},
  includeResultTable = true,
} = {}) {
  const doc = buildPdfDocument({ title, sectionLabel, summary, rows, chartData, filters, includeResultTable });
  return doc.output("blob");
}

export function downloadChatSectionExcel({
  title = "SAP Chat Export",
  sectionLabel = "Date range",
  summary = "",
  rows = [],
  filters = {},
  filename = "sap-chat-export.xlsx",
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const tableColumns = buildTableColumns(safeRows);
  const tableRows = buildTableRows(safeRows, tableColumns);

  const worksheet = XLSX.utils.aoa_to_sheet([
    [title],
    [sectionLabel],
    [summary],
    [],
    ["Filters"],
    ...summarizeFilters(filters).map((item) => [item]),
    [],
    tableColumns,
    ...tableRows,
  ]);

  worksheet["!cols"] = tableColumns.map((column) => ({ wch: Math.max(12, String(column || "").length + 2) }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Export");
  XLSX.writeFile(workbook, filename);
}

export function createChatExportExcelArrayBuffer({
  title = "SAP Chat Export",
  sectionLabel = "Date range",
  summary = "",
  rows = [],
  filters = {},
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const tableColumns = buildTableColumns(safeRows);
  const tableRows = buildTableRows(safeRows, tableColumns);

  const worksheet = XLSX.utils.aoa_to_sheet([
    [title],
    [sectionLabel],
    [summary],
    [],
    ["Filters"],
    ...summarizeFilters(filters).map((item) => [item]),
    [],
    tableColumns,
    ...tableRows,
  ]);

  worksheet["!cols"] = tableColumns.map((column) => ({ wch: Math.max(12, String(column || "").length + 2) }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Export");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" });
}

export function buildExportFilename({ baseName = "report", fromDate, toDate, format = "pdf" } = {}) {
  const ext = String(format || "pdf").trim().toLowerCase() === "xlsx" ? "xlsx" : "pdf";
  return buildExportFileName(baseName, fromDate, toDate, ext);
}

export function buildRowsFromChartOrTable(payload = null) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.d?.results)) {
    return payload.d.results;
  }

  if (Array.isArray(payload?.result?.d?.results)) {
    return payload.result.d.results;
  }

  if (Array.isArray(payload?.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}
