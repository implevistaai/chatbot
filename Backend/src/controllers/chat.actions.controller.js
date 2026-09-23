import { createSapActionHandler } from "./_shared/createSapActionHandler.js";
import { getOwner } from "./_chat/auth.js";
import { resolveSapConnection } from "../services/sap/sapConnectionResolver.service.js";
import {
  createSolmanChangeRequest,
  getSolmanChangeRequestDetailsById,
  listSolmanChangeRequestsByDateRange,
} from "../services/systems/solman/charm.service.js";
import { getPurchaseOrderDetails, listPurchaseOrders } from "../services/systems/s4hana/po.service.js";
import { getDependentTransportsFromCr, getTransportNumbersFromCr } from "../services/systems/solman/transport.service.js";
import { createTransportRequest } from "../services/systems/solman/transportRequest.service.js";
import { postToSap } from "../services/sap/sapWrite.service.js";
import { persistAssistantAndTouchSession } from "./stream/solman/solman.shared.js";
import { executePurchaseOrderFlow } from "../services/procurement/purchaseOrderFlow.service.js";
import { detectDocumentFlowIntent } from "../services/procurement/procurementQueryEngine.service.js";
import {
  assertPendingPoServiceCompatibility,
  getPendingPurchaseOrderItems,
  getPendingPurchaseOrderList,
  PENDING_PO_ENTITY_SET,
  PENDING_PO_SERVICE_NAME,
} from "../services/procurement/pendingPurchaseOrder.service.js";
import { SapServiceMap } from "../models/SapServiceMap.model.js";
import { getAllowedFieldsWithLabels } from "../services/allowlist.service.js";

function cleanString(v) {
  return String(v || "").trim();
}

function resolveCurrentSolmanUsername(connection) {
  return cleanString(
    connection?.sapAuth?.username ||
      connection?.sapAuth?.user ||
      connection?.sapAuth?.sapUser ||
      connection?.sapAuth?.USER ||
      ""
  ).toUpperCase();
}

function validateCreateChangeRequestInput(body) {
  console.log("[chat.actions] create-change-request input", {
    systemId: cleanString(body?.systemId),
    sapUser: cleanString(body?.sapUser),
    payloadKeys: body?.payload && typeof body.payload === "object" ? Object.keys(body.payload) : [],
  });

  if (!cleanString(body?.systemId)) {
    console.warn("[chat.actions] create-change-request blocked: missing systemId", {
      systemId: cleanString(body?.systemId),
      sapUser: cleanString(body?.sapUser),
      payload: body?.payload || null,
    });
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    console.warn("[chat.actions] create-change-request blocked: missing sapUser", {
      systemId: cleanString(body?.systemId),
      sapUser: cleanString(body?.sapUser),
      payload: body?.payload || null,
    });
    return "sapUser is required.";
  }

  if (!body?.payload || typeof body.payload !== "object") {
    console.warn("[chat.actions] create-change-request blocked: missing payload", {
      systemId: cleanString(body?.systemId),
      sapUser: cleanString(body?.sapUser),
    });
    return "payload is required.";
  }

  return null;
}

function validateGetChangeRequestDetailsInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!cleanString(body?.objectId)) {
    return "objectId is required.";
  }

  return null;
}

function validateListChangeRequestsInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!cleanString(body?.fromDate)) {
    return "fromDate is required.";
  }

  if (!cleanString(body?.toDate)) {
    return "toDate is required.";
  }

  return null;
}

function validateListTransportsInput(body) {
  if (!cleanString(body?.objectId)) {
    return "objectId is required.";
  }

  return null;
}

function validateCreateTransportRequestInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!body?.payload || typeof body.payload !== "object") {
    return "payload is required.";
  }

  if (!cleanString(body?.payload?.SolmanChangeReq)) {
    return "SolmanChangeReq is required.";
  }

  if (!cleanString(body?.payload?.TrOwner)) {
    return "TrOwner is required.";
  }

  if (!cleanString(body?.payload?.Client)) {
    return "Client is required.";
  }

  return null;
}

function validateGetPurchaseOrderDetailsInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!cleanString(body?.purchaseOrderId)) {
    return "purchaseOrderId is required.";
  }

  return null;
}

function validateGetProcurementFlowDetailsByItemInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!cleanString(body?.purchaseOrderId)) {
    return "purchaseOrderId is required.";
  }

  if (!cleanString(body?.purchaseOrderItem)) {
    return "purchaseOrderItem is required.";
  }

  return null;
}

function validateGetPendingPurchaseOrdersInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  const poNo = cleanString(body?.poNo);

  if (!cleanString(body?.dateFrom) && !poNo) {
    return "dateFrom is required.";
  }

  if (!cleanString(body?.dateTo) && !poNo) {
    return "dateTo is required.";
  }

  return null;
}

function validateGetPendingPurchaseOrderItemsInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!cleanString(body?.poNo)) {
    return "poNo is required.";
  }

  return null;
}

function resolvePendingPoServiceMap(catalogs = [], fallbackSystemId = "") {
  const rows = Array.isArray(catalogs) ? catalogs : [];

  const preferred = rows.find((catalog) => {
    const serviceName = cleanString(catalog?.serviceName).toUpperCase();
    const entitySet = cleanString(catalog?.entitySet).toUpperCase();
    return serviceName === PENDING_PO_SERVICE_NAME || entitySet === PENDING_PO_ENTITY_SET;
  });
  if (preferred) return preferred;

  return null;
}

function inferEntityTypeName(service = {}) {
  const explicit = cleanString(service?.entityTypeName);
  if (explicit) return explicit;
  const entitySet = cleanString(service?.entitySet);
  if (!entitySet) return "";
  return entitySet.replace(/Set$/i, "");
}

function hasRequiredPendingPoFields(fields = []) {
  const normalize = (value) => cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
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
    if (!cleanString(candidate?.serviceName) || !cleanString(candidate?.entitySet)) continue;

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
      // Ignore one candidate failing metadata fetch and continue probing.
    }
  }

  return null;
}

