import { fetchFromSap } from "../sap.service.js";
import { buildEntitySetQuery, normalizeNumericId } from "../odataQueryBuilder.js";
import { SapServiceCatalog } from "../../models/SapServiceCatalog.model.js";

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeServiceType(value) {
  return cleanString(value).toUpperCase();
}

function normalizeFieldText(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function toResultsArray(sapData) {
  const results = sapData?.d?.results;
  return Array.isArray(results) ? results : [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function normalizeId(value, pad = null) {
  const text = cleanString(value);
  if (!text) return "";
  if (!Number.isFinite(Number(pad)) || Number(pad) <= 0) return text;
  return normalizeNumericId(text, Number(pad));
}

function readRowPoNumber(row = {}) {
  return firstNonEmpty(
    row?.purchse_ordr_no,
    row?.PoNo,
    row?.po_no,
    row?.PO_NO,
    row?.EBELN,
    row?.purch_doc_no,
    row?.PurchaseOrder,
    row?.purchase_order,
    row?.ref_doc_no,
    row?.RefDocNo
  );
}

function readRowPoItem(row = {}) {
  return firstNonEmpty(
    row?.purchse_ordr_itm_no,
    row?.PoItem,
    row?.po_item,
    row?.PO_ITEM,
    row?.EBELP,
    row?.purch_item_no,
    row?.PurchaseOrderItem,
    row?.purchase_order_item,
    row?.PoItemNo,
    row?.po_item_no
  );
}

function filterRowsByPoContext(rows = [], { poNo = "", poItem = "", poPad = 10, itemPad = 5 } = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const targetPoNo = normalizeId(poNo, poPad);
  const targetPoItem = normalizeId(poItem, itemPad);

  if (!targetPoNo && !targetPoItem) return sourceRows;

  const filtered = sourceRows.filter((row) => {
    const rowPoNo = normalizeId(readRowPoNumber(row), poPad);
    const rowPoItem = normalizeId(readRowPoItem(row), itemPad);

    if (targetPoNo && rowPoNo && rowPoNo !== targetPoNo) return false;
    if (targetPoItem && rowPoItem && rowPoItem !== targetPoItem) return false;

    if (targetPoNo && !rowPoNo) return false;
    if (targetPoItem && !rowPoItem) return false;

    return true;
  });

  return filtered;
}

function buildQuery(entitySet, query, maxTop = 200) {
  return buildEntitySetQuery(entitySet, query, { maxTop });
}

function pickService(catalogs, serviceType) {
  const target = normalizeServiceType(serviceType);
  return (Array.isArray(catalogs) ? catalogs : []).find((catalog) => normalizeServiceType(catalog?.serviceType) === target) || null;
}

function pickCatalog(catalogs, matcher) {
  return (Array.isArray(catalogs) ? catalogs : []).find((catalog) => {
    const serviceName = cleanString(catalog?.serviceName).toUpperCase();
    const entitySet = cleanString(catalog?.entitySet).toUpperCase();
    const entityTypeName = cleanString(catalog?.entityTypeName).toUpperCase();
    return matcher({ serviceName, entitySet, entityTypeName, catalog });
  }) || null;
}

function pickField(catalog, hints = []) {
  const fields = Array.isArray(catalog?.fields) ? catalog.fields : [];
  const normalizedHints = (Array.isArray(hints) ? hints : []).map((hint) => normalizeFieldText(hint)).filter(Boolean);

  for (const hint of normalizedHints) {
    const exact = fields.find((field) => normalizeFieldText(field?.name) === hint);
    if (exact?.name) return exact.name;
  }

  for (const hint of normalizedHints) {
    const fuzzy = fields.find((field) => {
      const text = normalizeFieldText([field?.name, field?.label, field?.semantics].filter(Boolean).join(" "));
      return text.includes(hint) || hint.includes(text);
    });
    if (fuzzy?.name) return fuzzy.name;
  }

  if (Array.isArray(catalog?.keys) && catalog.keys.length > 0) {
    return cleanString(catalog.keys[0]);
  }

  return cleanString(catalog?.idField || catalog?.itemField || "");
}

function pickPreferredField(catalog, hints = [], fallback = "") {
  const picked = pickField(catalog, hints);
  if (picked) return picked;

  const safeFallback = cleanString(fallback);
  if (!safeFallback) return "";

  const fields = Array.isArray(catalog?.fields) ? catalog.fields : [];
  const normalizedFallback = normalizeFieldText(safeFallback);
  const direct = fields.find((field) => normalizeFieldText(field?.name) === normalizedFallback);
  return direct?.name || "";
}

function getCatalogFieldNames(catalog) {
  return Array.isArray(catalog?.fields)
    ? catalog.fields.map((field) => cleanString(field?.name)).filter(Boolean)
    : [];
}

function hasCatalogField(catalog, fieldName) {
  const normalized = normalizeFieldText(fieldName);
  return getCatalogFieldNames(catalog).some((name) => normalizeFieldText(name) === normalized);
}

function toStepService(stepType, catalog) {
  if (!catalog) return null;
  const prefersMetadata = stepType === "MAT";
  return {
    ...catalog,
    serviceType: stepType,
    idField: prefersMetadata
      ? pickPreferredField(catalog, ["MaterialDocument", "MBLNR", "PurchaseOrder", "EBELN", "PoNo"], "")
      : catalog.idField || (stepType === "PO" ? "PoNo" : stepType === "RSEG" ? "MaterialDocument" : stepType === "RBKP" ? "InvoiceNumber" : "InvoiceNumber"),
    itemField: prefersMetadata
      ? pickPreferredField(catalog, ["FiscalYear", "GJAHR", "PoItem", "EBELP"], "")
      : catalog.itemField || (stepType === "PO" ? "PoItem" : "FiscalYear"),
    idPad: Number.isFinite(Number(catalog.idPad)) ? Number(catalog.idPad) : 10,
    itemPad: Number.isFinite(Number(catalog.itemPad)) ? Number(catalog.itemPad) : 5,
  };
}

async function resolveProcurementFlowServices({ catalogs = [], systemId = "" }) {
  const localCatalogs = Array.isArray(catalogs) ? catalogs : [];
  const normalizedSystemId = cleanString(systemId).toUpperCase();

  const candidates = {
    PO: pickService(localCatalogs, "PO"),
    MAT: pickService(localCatalogs, "MAT"),
    RSEG: pickService(localCatalogs, "RSEG"),
    RBKP: pickService(localCatalogs, "RBKP"),
    ACDOCA: pickService(localCatalogs, "ACDOCA"),
  };

  if (candidates.PO && candidates.MAT && candidates.RSEG && candidates.RBKP && candidates.ACDOCA) {
    return candidates;
  }

  const metaCatalogs = normalizedSystemId
    ? await SapServiceCatalog.find({
        systemId: normalizedSystemId,
        isActive: true,
      }).sort({ updatedAt: -1 }).lean()
    : [];

  const mergedCatalogs = [...localCatalogs, ...metaCatalogs.map((catalog) => ({
    ...catalog,
    serviceType: normalizeServiceType(catalog?.serviceType || catalog?.domainHints?.find?.(() => false) || ""),
  }))];

  const resolveByType = (stepType, matchers, fallbackFields = {}) => {
    const existing = pickService(localCatalogs, stepType);
    if (existing) return existing;

    const found = pickCatalog(metaCatalogs, (meta) => matchers.some((matcher) => matcher(meta)));
    if (found) return toStepService(stepType, found);

    const serviceNameMap = {
      PO: ["ZIV_PO_DETAILS_CDS", "ZMM_PO_DETAILS_SRV"],
      MAT: ["ZIV_MAT_LEDGERS_CDS"],
      RSEG: ["ZIV_RSEG_DEATILS_CDS"],
      RBKP: ["ZIV_RBKP_DETAILS_CDS"],
      ACDOCA: ["ZIV_ACDOCA_DETAILS_CDS"],
    };

    const byName = pickCatalog(mergedCatalogs, ({ serviceName }) => serviceNameMap[stepType].includes(serviceName));
    if (byName) return toStepService(stepType, byName);

    if (fallbackFields.serviceName) {
      return {
        owner: localCatalogs[0]?.owner || "local",
        systemId: normalizedSystemId,
        serviceType: stepType,
        serviceName: fallbackFields.serviceName,
        entitySet: fallbackFields.entitySet,
        entityTypeName: fallbackFields.entityTypeName,
        idField: fallbackFields.idField,
        itemField: fallbackFields.itemField,
        idPad: fallbackFields.idPad ?? 10,
        itemPad: fallbackFields.itemPad ?? 5,
      };
    }

    return null;
  };

  return {
    PO: resolveByType("PO", [
      ({ serviceName, entitySet }) => serviceName.includes("PO_DETAILS") || entitySet.includes("PO_DETAILS"),
    ], { serviceName: "ZIV_PO_DETAILS_CDS", entitySet: "ZIV_PO_DETAILS", entityTypeName: "ZIV_PO_DETAILS", idField: "PoNo", itemField: "PoItem" }),
    MAT: resolveByType("MAT", [
      ({ serviceName, entitySet }) => serviceName.includes("MAT_LEDGERS") || entitySet.includes("MAT_LEDGERS"),
    ], { serviceName: "ZIV_MAT_LEDGERS_CDS", entitySet: "ZIV_MAT_LEDGERS", entityTypeName: "ZIV_MAT_LEDGERS", idField: "", itemField: "" }),
    RSEG: resolveByType("RSEG", [
      ({ serviceName, entitySet }) => serviceName.includes("RSEG") || entitySet.includes("RSEG"),
    ], { serviceName: "ZIV_RSEG_DEATILS_CDS", entitySet: "ZIV_RSEG_DEATILS", entityTypeName: "ZIV_RSEG_DEATILS", idField: "purch_doc_no", itemField: "purch_item_no" }),
    RBKP: resolveByType("RBKP", [
      ({ serviceName, entitySet }) => serviceName.includes("RBKP") || entitySet.includes("RBKP"),
    ], { serviceName: "ZIV_RBKP_DETAILS_CDS", entitySet: "ZIV_RBKP_DETAILS", entityTypeName: "ZIV_RBKP_DETAILS", idField: "invoice_doc_no", itemField: "fiscal_year" }),
    ACDOCA: resolveByType("ACDOCA", [
      ({ serviceName, entitySet }) => serviceName.includes("ACDOCA") || entitySet.includes("ACDOCA"),
    ], { serviceName: "ZIV_ACDOCA_DETAILS_CDS", entitySet: "ZIV_ACDOCA_DETAILS", entityTypeName: "ZIV_ACDOCA_DETAILS", idField: "ref_doc_no", itemField: "fiscal_year" }),
  };
}

function buildFilter(field, value) {
  const safeValue = String(value || "").replace(/'/g, "''");
  return `${field} eq '${safeValue}'`;
}

function attachRows(out, stepKey, rows, raw, request) {
  out.steps[stepKey] = {
    rows,
    raw,
    request,
    count: rows.length,
  };
  out.rowsByStep[stepKey] = rows;
}

function buildSummaryPayload(out) {
  const poRows = out.steps.PO?.rows || [];
  const matRows = out.steps.MAT?.rows || [];
  const rsegRows = out.steps.RSEG?.rows || [];
  const rbkpRows = out.steps.RBKP?.rows || [];
  const acdocaRows = out.steps.ACDOCA?.rows || [];

  return {
    poCount: poRows.length,
    materialDocumentCount: matRows.length,
    invoiceCount: rsegRows.length,
    invoiceHeaderCount: rbkpRows.length,
    accountingCount: acdocaRows.length,
  };
}

function normalizeDocumentFlowIntent(value) {
  const text = cleanString(value).toUpperCase();
  if (text === "MATERIAL_DOCUMENT" || text === "INVOICE_DETAILS" || text === "ACCOUNTING_DOCUMENT" || text === "COMPLETE_DOCUMENT_FLOW") {
    return text;
  }
  return "COMPLETE_DOCUMENT_FLOW";
}

function getDocumentFlowStepPlan(intent) {
  const normalized = normalizeDocumentFlowIntent(intent);

  if (normalized === "MATERIAL_DOCUMENT") {
    return ["PO", "MAT"];
  }

  if (normalized === "INVOICE_DETAILS") {
    return ["PO", "RSEG", "RBKP"];
  }

  if (normalized === "ACCOUNTING_DOCUMENT") {
    return ["PO", "RSEG", "RBKP", "ACDOCA"];
  }

  return ["PO", "MAT", "RSEG", "RBKP", "ACDOCA"];
}

export async function executePurchaseOrderFlow({ req, catalogs = [], plan = {}, query = "", logger = console } = {}) {
  const steps = {};
  const rowsByStep = {};
  const logs = [];
  const writeLog = (message) => {
    logs.push(message);
    logger?.log?.(message);
  };

  const services = await resolveProcurementFlowServices({ catalogs, systemId: req?.system?.systemId || req?.systemId || "" });
  const stepPlan = getDocumentFlowStepPlan(plan?.documentFlowIntent);
  const primary = services.PO;
  if (!primary) {
    return { ok: false, message: "Purchase Order not found.", steps, rowsByStep, logs, stoppedAt: "PO" };
  }

  writeLog("Starting Purchase Order Flow");
  writeLog("Calling ZIV_PO_DETAILS");

  const poNumber = firstNonEmpty(plan?.poNumber, plan?.docNumber, req?.body?.purchaseOrderId, req?.body?.poNumber);
  if (!poNumber) {
    return { ok: false, message: "Purchase Order not found.", steps, rowsByStep, logs, stoppedAt: "PO" };
  }

  const poQuery = buildQuery(primary.entitySet, {
    $filter: buildFilter(primary.idField || "PoNo", normalizeNumericId(poNumber, Number(primary.idPad) || 10)),
    $top: 200,
    $orderby: `${primary.idField || "PoNo"} asc`,
  });
  const poResponse = await fetchFromSap({ system: req.system, service: primary, relativePath: poQuery }, req.sapAuth);
  const poRows = toResultsArray(poResponse);
  

  if (!poRows.length) {
    writeLog("No Purchase Order Found");
    return { ok: false, message: "Purchase Order not found.", steps, rowsByStep, logs, stoppedAt: "PO", consolidated: { rows: {}, steps } };
  }

  writeLog("PO Retrieved");

  const requestedPoItem = normalizeNumericId(
    plan?.poItem || req?.body?.purchaseOrderItem || req?.body?.purchaseOrderItemNo || req?.body?.poItem || req?.body?.docItem || "",
    Number(primary.itemPad) || 5
  );
  const matchingPoRows = requestedPoItem
    ? poRows.filter((row) => normalizeNumericId(firstNonEmpty(row?.PoItem, row?.EBELP), Number(primary.itemPad) || 5) === requestedPoItem)
    : poRows;
  const effectivePoRows = matchingPoRows.length > 0 ? matchingPoRows : poRows;
  attachRows({ steps, rowsByStep }, "PO", effectivePoRows, poResponse, poQuery);

  const firstPo = effectivePoRows[0] || {};
  const resolvedPoNo = normalizeNumericId(firstNonEmpty(firstPo?.PoNo, firstPo?.EBELN, poNumber), Number(primary.idPad) || 10);
  const resolvedPoItem = normalizeNumericId(firstNonEmpty(firstPo?.PoItem, firstPo?.EBELP, requestedPoItem), Number(primary.itemPad) || 5);
  const wantsMaterialStep = stepPlan.includes("MAT");
  const wantsInvoiceStep = stepPlan.includes("RSEG");

  const matService = wantsMaterialStep ? services.MAT : null;
  if (!matService && !wantsInvoiceStep) {
    const merged = buildMergedFlowObject({ poRows: effectivePoRows, rowsByStep });
    return { ok: true, message: "Purchase order retrieved.", steps, rowsByStep, logs, consolidated: { ...merged, steps, rows: rowsByStep, summary: buildSummaryPayload({ steps, rows: rowsByStep }) } };
  }

  let matRows = [];
  if (matService) {
    writeLog("[PO_FLOW] MAT Ledger Input");
    writeLog(`PO Number: ${resolvedPoNo}`);
    writeLog(`PO Item: ${resolvedPoItem}`);
    writeLog("Calling ZIV_MAT_LEDGERS");
    let matPoField = pickPreferredField(
      matService,
      ["purchse_ordr_no", "purch_doc_no", "PoNo", "EBELN", "PurchaseOrder"],
      matService.idField || "purchse_ordr_no"
    );
    let matItemField = pickPreferredField(
      matService,
      ["purchse_ordr_itm_no", "purch_item_no", "PoItem", "EBELP", "PurchaseOrderItem"],
      matService.itemField || "purchse_ordr_itm_no"
    );

    if (!matPoField) matPoField = cleanString(matService.idField || "purchse_ordr_no");
    if (!matItemField) matItemField = cleanString(matService.itemField || "purchse_ordr_itm_no");

    const normalizedMatPoField = normalizeFieldText(matPoField);
    const normalizedMatItemField = normalizeFieldText(matItemField);
    if (normalizedMatPoField && normalizedMatItemField && normalizedMatPoField === normalizedMatItemField) {
      if (hasCatalogField(matService, "purchse_ordr_itm_no")) {
        matItemField = "purchse_ordr_itm_no";
      } else if (hasCatalogField(matService, "purch_item_no")) {
        matItemField = "purch_item_no";
      } else {
        matItemField = "";
      }
    }

    const matQueryParts = [];
    if (matPoField && resolvedPoNo) matQueryParts.push(`${matPoField} eq '${resolvedPoNo}'`);
    if (matItemField && resolvedPoItem) matQueryParts.push(`${matItemField} eq '${resolvedPoItem}'`);
    const matQuery = buildQuery(matService.entitySet, {
      $filter: matQueryParts.join(" and "),
      $top: 200,
    });
    let matResponse = null;
    let matRequestPath = matQuery;
    let matAttached = false;

    const toScopedMatRows = (rows) =>
      filterRowsByPoContext(rows, {
        poNo: resolvedPoNo,
        poItem: resolvedPoItem,
        poPad: Number(primary.idPad) || 10,
        itemPad: Number(primary.itemPad) || 5,
      });

    const looksLikeMissingPropertyError = (error) => {
      const msg = String(error?.message || "");
      const body = String(error?.responseBody || "");
      return Number(error?.status) === 400 && /property\s+.+\s+not\s+found/i.test(`${msg} ${body}`);
    };

    try {
      matResponse = await fetchFromSap({ system: req.system, service: matService, relativePath: matQuery }, req.sapAuth);
      const rawMatRows = toResultsArray(matResponse);
      matRows = toScopedMatRows(rawMatRows);
      if (!matRows.length && rawMatRows.length > 0) {
        matRows = rawMatRows;
      }
      attachRows({ steps, rowsByStep }, "MAT", matRows, matResponse, matRequestPath);
      matAttached = true;

      if (!matRows.length && resolvedPoNo) {
        const poOnlyQuery = buildQuery(matService.entitySet, {
          $filter: `${matPoField} eq '${resolvedPoNo}'`,
          $top: 200,
        });

        const poOnlyResponse = await fetchFromSap({ system: req.system, service: matService, relativePath: poOnlyQuery }, req.sapAuth);
        const rawPoOnlyRows = toResultsArray(poOnlyResponse);
        const poOnlyRows = toScopedMatRows(rawPoOnlyRows);
        const visiblePoOnlyRows = poOnlyRows.length > 0 ? poOnlyRows : rawPoOnlyRows;
        if (visiblePoOnlyRows.length > 0) {
          matRows = visiblePoOnlyRows;
          matRequestPath = poOnlyQuery;
          matResponse = poOnlyResponse;
          attachRows({ steps, rowsByStep }, "MAT", matRows, matResponse, matRequestPath);
          writeLog("[PO_FLOW] MAT PO-only fallback applied");
        }
      }
    } catch (error) {
      if (!looksLikeMissingPropertyError(error)) {
        throw error;
      }

      writeLog("[PO_FLOW] MAT filter field mismatch detected; trying fallback MAT queries");

      const retryFieldPairs = [
        { poField: "purchse_ordr_no", itemField: "purchse_ordr_itm_no" },
        { poField: "PoNo", itemField: "PoItem" },
        { poField: "EBELN", itemField: "EBELP" },
        { poField: "purch_doc_no", itemField: "purch_item_no" },
      ];

      for (const pair of retryFieldPairs) {
        const retryParts = [];
        if (resolvedPoNo) retryParts.push(`${pair.poField} eq '${resolvedPoNo}'`);
        if (resolvedPoItem) retryParts.push(`${pair.itemField} eq '${resolvedPoItem}'`);

        if (!retryParts.length) continue;

        const retryQuery = buildQuery(matService.entitySet, {
          $filter: retryParts.join(" and "),
          $top: 200,
        });

        try {
          const retryResponse = await fetchFromSap({ system: req.system, service: matService, relativePath: retryQuery }, req.sapAuth);
          const rawRetryRows = toResultsArray(retryResponse);
          const retryRows = toScopedMatRows(rawRetryRows);
          const visibleRetryRows = retryRows.length > 0 ? retryRows : rawRetryRows;
          if (visibleRetryRows.length > 0) {
            matRows = visibleRetryRows;
            matRequestPath = retryQuery;
            matResponse = retryResponse;
            attachRows({ steps, rowsByStep }, "MAT", matRows, matResponse, matRequestPath);
            matAttached = true;
            writeLog(`[PO_FLOW] MAT fallback filter applied: ${pair.poField}/${pair.itemField}`);
            break;
          }
        } catch (retryError) {
          if (!looksLikeMissingPropertyError(retryError)) {
            writeLog(`[PO_FLOW] MAT fallback query failed: ${pair.poField}/${pair.itemField}`);
          }
        }
      }

      if (!matAttached) {
        const unfilteredQuery = buildQuery(matService.entitySet, { $top: 200 });
        try {
          const unfilteredResponse = await fetchFromSap({ system: req.system, service: matService, relativePath: unfilteredQuery }, req.sapAuth);
          const rawUnfilteredRows = toResultsArray(unfilteredResponse);
          matRows = toScopedMatRows(rawUnfilteredRows);
          if (!matRows.length && rawUnfilteredRows.length > 0) {
            matRows = rawUnfilteredRows;
          }
          matRequestPath = unfilteredQuery;
          matResponse = unfilteredResponse;
          attachRows({ steps, rowsByStep }, "MAT", matRows, matResponse, matRequestPath);
          matAttached = true;
          writeLog("[PO_FLOW] MAT unfiltered fallback applied");
        } catch {
          writeLog("[PO_FLOW] MAT unfiltered fallback failed");
        }
      }

      if (!matAttached) {
        // Keep complete flow running even when MAT fields are incompatible for this system.
        attachRows({ steps, rowsByStep }, "MAT", [], null, matQuery);
      }
    }

    if (!matRows.length && !wantsInvoiceStep) {
      writeLog("No Material Document Found");
      const merged = buildMergedFlowObject({ poRows: effectivePoRows, matRows: [], rowsByStep, flowStatus: "PARTIAL" });
      return {
        ok: true,
        message: "Goods Receipt not available.",
        steps,
        rowsByStep,
        logs,
        stoppedAt: "MAT",
        consolidated: { ...merged, steps, rows: rowsByStep, summary: buildSummaryPayload({ steps, rows: rowsByStep }) },
      };
    }

    if (matRows.length) {
      writeLog("Material Document Retrieved");
    }
  }

  const matDoc = firstNonEmpty(matRows[0]?.MaterialDocument, matRows[0]?.MBLNR);
  const rsegService = stepPlan.includes("RSEG") ? services.RSEG : null;
  if (!rsegService) {
    const merged = buildMergedFlowObject({ poRows: effectivePoRows, matRows, rowsByStep, flowStatus: "PARTIAL" });
    return { ok: true, message: "Material movement retrieved.", steps, rowsByStep, logs, consolidated: { ...merged, steps, rows: rowsByStep, summary: buildSummaryPayload({ steps, rows: rowsByStep }) } };
  }

  writeLog("Calling ZIV_RSEG_DETAILS");
  writeLog("[PO_FLOW] RSEG Input");
  writeLog(`PO Number: ${resolvedPoNo}`);
  writeLog(`PO Item: ${resolvedPoItem}`);
  const rsegPoField = pickPreferredField(rsegService, ["purch_doc_no", "PoNo", "EBELN", "PurchaseOrder"], rsegService.idField || "purch_doc_no");
  let rsegPoItemField = pickPreferredField(rsegService, ["purch_item_no", "PoItem", "EBELP", "PurchaseOrderItem"], "purch_item_no");
  const normalizedRsegPoField = normalizeFieldText(rsegPoField);
  const normalizedRsegPoItemField = normalizeFieldText(rsegPoItemField);

  // Guardrail: if item field resolves to the same field as PO number, force a true item field or skip item filter.
  if (normalizedRsegPoItemField && normalizedRsegPoField && normalizedRsegPoItemField === normalizedRsegPoField) {
    if (hasCatalogField(rsegService, "purch_item_no")) {
      rsegPoItemField = "purch_item_no";
    } else if (hasCatalogField(rsegService, "PoItem")) {
      rsegPoItemField = "PoItem";
    } else if (hasCatalogField(rsegService, "EBELP")) {
      rsegPoItemField = "EBELP";
    } else {
      rsegPoItemField = "";
    }
  }

  const rsegFilters = [];
  if (resolvedPoNo && rsegPoField) rsegFilters.push(`${rsegPoField} eq '${resolvedPoNo}'`);
  if (resolvedPoItem && rsegPoItemField) rsegFilters.push(`${rsegPoItemField} eq '${resolvedPoItem}'`);
  const rsegQuery = buildQuery(rsegService.entitySet, {
    $filter: rsegFilters.join(" and "),
    $top: 200,
  });
  const rsegResponse = await fetchFromSap({ system: req.system, service: rsegService, relativePath: rsegQuery }, req.sapAuth);
  const rsegRows = filterRowsByPoContext(toResultsArray(rsegResponse), {
    poNo: resolvedPoNo,
    poItem: resolvedPoItem,
    poPad: Number(primary.idPad) || 10,
    itemPad: Number(primary.itemPad) || 5,
  });
  attachRows({ steps, rowsByStep }, "RSEG", rsegRows, rsegResponse, rsegQuery);

  if (!rsegRows.length) {
    writeLog("No Invoice Found");
    const merged = buildMergedFlowObject({ poRows: effectivePoRows, matRows, rsegRows: [], rowsByStep, flowStatus: "PARTIAL" });
    return {
      ok: true,
      message: "Invoice not created.",
      steps,
      rowsByStep,
      logs,
      stoppedAt: "RSEG",
      consolidated: { ...merged, steps, rows: rowsByStep, summary: buildSummaryPayload({ steps, rows: rowsByStep }) },
    };
  }

  const rsegFirstRow = rsegRows[0] || {};
  const accDocNo = firstNonEmpty(rsegFirstRow.acc_doc_no, rsegFirstRow.InvoiceNumber, rsegFirstRow.BELNR);
  const fiscalYear = firstNonEmpty(rsegFirstRow.fiscal_year, rsegFirstRow.FiscalYear, rsegFirstRow.GJAHR);
  const invoiceItem = firstNonEmpty(rsegFirstRow.invoice_item, rsegFirstRow.InvoiceItem, rsegFirstRow.BUZEI);
  const invoiceAmount = firstNonEmpty(rsegFirstRow.amt_doc_curr, rsegFirstRow.inv_amt_supplier, rsegFirstRow.InvoiceAmount);
  const invoiceQuantity = firstNonEmpty(rsegFirstRow.quantity, rsegFirstRow.qty_inv_purchse_ordr_uom, rsegFirstRow.InvoiceQuantity);
  const supplierInvoiceAmount = firstNonEmpty(rsegFirstRow.inv_amt_supplier, rsegFirstRow.InvoiceAmount, rsegFirstRow.amt_doc_curr);
  const supplierAccNo = firstNonEmpty(rsegFirstRow.supplier_acc_no, rsegFirstRow.supplier_acc_number, rsegFirstRow.SupplierAccountNumber);

  const invoice = {
    invoiceNumber: accDocNo,
    fiscalYear,
    invoiceAmount: supplierInvoiceAmount || invoiceAmount,
    quantity: invoiceQuantity,
  };

  writeLog("[PO_FLOW] Invoice Retrieved");
  writeLog(`Invoice Number: ${invoice.invoiceNumber}`);
  writeLog(`Fiscal Year: ${invoice.fiscalYear}`);

  const rbkpService = stepPlan.includes("RBKP") ? services.RBKP : null;
  const acdocaService = stepPlan.includes("ACDOCA") ? services.ACDOCA : null;

  if (rbkpService && accDocNo && fiscalYear) {
    writeLog("Calling ZIV_RBKP_DETAILS");
    const rbkpQuery = buildQuery(rbkpService.entitySet, {
      $filter: `${rbkpService.idField || "acc_doc_no"} eq '${accDocNo}' and ${rbkpService.itemField || "fiscal_year"} eq '${fiscalYear}'`,
      $top: 200,
    });
    const rbkpResponse = await fetchFromSap({ system: req.system, service: rbkpService, relativePath: rbkpQuery }, req.sapAuth);
    const rbkpRows = toResultsArray(rbkpResponse);
    attachRows({ steps, rowsByStep }, "RBKP", rbkpRows, rbkpResponse, rbkpQuery);

    if (rbkpRows.length) {
      writeLog("Invoice Header Retrieved");
    }

    if (acdocaService) {
      writeLog("Calling ZIV_ACDOCA_DETAILS");
      const acdocaQuery = buildQuery(acdocaService.entitySet, {
        $filter: `${acdocaService.idField || "acc_doc_no"} eq '${accDocNo}' and ${acdocaService.itemField || "fiscal_year"} eq '${fiscalYear}'`,
        $top: 200,
      });
      const acdocaResponse = await fetchFromSap({ system: req.system, service: acdocaService, relativePath: acdocaQuery }, req.sapAuth);
      const acdocaRows = toResultsArray(acdocaResponse);
      attachRows({ steps, rowsByStep }, "ACDOCA", acdocaRows, acdocaResponse, acdocaQuery);
      if (acdocaRows.length) {
        writeLog("Accounting Retrieved");
      }
    }
  }

  writeLog("Purchase Order Flow Completed");

  const merged = buildMergedFlowObject({
    poRows: effectivePoRows,
    matRows,
    rsegRows,
    rbkpRows: rowsByStep.RBKP || [],
    acdocaRows: rowsByStep.ACDOCA || [],
    flowStatus: "COMPLETED",
  });

  return {
    ok: true,
    message: "Purchase order flow completed.",
    steps,
    rowsByStep,
    logs,
    consolidated: {
      ...merged,
      rows: rowsByStep,
      steps,
      summary: buildSummaryPayload({ steps, rows: rowsByStep }),
    },
  };
}

export {
  getDocumentFlowStepPlan,
  normalizeDocumentFlowIntent,
};

function buildMergedFlowObject({ poRows = [], matRows = [], rsegRows = [], rbkpRows = [], acdocaRows = [], flowStatus = "PARTIAL" } = {}) {
  const purchaseOrderRow = Array.isArray(poRows) && poRows.length > 0 ? poRows[0] : {};
  const goodsReceiptRow = Array.isArray(matRows) && matRows.length > 0 ? matRows[0] : {};
  const invoiceRow = Array.isArray(rsegRows) && rsegRows.length > 0 ? rsegRows[0] : {};
  const invoiceHeaderRow = Array.isArray(rbkpRows) && rbkpRows.length > 0 ? rbkpRows[0] : {};
  const accountingRow = Array.isArray(acdocaRows) && acdocaRows.length > 0 ? acdocaRows[0] : {};

  return {
    purchaseOrder: {
      poNumber: purchaseOrderRow?.PoNo || null,
      poItem: purchaseOrderRow?.PoItem || null,
      material: purchaseOrderRow?.MatNo || null,
      vendor: purchaseOrderRow?.SuppAcoutNo || purchaseOrderRow?.Vendor || null,
      plant: purchaseOrderRow?.Plant || null,
      quantity: purchaseOrderRow?.Menge || purchaseOrderRow?.Quantity || null,
      rows: poRows,
    },
    goodsReceipt: {
      materialDocument: goodsReceiptRow?.MaterialDocument || goodsReceiptRow?.MBLNR || null,
      movementType: goodsReceiptRow?.MovementType || goodsReceiptRow?.BWART || null,
      postingDate: goodsReceiptRow?.PostingDate || goodsReceiptRow?.BUDAT || null,
      receivedQuantity: goodsReceiptRow?.Quantity || goodsReceiptRow?.Menge || null,
      material: goodsReceiptRow?.Material || goodsReceiptRow?.MatNo || null,
      rows: matRows,
    },
    invoice: {
      invoiceNumber: invoiceRow?.InvoiceNumber || invoiceRow?.BELNR || null,
      fiscalYear: invoiceRow?.FiscalYear || invoiceRow?.GJAHR || null,
      invoiceAmount: invoiceRow?.InvoiceAmount || invoiceRow?.WRBTR || null,
      invoiceQuantity: invoiceRow?.InvoiceQuantity || invoiceRow?.MENGE || null,
      tax: invoiceRow?.Tax || invoiceRow?.MWSKZ || null,
      rows: rsegRows,
    },
    invoiceHeader: {
      grossAmount: invoiceHeaderRow?.GrossAmount || invoiceHeaderRow?.WRBTR || null,
      paymentTerms: invoiceHeaderRow?.PaymentTerms || invoiceHeaderRow?.ZTERM || null,
      irn: invoiceHeaderRow?.IRN || null,
      header: invoiceHeaderRow,
      rows: rbkpRows,
    },
    accounting: {
      accountingDocument: accountingRow?.AccountingDocument || accountingRow?.BELNR || null,
      glAccount: accountingRow?.GLAccount || accountingRow?.HKONT || null,
      debitCredit: accountingRow?.DebitCredit || accountingRow?.SHKZG || null,
      costCenter: accountingRow?.CostCenter || accountingRow?.KOSTL || null,
      profitCenter: accountingRow?.ProfitCenter || accountingRow?.PRCTR || null,
      rows: acdocaRows,
    },
    flowStatus,
  };
}