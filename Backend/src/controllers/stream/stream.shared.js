import mongoose from "mongoose";
import { ChatSession } from "../../models/ChatSession.model.js";
import { ChatMessage } from "../../models/ChatMessage.model.js";
import { SapCredential } from "../../models/SapCredential.model.js";
import { decryptString } from "../../utils/crypto.js";

export function getOwner(req) {
  const owner = String(req.user?.id || "").trim();
  if (!owner) {
    const e = new Error("Unauthorized");
    e.status = 401;
    throw e;
  }
  return owner;
}

export function normalizeSystemId(systemId) {
  return String(systemId || "").trim().toUpperCase();
}

export function normalizeSapUser(sapUser) {
  const s = String(sapUser || "").trim();
  return s ? s.toUpperCase() : null;
}

export function createSseSession(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let closed = false;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  const ping = setInterval(() => {
    if (closed) return;
    res.write(`event: ping\n`);
    res.write(`data: {}\n\n`);
    res.flush?.();
  }, 15000);

  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    try {
      res.end();
    } catch {}
  };

  reqSafeBindClose(res, () => {
    closed = true;
    clearInterval(ping);
  });

  return {
    send,
    end,
    isClosed: () => closed,
  };
}

function reqSafeBindClose(res, onClose) {
  res.on("close", onClose);
  res.on("finish", onClose);
}

export async function step(label, fn) {
  console.log(`[SSE] ${label}...`);
  const t0 = Date.now();
  const out = await fn();
  console.log(`[SSE] ${label} done in ${Date.now() - t0}ms`);
  return out;
}

export async function getOrCreateSession({ owner, sessionId, systemId, sapUser }) {
  const sid = normalizeSystemId(systemId);
  const su = normalizeSapUser(sapUser);

  if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
    const existing = await ChatSession.findOne({ _id: sessionId, owner });

    if (existing) {
      const existingSystemId = normalizeSystemId(existing.systemId);
      const existingSapUser = normalizeSapUser(existing.sapUser);

      const needsUpdate = existingSystemId !== sid || existingSapUser !== su;

      if (needsUpdate) {
        await ChatSession.updateOne(
          { _id: existing._id },
          {
            $set: {
              systemId: sid,
              sapUser: su,
              updatedAt: new Date(),
            },
          }
        );

        existing.systemId = sid;
        existing.sapUser = su;
        existing.updatedAt = new Date();
      }

      return existing;
    }
  }

  return ChatSession.create({
    owner,
    systemId: sid,
    sapUser: su,
    title: "",
    sapConnectionId: null,
    updatedAt: new Date(),
  });
}

async function findCredentialForSystem({ owner, systemId, sapUser }) {
  const sid = normalizeSystemId(systemId);
  const su = normalizeSapUser(sapUser);

  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (su) {
    const exact = await SapCredential.findOne({
      owner,
      systemId: sid,
      sapUser: { $regex: `^${escapeRegex(su)}$`, $options: "i" },
    }).select({
      systemId: 1,
      sapUser: 1,
      encPassword: 1,
      encIv: 1,
      encTag: 1,
      lastUsedAt: 1,
      updatedAt: 1,
    });

    if (exact) {
      console.log("[SSE] credential exact match found", {
        owner,
        requestedSystemId: sid,
        matchedSystemId: exact.systemId,
        sapUser: exact.sapUser,
      });
      return exact;
    }
  }

  const sameSystemFallback = await SapCredential.findOne({ owner, systemId: sid })
    .sort({ lastUsedAt: -1, updatedAt: -1 })
    .select({
      systemId: 1,
      sapUser: 1,
      encPassword: 1,
      encIv: 1,
      encTag: 1,
      lastUsedAt: 1,
      updatedAt: 1,
    });

  if (sameSystemFallback) {
    console.log("[SSE] credential same-system fallback found", {
      owner,
      requestedSystemId: sid,
      matchedSystemId: sameSystemFallback.systemId,
      sapUser: sameSystemFallback.sapUser,
    });
    return sameSystemFallback;
  }

  return null;
}