function cleanText(value, fallback = "NULL") {
  const text = String(value ?? "").trim();
  return text || fallback;
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

  const sections = [
    {
      title: "Purchase Document Summary",
      columns: ["PO Number", "PO Item", "Material Number", "Quantity"],
      rows: (Array.isArray(poRows) && poRows.length > 0 ? poRows : [primary]).map((row) => [
        cleanText(row?.PoNo || poNo),
        cleanText(row?.PoItem || poItem),
        cleanText(row?.MatNo || row?.MaterialNumber || row?.Material || row?.material_no),
        cleanText(row?.PO_Quantity || row?.PoQuantity || row?.Menge || row?.Quantity || row?.TotalPoQuantity),
      ]),
    },
  ];

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

function validateCreateTransportTaskInput(body) {
  if (!cleanString(body?.systemId)) {
    return "systemId is required.";
  }

  if (!cleanString(body?.sapUser)) {
    return "sapUser is required.";
  }

  if (!body?.payload || typeof body.payload !== "object") {
    return "payload is required.";
  }

  if (!cleanString(body?.payload?.IM_TRANSPORT_NO)) {
    return "transportNo is required.";
  }

  if (!cleanString(body?.payload?.IM_SOLMAN_CHANGE_REQ)) {
    return "changeRequest is required.";
  }

  return null;
}

function extractCrNumberFromMessage(message) {
  const text = cleanString(message);
  if (!text) return "";

  const match = text.match(/\bCR\s*[:#-]?\s*(\d{6,})\b/i);
  return match?.[1] ? cleanString(match[1]) : "";
}

export const submitSolmanCreateChangeRequest = createSapActionHandler({
  executor: "solman.charm.createChangeRequest",

  validate: validateCreateChangeRequestInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const result = await createSolmanChangeRequest({
      system: connection.system,
      sapAuth: connection.sapAuth,
      payload: body.payload,
    });

    console.log("[chat.actions] create-change-request SAP response", {
      ok: result?.ok,
      message: result?.message,
      changeRequestId: result?.changeRequestId || null,
      status: result?.status || null,
      msgType: result?.msgType || null,
      raw: result?.raw || null,
    });

    const messageCrNumber = extractCrNumberFromMessage(result?.message);
    const responseCrNumber = cleanString(result?.changeRequestId || result?.ESolmanCr || messageCrNumber);

    console.log("[chat.actions] create-change-request derived CR", {
      responseCrNumber,
      messageCrNumber,
      message: result?.message || null,
    });

    const responseSummary = {
      changeRequestId: responseCrNumber || null,
      status: cleanString(result?.status || result?.EMsgType || result?.msgType || ""),
      shortDesc: cleanString(body?.payload?.ShortDesc),
      deliveryResponsible: cleanString(body?.payload?.DeliveryResponsible),
      developer: cleanString(body?.payload?.Developer),
      tester: cleanString(body?.payload?.Tester),
      workItemReference: cleanString(body?.payload?.WorkItemReference),
      landscape: cleanString(body?.payload?.Landscape),
      reqUrlNav: Array.isArray(body?.payload?.REQ_URL_NAV)
        ? body.payload.REQ_URL_NAV
            .map((item) => ({
              URL: cleanString(item?.URL),
              URL_NAME: cleanString(item?.URL_NAME),
            }))
            .filter((item) => item.URL || item.URL_NAME)
        : [],
    };

    const sessionId = String(body?.sessionId || "").trim();
    if (/^[a-f0-9]{24}$/i.test(sessionId)) {
      await persistAssistantAndTouchSession({
        owner,
        sessionId,
        text: responseCrNumber
          ? `CR ${responseCrNumber} created successfully.`
          : result?.message || "Change request created successfully.",
        summary: responseCrNumber
          ? `CR ${responseCrNumber} created successfully.`
          : result?.message || "Change request created successfully.",
        extracted: {
          system: "solman",
          intent: "create_change_request",
          changeRequestId: responseCrNumber || null,
          status: cleanString(result?.status || result?.EMsgType || result?.msgType || "") || null,
        },
        data: {
          viewType: "solman_create_cr_success",
          ...responseSummary,
          raw: result?.raw || null,
        },
        responseMeta: {
          ok: true,
          kind: "action",
          executor: "solman.charm.createChangeRequest",
          systemId: connection.system?.systemId || body?.systemId || "",
          sapUser: connection.sapAuth?.username || connection.sapAuth?.sapUser || body?.sapUser || "",
        },
      });
    }

    if (!result?.ok) {
      const err = new Error(
        result?.message || "Failed to create change request."
      );
      err.status = result?.statusCode || 400;
      err.code = result?.code || "EXECUTION_FAILED";
      throw err;
    }

    return {
      ...result,
      changeRequestId: responseCrNumber,
      ESolmanCr: responseCrNumber,
      status: cleanString(result?.status || result?.EMsgType || result?.msgType || ""),
      summary: responseSummary,
      submittedFields: {
        ShortDesc: cleanString(body?.payload?.ShortDesc),
        DeliveryResponsible: cleanString(body?.payload?.DeliveryResponsible),
        Developer: cleanString(body?.payload?.Developer),
        Tester: cleanString(body?.payload?.Tester),
        WorkItemReference: cleanString(body?.payload?.WorkItemReference),
        Landscape: cleanString(body?.payload?.Landscape),
        REQ_URL_NAV: Array.isArray(body?.payload?.REQ_URL_NAV)
          ? body.payload.REQ_URL_NAV.map((item) => ({
              URL: cleanString(item?.URL),
              URL_NAME: cleanString(item?.URL_NAME),
            }))
          : [],
      },
    };
  },

  mapSuccessResult: (result) => ({
    changeRequestId: result.changeRequestId,
    status: result.status,
    summary: {
      ShortDesc: result.submittedFields?.ShortDesc || "",
      DeliveryResponsible: result.submittedFields?.DeliveryResponsible || "",
      Developer: result.submittedFields?.Developer || "",
      Tester: result.submittedFields?.Tester || "",
      WorkItemReference: result.submittedFields?.WorkItemReference || "",
      Landscape: result.submittedFields?.Landscape || "",
      REQ_URL_NAV: Array.isArray(result.submittedFields?.REQ_URL_NAV)
        ? result.submittedFields.REQ_URL_NAV
        : [],
    },
    raw: result.raw,
  }),
});

export const getSolmanChangeRequestDetails = createSapActionHandler({
  executor: "solman.charm.getChangeRequestDetails",

  validate: validateGetChangeRequestDetailsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    return await getSolmanChangeRequestDetailsById({
      system: connection.system,
      sapAuth: connection.sapAuth,
      objectId: body.objectId,
      processType: body.processType || "YMHF",
    });
  },

  mapSuccessResult: (result) => ({
    objectId: result.objectId,
    processType: result.processType,
    count: result.count,
    results: result.results,
    raw: result.raw,
  }),
});

export const listSolmanChangeRequests = createSapActionHandler({
  executor: "solman.charm.listChangeRequests",

  validate: validateListChangeRequestsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    let createdBy = cleanString(body.createdBy || "");
    if (cleanString(body.createdByMode).toLowerCase() === "self") {
      createdBy = resolveCurrentSolmanUsername(connection);
    }

    return await listSolmanChangeRequestsByDateRange({
      system: connection.system,
      sapAuth: connection.sapAuth,
      processType: body.processType || "YMHF",
      fromDate: body.fromDate,
      toDate: body.toDate,
      triggerAll: body.triggerAll || "X",
      createdBy,
      createdByMode: body.createdByMode || "",
      status: body.status || "",
      statusMode: body.statusMode || "",
      excludeStatuses: Array.isArray(body.excludeStatuses) ? body.excludeStatuses : [],
      top: body.top ?? null,
      skip: body.skip ?? 0,
      orderBy: body.orderBy || "CREATED_ON desc",
    });
  },

  mapSuccessResult: (result) => ({
    processType: result?.result?.processType || result?.processType,
    fromDate: result?.result?.fromDate || result?.fromDate,
    toDate: result?.result?.toDate || result?.toDate,
    triggerAll: result?.result?.triggerAll || result?.triggerAll,
    createdBy: result?.result?.createdBy || result?.createdBy || "",
    count: result?.result?.count ?? result?.count ?? 0,
    results: Array.isArray(result?.result?.results)
      ? result.result.results
      : Array.isArray(result?.results)
        ? result.results
        : [],
    raw: result?.result?.raw || result?.raw || null,
    status: result?.result?.status || result?.status || "",
    statusMode: result?.result?.statusMode || result?.statusMode || "",
    excludeStatuses:
      result?.result?.excludeStatuses || result?.excludeStatuses || [],
    top: result?.result?.top ?? result?.top ?? null,
    skip: result?.result?.skip ?? result?.skip ?? 0,
    orderBy: result?.result?.orderBy || result?.orderBy || "CREATED_ON desc",
    nextSkip: result?.result?.nextSkip ?? result?.nextSkip ?? 0,
  }),
});

