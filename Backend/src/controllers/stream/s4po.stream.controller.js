import { extractDocQuery } from "../../services/extractor/extractor.service.js";
import { buildEntitySetQuery, normalizeNumericId } from "../../services/odataQueryBuilder.js";
import { fetchFromSap } from "../../services/sap.service.js";
import { extractQuantityValue } from "../../services/sap/sapValueExtractor.service.js";
import { getAllowedFieldsWithLabels } from "../../services/allowlist.service.js";
import { generateSummaryLLM } from "../../services/responseNarrator.service.js";
import { resolveServiceIntent } from "../../services/routing/serviceIntentResolver.service.js";
import { executePurchaseOrderFlow } from "../../services/procurement/purchaseOrderFlow.service.js";
import { detectDocumentFlowIntent, isPurchaseOrderFlowRequest } from "../../services/procurement/procurementQueryEngine.service.js";
import {
  assertPendingPoServiceCompatibility,
  buildPendingPoIntentPayload,
  detectPendingPoIntent,
  extractPendingPoNumber,
  getPendingPurchaseOrderList,
  PENDING_PO_ENTITY_SET,
  PENDING_PO_SERVICE_NAME,
} from "../../services/procurement/pendingPurchaseOrder.service.js";
import {
  hasPoQuerySignals,
  hasStructuredPoRequest,
} from "../../services/extractor/extractor.service.js";

import { ChatSession } from "../../models/ChatSession.model.js";
import { SapSystem } from "../../models/SapSystem.model.js";
import { SapServiceMap } from "../../models/SapServiceMap.model.js";

import {
  buildGenericTableReply,
  getOrCreateSession,
  getSapAuthOrThrow,
  normalizeSapUser,
  normalizeSystemId,
  saveAssistantMessage,
  saveUserMessage,
  step,
  toResultsArray,
} from "./stream.shared.js";
import { loadLastAssistantMemory } from "../_chat/memory.js";
import { isNextIntent, parseNextCount } from "../_chat/pagination.js";
import {
  calculatePendingInvoiceRows,
  executePendingInvoiceFlow,
  resolvePendingInvoiceScope,
} from "../../services/procurement/pendingInvoice.service.js";

function getDeploymentOwner(baseOwner = "local") {
  const scope = String(process.env.MONGODB_DB_NAME || process.env.APP_NAMESPACE || "").trim();
  return scope ? `${baseOwner}:${scope}` : baseOwner;
}

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function formatPriceWithCurrency(price, currency) {
  const priceText = cleanString(price);
  const currencyText = cleanString(currency);

  if (priceText && currencyText) {
    return `${priceText} ${currencyText}`;
  }

  return priceText || currencyText || "-";
}

function readPoSummaryValue(row = {}, fieldNames = []) {
  for (const fieldName of Array.isArray(fieldNames) ? fieldNames : []) {
    const value = cleanText(row?.[fieldName]);
    if (value !== "-") return value;
  }
  return "-";
}

function buildPurchaseDocumentSummaryRows(poRows = [], poNo = "NULL", poItem = "NULL") {
  const rows = Array.isArray(poRows) && poRows.length > 0 ? poRows : [{}];

  return rows.map((row) => [
    cleanText(row?.PoNo || poNo),
    cleanText(row?.PoItem || poItem),
    readPoSummaryValue(row, ["MatNo", "material", "material_no", "MaterialNumber", "Material"]),
    readPoSummaryValue(row, ["SuppAcoutNo", "SuppAccountNo", "SupplierAccountNo", "supplierAccountNo", "Supplier", "vendor", "Vendor"]),
    readPoSummaryValue(row, ["PoQuantity", "PO_Quantity", "Menge", "Quantity", "TotalPoQuantity"]),
  ]);
}

function buildFallbackPoService(serviceIntent) {
  const keys = Array.isArray(serviceIntent?.keys)
    ? serviceIntent.keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];

  return {
    owner: getDeploymentOwner("local"),
    systemId: String(serviceIntent?.systemId || "").trim().toUpperCase(),
    serviceType: "PO",
    serviceName: String(serviceIntent?.serviceName || process.env.DEFAULT_PO_SERVICE_NAME || "ZMM_PO_DETAILS_SRV").trim(),
    entitySet: String(serviceIntent?.entitySet || process.env.DEFAULT_PO_ENTITYSET || "Po_detailsSet").trim(),
    entityTypeName: String(serviceIntent?.entityTypeName || "Po_details").trim(),
    idField: String(serviceIntent?.idField || keys[0] || "PoNo").trim(),
    itemField: String(serviceIntent?.itemField || keys[1] || "PoItem").trim(),
    idPad: Number.isFinite(Number(serviceIntent?.idPad)) ? Number(serviceIntent.idPad) : 10,
    itemPad: Number.isFinite(Number(serviceIntent?.itemPad)) ? Number(serviceIntent.itemPad) : 5,
  };
}

function buildDocumentFlowServiceIntent({ query, serviceIntent, systemId, serviceIntentFallback }) {
  const documentFlowIntent = detectDocumentFlowIntent(query) || cleanString(serviceIntent?.collected?.documentFlowIntent || serviceIntent?.entities?.documentFlowIntent || serviceIntent?.documentFlowIntent || "") || null;
  if (!documentFlowIntent) return serviceIntent;

  if (serviceIntent?.matchFound && serviceIntent?.serviceName && serviceIntent?.entitySet) {
    return serviceIntent;
  }

  const fallback = serviceIntentFallback || {};
  if (!fallback?.serviceName || !fallback?.entitySet) {
    return serviceIntent;
  }

  return {
    matchFound: true,
    confidence: 0.95,
    systemId: String(systemId || fallback.systemId || "").trim().toUpperCase() || null,
    serviceName: String(fallback.serviceName || "").trim(),
    entitySet: String(fallback.entitySet || "").trim(),
    entityTypeName: String(fallback.entityTypeName || "").trim(),
    keys: Array.isArray(fallback.keys) ? fallback.keys : [],
    operation: "detail",
    docNumber: serviceIntent?.docNumber || null,
    docItem: serviceIntent?.docItem || null,
    fields: [],
    filters: [],
    orderBy: [],
    limit: 10,
    reason: `Document flow fallback for ${documentFlowIntent}`,
    candidatesConsidered: 1,
  };
}

function resolvePendingPoServiceMap(catalogs = [], fallbackSystemId = "") {
  const rows = Array.isArray(catalogs) ? catalogs : [];

  const preferred = rows.find((catalog) => {
    const serviceName = String(catalog?.serviceName || "").trim().toUpperCase();
    const entitySet = String(catalog?.entitySet || "").trim().toUpperCase();
    return serviceName === PENDING_PO_SERVICE_NAME || entitySet === PENDING_PO_ENTITY_SET;
  });
  if (preferred) return preferred;

  return null;
}

function inferEntityTypeName(service = {}) {
  const explicit = String(service?.entityTypeName || "").trim();
  if (explicit) return explicit;
  const entitySet = String(service?.entitySet || "").trim();
  if (!entitySet) return "";
  return entitySet.replace(/Set$/i, "");
}

function hasRequiredPendingPoFields(fields = []) {
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const set = new Set((Array.isArray(fields) ? fields : []).map((f) => normalize(f)));

  const hasAny = (candidates) => candidates.some((name) => set.has(normalize(name)));

  const hasPoNo = hasAny(["po_no", "PoNo", "EBELN"]);
  const hasPoItem = hasAny(["po_item", "PoItem", "EBELP"]);
  const hasDate = hasAny(["po_doc_date", "PoDocDate", "CrtDate", "BEDAT"]);
  const hasDirectPending = hasAny(["Pending_PO_Quantity", "pending_qty", "PendingQty"]);
  const hasOrdered = hasAny(["PO_Quantity", "PoQuantity", "Menge"]);
  const hasDelivered = hasAny(["Delivered", "delivered_qty", "Wemng"]);

  return hasPoNo && hasPoItem && hasDate && (hasDirectPending || (hasOrdered && hasDelivered));
}

async function resolveCompatiblePendingPoService({ catalogs = [], system, sapAuth }) {
  const preferred = resolvePendingPoServiceMap(catalogs, system?.systemId || "");
  const ordered = preferred
    ? [preferred, ...catalogs.filter((row) => row !== preferred)]
    : catalogs;

  for (const candidate of ordered) {
    if (!candidate?.serviceName || !candidate?.entitySet) continue;

    try {
      const { fields } = await getAllowedFieldsWithLabels({
        system,
        service: candidate,
        entityTypeName: inferEntityTypeName(candidate),
        authOverride: sapAuth,
      });

      if (hasRequiredPendingPoFields(fields)) {
        return {
          ...candidate,
          pendingPoFields: fields,
        };
      }
    } catch {
      // Ignore individual candidate metadata failures and continue probing other mappings.
    }
  }

  return null;
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;

  const datePortion = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePortion)) return datePortion;
  return "";
}

function detectPendingInvoiceIntent(query) {
  const text = String(query || "").toLowerCase();
  if (!text) return null;

  const normalized = text.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const hasPendingSignal =
    /\b(pending|remain(?:ing)?|yet\s+to|not\s+completed|status)\b/i.test(normalized) &&
    /\b(po|purchase\s*order)\b/i.test(normalized);
  const hasInvoiceSignal =
    /\b(invoice|invoices|invocie|inovice|invioce|invioice)\b/i.test(normalized);

  const intentHints = [
    "pending invoice",
    "pending invocie",
    "pending quantity",
    "invoice pending",
    "invocie pending",
    "invoice status",
    "remaining invoice quantity",
    "invoice not completed",
    "quantity yet to invoice",
    "quantity yet to invocie",
    "show pending invoice",
    "show pending invocie",
    "show pending quantity",
    "how much quantity is pending for invoice",
    "how much quantity is pending for invocie",
    "remaining quantity to invoice",
    "remaining quantity to invocie",
  ];

  if (intentHints.some((hint) => text.includes(hint))) return "PENDING_INVOICE_STATUS";
  if (hasPendingSignal && hasInvoiceSignal) return "PENDING_INVOICE_STATUS";
  return null;
}

function getPendingInvoiceExecutionPlan() {
  return ["ZIV_PO_DETAILS_CDS", "ZIV_RSEG_DETAILS_CDS"];
}

function extractPendingInvoiceContext(query) {
  const text = String(query || "");
  const poMatch = text.match(/\b\d{8,12}\b/);
  const itemMatch = text.match(/\bitem\s*(\d{1,6})\b/i);

  return {
    poNumber: poMatch?.[0] || "",
    poItem: itemMatch?.[1] || "",
  };
}

function cleanText(value, fallback = "NULL") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatQuantityValue(value, fallback = "0.000") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric.toFixed(3);
  }

  return text;
}

