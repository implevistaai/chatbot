import { buildClassifierPrompt } from "../../prompts/router/classifier.prompt.js";
import { generateJson } from "../llm/ollama.client.js";
import { ROUTING_CONFIG } from "../../config/routing.config.js";
import { normalizeRoutingResult } from "../../config/routing.schema.js";
import { isSupportedIntent } from "../../config/routing.registry.js";
import { detectTransportQueryIntent } from "./detectors/genericRuleDetector.js";
import { extractBusinessEntities } from "./utils/normalizeInput.js";
import { inferCrCreatedByIntent } from "../../controllers/stream/solman/solman.shared.js";

function normalizeSystem(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "s4" || v === "s4hana") return "s4hana";
  if (v === "solman" || v === "solutionmanager" || v === "solution_manager") return "solman";
  if (v === "ambiguous") return "ambiguous";
  return "unknown";
}

function normalizeModule(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["mm", "materials", "material_management"].includes(v)) return "mm";
  if (["sd", "sales"].includes(v)) return "sd";
  if (["finance", "fi"].includes(v)) return "finance";
  if (["approval", "approvals"].includes(v)) return "approval";
  if (["charm", "cha_rm", "change_request"].includes(v)) return "charm";
  if (["incident", "incidents"].includes(v)) return "incident";
  if (["transport", "transports"].includes(v)) return "transport";
  if (["unknown", "ambiguous"].includes(v)) return "unknown";
  return "unknown";
}

function normalizeIntent(value) {
  const v = String(value || "").trim().toLowerCase();
  const map = {
    list_purchase_orders: "list_purchase_orders",
    get_purchase_order_details: "get_purchase_order_details",
    check_approvals: "check_approvals",
    create_change_request: "create_change_request",
    get_change_request_details: "get_change_request_details",
    list_change_requests: "list_change_requests",
    cr_status_distribution: "cr_status_distribution",
    dependency_check: "dependency_check",
    dependency_analysis: "dependency_check",
    create_transport_task: "create_transport_task",
    import_transport_to_production: "import_transport_to_production",
    release_transport_task: "release_transport_task",
    release_transport_request: "release_transport_request",
    create_transport_request: "create_transport_request",
    create_transport: "create_transport",
    transport_list: "transport_list",
    unknown: "unknown",
  };
  return map[v] || "unknown";
}

