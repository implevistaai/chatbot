export { handleSolmanChatStream } from "./solman/index.js";

// import { ChatSession } from "../../models/ChatSession.model.js";
// import { SapSystem } from "../../models/SapSystem.model.js";
// import {
//   createSolmanChangeRequest,
//   getSolmanChangeRequestDetailsById,
//   listSolmanChangeRequestsByDateRange,
// } from "../../services/systems/solman/charm.service.js";

// import {
//   getOrCreateSession,
//   getSapAuthOrThrow,
//   normalizeSapUser,
//   normalizeSystemId,
//   saveAssistantMessage,
//   saveUserMessage,
//   step,
// } from "./stream.shared.js";

// function cleanString(v) {
//   return String(v || "").trim();
// }

// function pickCreateCrEntities(raw = {}) {
//   return {
//     ShortDesc: String(raw.ShortDesc || raw.shortDesc || "").trim(),
//     DeliveryResponsible: String(raw.DeliveryResponsible || raw.deliveryResponsible || "").trim(),
//     Developer: String(raw.Developer || raw.developer || "").trim(),
//     Tester: String(raw.Tester || raw.tester || "").trim(),
//     WorkItemReference: String(raw.WorkItemReference || raw.workItemReference || "").trim(),
//     Landscape: String(raw.Landscape || raw.landscape || "").trim(),
//     REQ_URL_NAV: Array.isArray(raw.REQ_URL_NAV) ? raw.REQ_URL_NAV : [],
//   };
// }

// function getMissingCreateCrFields(payload = {}) {
//   const required = [
//     "ShortDesc",
//     "DeliveryResponsible",
//     "Developer",
//     "Tester",
//     "WorkItemReference",
//     "Landscape",
//   ];

//   return required.filter((key) => !String(payload?.[key] || "").trim());
// }

// function resolveBusinessScope(query = "", raw = {}) {
//   const explicit = cleanString(
//     raw.businessScope || raw.scope || raw.region || raw.processScope
//   ).toUpperCase();

//   const q = cleanString(query).toLowerCase();

//   if (explicit === "ROW") {
//     return { label: "ROW", processType: "YMHF" };
//   }

//   if (explicit === "INDIA") {
//     return { label: "INDIA", processType: "YMH1" };
//   }

//   if (cleanString(raw.processType || raw.PROCESS_TYPE).toUpperCase() === "YMHF") {
//     return { label: "ROW", processType: "YMHF" };
//   }

//   if (cleanString(raw.processType || raw.PROCESS_TYPE).toUpperCase() === "YMH1") {
//     return { label: "INDIA", processType: "YMH1" };
//   }

//   if (/\brow\b/.test(q)) {
//     return { label: "ROW", processType: "YMHF" };
//   }

//   if (/\bindia\b/.test(q)) {
//     return { label: "INDIA", processType: "YMH1" };
//   }

//   return null;
// }

// function pickCrDetailsEntities(raw = {}, query = "") {
//   const scope = resolveBusinessScope(query, raw);

//   return {
//     objectId: String(
//       raw.objectId ||
//         raw.OBJECT_ID ||
//         raw.OBJ_ID ||
//         raw.changeRequestId ||
//         raw.crId ||
//         raw.crNumber ||
//         ""
//     ).trim(),
//     processType: String(
//       raw.processType || raw.PROCESS_TYPE || scope?.processType || ""
//     ).trim(),
//     businessScope: scope?.label || "",
//   };
// }

// function toCrDetailsArray(result) {
//   if (Array.isArray(result?.results)) return result.results;
//   if (Array.isArray(result?.result?.results)) return result.result.results;
//   if (Array.isArray(result?.data?.results)) return result.data.results;
//   if (Array.isArray(result?.raw?.d?.results)) return result.raw.d.results;
//   if (Array.isArray(result?.d?.results)) return result.d.results;
//   if (result?.raw?.d && !Array.isArray(result.raw.d.results)) return [result.raw.d];
//   if (result?.d && !Array.isArray(result.d.results)) return [result.d];
//   return [];
// }

// function formatDisplayDate(value) {
//   const s = cleanString(value);

//   if (/^\d{8}$/.test(s)) {
//     return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
//   }

//   return s || "-";
// }

// function getCrNumber(item = {}) {
//   return cleanString(item?.OBJECT_ID || item?.OBJ_ID || "-");
// }