function numericQuantity(value) {
  const numeric = Number(String(value ?? "").trim());
  return Number.isFinite(numeric) ? numeric : 0;
}

function isZeroQuantity(value) {
  return /^0(?:\.0+)?$/.test(String(value ?? "").trim());
}

function getPoOrderedQuantity(poRow = {}) {
  return extractQuantityValue(poRow, ["PoQuantity"]);
}

function buildProcurementFlowReply({
  poRows = [],
  materialRows = [],
  invoiceRows = [],
  rbkpRows = [],
  acdocaRows = [],
  poNo = "NULL",
  poItem = "NULL",
  documentFlowIntent = "COMPLETE_DOCUMENT_FLOW",
} = {}) {
  const primary = Array.isArray(poRows) ? poRows[0] || {} : {};
  const material = Array.isArray(materialRows) ? materialRows[0] || {} : {};
  const invoice = Array.isArray(invoiceRows) ? invoiceRows[0] || {} : {};
  const header = Array.isArray(rbkpRows) ? rbkpRows[0] || {} : {};
  const accounting = Array.isArray(acdocaRows) ? acdocaRows[0] || {} : {};

  const normalizedIntent = String(documentFlowIntent || "COMPLETE_DOCUMENT_FLOW").trim().toUpperCase();
  const allowPricing = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "PRICING_DETAILS";
  const allowMaterial = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "MATERIAL_DOCUMENT";
  const allowInvoice = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "INVOICE_DETAILS";
  const allowAccounting = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "ACCOUNTING_DOCUMENT";

  const sections = [];

  if (normalizedIntent === "PRICING_DETAILS") {
    if (poRows.length > 0) {
      sections.push(
        buildTable("Pricing Details", [
          ["PO Number", cleanText(primary.PoNo || poNo)],
          ["PO Item", cleanText(primary.PoItem || poItem)],
          ["Net Price", cleanText(primary.NetPrice || primary.net_price || primary.price || primary.NetAmount || primary.net_value)],
          ["Net Value", cleanText(primary.NetValue || primary.net_value || primary.net_amount || primary.TotalNetValue || primary.TotalAmount)],
          ["Quantity", cleanText(primary.PO_Quantity || primary.PoQuantity || primary.Menge || primary.Quantity)],
          ["Currency", cleanText(primary.CurKey || primary.Currency || primary.currency || primary.CurrencyKey)],
        ])
      );
    }

    return sections.filter(Boolean).join("\n\n");
  }

  if (normalizedIntent === "INVOICE_DETAILS") {
    if (invoiceRows.length > 0) {
      sections.push(
        buildTable("Invoice Details", [
          ["Invoice Number", cleanText(invoice.acc_doc_no || invoice.BELNR)],
          ["Fiscal Year", cleanText(invoice.fiscal_year || invoice.GJAHR)],
          ["Invoice Item", cleanText(invoice.invoice_item || invoice.InvoiceItem || invoice.BUZEI)],
          ["Quantity", cleanText(invoice.quantity || invoice.InvoiceQuantity || invoice.MENGE)],
          ["Invoice Amount", cleanText(invoice.inv_amt_supplier || invoice.InvoiceAmount || invoice.amt_doc_curr)],
          ["Supplier Account", cleanText(invoice.supplier_acc_no || invoice.SupplierAccountNumber)],
        ])
      );
    }

    if (rbkpRows.length > 0) {
      sections.push(
        buildTable("Invoice Header", [
          ["Invoice Document", cleanText(header.invoice_doc_no || header.BELNR || header.InvoiceDocNo)],
          ["Fiscal Year", cleanText(header.fiscal_year || header.GJAHR)],
          ["Company Code", cleanText(header.company_code || header.BUKRS)],
          ["Invoice Party", cleanText(header.invoice_party || header.Supplier || header.LIFNR)],
          ["Gross Amount", cleanText(header.gross_amount || header.WRBTR)],
        ])
      );
    }

    return sections.filter(Boolean).join("\n\n");
  }

  if (normalizedIntent === "ACCOUNTING_DOCUMENT") {
    if (acdocaRows.length > 0) {
      sections.push(
        buildTable("Accounting Details", [
          ["Accounting Document Number", cleanText(accounting.doc_no_acctng_doc || accounting.AccountingDocument || accounting.BELNR)],
          ["Company Code", cleanText(accounting.company_code || accounting.BUKRS)],
          ["Account Number", cleanText(accounting.account_no || accounting.GLAccount || accounting.HKONT)],
          ["Supplier Account", cleanText(accounting.supplier_acc_no || accounting.SupplierAccountNumber)],
          ["Material Number", cleanText(accounting.material_no || accounting.MATNR)],
          ["Amount", cleanText(accounting.amt_company || accounting.Amount || accounting.WRBTR)],
        ])
      );
    }

    return sections.filter(Boolean).join("\n\n");
  }

  function buildTable(title, rows) {
    const visibleRows = (Array.isArray(rows) ? rows : []).filter((row) => Array.isArray(row) && row.length > 0);
    if (!visibleRows.length) return "";

    const header = `| Field | Value |`;
    const separator = `| --- | --- |`;
    const body = visibleRows.map(([field, value]) => `| ${field} | ${value} |`).join("\n");
    return [title, "", header, separator, body].join("\n");
  }

  sections.push(
    buildTable("Purchase Document Summary", [
      ["PO Number", cleanText(primary.PoNo || poNo)],
      ["PO Item", cleanText(primary.PoItem || poItem)],
    ])
  );

  if (allowMaterial && materialRows.length > 0) {
    sections.push(
      buildTable("Material Document", [
        ["Material Document Number", cleanText(material.mat_doc_no1 || material.MBLNR)],
        ["Movement Type", cleanText(material.movement_type || material.BWART)],
        ["Posting Date", cleanText(material.posting_date || material.BUDAT)],
        ["Quantity", cleanText(material.quantity || material.Menge)],
        ["Material Number", cleanText(material.material_no || material.MatNo)],
        ["Supplier Account", cleanText(material.supplier_acc_no || material.LIFNR)],
      ])
    );
  }

  if (allowInvoice && invoiceRows.length > 0) {
    sections.push(
      buildTable("Invoice Details", [
        ["Invoice Number", cleanText(invoice.acc_doc_no || invoice.BELNR)],
        ["Fiscal Year", cleanText(invoice.fiscal_year || invoice.GJAHR)],
        ["Invoice Item", cleanText(invoice.invoice_item || invoice.InvoiceItem || invoice.BUZEI)],
        ["Quantity", cleanText(invoice.quantity || invoice.InvoiceQuantity || invoice.MENGE)],
        ["Invoice Amount", cleanText(invoice.inv_amt_supplier || invoice.InvoiceAmount || invoice.amt_doc_curr)],
        ["Supplier Account", cleanText(invoice.supplier_acc_no || invoice.SupplierAccountNumber)],
      ])
    );
  }

  if (allowInvoice && rbkpRows.length > 0) {
    sections.push(
      buildTable("Invoice Header", [
        ["Invoice Document", cleanText(header.invoice_doc_no || header.BELNR || header.InvoiceDocNo)],
        ["Fiscal Year", cleanText(header.fiscal_year || header.GJAHR)],
        ["Company Code", cleanText(header.company_code || header.BUKRS)],
        ["Invoice Party", cleanText(header.invoice_party || header.Supplier || header.LIFNR)],
        ["Gross Amount", cleanText(header.gross_amount || header.WRBTR)],
      ])
    );
  }

  if (allowAccounting && acdocaRows.length > 0) {
    sections.push(
      buildTable("Accounting Details", [
        ["Accounting Document Number", cleanText(accounting.doc_no_acctng_doc || accounting.AccountingDocument || accounting.BELNR)],
        ["Company Code", cleanText(accounting.company_code || accounting.BUKRS)],
        ["Account Number", cleanText(accounting.account_no || accounting.GLAccount || accounting.HKONT)],
        ["Supplier Account", cleanText(accounting.supplier_acc_no || accounting.SupplierAccountNumber)],
        ["Material Number", cleanText(accounting.material_no || accounting.MATNR)],
        ["Amount", cleanText(accounting.amt_company || accounting.Amount || accounting.WRBTR)],
      ])
    );
  }

  return sections
    .filter(Boolean)
    .join("\n\n");
}

