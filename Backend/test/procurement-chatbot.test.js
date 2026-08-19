import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPendingInvoiceStatusReply,
  buildPendingInvoiceStatusSections,
  buildProcurementFlowReply,
  detectPendingInvoiceIntent,
} from "../src/controllers/stream/s4po.stream.controller.js";
import { extractQuantityValue } from "../src/services/sap/sapValueExtractor.service.js";
import { getProcurementCdsRegistry, planProcurementChatQuery } from "../src/services/procurement/purchaseOrderChatbot.service.js";
import { detectDocumentFlowIntent, getDocumentFlowExecutionPlan, isPurchaseOrderFlowRequest } from "../src/services/procurement/procurementQueryEngine.service.js";
import { getDocumentFlowStepPlan, normalizeDocumentFlowIntent } from "../src/services/procurement/purchaseOrderFlow.service.js";

test("procurement registry exposes the five CDS sources", () => {
  const registry = getProcurementCdsRegistry();
  assert.equal(registry.length, 5);
  assert.deepEqual(
    registry.map((item) => item.serviceType),
    ["PO", "MAT", "RSEG", "RBKP", "ACDOCA"]
  );
});

test("planner routes PO and invoice lifecycle questions to the right primary source", async () => {
  const catalog = [
    { serviceType: "PO", serviceName: "ZIV_PO_DETAILS_CDS", entitySet: "ZIV_PO_DETAILS", entityTypeName: "ZIV_PO_DETAILS" },
    { serviceType: "MAT", serviceName: "ZIV_MAT_LEDGERS_CDS", entitySet: "ZIV_MAT_LEDGERS", entityTypeName: "ZIV_MAT_LEDGERS" },
    { serviceType: "RSEG", serviceName: "ZIV_RSEG_DEATILS_CDS", entitySet: "ZIV_RSEG_DEATILS", entityTypeName: "ZIV_RSEG_DEATILS" },
    { serviceType: "RBKP", serviceName: "ZIV_RBKP_DETAILS_CDS", entitySet: "ZIV_RBKP_DETAILS", entityTypeName: "ZIV_RBKP_DETAILS" },
    { serviceType: "ACDOCA", serviceName: "ZIV_ACDOCA_DETAILS_CDS", entitySet: "ZIV_ACDOCA_DETAILS", entityTypeName: "ZIV_ACDOCA_DETAILS" },
  ];

  const poPlan = await planProcurementChatQuery({ query: "Show lifecycle of PO 4500001234", serviceCatalog: catalog });
  assert.equal(poPlan.primary.serviceType, "PO");
  assert.ok(Array.isArray(poPlan.chain));

  const invoicePlan = await planProcurementChatQuery({ query: "Show invoice pending last 3 months", serviceCatalog: catalog });
  assert.equal(invoicePlan.primary.serviceType, "RSEG");

  const grPlan = await planProcurementChatQuery({ query: "Show GR pending", serviceCatalog: catalog });
  assert.equal(grPlan.primary.serviceType, "MAT");

  const accountingPlan = await planProcurementChatQuery({ query: "Show accounting entries", serviceCatalog: catalog });
  assert.equal(accountingPlan.primary.serviceType, "ACDOCA");
});

test("flow classifier routes lifecycle prompts into the multi-hop execution path", () => {
  assert.equal(isPurchaseOrderFlowRequest("Show complete details for PO 4500001234", { docNumber: "4500001234" }), true);
  assert.equal(isPurchaseOrderFlowRequest("Show goods receipt for PO 4500001234", { docNumber: "4500001234" }), true);
  assert.equal(isPurchaseOrderFlowRequest("Show accounting details for PO 4500001234", { docNumber: "4500001234" }), true);
  assert.equal(isPurchaseOrderFlowRequest("Show vendor details", {}), false);
});