// function formatCrDetailsReply(item) {
//   return [
//     `CR Number: ${getCrNumber(item)}`,
//     `Short Description: ${item?.SHORT_DESC || "-"}`,
//     `Status: ${item?.STATUS || "-"}`,
//     `Priority: ${item?.PRIORITY || "-"}`,
//     `Process Type: ${item?.PROCESS_TYPE || "-"}`,
//     `Created On: ${formatDisplayDate(item?.CREATED_ON)}`,
//     `Last Changed By: ${item?.LAST_CHANGED_BY || "-"}`,
//     `Last Changed At: ${item?.LAST_CHANGED_AT || "-"}`,
//     `Category: ${item?.CATEGORY || "-"}`,
//   ].join("\n");
// }

// function getDaysInMonth(year, monthIndexZeroBased) {
//   return new Date(year, monthIndexZeroBased + 1, 0).getDate();
// }

// function inferDateRangeFromQuery(query = "") {
//   const q = cleanString(query).toLowerCase();

//   if (!q) return null;

//   const months = {
//     january: 1,
//     february: 2,
//     march: 3,
//     april: 4,
//     may: 5,
//     june: 6,
//     july: 7,
//     august: 8,
//     september: 9,
//     october: 10,
//     november: 11,
//     december: 12,
//   };

//   const monthMatch = q.match(
//     /\b(?:in\s+the\s+month\s+of|month\s+of|for)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/
//   );

//   if (monthMatch) {
//     const monthName = monthMatch[1];
//     const year = Number(monthMatch[2]);
//     const month = months[monthName];
//     const fromDate = `${year}${String(month).padStart(2, "0")}01`;
//     const toDate = `${year}${String(month).padStart(2, "0")}${String(
//       getDaysInMonth(year, month - 1)
//     ).padStart(2, "0")}`;

//     return {
//       fromDate,
//       toDate,
//       granularity: "month",
//     };
//   }

//   const yearMatch = q.match(/\b(?:in\s+the\s+year\s+of|year\s+of|for)\s+(20\d{2})\b/);

//   if (yearMatch) {
//     const year = Number(yearMatch[1]);
//     return {
//       fromDate: `${year}0101`,
//       toDate: `${year}1231`,
//       granularity: "year",
//     };
//   }

//   const plainYearMatch = q.match(/\bin\s+(20\d{2})\b/);
//   if (plainYearMatch && /\b(cr|change request|status)\b/.test(q)) {
//     const year = Number(plainYearMatch[1]);
//     return {
//       fromDate: `${year}0101`,
//       toDate: `${year}1231`,
//       granularity: "year",
//     };
//   }

//   return null;
// }

// function inferCrStatusFilterFromQuery(query = "") {
//   const q = cleanString(query).toLowerCase();

//   if (!q) {
//     return {
//       status: "",
//       excludeStatuses: [],
//       statusMode: "",
//     };
//   }

//   if (q.includes("pending")) {
//     return {
//       status: "",
//       excludeStatuses: ["CLOSED", "REJECTED"],
//       statusMode: "pending",
//     };
//   }

//   const known = [
//     "open",
//     "closed",
//     "approved",
//     "rejected",
//     "in progress",
//     "under implementation",
//     "success",
//     "completed",
//   ];

//   for (const value of known) {
//     if (q.includes(value)) {
//       return {
//         status: value.toUpperCase(),
//         excludeStatuses: [],
//         statusMode: "",
//       };
//     }
//   }

//   return {
//     status: "",
//     excludeStatuses: [],
//     statusMode: "",
//   };
// }

// function inferRequestedTop(query = "", fallback = 10) {
//   const q = cleanString(query).toLowerCase();

//   const nextMatch = q.match(/\b(?:show\s+)?next\s+(\d+)\b/);
//   if (nextMatch) return Math.max(1, Number(nextMatch[1]));

//   const topMatch = q.match(/\b(?:top|last)\s+(\d+)\b/);
//   if (topMatch) return Math.max(1, Number(topMatch[1]));

//   return fallback;
// }

// function inferRequestedSkip(raw = {}, query = "") {
//   if (raw?.skip != null && Number.isFinite(Number(raw.skip))) {
//     return Math.max(0, Number(raw.skip));
//   }

//   const q = cleanString(query).toLowerCase();
//   if (/\b(?:show\s+)?next\s+\d+\b/.test(q)) {
//     return Math.max(0, Number(raw?.nextSkip || 0));
//   }

//   return 0;
// }