function clampConfidence(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function cleanString(value) {
  const v = String(value ?? "").trim();
  return v || null;
}

function normalizeRoutingQuery(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeDateYYYYMMDD(value) {
  const v = cleanString(value);
  if (!v) return null;

  if (/^\d{8}$/.test(v)) {
    return v;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return v.replaceAll("-", "");
  }

  return null;
}

function extractCrNumber(query) {
  const q = String(query || "");
  const match = q.match(/\b(?:cr|change request)\s*(?:number\s*)?(\d{6,20})\b/i);
  if (match) return match[1];

  const fallback = q.match(/\b(8\d{9,})\b/);
  return fallback ? fallback[1] : null;
}

function normalizeCreateCrText(query = "") {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\b(?:i\s+want\s+to|i\s+need\s+to|please|can\s+you|could\s+you|help\s+me|help\s+me\s+to|kindly)\b/g, " ")
    .replace(/\b(?:a|an|the|one|new|newly)\b/g, " ")
    .replace(/\b(?:transport\s+change\s+request|transport\s+change|transport\s+request|change\s+request|change\s+requests?|crs?|cr's)\b/g, " CR_ENTITY ")
    .replace(/\b(?:create|raise|submit|open|initiate|start|generate|make|add|request|need|want)\b/g, " ACTION ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCrEntityReference(query = "") {
  return /\b(?:change request|change requests?|transport change request|transport change|crs?|cr's)\b/i.test(query);
}

function hasRetrievalVerb(query = "") {
  return /\b(show|list|display|find|search|get|fetch|view|browse|latest|last|recent)\b/i.test(query);
}

function hasListFilterCue(query = "") {
  return /\b(created|open|closed|pending|rejected|approved|today|yesterday|this week|this month|between|by me|my)\b/i.test(query);
}

function isExplicitCreatePhrase(query = "") {
  const q = normalizeRoutingQuery(query);

  return (
    /\b(?:create|raise|submit|initiate|start|generate|make|add)\b[\s\S]{0,40}\b(?:new\s+)?(?:change request|change requests?|crs?|cr's)\b/i.test(q) ||
    /\bopen\b[\s\S]{0,20}\bnew\b[\s\S]{0,40}\b(?:change request|change requests?|crs?|cr's)\b/i.test(q) ||
    /\bcreate\b[\s\S]{0,40}\bemergency\b[\s\S]{0,40}\b(?:change request|change requests?|crs?|cr's|change)\b/i.test(q) ||
    /\b(?:change request|change requests?|crs?|cr's)\b[\s\S]{0,40}\b(?:create|raise|submit|initiate|start|generate|make|add)\b/i.test(q) ||
    /\bstart\b[\s\S]{0,40}\btransport\s+change\b/i.test(q)
  );
}

function detectListChangeRequestIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  if (!hasCrEntityReference(q)) {
    return false;
  }

  const detailCue =
    /details?\b/i.test(q) ||
    /status of\s+(?:the\s+)?(?:change request|cr)\b/i.test(q) ||
    /(?:change request|cr)\s+status\b/i.test(q) ||
    /cr details\b/i.test(q) ||
    /all change request details\b/i.test(q);

  return hasRetrievalVerb(q) || hasListFilterCue(q) || /\bshow\s+my\s+crs?\b/i.test(q) || /\bcreated\s+by\s+me\b/i.test(q) || /\bopen\s+crs?\b/i.test(q) || /\bclosed\s+crs?\b/i.test(q) || /\bpending\s+crs?\b/i.test(q) || /\brejected\s+crs?\b/i.test(q) || /\bapproved\s+crs?\b/i.test(q);
}

function detectCreateTransportTaskIntent(query = "") {
  const q = normalizeRoutingQuery(query);

  const createTaskPattern = /\b(?:create|add)\b[\s\S]{0,40}\b(?:task|tasks)\b/i;
  const explicitCrCreation = /\b(?:create|raise|submit|open|initiate|start|generate|make|request)\b[\s\S]{0,40}\b(?:change request|change requests?|crs?|cr's)\b/i;

  return createTaskPattern.test(q) && !explicitCrCreation.test(q);
}

function detectImportTransportToProductionIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  return (
    /\bimport\s+(?:transport\s+request|transport\s+number|transport\s+id|transport|tr)\b/i.test(q) ||
    /\b(?:transport|tr)\s+import\b/i.test(q) ||
    /\b(?:production\s+import|import\s+to\s+production|move\s+(?:transport|tr)\s+to\s+production|deploy\s+transport\s+to\s+production|send\s+transport\s+to\s+production)\b/i.test(q)
  );
}

function detectCreateTransportRequestIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  if (/\btransport\s+task\b/i.test(q)) return false;

  return (
    /\b(?:create|generate|raise|make|open|request)\b[\s\S]{0,40}\b(?:transport request|\btr\b)\b/i.test(q) ||
    /\b(?:transport request|\btr\b)\b[\s\S]{0,40}\b(?:create|generate|raise|make|open|request)\b/i.test(q) ||
    /\bcreate\s+transport\s+request\b/i.test(q) ||
    /\bgenerate\s+tr\b/i.test(q)
  );
}

function detectReleaseTransportTaskIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  const releaseTaskPattern = /\brelease\s+task\b/i;
  const releaseTransportTaskPattern = /\brelease\s+transport\s+task\b/i;
  const releaseTaskNumberPattern = /\brelease\s+task\s+number\b/i;
  const taskReleasePattern = /\btask\s+release\b/i;

  return (
    releaseTaskPattern.test(q) ||
    releaseTransportTaskPattern.test(q) ||
    releaseTaskNumberPattern.test(q) ||
    taskReleasePattern.test(q)
  ) && !/\brelease\s+transport\b/i.test(q) && !detectCreateTransportTaskIntent(q) && !detectCreateChangeRequestIntent(q);
}

function detectReleaseTransportIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  return (
    /\brelease\s+transport\b/i.test(q) ||
    /\brelease\s+transport\s+request\b/i.test(q) ||
    /\brelease\s+tr\b/i.test(q) ||
    /\brelease\s+tr\s+request\b/i.test(q) ||
    /\brelease\s+transport\s+number\b/i.test(q) ||
    /\brelease\s+transport\s+id\b/i.test(q) ||
    /\btransport\s+release\b/i.test(q)
  );
}

function detectCreateChangeRequestIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  const isTransportRequestOnly = /\b(?:create|raise|submit|open|initiate|start|generate|make|add|request)\b[\s\S]{0,40}\b(?:transport request|\btr\b)\b/i.test(q) ||
    /\b(?:transport request|\btr\b)\b[\s\S]{0,40}\b(?:create|raise|submit|open|initiate|start|generate|make|add|request)\b/i.test(q);

  if (isTransportRequestOnly && !/\bchange request\b/i.test(q)) {
    return false;
  }

  const hasCreateVerb = /\b(create|raise|submit|initiate|start|generate|make|add)\b/i.test(q);
  const hasRequestCreatePhrase = /\brequest\b[\s\S]{0,30}\b(?:new\s+)?(?:change request|change requests?|crs?|cr's|transport change request|transport change)\b/i.test(q);
  const hasNeedOrWant = /\b(need|want)\b/i.test(q);
  const hasCrNoun = /\b(?:change request|change requests?|transport change request|transport change|crs?|cr's)\b/i.test(q);
  const hasExplicitNew = /\bnew\s+(?:change request|change requests?|transport change request|transport change|crs?|cr's)\b/i.test(q);
  const hasEmergencyCreate = /\bemergency\b/i.test(q) && /\b(?:change request|change requests?|transport change request|transport change|change)\b/i.test(q);

  if (detectCreateTransportTaskIntent(q)) return false;

  return (
    (hasCreateVerb && hasCrNoun) ||
    hasRequestCreatePhrase ||
    (hasNeedOrWant && hasEmergencyCreate) ||
    hasExplicitNew ||
    /\bstart\b[\s\S]{0,40}\btransport\s+change\b/i.test(q)
  );
}

function detectDependencyCheckIntent(query = "") {
  const q = normalizeRoutingQuery(query);
  if (!q) return false;

  const mentionsCr = /\b(?:change request|cr|change requests?)\b/i.test(q);
  const mentionsDependencyCheck = /\bdependency\s+(?:check|analysis)\b/i.test(q);

  return mentionsCr && mentionsDependencyCheck;
}

export function isCreateChangeRequestQuery(query = "") {
  return detectCreateChangeRequestIntent(query);
}

function extractDateRange(query) {
  const q = String(query || "");

  const dates = [...q.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{8})\b/g)]
    .map((m) => normalizeDateYYYYMMDD(m[1]))
    .filter(Boolean);

  if (dates.length >= 2) {
    return {
      fromDate: dates[0],
      toDate: dates[1],
    };
  }

  if (dates.length === 1) {
    return {
      fromDate: dates[0],
      toDate: dates[0],
    };
  }

  return {
    fromDate: null,
    toDate: null,
  };
}

function inferProcessType(query) {
  const q = String(query || "").toLowerCase();

  if (q.includes("india")) return "YMH1";
  if (q.includes("row")) return "YMHF";
  return "";
}

function normalizeCreateChangeRequestEntities(raw = {}) {
  return {
    ShortDesc: cleanString(raw.ShortDesc || raw.shortDesc || raw.short_description || raw.description),
    DeliveryResponsible: cleanString(
      raw.DeliveryResponsible || raw.deliveryResponsible || raw.delivery_responsible
    ),
    Developer: cleanString(raw.Developer || raw.developer),
    Tester: cleanString(raw.Tester || raw.tester),
    WorkItemReference: cleanString(
      raw.WorkItemReference || raw.workItemReference || raw.work_item_reference || raw.ticket || raw.incident
    ),
    Landscape: cleanString(raw.Landscape || raw.landscape),
    ChangeType: cleanString(raw.ChangeType || raw.changeType || raw.change_type),
    Category: cleanString(raw.Category || raw.category),
    Purpose: cleanString(raw.Purpose || raw.purpose),
    Workflow: cleanString(raw.Workflow || raw.workflow),
  };
}

function extractCreateChangeRequestQualifiersFromText(query = "") {
  const q = String(query || "").toLowerCase();

  const changeType = /\bemergency\b/.test(q)
    ? "Emergency"
    : /\bnormal\b/.test(q)
      ? "Normal"
      : null;

  const category = /\btransport\b/.test(q) ? "Transport" : null;

  const purpose = /\bsystem deployment\b|\bdeploy(?:ment)?\b|\bproduction transport\b/.test(q)
    ? "System Deployment"
    : null;

  const workflow = /\bapproval\b/.test(q) ? "Approval" : null;

  return {
    ChangeType: changeType,
    Category: category,
    Purpose: purpose,
    Workflow: workflow,
  };
}

export function getCreateChangeRequestQualifiers(query = "") {
  return extractCreateChangeRequestQualifiersFromText(query);
}
function normalizeTransportListEntities(raw = {}) {
  const objectId = cleanString(
    raw.objectId || raw.OBJECT_ID || raw.changeRequestId || raw.crId || raw.crNumber || raw.cr_number
  );

  return {
    objectId,
    changeRequestId: objectId,
    cr_number: objectId,
    processType: cleanString(raw.processType || raw.PROCESS_TYPE) || "",
  };
}

function normalizeReleaseTransportEntities(raw = {}, queryText = "") {
  const query = String(queryText || "");
  const transportNumber = cleanString(
    raw?.transportNumber ||
      raw?.transportNo ||
      raw?.objectId ||
      raw?.OBJECT_ID ||
      raw?.IvObjectId ||
      query.match(/\b([A-Z]{2,6}\d{4,10})\b/i)?.[1] ||
      ""
  )?.toUpperCase() || null;

  const qualityValue = String(raw.quality ?? raw.IvQuality ?? raw.releaseToQuality ?? "").trim().toLowerCase();
  const quality = qualityValue === "true" || qualityValue === "x" || qualityValue === "1" || qualityValue === "yes";

  return {
    transportNumber,
    quality,
  };
}

export function extractCreateChangeRequestEntitiesFromText(query = "") {
  const text = String(query || "");

  const labelTokens = [
    "short description",
    "description",
    "desc",
    "delivery responsible",
    "del responsible",
    "deliveryresponsible",
    "developer",
    "tester",
    "work item ref",
    "work item reference",
    "workitemreference",
    "landscape",
    "process type",
  ];

  const buildValuePattern = (labelPattern, stopLabels = []) => {
    const stopPattern = stopLabels.length > 0 ? stopLabels.join("|") : "";
    return new RegExp(
      String.raw`(?:^|[\s,;])\s*${labelPattern}\s*[-=:]\s*([\s\S]*?)(?=\s*(?:${stopPattern}|$|[\n,;]))`,
      "i"
    );
  };

  const findValue = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && String(match[1] || "").trim()) {
        return cleanString(match[1]);
      }
    }
    return null;
  };

  return {
    ShortDesc: findValue([
      buildValuePattern(
        "(?:short\\s*desc(?:ription)?|description|desc)",
        ["delivery responsible", "del responsible", "deliveryresponsible", "developer", "tester", "work item ref", "work item reference", "workitemreference", "landscape", "process type"]
      ),
    ]),
    DeliveryResponsible: findValue([
      buildValuePattern(
        "(?:delivery\\s*responsible|del\\s*responsible|deliveryresponsible)",
        ["developer", "tester", "work item ref", "work item reference", "workitemreference", "landscape", "process type", "short description", "description", "desc"]
      ),
    ]),
    Developer: findValue([
      buildValuePattern(
        "(?:developer)",
        ["tester", "work item ref", "work item reference", "workitemreference", "landscape", "process type", "short description", "description", "desc", "delivery responsible", "del responsible", "deliveryresponsible"]
      ),
    ]),
    Tester: findValue([
      buildValuePattern(
        "(?:tester)",
        ["work item ref", "work item reference", "workitemreference", "landscape", "process type", "short description", "description", "desc", "delivery responsible", "del responsible", "deliveryresponsible", "developer"]
      ),
    ]),
    WorkItemReference: findValue([
      buildValuePattern(
        "(?:work\\s*item\\s*(?:ref(?:erence)?)?|workitemreference)",
        ["landscape", "process type", "short description", "description", "desc", "delivery responsible", "del responsible", "deliveryresponsible", "developer", "tester"]
      ),
    ]),
    Landscape: findValue([
      buildValuePattern(
        "(?:landscape|process\\s*type)",
        ["work item ref", "work item reference", "workitemreference", "short description", "description", "desc", "delivery responsible", "del responsible", "deliveryresponsible", "developer", "tester"]
      ),
    ]),
  };
}

function normalizePurchaseOrderDetailEntities(raw = {}) {
  return {
    PurchaseOrder: cleanString(
      raw.PurchaseOrder || raw.purchaseOrder || raw.purchase_order || raw.poNumber || raw.po
    ),
  };
}

function normalizeApprovalEntities(raw = {}) {
  return {
    Approver: cleanString(raw.Approver || raw.approver || raw.user || raw.userId),
    Status: cleanString(raw.Status || raw.status),
  };
}

function normalizeGetChangeRequestEntities(raw = {}) {
  return {
    objectId: cleanString(
      raw.objectId ||
        raw.OBJECT_ID ||
        raw.changeRequestId ||
        raw.crId ||
        raw.crNumber ||
        raw.ChangeRequest ||
        raw.CR
    ),
    processType: cleanString(raw.processType || raw.PROCESS_TYPE) || "",
  };
}

function normalizeListChangeRequestEntities(raw = {}) {
  return {
    fromDate: normalizeDateYYYYMMDD(raw.fromDate || raw.FROM_DATE),
    toDate: normalizeDateYYYYMMDD(raw.toDate || raw.TO_DATE),
    processType: cleanString(raw.processType || raw.PROCESS_TYPE) || "",
    triggerAll: cleanString(raw.triggerAll || raw.TRIGGER_ALL) || "X",
  };
}

function normalizeCrStatusDistributionEntities(raw = {}) {
  return {
    processType: cleanString(raw.processType || raw.PROCESS_TYPE) || "",
    fromDate: normalizeDateYYYYMMDD(raw.fromDate || raw.FROM_DATE),
    toDate: normalizeDateYYYYMMDD(raw.toDate || raw.TO_DATE),
    businessScope: cleanString(raw.businessScope || raw.scope || raw.region || ""),
    createdBy: cleanString(raw.createdBy || raw.CREATED_BY || ""),
    createdByMode: cleanString(raw.createdByMode || ""),
    status: cleanString(raw.status || raw.STATUS || ""),
    statusMode: cleanString(raw.statusMode || ""),
    excludeStatuses: Array.isArray(raw.excludeStatuses) ? raw.excludeStatuses : [],
    triggerAll: cleanString(raw.triggerAll || raw.TRIGGER_ALL) || "X",
    dateText: cleanString(raw.dateText || raw.dateRangeText || ""),
  };
}

function normalizeEntitiesByIntent(intent, rawEntities = {}, queryText = "") {
  const raw = rawEntities && typeof rawEntities === "object" ? rawEntities : {};

  switch (intent) {
    case "create_change_request":
      return normalizeCreateChangeRequestEntities({
        ...extractCreateChangeRequestEntitiesFromText(queryText),
        ...raw,
      });

    case "get_purchase_order_details":
      return normalizePurchaseOrderDetailEntities(raw);

    case "check_approvals":
      return normalizeApprovalEntities(raw);

    case "get_change_request_details":
      return normalizeGetChangeRequestEntities(raw);

    case "list_change_requests":
      return normalizeListChangeRequestEntities(raw);

    case "list_change_requests_by_created_by": {
      const listEntities = normalizeListChangeRequestEntities(raw);
      const inferredCreatedBy = inferCrCreatedByIntent(queryText, raw);

      return {
        ...listEntities,
        createdBy: cleanString(raw.createdBy || raw.CREATED_BY || inferredCreatedBy?.createdBy || ""),
        createdByMode: cleanString(raw.createdByMode || inferredCreatedBy?.createdByMode || ""),
      };
    }

    case "cr_status_distribution":
      return normalizeCrStatusDistributionEntities(raw);

    case "transport_list":
      return normalizeTransportListEntities(raw);

    case "release_transport_request":
      return normalizeReleaseTransportEntities(raw, queryText);

    default:
      return raw;
  }
}

function keywordFallback(query) {
  const q = String(query || "").toLowerCase();
  const objectId = extractCrNumber(query);
  const { fromDate, toDate } = extractDateRange(query);
  const processType = inferProcessType(query);

  if (detectDependencyCheckIntent(query)) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "dependency_check",
      confidence: 0.93,
      reason: "Matched SolMan dependency check/analysis keywords",
      source: "keyword",
      entities: {
        objectId,
        processType,
      },
    });
  }

  const transportMatch = detectTransportQueryIntent(query);

  if (transportMatch.matched) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "transport_list",
      confidence: transportMatch.confidence,
      reason:
        transportMatch.matchedBy === "exact"
          ? "Matched canonical transport query"
          : transportMatch.matchedBy === "fuzzy"
            ? "Matched transport query using fuzzy normalization"
            : "Matched transport query using token similarity",
      source: "keyword",
      entities: normalizeEntitiesByIntent("transport_list", {
        changeRequestId: transportMatch.entities?.cr_number,
        objectId: transportMatch.entities?.cr_number,
        cr_number: transportMatch.entities?.cr_number,
      }),
    });
  }

  const mentionsPo = /\bpo\b/.test(q) || q.includes("purchase order") || q.includes("purchase orders");
  const wantsDetails = /\b(details?|info|information|show details|full details|complete details)\b/.test(q);

  const mentionsCr =
    q.includes("change request") ||
    /\bcr\b/.test(q);

  const createdByIntent = inferCrCreatedByIntent(query);

  const wantsCrRetrieval = mentionsCr && (hasRetrievalVerb(q) || hasListFilterCue(q));

  const wantsCrDetails =
    q.includes("details") ||
    q.includes("detail") ||
    q.includes("status") ||
    q.includes("show") ||
    q.includes("get") ||
    q.includes("fetch") ||
    q.includes("view");

  const wantsCrAnalytics =
    q.includes("status distribution") ||
    q.includes("status breakdown") ||
    q.includes("status analytics") ||
    q.includes("status chart") ||
    q.includes("percentage distribution") ||
    q.includes("pie chart") ||
    q.includes("donut chart") ||
    q.includes("grouped by status") ||
    q.includes("group by status") ||
    q.includes("cr status distribution") ||
    q.includes("status percentage distribution");

  const wantsCrDetailView =
    q.includes("details") ||
    q.includes("detail") ||
    q.includes("show details") ||
    q.includes("all change request details") ||
    q.includes("change request details") ||
    q.includes("cr details") ||
    (objectId && /status of\s+(?:the\s+)?(?:change request|cr)\b/i.test(q)) ||
    (objectId && /(?:change request|cr)\s+status\b/i.test(q)) ||
    q.includes("change request status") ||
    (objectId && q.includes("cr status")) ||
    /details\s+of\s+(?:the\s+)?(?:change request|cr)\b/i.test(q);

  const wantsCrList =
    q.includes("list change requests") ||
    q.includes("show change requests") ||
    q.includes("cr list") ||
    q.includes("show crs") ||
    q.includes("show cr status") ||
    q.includes("show cr list") ||
    q.includes("show crs status") ||
    q.includes("list crs") ||
    q.includes("change request list") ||
    q.includes("browse crs") ||
    q.includes("browse change requests") ||
    wantsCrRetrieval;

  if (mentionsCr && createdByIntent?.intent === "list_change_requests_by_created_by") {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "list_change_requests_by_created_by",
      confidence: 0.92,
      reason: "Matched SolMan created-by list keywords",
      source: "keyword",
      entities: normalizeEntitiesByIntent(
        "list_change_requests_by_created_by",
        createdByIntent,
        query
      ),
    });
  }

  if (wantsCrAnalytics) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "cr_status_distribution",
      confidence: 0.93,
      reason: "Matched SolMan CR status analytics keywords",
      source: "keyword",
      entities: {
        processType,
        fromDate,
        toDate,
        dateText: q,
      },
    });
  }

  if (mentionsCr && wantsCrDetailView) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "get_change_request_details",
      confidence: 0.94,
      reason: "Matched SolMan CR detail/status keywords",
      source: "keyword",
      entities: {
        objectId,
        processType,
      },
    });
  }

  if (mentionsCr && wantsCrList) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "list_change_requests",
      confidence: 0.92,
      reason: "Matched SolMan CR list keywords",
      source: "keyword",
      entities: {
        fromDate,
        toDate,
        processType,
        triggerAll: "X",
      },
    });
  }

  if (
    (q.includes("change requests") || q.includes("change request") || q.includes("solman change requests")) &&
    (fromDate || toDate)
  ) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "list_change_requests",
      confidence: 0.92,
      reason: "Matched SolMan change request list/date keywords",
      source: "keyword",
      entities: {
        fromDate,
        toDate,
        processType,
        triggerAll: "X",
      },
    });
  }

  if (detectCreateChangeRequestIntent(query)) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "create_change_request",
      confidence: 0.9,
      reason: "Matched explicit SolMan change request keywords",
      source: "keyword",
      entities: normalizeEntitiesByIntent("create_change_request", {}, query),
    });
  }

  if (/(show|get|view|display|fetch).*(accounting details|account details|account detail|accounting document|fi document)/i.test(q) || /show accounting details for po/i.test(q)) {
    return normalizeRoutingResult({
      system: "s4hana",
      module: "mm",
      intent: "get_purchase_order_details",
      confidence: 0.9,
      reason: "Matched accounting details keywords before generic PO detail fallback",
      source: "keyword",
      entities: normalizeEntitiesByIntent("get_purchase_order_details", query),
      documentFlowIntent: "ACCOUNTING_DOCUMENT",
    });
  }

  if (mentionsPo && wantsDetails) {
    return normalizeRoutingResult({
      system: "s4hana",
      module: "mm",
      intent: "get_purchase_order_details",
      confidence: 0.88,
      reason: "Matched purchase order details keywords",
      source: "keyword",
      entities: normalizeEntitiesByIntent("get_purchase_order_details", {}),
    });
  }

  if (mentionsPo) {
    return normalizeRoutingResult({
      system: "s4hana",
      module: "mm",
      intent: "list_purchase_orders",
      confidence: 0.86,
      reason: "Matched purchase order keywords",
      source: "keyword",
      entities: {},
    });
  }

  if (q.includes("approval") || q.includes("approvals")) {
    return normalizeRoutingResult({
      system: "s4hana",
      module: "approval",
      intent: "check_approvals",
      confidence: 0.8,
      reason: "Matched approval-related keywords",
      source: "keyword",
      entities: normalizeEntitiesByIntent("check_approvals", {}),
    });
  }

  return normalizeRoutingResult({
    system: "ambiguous",
    module: "unknown",
    intent: "unknown",
    confidence: 0.4,
    reason: "No strong routing signal found",
    source: "keyword",
    entities: {},
  });
}