function buildProcurementFlowSections({
  poRows = [],
  materialRows = [],
  invoiceRows = [],
  rbkpRows = [],
  acdocaRows = [],
  poNo = "NULL",
  poItem = "NULL",
  documentFlowIntent = "COMPLETE_DOCUMENT_FLOW",
} = {}) {
  const primary = Array.isArray(poRows) ? poRows[0] || {} : {};

  const normalizedIntent = String(documentFlowIntent || "COMPLETE_DOCUMENT_FLOW").trim().toUpperCase();
  const allowMaterial = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "MATERIAL_DOCUMENT";
  const allowInvoice = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "INVOICE_DETAILS";
  const allowAccounting = normalizedIntent === "COMPLETE_DOCUMENT_FLOW" || normalizedIntent === "ACCOUNTING_DOCUMENT";

  if (normalizedIntent === "PRICING_DETAILS") {
    if (poRows.length > 0) {
      return [
        {
          title: "Pricing Details",
          columns: ["PO Number", "PO Item", "Net Price", "Net Value", "Quantity"],
          rows: (Array.isArray(poRows) && poRows.length > 0 ? poRows : [primary]).map((row) => [
            cleanText(row?.PoNo || poNo),
            cleanText(row?.PoItem || poItem),
            formatPriceWithCurrency(
              row?.NetPrice || row?.net_price || row?.price || row?.NetAmount || row?.net_value,
              row?.CurKey || row?.Currency || row?.currency || row?.CurrencyKey
            ),
            cleanText(row?.NetValue || row?.net_value || row?.net_amount || row?.TotalNetValue || row?.TotalAmount),
            cleanText(row?.PO_Quantity || row?.PoQuantity || row?.Menge || row?.Quantity),
          ]),
        },
      ];
    }

    return [];
  }

  const sections = [
    {
      title: "Purchase Document Summary",
      columns: ["PO Number", "PO Item", "Material Number", "Supplier", "Quantity"],
      rows: buildPurchaseDocumentSummaryRows(poRows, poNo, poItem),
    },
  ];

  if (normalizedIntent === "INVOICE_DETAILS") {
    return [
      ...(invoiceRows.length > 0
        ? [{
            title: "Invoice Details",
            columns: ["Invoice Number", "Fiscal Year", "Invoice Item", "Quantity", "Invoice Amount", "Supplier Account"],
            rows: invoiceRows.map((row) => [
              cleanText(row?.acc_doc_no || row?.BELNR),
              cleanText(row?.fiscal_year || row?.GJAHR),
              cleanText(row?.invoice_item || row?.InvoiceItem || row?.BUZEI),
              cleanText(row?.quantity || row?.InvoiceQuantity || row?.MENGE),
              cleanText(row?.inv_amt_supplier || row?.InvoiceAmount || row?.amt_doc_curr),
              cleanText(row?.supplier_acc_no || row?.SupplierAccountNumber),
            ]),
          }]
        : []),
      ...(rbkpRows.length > 0
        ? [{
            title: "Invoice Header",
            columns: ["Invoice Document", "Fiscal Year", "Company Code", "Invoice Party", "Gross Amount"],
            rows: rbkpRows.map((row) => [
              cleanText(row?.invoice_doc_no || row?.BELNR || row?.InvoiceDocNo),
              cleanText(row?.fiscal_year || row?.GJAHR),
              cleanText(row?.company_code || row?.BUKRS),
              cleanText(row?.invoice_party || row?.Supplier || row?.LIFNR),
              cleanText(row?.gross_amount || row?.WRBTR),
            ]),
          }]
        : []),
    ];
  }

  if (normalizedIntent === "ACCOUNTING_DOCUMENT") {
    return acdocaRows.length > 0
      ? [
          {
            title: "Accounting Details",
            columns: ["Accounting Document Number", "Company Code", "Account Number", "Supplier Account", "Material Number", "Amount"],
            rows: acdocaRows.map((row) => [
              cleanText(row?.doc_no_acctng_doc || row?.AccountingDocument || row?.BELNR),
              cleanText(row?.company_code || row?.BUKRS),
              cleanText(row?.account_no || row?.GLAccount || row?.HKONT),
              cleanText(row?.supplier_acc_no || row?.SupplierAccountNumber),
              cleanText(row?.material_no || row?.MATNR),
              cleanText(row?.amt_company || row?.Amount || row?.WRBTR),
            ]),
          },
        ]
      : [];
  }

  if (allowMaterial && materialRows.length > 0) {
    sections.push({
      title: "Material Document",
      columns: ["PO Number", "PO Item", "Material Document Number", "Movement Type", "Posting Date", "Quantity", "Material Number", "Supplier Account"],
      rows: materialRows.map((row) => [
        cleanText(row?.PoNo || poNo),
        cleanText(row?.PoItem || poItem),
        cleanText(row?.mat_doc_no1 || row?.MBLNR),
        cleanText(row?.movement_type || row?.BWART),
        cleanText(row?.posting_date || row?.BUDAT),
        cleanText(row?.quantity || row?.Menge),
        cleanText(row?.material_no || row?.MatNo),
        cleanText(row?.supplier_acc_no || row?.LIFNR),
      ]),
    });
  }

  if (allowInvoice && invoiceRows.length > 0) {
    sections.push({
      title: "Invoice Details",
      columns: ["PO Number", "PO Item", "Invoice Number", "Fiscal Year", "Invoice Item", "Quantity", "Invoice Amount", "Supplier Account"],
      rows: invoiceRows.map((row) => [
        cleanText(row?.PoNo || poNo),
        cleanText(row?.PoItem || poItem),
        cleanText(row?.acc_doc_no || row?.BELNR),
        cleanText(row?.fiscal_year || row?.GJAHR),
        cleanText(row?.invoice_item || row?.InvoiceItem || row?.BUZEI),
        cleanText(row?.quantity || row?.InvoiceQuantity || row?.MENGE),
        cleanText(row?.inv_amt_supplier || row?.InvoiceAmount || row?.amt_doc_curr),
        cleanText(row?.supplier_acc_no || row?.SupplierAccountNumber),
      ]),
    });
  }

  if (allowInvoice && rbkpRows.length > 0) {
    sections.push({
      title: "Invoice Header",
      columns: ["Invoice Document", "Fiscal Year", "Company Code", "Invoice Party", "Gross Amount"],
      rows: rbkpRows.map((row) => [
        cleanText(row?.invoice_doc_no || row?.BELNR || row?.InvoiceDocNo),
        cleanText(row?.fiscal_year || row?.GJAHR),
        cleanText(row?.company_code || row?.BUKRS),
        cleanText(row?.invoice_party || row?.Supplier || row?.LIFNR),
        cleanText(row?.gross_amount || row?.WRBTR),
      ]),
    });
  }

  if (allowAccounting && acdocaRows.length > 0) {
    sections.push({
      title: "Accounting Details",
      columns: ["Accounting Document Number", "Company Code", "Account Number", "Supplier Account", "Material Number", "Amount"],
      rows: acdocaRows.map((row) => [
        cleanText(row?.doc_no_acctng_doc || row?.AccountingDocument || row?.BELNR),
        cleanText(row?.company_code || row?.BUKRS),
        cleanText(row?.account_no || row?.GLAccount || row?.HKONT),
        cleanText(row?.supplier_acc_no || row?.SupplierAccountNumber),
        cleanText(row?.material_no || row?.MATNR),
        cleanText(row?.amt_company || row?.Amount || row?.WRBTR),
      ]),
    });
  }

  return sections;
}

function buildPendingInvoiceStatusReply({ poRow = {}, poRows = [], rsegRows = [], poNo = "NULL", poItem = "NULL" } = {}) {
  const statusRows = buildPendingInvoiceStatusRows({
    poRows: Array.isArray(poRows) && poRows.length > 0 ? poRows : (poRow && Object.keys(poRow).length ? [poRow] : []),
    rsegRows,
    poNo,
  });

  if (statusRows.length > 1) {
    const lines = [
      "Pending Invoice Status",
      "",
      `PO Number: ${cleanText(poNo)}`,
      `Items Evaluated: ${statusRows.length}`,
      "",
      "| PO Item | Material | Ordered Quantity | Invoiced Quantity | Pending Quantity | Invoice Status |",
      "| --- | --- | --- | --- | --- | --- |",
      ...statusRows.map((row) =>
        `| ${cleanText(row.poItem)} | ${cleanText(row.material)} | ${formatQuantityValue(row.orderedQuantity, "N/A")} | ${formatQuantityValue(row.invoicedQuantity, "N/A")} | ${formatQuantityValue(row.pendingQuantity, "N/A")} | ${cleanText(row.invoiceStatus)} |`
      ),
    ];

    return lines.join("\n");
  }

  const rows = Array.isArray(rsegRows) ? rsegRows : [];
  const calculation = calculatePendingInvoiceRows({ poRows: [poRow], invoiceRows: rows })[0];
  const invoiceStatus = !calculation.valid ? "Invalid PO Quantity" : rows.length === 0 ? "Not Invoiced" : !isZeroQuantity(calculation.pendingInvoiceQuantity) ? "Pending" : "Completed";

  console.log("[PENDING_INVOICE_QUANTITY_DEBUG]", {
    poNumber: poRow?.PoNo,
    poItem: poRow?.PoItem,
    availableFields: Object.keys(poRow || {}),
    orderedQuantity: getPoOrderedQuantity(poRow),
  });

  return [
    "Pending Invoice Status",
    "",
    `PO Number: ${cleanText(poRow?.PoNo || poNo)}`,
    `PO Item: ${cleanText(poRow?.PoItem || poItem)}`,
    `Material: ${cleanText(poRow?.MatNo || poRow?.material_no)}`,
    `Ordered Quantity: ${formatQuantityValue(calculation.poQuantity, "N/A")}`,
    `Invoiced Quantity: ${formatQuantityValue(calculation.invoicedQuantity, "N/A")}`,
    `Pending Quantity: ${formatQuantityValue(calculation.pendingInvoiceQuantity, "N/A")}`,
    `Invoice Status: ${invoiceStatus}`,
  ].join("\n");
}

function buildPendingInvoiceStatusRows({ poRows = [], rsegRows = [], poNo = "NULL" } = {}) {
  const sourcePoRows = Array.isArray(poRows) ? poRows : [];
  const sourceRsegRows = Array.isArray(rsegRows) ? rsegRows : [];

  const rsegByPoItem = new Map();
  for (const row of sourceRsegRows) {
    const poNumber = normalizeNumericId(row?.purch_doc_no || row?.PoNo || row?.po_no || row?.EBELN || "", 10);
    const item = normalizeNumericId(
      row?.purch_item_no || row?.PoItem || row?.po_item || row?.EBELP || row?.invoice_item || row?.InvoiceItem || row?.BUZEI || "",
      5
    );
    if (!poNumber || !item) continue;

    const key = `${poNumber}:${item}`;
    if (!rsegByPoItem.has(key)) {
      rsegByPoItem.set(key, []);
    }
    rsegByPoItem.get(key).push(row);
  }

  const calculations = calculatePendingInvoiceRows({ poRows: sourcePoRows, invoiceRows: sourceRsegRows });
  const statusRows = sourcePoRows.map((row, index) => {
    const normalizedPoItem = normalizeNumericId(row?.PoItem || row?.po_item || row?.poItem || row?.EBELP || "", 5);
    const normalizedPoNumber = normalizeNumericId(row?.PoNo || row?.po_no || row?.EBELN || poNo || "", 10);
    const matchingInvoices = normalizedPoNumber && normalizedPoItem ? (rsegByPoItem.get(`${normalizedPoNumber}:${normalizedPoItem}`) || []) : [];
    const calculation = calculations[index];
    const invoiceStatus = !calculation.valid ? "Invalid PO Quantity" : matchingInvoices.length === 0 ? "Not Invoiced" : !isZeroQuantity(calculation.pendingInvoiceQuantity) ? "Pending" : "Completed";

    return {
      poNumber: cleanText(row?.PoNo || row?.EBELN || poNo),
      poItem: cleanText(normalizedPoItem || row?.PoItem || row?.EBELP || "NULL"),
      material: cleanText(row?.MatNo || row?.material_no),
      orderedQuantity: calculation.poQuantity,
      invoicedQuantity: calculation.invoicedQuantity,
      pendingQuantity: calculation.pendingInvoiceQuantity,
      calculationStatus: calculation.valid ? "SUCCESS" : "INVALID_PO_QUANTITY",
      invoiceStatus,
    };
  });

  return statusRows;
}