// function isNextPageQuery(query = "") {
//   const q = cleanString(query).toLowerCase();
//   return /\b(?:show\s+)?next\s+\d+\b/.test(q);
// }

// function inferCrListIntent(classified, query = "") {
//   const intent = cleanString(classified?.intent).toLowerCase();
//   const q = cleanString(query).toLowerCase();

//   if (
//     intent === "list_change_requests" ||
//     intent === "get_change_request_status_list" ||
//     intent === "get_change_request_status" ||
//     intent === "list_change_request_status"
//   ) {
//     return true;
//   }

//   if (
//     /\b(?:show\s+)?next\s+\d+\b/.test(q) ||
//     /\bcr\b/.test(q) ||
//     /\bchange request\b/.test(q) ||
//     /\bchange requests\b/.test(q) ||
//     /\bcr list\b/.test(q) ||
//     /\bstatus of cr\b/.test(q) ||
//     /\bstatus of each change request\b/.test(q) ||
//     /\bshow the status of the cr\b/.test(q) ||
//     /\bopen cr\b/.test(q) ||
//     /\bapproved cr\b/.test(q) ||
//     /\brejected cr\b/.test(q) ||
//     /\bclosed cr\b/.test(q) ||
//     /\bpending cr\b/.test(q) ||
//     /\bpending\b/.test(q) ||
//     /\bunder implementation\b/.test(q) ||
//     /\blast\s+\d+\s+cr\b/.test(q) ||
//     /\blast\s+\d+\s+cr\s+status\b/.test(q) ||
//     /\bcreated in this week\b/.test(q) ||
//     /\bcreated from\b/.test(q) ||
//     /\bthis month\b/.test(q) ||
//     /\blast month\b/.test(q) ||
//     /\bthis year\b/.test(q) ||
//     /\bin the month of\b/.test(q) ||
//     /\bmonth of\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/.test(q) ||
//     /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/.test(q) ||
//     /\bin the year of\s+20\d{2}\b/.test(q) ||
//     /\byear of\s+20\d{2}\b/.test(q) ||
//     /\bdependency transport\b/.test(q) ||
//     /\bdependency transports\b/.test(q) ||
//     /\brow\b/.test(q) ||
//     /\bindia\b/.test(q)
//   ) {
//     return true;
//   }

//   return false;
// }

// function pickCrListEntities(raw = {}, query = "") {
//   const q = cleanString(query);
//   const scope = resolveBusinessScope(q, raw);
//   const inferredDateRange = inferDateRangeFromQuery(q);
//   const inferredStatus = inferCrStatusFilterFromQuery(q);

//   const requestedTop =
//     raw.top ??
//     raw.limit ??
//     (isNextPageQuery(q) ? inferRequestedTop(q, 10) : inferRequestedTop(q, 10));

//   return {
//     businessScope: scope?.label || cleanString(raw.businessScope || raw.scope || ""),
//     processType:
//       cleanString(raw.processType || raw.PROCESS_TYPE || scope?.processType || "") || "",
//     triggerAll: cleanString(raw.triggerAll || raw.TRIGGER_ALL || "X") || "X",
//     fromDate: cleanString(raw.fromDate || raw.FROM_DATE || inferredDateRange?.fromDate || ""),
//     toDate: cleanString(raw.toDate || raw.TO_DATE || inferredDateRange?.toDate || ""),
//     status: cleanString(raw.status || raw.STATUS || inferredStatus.status),
//     excludeStatuses: Array.isArray(raw.excludeStatuses)
//       ? raw.excludeStatuses
//       : inferredStatus.excludeStatuses,
//     statusMode: cleanString(raw.statusMode || inferredStatus.statusMode || ""),
//     dateText: cleanString(raw.dateText || raw.dateRangeText || q),
//     top: requestedTop,
//     skip: inferRequestedSkip(raw, q),
//     nextSkip:
//       raw.nextSkip != null && Number.isFinite(Number(raw.nextSkip))
//         ? Math.max(0, Number(raw.nextSkip))
//         : 0,
//     orderBy: cleanString(raw.orderBy || "CREATED_ON desc") || "CREATED_ON desc",
//   };
// }

// function padCell(value, width) {
//   const s = cleanString(value || "-");
//   if (s.length > width) return `${s.slice(0, Math.max(0, width - 1))}…`;
//   return s.padEnd(width, " ");
// }

// function formatCrListReply(rows = [], params = {}) {
//   if (!Array.isArray(rows) || rows.length === 0) {
//     return "No change requests found.";
//   }