export const submitSolmanCreateTransportRequest = createSapActionHandler({
  executor: "solman.transport.createTransportRequest",

  validate: validateCreateTransportRequestInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    return await createTransportRequest({
      system: connection.system,
      sapAuth: connection.sapAuth,
      payload: body.payload,
    });
  },

  mapSuccessResult: (result) => ({
    changeRequestId: result?.result?.changeRequestId || "",
    transportRequest: result?.result?.transportRequest || "",
    workbenchTransport: result?.result?.workbenchTransport || "",
    customizingTransport: result?.result?.customizingTransport || "",
    outputMessage: result?.result?.outputMessage || "",
    messages: Array.isArray(result?.result?.messages) ? result.result.messages : [],
    trOwner: result?.result?.trOwner || "",
    client: result?.result?.client || "",
    message: result?.message || "Transport Request created successfully.",
    raw: result?.result?.raw || null,
  }),
});

export const listSolmanTransports = createSapActionHandler({
  executor: "solman.transport.listTransports",

  validate: validateListTransportsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    return await getTransportNumbersFromCr({
      system: connection.system,
      sapAuth: connection.sapAuth,
      changeRequestId: body.objectId,
      processType: body.processType || "",
    });
  },

  mapSuccessResult: (result) => ({
    changeRequestId: result?.result?.changeRequestId || result?.changeRequestId || "",
    processType: result?.result?.processType || result?.processType || "",
    transports: Array.isArray(result?.result?.rows)
      ? result.result.rows
      : [],
    count: Array.isArray(result?.result?.rows) ? result.result.rows.length : 0,
    raw: result?.result?.raw || result?.raw || null,
    message: result?.message || "",
  }),
});

