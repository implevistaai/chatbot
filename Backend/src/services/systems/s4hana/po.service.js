import { buildPoDetailsQuery } from "../../odataQueryBuilder.js";
import { fetchFromSap } from "../../sap.service.js";

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 50;

export function computePurchaseOrderPagination({ rows = [], totalCount = null, pageSize = DEFAULT_PAGE_SIZE, cursor = 0 } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safePageSize = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize))) : DEFAULT_PAGE_SIZE;
  const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) > 0 ? Number(cursor) : 0;
  const nextCursor = safeCursor + safeRows.length;
  const hasMore = Number.isFinite(Number(totalCount))
    ? nextCursor < Number(totalCount)
    : safeRows.length === safePageSize;

  return {
    pageSize: safePageSize,
    cursor: safeCursor,
    nextPage: hasMore ? { cursor: nextCursor } : null,
    hasMore,
  };
}

function resolveSapContext(req) {
  const system = req?.sapSystem || req?.system || req?.sap?.system;
  const service = req?.sapService || req?.service || req?.sap?.service;
  const auth =
    req?.sapAuth ||
    req?.authOverride ||
    req?.sap?.auth ||
    req?.sapCredentials;

  if (!system) {
    throw new Error("SAP system context missing on request");
  }

  if (!service) {
    throw new Error("SAP service context missing on request");
  }

  if (!auth?.username || !auth?.password) {
    throw new Error("SAP auth context missing on request");
  }

  return { system, service, auth };
}

export async function listPurchaseOrders({ req, query } = {}) {
  const { system, service, auth } = resolveSapContext(req);

  const pageSizeRaw = Number(query?.pageSize ?? req?.query?.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.max(1, Math.min(MAX_PAGE_SIZE, pageSizeRaw)) : DEFAULT_PAGE_SIZE;
  const cursorRaw = Number(query?.cursor ?? req?.query?.cursor ?? 0);
  const skip = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;

  const finalQuery = buildPoDetailsQuery(query || req?.query || {}, {
    maxTop: pageSize,
  });

  const pagedQuery = buildPoDetailsQuery(
    {
      ...query,
      ...req?.query,
      $top: pageSize,
      $skip: skip,
    },
    {
      maxTop: pageSize,
    }
  );

  const sapData = await fetchFromSap(
    {
      system,
      service,
      relativePath: pagedQuery || finalQuery,
    },
    auth
  );

  const rows = Array.isArray(sapData?.d?.results) ? sapData.d.results : [];
  const totalCount = Number(sapData?.d?.__count || 0) || null;
  const pagination = computePurchaseOrderPagination({ rows, totalCount, pageSize, cursor: skip });

  return {
    data: sapData,
    rows,
    totalCount,
    ...pagination,
  };
}

export async function getPurchaseOrderDetails({ req, purchaseOrderId } = {}) {
  const { system, service, auth } = resolveSapContext(req);
  const poNo = String(purchaseOrderId || "").trim();

  if (!poNo) {
    throw new Error("purchaseOrderId is required");
  }

  const finalQuery = buildPoDetailsQuery(
    {
      $filter: `PoNo eq '${poNo.replace(/'/g, "''")}'`,
      $top: 10,
      $skip: 0,
      $select: [
        "PoNo",
        "Plant",
        "RelSt",
        "RelInd",
        "ReleaseState",
        "ReleaseIndicator",
        "Status",
        "DelivStatusItem",
        "DelivInd",
        "DelivStatusItem2",
        "Wemng",
        "NetPrice",
        "NetVal",
        "RlseTotalValue",
        "CurKey",
      ].join(","),
    },
    { maxTop: 10 }
  );

  const sapData = await fetchFromSap(
    {
      system,
      service,
      relativePath: finalQuery,
    },
    auth
  );

  return {
    data: sapData,
    rows: Array.isArray(sapData?.d?.results) ? sapData.d.results : [],
    totalCount: Number(sapData?.d?.__count || 0) || null,
  };
}