test("invoice-only prompts stay out of the full procurement flow gate", () => {
  assert.equal(isPurchaseOrderFlowRequest("Show invoice details for PO 4500001234", { docNumber: "4500001234" }), false);
  assert.equal(isPurchaseOrderFlowRequest("Show invoice for the PO 4500001234", { docNumber: "4500001234" }), false);
});

test("pending invoice intent is detected before generic PO detail routing", () => {
  const pendingPrompts = [
    "Show pending invoice",
    "Show pending invoice for PO 4500000001",
    "Show pending quantity",
    "Pending quantity for PO",
    "Invoice status",
    "Invoice pending status",
    "How much quantity is pending for invoice",
    "Remaining quantity to invoice",
  ];

  for (const prompt of pendingPrompts) {
    assert.equal(detectDocumentFlowIntent(prompt), null);
  }
});

test("pending invoice intent matcher supports common invoice typos", () => {
  const typoPrompts = [
    "show pending invocie for the po 4500000001",
    "pending invocie status for purchase order 4500000001",
    "remaining quantity to invocie for po 4500000001",
  ];

  for (const prompt of typoPrompts) {
    assert.equal(detectPendingInvoiceIntent(prompt), "PENDING_INVOICE_STATUS");
  }
});

test("document flow intent wins over generic PO detail wording", () => {
  assert.equal(detectDocumentFlowIntent("Show material document details for PO 4500000001"), "MATERIAL_DOCUMENT");
  assert.equal(detectDocumentFlowIntent("Show invoice details for PO 4500000001"), "INVOICE_DETAILS");
  assert.equal(detectDocumentFlowIntent("Show invoice for the PO 4500000001"), "INVOICE_DETAILS");
  assert.equal(detectDocumentFlowIntent("Show account details for PO 4500000001"), "ACCOUNTING_DOCUMENT");
  assert.equal(detectDocumentFlowIntent("Find accounting document for PO 4500000001"), "ACCOUNTING_DOCUMENT");
  assert.equal(detectDocumentFlowIntent("Show complete document flow for PO 4500000001"), "COMPLETE_DOCUMENT_FLOW");
});

test("material document intent maps to the minimal execution plan", () => {
  assert.deepEqual(getDocumentFlowExecutionPlan("MATERIAL_DOCUMENT"), ["ZIV_PO_DETAILS_CDS", "ZIV_MAT_LEDGERS_CDS"]);
  assert.deepEqual(getDocumentFlowExecutionPlan("INVOICE_DETAILS"), ["ZIV_PO_DETAILS_CDS", "ZIV_RSEG_DETAILS_CDS", "ZIV_RBKP_DETAILS_CDS"]);
  assert.deepEqual(getDocumentFlowExecutionPlan("ACCOUNTING_DOCUMENT"), ["ZIV_PO_DETAILS_CDS", "ZIV_RSEG_DETAILS_CDS", "ZIV_RBKP_DETAILS_CDS", "ZIV_ACDOCA_DETAILS_CDS"]);
});

test("document flow intents resolve to the minimal CDS step plan", () => {
  assert.equal(normalizeDocumentFlowIntent("material_document"), "MATERIAL_DOCUMENT");
  assert.deepEqual(getDocumentFlowStepPlan("MATERIAL_DOCUMENT"), ["PO", "MAT"]);
  assert.deepEqual(getDocumentFlowStepPlan("INVOICE_DETAILS"), ["PO", "RSEG", "RBKP"]);
  assert.deepEqual(getDocumentFlowStepPlan("ACCOUNTING_DOCUMENT"), ["PO", "RSEG", "RBKP", "ACDOCA"]);
  assert.deepEqual(getDocumentFlowStepPlan("COMPLETE_DOCUMENT_FLOW"), ["PO", "MAT", "RSEG", "RBKP", "ACDOCA"]);
});

