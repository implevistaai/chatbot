import { getDependentTransportsFromCr } from "../../../services/systems/solman/transport.service.js";
import {
  cleanString,
  persistAssistantAndTouchSession,
} from "./solman.shared.js";
import { validateDependencyCheck } from "./dependencyPreValidation.js";
import { step } from "../stream.shared.js";

function pickDependencyCheckEntities(raw = {}, query = "") {
  const q = cleanString(query);

  const objectId = cleanString(
    raw.objectId ||
      raw.OBJECT_ID ||
      raw.OBJ_ID ||
      raw.crNumber ||
      raw.changeRequestId ||
      (() => {
        const match = q.match(/\b(8\d{9}|9\d{9})\b/);
        return match ? match[1] : "";
      })()
  );

  const processType = cleanString(raw.processType || raw.PROCESS_TYPE || "");

  return {
    objectId,
    processType,
  };
}

function formatDependencyCheckReply(result = {}) {
  const dependencyChecks = Array.isArray(result?.dependencyChecks) ? result.dependencyChecks.filter(Boolean) : [];
  const dependencies = Array.isArray(result?.dependencies) ? result.dependencies.filter(Boolean) : [];
  const dependencyMessage = cleanString(result?.dependencyMessage || result?.message);

  if (dependencyChecks.length > 0) {
    const lines = ["Dependency Analysis", ""];

    if (dependencyMessage) {
      lines.push(`SAP Message: ${dependencyMessage}`);
      lines.push("");
    }

    for (const item of dependencyChecks) {
      const transport = cleanString(item?.transport) || "-";
      lines.push(`Transport: ${transport}`);

      const transportDetails = Array.isArray(item?.dependencies) ? item.dependencies.filter(Boolean) : [];

      if (transportDetails.length > 0) {
        lines.push("Transport Details");
        lines.push(`- Original Transport: ${transport}`);
        lines.push(`- Dependency Rows: ${transportDetails.length}`);
      }

      if (cleanString(item?.evMessage)) {
        lines.push("Dependency Details");
        lines.push(`- Transport: ${transport}`);
        lines.push(`- Message: ${cleanString(item.evMessage)}`);
      } else if (cleanString(item?.errorMessage)) {
        lines.push("Dependency Details");
        lines.push(`- Transport: ${transport}`);
        lines.push(`- Message: ${cleanString(item.errorMessage)}`);
      } else {
        lines.push("No dependency message was returned.");
      }

      lines.push("");
    }

    return lines.join("\n").trim();
  }

  if (dependencies.length === 0) {
    return [dependencyMessage ? dependencyMessage : "Dependency check completed.", "No dependent transports were found."]
      .filter(Boolean)
      .join("\n");
  }

  const lines = [];

  if (dependencyMessage) {
    lines.push("");
    lines.push(`SAP Message: ${dependencyMessage}`);
  }

  lines.push("");
  lines.push(`Found ${dependencies.length} dependent transport${dependencies.length > 1 ? "s" : ""}:`);

  dependencies.forEach((item, index) => {
    lines.push("");
    lines.push(`${index + 1}. Entered Transport: ${cleanString(item.transportEntered) || "-"}`);
    lines.push(`   Dependent Transport: ${cleanString(item.dependentTransport) || "-"}`);
    lines.push(`   Description: ${cleanString(item.description) || "-"}`);
    lines.push(`   Owner: ${cleanString(item.owner) || "-"}`);
  });

  return lines.join("\n");
}

function buildDependencyTableRows(result = {}) {
  const sourceTransports = Array.isArray(result?.sourceTransports)
    ? result.sourceTransports.filter(Boolean)
    : [];
  const dependencies = Array.isArray(result?.dependencies)
    ? result.dependencies.filter(Boolean)
    : [];

  if (dependencies.length === 0 && sourceTransports.length > 0) {
    return sourceTransports.map((transport) => [
      String(transport || "-").trim() || "-",
      String(transport || "-").trim() || "-",
      `Found ${sourceTransports.length} transport(s) for this CR.`,
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]);
  }

  return dependencies.map((item) => [
    sourceTransports[0] || cleanString(item?.transportEntered) || "-",
    cleanString(item?.dependentTransport) || "-",
    cleanString(item?.description) || "-",
    cleanString(item?.status) || "-",
    cleanString(item?.owner) || "-",
    cleanString(item?.exportDate) || "-",
    cleanString(item?.exportTime) || "-",
    cleanString(item?.importDate) || "-",
    cleanString(item?.importTime) || "-",
  ]);
}