function buildPendingInvoiceStatusSections({ poRow = {}, poRows = [], rsegRows = [], poNo = "NULL", poItem = "NULL" } = {}) {
  const derivedPoRows = Array.isArray(poRows) && poRows.length > 0
    ? poRows
    : (poRow && Object.keys(poRow).length ? [poRow] : []);
  const statusRows = buildPendingInvoiceStatusRows({
    poRows: derivedPoRows,
    rsegRows,
    poNo,
  });

  if (statusRows.length > 1) {
    return [
      {
        title: "Pending Invoice Status",
        columns: [
          "PO Number",
          "PO Item",
          "Material",
          "Ordered Quantity",
          "Invoiced Quantity",
          "Pending Quantity",
          "Invoice Status",
        ],
        rows: statusRows.map((row) => [
          cleanText(row.poNumber),
          cleanText(row.poItem),
          cleanText(row.material),
          formatQuantityValue(row.orderedQuantity, "N/A"),
          formatQuantityValue(row.invoicedQuantity, "N/A"),
          formatQuantityValue(row.pendingQuantity, "N/A"),
          cleanText(row.invoiceStatus),
        ]),
      },
    ];
  }

  const rows = Array.isArray(rsegRows) ? rsegRows : [];
  const calculation = calculatePendingInvoiceRows({ poRows: [poRow], invoiceRows: rows })[0];
  const invoiceStatus = !calculation.valid ? "Invalid PO Quantity" : rows.length === 0 ? "Not Invoiced" : !isZeroQuantity(calculation.pendingInvoiceQuantity) ? "Pending" : "Completed";

  return [
    {
      title: "Pending Invoice Status",
      columns: [
        "PO Number",
        "PO Item",
        "Material",
        "Ordered Quantity",
        "Invoiced Quantity",
        "Pending Quantity",
        "Invoice Status",
      ],
      rows: [[
        cleanText(poRow?.PoNo || poNo),
        cleanText(poRow?.PoItem || poItem),
        cleanText(poRow?.MatNo || poRow?.material_no),
        formatQuantityValue(calculation.poQuantity),
        formatQuantityValue(calculation.invoicedQuantity),
        formatQuantityValue(calculation.pendingInvoiceQuantity),
        invoiceStatus,
      ]],
    },
  ];
}

export {
  buildPendingInvoiceStatusReply,
  buildPendingInvoiceStatusSections,
  buildProcurementFlowReply,
  buildProcurementFlowSections,
  buildPurchaseDocumentSummaryRows,
  detectPendingInvoiceIntent,
  getPendingInvoiceExecutionPlan,
};

export function applyPoNextContinuationState({ query, extracted, previousMemory }) {
  const nextIntent = isNextIntent(query);
  const requestedNextCount = parseNextCount(query);

  const previousPoExtracted =
    previousMemory?.extracted &&
    previousMemory.extracted.docType === "PO" &&
    (previousMemory.extracted.listMode || previousMemory.extracted.orderBy || previousMemory.extracted.filters)
      ? previousMemory.extracted
      : null;

  if (!nextIntent) {
    return {
      nextIntent: false,
      requestedNextCount,
      previousPoExtracted: null,
      extracted,
      error: null,
    };
  }

  if (!previousPoExtracted) {
    return {
      nextIntent: true,
      requestedNextCount,
      previousPoExtracted: null,
      extracted,
      error: {
        message:
          "Please ask for a purchase order list first, then use the Load More button to see additional purchase orders.",
        status: "missing_po_context",
      },
    };
  }

  const previousReturnedCount = Array.isArray(previousMemory?.data) ? previousMemory.data.length : 0;
  const continuationStep = previousReturnedCount > 0 ? previousReturnedCount : Number(previousPoExtracted.limit) || 10;
  const nextLimit = requestedNextCount ?? (Number(previousPoExtracted.limit) || extracted.limit || 10);
  const nextSkip = (Number(previousPoExtracted.skip) || 0) + continuationStep;

  return {
    nextIntent: true,
    requestedNextCount,
    previousPoExtracted,
    extracted: {
      ...extracted,
      listMode: previousPoExtracted.listMode || extracted.listMode || "latest_po",
      fields: Array.isArray(previousPoExtracted.fields) ? previousPoExtracted.fields : extracted.fields,
      filters: Array.isArray(previousPoExtracted.filters) ? previousPoExtracted.filters : extracted.filters,
      orderBy: Array.isArray(previousPoExtracted.orderBy) ? previousPoExtracted.orderBy : extracted.orderBy,
      docNumber: previousPoExtracted.docNumber ?? extracted.docNumber,
      docItem: previousPoExtracted.docItem ?? extracted.docItem,
      limit: nextLimit,
      skip: nextSkip,
    },
    error: null,
  };
}

function buildStructuredEntitySetQuery({
  entitySet,
  idField,
  idValue,
  itemField,
  itemValue,
  itemNormalizer,
  fields,
  filters,
  orderBy,
  limit,
  skip,
  count,
}) {
  const query = {};
  const filterParts = [];

  if (idValue && idField) {
    const safeValue = String(idValue).replace(/'/g, "''");
    filterParts.push(`${idField} eq '${safeValue}'`);
  }

  if (itemField && itemValue != null) {
    const normalizedItem =
      typeof itemNormalizer === "function" ? itemNormalizer(itemValue) : itemValue;

    if (normalizedItem != null && String(normalizedItem).trim()) {
      const safeValue = String(normalizedItem).replace(/'/g, "''");
      filterParts.push(`${itemField} eq '${safeValue}'`);
    }
  }

  for (const f of Array.isArray(filters) ? filters : []) {
    if (!f || typeof f !== "object") continue;

    const field = String(f.field || "").trim();
    const op = String(f.op || "").trim().toLowerCase();
    const type = String(f.type || "string").trim().toLowerCase();
    const value = f.value;

    if (!field || !op || value == null) continue;
    if (!["eq", "ne", "gt", "ge", "lt", "le"].includes(op)) continue;

    if (type === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        filterParts.push(`${field} ${op} ${n}`);
      }
      continue;
    }

    if (type === "boolean") {
      if (value === true || value === "true") {
        filterParts.push(`${field} ${op} true`);
      } else if (value === false || value === "false") {
        filterParts.push(`${field} ${op} false`);
      }
      continue;
    }

    if (type === "datetime") {
      let dt = String(value || "").trim();
      if (!dt) continue;

      if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
        dt = `${dt}T00:00:00`;
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) {
        dt = `${dt}:00`;
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(dt)) {
        dt = dt.replace(/\.\d{3}$/, "");
      } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dt)) {
        continue;
      }

      dt = dt.replace(/'/g, "''");
      filterParts.push(`${field} ${op} datetime'${dt}'`);
      continue;
    }

    const safeValue = String(value).replace(/'/g, "''").trim();
    if (!safeValue) continue;
    filterParts.push(`${field} ${op} '${safeValue}'`);
  }

  if (filterParts.length > 0) {
    query.$filter = filterParts.join(" and ");
  }

  const selectFields = Array.from(
    new Set([idField, itemField, ...(Array.isArray(fields) ? fields : [])].filter(Boolean))
  );
  if (selectFields.length > 0) {
    query.$select = selectFields.join(",");
  }

  const orderParts = [];
  for (const o of Array.isArray(orderBy) ? orderBy : []) {
    if (!o || typeof o !== "object") continue;
    const field = String(o.field || "").trim();
    if (!field) continue;
    const dir = String(o.dir || "asc").toLowerCase() === "desc" ? "desc" : "asc";
    orderParts.push(`${field} ${dir}`);
  }
  if (orderParts.length > 0) {
    query.$orderby = orderParts.join(",");
  }

  const top = Number(limit);
  if (Number.isFinite(top) && top > 0) {
    query.$top = String(Math.min(top, 200));
  }

  const sk = Number(skip);
  if (Number.isFinite(sk) && sk >= 0) {
    query.$skip = String(sk);
  }

  if (count === true) {
    query.$inlinecount = "allpages";
  }

  return buildEntitySetQuery(entitySet, query, { maxTop: 200 });
}

function generateSuggestions(query, extracted, rows) {
  const q = String(query || "").toLowerCase();
  const firstRow = rows?.[0] || {};
  const docNumber = firstRow?.PoNo || extracted?.docNumber;
  const nextSize = Math.max(1, Number(extracted?.limit) || 10);

  if (q.includes("po") || q.includes("purchase") || extracted?.docNumber) {
    return [
      `show next ${nextSize} po`,
      docNumber ? `Show items of document ${docNumber}` : "Show document items",
      docNumber ? `Track document ${docNumber}` : "Track this document",
    ];
  }

  return [
    "Show latest purchase orders",
    "Show invoices",
    "Show reports",
  ];
}

function sanitizeStructuredFilters(filters, allowedFields) {
  const allowedSet = new Set((Array.isArray(allowedFields) ? allowedFields : []).map((f) => String(f)));
  const allowedOps = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
  const allowedTypes = new Set(["string", "number", "boolean", "datetime"]);

  const out = [];
  for (const f of Array.isArray(filters) ? filters : []) {
    if (!f || typeof f !== "object") continue;

    const field = String(f.field || "").trim();
    const op = String(f.op || "").trim().toLowerCase();
    const type = String(f.type || "string").trim().toLowerCase();
    const value = f.value;

    if (!field || !allowedSet.has(field)) continue;
    if (!allowedOps.has(op)) continue;
    if (!allowedTypes.has(type)) continue;
    if (value == null || (typeof value === "string" && !value.trim())) continue;

    out.push({ field, op, type, value });
  }

  return out;
}

// CrtDate is the confirmed SAP date field for Po_details.
// It bypasses the allowedFields/$select restriction because $orderby fields
// do not need to be in $select — they just need to exist in the entity type.
// Only CrtDate is bypassed; all others must be in allowedFields to prevent 400 errors.
const BYPASS_ORDERBY_FIELDS = new Set(["crtdate"]);