export const checkSolmanTransportDependencies = createSapActionHandler({
  executor: "solman.transport.dependencyCheck",

  validate: validateListTransportsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    return await getDependentTransportsFromCr({
      system: connection.system,
      sapAuth: connection.sapAuth,
      changeRequestId: body.objectId,
      processType: body.processType || "",
    });
  },

  mapSuccessResult: (result) => ({
    changeRequestId: result?.result?.changeRequestId || result?.changeRequestId || "",
    processType: result?.result?.processType || result?.processType || "",
    sourceTransports: Array.isArray(result?.result?.sourceTransports)
      ? result.result.sourceTransports
      : [],
    dependencies: Array.isArray(result?.result?.dependencies)
      ? result.result.dependencies
      : [],
    dependencyMessage: result?.result?.dependencyMessage || "",
    raw: result?.result?.raw || result?.raw || null,
    message: result?.message || "",
  }),
});

export const submitSolmanCreateTransportTask = createSapActionHandler({
  executor: "solman.transport.createTransportTask",

  validate: validateCreateTransportTaskInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const raw = await postToSap(
      {
        system: connection.system,
        relativePath: "/sap/opu/odata/sap/ZCREATE_TRANSPORT_TASKS_SRV/TransportTaskSet",
        body: body.payload,
      },
      connection.sapAuth
    );

    const d = raw?.d || raw || {};
    const status = String(d?.EV_TR_OUTPUT_MSG || d?.EV_OUTPUT_MSG || d?.STATUS || d?.STATUS_TEXT || "S").trim();
    const taskMessage = String(d?.TASK_MESSAGE || "[]").trim();
    const tasks = String(d?.TASKS || "[]").trim();

    const responseSummary = {
      transportNo: cleanString(body?.payload?.IM_TRANSPORT_NO),
      changeRequest: cleanString(body?.payload?.IM_SOLMAN_CHANGE_REQ),
      developers: (() => {
        try {
          return JSON.parse(String(body?.payload?.DEVELOPERS || "[]"))
            .map((item) => cleanString(item?.developer))
            .filter(Boolean);
        } catch {
          return [];
        }
      })(),
      status,
      taskMessage,
      tasks,
    };

    const sessionId = String(body?.sessionId || "").trim();
    if (/^[a-f0-9]{24}$/i.test(sessionId)) {
      await persistAssistantAndTouchSession({
        owner,
        sessionId,
        text: `Transport task creation completed for CR ${responseSummary.changeRequest}.`,
        summary: `Transport task creation completed for CR ${responseSummary.changeRequest}.`,
        extracted: {
          system: "solman",
          intent: "create_transport_task",
          transportNo: responseSummary.transportNo,
          changeRequest: responseSummary.changeRequest,
          developers: responseSummary.developers,
          status,
        },
        data: {
          viewType: "solman_create_transport_task_success",
          ...responseSummary,
          raw,
        },
        responseMeta: {
          ok: true,
          kind: "action",
          executor: "solman.transport.createTransportTask",
          systemId: connection.system?.systemId || body?.systemId || "",
          sapUser: connection.sapAuth?.username || connection.sapAuth?.sapUser || body?.sapUser || "",
        },
      });

    }

    return {
      ok: true,
      message: `Transport task creation completed for CR ${responseSummary.changeRequest}.`,
      summary: responseSummary,
      raw,
    };
  },

  mapSuccessResult: (result) => ({
    ...result,
    summary: result.summary,
    raw: result.raw,
  }),
});

