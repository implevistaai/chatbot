import { ApiError } from "../../utils/errors.js";
import { FIELD_HINTS, FIELD_HINTS_PART2, FIELD_HINTS_PART3 } from "./fieldhints.js";

import { extractDateFilters } from "../filters/dateFilters.js";
import { extractNumericFilters } from "../filters/valueFilters.js";
import {
  extractLimit,
  extractOrderBy,
  extractSkip,
  extractCount,
} from "../filters/sortAndLimit.js";
import { normalizePromptWithLlm } from "../routing/promptNormalization.service.js";

import { FIELD_BUNDLES } from "./fieldBundles.js";
import { INTENT_RULES } from "./intentRules.js";

const ALL_FIELD_HINTS = [
  ...(Array.isArray(FIELD_HINTS) ? FIELD_HINTS : []),
  ...(Array.isArray(FIELD_HINTS_PART2) ? FIELD_HINTS_PART2 : []),
  ...(Array.isArray(FIELD_HINTS_PART3) ? FIELD_HINTS_PART3 : []),
];

async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

const MAX_CHARS = Number(process.env.LLM_EXTRACTOR_MAX_CHARS || 2000);
const CANDIDATE_LIMIT = Number(process.env.LLM_FIELD_CANDIDATE_LIMIT || 30);

