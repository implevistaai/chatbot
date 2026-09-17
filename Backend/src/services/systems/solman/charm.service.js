import { postToSap } from "../../sap/sapWrite.service.js";
import { fetchFromSap } from "../../sap.service.js";
import { SapServiceMap } from "../../../models/SapServiceMap.model.js";
import { SapServiceCatalog } from "../../../models/SapServiceCatalog.model.js";
import { verifyEntitySetInMetadata } from "../../allowlist.service.js";
import { inferDateRangeFromQuery as inferSolmanDateRangeFromQuery } from "../../../controllers/stream/solman/solman.shared.js";

function cleanString(v) {
  return String(v || "").trim();
}

function getDeploymentOwner(baseOwner = "local") {
  const scope = String(process.env.MONGODB_DB_NAME || process.env.APP_NAMESPACE || "").trim();
  return scope ? `${baseOwner}:${scope}` : baseOwner;
}

function escapeODataString(value) {
  return cleanString(value).replace(/'/g, "''");
}

function findFirstNonEmptyValue(source, keys) {
  if (!source || typeof source !== "object") return "";

  for (const key of keys) {
    const value = cleanString(source?.[key]);
    if (value) return value;
  }

  for (const value of Object.values(source)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findFirstNonEmptyValue(item, keys);
        if (nested) return nested;
      }
      continue;
    }

    if (value && typeof value === "object") {
      const nested = findFirstNonEmptyValue(value, keys);
      if (nested) return nested;
    }
  }

  return "";
}

