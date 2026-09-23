import test from "node:test";
import assert from "node:assert/strict";

import {
  extractDocQuery,
  hasPoQuerySignals,
  hasStructuredPoRequest,
} from "../src/services/extractor/extractor.service.js";
import { extractDateFilters } from "../src/services/filters/dateFilters.js";
import { isLikelyGibberishQuery } from "../src/controllers/chat.stream.controller.js";
import {
  enforceLatestOrderBy,
  applyPoNextContinuationState,
  isSingleLatestPoRequest,
  sortRowsByLatestDate,
  isExplicitLatestPoQuery,
} from "../src/controllers/stream/s4po.stream.controller.js";
import { buildGenericTableReply } from "../src/controllers/stream/stream.shared.js";
import { handleChatStream } from "../src/controllers/chat.stream.controller.js";
import { listChatMessages } from "../src/controllers/chat.controller.js";
import { SapConnection } from "../src/models/SapConnection.model.js";
import { ChatMessage } from "../src/models/ChatMessage.model.js";
import { ChatSession } from "../src/models/ChatSession.model.js";
import { resolveTargetSystem } from "../src/services/routing/systemContextResolver.service.js";

test("extracts month + created-by username filter", async () => {
  process.env.FIXED_TODAY = "2026-06-10";

  const allowedFields = ["CrtDate", "UserCreated", "PoNo", "NetPrice"];

  const extracted = await extractDocQuery({
    query: "show po created on june by ramesh",
    allowedFields,
    fieldLabels: {},
  });

  const userFilter = (extracted.filters || []).find(
    (f) => f?.field === "UserCreated" && f?.op === "eq"
  );

  assert.equal(userFilter?.value, "ramesh");

  const dateFilters = (extracted.filters || []).filter((f) => f?.field === "CrtDate");
  const ge = dateFilters.find((f) => f?.op === "ge");
  const lt = dateFilters.find((f) => f?.op === "lt");

  assert.equal(ge?.value, "2026-06-01T00:00:00");
  assert.equal(lt?.value, "2026-07-01T00:00:00");

  delete process.env.FIXED_TODAY;
});

test("extracts year + created-by username filter", async () => {
  process.env.FIXED_TODAY = "2026-06-10";

  const allowedFields = ["CrtDate", "UserCreated", "PoNo", "NetPrice"];

  const extracted = await extractDocQuery({
    query: "show purchase orders created in 2025 by john.doe",
    allowedFields,
    fieldLabels: {},
  });

  const userFilter = (extracted.filters || []).find(
    (f) => f?.field === "UserCreated" && f?.op === "eq"
  );

  assert.equal(userFilter?.value, "john.doe");

  const dateFilters = (extracted.filters || []).filter((f) => f?.field === "CrtDate");
  const ge = dateFilters.find((f) => f?.op === "ge");
  const lt = dateFilters.find((f) => f?.op === "lt");

  assert.equal(ge?.value, "2025-01-01T00:00:00");
  assert.equal(lt?.value, "2026-01-01T00:00:00");

  delete process.env.FIXED_TODAY;
});

test("extracts quoted created-by username with filler words", async () => {
  const allowedFields = ["CrtDate", "UserCreated", "PoNo", "NetPrice"];

  const extracted = await extractDocQuery({
    query: 'show po created by the user "ISLM"',
    allowedFields,
    fieldLabels: {},
  });

  const userFilter = (extracted.filters || []).find(
    (f) => f?.field === "UserCreated" && f?.op === "eq"
  );

  assert.equal(userFilter?.value, "ISLM");
});

test("my PO phrasing resolves to self-user creator filter", async () => {
  const allowedFields = ["CrtDate", "UserCreated", "PoNo", "NetPrice"];

  const extracted = await extractDocQuery({
    query: "Show my POs",
    allowedFields,
    fieldLabels: {},
  });

  const userFilter = (extracted.filters || []).find(
    (f) => f?.field === "UserCreated" && f?.op === "eq"
  );

  assert.equal(userFilter?.value, "ME");
});