export async function classifyPrompt({ query, sessionContext = null }) {
  if (detectImportTransportToProductionIntent(query)) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "import_transport_to_production",
      confidence: 0.98,
      reason: "Matched SolMan production import transport intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent("import_transport_to_production", extractBusinessEntities(query), query),
    });
  }

  if (detectDependencyCheckIntent(query)) {
    const objectId = extractCrNumber(query);
    const processType = inferProcessType(query);
    const transportId = extractBusinessEntities(query)?.transport_id || null;

    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "dependency_check",
      confidence: 0.96,
      reason: "Matched SolMan dependency check/analysis intent from natural language",
      source: "rule",
      entities: {
        objectId,
        processType,
        transportId,
      },
    });
  }

  const transportMatch = detectTransportQueryIntent(query);

  if (detectCreateTransportRequestIntent(query)) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "create_transport_request",
      confidence: 0.98,
      reason: "Matched SolMan transport request creation intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent("create_transport_request", extractBusinessEntities(query), query),
    });
  }

  if (transportMatch.matched && transportMatch.confidence >= ROUTING_CONFIG.confidence.high) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "transport_list",
      confidence: transportMatch.confidence,
      reason:
        transportMatch.matchedBy === "exact"
          ? "Matched canonical transport query"
          : transportMatch.matchedBy === "fuzzy"
            ? "Matched transport query using fuzzy normalization"
            : "Matched transport query using token similarity",
      source: "rule",
      entities: normalizeEntitiesByIntent("transport_list", {
        changeRequestId: transportMatch.entities?.cr_number,
        objectId: transportMatch.entities?.cr_number,
        cr_number: transportMatch.entities?.cr_number,
      }),
    });
  }

  const createdByLikeIntent = inferCrCreatedByIntent(query);
  const createTransportTaskLikeIntent = detectCreateTransportTaskIntent(query);
  const releaseTransportLikeIntent = detectReleaseTransportIntent(query);
  const releaseTransportTaskLikeIntent = detectReleaseTransportTaskIntent(query);
  const listLikeIntent = detectListChangeRequestIntent(query);
  const createLikeIntent = detectCreateChangeRequestIntent(query);

  if (createdByLikeIntent?.intent === "list_change_requests_by_created_by") {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "list_change_requests_by_created_by",
      confidence: 0.95,
      reason: "Matched SolMan created-by retrieval intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent(
        "list_change_requests_by_created_by",
        createdByLikeIntent,
        query
      ),
    });
  }

  if (createTransportTaskLikeIntent) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "create_transport_task",
      confidence: 0.97,
      reason: "Matched SolMan transport task creation intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent(
        "create_transport_task",
        extractBusinessEntities(query),
        query
      ),
    });
  }

  if (releaseTransportLikeIntent) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "release_transport_request",
      confidence: 0.97,
      reason: "Matched SolMan transport release intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent(
        "release_transport_request",
        extractBusinessEntities(query),
        query
      ),
    });
  }

  if (releaseTransportTaskLikeIntent) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "release_transport_task",
      confidence: 0.97,
      reason: "Matched SolMan transport task release intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent(
        "release_transport_task",
        extractBusinessEntities(query),
        query
      ),
    });
  }

  if (createLikeIntent) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "create_change_request",
      confidence: 0.96,
      reason: "Matched create change request intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent(
        "create_change_request",
        {
          ...extractCreateChangeRequestEntitiesFromText(query),
          ...extractCreateChangeRequestQualifiersFromText(query),
        },
        query
      ),
    });
  }

  if (listLikeIntent) {
    return normalizeRoutingResult({
      system: "solman",
      module: "charm",
      intent: "list_change_requests",
      confidence: 0.95,
      reason: "Matched SolMan CR retrieval intent from natural language",
      source: "rule",
      entities: normalizeEntitiesByIntent("list_change_requests", {}, query),
    });
  }

  const prompt = buildClassifierPrompt({ query, sessionContext });

  const llm = await generateJson({
    prompt,
    schemaHint: "routing-classifier",
  });

  if (llm.ok && llm.data) {
    const normalizedIntent = normalizeIntent(llm.data.intent);

    const candidate = normalizeRoutingResult({
      system: normalizeSystem(llm.data.system),
      module: normalizeModule(llm.data.module),
      intent: normalizedIntent,
      confidence: clampConfidence(llm.data.confidence),
      reason: String(llm.data.reason || "").trim() || "LLM classification",
      source: "llm",
      entities: normalizeEntitiesByIntent(normalizedIntent, llm.data.entities, query),
    });

    if (normalizedIntent === "create_change_request" && listLikeIntent && !createLikeIntent) {
      return normalizeRoutingResult({
        ...candidate,
        system: "solman",
        module: "charm",
        intent: "list_change_requests",
        confidence: Math.max(candidate.confidence, 0.95),
        source: candidate.source === "llm" ? "llm" : "rule",
        entities: normalizeEntitiesByIntent("list_change_requests", llm.data.entities, query),
        reason: candidate.reason || "Normalized SolMan CR retrieval request",
      });
    }

    if (normalizedIntent === "create_change_request" && createLikeIntent) {
      return normalizeRoutingResult({
        ...candidate,
        system: "solman",
        module: "charm",
        intent: "create_change_request",
        confidence: Math.max(candidate.confidence, 0.96),
        source: candidate.source === "llm" ? "llm" : "rule",
        entities: normalizeEntitiesByIntent(
          "create_change_request",
          {
            ...extractCreateChangeRequestEntitiesFromText(query),
            ...extractCreateChangeRequestQualifiersFromText(query),
            ...candidate.entities,
          },
          query
        ),
        reason: candidate.reason || "Matched create change request intent",
      });
    }

    const q = String(query || "").toLowerCase();
    const explicitAnalyticsQuery =
      q.includes("status distribution") ||
      q.includes("status breakdown") ||
      q.includes("status analytics") ||
      q.includes("status chart") ||
      q.includes("percentage distribution") ||
      q.includes("pie chart") ||
      q.includes("donut chart") ||
      q.includes("grouped by status") ||
      q.includes("group by status") ||
      q.includes("cr status distribution") ||
      q.includes("status percentage distribution");

    const crListQuery =
      q.includes("show cr status") ||
      q.includes("show crs") ||
      q.includes("list change requests") ||
      q.includes("show change requests") ||
      q.includes("cr list") ||
      q.includes("list crs") ||
      q.includes("change request list") ||
      listLikeIntent;

    if (transportMatch.matched && normalizedIntent === "unknown") {
      return normalizeRoutingResult({
        system: "solman",
        module: "transport",
        intent: "transport_list",
        confidence: transportMatch.confidence,
        reason: "Matched transport query before LLM fallback",
        source: "rule",
        entities: normalizeEntitiesByIntent("transport_list", {
          changeRequestId: transportMatch.entities?.cr_number,
          objectId: transportMatch.entities?.cr_number,
          cr_number: transportMatch.entities?.cr_number,
        }),
      });
    }

    if (candidate.system === "solman" && crListQuery && !explicitAnalyticsQuery) {
      return normalizeRoutingResult({
        ...candidate,
        module: "charm",
        intent: "list_change_requests",
        entities: normalizeEntitiesByIntent("list_change_requests", llm.data.entities, query),
        reason: candidate.reason || "Normalized SolMan CR list request",
      });
    }

    if (
      candidate.system === "solman" &&
      candidate.intent === "cr_status_distribution" &&
      crListQuery &&
      !explicitAnalyticsQuery
    ) {
      return normalizeRoutingResult({
        ...candidate,
        module: "charm",
        intent: "list_change_requests",
        entities: normalizeEntitiesByIntent("list_change_requests", llm.data.entities, query),
        reason: candidate.reason || "Normalized SolMan CR list request",
      });
    }

    if (candidate.system === "ambiguous") {
      return candidate;
    }

    if (
      candidate.system === "s4hana" &&
      !ROUTING_CONFIG.systems.s4hana.enabled
    ) {
      return normalizeRoutingResult({
        ...candidate,
        system: "unknown",
        module: "unknown",
        intent: "unknown",
        confidence: 0.2,
        reason: "S/4HANA routing is disabled",
        source: "validator",
      });
    }

    if (
      candidate.system === "solman" &&
      !ROUTING_CONFIG.systems.solman.enabled
    ) {
      return normalizeRoutingResult({
        ...candidate,
        system: "unknown",
        module: "unknown",
        intent: "unknown",
        confidence: 0.2,
        reason: "SolMan routing is disabled",
        source: "validator",
      });
    }

    if (
      candidate.system !== "unknown" &&
      candidate.module !== "unknown" &&
      candidate.intent !== "unknown" &&
      isSupportedIntent({
        system: candidate.system,
        module: candidate.module,
        intent: candidate.intent,
      })
    ) {
      return candidate;
    }
  }

  if (transportMatch.matched) {
    return normalizeRoutingResult({
      system: "solman",
      module: "transport",
      intent: "transport_list",
      confidence: transportMatch.confidence,
      reason: "Transport query resolved by rule fallback",
      source: "rule",
      entities: normalizeEntitiesByIntent("transport_list", {
        changeRequestId: transportMatch.entities?.cr_number,
        objectId: transportMatch.entities?.cr_number,
        cr_number: transportMatch.entities?.cr_number,
      }),
    });
  }

  return keywordFallback(query);
}