export async function getSapAuthOrThrow({ owner, systemId, sapUser }) {
  const sid = normalizeSystemId(systemId);
  const su = normalizeSapUser(sapUser);

  console.log("[SSE] getSapAuthOrThrow", { owner, systemId: sid, sapUser: su });

  const cred = await findCredentialForSystem({ owner, systemId: sid, sapUser: su });

  console.log("[SSE] credential found?", Boolean(cred));
  if (cred) {
    console.log("[SSE] credential selected", {
      owner,
      systemId: sid,
      sapUser: String(cred.sapUser || "").trim().toUpperCase() || null,
      lastUsedAt: cred.lastUsedAt || null,
      updatedAt: cred.updatedAt || null,
      source: su ? "exact-or-regex-match" : "same-system-fallback",
    });
  }

  if (!cred) {
    const e = new Error(
      su
        ? `No SAP credentials saved for systemId=${sid} sapUser=${su}. Please login first.`
        : `No SAP credentials saved for systemId=${sid}. Please login first.`
    );
    e.status = 401;
    throw e;
  }

  const username = String(cred.sapUser || "").trim();
  const password = decryptString({
    enc: cred.encPassword,
    iv: cred.encIv,
    tag: cred.encTag,
  });

  if (!username || !password) {
    const e = new Error("Saved credentials are invalid.");
    e.status = 500;
    throw e;
  }

  await SapCredential.updateOne({ _id: cred._id }, { $set: { lastUsedAt: new Date() } });

  return {
    username,
    password,
    sapUser: username,
    matchedSystemId: normalizeSystemId(cred.systemId),
  };
}

export async function saveUserMessage({ owner, sessionId, text }) {
  return ChatMessage.create({
    owner,
    sessionId,
    role: "user",
    text: String(text),
  });
}

export async function saveAssistantMessage({
  owner,
  sessionId,
  text,
  summary = "",
  extracted = null,
  sapRequest = null,
  data = null,
  responseMeta = null,
  suggestions = [],
}) {
  return ChatMessage.create({
    owner,
    sessionId,
    role: "assistant",
    text,
    summary,
    extracted,
    sapRequest,
    data,
    responseMeta,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
  });
}

export function toResultsArray(sapData) {
  const results = sapData?.d?.results;
  return Array.isArray(results) ? results : [];
}

function na(v) {
  if (v == null) return "N/A";
  if (typeof v === "string") return v.trim() ? v.trim() : "N/A";
  return String(v);
}

function formatFieldName(fieldName) {
  return String(fieldName || "")
    .replace(/^_+/, "")
    .replace(/__/g, "_")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function buildGenericTableReply({ title = "Results", rows = [], fields = [], startIndex = 1 }) {
  if (!Array.isArray(rows) || rows.length === 0) return "No results found.";

  const keys = Array.from(
    rows.slice(0, 10).reduce((set, row) => {
      if (row && typeof row === "object") {
        Object.keys(row).forEach((key) => {
          if (key !== "__metadata") set.add(key);
        });
      }
      return set;
    }, new Set())
  );

  const base = Array.isArray(fields) && fields.length > 0 ? fields.filter((f) => keys.includes(f)) : [];
  const common = ["PoItem", "MatNo", "SuppAcoutNo", "Menge", "NetPrice", "CurKey", "CrtDate"].filter((k) =>
    keys.includes(k)
  );
  const baseOrCommon = base.length > 0 ? base : common.length > 0 ? common : keys.slice(0, 8);

  const mandatoryIds = [
    ...(keys.includes("PoNo") ? ["PoNo"] : []),
    ...(keys.includes("PoItem") ? ["PoItem"] : []),
  ];
  const cols = Array.from(new Set([...mandatoryIds, ...baseOrCommon]));

  const headerRow = ["#", ...cols.map((c) => formatFieldName(c))].join(" | ");
  const baseIndex = Number.isFinite(Number(startIndex)) ? Math.max(1, Number(startIndex)) : 1;
  const dataRows = rows.map((r, i) => [baseIndex + i, ...cols.map((k) => na(r?.[k]))].join(" | "));

  return `${title} (returned ${rows.length})\n\n${headerRow}\n${dataRows.join("\n")}`;
}