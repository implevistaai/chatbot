import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDependencyChecksForTransports,
  getDependencyCheckForTransport,
} from "../src/services/systems/solman/transport.service.js";

test("dependency check uses the transport dynamically and reads EV_MESSAGE", async () => {
  const calls = [];
  const result = await getDependencyCheckForTransport({
    system: { systemId: "HSD" },
    sapAuth: { owner: "local" },
    transport: "HDVK912377",
    fetcher: async (request) => {
      calls.push(request);
      return {
        d: {
          results: [
            {
              TRANSPORT: "HDVK912377",
              EV_MESSAGE: "actual test dependency message",
              message_nav: {
                results: [
                  {
                    TRANSPORT_ENTERED: "HDVK912377",
                    TRKORR: "HDVK912380",
                    DESCRIPTION: "Blocked by downstream transport",
                    TRSTATUS: "K",
                    OWNER: "IMVT0001",
                    EXPORT_DATE: "2025-07-07",
                    EXPORT_TIME: "PT15H27M42S",
                    IMPORT_DATE: "2025-07-07",
                    IMPORT_TIME: "PT15H26M26S",
                  },
                ],
              },
            },
          ],
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].service.serviceName, "ZTR_DEP_CHECK_SRV");
  assert.equal(calls[0].relativePath, "zmessageSet?$filter=TRANSPORT%20eq%20'HDVK912377'&$expand=message_nav");
  assert.equal(result.transport, "HDVK912377");
  assert.equal(result.evMessage, "actual test dependency message");
  assert.equal(result.hasDependency, true);
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].dependentTransport, "HDVK912380");
});

test("dependency checks dedupe transports and continue after a transport-level failure", async () => {
  const calls = [];
  const dependencyChecks = await buildDependencyChecksForTransports({
    system: { systemId: "HSD" },
    sapAuth: { owner: "local" },
    transports: ["HDVK912377", "HDVK912377", "HDVK912380", "HDVK912385"],
    fetcher: async ({ transport }) => {
      calls.push(transport);
      if (transport === "HDVK912380") {
        throw new Error("Unable to retrieve dependency information from SAP.");
      }

      return {
        transport,
        evMessage: transport === "HDVK912385" ? "" : `message for ${transport}`,
        hasDependency: transport !== "HDVK912385",
        dependencies: [],
      };
    },
  });

  assert.deepEqual(calls, ["HDVK912377", "HDVK912380", "HDVK912385"]);
  assert.equal(dependencyChecks.length, 3);
  assert.equal(dependencyChecks[0].hasDependency, true);
  assert.equal(dependencyChecks[1].hasDependency, false);
  assert.match(dependencyChecks[1].errorMessage, /Unable to retrieve dependency information/i);
  assert.equal(dependencyChecks[2].hasDependency, false);
});

test("empty EV_MESSAGE does not invent a dependency", async () => {
  const result = await getDependencyCheckForTransport({
    system: { systemId: "HSD" },
    sapAuth: { owner: "local" },
    transport: "HDVK912377",
    fetcher: async () => ({
      d: {
        results: [
          {
            TRANSPORT: "HDVK912377",
            EV_MESSAGE: "   ",
            message_nav: { results: [] },
          },
        ],
      },
    }),
  });

  assert.equal(result.hasDependency, false);
  assert.equal(result.evMessage, "");
});

test("no transports means no dependency calls", async () => {
  const checks = await buildDependencyChecksForTransports({
    system: { systemId: "HSD" },
    sapAuth: { owner: "local" },
    transports: [],
    fetcher: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(checks, []);
});