function sanitizeOrderBy(orderBy, allowedFields) {
  const allowedSet = new Set((Array.isArray(allowedFields) ? allowedFields : []).map((f) => String(f).toLowerCase()));
  const normalized = [];

  for (const o of Array.isArray(orderBy) ? orderBy : []) {
    if (!o || typeof o !== "object") continue;
    const field = String(o.field || "").trim();
    if (!field) continue;
    const fieldLower = field.toLowerCase();
    if (!allowedSet.has(fieldLower) && !BYPASS_ORDERBY_FIELDS.has(fieldLower)) continue;
    const dir = String(o.dir || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
    normalized.push({ field, dir });
  }

  return normalized;
}

function findAllowedField(allowedFields, candidates) {
  const fields = Array.isArray(allowedFields) ? allowedFields : [];
  const byLower = new Map(fields.map((f) => [String(f).toLowerCase(), String(f)]));

  for (const name of Array.isArray(candidates) ? candidates : []) {
    const hit = byLower.get(String(name || "").toLowerCase());
    if (hit) return hit;
  }

  return null;
}

function isLatestQuery(query, extracted) {
  const q = String(query || "").toLowerCase();
  if (String(extracted?.listMode || "").toLowerCase() === "latest_po") return true;
  return /\b(latest|recent|newest|most\s+recent)\b/.test(q);
}

function isExplicitLatestPoQuery(query) {
  const q = String(query || "").toLowerCase();
  return /\b(latest|recent|newest|most\s+recent)\b/.test(q);
}

export { isExplicitLatestPoQuery };

export function isSingleLatestPoRequest(query) {
  const q = String(query || "").toLowerCase();
  return (
    /\b(latest|newest|most\s+recent)\s+(purchase\s+order|po)\b(?!s)/.test(q) ||
    /\blatest\s+po\b/.test(q) ||
    /\bmost\s+recent\s+po\b/.test(q)
  );
}

function hasDateFilter(filters) {
  return (Array.isArray(filters) ? filters : []).some((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const field = String(filter.field || "").toLowerCase();
    const type = String(filter.type || "").toLowerCase();
    return type === "datetime" || /date/.test(field);
  });
}

function startOfCurrentYearIso() {
  const now = new Date();
  return `${now.getFullYear()}-01-01T00:00:00`;
}

const LATEST_DATE_CANDIDATES = [
  "CrtDate",
  "CreatedOn",
  "PoDocDate",
  "DocDate",
  "DocumentDate",
  "ERDAT",
  "AEDAT",
];

export function enforceLatestOrderBy({ query, extracted, allowedFields, fallbackField = "" }) {
  if (!isLatestQuery(query, extracted)) return;

  // Prefer a field that exists in allowedFields (returned by $select),
  // but fall back to the hardcoded list directly — $orderby field names
  // do NOT need to be in $select; they are hardcoded safe values.
  const fieldFromAllowed = findAllowedField(allowedFields, LATEST_DATE_CANDIDATES);
  const fieldDirect = LATEST_DATE_CANDIDATES[0]; // "CrtDate" — confirmed by user
  const fallbackFromId = findAllowedField(allowedFields, [fallbackField]);

  const chosenField = fieldFromAllowed || fieldDirect || fallbackFromId;
  if (!chosenField) return;

  const existing = Array.isArray(extracted?.orderBy) ? extracted.orderBy : [];
  const rest = existing.filter(
    (o) => String(o?.field || "").toLowerCase() !== String(chosenField).toLowerCase()
  );

  extracted.orderBy = [{ field: chosenField, dir: "desc" }, ...rest];
}

function normalizeOrderBy(orderBy) {
  return (Array.isArray(orderBy) ? orderBy : [])
    .map((o) => {
      const field = String(o?.field || "").trim();
      if (!field) return null;
      const dir = String(o?.dir || "asc").toLowerCase() === "desc" ? "desc" : "asc";
      return { field, dir };
    })
    .filter(Boolean);
}

function getLatestOrderCandidates({ allowedFields, fallbackField = "" }) {
  // Only retry with fields confirmed to exist in the entity (from allowedFields/metadata).
  // Always include CrtDate as the primary bypass — it's the confirmed Po_details field.
  // Filtering against allowedFields prevents 400 errors from non-existent fields like CreatedOn.
  const inAllowed = LATEST_DATE_CANDIDATES.filter((name) =>
    findAllowedField(allowedFields, [name])
  );

  // CrtDate is always the first candidate regardless of allowedFields presence.
  const primary = "CrtDate";
  const rest = inAllowed.filter((f) => f.toLowerCase() !== primary.toLowerCase());
  if (fallbackField && !rest.includes(fallbackField)) {
    const fb = findAllowedField(allowedFields, [fallbackField]);
    if (fb) rest.push(fb);
  }

  return [primary, ...new Set(rest)];
}

function buildLatestOrderVariants({ currentOrderBy, candidates, maxVariants = 4 }) {
  const base = normalizeOrderBy(currentOrderBy);
  const variants = [];
  const seen = new Set();

  const pushVariant = (order) => {
    const normalized = normalizeOrderBy(order);
    if (normalized.length === 0) return;
    const key = JSON.stringify(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(normalized);
  };

  pushVariant(base);

  for (const field of Array.isArray(candidates) ? candidates : []) {
    const rest = base.filter((o) => String(o.field).toLowerCase() !== String(field).toLowerCase());
    pushVariant([{ field, dir: "desc" }, ...rest]);
    if (variants.length >= maxVariants) break;
  }

  return variants;
}

function parseDateValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/^\d{8}$/.test(raw)) {
    const yyyy = Number(raw.slice(0, 4));
    const mm = Number(raw.slice(4, 6));
    const dd = Number(raw.slice(6, 8));
    const dt = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(dt.getTime()) ? null : dt.getTime();
  }

  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) return dt.getTime();

  return null;
}

export function sortRowsByLatestDate(rows, dateFields) {
  const data = Array.isArray(rows) ? [...rows] : [];
  const candidates = Array.isArray(dateFields) && dateFields.length > 0 ? dateFields : ["CrtDate"];

  return data.sort((left, right) => {
    for (const field of candidates) {
      const leftTs = parseDateValue(left?.[field]);
      const rightTs = parseDateValue(right?.[field]);
      const leftValid = Number.isFinite(leftTs);
      const rightValid = Number.isFinite(rightTs);

      if (leftValid && rightValid && leftTs !== rightTs) {
        return rightTs - leftTs;
      }

      if (leftValid && !rightValid) return -1;
      if (!leftValid && rightValid) return 1;
    }

    const leftPoNo = String(left?.PoNo || "");
    const rightPoNo = String(right?.PoNo || "");
    if (leftPoNo !== rightPoNo) {
      return rightPoNo.localeCompare(leftPoNo, undefined, { numeric: true, sensitivity: "base" });
    }

    return 0;
  });
}

function scoreRowsFreshness(rows, dateFields) {
  const data = Array.isArray(rows) ? rows : [];
  const candidates = Array.isArray(dateFields) ? dateFields : [];
  let best = Number.NEGATIVE_INFINITY;

  for (const row of data) {
    for (const field of candidates) {
      const ts = parseDateValue(row?.[field]);
      if (Number.isFinite(ts) && ts > best) best = ts;
    }
  }

  return best;
}

function hasCurrentYearData(rows, dateFields) {
  const data = Array.isArray(rows) ? rows : [];
  const candidates = Array.isArray(dateFields) ? dateFields : [];
  const currentYear = new Date().getFullYear();

  for (const row of data) {
    for (const field of candidates) {
      const ts = parseDateValue(row?.[field]);
      if (!Number.isFinite(ts)) continue;
      if (new Date(ts).getFullYear() >= currentYear) return true;
    }
  }

  return false;
}

function resolveSelfUserFilter(filters, sapUser) {
  const currentUser = String(sapUser || "").trim();
  let unresolvedSelfRef = false;

  const normalized = (Array.isArray(filters) ? filters : []).map((f) => {
    if (!f || typeof f !== "object") return f;
    if (String(f.field || "").trim() !== "UserCreated") return f;

    const raw = String(f.value || "").trim().toLowerCase();
    const isSelfRef = raw === "me" || raw === "my" || raw === "myself" || raw === "current";
    if (!isSelfRef) return f;

    if (!currentUser) {
      unresolvedSelfRef = true;
      return f;
    }

    return {
      ...f,
      value: currentUser,
    };
  });

  return { normalized, unresolvedSelfRef };
}

function isGenericPoListRequest(query, extracted) {
  const q = String(query || "").toLowerCase();
  if (String(extracted?.docNumber || "").trim() || String(extracted?.docItem || "").trim()) return false;
  if (String(extracted?.listMode || "").trim().toLowerCase() !== "latest_po") return false;
  return /^(show|list|get)\s+(all\s+)?(latest\s+|recent\s+|most\s+recent\s+)?(po|purchase\s*order[s]?)\b/.test(q);
}

function isExplicitPoFieldRequest(query) {
  const q = String(query || "").toLowerCase();
  return /\b(currency|volume|plant|price|net\s+price|amount|value|date|created|vendor|supplier|quantity|unit|material|storage|company\s+code)\b/.test(q);
}