//   const header = [`Found ${rows.length} change request(s).`];

//   if (params?.businessScope) {
//     header.push(`Landscape: ${params.businessScope}`);
//   }

//   if (params?.fromDate || params?.toDate) {
//     header.push(
//       `Date Range: ${formatDisplayDate(params?.fromDate)} to ${formatDisplayDate(params?.toDate)}`
//     );
//   }

//   if (params?.statusMode === "pending") {
//     header.push("Status Filter: Pending (excluding CLOSED and REJECTED)");
//   } else if (params?.status) {
//     header.push(`Status Filter: ${params.status}`);
//   }

//   // if (params?.top) {
//   //   header.push(`Limit: ${params.top}`);
//   // }

//   if (params?.skip) {
//     header.push(`Offset: ${params.skip}`);
//   }

//   if (rows.length <= 2) {
//     const body = rows
//       .map((item) => {
//         const crNumber = getCrNumber(item);
//         const status = item?.STATUS || "-";
//         const createdOn = formatDisplayDate(item?.CREATED_ON);
//         const shortDesc = item?.SHORT_DESC || "-";

//         return [
//           `CR Number: ${crNumber}`,
//           `Status: ${status}`,
//           `Created On: ${createdOn}`,
//           `Short Description: ${shortDesc}`,
//         ].join("\n");
//       })
//       .join("\n\n");

//     return `${header.join("\n")}\n\n${body}`;
//   }

//   const widths = {
//     no: 10,
//     cr: 16,
//     status: 26,
//     createdOn: 14,
//     shortDesc: 50,
//   };

//   const tableHeader = [
//     padCell("Serial No", widths.no),
//     padCell("CR Number", widths.cr),
//     padCell("Status", widths.status),
//     padCell("Created On", widths.createdOn),
//     padCell("Short Description", widths.shortDesc),
//   ].join(" | ");

//   const body = rows
//     .map((item, index) =>
//       [
//         padCell(String((params?.skip || 0) + index + 1), widths.no),
//         padCell(getCrNumber(item), widths.cr),
//         padCell(item?.STATUS || "-", widths.status),
//         padCell(formatDisplayDate(item?.CREATED_ON), widths.createdOn),
//         padCell(item?.SHORT_DESC || "-", widths.shortDesc),
//       ].join(" | ")
//     )
//     .join("\n");

//   return `${header.join("\n")}\n\n${tableHeader}\n${body}`;
// }

// function buildCrSuggestions(query = "", scopeLabel = "", rows = []) {
//   const q = cleanString(query).toLowerCase();
//   const prefix = scopeLabel ? `${scopeLabel} ` : "";
//   const pagination = buildPaginationSuggestions(rows);

//   if (q.includes("closed")) {
//     return [
//       ...pagination,
//       `Show ${prefix}closed CR list this week`.replace(/\s+/g, " ").trim(),
//       `Show ${prefix}closed CR list this month`.replace(/\s+/g, " ").trim(),
//     ];
//   }

//   if (q.includes("approved")) {
//     return [
//       ...pagination,
//       `Show ${prefix}approved CR list this week`.replace(/\s+/g, " ").trim(),
//       `Show ${prefix}approved CR list this month`.replace(/\s+/g, " ").trim(),
//     ];
//   }

//   if (q.includes("open")) {
//     return [
//       ...pagination,
//       `Show ${prefix}open CR list this week`.replace(/\s+/g, " ").trim(),
//       `Show ${prefix}open CR list this month`.replace(/\s+/g, " ").trim(),
//     ];
//   }

//   if (q.includes("pending")) {
//     return [
//       ...pagination,
//       `Show ${prefix}pending CR list this week`.replace(/\s+/g, " ").trim(),
//       `Show ${prefix}pending CR list this month`.replace(/\s+/g, " ").trim(),
//     ];
//   }

//   return [
//     ...pagination,
//     `Show ${prefix}CR list created in this week`.replace(/\s+/g, " ").trim(),
//     `Show ${prefix}closed CR list this month`.replace(/\s+/g, " ").trim(),
//   ];
// }

// async function persistAssistantAndTouchSession({
//   owner,
//   sessionId,
//   text,
//   summary,
//   extracted,
//   data,
//   responseMeta,
// }) {
//   await step("save assistant message", () =>
//     saveAssistantMessage({
//       owner,
//       sessionId,
//       text,
//       summary,
//       extracted,
//       data,
//       responseMeta,
//     })
//   );