export async function handleDependencyCheck(context) {
  const {
    sse,
    owner,
    session,
    query,
    system,
    sapAuth,
    effectiveSystemId,
    effectiveSapUser,
    classified,
  } = context;

  const input = pickDependencyCheckEntities(classified?.entities || {}, query);
  const objectId = cleanString(input.objectId);
  const processType = cleanString(input.processType);

  if (!objectId) {
    const message =
      "Please provide the change request number to check dependencies.";

    await persistAssistantAndTouchSession({
      owner,
      sessionId: session._id,
      text: message,
      summary: "Asked user to provide a transport number for dependency check.",
      extracted: {
        system: "solman",
        intent: "dependency_check",
        pending: true,
        objectId: objectId || null,
        processType,
      },
      data: {
        missingFields: ["objectId"],
      },
      responseMeta: {
        ok: false,
        kind: "stream",
        executor: "solman.dependency_check",
        systemId: effectiveSystemId,
        sapUser: effectiveSapUser,
        status: "needs_input",
      },
    });

    sse.send("error", {
      ok: false,
      sessionId: String(session._id),
      status: "needs_input",
      message,
      missingFields: ["objectId"],
    });
    return sse.end();
  }

  sse.send("phase", {
    phase: "executing",
    message: `Checking transport dependencies for CR ${objectId}...`,
  });

  const preValidation = await step("validateDependencyCheck", () =>
    validateDependencyCheck({
      system,
      sapAuth,
      systemId: effectiveSystemId,
      processType,
      objectId,
    })
  );

  console.log("[SOLMAN][DEP-CHECK] pre-validation decision", {
    objectId,
    processType,
    systemId: effectiveSystemId,
    shouldSkipDependency: Boolean(preValidation?.shouldSkipDependency),
    crStatus: preValidation?.crStatus || "<unresolved>",
    systemType: preValidation?.systemType || "<unknown>",
  });

  if (preValidation?.shouldSkipDependency) {
    const message = preValidation?.message || "No dependent transports were found for this CR.";

    console.log("[SOLMAN][DEP-CHECK] returning pre-validation message", {
      objectId,
      message,
      crStatus: preValidation?.crStatus || "",
      systemType: preValidation?.systemType || "",
    });

    await persistAssistantAndTouchSession({
      owner,
      sessionId: session._id,
      text: message,
      summary: message,
      extracted: {
        system: "solman",
        intent: "dependency_check",
        objectId: objectId || null,
        processType,
        crStatus: preValidation?.crStatus || "",
      },
      data: {
        crStatus: preValidation?.crStatus || "",
        systemType: preValidation?.systemType || "",
      },
      responseMeta: {
        ok: true,
        kind: "stream",
        executor: "solman.dependency_check",
        systemId: effectiveSystemId,
        sapUser: effectiveSapUser,
        status: "blocked_by_pre_validation",
      },
    });

    sse.send("reply", {
      ok: true,
      sessionId: String(session._id),
      systemId: effectiveSystemId,
      sapUser: effectiveSapUser,
      reply: message,
      summary: message,
      data: {
        crStatus: preValidation?.crStatus || "",
        systemType: preValidation?.systemType || "",
      },
      suggestions: [
        `Show status of CR ${objectId}`,
        `Check dependency check for CR ${objectId}`,
      ],
    });

    sse.send("done", { ok: true });
    return sse.end();
  }

  const result = await step("getDependentTransportsFromCr", () =>
    getDependentTransportsFromCr({
      system,
      sapAuth,
      changeRequestId: objectId,
      processType,
    })
  );

  console.log("[SOLMAN][DEP-CHECK] dependency API returned", {
    objectId,
    ok: Boolean(result?.ok),
    dependencyCount: Array.isArray(result?.result?.dependencies) ? result.result.dependencies.length : 0,
  });

  if (!result?.ok) {
    const message = result?.message || `Failed to check dependencies for CR ${objectId}.`;

    await persistAssistantAndTouchSession({
      owner,
      sessionId: session._id,
      text: message,
      summary: "Dependency check failed.",
      extracted: {
        system: "solman",
        intent: "dependency_check",
        objectId: objectId || null,
        processType,
      },
      data: {
        raw: result?.result?.raw || null,
      },
      responseMeta: {
        ok: false,
        kind: "stream",
        executor: "solman.dependency_check",
        systemId: effectiveSystemId,
        sapUser: effectiveSapUser,
        status: "execution_failed",
      },
    });

    sse.send("error", {
      ok: false,
      status: "execution_failed",
      message,
      raw: result?.result?.raw || null,
    });
    return sse.end();
  }

  const reply = formatDependencyCheckReply(result.result);
  const tableRows = buildDependencyTableRows(result.result);
  const dependencies = tableRows;
  const dependencyChecks = Array.isArray(result?.result?.dependencyChecks) ? result.result.dependencyChecks : [];

  await persistAssistantAndTouchSession({
    owner,
    sessionId: session._id,
    text: reply,
    summary: result?.message || `Checked dependencies for CR ${objectId}.`,
    extracted: {
      system: "solman",
      intent: "dependency_check",
      objectId: objectId || null,
      processType,
    },
    data: {
      dependencies,
      dependencyChecks,
      dependencyMessage: result?.result?.dependencyMessage || "",
      tableRows,
      viewType: "dependency_check_table",
      columns: [
        "Original Transport",
        "Dependent Transport",
        "Description",
        "Status",
        "Owner",
        "Export Date",
        "Export Time",
        "Import Date",
        "Import Time",
      ],
    },
    responseMeta: {
      ok: true,
      kind: "stream",
      executor: "solman.dependency_check",
      systemId: effectiveSystemId,
      sapUser: effectiveSapUser,
    },
  });

  sse.send("reply", {
    ok: true,
    sessionId: String(session._id),
    systemId: effectiveSystemId,
    sapUser: effectiveSapUser,
    reply,
    summary: result?.message || `Checked dependencies for CR ${objectId}.`,
    data: {
      dependencies,
      dependencyChecks,
      dependencyMessage: result?.result?.dependencyMessage || "",
      tableRows,
      viewType: "dependency_check_table",
      columns: [
        "Original Transport",
        "Dependent Transport",
        "Description",
        "Status",
        "Owner",
        "Export Date",
        "Export Time",
        "Import Date",
        "Import Time",
      ],
    },
    suggestions: [
      `Check dependency check for CR ${objectId}`,
      `Check dependency analysis for CR ${objectId}`,
    ],
  });

  sse.send("done", { ok: true });
  return sse.end();
}