export const submitSolmanReleaseTransportTask = createSapActionHandler({
  executor: "solman.transport.releaseTransportTask",

  validate: (body) => {
    if (!cleanString(body?.systemId)) return "systemId is required.";
    if (!cleanString(body?.sapUser)) return "sapUser is required.";
    if (!body?.payload || typeof body.payload !== "object") return "payload is required.";
    if (!cleanString(body?.payload?.IvTaskId)) return "Task number is required.";
    return null;
  },

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const serviceName = String(process.env.SOLMAN_RELEASE_TASK_SERVICE_NAME || "ZTASK_RELEASE_SRV").trim();
    const entitySetName = String(process.env.SOLMAN_RELEASE_TASK_ENTITYSET || "ZTask_releaseSet").trim();

    const taskId = cleanString(body?.payload?.IvTaskId).toUpperCase();

    let raw;
    try {
      raw = await postToSap(
        {
          system: connection.system,
          relativePath: `/sap/opu/odata/sap/${serviceName}/${entitySetName}`,
          body: { IvTaskId: taskId },
        },
        connection.sapAuth
      );
    } catch (error) {
      const message = String(error?.message || "");
      if (/No service found for namespace/i.test(message) || /service not found/i.test(message) || /not active/i.test(message)) {
        const friendly = `SAP service ${serviceName} is not active on this system, or the service name/entity set is wrong. Activate it in SAP Gateway or update SOLMAN_RELEASE_TASK_SERVICE_NAME / SOLMAN_RELEASE_TASK_ENTITYSET.`;
        const wrapped = new Error(friendly);
        wrapped.status = 404;
        wrapped.code = "SAP_SERVICE_NOT_FOUND";
        wrapped.userMessage = friendly;
        throw wrapped;
      }
      throw error;
    }

    const d = raw?.d || raw || {};
    const responseTaskId = cleanString(d?.IvTaskId || taskId).toUpperCase();
    const responseMessage = cleanString(d?.EvMessage || d?.EV_MESSAGE || `Task ${responseTaskId} released successfully`);

    const sessionId = String(body?.sessionId || "").trim();
    if (/^[a-f0-9]{24}$/i.test(sessionId)) {
      await persistAssistantAndTouchSession({
        owner,
        sessionId,
        text: `✅ Transport task released successfully.\n\nTask Number:\n${responseTaskId}\n\nSAP Message:\n${responseMessage}`,
        summary: responseMessage,
        extracted: {
          system: "solman",
          intent: "release_transport_task",
          taskId: responseTaskId,
        },
        data: {
          viewType: "solman_release_transport_task_success",
          taskId: responseTaskId,
          message: responseMessage,
          raw,
        },
        responseMeta: {
          ok: true,
          kind: "action",
          executor: "solman.transport.releaseTransportTask",
          systemId: connection.system?.systemId || body?.systemId || "",
          sapUser: connection.sapAuth?.username || connection.sapAuth?.sapUser || body?.sapUser || "",
        },
      });

    }

    return {
      ok: true,
      message: responseMessage,
      taskId: responseTaskId,
      raw,
    };
  },

  mapSuccessResult: (result) => ({
    taskId: result.taskId,
    message: result.message,
    raw: result.raw,
  }),
});

export const getPurchaseOrderDetailsAction = createSapActionHandler({
  executor: "s4hana.mm.getPurchaseOrderDetails",

  validate: validateGetPurchaseOrderDetailsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    return await getPurchaseOrderDetails({
      req: {
        sapSystem: connection.system,
        sapService: {
          serviceName: body.serviceName || process.env.DEFAULT_PO_SERVICE_NAME || "",
          entitySet: body.entitySet || process.env.DEFAULT_PO_ENTITYSET || "",
        },
        sapAuth: connection.sapAuth,
      },
      purchaseOrderId: body.purchaseOrderId,
    });
  },

  mapSuccessResult: (result) => ({
    rows: result.rows || [],
    totalCount: result.totalCount || null,
    data: result.data || null,
  }),
});