//   await step("update ChatSession updatedAt", () =>
//     ChatSession.updateOne(
//       { _id: sessionId },
//       { $set: { updatedAt: new Date() } }
//     )
//   );
// }

// export async function handleSolmanChatStream({
//   sse,
//   owner,
//   query,
//   sessionId,
//   systemId,
//   sapUser,
//   classified,
// }) {
//   const effectiveSystemId = normalizeSystemId(systemId);

//   if (!effectiveSystemId) {
//     sse.send("error", { message: "systemId is required" });
//     return sse.end();
//   }

//   const sapAuth = await step("getSapAuthOrThrow", () =>
//     getSapAuthOrThrow({
//       owner,
//       systemId: effectiveSystemId,
//       sapUser,
//     })
//   );

//   const effectiveSapUser = normalizeSapUser(sapAuth?.sapUser);

//   const session = await step("getOrCreateSession", () =>
//     getOrCreateSession({
//       owner,
//       sessionId,
//       systemId: effectiveSystemId,
//       sapUser: effectiveSapUser,
//     })
//   );

//   await step("save user message", () =>
//     saveUserMessage({
//       owner,
//       sessionId: session._id,
//       text: query,
//     })
//   );

//   await step("set session title (first message only)", async () => {
//     if (!session.title) {
//       await ChatSession.updateOne(
//         { _id: session._id },
//         { $set: { title: String(query).slice(0, 80), updatedAt: new Date() } }
//       );
//     }
//   });

//   const system = await step("load SapSystem", () =>
//     SapSystem.findOne({
//       owner: { $in: [owner, "local"] },
//       systemId: effectiveSystemId,
//     }).lean()
//   );

//   if (!system) {
//     const message = `SAP system profile not found for systemId=${effectiveSystemId}`;
//     await persistAssistantAndTouchSession({
//       owner,
//       sessionId: session._id,
//       text: message,
//       summary: "SAP system profile not found.",
//       extracted: {
//         system: "solman",
//       },
//       data: {
//         systemId: effectiveSystemId,
//       },
//       responseMeta: {
//         ok: false,
//         kind: "stream",
//         executor: "solman",
//         systemId: effectiveSystemId,
//         sapUser: effectiveSapUser,
//         status: "missing_system_profile",
//       },
//     });

//     sse.send("error", {
//       message,
//     });
//     return sse.end();
//   }

//   if (classified?.intent === "create_change_request") {
//     const collected = pickCreateCrEntities(classified?.entities || {});
//     const missingFields = getMissingCreateCrFields(collected);

//     if (missingFields.length > 0) {
//       const message = "Please complete the required change request details.";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Asked user to complete required change request details.",
//         extracted: {
//           system: "solman",
//           intent: "create_change_request",
//           pending: true,
//           payload: collected,
//           missingFields,
//         },
//         data: {
//           action: {
//             type: "open_form",
//             formId: "solman_create_cr",
//           },
//           pendingAction: {
//             collected,
//             missingFields,
//           },
//           missingFields,
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.create_change_request",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "needs_input",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "needs_input",
//         message,
//         action: {
//           type: "open_form",
//           formId: "solman_create_cr",
//         },
//         pendingAction: {
//           collected,
//           missingFields,
//         },
//         missingFields,
//       });
//       return sse.end();
//     }

//     sse.send("phase", {
//       phase: "executing",
//       message: "Creating change request in Solution Manager...",
//     });

//     const result = await step("createSolmanChangeRequest", () =>
//       createSolmanChangeRequest({
//         system,
//         sapAuth,
//         payload: collected,
//       })
//     );

//     if (!result?.ok) {
//       const message = result?.message || "Failed to create change request";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Change request creation failed.",
//         extracted: {
//           system: "solman",
//           intent: "create_change_request",
//           payload: collected,
//         },
//         data: {
//           sap: {
//             msgType: result?.result?.msgType,
//             message: result?.message,
//             changeRequestId: result?.result?.changeRequestId,
//             status: result?.result?.status,
//           },
//           raw: result?.result?.raw || null,
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.create_change_request",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "execution_failed",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "execution_failed",
//         message,
//         sap: {
//           msgType: result?.result?.msgType,
//           message: result?.message,
//           changeRequestId: result?.result?.changeRequestId,
//           status: result?.result?.status,
//         },
//         raw: result?.result?.raw || null,
//       });
//       return sse.end();
//     }