test("procurement flow formatter only renders sections allowed by intent", () => {
  const sample = {
    poRows: [{ PoNo: "4500000001", PoItem: "00001" }],
    materialRows: [{ mat_doc_no1: "4900000121", movement_type: "561" }],
    invoiceRows: [{ acc_doc_no: "5100000001", fiscal_year: "2017" }],
    rbkpRows: [{ invoice_doc_no: "5100000001", fiscal_year: "2017" }],
    acdocaRows: [{ doc_no_acctng_doc: "5100000000", account_no: "21100000" }],
    poNo: "4500000001",
    poItem: "00001",
  };

  const materialReply = buildProcurementFlowReply({ ...sample, documentFlowIntent: "MATERIAL_DOCUMENT" });
  assert.match(materialReply, /\| Field \| Value \|/);
  assert.match(materialReply, /Purchase Document Summary/);
  assert.match(materialReply, /Material Document/);
  assert.doesNotMatch(materialReply, /Invoice Details/);
  assert.doesNotMatch(materialReply, /Invoice Header/);
  assert.doesNotMatch(materialReply, /Accounting Details/);

  const invoiceReply = buildProcurementFlowReply({ ...sample, documentFlowIntent: "INVOICE_DETAILS" });
  assert.match(invoiceReply, /\| Field \| Value \|/);
  assert.match(invoiceReply, /Purchase Document Summary/);
  assert.match(invoiceReply, /Invoice Details/);
  assert.match(invoiceReply, /Invoice Header/);
  assert.doesNotMatch(invoiceReply, /Material Document/);
  assert.doesNotMatch(invoiceReply, /Accounting Details/);

  const accountingReply = buildProcurementFlowReply({ ...sample, documentFlowIntent: "ACCOUNTING_DOCUMENT" });
  assert.match(accountingReply, /\| Field \| Value \|/);
  assert.match(accountingReply, /Purchase Document Summary/);
  assert.match(accountingReply, /Accounting Details/);
  assert.doesNotMatch(accountingReply, /Material Document/);
  assert.doesNotMatch(accountingReply, /Invoice Details/);
  assert.doesNotMatch(accountingReply, /Invoice Header/);

  const completeReply = buildProcurementFlowReply({ ...sample, documentFlowIntent: "COMPLETE_DOCUMENT_FLOW" });
  assert.match(completeReply, /\| Field \| Value \|/);
  assert.match(completeReply, /Purchase Document Summary/);
  assert.match(completeReply, /Material Document/);
  assert.match(completeReply, /Invoice Details/);
  assert.match(completeReply, /Invoice Header/);
  assert.match(completeReply, /Accounting Details/);
});

test("pending invoice formatter reports only pending status fields", () => {
  const reply = buildPendingInvoiceStatusReply({
    poRow: { PoNo: "4500000001", PoItem: "00010", PO_Quantity: "100.000", MatNo: "TG10" },
    rsegRows: [
      { quantity: "40.000" },
      { quantity: "20.000" },
    ],
    poNo: "4500000001",
    poItem: "00010",
  });

  assert.match(reply, /Pending Invoice Status/);
  assert.match(reply, /PO Number: 4500000001/);
  assert.match(reply, /PO Item: 00010/);
  assert.match(reply, /Material: TG10/);
  assert.match(reply, /Ordered Quantity: 100\.000/);
  assert.match(reply, /Invoiced Quantity: 60\.000/);
  assert.match(reply, /Pending Quantity: 40\.000/);
  assert.match(reply, /Invoice Status: Pending/);
  assert.doesNotMatch(reply, /Material Document/);
  assert.doesNotMatch(reply, /Invoice Header/);
  assert.doesNotMatch(reply, /Accounting Details/);
});

test("pending invoice sections expose a horizontal table payload", () => {
  const sections = buildPendingInvoiceStatusSections({
    poRow: { PoNo: "4500000006", PoItem: "00015", PO_Quantity: "146.000", MatNo: "MZ-RM-R100-05" },
    rsegRows: [{ quantity: "146.000" }],
    poNo: "4500000006",
    poItem: "00015",
  });

  assert.ok(Array.isArray(sections));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "Pending Invoice Status");
  assert.deepEqual(sections[0].columns, [
    "PO Number",
    "PO Item",
    "Material",
    "Ordered Quantity",
    "Invoiced Quantity",
    "Pending Quantity",
    "Invoice Status",
  ]);
  assert.deepEqual(sections[0].rows[0], [
    "4500000006",
    "00015",
    "MZ-RM-R100-05",
    "146.000",
    "146.000",
    "0.000",
    "Completed",
  ]);
});

