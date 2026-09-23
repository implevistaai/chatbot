import { ChatSession } from "../../../models/ChatSession.model.js";
import { getWeekDateRange } from "../../../services/filters/dateFilters.js";
import { saveAssistantMessage, step } from "../stream.shared.js";

export function cleanString(v) {
  return String(v || "").trim();
}

function normalizeSolmanQueryText(query = "") {
  return cleanString(query)
    .toLowerCase()
    .replace(/\bc\.?r\.?['’]?s?\b/g, "cr")
    .replace(/\bchange requests?\b/g, "cr")
    .replace(/\bcurrent\b/g, "this")
    .replace(/\bpast\b/g, "last")
    .replace(/\brejected\b/g, "withdrawn")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSolmanStatusValue(value = "") {
  const status = cleanString(value).toLowerCase();

  if (!status) return "";
  if (status === "rejected") return "WITHDRAWN";
  if (status === "withdrawn") return "WITHDRAWN";

  return status.toUpperCase();
}

function findDateCandidate(text = "") {
  const patterns = [
    /\b\d{4}[./-]\d{2}[./-]\d{2}\b/,
    /\b\d{2}[./-]\d{2}[./-]\d{4}\b/,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/i,
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
  ];

  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return match[0];
  }

  return "";
}

export function normalizeSapUsername(value = "") {
  return cleanString(value).toUpperCase();
}

export function pickCreateCrEntities(raw = {}) {
  return {
    ShortDesc: String(raw.ShortDesc || raw.shortDesc || "").trim(),
    DeliveryResponsible: String(raw.DeliveryResponsible || raw.deliveryResponsible || "").trim(),
    Developer: String(raw.Developer || raw.developer || "").trim(),
    Tester: String(raw.Tester || raw.tester || "").trim(),
    WorkItemReference: String(raw.WorkItemReference || raw.workItemReference || "").trim(),
    Landscape: String(raw.Landscape || raw.landscape || "").trim(),
    REQ_URL_NAV: Array.isArray(raw.REQ_URL_NAV) ? raw.REQ_URL_NAV : [],
  };
}

export function getMissingCreateCrFields(payload = {}) {
  const required = [
    "ShortDesc",
    "DeliveryResponsible",
    "Developer",
    "Tester",
    "WorkItemReference",
    "Landscape",
  ];

  return required.filter((key) => !String(payload?.[key] || "").trim());
}

export function resolveBusinessScope(query = "", raw = {}) {
  const explicit = cleanString(
    raw.businessScope || raw.scope || raw.region || raw.processScope
  ).toUpperCase();

  const q = cleanString(query).toLowerCase();

  if (explicit === "ROW") {
    return { label: "ROW", processType: "YMHF" };
  }

  if (explicit === "INDIA") {
    return { label: "INDIA", processType: "YMH1" };
  }

  if (cleanString(raw.processType || raw.PROCESS_TYPE).toUpperCase() === "YMHF") {
    return { label: "ROW", processType: "YMHF" };
  }

  if (cleanString(raw.processType || raw.PROCESS_TYPE).toUpperCase() === "YMH1") {
    return { label: "INDIA", processType: "YMH1" };
  }

  if (/\brow\b/.test(q)) {
    return { label: "ROW", processType: "YMHF" };
  }

  if (/\bindia\b/.test(q)) {
    return { label: "INDIA", processType: "YMH1" };
  }

  return null;
}

export function pickCrDetailsEntities(raw = {}, query = "") {
  const scope = resolveBusinessScope(query, raw);
  const queryCrNumber = String(query || "").match(/\b(?:cr|change request)\s*(?:number\s*)?(\d{6,20})\b/i)?.[1] || "";
  const rawCrNumber = String(
    raw.objectId ||
      raw.OBJECT_ID ||
      raw.OBJ_ID ||
      raw.changeRequestId ||
      raw.crId ||
      raw.crNumber ||
      ""
  ).trim();

  return {
    objectId: queryCrNumber || rawCrNumber,
    processType: String(
      raw.processType || raw.PROCESS_TYPE || scope?.processType || ""
    ).trim(),
    businessScope: scope?.label || "",
  };
}

export function toCrDetailsArray(result) {
  if (Array.isArray(result?.results)) return result.results;
  if (Array.isArray(result?.result?.results)) return result.result.results;
  if (Array.isArray(result?.data?.results)) return result.data.results;
  if (Array.isArray(result?.raw?.d?.results)) return result.raw.d.results;
  if (Array.isArray(result?.d?.results)) return result.d.results;
  if (result?.raw?.d && !Array.isArray(result.raw.d.results)) return [result.raw.d];
  if (result?.d && !Array.isArray(result.d.results)) return [result.d];
  return [];
}

export function formatDisplayDate(value) {
  const s = cleanString(value);

  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s.replaceAll("-", "/");
  }

  return s || "-";
}

function parseSummaryDate(value) {
  const s = cleanString(value);
  if (!s) return null;

  if (/^\d{8}$/.test(s)) {
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : native;
}

function formatSummaryDate(value) {
  const date = parseSummaryDate(value);
  if (!date) return cleanString(value);

  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(date);

  const day = parts.find((part) => part.type === "day")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const year = parts.find((part) => part.type === "year")?.value || "";

  return [day, month, year].filter(Boolean).join("-");
}

function normalizeStatusSummaryValue({ status = "", statusMode = "", excludeStatuses = [] }) {
  const cleanStatus = cleanString(status);
  const cleanStatusMode = cleanString(statusMode).toLowerCase();

  if (cleanStatusMode === "pending" || Array.isArray(excludeStatuses) && excludeStatuses.length > 0) {
    return "Open / Pending";
  }

  if (cleanStatus) {
    return cleanStatus.charAt(0).toUpperCase() + cleanStatus.slice(1).toLowerCase();
  }

  return "";
}

export function buildSolmanAppliedFiltersSummary({
  status = "",
  statusMode = "",
  excludeStatuses = [],
  fromDate = "",
  toDate = "",
  createdBy = "",
  businessScope = "",
} = {}) {
  const lines = [];

  const statusLabel = normalizeStatusSummaryValue({ status, statusMode, excludeStatuses });
  if (statusLabel) {
    lines.push(`Status: ${statusLabel}`);
  }

  const cleanFromDate = cleanString(fromDate);
  const cleanToDate = cleanString(toDate);
  if (cleanFromDate || cleanToDate) {
    const start = formatSummaryDate(cleanFromDate || cleanToDate);
    const end = formatSummaryDate(cleanToDate || cleanFromDate);
    lines.push(`Date Range: ${start}${start === end ? "" : ` to ${end}`}`);
  }

  const cleanCreatedBy = cleanString(createdBy);
  if (cleanCreatedBy) {
    lines.push(`Created By: ${cleanCreatedBy}`);
  }

  const cleanBusinessScope = cleanString(businessScope);
  if (cleanBusinessScope) {
    lines.push(`Business Scope: ${cleanBusinessScope}`);
  }

  return lines.join("\n");
}

export function getCrNumber(item = {}) {
  return cleanString(item?.OBJECT_ID || item?.OBJ_ID || "-");
}

export function formatCrDetailsReply(item) {
  return [
    `CR Number: ${getCrNumber(item)}`,
    `Short Description: ${item?.SHORT_DESC || "-"}`,
    `Status: ${item?.STATUS || "-"}`,
    `Priority: ${item?.PRIORITY || "-"}`,
    `Process Type: ${item?.PROCESS_TYPE || "-"}`,
    `Created On: ${formatDisplayDate(item?.CREATED_ON)}`,
    `Last Changed By: ${item?.LAST_CHANGED_BY || "-"}`,
    `Last Changed At: ${item?.LAST_CHANGED_AT || "-"}`,
    `Category: ${item?.CATEGORY || "-"}`,
  ].join("\n");
}

export function getDaysInMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatSapYmd(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function addMonths(date, months) {
  const value = new Date(date);
  const dayOfMonth = value.getDate();
  value.setDate(1);
  value.setMonth(value.getMonth() + months);
  value.setDate(Math.min(dayOfMonth, getDaysInMonth(value.getFullYear(), value.getMonth())));

  return value;
}

function addYears(date, years) {
  const value = new Date(date);
  const month = value.getMonth();
  const dayOfMonth = value.getDate();
  value.setDate(1);
  value.setFullYear(value.getFullYear() + years);
  value.setMonth(month);
  value.setDate(Math.min(dayOfMonth, getDaysInMonth(value.getFullYear(), month)));

  return value;
}

function startOfWeek(date) {
  const value = startOfDay(date);
  const day = value.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(value, diff);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfWeek(date) {
  return addDays(startOfWeek(date), 6);
}

function endOfMonth(date) {
  const value = startOfDay(date);
  return new Date(value.getFullYear(), value.getMonth() + 1, 0);
}

function endOfYear(date) {
  const value = startOfDay(date);
  return new Date(value.getFullYear(), 11, 31);
}

function getSundayStartWeekRange(year, weekNumber) {
  const startOfYearDate = new Date(year, 0, 1);
  const firstSunday = new Date(startOfYearDate);
  firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay());

  const start = addDays(firstSunday, (weekNumber - 1) * 7);
  const end = addDays(start, 6);

  return { start, end };
}

function parseWeekNumber(query = "") {
  const q = cleanString(query).toLowerCase();
  if (!q) return null;

  const ordinalMap = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
    twentyfirst: 21,
    twentysecond: 22,
    twentythird: 23,
    twentyfourth: 24,
    twentyfifth: 25,
    twentysixth: 26,
    twentyseventh: 27,
    twentyeighth: 28,
    twentyninth: 29,
    thirtieth: 30,
    thirtyfirst: 31,
    thirtysecond: 32,
    thirtythird: 33,
    thirtyfourth: 34,
    thirtyfifth: 35,
    thirtysixth: 36,
    thirtyseventh: 37,
    thirtyeighth: 38,
    thirtyninth: 39,
    fortieth: 40,
    fortyfirst: 41,
    fortysecond: 42,
    fortythird: 43,
    fortyfourth: 44,
    fortyfifth: 45,
    fortysixth: 46,
    fortyseventh: 47,
    fortyeighth: 48,
    fortyninth: 49,
    fiftieth: 50,
    fiftyfirst: 51,
    fiftysecond: 52,
    fiftythird: 53,
  };

  let match = q.match(/\bweek\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (match) return Number(match[1]);

  match = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+week\b/);
  if (match) return Number(match[1]);

  match = q.match(/\b(?:the\s+)?([a-z]+)\s+week\b/);
  if (match) {
    const compact = match[1].replace(/\s+/g, "");
    if (Object.prototype.hasOwnProperty.call(ordinalMap, compact)) {
      return ordinalMap[compact];
    }
  }

  return null;
}

function makeDatePeriod(period, startDate, endDate) {
  return {
    period,
    startDate: formatSapYmd(startDate),
    endDate: formatSapYmd(endDate),
    fromDate: formatSapYmd(startDate),
    toDate: formatSapYmd(endDate),
    granularity:
      period === "date" || period.includes("day")
        ? "day"
        : period.includes("week")
          ? "week"
          : period.includes("month")
            ? "month"
            : period.includes("year")
              ? "year"
              : "range",
  };
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

  m = /^(\d{1,2})[-\s](jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[-\s](\d{4})$/i.exec(s);
  if (m) {
    const monthIndex = monthNameToIndex(m[2]);
    if (monthIndex >= 0) {
      return new Date(Number(m[3]), monthIndex, Number(m[1]));
    }
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : native;
}

function formatDateYmd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeDateRange(startDate, endDate) {
  if (!startDate || !endDate) return null;

  const normalizedStart = startOfDay(startDate);
  const normalizedEnd = startOfDay(endDate);
  const from = normalizedStart <= normalizedEnd ? normalizedStart : normalizedEnd;
  const to = normalizedStart <= normalizedEnd ? normalizedEnd : normalizedStart;

  return {
    fromDate: formatDateYmd(from),
    toDate: formatDateYmd(to),
  };
}

function ymdStringToDate(value) {
  const s = String(value || "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

export function inferDateRangeFromQuery(query = "") {
  const q = normalizeSolmanQueryText(query);

  if (!q) return null;

  const today = startOfDay(new Date());

  const weekNumber = parseWeekNumber(q);
  if (weekNumber != null) {
    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) {
      return {
        error: "Invalid week number. Please enter a week between 1 and 53.",
      };
    }

    const year = today.getFullYear();
    const { start, end } = getSundayStartWeekRange(year, weekNumber);
    const firstSunday = getSundayStartWeekRange(year, 1).start;
    const maxWeeks = Math.floor((endOfYear(today) - firstSunday) / (7 * 24 * 60 * 60 * 1000)) + 1;

    if (weekNumber > maxWeeks) {
      return {
        error: "Invalid week number. Please enter a week between 1 and 53.",
      };
    }

    return makeDatePeriod(`week_${weekNumber}`, start, end);
  }

  const exactDateCandidate = findDateCandidate(q);
  const hasRangeKeyword = /\b(?:between|from|after|before|since)\b/.test(q);
  if (!hasRangeKeyword && exactDateCandidate) {
    const exactDate = parseUserDate(exactDateCandidate);
    if (exactDate) {
      const normalized = normalizeDateRange(exactDate, exactDate);
      return makeDatePeriod("date", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const cleanQuery = q
    .replace(/\b(show|display|list|retrieve|get|fetch|created|creation|crs?|change request[s]?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const yearRangeMatch = cleanQuery.match(/\b(?:from|between)\s+(20\d{2})\s+(?:to|and|- )\s+(20\d{2})\b/);
  if (yearRangeMatch) {
    const fromYear = Number(yearRangeMatch[1]);
    const toYear = Number(yearRangeMatch[2]);
    const lowYear = Math.min(fromYear, toYear);
    const highYear = Math.max(fromYear, toYear);

    return makeDatePeriod(
      `between_${lowYear}_${highYear}`,
      new Date(lowYear, 0, 1),
      new Date(highYear, 11, 31)
    );
  }

  if (/\btoday(?:'s)?\b/.test(cleanQuery)) {
    return makeDatePeriod("today", today, today);
  }

  if (/\byesterday(?:'s)?\b/.test(cleanQuery)) {
    const yesterday = addDays(today, -1);
    return makeDatePeriod("yesterday", yesterday, yesterday);
  }

  if (/\bthis week\b/.test(cleanQuery)) {
    const { startOfWeek, endOfWeek } = getWeekDateRange(today, 0);
    return makeDatePeriod("this_week", startOfWeek, endOfWeek);
  }

  if (/\blast week\b/.test(cleanQuery)) {
    const { startOfWeek, endOfWeek } = getWeekDateRange(today, -1);
    const start = startOfWeek;
    const end = endOfWeek;
    return makeDatePeriod("last_week", start, end);
  }

  if (/\bnext week\b/.test(cleanQuery)) {
    const { startOfWeek, endOfWeek } = getWeekDateRange(today, 1);
    return makeDatePeriod("next_week", startOfWeek, endOfWeek);
  }

  if (/\bthis month\b/.test(cleanQuery)) {
    return makeDatePeriod("this_month", startOfMonth(today), today);
  }

  if (/\blast month\b/.test(cleanQuery)) {
    const start = startOfMonth(addMonths(today, -1));
    const end = endOfMonth(addMonths(today, -1));
    return makeDatePeriod("last_month", start, end);
  }

  if (/\bthis year\b/.test(cleanQuery)) {
    return makeDatePeriod("this_year", new Date(today.getFullYear(), 0, 1), today);
  }

  if (/\blast year\b/.test(cleanQuery)) {
    const priorYear = today.getFullYear() - 1;
    return makeDatePeriod("last_year", new Date(priorYear, 0, 1), new Date(priorYear, 11, 31));
  }

  const relativeMatch = cleanQuery.match(
    /\blast\s+(\d+)\s+(days?|weeks?|months?|years?)\b/
  );
  if (relativeMatch) {
    const amount = Math.max(1, Number(relativeMatch[1]));
    const unit = relativeMatch[2].replace(/s$/, "");

    if (unit === "day") {
      return makeDatePeriod(`last_${amount}_days`, addDays(today, -amount), today);
    }

    if (unit === "week") {
      return makeDatePeriod(`last_${amount}_weeks`, addDays(today, -(amount * 7)), today);
    }

    if (unit === "month") {
      return makeDatePeriod(`last_${amount}_months`, addMonths(today, -amount), today);
    }

    if (unit === "year") {
      return makeDatePeriod(`last_${amount}_years`, addYears(today, -amount), today);
    }
  }

  const betweenDateMatch = cleanQuery.match(
    /\bbetween\s+(.+?)\s+(?:and|to|-)\s+(.+)/
  );
  if (betweenDateMatch) {
    const from = parseUserDate(betweenDateMatch[1]);
    const to = parseUserDate(betweenDateMatch[2]);
    if (from && to) {
      const normalized = normalizeDateRange(from, to);
      return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const fromToMatch = cleanQuery.match(/\bfrom\s+(.+?)\s+(?:to|-)\s+(.+)/);
  if (fromToMatch) {
    const from = parseUserDate(fromToMatch[1]);
    const to = parseUserDate(fromToMatch[2]);
    if (from && to) {
      const normalized = normalizeDateRange(from, to);
      return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const sinceMatch = cleanQuery.match(/\b(?:since|after)\s+(.+)/);
  if (sinceMatch) {
    const from = parseUserDate(sinceMatch[1]);
    if (from) {
      const adjustedFrom = /\bafter\b/.test(cleanQuery) ? addDays(startOfDay(from), 1) : startOfDay(from);
      const normalized = normalizeDateRange(adjustedFrom, today);
      return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const beforeMatch = cleanQuery.match(/\bbefore\s+(.+)/);
  if (beforeMatch) {
    const to = parseUserDate(beforeMatch[1]);
    if (to) {
      const normalized = normalizeDateRange(new Date(1900, 0, 1), addDays(startOfDay(to), -1));
      return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const betweenMatch = cleanQuery.match(/\bbetween\s+(.+?)\s+(?:and|to|-)\s+(.+)/);
  if (betweenMatch) {
    const from = parseUserDate(betweenMatch[1]);
    const to = parseUserDate(betweenMatch[2]);
    if (from && to) {
      const normalized = normalizeDateRange(from, to);
      return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
    }
  }

  const months = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  const monthMatch = cleanQuery.match(
    /\b(?:in\s+the\s+month\s+of|month\s+of|for)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/
  );

  if (monthMatch) {
    const monthName = monthMatch[1];
    const year = Number(monthMatch[2]);
    const month = months[monthName];
    const fromDate = `${year}${String(month).padStart(2, "0")}01`;
    const toDate = `${year}${String(month).padStart(2, "0")}${String(
      getDaysInMonth(year, month - 1)
    ).padStart(2, "0")}`;

    return {
      period: `month_${year}_${String(month).padStart(2, "0")}`,
      startDate: fromDate,
      endDate: toDate,
      fromDate,
      toDate,
      granularity: "month",
    };
  }

  const directDate = parseUserDate(q);
  if (
    directDate &&
    /^(?:\d{4}[./-]\d{2}[./-]\d{2}|\d{2}[./-]\d{2}[./-]\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+|,\s*)\d{4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})$/i.test(q)
  ) {
    return makeDatePeriod("day", startOfDay(directDate), startOfDay(directDate));
  }

  const singleDatePrefixMatch = cleanQuery.match(/\b(from|since|after|on)\s+(.+)/);
  if (singleDatePrefixMatch) {
    const prefix = singleDatePrefixMatch[1];
    const suffix = cleanString(singleDatePrefixMatch[2]);

    if (!/\b(?:to|and)\b|\bto\s+\d|\b-\s+\d/.test(suffix)) {
      const candidate = findDateCandidate(suffix) || suffix;
      const parsed = parseUserDate(candidate);

      if (parsed) {
        if (prefix === "on") {
          return makeDatePeriod("date", startOfDay(parsed), startOfDay(parsed));
        }

        const adjustedFrom = prefix === "after" ? addDays(startOfDay(parsed), 1) : startOfDay(parsed);
        const normalized = normalizeDateRange(adjustedFrom, today);
        return makeDatePeriod("range", ymdStringToDate(normalized.fromDate), ymdStringToDate(normalized.toDate));
      }
    }
  }

  const plainYearMatch = cleanQuery.match(/\b(?:in\s+the\s+year\s+of|year\s+of|for|in)\s+(20\d{2})\b/);
  if (plainYearMatch && /\b(cr|change request|status)\b/.test(q)) {
    const year = Number(plainYearMatch[1]);
    return {
      period: `year_${year}`,
      startDate: `${year}0101`,
      endDate: `${year}1231`,
      fromDate: `${year}0101`,
      toDate: `${year}1231`,
      granularity: "year",
    };
  }

  return null;
}

export function inferCrStatusFilterFromQuery(query = "") {
  const q = normalizeSolmanQueryText(query);

  if (!q) {
    return {
      status: "",
      excludeStatuses: [],
      statusMode: "",
    };
  }

  if (/\b(?:open|pending)\b/.test(q)) {
    return {
      status: "",
      excludeStatuses: ["CLOSED", "WITHDRAWN"],
      statusMode: "pending",
    };
  }

  const exactQuotedMatch = q.match(/"([^"]{3,})"|'([^']{3,})'/);
  const quotedStatus = cleanString(exactQuotedMatch?.[1] || exactQuotedMatch?.[2] || "");

  const known = [
    "ready for test",
    "approved for production",
    "imported in production",
    "tested ok",
    "closed",
    "rejected",
    "approved",
    "withdrawn",
    "in development",
    "in progress",
    "under implementation",
    "success",
    "completed",
  ];

  const statusCandidates = [quotedStatus, q].filter(Boolean);

  for (const candidate of statusCandidates) {
    for (const value of known) {
      const pattern = new RegExp(`\\b${value.replace(/\s+/g, "\\s+")}\\b`, "i");
      if (pattern.test(candidate)) {
        return {
          status: normalizeSolmanStatusValue(value),
          excludeStatuses: [],
          statusMode: "",
        };
      }
    }
  }

  return {
    status: "",
    excludeStatuses: [],
    statusMode: "",
  };
}

export function inferRequestedTop(query = "", fallback = 10) {
  const q = cleanString(query).toLowerCase();

  const nextMatch = q.match(/\b(?:show\s+)?next\s+(\d+)\b/);
  if (nextMatch) return Math.max(1, Number(nextMatch[1]));

  const explicitPatterns = [
    /\b(?:show|list|display|retrieve|get|fetch)\s+(?:the\s+)?(?:last|latest|most recent|top)\s+(\d+)\s*(?:change requests?|crs?)\b/,
    /\b(?:show|list|display|retrieve|get|fetch)\s+(?:the\s+)?(\d+)\s+(?:most recent|latest|last)\s*(?:change requests?|crs?)\b/,
    /\b(?:show|list|display|retrieve|get|fetch)\s+(?:the\s+)?top\s+(\d+)\s+(?:most recent\s+)?(?:change requests?|crs?)\b/,
    /\b(?:last|latest|most recent|top)\s+(\d+)\s*(?:change requests?|crs?)\b/,
  ];

  for (const pattern of explicitPatterns) {
    const match = q.match(pattern);
    if (match) {
      return Math.max(1, Number(match[1]));
    }
  }

  return fallback;
}

export function inferRequestedSkip(raw = {}, query = "") {
  if (raw?.skip != null && Number.isFinite(Number(raw.skip))) {
    return Math.max(0, Number(raw.skip));
  }

  const q = cleanString(query).toLowerCase();
  if (/\b(?:show\s+)?next\s+\d+\b/.test(q)) {
    return Math.max(0, Number(raw?.nextSkip || 0));
  }

  return 0;
}

export function isNextPageQuery(query = "") {
  const q = cleanString(query).toLowerCase();
  return /\b(?:show\s+)?next\s+\d+\b/.test(q);
}

export function inferCreatedByFilterFromQuery(query = "", raw = {}) {
  const normalizeCreatedByValue = (value = "") =>
    cleanString(value)
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^the\s+/i, "")
      .replace(/^(?:user(?:name)?|sap\s*user)\s+/i, "")
      .trim();

  const rawCreatedBy = cleanString(
    raw.createdBy ||
      raw.CREATED_BY ||
      raw.created_by ||
      raw.creator ||
      raw.CREATEDBY ||
      raw.user ||
      raw.username
  );

  if (rawCreatedBy) {
    const normalized = normalizeCreatedByValue(rawCreatedBy).toLowerCase();

    if (["me", "my", "mine", "myself"].includes(normalized)) {
      return {
        createdBy: "ME",
        createdByMode: "self",
      };
    }

    return {
      createdBy: normalizeSapUsername(normalized),
      createdByMode: "explicit",
    };
  }

  const q = normalizeSolmanQueryText(query);

  if (!q) {
    return {
      createdBy: "",
      createdByMode: "",
    };
  }

  if (
    /\bcreated by me\b/.test(q) ||
    /\bcreated by myself\b/.test(q) ||
    /\bshow my cr\b/.test(q) ||
    /\bshow my crs\b/.test(q) ||
    /\bmy cr\b/.test(q) ||
    /\bmy crs\b/.test(q) ||
    /\bmy change request\b/.test(q) ||
    /\bmy change requests\b/.test(q)
  ) {
    return {
      createdBy: "ME",
      createdByMode: "self",
    };
  }

  const createdByMatch = q.match(/\bcreated\s+by\s*(?:the\s+)?(?:user(?:name)?|sap\s*user)?\s*[:=]?\s*["'`]?([a-z0-9._-]+)["'`]?/i);
  if (createdByMatch) {
    return {
      createdBy: normalizeSapUsername(normalizeCreatedByValue(createdByMatch[1])),
      createdByMode: "explicit",
    };
  }

  return {
    createdBy: "",
    createdByMode: "",
  };
}

export function inferCrListIntent(classified, query = "") {
  const intent = cleanString(classified?.intent).toLowerCase();
  const q = normalizeSolmanQueryText(query);

  if (
    intent === "list_change_requests" ||
    intent === "get_change_request_status_list" ||
    intent === "get_change_request_status" ||
    intent === "list_change_request_status"
  ) {
    return true;
  }

  if (
    /\b(?:show\s+)?next\s+\d+\b/.test(q) ||
    /\bcr\b/.test(q) ||
    /\bchange request\b/.test(q) ||
    /\bchange requests\b/.test(q) ||
    /\bcr list\b/.test(q) ||
      /\bshow cr status\b/.test(q) ||
    /\bopen cr\b/.test(q) ||
    /\bapproved cr\b/.test(q) ||
    /\brejected cr\b/.test(q) ||
    /\bclosed cr\b/.test(q) ||
    /\bpending cr\b/.test(q) ||
    /\bpending\b/.test(q) ||
    /\bunder implementation\b/.test(q) ||
    /\blast\s+\d+\s+cr\b/.test(q) ||
    /\blast\s+\d+\s+cr\s+status\b/.test(q) ||
    /\bcreated in this week\b/.test(q) ||
    /\bcreated in this month\b/.test(q) ||
    /\bcreated in this year\b/.test(q) ||
    /\bcreated from\b/.test(q) ||
    /\bcreated by me\b/.test(q) ||
    /\bcreated by\b/.test(q) ||
    /\bmy cr\b/.test(q) ||
    /\bmy crs\b/.test(q) ||
    /\bmy change request\b/.test(q) ||
    /\bmy change requests\b/.test(q) ||
    /\bthis month\b/.test(q) ||
    /\blast month\b/.test(q) ||
    /\bthis year\b/.test(q) ||
    /\bin the month of\b/.test(q) ||
    /\btoday\b/.test(q) ||
    /\byesterday\b/.test(q) ||
    /\bmonth of\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/.test(q) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/.test(q) ||
    /\bin the year of\s+20\d{2}\b/.test(q) ||
    /\blast year\b/.test(q) ||
    /\blast\s+\d+\s+days?\b/.test(q) ||
    /\byear of\s+20\d{2}\b/.test(q) ||
    /\bdependency check\b/.test(q) ||
    /\bdependency analysis\b/.test(q) ||
    /\brow\b/.test(q) ||
    /\bindia\b/.test(q)
  ) {
    return true;
  }

  return false;
}

export function inferCrCreatedByIntent(query = "", raw = {}) {
  const q = cleanString(query).toLowerCase();

  const inferred = inferCreatedByFilterFromQuery(query, raw);

  if (inferred?.createdByMode === "self") {
    return {
      intent: "list_change_requests_by_created_by",
      createdBy: "ME",
      createdByMode: "self",
    };
  }

  if (inferred?.createdByMode === "explicit" && inferred?.createdBy) {
    return {
      intent: "list_change_requests_by_created_by",
      createdBy: inferred.createdBy,
      createdByMode: "explicit",
    };
  }

  if (
    /\bcreated by me\b/.test(q) ||
    /\bcreated by myself\b/.test(q) ||
    /\b(?:show|list|display|retrieve|get)\s+my\s+crs?\b/.test(q) ||
    /\b(?:show|list|display|retrieve|get)\s+my\s+change requests?\b/.test(q) ||
    /\b(?:show|list|display|retrieve|get)\s+my\s+submitted change requests?\b/.test(q) ||
    /\b(?:show|list|display|retrieve|get)\s+all\s+crs?\s+i\s+created\b/.test(q) ||
    /\bmy\s+crs?\b/.test(q) ||
    /\bmy\s+change requests?\b/.test(q) ||
    /\bmy\s+submitted change requests?\b/.test(q) ||
    /\bsubmitted change requests?\b/.test(q) ||
    /\bcrs?\s+i\s+created\b/.test(q) ||
    /\bchange requests?\s+i\s+created\b/.test(q)
  ) {
    return {
      intent: "list_change_requests_by_created_by",
      createdBy: "ME",
      createdByMode: "self",
    };
  }

  return null;
}

export function pickCrListEntities(raw = {}, query = "") {
  const q = normalizeSolmanQueryText(query);
  const scope = resolveBusinessScope(q, raw);
  const inferredDateRange = inferDateRangeFromQuery(q);
  const inferredStatus = inferCrStatusFilterFromQuery(q);
  const inferredCreatedBy = inferCreatedByFilterFromQuery(q, raw);
  const explicitRequestedTop = inferRequestedTop(q, null);

  const requestedTop =
    raw.top ??
    raw.limit ??
    explicitRequestedTop ??
    (isNextPageQuery(q) ? inferRequestedTop(q, 10) : null);

  const rawCreatedBy = cleanString(
    raw.createdBy ||
      raw.CREATED_BY ||
      raw.created_by ||
      raw.creator ||
      ""
  );

  const rawCreatedByMode = cleanString(raw.createdByMode || "");

  const displayOffset =
    raw.displayOffset != null && Number.isFinite(Number(raw.displayOffset))
      ? Math.max(0, Number(raw.displayOffset))
      : 0;

  const nextDisplayOffset =
    raw.nextDisplayOffset != null && Number.isFinite(Number(raw.nextDisplayOffset))
      ? Math.max(0, Number(raw.nextDisplayOffset))
      : displayOffset;

  return {
    businessScope: scope?.label || cleanString(raw.businessScope || raw.scope || ""),
    processType:
      cleanString(raw.processType || raw.PROCESS_TYPE || scope?.processType || "") || "",
    triggerAll: cleanString(raw.triggerAll || raw.TRIGGER_ALL || "X") || "X",
    dateValidationError: cleanString(inferredDateRange?.error || ""),
    fromDate: cleanString(raw.fromDate || raw.FROM_DATE || inferredDateRange?.fromDate || ""),
    toDate: cleanString(raw.toDate || raw.TO_DATE || inferredDateRange?.toDate || ""),
    status: normalizeSolmanStatusValue(raw.status || raw.STATUS || inferredStatus.status),
    excludeStatuses: Array.isArray(raw.excludeStatuses)
      ? raw.excludeStatuses.map((value) => normalizeSolmanStatusValue(value)).filter(Boolean)
      : inferredStatus.excludeStatuses,
    statusMode: cleanString(raw.statusMode || inferredStatus.statusMode || ""),
    createdBy: cleanString(rawCreatedBy || inferredCreatedBy.createdBy || ""),
    createdByMode: cleanString(rawCreatedByMode || inferredCreatedBy.createdByMode || ""),
    dateText: cleanString(raw.dateText || raw.dateRangeText || q),
    top: requestedTop,
    explicitCountRequested: Boolean(explicitRequestedTop),
    skip: inferRequestedSkip(raw, q),
    nextSkip:
      raw.nextSkip != null && Number.isFinite(Number(raw.nextSkip))
        ? Math.max(0, Number(raw.nextSkip))
        : 0,
    displayOffset,
    nextDisplayOffset,
    orderBy: cleanString(raw.orderBy || "CREATED_ON desc") || "CREATED_ON desc",
  };
}

export function padCell(value, width) {
  const s = cleanString(value || "-");
  if (s.length > width) return `${s.slice(0, Math.max(0, width - 1))}…`;
  return s.padEnd(width, " ");
}

export function formatCrListReply(rows = [], params = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const q = cleanString(params?.dateText || params?.query || "").toLowerCase();
    const weekMatch = q.match(/\b(?:week\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+week|(?:the\s+)?(thirteenth|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twentyfirst|twentysecond|twentythird|twentyfourth|twentyfifth|twentysixth|twentyseventh|twentyeighth|twentyninth|thirtieth|thirtyfirst|thirtysecond|thirtythird|thirtyfourth|thirtyfifth|thirtysixth|thirtyseventh|thirtyeighth|thirtyninth|fortieth|fortyfirst|fortysecond|fortythird|fortyfourth|fortyfifth|fortysixth|fortyseventh|fortyeighth|fortyninth|fiftieth|fiftyfirst|fiftysecond|fiftythird)\s+week)\b/);
    const wordWeekToNumber = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
      ninth: 9,
      tenth: 10,
      eleventh: 11,
      twelfth: 12,
      thirteenth: 13,
      fourteenth: 14,
      fifteenth: 15,
      sixteenth: 16,
      seventeenth: 17,
      eighteenth: 18,
      nineteenth: 19,
      twentieth: 20,
      twentyfirst: 21,
      twentysecond: 22,
      twentythird: 23,
      twentyfourth: 24,
      twentyfifth: 25,
      twentysixth: 26,
      twentyseventh: 27,
      twentyeighth: 28,
      twentyninth: 29,
      thirtieth: 30,
      thirtyfirst: 31,
      thirtysecond: 32,
      thirtythird: 33,
      thirtyfourth: 34,
      thirtyfifth: 35,
      thirtysixth: 36,
      thirtyseventh: 37,
      thirtyeighth: 38,
      thirtyninth: 39,
      fortieth: 40,
      fortyfirst: 41,
      fortysecond: 42,
      fortythird: 43,
      fortyfourth: 44,
      fortyfifth: 45,
      fortysixth: 46,
      fortyseventh: 47,
      fortyeighth: 48,
      fortyninth: 49,
      fiftieth: 50,
      fiftyfirst: 51,
      fiftysecond: 52,
      fiftythird: 53,
    };

    if (weekMatch) {
      const weekNumber = Number(weekMatch[1] || weekMatch[2] || wordWeekToNumber[cleanString(weekMatch[3]).toLowerCase()] || 0);
      if (weekNumber >= 1 && weekNumber <= 53) {
        return `No Change Requests found for Week ${weekNumber}.`;
      }
    }

    return "No records found for the given criteria.";
  }

  const header = [`Found ${rows.length} change request(s).`];

  const widths = {
    no: 10,
    cr: 16,
    status: 26,
    createdOn: 14,
    shortDesc: 50,
  };

  const tableHeader = [
    padCell("S.N", widths.no),
    padCell("CR Number", widths.cr),
    padCell("Status", widths.status),
    padCell("Created On", widths.createdOn),
    padCell("Short Description", widths.shortDesc),
  ].join(" | ");

  const body = rows
    .map((item, index) =>
      [
        padCell(
          String(
            ((params?.displayOffset ?? params?.skip) || 0) + index + 1
          ),
          widths.no
        ),
        padCell(getCrNumber(item), widths.cr),
        padCell(item?.STATUS || "-", widths.status),
        padCell(formatDisplayDate(item?.CREATED_ON), widths.createdOn),
        padCell(item?.SHORT_DESC || "-", widths.shortDesc),
      ].join(" | ")
    )
    .join("\n");

  return `${header.join("\n")}\n\n${tableHeader}\n${body}`;
}

export function buildPaginationSuggestions(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return [
    "Load more records",
  ];
}

export function buildCrSuggestions(query = "", scopeLabel = "", rows = []) {
  const q = cleanString(query).toLowerCase();
  const crNumber = cleanString(getCrNumber(Array.isArray(rows) ? rows[0] : null));
  const crLabel = crNumber || "the CR from the result";
  const scopePrefix = cleanString(scopeLabel) ? `${cleanString(scopeLabel)} ` : "";

  const suggestions = [
    `Show transport for the CR ${crLabel}`,
    `Show dependency check for the CR ${crLabel}`,
    `Show CR created last month`,
  ];

  if (q.includes("week")) {
    suggestions[2] = `Show CR created last week`;
  } else if (q.includes("yesterday")) {
    suggestions[2] = `Show CR created yesterday`;
  }

  if (scopePrefix) {
    return suggestions.map((suggestion) => suggestion.replace(/^Show /, `Show ${scopePrefix}`));
  }

  return suggestions;
}

export async function persistAssistantAndTouchSession({
  owner,
  sessionId,
  text,
  summary,
  extracted,
  data,
  responseMeta,
}) {
  await step("save assistant message", () =>
    saveAssistantMessage({
      owner,
      sessionId,
      text,
      summary,
      extracted,
      data,
      responseMeta,
    })
  );

  await step("update ChatSession updatedAt", () =>
    ChatSession.updateOne(
      { _id: sessionId },
      { $set: { updatedAt: new Date() } }
    )
  );
}

// =========================
// CR Status Analytics Helpers
// =========================

export function normalizeStatusValue(value = "") {
  return cleanString(value).toLowerCase().replace(/\s+/g, " ");
}

export function getCrStatus(item = {}) {
  return cleanString(
    item?.STATUS ||
      item?.STATU ||
      item?.CR_STATUS ||
      item?.CHANGEREQUEST_STATUS ||
      item?.STATUS_TEXT ||
      item?.STATUSNAME ||
      item?.STATE ||
      ""
  );
}

export function groupCrStatusCounts(rows = []) {
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const status = normalizeStatusValue(getCrStatus(row));
    const key = status || "unknown";
    map.set(key, (map.get(key) || 0) + 1);
  }

  return Array.from(map.entries()).map(([status, count]) => ({
    status,
    count,
  }));
}

export function calculatePercentage(count, total) {
  if (!total || total <= 0) return 0;
  return Math.round((count / total) * 100);
}

export function buildStatusDistributionChart(rows = [], meta = {}) {
  const totalCRs = Array.isArray(rows) ? rows.length : 0;
  const grouped = groupCrStatusCounts(rows);

  return {
    type: "status_distribution",
    chartType: "donut",
    title: meta.title || "CR Status Distribution",
    totalCRs,
    filters: meta.filters || {},
    data: grouped.map((item) => ({
      status: item.status,
      count: item.count,
      percentage: calculatePercentage(item.count, totalCRs),
    })),
  };
}

export function getSolmanCrStatusMaxRows(defaultValue = 30) {
  const configuredValue = Number(process.env.SOLMAN_CR_STATUS_MAX_ROWS || defaultValue);

  if (!Number.isFinite(configuredValue) || configuredValue <= 0) {
    return defaultValue;
  }

  return Math.min(Math.floor(configuredValue), 500);
}