//     const reply =
//       `Change request ${result.result?.changeRequestId} created successfully.\n` +
//       `Status: ${result.result?.status || "-"}\n` +
//       `Message: ${result.message || "-"}`;

//     await persistAssistantAndTouchSession({
//       owner,
//       sessionId: session._id,
//       text: reply,
//       summary: result.message || "Change request created successfully.",
//       extracted: {
//         system: "solman",
//         intent: "create_change_request",
//         payload: collected,
//       },
//       data: {
//         changeRequestId: result.result?.changeRequestId,
//         status: result.result?.status,
//         msgType: result.result?.msgType,
//         raw: result.result?.raw || null,
//       },
//       responseMeta: {
//         ok: true,
//         kind: "stream",
//         executor: "solman.create_change_request",
//         systemId: effectiveSystemId,
//         sapUser: effectiveSapUser,
//       },
//     });

//     sse.send("reply", {
//       ok: true,
//       sessionId: String(session._id),
//       systemId: effectiveSystemId,
//       sapUser: effectiveSapUser,
//       reply,
//       summary: result.message || "Change request created successfully.",
//       data: {
//         changeRequestId: result.result?.changeRequestId,
//         status: result.result?.status,
//         msgType: result.result?.msgType,
//       },
//       suggestions: [
//         `Show status of CR ${result.result?.changeRequestId}`,
//         "Create another change request",
//       ],
//     });

//     sse.send("done", { ok: true });
//     return sse.end();
//   }

//   if (classified?.intent === "get_change_request_details") {
//     const detailsInput = pickCrDetailsEntities(classified?.entities || {}, query);
//     const objectId = detailsInput.objectId;
//     const processType = detailsInput.processType || "YMHF";

//     if (!objectId) {
//       const message = "Please provide the change request number.";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Asked user to provide the change request number.",
//         extracted: {
//           system: "solman",
//           intent: "get_change_request_details",
//           pending: true,
//           processType,
//         },
//         data: {
//           missingFields: ["objectId"],
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.get_change_request_details",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "needs_input",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "needs_input",
//         message,
//         missingFields: ["objectId"],
//       });
//       return sse.end();
//     }

//     sse.send("phase", {
//       phase: "executing",
//       message: "Fetching change request details from Solution Manager...",
//     });

//     const result = await step("getSolmanChangeRequestDetailsById", () =>
//       getSolmanChangeRequestDetailsById({
//         system,
//         sapAuth,
//         objectId,
//         processType,
//       })
//     );

//     if (result?.ok === false) {
//       const message = result?.message || "Failed to fetch change request details";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Fetching change request details failed.",
//         extracted: {
//           system: "solman",
//           intent: "get_change_request_details",
//           objectId,
//           processType,
//         },
//         data: {
//           raw: result?.result?.raw || null,
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.get_change_request_details",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "execution_failed",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "execution_failed",
//         message,
//         raw: result?.result?.raw || null,
//       });
//       return sse.end();
//     }

//     const rows = toCrDetailsArray(result);
//     const item = rows[0] || null;
//     const crNumber = getCrNumber(item || { OBJECT_ID: objectId });

//     if (!item) {
//       const message = `No details found for CR ${objectId}.`;

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: `No details found for CR ${objectId}.`,
//         extracted: {
//           system: "solman",
//           intent: "get_change_request_details",
//           objectId,
//           processType,
//         },
//         data: [],
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.get_change_request_details",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "not_found",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "not_found",
//         message,
//         data: [],
//       });
//       return sse.end();
//     }

//     const reply = formatCrDetailsReply(item);

//     await persistAssistantAndTouchSession({
//       owner,
//       sessionId: session._id,
//       text: reply,
//       summary: `Fetched details for CR Number ${crNumber}.`,
//       extracted: {
//         system: "solman",
//         intent: "get_change_request_details",
//         objectId,
//         processType,
//       },
//       data: rows,
//       responseMeta: {
//         ok: true,
//         kind: "stream",
//         executor: "solman.get_change_request_details",
//         systemId: effectiveSystemId,
//         sapUser: effectiveSapUser,
//       },
//     });

//     sse.send("reply", {
//       ok: true,
//       sessionId: String(session._id),
//       systemId: effectiveSystemId,
//       sapUser: effectiveSapUser,
//       reply,
//       summary: `Fetched details for CR Number ${crNumber}.`,
//       data: rows,
//       suggestions: [
//         `Show status of CR ${crNumber}`,
//         "Create another change request",
//       ],
//     });