test("pending invoice formatter uses PO_Quantity and does not fall back to zero when present", () => {
  const reply = buildPendingInvoiceStatusReply({
    poRow: { PoNo: "4500000002", PoItem: "00001", PO_Quantity: "49.000", MatNo: "MZ-RM-R300-01" },
    rsegRows: [{ quantity: "49.000" }],
    poNo: "4500000002",
    poItem: "00001",
  });

  assert.match(reply, /Ordered Quantity: 49\.000/);
  assert.match(reply, /Invoiced Quantity: 49\.000/);
  assert.match(reply, /Pending Quantity: 0\.000/);
  assert.match(reply, /Invoice Status: Completed/);
});

test("SAP quantity extractor handles strings, xml objects, namespaces, and fallback fields", () => {
  assert.equal(extractQuantityValue({ PO_Quantity: "49.000" }, ["PO_Quantity", "quantity"]), "49.000");
  assert.equal(
    extractQuantityValue({ PO_Quantity: { _text: "49.000" } }, ["PO_Quantity", "quantity"]),
    "49.000"
  );
  assert.equal(
    extractQuantityValue({ PoQuantity: "49" }, ["PO_Quantity", "PoQuantity", "quantity"]),
    "49"
  );
  assert.equal(
    extractQuantityValue({ "d:PO_Quantity": "49.000" }, ["PO_Quantity", "d:PO_Quantity"]),
    "49.000"
  );
  assert.equal(
    extractQuantityValue({ PO_Quantity: "", quantity: "49.000" }, ["PO_Quantity", "quantity"]),
    "49.000"
  );
  assert.equal(extractQuantityValue({ Material: "ABC" }, ["PO_Quantity", "quantity"]), null);
});

test("pending invoice formatter handles completed, partial, and empty invoice states", () => {
  const completedReply = buildPendingInvoiceStatusReply({
    poRow: { PoNo: "4500000003", PoItem: "00001", PO_Quantity: "49", MatNo: "MZ-RM-R300-03" },
    rsegRows: [{ quantity: "49" }],
    poNo: "4500000003",
    poItem: "00001",
  });

  assert.match(completedReply, /Ordered Quantity: 49\.000/);
  assert.match(completedReply, /Invoiced Quantity: 49\.000/);
  assert.match(completedReply, /Pending Quantity: 0\.000/);
  assert.match(completedReply, /Invoice Status: Completed/);

  const partialReply = buildPendingInvoiceStatusReply({
    poRow: { PoNo: "4500000004", PoItem: "00001", PO_Quantity: "100", MatNo: "MZ-RM-R300-04" },
    rsegRows: [{ quantity: "40" }],
    poNo: "4500000004",
    poItem: "00001",
  });

  assert.match(partialReply, /Ordered Quantity: 100\.000/);
  assert.match(partialReply, /Invoiced Quantity: 40\.000/);
  assert.match(partialReply, /Pending Quantity: 60\.000/);
  assert.match(partialReply, /Invoice Status: Pending/);

  const noneReply = buildPendingInvoiceStatusReply({
    poRow: { PoNo: "4500000005", PoItem: "00001", PO_Quantity: "50", MatNo: "MZ-RM-R300-05" },
    rsegRows: [],
    poNo: "4500000005",
    poItem: "00001",
  });

  assert.match(noneReply, /Ordered Quantity: 50\.000/);
  assert.match(noneReply, /Invoiced Quantity: 0\.000/);
  assert.match(noneReply, /Pending Quantity: 50\.000/);
  assert.match(noneReply, /Invoice Status: Not Invoiced/);
});