test("extracts explicit ISO date ranges as inclusive PoDocDate filters", async () => {
  const allowedFields = ["PoDocDate", "CrtDate", "UserCreated", "PoNo"];

  const extracted = await extractDocQuery({
    query: "how many POs are there from 2017-10-10 to 2017-10-31",
    allowedFields,
    fieldLabels: {},
  });

  const poDocDateFilters = (extracted.filters || []).filter((filter) => filter?.field === "PoDocDate");
  const ge = poDocDateFilters.find((filter) => filter?.op === "ge");
  const le = poDocDateFilters.find((filter) => filter?.op === "le");

  assert.equal(poDocDateFilters.length >= 2, true);
  assert.equal(ge?.value, "2017-10-10T00:00:00");
  assert.equal(le?.value, "2017-10-31T23:59:59");
});

test("gibberish query has no PO signal and no structured request", () => {
  const gibberish = "asdf qwer zxcv blabla";

  assert.equal(hasPoQuerySignals(gibberish), false);

  const extracted = {
    docNumber: null,
    docItem: null,
    listMode: null,
    count: false,
    limit: null,
    skip: null,
    filters: [],
    orderBy: [],
  };

  assert.equal(hasStructuredPoRequest(extracted), false);
});

test("valid PO filter request has signals and structured extraction", async () => {
  process.env.FIXED_TODAY = "2026-06-10";

  const query = "show po created in june by ramesh top 5";
  const allowedFields = ["CrtDate", "UserCreated", "PoNo", "NetPrice"];

  const extracted = await extractDocQuery({
    query,
    allowedFields,
    fieldLabels: {},
  });

  assert.equal(hasPoQuerySignals(query), true);
  assert.equal(hasStructuredPoRequest(extracted), true);

  delete process.env.FIXED_TODAY;
});

test("routing guard flags random gibberish prompt", () => {
  assert.equal(isLikelyGibberishQuery("dhoewnfwofnbslkjbc"), true);
  assert.equal(isLikelyGibberishQuery("adakijcd"), true);
  assert.equal(isLikelyGibberishQuery("IUWE N"), true);
  assert.equal(isLikelyGibberishQuery("show latest purchase orders"), false);
});

test("PO next-page continuation advances by the actual previous result count", () => {
  const state = applyPoNextContinuationState({
    query: "show next 10 po",
    extracted: {
      docType: "PO",
      limit: 10,
      skip: 0,
      listMode: "latest_po",
      fields: ["PoNo"],
      filters: [],
      orderBy: [{ field: "CrtDate", dir: "desc" }],
    },
    previousMemory: {
      extracted: {
        docType: "PO",
        limit: 10,
        skip: 0,
        listMode: "latest_po",
      },
      data: [{ PoNo: "4500001935" }],
    },
  });

  assert.equal(state.error, null);
  assert.equal(state.nextIntent, true);
  assert.equal(state.extracted.skip, 1);
  assert.equal(state.extracted.limit, 10);
});

test("latest PO query enforces descending order on available date field", () => {
  const extracted = {
    listMode: "latest_po",
    orderBy: [],
  };

  enforceLatestOrderBy({
    query: "show latest purchase orders",
    extracted,
    allowedFields: ["PoNo", "PoDocDate", "UserCreated"],
    fallbackField: "PoNo",
  });

  assert.deepEqual(extracted.orderBy, [{ field: "PoDocDate", dir: "desc" }]);
});

test("latest PO query keeps all dates and only enforces descending sort", () => {
  const extracted = {
    listMode: "latest_po",
    docNumber: null,
    docItem: null,
    filters: [],
    orderBy: [],
  };

  enforceLatestOrderBy({
    query: "show latest purchase orders",
    extracted,
    allowedFields: ["PoNo", "CrtDate", "UserCreated"],
    fallbackField: "PoNo",
  });

  assert.equal(extracted.filters.length, 0);
  assert.deepEqual(extracted.orderBy, [{ field: "CrtDate", dir: "desc" }]);
});