export async function handleS4poChatStream({
  req,
  sse,
  owner,
  query,
  sessionId,
  systemId,
  sapUser,
}) {
  const requestedSystemId = normalizeSystemId(systemId);

  const serviceIntent = await step("resolveServiceIntent", () =>
    resolveServiceIntent({
      owner,
      query,
      systemIds: requestedSystemId ? [requestedSystemId] : [],
      limitServices: 12,
    })
  );

  const serviceIntentFallback = buildFallbackPoService({
    systemId: requestedSystemId || serviceIntent?.systemId || "",
    serviceName: serviceIntent?.serviceName,
    entitySet: serviceIntent?.entitySet,
    entityTypeName: serviceIntent?.entityTypeName,
    idField: serviceIntent?.keys?.[0] || "PoNo",
    itemField: serviceIntent?.keys?.[1] || "PoItem",
    keys: serviceIntent?.keys || [],
  });

  const effectiveServiceIntent = buildDocumentFlowServiceIntent({
    query,
    serviceIntent,
    systemId: requestedSystemId,
    serviceIntentFallback,
  });

  console.log("[SSE] resolved service intent:", effectiveServiceIntent);

  if (!effectiveServiceIntent?.matchFound || !effectiveServiceIntent?.serviceName || !effectiveServiceIntent?.entitySet) {
    sse.send("error", {
      message: "I could not match your query to any SAP service.",
      status: "service_not_found",
      serviceIntent,
    });
    return sse.end();
  }

  const routingSystemId = normalizeSystemId(effectiveServiceIntent.systemId || requestedSystemId);

  if (!routingSystemId) {
    sse.send("error", { message: "systemId is required" });
    return sse.end();
  }

  const sapAuth = await step("getSapAuthOrThrow", () =>
    getSapAuthOrThrow({
      owner,
      systemId: routingSystemId,
      sapUser,
    })
  );

  const effectiveSapUser = normalizeSapUser(sapAuth?.sapUser);
  const executionSystemId = normalizeSystemId(
    sapAuth?.matchedSystemId || requestedSystemId || routingSystemId
  );

  const session = await step("getOrCreateSession", () =>
    getOrCreateSession({
      owner,
      sessionId,
      systemId: executionSystemId,
      sapUser: effectiveSapUser,
    })
  );

  await step("save user message", () =>
    saveUserMessage({
      owner,
      sessionId: session._id,
      text: query,
    })
  );

  await step("set session title (first message only)", async () => {
    if (!session.title) {
      await ChatSession.updateOne(
        { _id: session._id },
        { $set: { title: String(query).slice(0, 80), updatedAt: new Date() } }
      );
    }
  });

  const system = await step("load SapSystem", async () => {
    return (
      (await SapSystem.findOne({
        owner: { $in: [owner, "local"] },
        systemId: executionSystemId,
      }).lean()) ||
      (await SapSystem.findOne({
        owner: { $in: [owner, "local"] },
        systemId: routingSystemId,
      }).lean())
    );
  });

  if (!system) {
    sse.send("error", {
      message: `SAP system profile not found for routingSystemId=${routingSystemId} or executionSystemId=${executionSystemId}`,
    });
    return sse.end();
  }

  const actualSystemId = normalizeSystemId(system.systemId);

  const service = await step("load SapServiceMap", async () => {
    const mappedService =
      (await SapServiceMap.findOne({
        owner: getDeploymentOwner("local"),
        systemId: actualSystemId,
        serviceName: serviceIntent.serviceName,
        entitySet: serviceIntent.entitySet,
      }).lean()) ||
      (await SapServiceMap.findOne({
        owner: getDeploymentOwner("local"),
        systemId: routingSystemId,
        serviceName: serviceIntent.serviceName,
        entitySet: serviceIntent.entitySet,
      }).lean());

    if (mappedService) {
      return mappedService;
    }

    return buildFallbackPoService(serviceIntent);
  });

  if (!service?.serviceName || !service?.entitySet) {
    sse.send("error", {
      message: `Service mapping not found for executionSystemId=${actualSystemId}, routingSystemId=${routingSystemId}, serviceName=${serviceIntent.serviceName}, entitySet=${serviceIntent.entitySet}.`,
      status: "service_mapping_not_found",
      serviceIntent,
    });
    return sse.end();
  }

  const allow = await step("getAllowedFieldsWithLabels", () =>
    getAllowedFieldsWithLabels({
      system,
      service,
      entityTypeName: service.entityTypeName,
      authOverride: sapAuth,
    })
  );

  const allowedFields = allow?.fields || [];
  const fieldLabels = allow?.labels || {};

  let extracted = await step("extractDocQuery", () =>
    extractDocQuery({
      query,
      allowedFields,
      fieldLabels,
      defaultDocType: serviceIntent?.entityTypeName || service.entityTypeName || "DOCUMENT",
    })
  );

  const previousMemory = session?._id
    ? await step("loadLastAssistantMemory", () =>
        loadLastAssistantMemory({
          owner,
          sessionId: session._id,
        })
      )
    : null;

  const continuationState = applyPoNextContinuationState({ query, extracted, previousMemory });

  if (continuationState.error) {
    if (continuationState.error.status === "missing_po_context") {
      sse.send("error", {
        message: continuationState.error.message,
        status: continuationState.error.status,
      });
      return sse.end();
    }
  }

  extracted = continuationState.extracted;

  if ((!extracted.fields || extracted.fields.length === 0) && Array.isArray(serviceIntent?.fields)) {
    extracted.fields = serviceIntent.fields.filter((f) => allowedFields.includes(f));
  }

  const genericPoListRequest = isGenericPoListRequest(query, extracted);
  const explicitPoFieldRequest = isExplicitPoFieldRequest(query);
  if (genericPoListRequest && !explicitPoFieldRequest) {
    extracted.fields = ["PoNo", "PoItem", "MatNo", "SuppAcoutNo", "Menge"].filter((field) =>
      allowedFields.includes(field)
    );
  }

  if ((!extracted.orderBy || extracted.orderBy.length === 0) && Array.isArray(serviceIntent?.orderBy)) {
    extracted.orderBy = serviceIntent.orderBy;
  }

  if (!extracted.docNumber && serviceIntent?.docNumber) {
    extracted.docNumber = serviceIntent.docNumber;
  }

  if (!extracted.docItem && serviceIntent?.docItem) {
    extracted.docItem = serviceIntent.docItem;
  }

  const explicitFromDate = String(req?.body?.fromDate || req?.query?.fromDate || "").trim();
  const explicitToDate = String(req?.body?.toDate || req?.query?.toDate || "").trim();
  const explicitDateText = String(req?.body?.dateText || req?.query?.dateText || "").trim();

  if (explicitFromDate) {
    extracted.fromDate = extracted.fromDate || explicitFromDate;
  }

  if (explicitToDate) {
    extracted.toDate = extracted.toDate || explicitToDate;
  }

  if (explicitDateText) {
    extracted.dateText = extracted.dateText || explicitDateText;
  }

  const pendingPoIntentDetected = detectPendingPoIntent(query);
  if (pendingPoIntentDetected) {
    const pendingIntentPayload = buildPendingPoIntentPayload(query, {
      pageSize: Number(req?.body?.limit) || 5,
    });

    const fallbackDateFrom = normalizeDateOnly(extracted?.fromDate);
    const fallbackDateTo = normalizeDateOnly(extracted?.toDate);
    const effectiveDateFrom = normalizeDateOnly(explicitFromDate) || fallbackDateFrom || pendingIntentPayload.date_from;
    const effectiveDateTo = normalizeDateOnly(explicitToDate) || fallbackDateTo || pendingIntentPayload.date_to;
    const requestedPoNo = String(
      extracted?.docNumber ||
      serviceIntent?.docNumber ||
      extractPendingPoNumber(query) ||
      ""
    ).trim();
    const hasExplicitDateFilter = Boolean(
      normalizeDateOnly(explicitFromDate) ||
      normalizeDateOnly(explicitToDate) ||
      fallbackDateFrom ||
      fallbackDateTo
    );
    const queryDateFrom = requestedPoNo && !hasExplicitDateFilter ? "" : effectiveDateFrom;
    const queryDateTo = requestedPoNo && !hasExplicitDateFilter ? "" : effectiveDateTo;

    const pendingPoServices = await step("load Pending PO Service Map", async () =>
      SapServiceMap.find({
        owner: { $in: [getDeploymentOwner("local"), "local"] },
        systemId: actualSystemId,
        serviceType: "PO",
        isActive: true,
      })
        .sort({ updatedAt: -1 })
        .lean()
    );

    const pendingPoService = await step("resolve Pending PO compatible service", async () =>
      resolveCompatiblePendingPoService({
        catalogs: pendingPoServices,
        system,
        sapAuth,
      })
    );
    assertPendingPoServiceCompatibility(pendingPoService);
    const listResult = await step("executePendingPurchaseOrderList", async () =>
      getPendingPurchaseOrderList({
        system,
        sapAuth,
        service: pendingPoService,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        poNo: requestedPoNo,
        pageSize: pendingIntentPayload.page_size,
        cursor: null,
      })
    );

    const summaryText = listResult.count > 0
      ? (requestedPoNo && !hasExplicitDateFilter
        ? `Showing ${listResult.count} pending purchase order(s) for PO ${requestedPoNo}.`
        : `Showing ${listResult.count} pending purchase order(s) from ${effectiveDateFrom} to ${effectiveDateTo}.`)
      : (requestedPoNo && !hasExplicitDateFilter
        ? `No pending purchase orders found for PO ${requestedPoNo}.`
        : "No pending purchase orders found for the selected period.");

    await step("save assistant message", () =>
      saveAssistantMessage({
        owner,
        sessionId: session._id,
        text: summaryText,
        summary: summaryText,
        extracted: {
          ...extracted,
          intent: "GET_PENDING_PO_LIST",
          dateFrom: queryDateFrom,
          dateTo: queryDateTo,
          docNumber: requestedPoNo || extracted?.docNumber || "",
          limit: listResult.pageSize,
          skip: 0,
        },
        sapRequest: null,
        data: {
          ...listResult,
          dateFrom: queryDateFrom,
          dateTo: queryDateTo,
          requestContext: {
            systemId: actualSystemId,
            sapUser: effectiveSapUser,
            dateFrom: queryDateFrom,
            dateTo: queryDateTo,
            poNo: requestedPoNo,
            pageSize: listResult.pageSize,
            nextPage: listResult.nextPage,
          },
        },
        suggestions: [],
        responseMeta: {
          ok: true,
          kind: "stream",
          returned: listResult.count,
          routingSystemId,
          executionSystemId: actualSystemId,
          sapUser: effectiveSapUser,
          serviceName: pendingPoService.serviceName,
          entitySet: pendingPoService.entitySet,
        },
      })
    );

    sse.send("reply", {
      ok: true,
      kind: "stream",
      sessionId: String(session._id),
      systemId: actualSystemId,
      sapUser: effectiveSapUser,
      reply: summaryText,
      summary: summaryText,
      data: {
        ...listResult,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        requestContext: {
          systemId: actualSystemId,
          sapUser: effectiveSapUser,
          dateFrom: queryDateFrom,
          dateTo: queryDateTo,
          poNo: requestedPoNo,
          pageSize: listResult.pageSize,
          nextPage: listResult.nextPage,
        },
      },
      suggestions: [],
    });

    sse.send("done", { ok: true, sessionId: String(session._id) });
    return sse.end();
  }

  const pendingInvoiceIntent = detectPendingInvoiceIntent(query);
  if (pendingInvoiceIntent) {
    const pendingContext = extractPendingInvoiceContext(query);
    const pendingPlan = getPendingInvoiceExecutionPlan();
    const pendingScope = resolvePendingInvoiceScope(query);
    console.log("[PENDING_INVOICE_INTENT]");
    console.log(`User query: ${query}`);
    console.log(`Detected intent: ${pendingInvoiceIntent}`);
    console.log(`Execution plan: ${JSON.stringify(pendingPlan, null, 2)}`);
    console.log("[PENDING_INVOICE_SCOPE]", pendingScope);

    const pendingFallbackIntent = buildFallbackPoService({
      systemId: requestedSystemId || effectiveServiceIntent?.systemId || "",
      serviceName: effectiveServiceIntent?.serviceName,
      entitySet: effectiveServiceIntent?.entitySet,
      entityTypeName: effectiveServiceIntent?.entityTypeName,
      idField: effectiveServiceIntent?.keys?.[0] || "PoNo",
      itemField: effectiveServiceIntent?.keys?.[1] || "PoItem",
      keys: effectiveServiceIntent?.keys || [],
    });

    const flowServices = await step("load Purchase Order Flow Service Maps", async () =>
      SapServiceMap.find({
        owner: { $in: [getDeploymentOwner("local"), "local"] },
        systemId: actualSystemId,
        serviceType: { $in: ["PO", "RSEG"] },
        isActive: true,
      })
        .sort({ updatedAt: -1 })
        .lean()
    );

    const poService =
      flowServices.find((service) => String(service?.serviceType || "").trim().toUpperCase() === "PO") ||
      pendingFallbackIntent;
    const rsegService =
      flowServices.find((service) => String(service?.serviceType || "").trim().toUpperCase() === "RSEG") ||
      {
        owner: getDeploymentOwner("local"),
        systemId: String(requestedSystemId || pendingFallbackIntent.systemId || "").trim().toUpperCase(),
        serviceType: "RSEG",
        serviceName: process.env.DEFAULT_RSEG_SERVICE_NAME || "ZIV_RSEG_DEATILS_CDS",
        entitySet: process.env.DEFAULT_RSEG_ENTITYSET || "ZIV_RSEG_DEATILS",
        entityTypeName: process.env.DEFAULT_RSEG_ENTITYTYPE || "ZIV_RSEG_DEATILS",
        idField: "purch_doc_no",
        itemField: "purch_item_no",
        idPad: 10,
        itemPad: 5,
      };

    const flowResult = await step("executePendingInvoiceStatus", () => executePendingInvoiceFlow({
      system,
      sapAuth,
      poService,
      rsegService,
      scope: {
        ...pendingScope,
        poNumber: pendingScope.poNumber || pendingContext.poNumber || effectiveServiceIntent?.docNumber || extracted.docNumber || null,
        poItem: pendingScope.poItem || pendingContext.poItem || effectiveServiceIntent?.docItem || extracted.docItem || null,
      },
      logger: console,
    }));

    if (!flowResult.ok) {
      const errorReply = `Pending Invoice Status: ${flowResult.status}`;
      sse.send("error", { ok: false, status: flowResult.status, message: errorReply, sessionId: String(session._id) });
      return sse.end();
    }

    if (flowResult.status === "PO_NOT_FOUND" || flowResult.status === "NO_PO_RECORDS_IN_DATE_RANGE") {
      const noDataReply = `Pending Invoice Status: ${flowResult.status}`;
      sse.send("reply", {
        ok: true,
        kind: "stream",
        sessionId: String(session._id),
        systemId: actualSystemId,
        sapUser: effectiveSapUser,
        reply: noDataReply,
        summary: noDataReply,
        data: { viewType: "pending_invoice_status", flow: flowResult, scope: flowResult.scope },
      });
      sse.send("done", { ok: true, sessionId: String(session._id) });
      return sse.end();
    }

    const firstPoRow = flowResult.poRows?.[0] || {};
    const resolvedPoNo = flowResult.scope.poNumber || firstPoRow?.PoNo || "";
    const resolvedPoItem = flowResult.scope.poItem || "";
    const flowStatusRows = buildPendingInvoiceStatusRows({ poRows: flowResult.poRows, rsegRows: flowResult.rsegRows, poNo: resolvedPoNo });
    flowResult.poRow = firstPoRow;
    flowResult.statusRows = flowStatusRows;
    flowResult.resolvedPoNo = resolvedPoNo;
    flowResult.resolvedPoItem = resolvedPoItem;

    const reply = buildPendingInvoiceStatusReply({
      poRow: flowResult.poRow,
      poRows: flowResult.statusRows?.length > 0
        ? flowResult.statusRows.map((row) => ({ PoNo: row.poNo, PoItem: row.poItem, PoQuantity: row.poQuantity }))
        : flowResult.poRows,
      rsegRows: flowResult.rsegRows,
      poNo: flowResult.resolvedPoNo,
      poItem: flowResult.resolvedPoItem,
    });
    const sections = buildPendingInvoiceStatusSections({
      poRow: flowResult.poRow,
      poRows: flowResult.statusRows?.length > 0
        ? flowResult.statusRows.map((row) => ({ PoNo: row.poNo, PoItem: row.poItem, PoQuantity: row.poQuantity }))
        : [],
      rsegRows: flowResult.rsegRows,
      poNo: flowResult.resolvedPoNo,
      poItem: flowResult.resolvedPoItem,
    });

    console.log("[PENDING_INVOICE_DEBUG] reply preview before persistence", {
      reply,
      replyLength: String(reply || "").length,
      sections: String(reply || "").split(/\n\n+/).filter(Boolean),
    });

    await step("save assistant message", () =>
      saveAssistantMessage({
        owner,
        sessionId: session._id,
        text: reply,
        summary: reply,
        extracted: { ...extracted, limit: Number(extracted.limit) || 10, skip: Number(extracted.skip) || 0, pendingInvoiceStatus: true },
        sapRequest: null,
        data: {
          viewType: "pending_invoice_status",
          flow: flowResult,
          poNo: flowResult.resolvedPoNo,
          poItem: flowResult.resolvedPoItem,
          pendingInvoiceStatus: reply,
          sections,
          rows: flowResult.statusRows,
          hasMore: Boolean(flowResult.hasMore),
          nextPage: flowResult.nextPage || null,
          totalCount: Number(flowResult.totalCount) || flowResult.statusRows?.length || 0,
        },
        suggestions: [
          `Show invoice details for PO ${flowResult.resolvedPoNo}`,
          `Show complete document flow for PO ${flowResult.resolvedPoNo}`,
        ],
        responseMeta: {
          ok: true,
          kind: "stream",
          returned: Array.isArray(flowResult.rsegRows) ? flowResult.rsegRows.length : 0,
          routingSystemId,
          executionSystemId: actualSystemId,
          sapUser: effectiveSapUser,
          serviceName: "PENDING_INVOICE_STATUS",
          entitySet: "PENDING_INVOICE_STATUS",
        },
      })
    );

    sse.send("reply", {
      ok: true,
      kind: "stream",
      sessionId: String(session._id),
      systemId: actualSystemId,
      sapUser: effectiveSapUser,
      reply,
      summary: reply,
      data: {
        viewType: "pending_invoice_status",
        flow: flowResult,
        poNo: flowResult.resolvedPoNo,
        poItem: flowResult.resolvedPoItem,
        sections,
        rows: flowResult.statusRows,
        hasMore: Boolean(flowResult.hasMore),
        nextPage: flowResult.nextPage || null,
        totalCount: Number(flowResult.totalCount) || flowResult.statusRows?.length || 0,
      },
    });

    console.log("[PENDING_INVOICE_DEBUG] reply sent to frontend", {
      sessionId: String(session._id),
      replyLength: String(reply || "").length,
    });

    sse.send("done", { ok: true, sessionId: String(session._id) });
    return sse.end();
  }

  if ((!extracted.limit || Number(extracted.limit) <= 0) && serviceIntent?.limit) {
    extracted.limit = serviceIntent.limit;
  }

  if ((!extracted.filters || extracted.filters.length === 0) && Array.isArray(serviceIntent?.filters)) {
    extracted.filters = serviceIntent.filters;
  }

  if (continuationState.nextIntent && continuationState.requestedNextCount != null) {
    extracted.limit = continuationState.requestedNextCount;
  }

  const documentFlowIntent = detectDocumentFlowIntent(query);
  const isPoDetailRequest = String(serviceIntent?.intent || "").trim() === "get_purchase_order_details" || String(serviceIntent?.operation || "").trim().toLowerCase() === "detail";
  const isPricingDetailRequest = documentFlowIntent === "PRICING_DETAILS";
  const isAccountingDetailRequest = documentFlowIntent === "ACCOUNTING_DOCUMENT";
  const isMaterialDetailRequest = documentFlowIntent === "MATERIAL_DOCUMENT";
  const isInvoiceDetailRequest = documentFlowIntent === "INVOICE_DETAILS";
  const flowRequested = isPricingDetailRequest || isAccountingDetailRequest || isMaterialDetailRequest || isInvoiceDetailRequest || (!isPoDetailRequest && isPurchaseOrderFlowRequest(query, extracted));
  if (flowRequested) {
    const normalizedDocumentFlowIntent = documentFlowIntent || "COMPLETE_DOCUMENT_FLOW";
    const flowServices = await step("load Purchase Order Flow Service Maps", async () =>
      SapServiceMap.find({
        owner: { $in: [getDeploymentOwner("local"), "local"] },
        systemId: actualSystemId,
        serviceType: { $in: ["PO", "MAT", "RSEG", "RBKP", "ACDOCA"] },
        isActive: true,
      })
        .sort({ updatedAt: -1 })
        .lean()
    );

    const flowResult = await step("executePurchaseOrderFlow", () =>
      executePurchaseOrderFlow({
        req: {
          system,
          sapAuth,
          body: {
            purchaseOrderId: extracted.docNumber || effectiveServiceIntent?.docNumber || "",
            purchaseOrderItem: extracted.docItem || effectiveServiceIntent?.docItem || "",
          },
        },
        catalogs: flowServices,
        plan: {
          primary: { serviceType: "PO" },
          poNumber: extracted.docNumber || effectiveServiceIntent?.docNumber || "",
          poItem: extracted.docItem || effectiveServiceIntent?.docItem || "",
          documentFlowIntent: normalizedDocumentFlowIntent,
        },
        query,
        logger: console,
      })
    );

    const flowRowsByStep = flowResult?.consolidated?.rows || flowResult?.rows || {};
    const allRows = Object.values(flowRowsByStep).flat();
    const primaryRows = Array.isArray(flowRowsByStep.PO) ? flowRowsByStep.PO : [];
    const materialRows = Array.isArray(flowRowsByStep.MAT) ? flowRowsByStep.MAT : [];
    const invoiceRows = Array.isArray(flowRowsByStep.RSEG) ? flowRowsByStep.RSEG : [];
    const rbkpRows = Array.isArray(flowRowsByStep.RBKP) ? flowRowsByStep.RBKP : [];
    const acdocaRows = Array.isArray(flowRowsByStep.ACDOCA) ? flowRowsByStep.ACDOCA : [];

    const poNo = primaryRows[0]?.PoNo || extracted.docNumber || effectiveServiceIntent?.docNumber || "NULL";
    const poItem = primaryRows[0]?.PoItem || extracted.docItem || effectiveServiceIntent?.docItem || "NULL";
    const materialDocument = materialRows[0]?.MaterialDocument || materialRows[0]?.MBLNR || "-";
    const invoiceNumber = invoiceRows[0]?.InvoiceNumber || invoiceRows[0]?.BELNR || "-";
    const fiscalYear = invoiceRows[0]?.FiscalYear || invoiceRows[0]?.GJAHR || "-";

    const procurementPoRows = Array.isArray(flowResult?.consolidated?.purchaseOrder?.rows) && flowResult.consolidated.purchaseOrder.rows.length > 0
      ? flowResult.consolidated.purchaseOrder.rows
      : primaryRows;

    const sections = buildProcurementFlowSections({
      poRows: procurementPoRows,
      materialRows,
      invoiceRows,
      rbkpRows,
      acdocaRows,
      poNo,
      poItem,
      documentFlowIntent: normalizedDocumentFlowIntent,
    });
    const reply = buildProcurementFlowReply({
      poRows: procurementPoRows,
      materialRows,
      invoiceRows,
      rbkpRows,
      acdocaRows,
      poNo,
      poItem,
      documentFlowIntent: normalizedDocumentFlowIntent,
    });

    const chart = flowResult?.result?.chartData || flowResult?.result?.chart || null;
    const procurementRequestContext = {
      query: String(query || "").trim(),
      systemId: actualSystemId,
      sapUser: effectiveSapUser,
      sessionId: String(session?._id || "").trim() || null,
      cursor: req.body?.cursor ?? null,
      businessScope: String(req.body?.businessScope || "").trim(),
      pendingAction: req.body?.pendingAction || null,
      availableSystems: Array.isArray(req.body?.availableSystems) ? req.body.availableSystems : null,
      documentFlowIntent: normalizedDocumentFlowIntent,
    };

    await step("save assistant message", () =>
      saveAssistantMessage({
        owner,
        sessionId: session._id,
        text: reply,
        summary: flowResult?.message || reply,
        extracted: { ...extracted, limit: Number(extracted.limit) || 10, skip: Number(extracted.skip) || 0, flowRequested: true },
        sapRequest: null,
        data: {
          viewType: "procurement_flow",
          flow: flowResult,
          rows: allRows,
          tableRows: allRows,
          sections,
          chartData: chart,
          chart,
          poNo,
          poItem,
          materialDocument,
          invoiceNumber,
          fiscalYear,
          procurementRequestContext,
        },
        suggestions: [
          `Show accounting details for PO ${poNo}`,
          `Show invoice for PO ${poNo}`,
          `Show goods receipt for PO ${poNo}`,
        ],
        responseMeta: {
          ok: true,
          kind: "stream",
          returned: allRows.length,
          routingSystemId,
          executionSystemId: actualSystemId,
          sapUser: effectiveSapUser,
          serviceName: "MULTI_HOP_PROCUREMENT_FLOW",
          entitySet: "MULTI_HOP_PROCUREMENT_FLOW",
        },
      })
    );

    sse.send("reply", {
      ok: true,
      kind: "stream",
      sessionId: String(session._id),
      systemId: actualSystemId,
      sapUser: effectiveSapUser,
      reply,
      summary: flowResult?.message || reply,
      data: {
        viewType: "procurement_flow",
        flow: flowResult,
        rows: allRows,
        tableRecords: allRows,
        allRecords: allRows,
        sections,
        chart,
        statusDistribution: chart,
        poNo,
        poItem,
        materialDocument,
        invoiceNumber,
        fiscalYear,
        procurementRequestContext,
      },
      suggestions: [
        `Show accounting details for PO ${poNo}`,
        `Show invoice for PO ${poNo}`,
        `Show goods receipt for PO ${poNo}`,
      ],
    });

    sse.send("done", { ok: true, sessionId: String(session._id) });

    return sse.end();
  }

  const { normalized: selfResolvedFilters, unresolvedSelfRef } = resolveSelfUserFilter(
    extracted.filters,
    effectiveSapUser
  );
  extracted.filters = selfResolvedFilters;

  if (unresolvedSelfRef) {
    sse.send("error", {
      message:
        "I could not determine your SAP username for the 'created by me' filter. Please provide an explicit username.",
      status: "missing_user_context",
    });
    return sse.end();
  }

  const hasSignals = hasPoQuerySignals(query);
  const hasStructuredRequest = hasStructuredPoRequest(extracted);
  if (!hasSignals && !hasStructuredRequest) {
    sse.send("error", {
      message:
        "I could not understand this purchase order request. Please ask with a PO number or filters like month/year/date and created by username.",
      status: "invalid_po_query",
    });
    return sse.end();
  }

  extracted.filters = sanitizeStructuredFilters(extracted.filters, allowedFields);
  extracted.orderBy = sanitizeOrderBy(extracted.orderBy, allowedFields);
  enforceLatestOrderBy({
    query,
    extracted,
    allowedFields,
    fallbackField: service.idField,
  });

  sse.send("phase", { phase: "fetching", message: "Fetching data from SAP..." });

  const docNumber = extracted.docNumber
    ? normalizeNumericId(extracted.docNumber, Number(service.idPad) || null)
    : null;

  const docItem = extracted.docItem
    ? normalizeNumericId(extracted.docItem, Number(service.itemPad) || null)
    : null;

  if (isExplicitLatestPoQuery(query) && !docNumber && !docItem && !hasDateFilter(extracted.filters)) {
    extracted.filters = Array.isArray(extracted.filters) ? extracted.filters : [];
    extracted.filters.push({
      field: "CrtDate",
      op: "ge",
      type: "datetime",
      value: startOfCurrentYearIso(),
    });
  }

  const limit = Math.min(200, Math.max(1, Number(extracted.limit) || 10));
  const skip = Number.isFinite(Number(extracted.skip)) ? Math.max(0, Number(extracted.skip)) : 0;

  const relativePath = buildStructuredEntitySetQuery({
    entitySet: service.entitySet,
    idField: service.idField,
    idValue: docNumber,
    itemField: service.itemField || null,
    itemValue: docItem,
    itemNormalizer: (v) => normalizeNumericId(v, Number(service.itemPad) || null),
    fields: extracted.fields,
    filters: extracted.filters,
    orderBy: extracted.orderBy,
    limit,
    skip,
    count: extracted.count === true,
  });

  console.log("[S4PO DEBUG] resolvedServiceIntent.fields:", JSON.stringify(effectiveServiceIntent?.fields ?? [], null, 2));
  console.log("[S4PO DEBUG] extracted:", JSON.stringify(extracted, null, 2));
  console.log("[S4PO DEBUG] requested fields:", JSON.stringify(
    extracted?.fields ?? extracted?.requestedFields ?? extracted?.requested_fields,
    null,
    2
  ));
  console.log("[S4PO DEBUG] final select fields:", extracted.fields);
  console.log("[S4PO DEBUG] final relativePath:", relativePath);
  console.log("[S4PO] extracted.orderBy before SAP fetch:", JSON.stringify(extracted.orderBy));
  console.log("[SSE] SAP relativePath:", relativePath);

  let sapData = await step("fetchFromSap", () =>
    fetchFromSap({ system, service, relativePath }, sapAuth)
  );
  let selectedRelativePath = relativePath;
  const totalCount = Number(sapData?.d?.__count || sapData?.__count || 0) || null;

  if (isLatestQuery(query, extracted) && !docNumber && !docItem) {
    const latestOrderCandidates = getLatestOrderCandidates({
      allowedFields,
      fallbackField: service.idField,
    });

    const orderVariants = buildLatestOrderVariants({
      currentOrderBy: extracted.orderBy,
      candidates: latestOrderCandidates,
      maxVariants: 4,
    });

    let bestData = sapData;
    let bestPath = selectedRelativePath;
    let bestRows = toResultsArray(sapData);
    let bestScore = scoreRowsFreshness(bestRows, latestOrderCandidates);

    for (let i = 1; i < orderVariants.length; i++) {
      const variantOrderBy = orderVariants[i];
      const variantPath = buildStructuredEntitySetQuery({
        entitySet: service.entitySet,
        idField: service.idField,
        idValue: docNumber,
        itemField: service.itemField || null,
        itemValue: docItem,
        itemNormalizer: (v) => normalizeNumericId(v, Number(service.itemPad) || null),
        fields: extracted.fields,
        filters: extracted.filters,
        orderBy: variantOrderBy,
        limit,
        skip,
        count: extracted.count === true,
      });

      const variantData = await fetchFromSap({ system, service, relativePath: variantPath }, sapAuth);
      const variantRows = toResultsArray(variantData);
      const variantScore = scoreRowsFreshness(variantRows, latestOrderCandidates);

      if (variantScore > bestScore) {
        bestScore = variantScore;
        bestData = variantData;
        bestRows = variantRows;
        bestPath = variantPath;
      }

      if (hasCurrentYearData(bestRows, latestOrderCandidates)) {
        break;
      }
    }

    sapData = bestData;
    selectedRelativePath = bestPath;
  }

  sse.send("phase", { phase: "formatting", message: "Preparing results..." });

  const safeRows = toResultsArray(sapData);
  console.log("[S4PO DEBUG] first normalized PO:", JSON.stringify(safeRows?.[0], null, 2));
  const sortedRows = isLatestQuery(query, extracted)
    ? sortRowsByLatestDate(safeRows, ["CrtDate"])
    : safeRows;
  const responseRows = (() => {
    let rows = sortedRows;

    if (docNumber) {
      const normalizedDocNumber = normalizeNumericId(docNumber, null);
      rows = rows.filter((row) => {
        const rowPoNo = normalizeNumericId(row?.PoNo || row?.PONo || row?.PO_NO || row?.poNo || row?.po_number || row?.poNumber || "", null);
        return rowPoNo && normalizedDocNumber ? rowPoNo === normalizedDocNumber : String(row?.PoNo || "").trim() === String(docNumber).trim();
      });
    }

    if (docItem) {
      const normalizedDocItem = normalizeNumericId(docItem, null);
      rows = rows.filter((row) => {
        const rowPoItem = normalizeNumericId(row?.PoItem || row?.POItem || row?.poItem || row?.item || "", null);
        return rowPoItem && normalizedDocItem ? rowPoItem === normalizedDocItem : String(row?.PoItem || "").trim() === String(docItem).trim();
      });
    }

    if (isSingleLatestPoRequest(query) && !docNumber && !docItem) {
      return rows.slice(0, 1);
    }

    return rows;
  })();

  const title =
    Array.isArray(extracted?.filters) && extracted.filters.length > 0
      ? "Filtered Results"
      : serviceIntent?.operation
      ? String(serviceIntent.operation).toUpperCase()
      : extracted?.listMode
      ? String(extracted.listMode).replace(/_/g, " ").toUpperCase()
      : "Results";

  const reply = buildGenericTableReply({
    title,
    rows: responseRows,
    fields: extracted.fields,
    startIndex: skip + 1,
  });

  const summary = await step("generateSummaryLLM", () =>
    generateSummaryLLM({
      entityLabel: service.entityTypeName || "SAP Documents",
      count: responseRows.length,
      totalCount,
      extracted,
      sample: responseRows.slice(0, 10),
      columns: extracted.fields || [],
    })
  );

  await step("save assistant message", () =>
    saveAssistantMessage({
      owner,
      sessionId: session._id,
      text: reply,
      summary,
      extracted: { ...extracted, limit, skip },
      sapRequest: selectedRelativePath,
      data: responseRows,
      suggestions: generateSuggestions(query, extracted, safeRows),
      responseMeta: {
        ok: true,
        kind: "stream",
        returned: responseRows.length,
        routingSystemId,
        executionSystemId: actualSystemId,
        sapUser: effectiveSapUser,
        serviceName: service.serviceName,
        entitySet: service.entitySet,
      },
    })
  );

  await step("update ChatSession updatedAt", () =>
    ChatSession.updateOne({ _id: session._id }, { $set: { updatedAt: new Date() } })
  );

  sse.send("reply", {
    ok: true,
    sessionId: String(session._id),
    systemId: actualSystemId,
    routingSystemId,
    sapUser: effectiveSapUser,
    serviceName: service.serviceName,
    entitySet: service.entitySet,
    extracted: { ...extracted, limit, skip },
    sapRequest: selectedRelativePath,
    data: responseRows,
    reply,
    summary,
    returned: responseRows.length,
    suggestions: generateSuggestions(query, extracted, responseRows),
  });

  sse.send("done", { ok: true });
  return sse.end();
}