function safeJsonFromText(text) {
  const s = String(text || "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeText(s) {
  const text = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return text;

  // Lightweight typo normalization for common action verbs in PO prompts.
  const typoMap = new Map([
    ["shew", "show"],
    ["shwo", "show"],
    ["sho", "show"],
    ["lsit", "list"],
    ["purhcase", "purchase"],
    ["puchase", "purchase"],
    ["orde", "order"],
    ["ordr", "order"],
  ]);

  return text
    .split(" ")
    .map((t) => typoMap.get(t) || t)
    .join(" ");
}

const PO_SIGNAL_REGEX =
  /\b(po|pos|purchase\s*order|purchase\s*orders|document|documents|vendor|supplier|material|item|line\s*item|created|creation|date|month|year|today|yesterday|last\s+week|last\s+month|last\s+year|top|skip|offset|count|order\s+by)\b/i;

const MONTH_TOKEN_REGEX =
  /\b(jan|january|feb|february|febaury|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i;

const USERNAME_STOPWORDS = new Set([
  "date",
  "dates",
  "month",
  "months",
  "year",
  "years",
  "today",
  "yesterday",
  "week",
  "latest",
  "recent",
  "asc",
  "desc",
  "ascending",
  "descending",
  "price",
  "amount",
  "vendor",
  "supplier",
  "count",
  "top",
  "skip",
  "offset",
  "order",
]);

const PO_SUMMARY_FIELDS = ["PoNo", "PoItem", "MatNo", "SuppAcoutNo", "Menge"];
const GENERIC_PO_LIST_FIELDS = ["PoNo", "PoItem", "MatNo", "SuppAcoutNo", "Menge"];

export function hasPoQuerySignals(message) {
  const q = String(message || "").trim();
  if (!q) return false;
  if (PO_SIGNAL_REGEX.test(q)) return true;
  if (/\b(shew|shwo|sho)\s+po\b/i.test(q)) return true;
  if (MONTH_TOKEN_REGEX.test(q)) return true;
  if (/\b(19\d{2}|20\d{2})\b/.test(q)) return true;
  if (/\b\d{8,12}\b/.test(q)) return true;
  return false;
}

export function hasStructuredPoRequest(extracted) {
  const filters = Array.isArray(extracted?.filters) ? extracted.filters : [];
  const orderBy = Array.isArray(extracted?.orderBy) ? extracted.orderBy : [];
  const hasLimit = Number.isFinite(Number(extracted?.limit)) && Number(extracted?.limit) > 0;
  const hasSkip = Number.isFinite(Number(extracted?.skip)) && Number(extracted?.skip) > 0;

  return Boolean(
    extracted?.docNumber ||
      extracted?.docItem ||
      extracted?.listMode ||
      extracted?.count === true ||
      hasLimit ||
      hasSkip ||
      filters.length > 0 ||
      orderBy.length > 0
  );
}

function singularizeToken(t) {
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  const norm = normalizeText(s);
  if (!norm) return [];
  return norm.split(" ").map(singularizeToken).filter(Boolean);
}

function applySynonymsToTokens(tokens) {
  const map = new Map([
    ["ccy", "currency"],
    ["curr", "currency"],
    ["doc", "document"],
    ["del", "delivery"],
    ["uom", "unit"],
    ["fx", "exchange"],
    ["exch", "exchange"],
    ["vendor", "supplier"],
    ["seller", "supplier"],
    ["product", "material"],
    ["sku", "material"],
  ]);
  return tokens.map((t) => map.get(t) || t);
}

function normalizeNumericId(value, padLen) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  if (!padLen) return digits;
  return digits.padStart(padLen, "0").slice(-padLen);
}

function normalizePoItem(poItem) {
  return normalizeNumericId(poItem, 5);
}

function extractDocNumberFallback(message) {
  const m = String(message || "");

  const pref = m.match(/\b(po|purchase\s*order)\s*[:#\-()]?\s*(\d{8,12})\b/i);
  if (pref?.[2]) return pref[2];

  const withArticle = m.match(/\b(the\s+)?(po|purchase\s*order)\s+(\d{8,12})\b/i);
  if (withArticle?.[3]) return withArticle[3];

  const ten = m.match(/\b\d{10}\b/);
  if (ten) return ten[0];

  const any = m.match(/\b\d{8,12}\b/);
  return any ? any[0] : null;
}

function extractPoItemFallback(message) {
  const m = String(message || "");
  const match = m.match(
    /\b(po\s*items?|poitems?|po\s*item|poitem|item|line\s*item|line)\s*[:#\-()]?\s*(\d{1,5})\b/i
  );
  return match?.[2] ? normalizePoItem(match[2]) : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

function similarity(a, b) {
  const A = normalizeText(a);
  const B = normalizeText(b);
  if (!A || !B) return 0;
  const dist = levenshtein(A, B);
  return 1 - dist / Math.max(A.length, B.length);
}

function buildLabelIndex(allowedFields, fieldLabels) {
  const allowed = Array.isArray(allowedFields) ? allowedFields : [];
  const labels = fieldLabels && typeof fieldLabels === "object" ? fieldLabels : {};

  const index = [];
  for (const f of allowed) {
    const label = labels[f] || "";
    const labelNorm = normalizeText(label);
    const labelTokens = applySynonymsToTokens(tokenize(label));
    index.push({ field: f, fieldLower: String(f).toLowerCase(), label, labelNorm, labelTokens });
  }
  return index;
}

function extractFieldsByLabels({ message, allowedFields, fieldLabels }) {
  const qNorm = normalizeText(message);
  const qTokens = applySynonymsToTokens(tokenize(message));
  const qTokenSet = new Set(qTokens);

  const allowedMap = new Map(allowedFields.map((f) => [String(f).toLowerCase(), f]));
  const labelIndex = buildLabelIndex(allowedFields, fieldLabels);

  const picked = new Map();

  for (const [low, orig] of allowedMap.entries()) {
    if (qNorm.includes(low)) picked.set(orig, Math.max(picked.get(orig) || 0, 100));
  }

  for (const entry of labelIndex) {
    if (entry.labelNorm && qNorm.includes(entry.labelNorm)) {
      picked.set(entry.field, Math.max(picked.get(entry.field) || 0, 80));
    }
  }

  for (const entry of labelIndex) {
    if (!entry.labelTokens.length) continue;
    let overlap = 0;
    for (const t of entry.labelTokens) if (qTokenSet.has(t)) overlap++;

    const minOverlap = entry.labelTokens.length >= 2 ? 2 : 1;
    if (overlap >= minOverlap) {
      picked.set(entry.field, Math.max(picked.get(entry.field) || 0, 20 + overlap * 10));
    }
  }

  const FUZZY_TOKEN_SIM_THRESHOLD = 0.86;
  for (const entry of labelIndex) {
    if (!entry.labelTokens.length) continue;

    for (const qt of qTokens) {
      if (qt.length < 4) continue;
      for (const lt of entry.labelTokens) {
        if (lt.length < 4) continue;
        const sim = similarity(qt, lt);
        if (sim >= FUZZY_TOKEN_SIM_THRESHOLD) {
          picked.set(entry.field, Math.max(picked.get(entry.field) || 0, 25));
        }
      }
    }
  }

  return [...picked.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

function extractFieldsByHints(message, allowedFields) {
  const q = normalizeText(message);
  const allowedSet = new Set((allowedFields || []).map((f) => String(f).toLowerCase()));

  const picked = [];
  for (const h of ALL_FIELD_HINTS) {
    const fieldLower = String(h.field).toLowerCase();
    if (!allowedSet.has(fieldLower)) continue;
    if ((h.terms || []).some((t) => q.includes(normalizeText(t)))) picked.push(h.field);
  }
  return picked;
}

function extractFieldsByBundles(message, allowedFields) {
  const q = normalizeText(message);
  const allowedSet = new Set((allowedFields || []).map((f) => String(f).toLowerCase()));

  const picked = [];
  for (const b of Array.isArray(FIELD_BUNDLES) ? FIELD_BUNDLES : []) {
    const hit = (b.terms || []).some((t) => q.includes(normalizeText(t)));
    if (!hit) continue;
    for (const f of b.fields || []) if (allowedSet.has(String(f).toLowerCase())) picked.push(f);
  }
  return picked;
}

function detectIntent(message) {
  const q = normalizeText(message);

  for (const rule of Array.isArray(INTENT_RULES) ? INTENT_RULES : []) {
    const hitTerms = (rule.terms || []).some((t) => q.includes(normalizeText(t)));
    if (hitTerms) return rule;

    for (const p of rule.patterns || []) {
      try {
        const re = new RegExp(p, "i");
        if (re.test(q)) return rule;
      } catch {
        // ignore bad regex
      }
    }
  }

  return null;
}

function getCandidateFields(message, allowedFields, limit = 30) {
  const allowed = Array.isArray(allowedFields) ? allowedFields : [];
  if (allowed.length <= limit) return allowed;

  const q = normalizeText(message);
  const scores = new Map();
  for (const f of allowed) scores.set(f, 0);

  for (const f of allowed) {
    const low = String(f).toLowerCase();
    if (q.includes(low)) scores.set(f, (scores.get(f) || 0) + 10);
    if (q.includes("date") && low.includes("date")) scores.set(f, (scores.get(f) || 0) + 2);
    if (q.includes("price") && low.includes("price")) scores.set(f, (scores.get(f) || 0) + 2);
    if (q.includes("volume") && low.includes("vol")) scores.set(f, (scores.get(f) || 0) + 2);
    if (q.includes("weight") && low.includes("wt")) scores.set(f, (scores.get(f) || 0) + 2);
  }

  for (const h of ALL_FIELD_HINTS) {
    if (!scores.has(h.field)) continue;
    if ((h.terms || []).some((t) => q.includes(normalizeText(t)))) {
      scores.set(h.field, (scores.get(h.field) || 0) + 50);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f]) => f);
}

function buildPrompt({ message, allowedFields }) {
  return `
You are an information extraction system for SAP Purchase Orders.

Extract ONLY:
- SAP field names from allowed list
- docNumber
- docItem

Return ONLY JSON:
{
  "fields": [],
  "docNumber": null,
  "docItem": null
}

STRICT RULES:
- Use ONLY fields from this list:
${JSON.stringify(allowedFields)}

- DO NOT invent fields
- Always prefer exact field names from list

- docNumber = digits only (usually 10 digits)
- docItem = digits only (PO item 5 digits)

User:
${JSON.stringify(message)}
`.trim();
}

async function callExtractorLLM({ message, allowedFields }) {
  const url = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
  const model = process.env.OLLAMA_MODEL || "llama3:latest";
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 8000);

  const candidates = getCandidateFields(message, allowedFields, CANDIDATE_LIMIT);
  const prompt = buildPrompt({ message, allowedFields: candidates });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const f = await getFetch();

    const resp = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 100,
          stop: ["}\n", "}\r\n", "}"],
        },
      }),
    });

    if (!resp.ok) return null;

    const json = await resp.json();
    const parsed = safeJsonFromText(json?.response);
    if (!parsed || typeof parsed !== "object") return null;

    return parsed;
  } catch (e) {
    if (e?.name === "AbortError") return null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildPoStructuredExtractionPrompt({ message, allowedFields, fieldLabels }) {
  return `
You are a strict SAP Purchase Order prompt interpreter.

Return ONLY JSON with this exact shape:
{
  "normalizedQuery": "string",
  "shouldReject": false,
  "confidence": 0.0,
  "reason": "string",
  "fields": [],
  "docNumber": null,
  "docItem": null,
  "filters": [],
  "orderBy": [],
  "limit": null,
  "skip": null,
  "count": false,
  "listMode": null
}

  {"field":"UserCreated","op":"eq","type":"string","value":"<user>"}
- If the user says last/today/month/week/day ranges, map date filters onto the best date field.
- If the user asks for latest/recent PO list, set listMode to "latest_po" and orderBy to CrtDate desc.
- If no explicit limit is mentioned for list queries, default limit to 10.
- confidence must be between 0 and 1.

User:
${JSON.stringify(message)}

Allowed fields:
${JSON.stringify(allowedFields)}

Field labels:
${JSON.stringify(fieldLabels)}
`.trim();
}

async function callPoStructuredExtractorLLM({ message, allowedFields, fieldLabels }) {
  const url = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
  const model = process.env.OLLAMA_MODEL || "llama3:latest";
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 8000);

  const prompt = buildPoStructuredExtractionPrompt({ message, allowedFields, fieldLabels });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const f = await getFetch();

    const resp = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 180,
          stop: ["}\n", "}\r\n", "}"],
        },
      }),
    });

    if (!resp.ok) return null;

    const json = await resp.json();
    const parsed = safeJsonFromText(json?.response);
    if (!parsed || typeof parsed !== "object") return null;

    return parsed;
  } catch (e) {
    if (e?.name === "AbortError") return null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickPoDateField(message, allowedFields) {
  const q = String(message || "").toLowerCase();
  const set = new Set((allowedFields || []).map((f) => String(f).toLowerCase()));

  const createdCandidates = ["CrtDate", "CreatedOn"];
  const documentCandidates = ["PoDocDate", "DocDate", "DocumentDate"];

  if (/\b(created|created on|created in|creation)\b/.test(q)) {
    for (const c of createdCandidates) {
      if (set.has(String(c).toLowerCase())) return c;
    }
  }

  if (/\b(document date|doc date|po date)\b/.test(q)) {
    for (const c of documentCandidates) {
      if (set.has(String(c).toLowerCase())) return c;
    }
  }

  if (set.has("podocdate")) {
    return "PoDocDate";
  }

  for (const c of [...createdCandidates, ...documentCandidates]) {
    if (set.has(String(c).toLowerCase())) return c;
  }

  return "PoDocDate";
}

function extractUserCreatedFilters(message, allowedFields) {
  const text = String(message || "");
  const q = normalizeText(text);

  const allowedSet = new Set((allowedFields || []).map((f) => String(f).toLowerCase()));
  if (!allowedSet.has("usercreated")) return [];

  if (
    /\bmy\s+(po|pos|purchase\s*orders?)\b/i.test(text) ||
    /\bshow\s+my\s+(po|pos|purchase\s*orders?)\b/i.test(text) ||
    /\bcreated\s+by\s+me\b/i.test(text) ||
    /\bmy\s+po\s+created\s+by\s+me\b/i.test(text)
  ) {
    return [
      {
        field: "UserCreated",
        op: "eq",
        type: "string",
        value: "ME",
      },
    ];
  }

  const directMatch =
    text.match(new RegExp("\\bcreated\\s*by\\s*(?:the\\s+)?(?:user(?:name)?|sap\\s*user)?\\s*[:=]?\\s*[\"'\\x60]?([A-Za-z0-9_@.\\-]+)[\"'\\x60]?", "i")) ||
    text.match(new RegExp("\\bcreatedby\\s*[:=]?\\s*[\"'\\x60]?([A-Za-z0-9_@.\\-]+)[\"'\\x60]?", "i")) ||
    text.match(new RegExp("\\b(?:user(?:name)?|user\\s*id|userid|sap\\s*user)\\s*[:=]?\\s*[\"'\\x60]?([A-Za-z0-9_@.\\-]+)[\"'\\x60]?", "i"));

  let user = directMatch?.[1] ? String(directMatch[1]).trim() : "";

  if (!user) {
    if (!/\bby\b/i.test(text)) {
      return [];
    }

    const byRegex = new RegExp("\\b(?:by\\s+(?:the\\s+)?(?:user(?:name)?|sap\\s*user)?\\s*[:=]?\\s*)?[\"'\\x60]?([A-Za-z0-9_@.\\-]+)[\"'\\x60]?", "gi");
    const byMatches = [...text.matchAll(byRegex)];
    const hasCreationContext =
      /\b(created|creation|created\s+on|created\s+in|created\s+during)\b/i.test(text) ||
      MONTH_TOKEN_REGEX.test(text) ||
      /\b(19\d{2}|20\d{2})\b/.test(text);

    if (hasCreationContext && byMatches.length > 0) {
      for (let i = byMatches.length - 1; i >= 0; i--) {
        const candidate = String(byMatches[i][1] || "").trim();
        if (!candidate) continue;
        if (USERNAME_STOPWORDS.has(candidate.toLowerCase())) continue;
        user = candidate;
        break;
      }
    }
  }

  if (!user) return [];

  if (["me", "my", "myself", "user", "someone"].includes(q.split(" ").pop())) {
    // optional: resolve current sap user later
  }

  return [
    {
      field: "UserCreated",
      op: "eq",
      type: "string",
      value: user,
    },
  ];
}

export async function extractDocQuery({ query, allowedFields, fieldLabels }) {
  const message = String(query || "").trim();
  if (!message) throw new ApiError(400, "query is required");
  if (!Array.isArray(allowedFields) || allowedFields.length === 0) {
    throw new ApiError(500, "allowedFields is required");
  }

  const truncated = message.length > MAX_CHARS ? message.slice(0, MAX_CHARS) : message;
  const poDateField = pickPoDateField(truncated, allowedFields);

  const out = {
    docType: "PO",
    fields: [],
    docNumber: extractDocNumberFallback(truncated),
    docItem: extractPoItemFallback(truncated),
    filters: [],
    orderBy: [],
    limit: null,
    skip: null,
    listMode: null,
    count: false,
  };

  out.filters.push(...extractDateFilters(truncated, poDateField));
  out.filters.push(...extractNumericFilters(truncated, allowedFields));
  out.filters.push(...extractUserCreatedFilters(truncated, allowedFields));

  if (/\b(?:from|between)\b/i.test(truncated) && /\b(?:to|and)\b/i.test(truncated)) {
    const startDateFilter = out.filters.find(
      (filter) => filter?.field === poDateField && filter?.op === "ge" && filter?.type === "datetime"
    );
    const endDateFilter = out.filters.find(
      (filter) => filter?.field === poDateField && filter?.op === "lt" && filter?.type === "datetime"
    );

    if (startDateFilter?.value && endDateFilter?.value) {
      const endDateValue = String(endDateFilter.value);
      const parsedEnd = new Date(endDateValue.endsWith("Z") ? endDateValue : endDateValue + "Z");
      if (!Number.isNaN(parsedEnd.getTime())) {
        const inclusiveEnd = new Date(parsedEnd.getTime() - 1000);
        const yyyy = inclusiveEnd.getUTCFullYear();
        const mm = String(inclusiveEnd.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(inclusiveEnd.getUTCDate()).padStart(2, "0");
        endDateFilter.op = "le";
        endDateFilter.value = yyyy + "-" + mm + "-" + dd + "T23:59:59";
      }
    }
  }

  out.orderBy = extractOrderBy(truncated, allowedFields, poDateField) || [];
  out.limit = extractLimit(truncated);
  out.skip = extractSkip(truncated);
  out.count = extractCount(truncated);

  const labelPicked = extractFieldsByLabels({ message: truncated, allowedFields, fieldLabels });
  const hintPicked = extractFieldsByHints(truncated, allowedFields);
  const bundlePicked = extractFieldsByBundles(truncated, allowedFields);

  const qNorm = normalizeText(truncated);
  const hasDocumentContext = Boolean(out.docNumber);
  const wantsDetails = /\b(details?|info|information|full details|complete details|all details|show details)\b/.test(qNorm);
  const autoBundlePicked = hasDocumentContext && wantsDetails
    ? extractFieldsByBundles("details", allowedFields)
    : [];

  const intent = detectIntent(truncated);
  const hasPoMention = /\b(po|purchase\s*order[s]?)\b/i.test(truncated);
  const needsStructuredPoFallback =
    hasPoMention &&
    !out.docNumber &&
    !out.docItem &&
    out.filters.length === 0 &&
    out.orderBy.length === 0 &&
    !intent;

  if (intent && !out.docNumber) {
    out.listMode = intent.listMode || null;

    if ((!out.orderBy || out.orderBy.length === 0) && Array.isArray(intent.defaultOrderBy)) {
      out.orderBy = intent.defaultOrderBy;
    }

    if (out.limit == null && Number.isFinite(Number(intent.defaultLimit))) {
      out.limit = Number(intent.defaultLimit);
    }

    if (out.fields.length === 0) {
      const allowedSet = new Set(allowedFields.map((f) => String(f).toLowerCase()));
      out.fields = PO_SUMMARY_FIELDS.filter((field) => allowedSet.has(String(field).toLowerCase()));
    }
  }

  if (!intent && hasPoMention && !out.docNumber && !out.docItem) {
    const allowedSet = new Set(allowedFields.map((f) => String(f).toLowerCase()));
    out.listMode = "latest_po";
    if (!Array.isArray(out.orderBy) || out.orderBy.length === 0) {
      out.orderBy = [{ field: "CrtDate", dir: "desc" }];
    }
    if (out.limit == null) {
      out.limit = 10;
    }
    if (!Array.isArray(out.fields) || out.fields.length === 0) {
      out.fields = PO_SUMMARY_FIELDS.filter((f) => allowedSet.has(String(f).toLowerCase()));
    }
  }

  const combined = Array.from(new Set([...labelPicked, ...hintPicked, ...bundlePicked, ...autoBundlePicked]));
  const userPickedAny = combined.length > 0;

  const ensureIdentifiers = (fields) => {
    const outFields = Array.isArray(fields) ? [...fields] : [];
    const allowedSet = new Set(allowedFields.map((f) => String(f).toLowerCase()));

    for (const identifier of ["PoNo", "PoItem"]) {
      if (
        allowedSet.has(String(identifier).toLowerCase()) &&
        !outFields.some((field) => String(field).toLowerCase() === String(identifier).toLowerCase())
      ) {
        outFields.unshift(identifier);
      }
    }

    return Array.from(new Set(outFields));
  };

  const isNextQuery = /\b(next|more|another|load)\b/i.test(qNorm);
  const hasExplicitFieldRequest = /\b(price|net\s*price|amount|value|currency|date|created|vendor|supplier|volume|weight|quantity|unit|material|plant|storage|company\s*code)\b/i.test(
    qNorm
  );

  const isGenericPoListQuery =
    intent &&
    !out.docNumber &&
    !out.docItem &&
    /^(show|list|get)\s+(all\s+)?(latest\s+|recent\s+|most\s+recent\s+)?(po|purchase\s*order[s]?)\b/.test(qNorm);

  if (isNextQuery || isGenericPoListQuery || (intent && !out.docNumber && !userPickedAny)) {
    const summaryFields = PO_SUMMARY_FIELDS.filter((field) =>
      allowedFields.some((allowedField) => String(allowedField).toLowerCase() === String(field).toLowerCase())
    );
    const genericListFields = GENERIC_PO_LIST_FIELDS.filter((field) =>
      allowedFields.some((allowedField) => String(allowedField).toLowerCase() === String(field).toLowerCase())
    );

    if (isGenericPoListQuery) {
      out.fields = ensureIdentifiers(genericListFields.length > 0 ? genericListFields : GENERIC_PO_LIST_FIELDS);
    } else {
      out.fields = ensureIdentifiers(combined.length > 0 ? combined : summaryFields);
    }

    if (out.fields.length === 0) {
      out.fields = ensureIdentifiers(GENERIC_PO_LIST_FIELDS);
    }

    return out;
  }

  if (combined.length > 0) {
    out.fields = ensureIdentifiers(combined);
    return out;
  }

  if (out.docNumber && (!out.fields || out.fields.length === 0)) {
    const detailDefaults = extractFieldsByBundles("details", allowedFields);
    if (detailDefaults.length > 0) {
      out.fields = ensureIdentifiers(detailDefaults);
      return out;
    }
  }

  if (needsStructuredPoFallback) {
    const normalizedPrompt = await normalizePromptWithLlm({ query: truncated });
    const structuredMessage =
      String(normalizedPrompt?.normalizedQuery || "").trim() || truncated;

    const parsed = await callPoStructuredExtractorLLM({
      message: structuredMessage,
      allowedFields,
      fieldLabels,
    });

    if (parsed && typeof parsed === "object") {
      const parsedConfidence = Number(parsed.confidence || 0);
      const parsedReject = parsed.shouldReject === true;

      if (!parsedReject && parsedConfidence >= 0.35) {
        const allowedMap = new Map(allowedFields.map((f) => [String(f).toLowerCase(), f]));

        const parsedFields = Array.isArray(parsed.fields) ? parsed.fields : [];
        const llmFields = parsedFields
          .map((f) => allowedMap.get(String(f).toLowerCase()))
          .filter(Boolean);
        if (llmFields.length > 0) out.fields = llmFields;

        const parsedDocNumber =
          (typeof parsed.docNumber === "string" && parsed.docNumber.trim()
            ? parsed.docNumber.trim()
            : null) ||
          (typeof parsed.poNumber === "string" && parsed.poNumber.trim()
            ? parsed.poNumber.trim()
            : null);
        if (parsedDocNumber) out.docNumber = parsedDocNumber;

        const parsedItem = parsed.docItem ?? parsed.poItem ?? null;
        out.docItem = normalizePoItem(parsedItem) || out.docItem;

        const parsedFilters = Array.isArray(parsed.filters) ? parsed.filters : [];
        if (parsedFilters.length > 0) {
          out.filters = parsedFilters
            .map((f) => {
              if (!f || typeof f !== "object") return null;
              const field = String(f.field || "").trim();
              const op = String(f.op || "").trim().toLowerCase();
              const type = String(f.type || "string").trim().toLowerCase();
              const value = f.value;
              if (!field || value == null) return null;
              if (!["eq", "ne", "gt", "ge", "lt", "le"].includes(op)) return null;
              if (!["string", "number", "boolean", "datetime"].includes(type)) return null;

              const normalizedField =
                allowedMap.get(field.toLowerCase()) ||
                (field.toLowerCase() === "usercreated" ? "UserCreated" : null);
              if (!normalizedField) return null;

              return { field: normalizedField, op, type, value };
            })
            .filter(Boolean);
        }

        const parsedOrderBy = Array.isArray(parsed.orderBy) ? parsed.orderBy : [];
        if (parsedOrderBy.length > 0) {
          out.orderBy = parsedOrderBy
            .map((o) => {
              if (!o || typeof o !== "object") return null;
              const field = String(o.field || "").trim();
              if (!field) return null;

              const normalizedField =
                allowedMap.get(field.toLowerCase()) ||
                (field.toLowerCase() === "crtdate" ? "CrtDate" : null);
              if (!normalizedField) return null;

              const dir = String(o.dir || "asc").toLowerCase() === "desc" ? "desc" : "asc";
              return { field: normalizedField, dir };
            })
            .filter(Boolean);
        }

        if (parsed.listMode) out.listMode = String(parsed.listMode).trim() || out.listMode;
        if (Number.isFinite(Number(parsed.limit))) out.limit = Number(parsed.limit);
        if (Number.isFinite(Number(parsed.skip))) out.skip = Number(parsed.skip);
        if (parsed.count === true) out.count = true;

        if (out.docNumber && (!out.fields || out.fields.length === 0)) {
          const detailDefaults = extractFieldsByBundles("details", allowedFields);
          if (detailDefaults.length > 0) out.fields = detailDefaults;
        }

        if (out.filters.length > 0 || out.docNumber || out.docItem || out.orderBy.length > 0) {
          return out;
        }
      }
    }
  }

  const parsed = await callExtractorLLM({ message: truncated, allowedFields });
  if (!parsed) return out;

  const parsedDocNumber =
    (typeof parsed.docNumber === "string" && parsed.docNumber.trim() ? parsed.docNumber.trim() : null) ||
    (typeof parsed.poNumber === "string" && parsed.poNumber.trim() ? parsed.poNumber.trim() : null);

  if (parsedDocNumber) out.docNumber = parsedDocNumber;

  const parsedItem = parsed.docItem ?? parsed.poItem ?? null;
  out.docItem = normalizePoItem(parsedItem) || out.docItem;

  const allowedMap = new Map(allowedFields.map((f) => [String(f).toLowerCase(), f]));
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  out.fields = fields.map((f) => allowedMap.get(String(f).toLowerCase())).filter(Boolean);

  if (out.docNumber && (!out.fields || out.fields.length === 0)) {
    const detailDefaults = extractFieldsByBundles("details", allowedFields);
    if (detailDefaults.length > 0) {
      out.fields = detailDefaults;
    }
  }

  return out;
}

export async function extractPoQuery({ query, allowedFields, fieldLabels }) {
  const r = await extractDocQuery({ query, allowedFields, fieldLabels });
  console.log("EXTRACTOR OUTPUT:", JSON.stringify(r, null, 2));
  return {
    fields: r.fields,
    poNumber: r.docNumber,
    poItem: r.docItem,
    filters: r.filters,
    orderBy: r.orderBy,
    limit: r.limit,
    skip: r.skip,
    listMode: r.listMode,
    docType: r.docType,
    docNumber: r.docNumber,
    docItem: r.docItem,
    count: r.count,
  };
}