export const listPurchaseOrdersAction = createSapActionHandler({
  executor: "s4hana.mm.listPurchaseOrders",

  validate: (body) => {
    if (!cleanString(body?.systemId)) return "systemId is required.";
    if (!cleanString(body?.sapUser)) return "sapUser is required.";
    return null;
  },

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const result = await listPurchaseOrders({
      req: {
        sapSystem: connection.system,
        sapService: {
          serviceName: body.serviceName || process.env.DEFAULT_PO_SERVICE_NAME || "",
          entitySet: body.entitySet || process.env.DEFAULT_PO_ENTITYSET || "",
        },
        sapAuth: connection.sapAuth,
        query: { pageSize: body.pageSize, cursor: body.cursor },
      },
      query: {
        pageSize: body.pageSize,
        cursor: body.cursor,
      },
    });

    return {
      ok: true,
      message: "Purchase orders fetched successfully.",
      ...result,
    };
  },

  mapSuccessResult: (result) => ({
    rows: result.rows,
    data: result.data,
    totalCount: result.totalCount,
    pageSize: result.pageSize,
    cursor: result.cursor,
    nextPage: result.nextPage,
    hasMore: result.hasMore,
  }),
});

export const getProcurementFlowDetailsByItemAction = createSapActionHandler({
  executor: "s4hana.mm.getProcurementFlowDetailsByItem",

  validate: validateGetProcurementFlowDetailsByItemInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const requestedPoNo = cleanString(body.purchaseOrderId);
    const requestedPoItem = cleanString(body.purchaseOrderItem);
    const requestQuery = cleanString(body.query);
    const normalizedDocumentFlowIntent =
      cleanString(body.documentFlowIntent).toUpperCase() ||
      detectDocumentFlowIntent(requestQuery) ||
      "COMPLETE_DOCUMENT_FLOW";

    const flowServices = await SapServiceMap.find({
      owner: { $in: [owner, "local"] },
      systemId: cleanString(connection?.system?.systemId || body.systemId).toUpperCase(),
      serviceType: { $in: ["PO", "MAT", "RSEG", "RBKP", "ACDOCA"] },
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const flowResult = await executePurchaseOrderFlow({
      req: {
        system: connection.system,
        sapAuth: connection.sapAuth,
        body: {
          purchaseOrderId: requestedPoNo,
          purchaseOrderItem: requestedPoItem,
        },
      },
      catalogs: flowServices,
      plan: {
        primary: { serviceType: "PO" },
        poNumber: requestedPoNo,
        poItem: requestedPoItem,
        documentFlowIntent: normalizedDocumentFlowIntent,
      },
      query: requestQuery || `Show complete document flow for PO ${requestedPoNo} item ${requestedPoItem}`,
      logger: console,
    });

    if (!flowResult?.ok) {
      const error = new Error(flowResult?.message || "Failed to fetch procurement flow details.");
      error.status = 404;
      throw error;
    }

    const flowRowsByStep = flowResult?.consolidated?.rows || flowResult?.rows || {};
    const primaryRows = Array.isArray(flowRowsByStep.PO) ? flowRowsByStep.PO : [];
    const materialRows = Array.isArray(flowRowsByStep.MAT) ? flowRowsByStep.MAT : [];
    const invoiceRows = Array.isArray(flowRowsByStep.RSEG) ? flowRowsByStep.RSEG : [];
    const rbkpRows = Array.isArray(flowRowsByStep.RBKP) ? flowRowsByStep.RBKP : [];
    const acdocaRows = Array.isArray(flowRowsByStep.ACDOCA) ? flowRowsByStep.ACDOCA : [];

    const poNo = primaryRows[0]?.PoNo || requestedPoNo || "NULL";
    const poItem = primaryRows[0]?.PoItem || requestedPoItem || "NULL";
    const procurementPoRows =
      Array.isArray(flowResult?.consolidated?.purchaseOrder?.rows) && flowResult.consolidated.purchaseOrder.rows.length > 0
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

    return {
      ok: true,
      message: `Procurement flow details fetched for PO ${poNo} / Item ${poItem}.`,
      viewType: "procurement_flow",
      poNo,
      poItem,
      documentFlowIntent: normalizedDocumentFlowIntent,
      sections,
      flow: flowResult,
      requestContext: {
        query: requestQuery,
        businessScope: cleanString(body.businessScope),
        cursor: body.cursor ?? null,
        pendingAction: body.pendingAction || null,
        availableSystems: Array.isArray(body.availableSystems) ? body.availableSystems : null,
      },
    };
  },

  mapSuccessResult: (result) => ({
    viewType: result.viewType,
    poNo: result.poNo,
    poItem: result.poItem,
    documentFlowIntent: result.documentFlowIntent,
    sections: result.sections,
    flow: result.flow,
    requestContext: result.requestContext,
  }),
});

export const getPendingPurchaseOrdersAction = createSapActionHandler({
  executor: "s4hana.mm.getPendingPurchaseOrders",

  validate: validateGetPendingPurchaseOrdersInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const serviceMaps = await SapServiceMap.find({
      owner: { $in: [owner, "local"] },
      systemId: cleanString(connection?.system?.systemId || body.systemId).toUpperCase(),
      serviceType: "PO",
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const pendingPoService = await resolveCompatiblePendingPoService({
      catalogs: serviceMaps,
      system: connection.system,
      sapAuth: connection.sapAuth,
    });
    assertPendingPoServiceCompatibility(pendingPoService);

    const result = await getPendingPurchaseOrderList({
      system: connection.system,
      sapAuth: connection.sapAuth,
      service: pendingPoService,
      dateFrom: cleanString(body.dateFrom),
      dateTo: cleanString(body.dateTo),
      poNo: cleanString(body.poNo),
      pageSize: Number(body.pageSize) || 30,
      cursor: body.cursor || null,
    });

    return {
      ok: true,
      message: "Pending purchase orders fetched successfully.",
      ...result,
    };
  },

  mapSuccessResult: (result) => ({
    viewType: result.viewType,
    intent: result.intent,
    dateFrom: result.dateFrom,
    dateTo: result.dateTo,
    pageSize: result.pageSize,
    rows: result.rows,
    count: result.count,
    hasMore: result.hasMore,
    nextPage: result.nextPage,
    pendingFilter: result.pendingFilter,
    orderBy: result.orderBy,
    dataQualityIssues: result.dataQualityIssues,
    sourceService: result.sourceService,
    sourceEntitySet: result.sourceEntitySet,
  }),
});

export const getPendingPurchaseOrderItemsAction = createSapActionHandler({
  executor: "s4hana.mm.getPendingPurchaseOrderItems",

  validate: validateGetPendingPurchaseOrderItemsInput,

  execute: async ({ owner, body }) => {
    const connection = await resolveSapConnection({
      owner,
      systemId: body.systemId,
      sapUser: body.sapUser,
    });

    const serviceMaps = await SapServiceMap.find({
      owner: { $in: [owner, "local"] },
      systemId: cleanString(connection?.system?.systemId || body.systemId).toUpperCase(),
      serviceType: "PO",
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const pendingPoService = await resolveCompatiblePendingPoService({
      catalogs: serviceMaps,
      system: connection.system,
      sapAuth: connection.sapAuth,
    });
    assertPendingPoServiceCompatibility(pendingPoService);

    const result = await getPendingPurchaseOrderItems({
      system: connection.system,
      sapAuth: connection.sapAuth,
      service: pendingPoService,
      poNo: cleanString(body.poNo),
      dateFrom: cleanString(body.dateFrom),
      dateTo: cleanString(body.dateTo),
    });

    return {
      ok: true,
      message: `Pending items fetched for PO ${result.poNo}.`,
      ...result,
    };
  },

  mapSuccessResult: (result) => ({
    viewType: result.viewType,
    intent: result.intent,
    poNo: result.poNo,
    dateFrom: result.dateFrom,
    dateTo: result.dateTo,
    items: result.items,
    count: result.count,
    pendingFilter: result.pendingFilter,
    sourceService: result.sourceService,
    sourceEntitySet: result.sourceEntitySet,
  }),
});