test("latest PO sorting prefers CrtDate over PoNo", () => {
  const rows = sortRowsByLatestDate([
    { PoNo: "4500000066", CrtDate: "2017-01-01T00:00:00" },
    { PoNo: "4500001935", CrtDate: "2026-01-01T00:00:00" },
  ]);

  assert.equal(rows[0]?.PoNo, "4500001935");
});

test("singular latest PO prompts are collapsed to one row", () => {
  assert.equal(isSingleLatestPoRequest("show latest purchase order"), true);
  assert.equal(isSingleLatestPoRequest("latest PO"), true);
  assert.equal(isSingleLatestPoRequest("show latest purchase orders"), false);
});

test("generic show po does not trigger explicit latest-only date filtering", () => {
  assert.equal(isExplicitLatestPoQuery("show po"), false);
  assert.equal(isExplicitLatestPoQuery("show latest po"), true);
  assert.equal(isExplicitLatestPoQuery("most recent purchase orders"), true);
});

test("chat stream returns invalid_prompt for gibberish before ambiguous routing", async () => {
  const originalFind = SapConnection.find;

  SapConnection.find = () => ({
    select() {
      return this;
    },
    lean: async () => [],
  });

  const chunks = [];
  const listeners = new Map();

  const res = {
    setHeader() {},
    flushHeaders() {},
    flush() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      const cb = listeners.get("finish");
      if (typeof cb === "function") cb();
    },
    on(event, cb) {
      listeners.set(event, cb);
    },
  };

  try {
    await handleChatStream(
      {
        user: { id: "test-user" },
        body: {
          query: "dhoewnfwofnbslkjbc",
          availableSystems: [
            { systemId: "S4D", connected: true },
            { systemId: "HSD", connected: true },
          ],
        },
      },
      res
    );

    const output = chunks.join("");
    assert.match(output, /event: error/);
    assert.match(output, /"status":"invalid_prompt"/);
    assert.match(output, /I couldn't understand that request/);
    assert.ok(!output.includes("multiple possible systems"));
  } finally {
    SapConnection.find = originalFind;
  }
});

test("extracts relative last 3 days and last 30 days filters", () => {
  process.env.FIXED_TODAY = "2026-06-10";

  try {
    const last3 = extractDateFilters("show po created in last 3 days", "CrtDate");
    const last30 = extractDateFilters("show po created in last 30 days", "CrtDate");

    const last3Ge = last3.find((f) => f.op === "ge");
    const last3Lt = last3.find((f) => f.op === "lt");
    assert.equal(last3Ge?.value, "2026-06-08T00:00:00");
    assert.equal(last3Lt?.value, "2026-06-11T00:00:00");

    const last30Ge = last30.find((f) => f.op === "ge");
    const last30Lt = last30.find((f) => f.op === "lt");
    assert.equal(last30Ge?.value, "2026-05-12T00:00:00");
    assert.equal(last30Lt?.value, "2026-06-11T00:00:00");
  } finally {
    delete process.env.FIXED_TODAY;
  }
});

test("typo query 'shew po' still resolves as latest_po list", async () => {
  const allowedFields = ["CrtDate", "UserCreated", "SuppAcoutNo", "NetPrice", "CurKey", "PoNo"];

  const extracted = await extractDocQuery({
    query: "shew po",
    allowedFields,
    fieldLabels: {},
  });

  assert.equal(extracted.listMode, "latest_po");
  assert.equal(Array.isArray(extracted.orderBy), true);
  assert.equal(extracted.orderBy[0]?.field, "CrtDate");
  assert.equal(extracted.orderBy[0]?.dir, "desc");
  assert.equal(extracted.limit, 10);
});

