import { authFetch } from "./authFetch";

const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  `${window.location.protocol}//${window.location.hostname}:3000`;

async function readResponseBody(res) {
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json") || contentType.includes("+json")) {
    const json = await res.clone().json().catch(() => null);
    if (json != null) return json;
  }

  const text = await res.clone().text().catch(() => "");
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text,
      rawText: text,
    };
  }
}

export async function sendChatMessage({
  query,
  sessionId,
  systemId,
  sapUser,
  availableSystems,
  cursor = null,
  limit = null,
  skip = null,
  fromDate = null,
  toDate = null,
}) {
  const message = String(query || "").trim();

  if (!message) {
    throw new Error("query is required");
  }

  const body = {
    query: message,
    sessionId: sessionId || null,
    systemId: systemId || null,
  };

  const su = String(sapUser || "").trim();
  if (su) {
    body.sapUser = su;
  }

  if (Array.isArray(availableSystems)) {
    body.availableSystems = availableSystems;
  }

  if (cursor) {
    body.cursor = cursor;
  }

  if (limit != null) {
    body.limit = limit;
  }

  if (skip != null) {
    body.skip = skip;
  }

  if (fromDate) {
    body.fromDate = fromDate;
  }

  if (toDate) {
    body.toDate = toDate;
  }

  const res = await authFetch(`${apiBase}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await readResponseBody(res);

  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || `Chat request failed (${res.status})`);
  }

  return payload;
}

export async function sendChatMessageForExport({
  query,
  sessionId,
  systemId,
  sapUser,
  availableSystems,
  cursor = null,
  limit = null,
  skip = null,
  fromDate = null,
  toDate = null,
}) {
  const message = String(query || "").trim();

  if (!message) {
    throw new Error("query is required");
  }

  const body = {
    query: message,
    sessionId: sessionId || null,
    systemId: systemId || null,
  };

  const su = String(sapUser || "").trim();
  if (su) {
    body.sapUser = su;
  }

  if (Array.isArray(availableSystems)) {
    body.availableSystems = availableSystems;
  }

  if (cursor) {
    body.cursor = cursor;
  }

  if (limit != null) {
    body.limit = limit;
  }

  if (skip != null) {
    body.skip = skip;
  }

  if (fromDate) {
    body.fromDate = fromDate;
  }

  if (toDate) {
    body.toDate = toDate;
  }

  const res = await authFetch(`${apiBase}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await readResponseBody(res);

  return {
    ok: res.ok,
    status: res.status,
    payload,
  };
}

export async function getPurchaseOrderDetails({ systemId, sapUser, purchaseOrderId, serviceName = null, entitySet = null }) {
  const res = await authFetch(`${apiBase}/chat/actions/s4hana/get-purchase-order-details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemId,
      sapUser,
      purchaseOrderId,
      serviceName,
      entitySet,
    }),
  });

  const payload = await readResponseBody(res);

  if (!res.ok || payload?.ok === false || payload?.status === "validation_failed" || payload?.status === "execution_failed") {
    throw new Error(payload?.error || payload?.message || "Failed to fetch purchase order details.");
  }

  return payload;
}

export async function listPurchaseOrders({ systemId, sapUser, pageSize = 5, cursor = null, serviceName = null, entitySet = null }) {
  const res = await authFetch(`${apiBase}/chat/actions/s4hana/list-purchase-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemId,
      sapUser,
      pageSize,
      cursor,
      serviceName,
      entitySet,
    }),
  });

  const payload = await readResponseBody(res);

  if (!res.ok || payload?.ok === false || payload?.status === "validation_failed" || payload?.status === "execution_failed") {
    throw new Error(payload?.error || payload?.message || "Failed to fetch purchase orders.");
  }

  return payload;
}

export async function getProcurementFlowDetailsByItem({
  systemId,
  sapUser,
  purchaseOrderId,
  purchaseOrderItem,
  query = "",
  businessScope = "",
  cursor = null,
  pendingAction = null,
  availableSystems = null,
  documentFlowIntent = "",
}) {
  const res = await authFetch(`${apiBase}/chat/actions/s4hana/get-procurement-flow-details-by-item`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemId,
      sapUser,
      purchaseOrderId,
      purchaseOrderItem,
      query,
      businessScope,
      cursor,
      pendingAction,
      availableSystems,
      documentFlowIntent,
    }),
  });

  const payload = await readResponseBody(res);

  if (!res.ok || payload?.ok === false || payload?.status === "validation_failed" || payload?.status === "execution_failed") {
    throw new Error(payload?.error || payload?.message || "Failed to fetch procurement flow details.");
  }

  return payload;
}

export async function getS4dPurchaseOrderDetails({ systemId, sapUser, poNumber }) {
  const cleanSystemId = String(systemId || "").trim();
  const cleanSapUser = String(sapUser || "").trim();
  const cleanPoNumber = String(poNumber || "").trim();

  const url = new URL(`${apiBase}/api/s4d/po/details/${encodeURIComponent(cleanPoNumber)}`);

  if (cleanSystemId) url.searchParams.set("systemId", cleanSystemId);
  if (cleanSapUser) url.searchParams.set("sapUser", cleanSapUser);

  const res = await authFetch(url.toString(), { method: "GET" });
  const payload = await readResponseBody(res);

  if (!res.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || "Failed to fetch purchase order details.");
  }

  return payload;
}

export async function getPendingPurchaseOrders({
  systemId,
  sapUser,
  dateFrom,
  dateTo,
  poNo = "",
  pageSize = 30,
  cursor = null,
}) {
  const res = await authFetch(`${apiBase}/chat/actions/s4hana/get-pending-purchase-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemId,
      sapUser,
      dateFrom,
      dateTo,
      poNo,
      pageSize,
      cursor,
    }),
  });

  const payload = await readResponseBody(res);

  if (!res.ok || payload?.ok === false || payload?.status === "validation_failed" || payload?.status === "execution_failed") {
    throw new Error(payload?.error || payload?.message || "Unable to retrieve pending purchase orders. Please try again.");
  }

  return payload;
}

export async function getPendingPurchaseOrderItems({
  systemId,
  sapUser,
  poNo,
  dateFrom,
  dateTo,
}) {
  const res = await authFetch(`${apiBase}/chat/actions/s4hana/get-pending-purchase-order-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemId,
      sapUser,
      poNo,
      dateFrom,
      dateTo,
    }),
  });

  const payload = await readResponseBody(res);

  if (!res.ok || payload?.ok === false || payload?.status === "validation_failed" || payload?.status === "execution_failed") {
    throw new Error(payload?.error || payload?.message || "Unable to load items for this PO. Please try again.");
  }

  return payload;
}