//     sse.send("done", { ok: true });
//     return sse.end();
//   }

//   if (inferCrListIntent(classified, query)) {
//     const listInput = pickCrListEntities(classified?.entities || {}, query);

//     if (!cleanString(listInput.processType)) {
//       const message = "Which landscape would you like to view the Change Requests from?";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Asked user to choose a landscape for listing change requests.",
//         extracted: {
//           system: "solman",
//           intent: "list_change_requests",
//           pending: true,
//           filters: {
//             businessScope: listInput.businessScope,
//             processType: listInput.processType,
//             status: listInput.status,
//             dateText: listInput.dateText,
//             triggerAll: listInput.triggerAll || "X",
//             top: listInput.top,
//             skip: listInput.skip,
//             nextSkip: listInput.nextSkip,
//             orderBy: listInput.orderBy,
//             fromDate: listInput.fromDate,
//             toDate: listInput.toDate,
//             statusMode: listInput.statusMode,
//             excludeStatuses: listInput.excludeStatuses,
//           },
//         },
//         data: {
//           missingFields: ["processType"],
//           action: {
//             type: "quick_replies",
//             options: [
//               { label: "ROW", value: "ROW" },
//               { label: "INDIA", value: "INDIA" },
//             ],
//           },
//           pendingAction: {
//             system: "solman",
//             intent: "list_change_requests",
//             query,
//             filters: {
//               businessScope: listInput.businessScope,
//               processType: listInput.processType,
//               status: listInput.status,
//               dateText: listInput.dateText,
//               triggerAll: listInput.triggerAll || "X",
//               top: listInput.top,
//               skip: listInput.skip,
//               nextSkip: listInput.nextSkip,
//               orderBy: listInput.orderBy,
//               fromDate: listInput.fromDate,
//               toDate: listInput.toDate,
//               statusMode: listInput.statusMode,
//               excludeStatuses: listInput.excludeStatuses,
//             },
//           },
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.list_change_requests",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "needs_input",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "needs_input",
//         message,
//         missingFields: ["processType"],
//         action: {
//           type: "quick_replies",
//           options: [
//             { label: "ROW", value: "ROW" },
//             { label: "INDIA", value: "INDIA" },
//           ],
//         },
//         pendingAction: {
//           system: "solman",
//           intent: "list_change_requests",
//           query,
//           filters: {
//             businessScope: listInput.businessScope,
//             processType: listInput.processType,
//             status: listInput.status,
//             dateText: listInput.dateText,
//             triggerAll: listInput.triggerAll || "X",
//             top: listInput.top,
//             skip: listInput.skip,
//             nextSkip: listInput.nextSkip,
//             orderBy: listInput.orderBy,
//             fromDate: listInput.fromDate,
//             toDate: listInput.toDate,
//             statusMode: listInput.statusMode,
//             excludeStatuses: listInput.excludeStatuses,
//           },
//         },
//       });
//       return sse.end();
//     }

//     sse.send("phase", {
//       phase: "executing",
//       message: "Fetching change requests from Solution Manager...",
//     });

//     const result = await step("listSolmanChangeRequestsByDateRange", () =>
//       listSolmanChangeRequestsByDateRange({
//         system,
//         sapAuth,
//         processType: listInput.processType,
//         triggerAll: listInput.triggerAll || "X",
//         fromDate: listInput.fromDate || "",
//         toDate: listInput.toDate || "",
//         status: listInput.status || "",
//         excludeStatuses: listInput.excludeStatuses || [],
//         statusMode: listInput.statusMode || "",
//         dateText: listInput.dateText || query,
//         top: listInput.top ?? 10,
//         skip: listInput.skip || 0,
//         orderBy: listInput.orderBy || "CREATED_ON desc",
//       })
//     );

//     if (result?.ok === false) {
//       const message = result?.message || "Failed to fetch change requests";