test("s4 query without explicit systemId defaults to first connected system", async () => {
  const result = await resolveTargetSystem({
    query: "show po created by S4H_MM",
    classified: { system: "s4hana", module: "mm", intent: "list_purchase_orders" },
    requestedSystemId: "",
    availableSystems: [
      { systemId: "SYS1", host: "10.0.0.1", port: 44300, connected: true },
      { systemId: "SYS2", host: "10.0.0.2", port: 44300, connected: true },
    ],
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.targetSystemId, "SYS1");
  assert.equal(result.reason, "s4_first_connected_default");
});

test("show next po requires a previous PO list context", () => {
  const state = applyPoNextContinuationState({
    query: "show next po",
    extracted: { listMode: "latest_po", limit: 10, skip: 0 },
    previousMemory: null,
  });

  assert.equal(state.error?.status, "missing_po_context");
});

test("show next 20 po reuses previous PO list context and advances the page", () => {
  const previousMemory = {
    extracted: {
      docType: "PO",
      listMode: "latest_po",
      fields: ["PoNo"],
      filters: [{ field: "UserCreated", op: "eq", type: "string", value: "ramesh" }],
      orderBy: [{ field: "CrtDate", dir: "desc" }],
      limit: 10,
      skip: 10,
    },
  };

  const state = applyPoNextContinuationState({
    query: "show next 20 po",
    extracted: { listMode: "latest_po", limit: 10, skip: 0, filters: [], orderBy: [], fields: [] },
    previousMemory,
  });

  assert.equal(state.error, null);
  assert.equal(state.extracted.limit, 20);
  assert.equal(state.extracted.skip, 20);
  assert.deepEqual(state.extracted.filters, previousMemory.extracted.filters);
  assert.deepEqual(state.extracted.orderBy, previousMemory.extracted.orderBy);
  assert.deepEqual(state.extracted.fields, previousMemory.extracted.fields);
});

test("pending PO intent payload defaults to five rows per page", async () => {
  const { buildPendingPoIntentPayload } = await import("../src/services/procurement/pendingPurchaseOrder.service.js");
  const payload = buildPendingPoIntentPayload("show po", { today: new Date("2026-06-10T00:00:00Z") });

  assert.equal(payload.page_size, 5);
});

test("PO table reply respects pagination start index", () => {
  const reply = buildGenericTableReply({
    title: "Results",
    startIndex: 11,
    rows: [
      { PoNo: "4500000011", CrtDate: "2026-06-10", UserCreated: "IRAM" },
      { PoNo: "4500000012", CrtDate: "2026-06-09", UserCreated: "IRAM" },
    ],
    fields: ["PoNo", "CrtDate", "UserCreated"],
  });

  assert.match(reply, /\n11 \| 4500000011 \| 2026-06-10 \| IRAM/);
  assert.match(reply, /\n12 \| 4500000012 \| 2026-06-09 \| IRAM/);
});

test("chat message history includes assistant suggestions", async () => {
  const sessionId = "64f000000000000000000001";
  const originalFindOne = ChatSession.findOne;
  const originalFind = ChatMessage.find;

  ChatSession.findOne = () => ({
    select() {
      return Promise.resolve({ _id: "session-1" });
    },
  });

  ChatMessage.find = () => ({
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    select() {
      return this;
    },
    lean: async () => [
      {
        _id: "msg-1",
        role: "assistant",
        text: "Results",
        summary: "",
        data: null,
        suggestions: ["Load more"],
        createdAt: new Date("2026-06-11T10:00:00Z"),
      },
    ],
  });

  const chunks = [];
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      chunks.push(payload);
      return payload;
    },
  };

  try {
    await listChatMessages(
      {
        user: { id: "local" },
        params: { sessionId },
        query: {},
      },
      res
    );

    assert.equal(chunks[0]?.ok, true);
    assert.deepEqual(chunks[0]?.items?.[0]?.suggestions, ["Load more"]);
  } finally {
    ChatSession.findOne = originalFindOne;
    ChatMessage.find = originalFind;
  }
});
