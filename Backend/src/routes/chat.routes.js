import express from "express";

import { handleChatEntry } from "../controllers/chat.entry.controller.js";
import {
  submitSolmanCreateChangeRequest,
  submitSolmanCreateTransportRequest,
  submitSolmanCreateTransportTask,
  submitSolmanReleaseTransportTask,
  getSolmanChangeRequestDetails,
  listSolmanChangeRequests,
  listSolmanTransports,
  checkSolmanTransportDependencies,
  getPurchaseOrderDetailsAction,
  listPurchaseOrdersAction,
  getProcurementFlowDetailsByItemAction,
  getPendingPurchaseOrderItemsAction,
  getPendingPurchaseOrdersAction,
} from "../controllers/chat.actions.controller.js";
import { sendChatReportEmail } from "../controllers/chat.email.controller.js";

import {
  listChatSessions,
  listChatMessages,
  renameChatSession,
  deleteChatSession,
} from "../controllers/chat.controller.js";

export const chatRoutes = express.Router();

// main chat API (router-aware)
chatRoutes.post("/", handleChatEntry);

// action endpoints
chatRoutes.post(
  "/actions/solman/create-change-request",
  submitSolmanCreateChangeRequest
);

chatRoutes.post(
  "/actions/solman/create-transport-task",
  submitSolmanCreateTransportTask
);

chatRoutes.post(
  "/actions/solman/create-transport-request",
  submitSolmanCreateTransportRequest
);

chatRoutes.post(
  "/actions/solman/release-transport-task",
  submitSolmanReleaseTransportTask
);

chatRoutes.post(
  "/actions/solman/get-change-request-details",
  getSolmanChangeRequestDetails
);

chatRoutes.post(
  "/actions/solman/list-change-requests",
  listSolmanChangeRequests
);

chatRoutes.post(
  "/actions/solman/list-transports",
  listSolmanTransports
);

chatRoutes.post(
  "/actions/solman/check-transport-dependencies",
  checkSolmanTransportDependencies
);

chatRoutes.post(
  "/actions/s4hana/get-purchase-order-details",
  getPurchaseOrderDetailsAction
);

chatRoutes.post(
  "/actions/s4hana/list-purchase-orders",
  listPurchaseOrdersAction
);

chatRoutes.post(
  "/actions/s4hana/get-procurement-flow-details-by-item",
  getProcurementFlowDetailsByItemAction
);

chatRoutes.post(
  "/actions/s4hana/get-pending-purchase-orders",
  getPendingPurchaseOrdersAction
);

chatRoutes.post(
  "/actions/s4hana/get-pending-purchase-order-items",
  getPendingPurchaseOrderItemsAction
);

chatRoutes.post("/email", sendChatReportEmail);

// sidebar sessions
chatRoutes.get("/sessions", listChatSessions);

// chat messages
chatRoutes.get("/sessions/:sessionId/messages", listChatMessages);

// rename session
chatRoutes.patch("/sessions/:sessionId", renameChatSession);

// delete session
chatRoutes.delete("/sessions/:sessionId", deleteChatSession);