//       await persistAssistantAndTouchSession({
//         owner,
//         sessionId: session._id,
//         text: message,
//         summary: "Fetching change requests failed.",
//         extracted: {
//           system: "solman",
//           intent: "list_change_requests",
//           filters: {
//             businessScope: listInput.businessScope,
//             processType: listInput.processType,
//             triggerAll: listInput.triggerAll || "X",
//             fromDate: listInput.fromDate,
//             toDate: listInput.toDate,
//             status: listInput.status,
//             statusMode: listInput.statusMode,
//             excludeStatuses: listInput.excludeStatuses || [],
//             top: listInput.top ?? 10,
//             skip: listInput.skip || 0,
//             nextSkip: listInput.nextSkip || 0,
//             orderBy: listInput.orderBy || "CREATED_ON desc",
//           },
//         },
//         data: {
//           raw: result?.result?.raw || null,
//         },
//         responseMeta: {
//           ok: false,
//           kind: "stream",
//           executor: "solman.list_change_requests",
//           systemId: effectiveSystemId,
//           sapUser: effectiveSapUser,
//           status: "execution_failed",
//         },
//       });

//       sse.send("error", {
//         ok: false,
//         status: "execution_failed",
//         message,
//         raw: result?.result?.raw || null,
//       });
//       return sse.end();
//     }

//     const rows = toCrDetailsArray(result);
//     const responseTop = result?.result?.top ?? listInput.top ?? 10;
//     const responseSkip = result?.result?.skip ?? listInput.skip ?? 0;
//     const responseNextSkip =
//       result?.result?.nextSkip ?? responseSkip + (Array.isArray(rows) ? rows.length : 0);

//     const reply = formatCrListReply(rows, {
//       businessScope: listInput.businessScope,
//       fromDate: result?.result?.fromDate || listInput.fromDate,
//       toDate: result?.result?.toDate || listInput.toDate,
//       status: result?.result?.status || listInput.status,
//       statusMode: result?.result?.statusMode || listInput.statusMode,
//       top: responseTop,
//       skip: responseSkip,
//     });

//     await persistAssistantAndTouchSession({
//       owner,
//       sessionId: session._id,
//       text: reply,
//       summary: result?.message || `Fetched ${rows.length} change request(s).`,
//       extracted: {
//         system: "solman",
//         intent: "list_change_requests",
//         filters: {
//           businessScope: listInput.businessScope,
//           processType: result?.result?.processType || listInput.processType,
//           triggerAll: result?.result?.triggerAll || listInput.triggerAll,
//           fromDate: result?.result?.fromDate || listInput.fromDate,
//           toDate: result?.result?.toDate || listInput.toDate,
//           status: result?.result?.status || listInput.status,
//           statusMode: result?.result?.statusMode || listInput.statusMode,
//           excludeStatuses:
//             result?.result?.excludeStatuses || listInput.excludeStatuses || [],
//           top: responseTop,
//           skip: responseSkip,
//           nextSkip: responseNextSkip,
//           orderBy: result?.result?.orderBy || listInput.orderBy || "CREATED_ON desc",
//           dateText: listInput.dateText || query,
//         },
//       },
//       data: rows,
//       responseMeta: {
//         ok: true,
//         kind: "stream",
//         executor: "solman.list_change_requests",
//         systemId: effectiveSystemId,
//         sapUser: effectiveSapUser,
//         pagination: {
//           top: responseTop,
//           skip: responseSkip,
//           nextSkip: responseNextSkip,
//           orderBy: result?.result?.orderBy || listInput.orderBy || "CREATED_ON desc",
//         },
//       },
//     });

//     sse.send("reply", {
//       ok: true,
//       sessionId: String(session._id),
//       systemId: effectiveSystemId,
//       sapUser: effectiveSapUser,
//       reply,
//       summary: result?.message || `Fetched ${rows.length} change request(s).`,
//       data: rows,
//       pagination: {
//         top: responseTop,
//         skip: responseSkip,
//         nextSkip: responseNextSkip,
//         orderBy: result?.result?.orderBy || listInput.orderBy || "CREATED_ON desc",
//       },
//       suggestions: buildCrSuggestions(query, listInput.businessScope, rows),
//     });

//     sse.send("done", { ok: true });
//     return sse.end();
//   }

//   const unsupportedMessage =
//     "This Solution Manager request is not supported yet in chat stream.";

//   await persistAssistantAndTouchSession({
//     owner,
//     sessionId: session._id,
//     text: unsupportedMessage,
//     summary: "Unsupported Solution Manager request.",
//     extracted: {
//       system: "solman",
//     },
//     data: null,
//     responseMeta: {
//       ok: false,
//       kind: "stream",
//       executor: "solman",
//       systemId: effectiveSystemId,
//       sapUser: effectiveSapUser,
//       status: "unsupported",
//     },
//   });

//   sse.send("error", {
//     message: unsupportedMessage,
//     status: "unsupported",
//   });
//   return sse.end();
// }