function extractCrNumberFromText(value) {
  const text = cleanString(value);
  if (!text) return "";

  const patterns = [
    /\bCR\s*[:#-]?\s*(\d{6,})\b/i,
    /\bChange\s*Request\s*[:#-]?\s*(\d{6,})\b/i,
    /\bCR(?:\s+Number)?\s*[:#-]?\s*(\d{6,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanString(match[1]);
  }

  return "";
}

function normalizeUrlNav(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((x) => ({
      URL: cleanString(x?.URL),
      URL_NAME: cleanString(x?.URL_NAME),
    }))
    .filter((x) => x.URL && x.URL_NAME);
}

function buildCreatePayload(payload = {}) {
  const urlNav = normalizeUrlNav(
    Array.isArray(payload?.REQ_URL_NAV)
      ? payload.REQ_URL_NAV
      : Array.isArray(payload?.reqUrlNav)
        ? payload.reqUrlNav
        : []
  );

  return {
    ShortDesc: cleanString(payload?.ShortDesc || payload?.shortDesc),
    DeliveryResponsible: cleanString(payload?.DeliveryResponsible || payload?.deliveryResponsible),
    Developer: cleanString(payload?.Developer || payload?.developer),
    Tester: cleanString(payload?.Tester || payload?.tester),
    WorkItemReference: cleanString(payload?.WorkItemReference || payload?.workItemReference),
    Landscape: cleanString(payload?.Landscape || payload?.landscape),
    REQ_URL_NAV: urlNav,
  };
}

function normalizeCreateResponse(raw) {
  const rows = Array.isArray(raw?.d?.results) ? raw.d.results : [];
  const first = rows[0] || raw?.d || raw?.result || raw || {};
  const messageText =
    cleanString(first?.EMsgDesc || first?.EMSGDESC || first?.MESSAGE || first?.Message || first?.EV_MESSAGE || first?.EvMessage) ||
    cleanString(first?.message || first?.msg || first?.MSG) ||
    "Change request created successfully.";
  const changeRequestId =
    findFirstNonEmptyValue(raw, [
      "ESolmanCr",
      "ESOLMANCR",
      "ESOLMAN_CR",
      "ESOLMAN_CR_NO",
      "CHANGE_REQUEST_ID",
      "ChangeRequestId",
      "CR_NUMBER",
      "CR_NO",
      "CR_NUMBER_NEW",
      "CR_NO_NEW",
      "CR",
      "OBJECT_ID",
      "OBJ_ID",
      "changeRequestId",
      "change_request_id",
      "crNumber",
      "cr_number",
      "crNo",
      "cr_no",
    ]) ||
    findFirstNonEmptyValue(first, [
      "ESolmanCr",
      "ESOLMANCR",
      "ESOLMAN_CR",
      "ESOLMAN_CR_NO",
      "CHANGE_REQUEST_ID",
      "ChangeRequestId",
      "CR_NUMBER",
      "CR_NO",
      "CR",
      "OBJECT_ID",
      "OBJ_ID",
      "changeRequestId",
      "change_request_id",
      "crNumber",
      "cr_number",
      "crNo",
      "cr_no",
    ]) ||
    extractCrNumberFromText(first?.EMsgDesc || first?.EMSGDESC || messageText) ||
    extractCrNumberFromText(messageText);
  const msgType = cleanString(first?.MSG_TYPE || first?.MsgType || first?.TYPE || first?.EMsgType || first?.EMSGTYPE);
  const eMsgType = cleanString(first?.EMsgType || first?.EMSGTYPE || first?.MSG_TYPE || first?.MsgType || first?.TYPE);
  const eSolmanCr = cleanString(first?.ESolmanCr || first?.ESOLMANCR || first?.ESOLMAN_CR || changeRequestId);

  return {
    ok: true,
    message: messageText,
    result: {
      changeRequestId,
      status: cleanString(first?.STATUS || first?.Status || first?.STATE),
      msgType,
      EMsgType: eMsgType,
      EMsgDesc: cleanString(first?.EMsgDesc || first?.EMSGDESC || messageText),
      ESolmanCr: eSolmanCr,
      raw,
    },
  };
}

function mapSapCreateError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = cleanString(
    error?.message ||
      error?.response?.data?.error?.message?.value ||
      error?.response?.data?.error?.message ||
      error?.response?.data?.message
  );

  if (status === 400 && /missing required fields/i.test(message)) {
    const e = new Error(message || "Missing required fields.");
    e.status = 400;
    e.code = "VALIDATION_FAILED";
    e.userMessage = e.message;
    throw e;
  }

  if (status === 401 || status === 403) {
    const e = new Error(message || "Not authorized to create the change request.");
    e.status = status;
    e.code = "SAP_AUTH_FAILED";
    e.userMessage = e.message;
    throw e;
  }

  throw error;
}


function normalizeCrDetailsResponse(raw) {
  const results = Array.isArray(raw?.d?.results) ? raw.d.results : [];
  return results;
}

function validatePayload(payload) {
  const required = [
    "ShortDesc",
    "DeliveryResponsible",
    "Developer",
    "Tester",
    "WorkItemReference",
    "Landscape",
  ];

  const missing = required.filter((key) => !cleanString(payload?.[key]));

  const urlNav = Array.isArray(payload?.REQ_URL_NAV) ? payload.REQ_URL_NAV : [];
  const hasAnyUrlInput = urlNav.some((item) => cleanString(item?.URL) || cleanString(item?.URL_NAME));

  if (hasAnyUrlInput) {
    const firstUrl = urlNav[0] || {};
    if (!cleanString(firstUrl?.URL)) missing.push("REQ_URL_NAV.URL");
    if (!cleanString(firstUrl?.URL_NAME)) missing.push("REQ_URL_NAV.URL_NAME");
  }

  if (missing.length > 0) {
    const err = new Error(`Missing required fields: ${missing.join(", ")}`);
    err.status = 400;
    err.code = "VALIDATION_FAILED";
    throw err;
  }
}

function formatSapYmd(date) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(x, diff);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function monthNameToIndex(name) {
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  return months[String(name || "").toLowerCase()] ?? -1;
}

function parseUserDate(input) {
  const s = cleanString(input);
  if (!s) return null;

  let m = /^(\d{4})[./-](\d{2})[./-](\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+|,\s*)(\d{4})$/i.exec(s);
  if (m) {
    const monthIndex = monthNameToIndex(m[2]);
    if (monthIndex >= 0) {
      return new Date(Number(m[3]), monthIndex, Number(m[1]));
    }
  }
  m = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const monthIndex = monthNameToIndex(m[1]);
    if (monthIndex >= 0) {
      return new Date(Number(m[3]), monthIndex, Number(m[2]));
    }
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : native;
}

function resolveCrDateRange({ fromDate, toDate, dateText }) {
  if (cleanString(fromDate) && cleanString(toDate)) {
    const from = parseUserDate(fromDate);
    const to = parseUserDate(toDate);
    if (from && to) {
      const start = startOfDay(from) <= startOfDay(to) ? from : to;
      const end = startOfDay(from) <= startOfDay(to) ? to : from;

      return {
        from: formatSapYmd(startOfDay(start)),
        to: formatSapYmd(startOfDay(end)),
        source: "explicit",
      };
    }

    return {
      from: cleanString(fromDate),
      to: cleanString(toDate),
      source: "explicit",
    };
  }

  const inferred = inferSolmanDateRangeFromQuery(cleanString(dateText));
  if (inferred?.fromDate && inferred?.toDate) {
    return {
      from: inferred.fromDate,
      to: inferred.toDate,
      source: inferred.period || inferred.granularity || "inferred",
    };
  }

  return null;
}

function getDefaultCrRange(now = new Date(), days = 730) {
  const today = startOfDay(now);
  const from = addDays(today, -(days - 1));
  return {
    from: formatSapYmd(from),
    to: formatSapYmd(today),
    source: `default_last_${days}_days`,
  };
}

function resolveSolmanCrEntitySet() {
  return String(process.env.DEFAULT_SOLMAN_CR_ENTITYSET || "ZEX_OutputSet").trim() || "ZEX_OutputSet";
}

function buildCrDetailLookupFilters({ objectId, processType }) {
  const cleanObjectId = cleanString(objectId);
  const cleanProcessType = cleanString(processType);
  const filters = [];
  const push = (filter) => {
    if (filter) filters.push(filter);
  };

  push(`OBJECT_ID eq '${escapeODataString(cleanObjectId)}'`);
  push(`OBJ_ID eq '${escapeODataString(cleanObjectId)}'`);
  push(`ChangeRequestId eq '${escapeODataString(cleanObjectId)}'`);
  push(`ZchangeRequest eq '${escapeODataString(cleanObjectId)}'`);

  if (cleanProcessType) {
    push(`OBJECT_ID eq '${escapeODataString(cleanObjectId)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`);
    push(`OBJ_ID eq '${escapeODataString(cleanObjectId)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`);
    push(`ChangeRequestId eq '${escapeODataString(cleanObjectId)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`);
    push(`ZchangeRequest eq '${escapeODataString(cleanObjectId)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`);
  }

  return [...new Set(filters)];
}
function isTransientSapNetworkError(err) {
  const code = String(err?.code || err?.cause?.code || "").toUpperCase();
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNABORTED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ECONNREFUSED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ].includes(code);
}

export async function resolveSolmanDataServiceMapping({ owner, systemId }) {
  const sid = cleanString(systemId).toUpperCase();
  const deploymentOwner = getDeploymentOwner("local");
  const ownerCandidates = Array.from(
    new Set([cleanString(owner), "local", deploymentOwner].map((value) => cleanString(value)).filter(Boolean))
  );
  const activeCatalogEntries = await SapServiceCatalog.find({
    systemId: sid,
    isActive: true,
    owner: { $in: ownerCandidates },
  })
    .sort({ updatedAt: -1 })
    .lean();

  const activeCatalogEntry = activeCatalogEntries.find((entry) => {
    const searchText = [
      entry?.serviceName,
      entry?.entitySet,
      entry?.entityTypeName,
      entry?.labelsText,
      Array.isArray(entry?.domainHints) ? entry.domainHints.join(" ") : "",
      Array.isArray(entry?.keys) ? entry.keys.join(" ") : "",
      Array.isArray(entry?.fields)
        ? entry.fields.map((field) => `${field?.name || ""} ${field?.label || ""}`).join(" ")
        : "",
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    return /\b(zcr|zchange|charm|change request|change request.*status|cr)\b/i.test(searchText);
  }) || null;

  const catalogServiceName = cleanString(activeCatalogEntry?.serviceName);
  if (catalogServiceName) {
    console.log("[SOLMAN] using active catalog CR service name:", {
      owner,
      systemId: sid,
      serviceName: catalogServiceName,
      entitySet: cleanString(activeCatalogEntry?.entitySet),
      entityTypeName: cleanString(activeCatalogEntry?.entityTypeName),
    });
    return {
      serviceName: catalogServiceName,
      entitySetName: cleanString(activeCatalogEntry?.entitySet) || resolveSolmanCrEntitySet(),
    };
  }

  const systemConfigured = cleanString(process.env[`DEFAULT_SOLMAN_CR_SERVICE_NAME_${sid}`] || "");
  const serviceMaps = await SapServiceMap.find({ owner: { $in: [owner, "local"] }, systemId: sid })
    .sort({ updatedAt: -1 })
    .lean();

  const fallbackCandidate =
    serviceMaps.find((service) => /\b(zcr|zchange|charm|cr)\b/i.test(cleanString(service?.serviceName))) || null;

  const mappedServiceName = cleanString(fallbackCandidate?.serviceName);
  if (mappedServiceName) {
    console.log("[SOLMAN] using catalog fallback service name:", {
      owner,
      systemId: sid,
      serviceName: mappedServiceName,
      entitySet: cleanString(fallbackCandidate?.entitySet),
      entityTypeName: cleanString(fallbackCandidate?.entityTypeName),
    });
    return {
      serviceName: mappedServiceName,
      entitySetName: cleanString(fallbackCandidate?.entitySet) || resolveSolmanCrEntitySet(),
    };
  }

  if (systemConfigured) {
    console.log("[SOLMAN] using system-specific configured CR service name:", {
      owner,
      systemId: sid,
      serviceName: systemConfigured,
    });
    return {
      serviceName: systemConfigured,
      entitySetName: resolveSolmanCrEntitySet(),
    };
  }

  const configured = cleanString(process.env.DEFAULT_SOLMAN_CR_SERVICE_NAME || "ZCR_DETAILS_SRV");

  if (configured) {
    console.log("[SOLMAN] using configured CR service name:", {
      owner,
      systemId: sid,
      serviceName: configured,
    });
    return {
      serviceName: configured,
      entitySetName: resolveSolmanCrEntitySet(),
    };
  }

  console.log("[SOLMAN] using legacy fallback service name:", { owner, systemId: sid, serviceName: "ZCR_DETAILS_SRV" });
  return {
    serviceName: "ZCR_DETAILS_SRV",
    entitySetName: resolveSolmanCrEntitySet(),
  };
}

async function preflightSolmanCrMetadata({ system, sapAuth, owner, serviceName, entitySetName }) {
  try {
    await verifyEntitySetInMetadata({
      system,
      service: { serviceName },
      entitySetName,
      authOverride: { username: sapAuth?.username || sapAuth?.sapUser || sapAuth?.user, password: sapAuth?.password },
      allowEnvFallback: false,
    });
    console.log("[SOLMAN] metadata preflight ok:", {
      owner,
      systemId: system?.systemId || null,
      serviceName,
      entitySetName,
    });
  } catch (err) {
    console.log("[SOLMAN] metadata preflight failed:", {
      owner,
      systemId: system?.systemId || null,
      serviceName,
      entitySetName,
      error: err?.message || String(err),
      code: err?.code || null,
    });

    const message = cleanString(err?.message || "");
    const serviceInactiveMessage =
      message === "OData service not found/active on this SAP system. Check service name and activation.";

    if (isTransientSapNetworkError(err) || serviceInactiveMessage) {
      console.log("[SOLMAN] metadata preflight skipped due to transient network error:", {
        owner,
        systemId: system?.systemId || null,
        serviceName,
        entitySetName,
        error: err?.message || String(err),
        code: err?.code || null,
      });
      return false;
    }

    throw err;
  }

  return true;
}

function normalizeStatusValue(value) {
  return cleanString(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeCreatedByValue(value) {
  return cleanString(value).toUpperCase();
}

function normalizeCreatedByComparable(value) {
  return normalizeCreatedByValue(value).replace(/[^A-Z0-9]/g, "");
}

function matchesRequestedStatus(item, requestedStatus) {
  const wanted = normalizeStatusValue(requestedStatus);
  if (!wanted) return true;

  const actual = normalizeStatusValue(item?.STATUS);

  if (actual === wanted) return true;

  const aliases = {
    approved: ["approved", "authorized", "authorized for import"],
    open: ["open", "new", "created"],
    closed: ["closed", "completed", "successfully tested"],
    rejected: ["rejected"],
    pending: ["pending"],
    "in progress": [
      "in progress",
      "under implementation",
      "implementation",
      "in process",
    ],
    "under implementation": [
      "under implementation",
      "in progress",
      "implementation",
    ],
    completed: ["completed", "closed", "successfully tested"],
    success: ["success", "successful", "successfully tested"],
  };

  const allowed = aliases[wanted] || [wanted];
  return allowed.includes(actual);
}

function matchesCreatedBy(item, requestedCreatedBy) {
  const wanted = normalizeCreatedByValue(requestedCreatedBy);
  if (!wanted) return true;

  const wantedComparable = normalizeCreatedByComparable(wanted);

  const actualCandidates = [
    item?.CREATED_BY,
    item?.ERNAM,
    item?.CREATEDBY,
    item?.CREATOR,
    item?.AUTHOR,
    item?.CREATEDBYNAME,
    item?.CREATED_BY_NAME,
    item?.USER_NAME,
    item?.USERNAME,
    item?.SAP_USER,
    item?.LAST_CHANGED_BY,
    "",
  ]
    .map((value) => normalizeCreatedByValue(value))
    .filter(Boolean);

  if (actualCandidates.length === 0 || !wantedComparable) {
    return false;
  }

  return actualCandidates.some((actual) => {
    if (actual === wanted) {
      return true;
    }

    const actualComparable = normalizeCreatedByComparable(actual);
    return (
      actualComparable === wantedComparable ||
      actualComparable.includes(wantedComparable) ||
      wantedComparable.includes(actualComparable)
    );
  });
}

function isExcludedStatus(item, excludeStatuses = []) {
  const actual = normalizeStatusValue(item?.STATUS);
  if (!actual || !Array.isArray(excludeStatuses) || excludeStatuses.length === 0) {
    return false;
  }

  return excludeStatuses
    .map((status) => normalizeStatusValue(status))
    .filter(Boolean)
    .includes(actual);
}

function buildCrListRelativePath({
  processType,
  triggerAll = "X",
  fromDate,
  toDate,
  status,
  createdBy,
  dateText,
  top,
  skip = 0,
  orderBy = "CREATED_ON desc",
}) {
  const cleanProcessType = cleanString(processType);
  const cleanTriggerAll = cleanString(triggerAll) || "X";
  const cleanStatus = cleanString(status);
  const cleanCreatedBy = normalizeCreatedByValue(createdBy);
  const cleanOrderBy = cleanString(orderBy) || "CREATED_ON desc";

  if (!cleanProcessType) {
    const err = new Error("processType is required.");
    err.status = 400;
    err.code = "VALIDATION_FAILED";
    throw err;
  }

  let resolved = resolveCrDateRange({ fromDate, toDate, dateText });
  let finalTop = Number(top) || null;
  let finalSkip = Math.max(0, Number(skip) || 0);

  if (!resolved) {
    resolved = getDefaultCrRange(new Date(), 730);
  }

  const parts = [
    `PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`,
    `TRIGGER_ALL eq '${escapeODataString(cleanTriggerAll)}'`,
  ];

  if (cleanStatus) {
    parts.push(`STATUS eq '${escapeODataString(cleanStatus)}'`);
  }

  if (resolved?.from && resolved?.to) {
    parts.push(`FROM_DATE eq '${escapeODataString(resolved.from)}'`);
    parts.push(`TO_DATE eq '${escapeODataString(resolved.to)}'`);
  }

  if (cleanCreatedBy) {
    parts.push(`CREATED_BY eq '${escapeODataString(cleanCreatedBy)}'`);
  }

  const params = [`$filter=${encodeURIComponent(parts.join(" and "))}`];

  if (cleanOrderBy) {
    params.push(`$orderby=${encodeURIComponent(cleanOrderBy)}`);
  }

  if (finalTop && Number.isFinite(finalTop) && finalTop > 0) {
    params.push(`$top=${finalTop}`);
  }

  if (finalSkip > 0) {
    params.push(`$skip=${finalSkip}`);
  }

  return {
    relativePath: `${resolveSolmanCrEntitySet()}?${params.join("&")}`,
    resolvedRange: resolved || null,
    top: finalTop,
    skip: finalSkip,
    orderBy: cleanOrderBy,
    createdBy: cleanCreatedBy,
  };
}

export async function createSolmanChangeRequest({ system, sapAuth, payload }) {
  validatePayload(payload);

  const body = buildCreatePayload(payload);

  try {
    const raw = await postToSap(
      {
        system,
        relativePath:
          "/sap/opu/odata/sap/ZCR_CREATION_CHARM_SRV/ZChange_requestSet",
        body,
      },
      sapAuth
    );

    return normalizeCreateResponse(raw);
  } catch (err) {
    mapSapCreateError(err);
  }
}

export async function getSolmanChangeRequestDetailsById({
  system,
  sapAuth,
  objectId,
  processType = "",
}) {
  const cleanObjectId = cleanString(objectId);
  const requestedProcessType = cleanString(processType);

  if (!cleanObjectId) {
    const err = new Error("objectId is required.");
    err.status = 400;
    err.code = "VALIDATION_FAILED";
    throw err;
  }

  const serviceMapping = await resolveSolmanDataServiceMapping({ owner: sapAuth?.owner || "local", systemId: system?.systemId });
  const serviceName = cleanString(serviceMapping?.serviceName) || "ZCR_DETAILS_SRV";
  const entitySetName = cleanString(serviceMapping?.entitySetName) || resolveSolmanCrEntitySet();

  await preflightSolmanCrMetadata({
    system,
    sapAuth,
    owner: sapAuth?.owner || "local",
    serviceName,
    entitySetName,
  });

  const processTypeCandidates = requestedProcessType
    ? [requestedProcessType]
    : ["YMHF", "YMH1"];

  let raw = null;
  let results = [];
  let usedProcessType = requestedProcessType || "";

  for (const candidateProcessType of processTypeCandidates) {
    const relativePath = `/sap/opu/odata/sap/${serviceName}/${entitySetName}?$filter=${encodeURIComponent(
      `OBJECT_ID eq '${escapeODataString(cleanObjectId)}' and PROCESS_TYPE eq '${escapeODataString(candidateProcessType)}'`
    )}`;

    raw = await fetchFromSap(
      {
        system,
        service: { serviceName },
        relativePath,
      },
      sapAuth
    );

    results = normalizeCrDetailsResponse(raw);
    usedProcessType = candidateProcessType;

    if (results.length > 0) {
      break;
    }
  }

  if (results.length === 0) {
    const relativePath = `/sap/opu/odata/sap/${serviceName}/${entitySetName}?$filter=${encodeURIComponent(
      `OBJECT_ID eq '${escapeODataString(cleanObjectId)}'`
    )}`;

    raw = await fetchFromSap(
      {
        system,
        service: { serviceName },
        relativePath,
      },
      sapAuth
    );

    results = normalizeCrDetailsResponse(raw);
    if (results[0]?.PROCESS_TYPE) {
      usedProcessType = cleanString(results[0].PROCESS_TYPE);
    }
  }

  return {
    ok: true,
    message:
      results.length > 0
        ? `Found ${results.length} change request record(s).`
        : `No details found for CR ${cleanObjectId}.`,
    result: {
      objectId: cleanObjectId,
      processType: usedProcessType,
      count: results.length,
      results,
      raw,
    },
  };
}

export async function listSolmanChangeRequestsByDateRange({
  system,
  sapAuth,
  processType,
  fromDate,
  toDate,
  triggerAll = "X",
  status = "",
  statusMode = "",
  excludeStatuses = [],
  createdBy = "",
  dateText = "",
  top = null,
  skip = 0,
  orderBy = "CREATED_ON desc",
}) {
  const cleanProcessType = cleanString(processType);
  const cleanStatus = cleanString(status);
  const cleanStatusMode = cleanString(statusMode);
  const cleanCreatedBy = normalizeCreatedByValue(createdBy);

  if (!cleanProcessType) {
    const err = new Error("processType is required.");
    err.status = 400;
    err.code = "VALIDATION_FAILED";
    throw err;
  }

  const built = buildCrListRelativePath({
    processType: cleanProcessType,
    triggerAll,
    fromDate,
    toDate,
    status: cleanStatusMode === "pending" ? "" : cleanStatus,
    createdBy: cleanCreatedBy,
    dateText,
    top,
    skip,
    orderBy,
  });

  const serviceMapping = await resolveSolmanDataServiceMapping({ owner: sapAuth?.owner || "local", systemId: system?.systemId });
  const serviceName = cleanString(serviceMapping?.serviceName) || "ZCR_DETAILS_SRV";
  const entitySetName = cleanString(serviceMapping?.entitySetName) || resolveSolmanCrEntitySet();

  await preflightSolmanCrMetadata({
    system,
    sapAuth,
    owner: sapAuth?.owner || "local",
    serviceName,
    entitySetName,
  });

  const raw = await fetchFromSap(
    {
      system,
      service: { serviceName },
      relativePath: built.relativePath,
    },
    sapAuth
  );

  let results = normalizeCrDetailsResponse(raw);

  if (cleanStatusMode === "pending") {
    results = results.filter((item) => !isExcludedStatus(item, excludeStatuses));
  } else if (cleanStatus) {
    results = results.filter((item) => matchesRequestedStatus(item, cleanStatus));
  }

  if (cleanCreatedBy) {
    results = results.filter((item) => matchesCreatedBy(item, cleanCreatedBy));
  }

  return {
    ok: true,
    message:
      results.length > 0
        ? `Found ${results.length} change request(s).`
        : "No records found for the given criteria.",
    result: {
      processType: cleanProcessType,
      triggerAll: cleanString(triggerAll) || "X",
      fromDate: built.resolvedRange?.from || cleanString(fromDate),
      toDate: built.resolvedRange?.to || cleanString(toDate),
      status: cleanStatus,
      statusMode: cleanStatusMode,
      createdBy: cleanCreatedBy,
      excludeStatuses: Array.isArray(excludeStatuses) ? excludeStatuses : [],
      top: built.top || top || null,
      skip: built.skip || 0,
      orderBy: built.orderBy,
      nextSkip:
        (built.skip || 0) +
        Math.max(
          0,
          Number.isFinite(Number(built.top || top)) ? Number(built.top || top) : results.length
        ),
      count: results.length,
      results,
      raw,
    },
  };
}
