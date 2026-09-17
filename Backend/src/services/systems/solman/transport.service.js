import { fetchFromSap } from "../../sap.service.js";
import { SapSystem } from "../../../models/SapSystem.model.js";
import { SapServiceCatalog } from "../../../models/SapServiceCatalog.model.js";

function cleanString(v) {
  return String(v || "").trim();
}

function safePreview(value, max = 300) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return "<unpreviewable>";
  }
}

function escapeODataString(value) {
  return cleanString(value).replace(/'/g, "''");
}

function asArray(raw) {
  if (Array.isArray(raw?.d?.results)) return raw.d.results;
  if (raw?.d) return [raw.d];
  return [];
}

function collectNavRows(item) {
  const navCandidates = [
    item?.message_nav,
    item?.transport_nav,
    item?.transportNav,
    item?.Trkorr_nav,
    item?.TRKORR_nav,
  ];

  const rows = [];

  for (const nav of navCandidates) {
    if (Array.isArray(nav?.results)) {
      rows.push(...nav.results);
    } else if (Array.isArray(nav)) {
      rows.push(...nav);
    }
  }

  return rows;
}

function unique(values = []) {
  return [...new Set(values.map((x) => cleanString(x)).filter(Boolean))];
}

function pickString(item, keys = []) {
  for (const key of Array.isArray(keys) ? keys : []) {
    const value = cleanString(item?.[key]);
    if (value) return value;
  }
  return "";
}

function rowMatchesCr(item, changeRequestId) {
  const cleanCr = cleanString(changeRequestId);
  if (!cleanCr) return false;

  const candidates = [
    item?.ChangeRequestId,
    item?.CHANGE_REQUEST_ID,
    item?.ZchangeRequest,
    item?.ZCHANGE_REQUEST,
    item?.OBJECT_ID,
    item?.OBJ_ID,
  ]
    .map((value) => cleanString(value))
    .filter(Boolean);

  return candidates.some((value) => value === cleanCr || value.includes(cleanCr) || cleanCr.includes(value));
}

function normalizeTransportsFromCr(raw, { changeRequestId = "" } = {}) {
  const rootRows = asArray(raw);
  const rows = [
    ...rootRows,
    ...rootRows.flatMap((item) => collectNavRows(item)),
  ];

  const crRows = cleanString(changeRequestId)
    ? rows.filter((item) => rowMatchesCr(item, changeRequestId))
    : rows;
  const effectiveRows = crRows.length > 0 ? crRows : rows;

  const transports = unique(
    effectiveRows.flatMap((item) => [
      pickString(item, ["Trkorr", "TRKORR", "Transport", "TRANSPORT", "TransportNo", "TRANSPORT_NO"]),
    ])
  );

  const normalizedChangeRequestId =
    pickString(effectiveRows[0], [
      "ZchangeRequest",
      "ZCHANGE_REQUEST",
      "ChangeRequestId",
      "CHANGE_REQUEST_ID",
      "ChangeRequest",
      "CHANGE_REQUEST",
      "OBJECT_ID",
      "OBJ_ID",
    ]);

  const normalizedRows = effectiveRows.map((item) => ({
    raw: item,
    _raw: item,
    ChangeRequestId: pickString(item, ["ChangeRequestId", "CHANGE_REQUEST_ID", "ZchangeRequest", "ZCHANGE_REQUEST", "ChangeRequest", "CHANGE_REQUEST"]),
    Trkorr: pickString(item, ["Trkorr", "TRKORR", "Transport", "TRANSPORT", "TransportNo", "TRANSPORT_NO"]),
    Trfunction: pickString(item, ["Trfunction", "TRFUNCTION", "TransportType", "TRANSPORT_TYPE", "TRFUNCTION_CODE"]),
    TrfuncDescription: pickString(item, ["TrfuncDescription", "TRFUNC_DESCRIPTION", "TrfunctionText", "TRFUNCTION_TEXT", "TransportTypeText", "TRANSPORT_TYPE_TEXT"]),
    ZchangeRequest: pickString(item, ["ZchangeRequest", "ZCHANGE_REQUEST", "ChangeRequestId", "CHANGE_REQUEST_ID", "ChangeRequest", "CHANGE_REQUEST"]),
    DevCreatedDate: pickString(item, ["DevCreatedDate", "DEV_CREATED_DATE", "CreatedDate", "CREATED_DATE", "CRTD_DATE"]),
    DevCreatedTime: pickString(item, ["DevCreatedTime", "DEV_CREATED_TIME", "CreatedTime", "CREATED_TIME", "CRTD_TIME"]),
    DevReleasedDate: pickString(item, ["DevReleasedDate", "DEV_RELEASED_DATE", "ReleasedDate", "RELEASED_DATE", "REL_DATE"]),
    DevReleasedTime: pickString(item, ["DevReleasedTime", "DEV_RELEASED_TIME", "ReleasedTime", "RELEASED_TIME", "REL_TIME"]),
    Desc: pickString(item, ["Desc", "DESC", "Description", "DESCRIPTION", "ShortText", "SHORT_TEXT"]),
    Owner: pickString(item, ["Owner", "OWNER", "CreatedBy", "CREATED_BY", "User", "USERNAME", "AS4USER"]),
    TaskExdate: pickString(item, ["TaskExdate", "TASK_EXDATE", "TaskExitDate", "TASK_EXIT_DATE", "TaskReleasedDate", "TASK_RELEASED_DATE"]),
    TaskExtime: pickString(item, ["TaskExtime", "TASK_EXTIME", "TaskExitTime", "TASK_EXIT_TIME", "TaskReleasedTime", "TASK_RELEASED_TIME"]),
    Hgq: pickString(item, ["Hgq", "HGQ"]),
    DateQua: pickString(item, ["DateQua", "DATE_QUA"]),
    Hgd: pickString(item, ["Hgd", "HGD"]),
    Hep: pickString(item, ["Hep", "HEP"]),
    DatePrd: pickString(item, ["DatePrd", "DATE_PRD"]),
    Hdv: pickString(item, ["Hdv", "HDV"]),
    Hqa: pickString(item, ["Hqa", "HQA"]),
    Hdp: pickString(item, ["Hdp", "HDP"]),
    Tasks: pickString(item, ["Tasks", "TASKS", "Task", "TASK"]),
    TaskOwner: pickString(item, ["TaskOwner", "TASK_OWNER", "Owner", "OWNER", "AS4USER"]),
    TaskFunc: pickString(item, ["TaskFunc", "TASK_FUNC"]),
    TaskFuncDescription: pickString(item, ["TaskFuncDescription", "TASK_FUNC_DESCRIPTION", "TaskFuncText", "TASK_FUNC_TEXT"]),
    Message: pickString(item, ["Message", "MESSAGE", "EV_MESSAGE", "EvMessage"]),
  }));

  return {
    changeRequestId: normalizedChangeRequestId,
    transports,
    rows: normalizedRows,
  };
}

function normalizeDependencyRows(raw) {
  const rootRows = asArray(raw);

  const dependencyMessage =
    cleanString(rootRows[0]?.EV_MESSAGE) ||
    cleanString(rootRows[0]?.EvMessage) ||
    "";

  const detailRows = rootRows.flatMap((row) => {
    const nav = row?.message_nav;
    if (Array.isArray(nav?.results)) return nav.results;
    if (Array.isArray(nav)) return nav;
    return [];
  });

  const dependencies = detailRows
    .map((item) => ({
      transportEntered: cleanString(item?.TRANSPORT_ENTERED),
      dependentTransport: cleanString(item?.TRKORR),
      description: cleanString(item?.DESCRIPTION),
      status: cleanString(item?.TRSTATUS),
      owner: cleanString(item?.OWNER),
      exportDate: cleanString(item?.EXPORT_DATE),
      exportTime: cleanString(item?.EXPORT_TIME),
      importDate: cleanString(item?.IMPORT_DATE),
      importTime: cleanString(item?.IMPORT_TIME),
    }))
    .filter((item) => item.transportEntered)
    .filter((item) => item.dependentTransport)
    .filter((item) => item.dependentTransport.toLowerCase() !== "request");

  return {
    dependencyMessage,
    dependencies,
    rawRows: rootRows,
    detailRows,
  };
}

function extractTransportNumbersFromCrRows(rows = []) {
  const transports = [];

  for (const item of Array.isArray(rows) ? rows : []) {
    const transport = cleanString(
      item?.Trkorr ||
        item?.TRKORR ||
        item?.Transport ||
        item?.TRANSPORT ||
        item?.TransportNo ||
        item?.TRANSPORT_NO
    );

    if (transport) transports.push(transport);
  }

  return unique(transports);
}

function isSapServiceNotFoundError(error, serviceName) {
  const msg = cleanString(error?.message).toLowerCase();
  const targetService = cleanString(serviceName).toLowerCase();

  return (
    msg.includes("no service found") &&
    (!targetService || msg.includes(targetService))
  );
}

function mapSapServiceError(error, { serviceName }) {
  if (isSapServiceNotFoundError(error, serviceName)) {
    const e = new Error("SAP service is not available on this system.");
    e.status = 400;
    e.code = "SAP_SERVICE_NOT_AVAILABLE";
    e.userMessage = e.message;
    throw e;
  }

  throw error;
}

async function resolveCrProcessType({ system, sapAuth, changeRequestId }) {
  const cleanCr = cleanString(changeRequestId);
  if (!cleanCr) return "";

  const serviceMapping = await resolveSolmanCrCatalog({
    owner: sapAuth?.owner || "local",
    systemId: system?.systemId,
    serviceName: resolveCrDetailsServiceName(),
  });
  const serviceName = cleanString(serviceMapping?.serviceName) || resolveCrDetailsServiceName();
  const entitySetName = cleanString(serviceMapping?.entitySetName) || resolveTransportFallbackEntitySet(serviceName);

  try {
    const relativePath = `/sap/opu/odata/sap/${serviceName}/${entitySetName}?$filter=${encodeURIComponent(
      `OBJECT_ID eq '${escapeODataString(cleanCr)}'`
    )}`;

    const raw = await fetchFromSap(
      {
        system,
        service: { serviceName },
        relativePath,
      },
      sapAuth
    );

    const rows = Array.isArray(raw?.d?.results) ? raw.d.results : [];
    return cleanString(rows[0]?.PROCESS_TYPE);
  } catch {
    return "";
  }
}

function buildCrTransportLookupVariants({ changeRequestId, processType }) {
  const cleanCr = cleanString(changeRequestId);
  const cleanProcessType = cleanString(processType);

  const variants = [];
  const push = (filter) => {
    if (filter) variants.push(filter);
  };

  push(`ChangeRequestId eq '${escapeODataString(cleanCr)}'`);

  if (cleanProcessType) {
    push(
      `ChangeRequestId eq '${escapeODataString(cleanCr)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`
    );
  }

  push(`ZchangeRequest eq '${escapeODataString(cleanCr)}'`);
  if (cleanProcessType) {
    push(
      `ZchangeRequest eq '${escapeODataString(cleanCr)}' and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`
    );
  }

  return [...new Set(variants)];
}

function buildCrTransportAllRowsVariants() {
  return ["", "$top=500"];
}

function resolveCrDetailsServiceName() {
  return String(process.env.DEFAULT_SOLMAN_CR_DETAILS_SERVICE_NAME || "ZNEW_TRS_FROM_CR_SRV").trim() || "ZNEW_TRS_FROM_CR_SRV";
}

function resolveDependentTransportsServiceName() {
  return String(process.env.DEFAULT_SOLMAN_DEPENDENT_TRANSPORTS_SERVICE_NAME || "ZNEW_TRS_FROM_CR_SRV").trim() || "ZNEW_TRS_FROM_CR_SRV";
}

async function resolveSolmanCrCatalog({ owner, systemId, serviceName = "" }) {
  const sid = cleanString(systemId).toUpperCase();
  const deploymentOwner = cleanString(owner || "local");

  const query = {
    owner: { $in: [deploymentOwner, "local"] },
    isActive: true,
  };

  if (sid) {
    query.systemId = sid;
  }

  const activeCatalogEntries = await SapServiceCatalog.find(query)
    .sort({ updatedAt: -1 })
    .lean();

  const activeCatalogEntry = activeCatalogEntries.find((entry) => {
    if (serviceName && cleanString(entry?.serviceName).toUpperCase() !== cleanString(serviceName).toUpperCase()) {
      return false;
    }

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

  return activeCatalogEntry;
}

function isSolmanCrServiceName(serviceName) {
  const normalized = cleanString(serviceName).toUpperCase();
  return normalized === "ZCR_DETAILS_SRV" || normalized === "ZNEW_TRS_FROM_CR_SRV";
}

async function resolveSolmanSystem(system, serviceName) {
  const incomingSystemId = cleanString(system?.systemId || system?.id || system?.code).toUpperCase();
  const incomingOwner = cleanString(system?.owner || "local") || "local";

  console.log("[SOLMAN][SYSTEM_RESOLVER] incoming SAP system:", {
    systemId: incomingSystemId || null,
    host: cleanString(system?.host) || null,
    port: cleanString(system?.port) || null,
    serviceName: cleanString(serviceName) || null,
  });

  if (!isSolmanCrServiceName(serviceName)) {
    return system;
  }

  const catalogEntry = await resolveSolmanCrCatalog({
    owner: incomingOwner,
    systemId: incomingSystemId,
    serviceName: cleanString(serviceName),
  });

  const mappedSystemId = cleanString(catalogEntry?.systemId).toUpperCase();
  const targetSystemId = incomingSystemId || mappedSystemId;

  const query = {
    owner: { $in: [incomingOwner, "local"] },
    systemId: targetSystemId,
  };

  console.log("[SOLMAN][SYSTEM_RESOLVER] Searching serverdb.sapsystems...");
  console.log("[SOLMAN][SYSTEM_RESOLVER] Mongo query:", query);

  const solmanSystem = await SapSystem.findOne(query).lean();

  console.log("[SOLMAN][SYSTEM_RESOLVER] Mongo result:", solmanSystem || null);

  if (!solmanSystem) {
    const err = new Error("SAP system mapping not found.");
    err.status = 404;
    err.code = "SAP_SYSTEM_MAPPING_NOT_FOUND";
    throw err;
  }

  console.log("[SOLMAN][SYSTEM_RESOLVER] Selected Mongo document:", {
    databaseSystemId: cleanString(solmanSystem.systemId).toUpperCase() || null,
    databaseHost: cleanString(solmanSystem.host) || null,
    databasePort: cleanString(solmanSystem.port) || null,
  });

  return solmanSystem;
}

function resolveCrEntitySet() {
  return String(process.env.DEFAULT_SOLMAN_CR_ENTITYSET || "CR_DetailsSet").trim() || "CR_DetailsSet";
}

function resolveTransportFallbackEntitySet(serviceName) {
  const normalized = cleanString(serviceName).toUpperCase();

  if (normalized === "ZNEW_TRS_FROM_CR_SRV") {
    return String(process.env.DEFAULT_SOLMAN_DEPENDENT_TRANSPORTS_ENTITYSET || "CR_DetailsSet").trim() || "CR_DetailsSet";
  }

  return resolveCrEntitySet();
}

function buildCrTransportLookupFallbackVariants({ changeRequestId, processType }) {
  const cleanCr = cleanString(changeRequestId);
  const cleanProcessType = cleanString(processType);

  if (!cleanCr) return [];

  const variants = [];
  const push = (filter) => {
    if (filter) variants.push(filter);
  };

  push(`substringof('${escapeODataString(cleanCr)}', ChangeRequestId)`);
  push(`substringof('${escapeODataString(cleanCr)}', ZchangeRequest)`);

  if (cleanProcessType) {
    push(
      `substringof('${escapeODataString(cleanCr)}', ChangeRequestId) and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`
    );
    push(
      `substringof('${escapeODataString(cleanCr)}', ZchangeRequest) and PROCESS_TYPE eq '${escapeODataString(cleanProcessType)}'`
    );
  }

  return [...new Set(variants)];
}

export async function getTransportNumbersFromCr({
  system,
  sapAuth,
  changeRequestId,
  processType = "",
}) {
  const cleanCr = cleanString(changeRequestId);
  const explicitProcessType = cleanString(processType);

  if (!cleanCr) {
    const err = new Error("changeRequestId is required.");
    err.status = 400;
    err.code = "VALIDATION_FAILED";
    throw err;
  }

  const resolvedSystem = await resolveSolmanSystem(system, resolveCrDetailsServiceName());
  const catalogEntry = await resolveSolmanCrCatalog({
    owner: resolvedSystem?.owner || system?.owner || "local",
    systemId: resolvedSystem?.systemId || system?.systemId || "",
    serviceName: resolveCrDetailsServiceName(),
  });

  const resolvedProcessType = explicitProcessType || (await resolveCrProcessType({
    system: resolvedSystem,
    sapAuth,
    changeRequestId: cleanCr,
  }));

  const serviceName = cleanString(catalogEntry?.serviceName) || resolveCrDetailsServiceName();

  const variants = buildCrTransportLookupVariants({
    changeRequestId: cleanCr,
    processType: resolvedProcessType,
  });
  const entitySetName = cleanString(catalogEntry?.entitySet) || resolveTransportFallbackEntitySet(serviceName);

  console.log("[SOLMAN][DEPENDENT] CR Number received:", cleanCr);
  console.log("[SOLMAN][DEPENDENT] First API service:", serviceName);
  console.log("[SOLMAN][DEPENDENT] First API entity set:", entitySetName);
  console.log("[SOLMAN][DEPENDENT] Catalog selection:", {
    serviceName,
    entitySet: entitySetName,
    entityTypeName: cleanString(catalogEntry?.entityTypeName) || null,
  });

  let raw = null;
  let lastError = null;
  let normalized = null;

  for (const filter of variants) {
    const relativePath = `${entitySetName}?$filter=${encodeURIComponent(filter)}`;

    try {
      raw = await fetchFromSap(
        {
          system: resolvedSystem,
          service: { serviceName },
          relativePath,
          requestMeta: {
            feature: "solman",
            serviceName,
            requestedSystemId: cleanString(system?.systemId || system?.id || system?.code).toUpperCase() || null,
            mappedSystemId: cleanString(resolvedSystem?.systemId).toUpperCase() || null,
          },
        },
        sapAuth
      );

      console.log("[SOLMAN][DEPENDENT] First API URL path:", relativePath);
      console.log("[SOLMAN][DEPENDENT] First API full response:", JSON.stringify(raw));

      const rowsForLogging = Array.isArray(raw?.d?.results) ? raw.d.results : raw?.d ? [raw.d] : [];
      console.log("[SOLMAN][DEPENDENT] First API record count:", rowsForLogging.length);
      rowsForLogging.forEach((item, index) => {
        console.log("[SOLMAN][DEPENDENT] First API record property names:", {
          index,
          properties: item && typeof item === "object" ? Object.keys(item) : [],
        });
      });

      normalized = normalizeTransportsFromCr(raw, { changeRequestId: cleanCr });
      console.log("[SOLMAN][DEPENDENT] First API normalized rows:", normalized.rows.length);
      console.log("[SOLMAN][DEPENDENT] Transport field selected from normalized rows:", normalized.rows.map((item) => item.Trkorr).filter(Boolean));
      if (normalized.transports.length > 0 || normalized.rows.length > 0) break;
    } catch (error) {
      lastError = error;
      const msg = cleanString(error?.message).toLowerCase();
      if (
        error?.status === 501 ||
        msg.includes("no service found") ||
        msg.includes("not implemented in data provider class")
      ) {
        mapSapServiceError(error, {
            serviceName,
        });
      }

      if (error?.status === 401 || msg.includes("logon error") || msg.includes("authentication")) {
        throw error;
      }
    }
  }

  if (!normalized || (normalized.transports.length === 0 && normalized.rows.length === 0)) {
    const fallbackVariants = buildCrTransportLookupFallbackVariants({
      changeRequestId: cleanCr,
      processType: resolvedProcessType,
    });

    for (const filter of fallbackVariants) {
      const relativePath = `${entitySetName}?$filter=${encodeURIComponent(filter)}`;

      try {
        raw = await fetchFromSap(
          {
          system: resolvedSystem,
            service: { serviceName },
            relativePath,
          requestMeta: {
            feature: "solman",
            serviceName,
            requestedSystemId: cleanString(system?.systemId || system?.id || system?.code).toUpperCase() || null,
            mappedSystemId: cleanString(resolvedSystem?.systemId).toUpperCase() || null,
          },
          },
          sapAuth
        );

        normalized = normalizeTransportsFromCr(raw, { changeRequestId: cleanCr });
        if (normalized.transports.length > 0 || normalized.rows.length > 0) break;
      } catch (error) {
        lastError = error;
        const msg = cleanString(error?.message).toLowerCase();
        if (
          error?.status === 501 ||
          msg.includes("no service found") ||
          msg.includes("not implemented in data provider class")
        ) {
          mapSapServiceError(error, {
              serviceName,
          });
        }

        if (error?.status === 401 || msg.includes("logon error") || msg.includes("authentication")) {
          throw error;
        }
      }
    }
  }

  if (!normalized || (normalized.transports.length === 0 && normalized.rows.length === 0)) {
    for (const suffix of buildCrTransportAllRowsVariants()) {
      try {
        const relativePath = suffix ? `${entitySetName}?${suffix}` : entitySetName;
        raw = await fetchFromSap(
          {
            system: resolvedSystem,
            service: { serviceName },
            relativePath,
            requestMeta: {
              feature: "solman",
              serviceName,
              requestedSystemId: cleanString(system?.systemId || system?.id || system?.code).toUpperCase() || null,
              mappedSystemId: cleanString(resolvedSystem?.systemId).toUpperCase() || null,
            },
          },
          sapAuth
        );

        normalized = normalizeTransportsFromCr(raw, { changeRequestId: cleanCr });
        if (normalized.transports.length > 0 || normalized.rows.length > 0) break;
      } catch (error) {
        lastError = error;

        if (error?.status === 401 || cleanString(error?.message).toLowerCase().includes("logon error")) {
          throw error;
        }
      }
    }
  }

  if (!normalized || (normalized.transports.length === 0 && normalized.rows.length === 0)) {
    if (lastError) {
      throw lastError;
    }

    console.log("[SOLMAN][DEPENDENT] first API returned no transport rows; skipping second API.");
    return {
      ok: true,
      message: `No transports found for CR ${cleanCr}.`,
      result: {
        changeRequestId: cleanCr,
        processType: resolvedProcessType || null,
        transports: [],
        rows: [],
        raw,
        emptyState: `No transports found for CR ${cleanCr}.`,
      },
    };
  }

  return {
    ok: true,
    message:
      normalized.transports.length > 0
        ? `Found ${normalized.transports.length} transport(s) for CR ${cleanCr}.`
        : `No transports found for CR ${cleanCr}.`,
    result: {
      changeRequestId: normalized.changeRequestId || cleanCr,
      transports: normalized.transports,
      rows: normalized.rows,
      processType: resolvedProcessType || null,
      raw,
    },
  };
}

export async function getDependentTransportsFromCr({
  system,
  sapAuth,
  changeRequestId,
  processType = "",
}) {
  const cleanCr = cleanString(changeRequestId);
  console.log("[SOLMAN][DEPENDENT] CR Number received:", cleanCr);

  const trResult = await getTransportNumbersFromCr({
    system,
    sapAuth,
    changeRequestId: cleanCr,
    processType,
  });

  console.log("[SOLMAN][DEPENDENT] first API response:", {
    ok: Boolean(trResult?.ok),
    message: trResult?.message || "",
    changeRequestId: trResult?.result?.changeRequestId || cleanCr,
    rawPreview: safePreview?.(trResult?.result?.raw || trResult?.raw || null),
  });

  if (!trResult?.ok) {
    console.log("[SOLMAN][DEPENDENT] first API failed, skipping second API call.");
    return {
      ok: true,
      message: `No transports were found for CR ${cleanCr}.`,
      result: {
        changeRequestId: cleanCr,
        processType: cleanString(processType) || null,
        sourceTransports: [],
        dependencyMessage: "",
        dependencies: [],
        raw: {
          transportLookup: trResult?.result?.raw || null,
          dependencyLookup: null,
          transportLookupError: trResult?.result?.error || null,
        },
      },
    };
  }

  const sourceTransports = extractTransportNumbersFromCrRows(trResult?.result?.rows || []);
  console.log("[SOLMAN][DEPENDENT] extracted transport numbers:", sourceTransports);
  console.log("[SOLMAN][DEPENDENT] number of transports found:", sourceTransports.length);

  if (sourceTransports.length === 0) {
    console.log("[SOLMAN][DEPENDENT] no transport numbers found, second API will not be called.");
    return {
      ok: true,
      message: `No transports were found for CR ${cleanCr}.`,
      result: {
        changeRequestId: cleanCr,
        processType: trResult?.result?.processType || null,
        sourceTransports: [],
        dependencyMessage: "",
        dependencies: [],
        raw: {
          transportLookup: trResult?.result?.raw || null,
          dependencyLookup: null,
        },
      },
    };
  }

  const transportRows = (Array.isArray(trResult?.result?.rows) ? trResult.result.rows : []).filter(Boolean);
  const dependencyRows = transportRows.length > 0
    ? transportRows.map((row) => ({
        transportEntered: cleanString(row?.Trkorr) || cleanString(row?.Transport) || cleanString(row?.TRANSPORT) || cleanString(sourceTransports[0]) || cleanCr,
        dependentTransport: cleanString(row?.Trkorr) || cleanString(row?.Transport) || cleanString(row?.TRANSPORT) || cleanString(sourceTransports[0]) || cleanCr,
        description: cleanString(row?.Desc) || cleanString(row?.TrfuncDescription) || cleanString(row?.Message) || `Found ${sourceTransports.length} transport(s) for CR ${cleanCr}.`,
        status: cleanString(row?.Trfunction) || cleanString(row?.Status) || "",
        owner: cleanString(row?.Owner) || cleanString(row?.TaskOwner) || "",
        exportDate: cleanString(row?.DevReleasedDate) || cleanString(row?.DevCreatedDate) || "",
        exportTime: cleanString(row?.DevReleasedTime) || cleanString(row?.DevCreatedTime) || "",
        importDate: cleanString(row?.TaskExdate) || "",
        importTime: cleanString(row?.TaskExtime) || "",
      }))
    : sourceTransports.map((transport) => ({
        transportEntered: cleanString(transport) || cleanCr,
        dependentTransport: cleanString(transport) || cleanCr,
        description: `Found ${sourceTransports.length} transport(s) for CR ${cleanCr}.`,
        status: "",
        owner: "",
        exportDate: "",
        exportTime: "",
        importDate: "",
        importTime: "",
      }));

  return {
    ok: true,
    message: `Found ${sourceTransports.length} transport(s) for CR ${cleanCr}.`,
    result: {
      changeRequestId: cleanCr,
      processType: trResult?.result?.processType || null,
      sourceTransports,
      dependencyMessage: `Found ${sourceTransports.length} transport(s) for CR ${cleanCr}.`,
      dependencies: dependencyRows,
      raw: {
        transportLookup: trResult?.result?.raw || null,
        dependencyLookup: null,
      },
    },
  };
}