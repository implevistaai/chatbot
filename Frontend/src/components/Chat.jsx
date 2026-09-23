import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSpeechToText } from "../hooks/useSpeechToText";
import { sendChatMessageForExport } from "../api/chatApi";
import { sendChatMessageStream } from "../api/chatApiStream";
import { getSolmanChangeRequestDetails, importTransportToProduction, listSolmanChangeRequestsForExport } from "../api/solmanApi";
import { API_BASE } from "../api/client";
import {
  buildExportSummary,
  buildExportFilename,
  createChatExportExcelArrayBuffer,
  createChatExportPdfBlob,
  buildRowsFromChartOrTable,
  downloadChatSectionExcel,
  downloadChatSectionPdf,
} from "../utils/downloadChatPdf";

import Sidebar from "./Sidebar";
import ChatWindow from "./ChatWindow";
import SapLogin from "../pages/saplogin";
import { authFetch } from "../api/authFetch";
import SolmanCreateCrForm from "./SolmanCreateCrForm";
import SolmanCreateTransportRequestForm from "./SolmanCreateTransportRequestForm";
import SolmanCreateTransportTaskForm from "./SolmanCreateTransportTaskForm";
import SolmanImportTransportToProductionForm from "./SolmanImportTransportToProductionForm";
import SolmanReleaseTransportTaskForm from "./SolmanReleaseTransportTaskForm";
import ReleaseTransportForm from "./ReleaseTransportForm";

//---------------------------------------------//
// Utility helpers
//---------------------------------------------//

async function copyToClipboard(text) {
  const t = String(text ?? "");
  if (!t) return false;

  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function generateTitle(text) {
  if (!text) return "New chat";
  const clean = text.trim();
  const words = clean.split(" ").slice(0, 6).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isMongoId(v) {
  return /^[a-f0-9]{24}$/i.test(String(v || ""));
}

function createMessageId(prefix = "msg") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createChatMessage(message = {}) {
  const role = String(message?.role || "").toLowerCase() === "assistant" ? "assistant" : "user";

  return {
    id: createMessageId(role),
    createdAt: Date.now(),
    ...message,
  };
}

function normalizeSystemId(sid) {
  return String(sid || "").trim().toUpperCase();
}

function normalizeActiveSession(v) {
  if (!v || !v.systemId) return null;
  return {
    systemId: normalizeSystemId(v.systemId),
    sapUser: String(v.sapUser || "").trim() || null,
    firstName: String(v.firstName || "").trim(),
    fullName: String(v.fullName || "").trim(),
  };
}

function normalizeSelectedSystem(v) {
  if (!v || !v.systemId) return null;

  const systemId = normalizeSystemId(v.systemId);
  const sapUser = String(v.sapUser || "").trim() || "";
  const status = String(v.status || (v.connected ? "connected" : "disconnected") || "").trim().toLowerCase();
  const connected = Boolean(
    v.connected === true ||
      v.isConnected === true ||
      status === "connected" ||
      status === "online" ||
      status === "active"
  );

  return {
    ...v,
    systemId,
    sapUser,
    connected,
    isConnected: connected,
    status: connected ? "connected" : "disconnected",
    active: connected,
  };
}

function buildDisconnectedSystemNotice(system = null) {
  const systemId = normalizeSystemId(system?.systemId || system?.SystemId || "");
  const systemName = String(system?.name || system?.title || systemId || "selected system").trim();
  const reconnectAction = {
    type: "reconnect_system",
    systemId: systemId || null,
    label: systemId ? `Connect ${systemId}` : "Connect system",
  };

  return {
    text: systemId
      ? `The selected system ${systemName} is disconnected. Please connect it and try again.`
      : "The selected system is disconnected. Please connect it and try again.",
    suggestions: [
      {
        label: reconnectAction.label,
        action: reconnectAction,
      },
    ],
    action: reconnectAction,
  };
}

function isPurchaseOrderPrompt(text) {
  const normalizedText = String(text || "").trim().toLowerCase();
  if (!normalizedText) return false;

  return (
    normalizedText.includes("purchase order") ||
    normalizedText.includes("purchase orders") ||
    /\bpo\b/.test(normalizedText)
  );
}

function readStoredSelectedSystem() {
  try {
    return normalizeSelectedSystem(JSON.parse(localStorage.getItem("sapSelectedSystem") || "null"));
  } catch {
    return null;
  }
}

function readStoredPendingAction() {
  try {
    const raw = localStorage.getItem("solmanPendingAction");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function buildAvailableSystemsFromTiles(tiles = []) {
  if (!Array.isArray(tiles)) return [];

  return tiles
    .map((tile) => {
      const system = tile?.system && typeof tile.system === "object" ? tile.system : {};

      const systemId = String(
        tile?.systemId ||
          tile?.SystemId ||
          system?.systemId ||
          system?.SystemId ||
          tile?.code ||
          system?.code ||
          ""
      )
        .trim()
        .toUpperCase();

      if (!systemId) return null;

      const name = String(
        tile?.name ||
          tile?.systemName ||
          tile?.title ||
          system?.name ||
          system?.systemName ||
          systemId
      ).trim();

      const host = String(
        tile?.host ||
          tile?.Host ||
          system?.host ||
          system?.Host ||
          ""
      )
        .trim()
        .toLowerCase();

      const rawPort =
        tile?.port ??
        tile?.Port ??
        system?.port ??
        system?.Port ??
        "";

      const port = String(rawPort).trim();

      const protocol = String(
        tile?.protocol ||
          tile?.Protocol ||
          system?.protocol ||
          system?.Protocol ||
          "https"
      )
        .trim()
        .toLowerCase();

      const connected =
        tile?.connected === true ||
        tile?.isConnected === true ||
        system?.connected === true ||
        system?.isConnected === true ||
        tile?.status === "connected" ||
        system?.status === "connected" ||
        tile?.active === true ||
        system?.active === true;

      const aliases = Array.isArray(tile?.aliases)
        ? tile.aliases.map((a) => String(a || "").trim()).filter(Boolean)
        : [];

      return {
        systemId,
        name,
        host,
        port,
        protocol,
        connected,
        isConnected: connected,
        status: connected ? "connected" : "disconnected",
        aliases,
        sapUser:
          tile?.sapUser ||
          system?.sapUser ||
          tile?.user ||
          system?.user ||
          "",
      };
    })
    .filter((item) => item && (item.systemId || (item.host && item.port)));
}

function getCurrentConnectedSystem({ activeSession, selectedSystem, availableSystems }) {
  const activeId = normalizeSystemId(activeSession?.systemId);
  const selectedId = normalizeSystemId(selectedSystem?.systemId);
  const activeSapUser = String(activeSession?.sapUser || "").trim();

  if (activeId && activeSapUser) {
    return {
      systemId: activeId,
      sapUser: activeSapUser,
    };
  }

  const activeMatch = activeId
    ? availableSystems.find(
        (item) =>
          normalizeSystemId(item?.systemId) === activeId &&
          item?.connected === true
      )
    : null;

  if (activeMatch) {
    return {
      systemId: activeId,
      sapUser: String(activeSession?.sapUser || activeMatch?.sapUser || "").trim(),
    };
  }

  const selectedMatch = selectedId
    ? availableSystems.find(
        (item) =>
          normalizeSystemId(item?.systemId) === selectedId &&
          item?.connected === true
      )
    : null;

  if (selectedMatch) {
    return {
      systemId: selectedId,
      sapUser: String(selectedMatch?.sapUser || activeSession?.sapUser || "").trim(),
    };
  }

  const connectedSystems = Array.isArray(availableSystems)
    ? availableSystems.filter((item) => item?.connected === true)
    : [];

  const fallbackMatch = connectedSystems.length === 1 ? connectedSystems[0] : null;

  if (fallbackMatch) {
    return {
      systemId: normalizeSystemId(fallbackMatch?.systemId || fallbackMatch?.id || fallbackMatch?.code),
      sapUser: String(fallbackMatch?.sapUser || activeSession?.sapUser || "").trim(),
    };
  }

  return {
    systemId: "",
    sapUser: "",
  };
}

function getSystemConnectionState(systemId, availableSystems) {
  const normalizedSystemId = normalizeSystemId(systemId);
  const matched = normalizedSystemId
    ? (Array.isArray(availableSystems) ? availableSystems : []).find(
        (item) => normalizeSystemId(item?.systemId) === normalizedSystemId
      ) || null
    : null;

  const connected = Boolean(
    matched &&
      (matched?.connected === true ||
        matched?.isConnected === true ||
        matched?.status === "connected" ||
        matched?.active === true)
  );

  return {
    systemId: normalizedSystemId,
    connected,
    status: connected ? "Connected" : "Disconnected",
    matched,
  };
}

function pickBestConnectedSystem(availableSystems = []) {
  const systems = Array.isArray(availableSystems) ? availableSystems : [];

  const scoreSystem = (item) => {
    const name = String(item?.name || item?.label || item?.description || "").toLowerCase();
    const host = String(item?.host || "").toLowerCase();
    const sid = normalizeSystemId(item?.systemId || item?.id || item?.code);

    const isSapLike =
      sid.startsWith("H") ||
      name.includes("sap") ||
      name.includes("solman") ||
      name.includes("solam") ||
      name.includes("solution manager") ||
      name.includes("ecc") ||
      name.includes("s4") ||
      name.includes("hana") ||
      name.includes("erp") ||
      host.includes("sap") ||
      host.includes("solman") ||
      host.includes("solam");

    const scoreFromDate = (value) => {
      const time = value ? new Date(value).getTime() : 0;
      return Number.isFinite(time) ? time : 0;
    };

    return {
      item,
      priority: isSapLike ? 2 : 1,
      score:
        scoreFromDate(item?.connectedAt) * 4 +
        scoreFromDate(item?.lastUsedAt) * 3 +
        scoreFromDate(item?.credentialsUpdatedAt) * 2 +
        scoreFromDate(item?.updatedAt),
    };
  };

  const ranked = systems
    .filter((item) => item?.connected === true || item?.isConnected === true || String(item?.status || "").trim().toLowerCase() === "connected")
    .map(scoreSystem)
    .sort((a, b) => b.priority - a.priority || b.score - a.score);

  return ranked[0]?.item || null;
}

function findSystemMentionInText(text, availableSystems) {
  const normalizedText = String(text || "").trim().toUpperCase();
  if (!normalizedText) return null;

  const systems = Array.isArray(availableSystems) ? availableSystems : [];

  const ranked = systems
    .map((item) => {
      const systemId = normalizeSystemId(item?.systemId || item?.id || item?.code || "");
      const name = String(item?.name || item?.label || item?.description || "").trim();
      const aliases = Array.isArray(item?.aliases)
        ? item.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : [];

      const candidates = [systemId, name, ...aliases]
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      const matched = candidates.find((candidate) => {
        const normalizedCandidate = candidate.toUpperCase();
        if (!normalizedCandidate) return false;
        return (
          normalizedText === normalizedCandidate ||
          normalizedText.includes(` ${normalizedCandidate} `) ||
          normalizedText.startsWith(`${normalizedCandidate} `) ||
          normalizedText.endsWith(` ${normalizedCandidate}`) ||
          normalizedText.includes(` ${normalizedCandidate}`) ||
          normalizedText.includes(`${normalizedCandidate} `)
        );
      });

      if (!matched) return null;

      return {
        systemId,
        name,
        sapUser: String(item?.sapUser || "").trim(),
        connected: Boolean(item?.connected === true || item?.isConnected === true || item?.status === "connected"),
        matchedText: matched,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.matchedText || "").length - String(a.matchedText || "").length);

  return ranked[0] || null;
}

//---------------------------------------------//
// Main component
//---------------------------------------------//

export default function Chat({ onToast = null } = {}) {
  const apiBase = API_BASE;

  const userName = (() => {
    try {
      const system = JSON.parse(localStorage.getItem("sapActiveSystem") || "null");
      return system?.username || "User";
    } catch {
      return "User";
    }
  })();

  const [sapView, setSapView] = useState(() => {
    try {
      const force = localStorage.getItem("forceSapLogin") === "1";
      if (force) return "saplogin";
    } catch {}
    return "chat";
  });

  const [selectedSystem, setSelectedSystem] = useState(() => readStoredSelectedSystem());
  const [statusText, setStatusText] = useState("");
  const [showSolmanCrForm, setShowSolmanCrForm] = useState(false);
  const [showSolmanTransportRequestForm, setShowSolmanTransportRequestForm] = useState(false);
  const [showSolmanTransportTaskForm, setShowSolmanTransportTaskForm] = useState(false);
  const [showSolmanImportTransportToProductionForm, setShowSolmanImportTransportToProductionForm] = useState(false);
  const [showSolmanReleaseTaskForm, setShowSolmanReleaseTaskForm] = useState(false);
  const [showSolmanReleaseTransportForm, setShowSolmanReleaseTransportForm] = useState(false);
  const [pendingAction, setPendingAction] = useState(() => readStoredPendingAction());

  const [activeSession, setActiveSession] = useState(() => {
    try {
      return normalizeActiveSession(JSON.parse(localStorage.getItem("sapActiveSession") || "null"));
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (activeSession) {
      localStorage.setItem("sapActiveSession", JSON.stringify(activeSession));
    } else {
      localStorage.removeItem("sapActiveSession");
    }
  }, [activeSession]);

  useEffect(() => {
    if (selectedSystem) {
      localStorage.setItem("sapSelectedSystem", JSON.stringify(selectedSystem));
    } else {
      localStorage.removeItem("sapSelectedSystem");
    }
  }, [selectedSystem]);

  useEffect(() => {
    if (pendingAction) {
      localStorage.setItem("solmanPendingAction", JSON.stringify(pendingAction));
    } else {
      localStorage.removeItem("solmanPendingAction");
    }
  }, [pendingAction]);

  const [systems, setSystems] = useState([]);
  const [tiles, setTiles] = useState([]);
  const [tilesLoaded, setTilesLoaded] = useState(false);
  const resolvedConnectedSystem = getCurrentConnectedSystem({
    activeSession,
    selectedSystem,
    availableSystems: tiles,
  });

  useEffect(() => {
    if (activeSession?.systemId || selectedSystem?.systemId) return;

    const bestConnected = pickBestConnectedSystem(tiles);
    if (!bestConnected?.systemId) return;

    const systemId = normalizeSystemId(bestConnected.systemId);
    const sapUser = String(bestConnected.sapUser || "").trim();

    setSelectedSystem(
      normalizeSelectedSystem({
        ...bestConnected,
        systemId,
        sapUser,
        connected: true,
        isConnected: true,
        status: "connected",
        active: true,
      })
    );

    setActiveSession(
      normalizeActiveSession({
        systemId,
        sapUser,
      })
    );
  }, [activeSession?.systemId, selectedSystem?.systemId, tiles]);

  const loadSystems = useCallback(async () => {
    try {
      const res = await authFetch(`${apiBase}/sap/systems`, { method: "GET" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok !== true) return;
      const items = Array.isArray(payload.items) ? payload.items : [];
      setSystems(items);
    } catch {}
  }, [apiBase]);

  const loadTiles = useCallback(async () => {
    setTilesLoaded(false);
    try {
      const res = await authFetch(`${apiBase}/sap/tiles`, { method: "GET" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok !== true) return;
      const items = Array.isArray(payload.items) ? payload.items : [];

      const normalized = items.map((tile) => {
        const connected =
          tile?.connected === true ||
          tile?.isConnected === true ||
          tile?.status === "connected" ||
          tile?.active === true;

        return {
          ...tile,
          systemId: normalizeSystemId(tile?.systemId || tile?.SystemId || ""),
          connected,
          isConnected: connected,
          status: connected ? "connected" : "disconnected",
          active: connected,
        };
      });

      setTiles(normalized);
    } catch {
    } finally {
      setTilesLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    function syncActiveSessionFromStorage() {
      try {
        setActiveSession(normalizeActiveSession(JSON.parse(localStorage.getItem("sapActiveSession") || "null")));
      } catch {
        setActiveSession(null);
      }
    }

    function onStorage(e) {
      if (e.key === "sapActiveSession") syncActiveSessionFromStorage();
      if (e.key === "sapSelectedSystem") setSelectedSystem(readStoredSelectedSystem());
    }

    function onSapSessionChanged() {
      syncActiveSessionFromStorage();
      loadSystems();
      loadTiles();
    }

    function onSelectedSystemChanged() {
      setSelectedSystem(readStoredSelectedSystem());
    }

    function onSapConnectionChanged() {
      syncActiveSessionFromStorage();
      loadSystems();
      loadTiles();
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("sapActiveSessionChanged", onSapSessionChanged);
    window.addEventListener("sapSelectedSystemChanged", onSelectedSystemChanged);
    window.addEventListener("sapConnectionChanged", onSapConnectionChanged);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sapActiveSessionChanged", onSapSessionChanged);
      window.removeEventListener("sapSelectedSystemChanged", onSelectedSystemChanged);
      window.removeEventListener("sapConnectionChanged", onSapConnectionChanged);
    };
  }, [loadSystems, loadTiles]);

  useEffect(() => {
    function onChatSessionsChanged() {}
    window.addEventListener("chatSessionsChanged", onChatSessionsChanged);
    return () => window.removeEventListener("chatSessionsChanged", onChatSessionsChanged);
  }, []);

  useEffect(() => {
    let force = false;
    try {
      force = localStorage.getItem("forceSapLogin") === "1";
    } catch {}
    if (!force) setSapView("chat");

    loadSystems();
    loadTiles();
  }, [loadSystems, loadTiles]);

  useEffect(() => {
    if (!tilesLoaded) return;

    let force = false;
    try {
      force = localStorage.getItem("forceSapLogin") === "1";
    } catch {}

    if (force) {
      if (sapView !== "saplogin") setSapView("saplogin");
      return;
    }

    if (sapView !== "saplogin") setSapView("chat");
  }, [tilesLoaded, tiles, sapView]);

  useEffect(() => {
    if (!Array.isArray(tiles) || tiles.length === 0) {
      if (activeSession?.systemId) {
        setSelectedSystem(null);
      }
      return;
    }

    const isTileConnected = (t) =>
      t?.connected === true ||
      t?.isConnected === true ||
      t?.status === "connected" ||
      t?.active === true;

    if (activeSession?.systemId) {
      const matchedTile = tiles.find(
        (t) =>
          normalizeSystemId(t?.systemId || t?.SystemId || t?.name) ===
          normalizeSystemId(activeSession.systemId)
      );

      if (!matchedTile) {
        setSelectedSystem(null);
        setActiveSession(null);
        localStorage.removeItem("sapActiveSession");
        window.dispatchEvent(new Event("sapActiveSessionChanged"));
        return;
      }

      if (!isTileConnected(matchedTile)) {
        setSelectedSystem(matchedTile);
        setActiveSession(null);
        localStorage.removeItem("sapActiveSession");
        window.dispatchEvent(new Event("sapActiveSessionChanged"));
        return;
      }

      setSelectedSystem(matchedTile);

      const nextSapUser = String(
        matchedTile?.sapUser || activeSession?.sapUser || ""
      ).trim();

      const nextSession = normalizeActiveSession({
        ...activeSession,
        systemId: matchedTile.systemId,
        sapUser: nextSapUser,
      });

      const prevKey = JSON.stringify(activeSession || null);
      const nextKey = JSON.stringify(nextSession || null);

      if (nextSession && prevKey !== nextKey) {
        setActiveSession(nextSession);
      }

      return;
    }

    const connectedSelected = selectedSystem?.systemId
      ? tiles.find(
          (t) =>
            normalizeSystemId(t?.systemId || t?.SystemId || t?.name) ===
              normalizeSystemId(selectedSystem.systemId) && isTileConnected(t)
        )
      : null;

    if (connectedSelected) {
      setSelectedSystem(connectedSelected);
    }
  }, [tiles, activeSession, selectedSystem]);

  const [conversations, setConversations] = useState(() => [
    {
      id: "draft",
      title: "New chat",
      messages: [
        createChatMessage({
          role: "assistant",
          text: "Hi, Welcome to ImpleVista AI. How may I assist you?",
          suggestions: [
            "show cr status",
            "Show PO created in January 2026",
            "Show details of PO 4500001933",
          ],
        }),
      ],
      updatedAt: Date.now(),
    },
  ]);

  const [activeId, setActiveId] = useState(() => {
    const saved = localStorage.getItem("chatSessionId");
    return isMongoId(saved) ? saved : "draft";
  });

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const [editingChatId, setEditingChatId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState(null);

  const [editingIndex, setEditingIndex] = useState(null);
  const [editingText, setEditingText] = useState("");

  const [copiedAtIndex, setCopiedAtIndex] = useState(null);

  const abortRef = useRef(null);
  const sendingRef = useRef(false);
  const lastSendGuardRef = useRef({ text: "", convId: "", at: 0 });
  const lastStreamRequestRef = useRef(null);
  const placeholderMessageIdRef = useRef(null);
  const restoredPendingActionRef = useRef(new Set());
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const baseRef = useRef("");
  const interimRef = useRef("");
  const cursorRef = useRef(null);

  const activeConv = useMemo(() => {
    const found = conversations.find((c) => c.id === activeId);
    if (found) return found;

    if (isMongoId(activeId)) {
      return { id: activeId, title: "New chat", messages: [], updatedAt: Date.now() };
    }

    return conversations[0] || null;
  }, [conversations, activeId]);

  useEffect(() => {
    if (pendingAction) return;
    if (!activeConv?.messages?.length) return;

    const restoreKey = String(activeConv.id || "");
    if (restoredPendingActionRef.current.has(restoreKey)) return;

    const messages = Array.isArray(activeConv.messages) ? activeConv.messages : [];
    const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
    const restoredPendingAction = lastAssistant?.pendingAction || lastAssistant?.data?.pendingAction || null;

    if (restoredPendingAction && typeof restoredPendingAction === "object") {
      restoredPendingActionRef.current.add(restoreKey);
      setPendingAction(restoredPendingAction);
    }
  }, [activeConv?.messages, pendingAction]);

  const availableSystems = useMemo(() => {
    return buildAvailableSystemsFromTiles(tiles);
  }, [tiles]);

  const hasConnectedSystems = useMemo(() => {
    return availableSystems.some((item) => item?.connected === true);
  }, [availableSystems]);

  const canSendMessage = useMemo(() => {
    return Boolean(
      hasConnectedSystems ||
        selectedSystem?.systemId ||
        activeSession?.systemId ||
        (() => {
          try {
            const stored = JSON.parse(localStorage.getItem("sapActiveSystem") || "null");
            return normalizeSystemId(stored?.systemId || "");
          } catch {
            return "";
          }
        })()
    );
  }, [
    hasConnectedSystems,
    activeSession?.systemId,
    activeSession?.sapUser,
    selectedSystem?.systemId,
    selectedSystem?.sapUser,
  ]);

  useEffect(() => {
    if (!isMongoId(activeId)) return;

    const exists = conversations.some((c) => c.id === activeId);
    if (exists) return;

    setConversations((prev) => [{ id: activeId, title: "New chat", messages: [], updatedAt: Date.now() }, ...prev]);
  }, [activeId, conversations]);

  useEffect(() => {
    if (isMongoId(activeId)) {
      localStorage.setItem("chatSessionId", activeId);
    } else {
      localStorage.removeItem("chatSessionId");
    }

    if (activeId === "draft") {
      cursorRef.current = null;
    }
  }, [activeId]);

  useEffect(() => {
    if (window.innerWidth > 768) inputRef.current?.focus();
  }, [activeId]);

  useEffect(() => {
    const scrollToBottom = () => {
      const el = bottomRef.current;
      if (!el) return;

      const container = el.closest("section");
      if (!container) return;

      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    };

    const t1 = setTimeout(scrollToBottom, 150);
    const t2 = setTimeout(scrollToBottom, 400);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [activeConv?.messages?.length, loading, showSolmanCrForm]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [activeId]);

  const onStop = useCallback(() => {
    try {
      abortRef.current?.abort();
    } catch {}
  }, []);

  function focusInput() {
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function updateConversationById(convId, updater) {
    setConversations((prev) =>
      prev.map((c) => {
        if (String(c.id) !== String(convId)) return c;
        const messages = typeof updater === "function" ? updater(c.messages) : updater;
        console.log("[Chat] updateConversationById", {
          convId,
          beforeCount: Array.isArray(c.messages) ? c.messages.length : 0,
          afterCount: Array.isArray(messages) ? messages.length : 0,
          beforeIds: (Array.isArray(c.messages) ? c.messages : []).map((message) => message?.id || null),
          afterIds: (Array.isArray(messages) ? messages : []).map((message) => message?.id || null),
        });
        return { ...c, messages, updatedAt: Date.now() };
      })
    );
  }

  function updateActiveMessages(updater) {
    updateConversationById(activeId, updater);
  }

  function upsertAssistantPlaceholder(convId, messageId, payload = {}) {
    if (!messageId) return;

    const normalizeSuggestions = (value) => {
      if (!Array.isArray(value)) return null;
      const filtered = value.filter(Boolean);
      return filtered.length > 0 ? filtered : null;
    };

    setConversations((prev) =>
      prev.map((conversation) => {
        if (String(conversation.id) !== String(convId)) return conversation;

        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const placeholderIndex = messages.findIndex((message) => String(message?.id) === String(messageId));
        const existingMessage = placeholderIndex >= 0 ? messages[placeholderIndex] : null;
        console.log("[Chat] upsertAssistantPlaceholder", {
          convId,
          messageId,
          placeholderIndex,
          beforeCount: messages.length,
          payloadKeys: Object.keys(payload || {}),
        });
        const placeholder = createChatMessage({
          id: messageId,
          role: "assistant",
          text: payload.text ?? "",
          suggestions:
            normalizeSuggestions(payload.suggestions) !== null
              ? normalizeSuggestions(payload.suggestions)
              : existingMessage?.suggestions,
          summary: payload.summary || "",
          summaryStatus: payload.summary ? "done" : "pending",
          data: payload.data !== undefined ? payload.data : existingMessage?.data || null,
          chart:
            payload.chart ||
            (payload?.type === "status_distribution" ? payload : null) ||
            (payload?.data?.statusDistribution ? payload.data.statusDistribution : null) ||
            existingMessage?.chart ||
            null,
          extracted: payload.extracted !== undefined ? payload.extracted : existingMessage?.extracted || null,
          responseMeta:
            payload.responseMeta !== undefined
              ? payload.responseMeta
              : existingMessage?.responseMeta || null,
          query: payload.query || "",
          pagination: payload.pagination !== undefined ? payload.pagination : existingMessage?.pagination || null,
          pendingAction:
            payload.pendingAction !== undefined
              ? payload.pendingAction
              : existingMessage?.pendingAction || null,
          action: payload.action !== undefined ? payload.action : existingMessage?.action || null,
        });

        if (placeholderIndex === -1) {
          return {
            ...conversation,
            messages: [...messages, placeholder],
            updatedAt: Date.now(),
          };
        }

        const nextMessages = [...messages];
        nextMessages[placeholderIndex] = {
          ...nextMessages[placeholderIndex],
          ...placeholder,
        };

        return {
          ...conversation,
          messages: nextMessages,
          updatedAt: Date.now(),
        };
      })
    );
  }

  function appendUserMessageOnce(convId, messageText) {
    const nextText = String(messageText || "").trim();
    if (!nextText) return;

    setConversations((prev) =>
      prev.map((conversation) => {
        if (String(conversation.id) !== String(convId)) return conversation;

        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const lastMessage = messages[messages.length - 1] || null;
        const lastText = String(lastMessage?.text || lastMessage?.summary || "").trim();

        if (lastMessage?.role === "user" && lastText === nextText) {
          return conversation;
        }

        console.log("[Chat] appendUserMessageOnce", {
          convId,
          beforeCount: messages.length,
          nextText,
        });

        return {
          ...conversation,
          messages: [...messages, createChatMessage({ role: "user", text: nextText })],
          updatedAt: Date.now(),
        };
      })
    );
  }

  function handleDelete(id) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) setActiveId("draft");
    setMenuOpenId(null);
  }

  function saveRename(id) {
    if (!editingTitle.trim()) return cancelRename();
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: editingTitle } : c)));
    setEditingChatId(null);
    setEditingTitle("");
  }

  function cancelRename() {
    setEditingChatId(null);
    setEditingTitle("");
  }

  function onNewChat() {
    setActiveId("draft");
    cursorRef.current = null;
    setShowSolmanCrForm(false);
    setPendingAction(null);

    setConversations((prev) => {
      const withoutDraft = prev.filter((c) => c.id !== "draft");
      return [
        {
          id: "draft",
          title: "New chat",
          messages: [
            {
              role: "assistant",
              text: "Hi, Welcome to ImpleVista AI. How may I assist you?",
              suggestions: [
                "show cr status",
                "Show PO created in January 2026",
                "Show details of PO 4500001933",
              ],
            },
          ],
          updatedAt: Date.now(),
        },
        ...withoutDraft,
      ];
    });

    setInput("");
    baseRef.current = "";
    interimRef.current = "";
    setEditingIndex(null);
    setEditingText("");
    focusInput();
  }

  function startEditMessage(idx) {
    const m = activeConv?.messages?.[idx];
    if (!m || m.role !== "user") return;
    setEditingIndex(idx);
    setEditingText(m.text || "");
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditingText("");
    focusInput();
  }

  function applyEditLocal({ removeFollowingAssistant = true } = {}) {
    const newText = editingText.trim();
    if (editingIndex == null || !newText) return null;

    updateActiveMessages((msgs) => {
      const copy = [...msgs];
      copy[editingIndex] = { ...copy[editingIndex], text: newText };
      if (removeFollowingAssistant) return copy.slice(0, editingIndex + 1);
      return copy;
    });

    setEditingIndex(null);
    setEditingText("");
    return newText;
  }

  const ensureSessionExistsLocally = useCallback((sessionId, firstUserText) => {
    if (!isMongoId(sessionId)) return;

    const title = generateTitle(firstUserText || "");

    setConversations((prev) => {
      if (prev.some((c) => String(c.id) === String(sessionId))) return prev;

      const hasDraft = prev.some((c) => c.id === "draft");
      if (hasDraft) {
        return prev.map((c) => {
          if (c.id !== "draft") return c;

          const nextTitle =
            c.title && c.title !== "New chat" ? c.title : title;

          return { ...c, id: sessionId, title: nextTitle, updatedAt: Date.now() };
        });
      }

      return [{ id: sessionId, title, messages: [], updatedAt: Date.now() }, ...prev];
    });
  }, []);

  async function onSend({
    overrideText,
    displayText = "",
    fromEdit = false,
    forcedSystemId = null,
    systemId = null,
    sapUser = null,
    businessScope = "",
    pendingContext = null,
    sessionId = null,
  } = {}) {
    const requestText =
      typeof overrideText === "string"
        ? overrideText
        : typeof input === "string"
          ? input
          : "";

    const text = requestText.trim();
    const uiText = String(displayText || text).trim();
    const currentConvId = activeId;

    if (!text || loading) return;
    if (sendingRef.current) return;

    const explicitSystemId = String(forcedSystemId || systemId || "")
      .trim()
      .toUpperCase();

    const explicitSapUser = String(sapUser || "").trim();

    const optimisticActiveId = normalizeSystemId(activeSession?.systemId);
    const optimisticSapUser = String(activeSession?.sapUser || "").trim();

    const isSystemConnectedNow = (sid) => {
      const normalizedSid = normalizeSystemId(sid);
      if (!normalizedSid) return false;

      if (optimisticActiveId === normalizedSid && optimisticSapUser) {
        return true;
      }

      const matched = availableSystems.find(
        (item) => normalizeSystemId(item?.systemId) === normalizedSid
      );

      return matched?.connected === true;
    };

    const matchedRequestedSystem = explicitSystemId
      ? availableSystems.find(
          (item) => String(item?.systemId || "").trim().toUpperCase() === explicitSystemId
        ) || null
      : null;

    const currentConnected = getCurrentConnectedSystem({
      activeSession,
      selectedSystem,
      availableSystems,
    });

    const mentionedSystem = findSystemMentionInText(text, availableSystems);
    const mentionedSystemId = normalizeSystemId(mentionedSystem?.systemId || "");

    const requestedSystemId = normalizeSystemId(explicitSystemId || mentionedSystemId || "");
    const selectedSystemId = normalizeSystemId(selectedSystem?.systemId || "");
    const selectedConnectionState = getSystemConnectionState(selectedSystemId, availableSystems);
    const storedSelectedSystemId = normalizeSystemId(selectedSystem?.systemId || "");
    const storedSelectedState = getSystemConnectionState(storedSelectedSystemId, availableSystems);
    const activeSystemState = getSystemConnectionState(normalizeSystemId(activeSession?.systemId || ""), availableSystems);

    if (isPurchaseOrderPrompt(text) && selectedSystemId && !selectedConnectionState.connected) {
      const notice = buildDisconnectedSystemNotice(selectedSystem);
      updateConversationById(currentConvId, (m) => [
        ...m,
        {
          role: "assistant",
          text: notice.text,
          suggestions: notice.suggestions,
          action: notice.action,
        },
      ]);
      setInput("");
      return;
    }

    if (
      requestedSystemId &&
      !getSystemConnectionState(requestedSystemId, availableSystems).connected
    ) {
      const notice = buildDisconnectedSystemNotice(
        getSystemConnectionState(requestedSystemId, availableSystems).matched || {
          systemId: requestedSystemId,
        }
      );
      updateConversationById(currentConvId, (m) => [
        ...m,
        {
          role: "assistant",
          text: notice.text,
          suggestions: notice.suggestions,
          action: notice.action,
        },
      ]);
      setInput("");
      return;
    }

    const fallbackConnectedSystemId = activeSystemState.connected
      ? activeSystemState.systemId
      : storedSelectedState.connected
        ? storedSelectedState.systemId
        : null;
    const fallbackSapUser = String(
      activeSession?.sapUser || selectedSystem?.sapUser || currentConnected.sapUser || ""
    ).trim();

    const effectiveSapUser = explicitSapUser || fallbackSapUser || selectedSystem?.sapUser || "";

    const safeExplicitSystemId =
      explicitSystemId &&
      isSystemConnectedNow(explicitSystemId)
        ? explicitSystemId
        : "";

    const effectiveAvailableSystems = (() => {
      if (!optimisticActiveId || !optimisticSapUser) return availableSystems;

      const hasOptimisticSystem = availableSystems.some(
        (item) => normalizeSystemId(item?.systemId) === optimisticActiveId
      );

      if (!hasOptimisticSystem) {
        return [
          ...availableSystems,
          {
            systemId: optimisticActiveId,
            sapUser: optimisticSapUser,
            connected: true,
            isConnected: true,
            status: "connected",
          },
        ];
      }

      return availableSystems.map((item) => {
        if (normalizeSystemId(item?.systemId) !== optimisticActiveId) return item;

        return {
          ...item,
          sapUser: optimisticSapUser || item?.sapUser || "",
          connected: true,
          isConnected: true,
          status: "connected",
        };
      });
    })();

    const requestAvailableSystems = safeExplicitSystemId
      ? effectiveAvailableSystems.filter(
          (item) => String(item?.systemId || "").trim().toUpperCase() === safeExplicitSystemId
        )
      : effectiveAvailableSystems;

    sendingRef.current = true;
    baseRef.current = "";
    interimRef.current = "";
    const sessionIdToSend = isMongoId(sessionId)
      ? sessionId
      : isMongoId(currentConvId)
        ? currentConvId
        : null;

    const upperText = String(text || "").trim().toUpperCase();
    const isFollowupChoice = upperText === "ROW" || upperText === "INDIA";
    const isPendingFollowup = Boolean(pendingContext || pendingAction);
    const sendSignature = `${currentConvId}::${uiText}::${isFollowupChoice ? "choice" : "normal"}`;
    const now = Date.now();
    const lastSend = lastSendGuardRef.current;
    const isDuplicateLocalSend =
      lastSend.convId === currentConvId &&
      lastSend.text === uiText &&
      now - lastSend.at < 1000;

    if (isDuplicateLocalSend) {
      return;
    }

    lastSendGuardRef.current = {
      text: uiText,
      convId: currentConvId,
      at: now,
    };

    const logMessages = (label, messages) => {
      console.log(`[Chat] ${label}`, (Array.isArray(messages) ? messages : []).map((message) => ({
        id: message?.id || null,
        role: message?.role || null,
        text: String(message?.text || message?.summary || "").slice(0, 80),
        createdAt: message?.createdAt || null,
        updatedAt: message?.updatedAt || null,
      })));
    };

    if (!fromEdit) {
      const beforeMessages = activeConv?.messages || [];
      logMessages("messages before Prompt 2", beforeMessages);

      appendUserMessageOnce(currentConvId, uiText);

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== currentConvId) return c;

          if (isFollowupChoice || isPendingFollowup) {
            return c;
          }

          if (c.title === "New chat" || c.title === "SAP MM Chat") {
            return { ...c, title: generateTitle(text) };
          }

          return c;
        })
      );
    }

    setInput("");
    setLoading(true);

    setTimeout(() => inputRef.current?.blur(), 50);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const isNextQuery = /\b(next|more|another|load|show\s+more)\b/i.test(text);
      if (!isNextQuery) cursorRef.current = null;

      if (!isFollowupChoice && !isPendingFollowup) {
        console.log("[Chat] preserving prior assistant messages for new request", {
          currentConvId,
          activeMessageCount: Array.isArray(activeConv?.messages) ? activeConv.messages.length : 0,
        });
      }

      setStatusText("Interpreting your query...");

      let streamedPayload = null;
      const streamRequestId = createMessageId("stream");
      lastStreamRequestRef.current = streamRequestId;
      const assistantPlaceholderId = createMessageId("assistant");
      placeholderMessageIdRef.current = assistantPlaceholderId;

      upsertAssistantPlaceholder(currentConvId, assistantPlaceholderId, {
        text: "",
        summary: "",
        query: text,
        pendingAction: pendingContext || pendingAction || null,
      });

      await sendChatMessageStream(text, {
        apiBase,
        systemId: safeExplicitSystemId || null,
        sapUser: effectiveSapUser || null,
        sessionId: sessionIdToSend,
        availableSystems:
          requestAvailableSystems.length > 0 ? requestAvailableSystems : effectiveAvailableSystems,
        cursor: isNextQuery ? cursorRef.current : null,
        businessScope: businessScope || "",
        pendingAction: pendingContext || pendingAction || null,
        signal: controller.signal,

        onPhase: ({ message }) => {
          if (message) setStatusText(message);
        },

        onReply: (payload) => {
          if (lastStreamRequestRef.current !== streamRequestId) return;
          streamedPayload = payload;
        },
      });

      if (lastStreamRequestRef.current !== streamRequestId) {
        return;
      }

      const data = streamedPayload;
      if (!data) throw new Error("No reply received from stream");

      setPendingAction(null);

      const targetConvId =
        data?.sessionId && isMongoId(data.sessionId) ? data.sessionId : currentConvId;

      if (data?.sessionId && isMongoId(data.sessionId)) {
        if (currentConvId === "draft") {
          ensureSessionExistsLocally(data.sessionId, text);

          if (!isFollowupChoice && !isPendingFollowup) {
            const newTitle = generateTitle(text);
            authFetch(`${apiBase}/chat/sessions/${data.sessionId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: newTitle }),
            }).catch(() => {});
          }
        }

        setActiveId(data.sessionId);
        window.dispatchEvent(new Event("chatSessionsChanged"));
      }

      upsertAssistantPlaceholder(targetConvId, placeholderMessageIdRef.current, {
        text: data.reply ?? "",
        suggestions: data.suggestions,
        summary: data.summary || "",
        summaryStatus: data.summary ? "done" : "pending",
        data: data.data || null,
        chart:
          data.chart ||
          (data?.type === "status_distribution" ? data : null) ||
          (data?.data?.statusDistribution ? data.data.statusDistribution : null),
        extracted: data.extracted || null,
        responseMeta: data.responseMeta || null,
        query: text,
        pagination: data.pagination || null,
      });

      if (String(data?.responseMeta?.serviceName || "").trim() === "PENDING_INVOICE_STATUS") {
        console.log("[PENDING_INVOICE_DEBUG] assistant placeholder inserted", {
          sessionId: data.sessionId,
          hasText: Boolean(data.reply),
          hasSummary: Boolean(data.summary),
          textLength: String(data.reply || "").length,
          summaryLength: String(data.summary || "").length,
          dataKeys: Object.keys(data?.data || {}),
        });
      }

      placeholderMessageIdRef.current = null;

      cursorRef.current = data?.cursor || null;
    } catch (e) {
      const payload = e?.payload || null;
      const payloadSessionId = isMongoId(payload?.sessionId) ? payload.sessionId : null;
      const errorConvId = payloadSessionId || currentConvId;

      if (payloadSessionId && currentConvId === "draft") {
        ensureSessionExistsLocally(payloadSessionId, text);
        setActiveId(payloadSessionId);
        window.dispatchEvent(new Event("chatSessionsChanged"));
      }

      const assistantPlaceholderId = placeholderMessageIdRef.current;
      const updateAssistantPlaceholder = (nextPayload) => {
        if (!assistantPlaceholderId) return false;
        upsertAssistantPlaceholder(errorConvId, assistantPlaceholderId, nextPayload);
        return true;
      };

      const actionType = String(payload?.action?.type || payload?.action || "").toLowerCase();
      const actionFormId = String(payload?.action?.formId || payload?.formId || "").trim();

      if (actionType === "open_form" && actionFormId === "solman_create_cr") {
        setPendingAction(payload?.pendingAction || null);
        setShowSolmanCrForm(true);
        setShowSolmanTransportRequestForm(false);
        setShowSolmanTransportTaskForm(false);
        setShowSolmanReleaseTaskForm(false);
        setShowSolmanReleaseTransportForm(false);

        updateAssistantPlaceholder({
          text: payload?.message || "Please complete the required change request details.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (actionType === "open_form" && actionFormId === "solman_create_transport_task") {
        setPendingAction({
          collected: payload?.prefilledData || payload?.pendingAction?.collected || {},
          missingFields: payload?.missingFields || payload?.pendingAction?.missingFields || [],
        });
        setShowSolmanTransportTaskForm(true);
        setShowSolmanCrForm(false);
        setShowSolmanTransportRequestForm(false);
        setShowSolmanReleaseTaskForm(false);
        setShowSolmanReleaseTransportForm(false);

        updateAssistantPlaceholder({
          text:
            payload?.message ||
            "Please complete the required transport task details.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (actionType === "open_form" && actionFormId === "solman_release_transport_task") {
        setPendingAction({
          collected: payload?.prefilledData || payload?.pendingAction?.collected || {},
          missingFields: payload?.missingFields || payload?.pendingAction?.missingFields || [],
        });
        setShowSolmanReleaseTaskForm(true);
        setShowSolmanCrForm(false);
        setShowSolmanTransportTaskForm(false);
        setShowSolmanTransportRequestForm(false);
        setShowSolmanReleaseTransportForm(false);

        updateAssistantPlaceholder({
          text: payload?.message || "Please complete the required task number.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (actionType === "open_form" && actionFormId === "solman_create_transport_request") {
        setPendingAction({
          collected: payload?.prefilledData || payload?.pendingAction?.collected || {},
          missingFields: payload?.missingFields || payload?.pendingAction?.missingFields || [],
        });
        setShowSolmanTransportRequestForm(true);
        setShowSolmanCrForm(false);
        setShowSolmanTransportTaskForm(false);
        setShowSolmanImportTransportToProductionForm(false);
        setShowSolmanReleaseTaskForm(false);
        setShowSolmanReleaseTransportForm(false);

        updateAssistantPlaceholder({
          text: payload?.message || "Please complete the required transport request details.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (actionType === "open_form" && actionFormId === "solman_release_transport") {
        setPendingAction({
          collected: payload?.prefilledData || payload?.pendingAction?.collected || {},
          missingFields: payload?.missingFields || payload?.pendingAction?.missingFields || [],
        });
        setShowSolmanReleaseTransportForm(true);
        setShowSolmanCrForm(false);
        setShowSolmanTransportTaskForm(false);
        setShowSolmanTransportRequestForm(false);
        setShowSolmanReleaseTaskForm(false);
        setShowSolmanImportTransportToProductionForm(false);

        updateAssistantPlaceholder({
          text: payload?.message || "Please complete the required transport release details.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (actionType === "open_form" && actionFormId === "solman_import_transport_to_production") {
        setPendingAction({
          collected: payload?.prefilledData || payload?.pendingAction?.collected || {},
          missingFields: payload?.missingFields || payload?.pendingAction?.missingFields || [],
        });
        setShowSolmanImportTransportToProductionForm(true);
        setShowSolmanCrForm(false);
        setShowSolmanTransportTaskForm(false);
        setShowSolmanTransportRequestForm(false);
        setShowSolmanReleaseTaskForm(false);
        setShowSolmanReleaseTransportForm(false);

        updateAssistantPlaceholder({
          text: payload?.message || "Please provide the transport number to import to production.",
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (payload?.action?.type === "add_system") {
        updateAssistantPlaceholder({
          text:
            payload?.message ||
            "No transport details found for the connected system.",
          suggestions: [payload?.action?.label || "Add System"],
          action: payload?.action || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (
        payload?.status === "needs_input" &&
        Array.isArray(payload?.missingFields) &&
        payload.missingFields.includes("processType")
      ) {
        setPendingAction(payload?.pendingAction || null);

        const options = Array.isArray(payload?.action?.options)
          ? payload.action.options.map((x) => x?.label || x?.value).filter(Boolean)
          : ["ROW", "INDIA"];

        updateAssistantPlaceholder({
          text:
            payload?.message ||
            "Which landscape would you like to view the Change Requests from?",
          suggestions: options,
          pendingAction: payload?.pendingAction || null,
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (
        payload?.status === "needs_input" &&
        Array.isArray(payload?.missingFields) &&
        payload.missingFields.includes("systemId")
      ) {
        const candidates = Array.isArray(payload?.systemResolution?.candidates)
          ? payload.systemResolution.candidates
          : [];

        updateAssistantPlaceholder({
          text: payload?.message || "Please specify which system to use.",
          ...(candidates.length > 0
            ? {
                suggestions: candidates.map((id) => `Use ${id}`),
              }
            : {}),
        }) || updateConversationById(errorConvId, (m) => m);
      } else if (payload?.status === "disconnected_system") {
        const targetSystem =
          payload?.systemResolution?.targetSystem ||
          payload?.action?.system ||
          payload?.action ||
          selectedSystem ||
          activeSession ||
          null;
        const notice = buildDisconnectedSystemNotice(targetSystem);

        updateAssistantPlaceholder({
          text: notice.text,
          suggestions: notice.suggestions,
          action: notice.action,
        }) || updateConversationById(errorConvId, (m) => m);
      } else {
        updateAssistantPlaceholder({ text: `Error: ${e.message}` }) ||
          updateConversationById(errorConvId, (m) => m);
      }
    } finally {
      setLoading(false);
      sendingRef.current = false;
      abortRef.current = null;
      setStatusText("");
    }
  }

  function onKeyDown(e) {
    if (editingIndex != null) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const newText = applyEditLocal({ removeFollowingAssistant: true });
        if (newText) onSend({ overrideText: newText, fromEdit: true });
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
        return;
      }
    }
  }

  const { supported, listening, start, stop } = useSpeechToText({
    onText: (text, meta) => {
      if (!canSendMessage) return;
      const t = String(text || "").trim();
      if (!t) return;

      const base = baseRef.current.trim();

      if (meta?.interim) {
        interimRef.current = t;
        setInput(base ? `${base} ${t}` : t);
      } else {
        interimRef.current = "";
        setInput(base ? `${base} ${t}` : t);
      }

      focusInput();
    },
    onError: () => {
      interimRef.current = "";
      focusInput();
    },
  });

  function onMicClick() {
    if (!supported) {
      alert("Speech recognition not supported in this browser (try Chrome / Edge).");
      return;
    }

    if (!canSendMessage) return;

    if (listening) {
      stop();
      interimRef.current = "";
      focusInput();
      return;
    }

    baseRef.current = input.trim();
    interimRef.current = "";

    start();
    focusInput();
  }

  async function onCopyAssistant(idx, text) {
    const ok = await copyToClipboard(text);
    if (!ok) return;

    setCopiedAtIndex(idx);
    setTimeout(() => setCopiedAtIndex(null), 1200);
  }

  function getAssistantDownloadContext(group) {
    if (!group || !Array.isArray(group.messages) || group.messages.length === 0) {
      return { rowMessage: null, filterMessage: null };
    }

    const messages = [...group.messages];

    const withRowsOrChart = messages.find((msg) => {
      if (!msg) return false;
      const payloadRows = buildRowsFromChartOrTable(msg?.data);
      const hasRows = Array.isArray(payloadRows) && payloadRows.length > 0;
      const hasChart = Boolean(msg?.chart || msg?.data?.chart);
      return hasRows || hasChart;
    });

    const withFilters = messages.find((msg) => {
      if (!msg) return false;

      const filters = msg?.extracted?.filters || {};
      return Boolean(filters.fromDate && filters.toDate);
    });

    return {
      rowMessage: withRowsOrChart || withFilters || messages[messages.length - 1] || null,
      filterMessage: withFilters || withRowsOrChart || messages[messages.length - 1] || null,
    };
  }

  function getAssistantMessageForDownload(group, mode = "current") {
    const { rowMessage, filterMessage } = getAssistantDownloadContext(group);

    if (mode === "entire") {
      return filterMessage || rowMessage;
    }

    return rowMessage || filterMessage;
  }

  function normalizeSolmanRows(result, fallback = []) {
    if (Array.isArray(result?.results)) return result.results;
    if (Array.isArray(result?.result?.results)) return result.result.results;
    if (Array.isArray(result?.result?.rows)) return result.result.rows;
    if (Array.isArray(result?.rows)) return result.rows;
    if (Array.isArray(result?.data)) return result.data;
    if (Array.isArray(result?.result?.data)) return result.result.data;
    if (Array.isArray(fallback)) return fallback;
    return [];
  }

  function buildChartFromRows(rows = []) {
    const counts = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
      const status = String(row?.STATUS || row?.status || "Unknown").trim() || "Unknown";
      counts.set(status, (counts.get(status) || 0) + 1);
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

    return {
      type: "status_distribution",
      chartType: "donut",
      title: "Status Distribution",
      totalCRs: total,
      data: [...counts.entries()].map(([status, count]) => ({
        status,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      })),
    };
  }

  function getLastNDaysRange(days = 30) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - Math.max(1, Number(days) || 30) + 1);

    const toYyyymmdd = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}${month}${day}`;
    };

    return {
      fromDate: toYyyymmdd(start),
      toDate: toYyyymmdd(end),
    };
  }

  function isPurchaseOrderDownloadContext(message = {}) {
    const rows = buildRowsFromChartOrTable(message?.data || message?.result || message);
    const hasPoShape = Array.isArray(rows) && rows.some((row) => {
      if (!row || typeof row !== "object") return false;
      return (
        row.PoNo != null ||
        row.PoItem != null ||
        row.CrtDate != null ||
        row.UserCreated != null ||
        row.SuppAcoutNo != null ||
        row.NetPrice != null ||
        row.CurKey != null
      );
    });

    if (hasPoShape) return true;

    const system = String(message?.extracted?.system || message?.responseMeta?.system || "").trim().toLowerCase();
    const intent = String(message?.extracted?.intent || message?.responseMeta?.intent || message?.responseMeta?.executor || "").trim().toLowerCase();
    const text = String(message?.text || message?.summary || "").trim().toLowerCase();

    if (system === "s4hana") return true;
    if (intent.includes("purchase_order")) return true;

    return (
      text.includes("purchase order") ||
      text.includes("purchase orders") ||
      /\bpo\b/.test(text)
    );
  }

  async function fetchEntirePurchaseOrderData(message, fallbackFilters = {}) {
    const filters = {
      ...(fallbackFilters || {}),
    };

    const selectedSystemId = normalizeSystemId(selectedSystem?.systemId || activeSession?.systemId || "");
    const selectedState = getSystemConnectionState(selectedSystemId, availableSystems);
    if (selectedSystemId && !selectedState.connected) {
      const notice = buildDisconnectedSystemNotice();
      throw new Error(notice.text);
    }

    let storedActiveSystem = null;
    try {
      storedActiveSystem = JSON.parse(localStorage.getItem("sapActiveSystem") || "null");
    } catch {
      storedActiveSystem = null;
    }

    const exportSystemId = String(
      message?.responseMeta?.systemId ||
        message?.data?.responseMeta?.systemId ||
        message?.data?.systemId ||
        activeSession?.systemId ||
        storedActiveSystem?.systemId ||
        ""
    ).trim();
    const exportSapUser = String(
      message?.responseMeta?.sapUser ||
        message?.data?.responseMeta?.sapUser ||
        message?.data?.sapUser ||
        activeSession?.sapUser ||
        storedActiveSystem?.sapUser ||
        ""
    ).trim();

    if (!exportSystemId || !exportSapUser) {
      throw new Error("Active SAP connection is required for full export.");
    }

    if (!filters.fromDate || !filters.toDate) {
      const last30Days = getLastNDaysRange(30);
      filters.fromDate = filters.fromDate || last30Days.fromDate;
      filters.toDate = filters.toDate || last30Days.toDate;
      if (!filters.dateText) filters.dateText = "last 30 days";
    }

    const queryText = "show purchase orders";

    const availableSystems = Array.isArray(systems) ? systems : [];
    const rows = [];
    const pageSize = 200;
    let totalCount = null;

    for (let page = 0; page < 30; page += 1) {
      const skip = page * pageSize;
      if (totalCount && totalCount > 0) {
        const progress = Math.min(99, Math.round((rows.length / totalCount) * 100));
        showDownloadToast("info", "Downloading", `Fetching purchase orders ${progress}%`, progress);
      } else if (page === 0) {
        showDownloadToast("info", "Downloading", "Fetching purchase orders 0%", 0);
      }

      const response = await sendChatMessageForExport({
        query: queryText,
        sessionId: null,
        systemId: exportSystemId,
        sapUser: exportSapUser,
        availableSystems,
        limit: pageSize,
        skip,
        fromDate: filters.fromDate,
        toDate: filters.toDate,
      });

      const responseBody = response?.payload || {};
      const responseResult =
        responseBody?.result?.result ||
        responseBody?.result ||
        responseBody?.data ||
        responseBody?.rows ||
        responseBody;
      const pageRows = buildRowsFromChartOrTable(responseResult);

      if (pageRows.length > 0) {
        rows.push(...pageRows);
      }

      if (!totalCount) {
        const rawTotal = Number(
          responseBody?.result?.result?.totalCount ||
            responseBody?.result?.result?.count ||
            responseBody?.result?.totalCount ||
            responseBody?.result?.count ||
            responseBody?.totalCount ||
            responseBody?.count ||
            0
        );
        if (Number.isFinite(rawTotal) && rawTotal > 0) {
          totalCount = rawTotal;
        }
      }

      const returnedCount = Number(
        responseBody?.result?.result?.returned ??
          responseBody?.result?.returned ??
          pageRows.length
      );

      if (!response.ok && pageRows.length === 0) {
        const errorMessage =
          responseBody?.error?.message ||
          responseBody?.error ||
          responseBody?.message ||
          `Chat request failed (${response.status})`;

        throw new Error(errorMessage);
      }

      if (totalCount && totalCount > 0) {
        const progress = Math.min(99, Math.round((rows.length / totalCount) * 100));
        showDownloadToast(
          "info",
          "Downloading",
          `Fetching purchase orders ${progress}% (${rows.length}/${totalCount})`,
          progress
        );
      }

      if ((Number.isFinite(totalCount) && totalCount > 0 && rows.length >= totalCount) || returnedCount < pageSize) {
        break;
      }
    }

    if (Number.isFinite(totalCount) && totalCount > 0 && rows.length > totalCount) {
      rows.length = totalCount;
    }

    rows.totalCount = totalCount ?? rows.length;
    return rows;
  }

  async function fetchEntireSolmanData(message, fallbackFilters = {}) {
    const filters = {
      ...(fallbackFilters || {}),
      ...(message?.extracted?.filters || {}),
    };

    const selectedSystemId = normalizeSystemId(selectedSystem?.systemId || activeSession?.systemId || "");
    const selectedState = getSystemConnectionState(selectedSystemId, availableSystems);
    if (selectedSystemId && !selectedState.connected) {
      const notice = buildDisconnectedSystemNotice();
      throw new Error(notice.text);
    }
    let storedActiveSystem = null;
    try {
      storedActiveSystem = JSON.parse(localStorage.getItem("sapActiveSystem") || "null");
    } catch {
      storedActiveSystem = null;
    }

    const exportSystemId = String(
      message?.responseMeta?.systemId ||
        message?.data?.responseMeta?.systemId ||
        message?.data?.systemId ||
        activeSession?.systemId ||
        storedActiveSystem?.systemId ||
        ""
    ).trim();
    const exportSapUser = String(
      message?.responseMeta?.sapUser ||
        message?.data?.responseMeta?.sapUser ||
        message?.data?.sapUser ||
        activeSession?.sapUser ||
        storedActiveSystem?.sapUser ||
        ""
    ).trim();

    if (!exportSystemId || !exportSapUser) {
      throw new Error("Active SAP connection is required for full export.");
    }

    if (!filters.fromDate || !filters.toDate) {
      if (isPurchaseOrderDownloadContext(message)) {
        const last30Days = getLastNDaysRange(30);
        filters.fromDate = filters.fromDate || last30Days.fromDate;
        filters.toDate = filters.toDate || last30Days.toDate;
        if (!filters.dateText) filters.dateText = "last 30 days";
      } else {
        throw new Error("This export needs a date range to fetch the full result set.");
      }
    }

    const baseRequest = {
      systemId: exportSystemId,
      sapUser: exportSapUser,
      processType: filters.processType || "YMHF",
      businessScope: filters.businessScope || "",
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      triggerAll: filters.triggerAll || "X",
      status: filters.status || "",
      statusMode: filters.statusMode || "",
      excludeStatuses: Array.isArray(filters.excludeStatuses) ? filters.excludeStatuses : [],
      dateText: filters.dateText || "",
      top: null,
      createdBy: filters.createdBy || "",
      createdByMode: filters.createdByMode || "",
    };

    if (filters.fromDate && filters.toDate) {
      const response = await listSolmanChangeRequestsForExport(baseRequest);
      const responseBody = response?.payload || {};
      const result =
        responseBody?.result ||
        responseBody?.data ||
        responseBody?.rows ||
        responseBody;
      const normalizedRows = normalizeSolmanRows(result, message?.data);

      if (!response.ok && normalizedRows.length === 0) {
        const errorMessage =
          responseBody?.error?.message ||
          responseBody?.error ||
          responseBody?.message ||
          `SolMan request failed (${response.status})`;

        throw new Error(errorMessage);
      }

      return normalizedRows;
    }

    return Array.isArray(message?.data) ? message.data : [];
  }

  async function fetchActiveProfileEmail() {
    let storedActiveSession = null;
    try {
      storedActiveSession = JSON.parse(localStorage.getItem("sapActiveSession") || "null");
    } catch {
      storedActiveSession = null;
    }

    const resolvedConnection = getCurrentConnectedSystem({
      activeSession: activeSession || storedActiveSession,
      selectedSystem,
      availableSystems: tiles,
    });

    const systemId = String(resolvedConnection?.systemId || "").trim();
    const sapUser = String(resolvedConnection?.sapUser || "").trim();

    if (!systemId || !sapUser) {
      throw new Error("Active SAP connection is required to resolve the sender email.");
    }

    const response = await authFetch(`${apiBase}/sap/user-profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ systemId, sapUser }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || "Failed to fetch the active profile email.");
    }

    const profile = payload?.profile || payload || {};
    const email = String(profile?.email || profile?.Email || profile?.mail || profile?.Mail || "").trim();
    const firstName = String(profile?.firstName || profile?.Firstname || profile?.first_name || "").trim();
    const lastName = String(profile?.lastName || profile?.Lastname || profile?.last_name || "").trim();

    return {
      email,
      firstName,
      lastName,
      profile,
    };
  }

  function blobToBase64(blob) {
    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;

      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }

      return btoa(binary);
    });
  }

  function showDownloadToast(type, title, message, progress = null) {
    if (typeof onToast !== "function") return;
    onToast({
      type,
      title,
      message,
      progress: Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : null,
      duration: type === "info" ? 12000 : 2500,
    });
  }

  async function onDownloadAssistant({ group, mode, fromDate = null, toDate = null, format = "pdf" }) {
    const message = getAssistantMessageForDownload(group, mode);
    if (!message) {
      showDownloadToast("error", "Download failed", "No export data found for this response.");
      return { ok: false, message: "No export data found for this response." };
    }

    const isCurrent = mode === "current";
    showDownloadToast(
      "info",
      "Preparing download",
      isCurrent
        ? "Building current section PDF..."
        : `Building ${String(format || "pdf").toUpperCase()} for selected date range...`
    );

    try {
      const sectionRows = buildRowsFromChartOrTable(message?.data);
      const chartData = message?.chart || message?.data?.chart || null;
      const filters = message?.extracted?.filters || {};

      if (isCurrent) {
        const filename = buildExportFilename({
          baseName: "report",
          fromDate: filters?.fromDate,
          toDate: filters?.toDate,
          format: "pdf",
        });

        downloadChatSectionPdf({
          title: "SAP Chat Export",
          sectionLabel: "Current section",
          summary: message?.summary || message?.text || "",
          rows: sectionRows,
          chartData: chartData || buildChartFromRows(sectionRows),
          filters,
          includeResultTable: true,
          filename,
        });
        showDownloadToast("success", "Download ready", "Current section PDF has been downloaded.");
        return { ok: true };
      }

      const selectedFromDate = String(fromDate || "").trim();
      const selectedToDate = String(toDate || "").trim();

      if (!selectedFromDate || !selectedToDate) {
        throw new Error("From Date and To Date are required.");
      }

      if (selectedFromDate > selectedToDate) {
        throw new Error("From Date cannot be later than To Date.");
      }

      const rangeFilters = {
        ...filters,
        fromDate: selectedFromDate,
        toDate: selectedToDate,
      };

      const isPurchaseOrderExport = isPurchaseOrderDownloadContext(message);
      const fullRows = isPurchaseOrderExport
        ? await fetchEntirePurchaseOrderData(message, rangeFilters)
        : await fetchEntireSolmanData(message, rangeFilters);

      if (!Array.isArray(fullRows) || fullRows.length === 0) {
        throw new Error("Selected date range does not contain any available records.");
      }

      const fullChart = chartData || buildChartFromRows(fullRows);
      const summary = buildExportSummary({
        summary: "",
        totalCount: fullRows.length,
        filters: rangeFilters,
      });
      const exportFilename = buildExportFilename({
        baseName: "report",
        fromDate: selectedFromDate,
        toDate: selectedToDate,
        format,
      });

      if (String(format || "pdf").toLowerCase() === "xlsx") {
        downloadChatSectionExcel({
          title: "SAP Chat Export",
          sectionLabel: `Selected range: ${selectedFromDate} to ${selectedToDate}`,
          summary,
          rows: fullRows,
          filters: rangeFilters,
          filename: exportFilename,
        });
      } else {
        downloadChatSectionPdf({
          title: "SAP Chat Export",
          sectionLabel: `Selected range: ${selectedFromDate} to ${selectedToDate}`,
          summary,
          rows: fullRows,
          chartData: fullChart,
          filters: rangeFilters,
          filename: exportFilename,
        });
      }

      showDownloadToast(
        "success",
        "Download ready",
        `${String(format || "pdf").toUpperCase()} download started with ${fullRows.length} record(s).`
      );

      return { ok: true };
    } catch (err) {
      showDownloadToast("error", "Download failed", err?.message || "Download failed.");
      return { ok: false, message: err?.message || "Download failed." };
    }
  }

  async function onEmailAssistant({
    group,
    recipientType,
    recipientEmail,
    scope = "current",
    fromDate = "",
    toDate = "",
    format = "pdf",
    customMessageEnabled = false,
    customMessage = "",
    onStatusChange = null,
  }) {
    const message = getAssistantMessageForDownload(group, "current");
    if (!message) {
      showDownloadToast("error", "Email failed", "No export data found for this response.");
      return { ok: false, message: "No export data found for this response." };
    }

    const filters = message?.extracted?.filters || {};
    const selectedFormat = String(format || "pdf").toLowerCase() === "xlsx" ? "xlsx" : "pdf";

    const normalizedScope = String(scope || "current").trim().toLowerCase();
    const isRangeScope = normalizedScope === "range";

    const exportFromDate = String(fromDate || filters?.fromDate || "").trim();
    const exportToDate = String(toDate || filters?.toDate || "").trim();

    onStatusChange?.("Generating report...");

    const emailPayload = (() => {
      if (isRangeScope) {
        if (!exportFromDate || !exportToDate) {
          throw new Error("A date range is required before sending this report by email.");
        }

        const isPurchaseOrderExport = isPurchaseOrderDownloadContext(message);
        const rangeFilters = {
          ...filters,
          fromDate: exportFromDate,
          toDate: exportToDate,
        };

        return {
          kind: "range",
          filters: rangeFilters,
          fileName: buildExportFilename({
            baseName: "report",
            fromDate: exportFromDate,
            toDate: exportToDate,
            format: selectedFormat,
          }),
          rowsPromise: isPurchaseOrderExport
            ? fetchEntirePurchaseOrderData(message, rangeFilters)
            : fetchEntireSolmanData(message, rangeFilters),
          sectionLabel: `Selected range: ${exportFromDate} to ${exportToDate}`,
          summaryFilters: rangeFilters,
        };
      }

      const currentRows = buildRowsFromChartOrTable(message?.data);
      return {
        kind: "current",
        filters,
        fileName: buildExportFilename({
          baseName: "report_current_section",
          fromDate: "current",
          toDate: "section",
          format: selectedFormat,
        }),
        rowsPromise: Promise.resolve(Array.isArray(currentRows) ? currentRows : []),
        sectionLabel: "Current section",
        summaryFilters: filters,
      };
    })();

    const fullRows = await emailPayload.rowsPromise;

    if (!Array.isArray(fullRows) || (fullRows.length === 0 && emailPayload.kind === "range")) {
      throw new Error(
        emailPayload.kind === "range"
          ? "Selected date range does not contain any available records."
          : "Current section does not contain any available records."
      );
    }

    const summary = buildExportSummary({
      summary: emailPayload.kind === "current" && (!Array.isArray(fullRows) || fullRows.length === 0)
        ? String(message?.summary || message?.text || "").trim()
        : "",
      totalCount: fullRows.length,
      filters: emailPayload.summaryFilters,
    });
    const fileName = emailPayload.fileName;
    const emailFilters = emailPayload.filters || filters;

    const senderProfile = await fetchActiveProfileEmail();
    const senderEmail = String(senderProfile?.email || "").trim();
    const senderName = `${String(senderProfile?.firstName || "").trim()} ${String(senderProfile?.lastName || "").trim()}`.trim();

    if (recipientType !== "me" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipientEmail || "").trim())) {
      throw new Error("Please enter a valid recipient email address.");
    }

    onStatusChange?.("Generating attachment...");

    let attachmentContentBase64 = "";
    let contentType = "application/pdf";
    let attachmentSize = 0;

    if (selectedFormat === "xlsx") {
      const arrayBuffer = createChatExportExcelArrayBuffer({
        title: "SAP Chat Export",
        sectionLabel: emailPayload.kind === "range"
          ? `Selected range: ${exportFromDate} to ${exportToDate}`
          : "Current section",
        summary,
        rows: fullRows,
        filters: emailFilters,
      });

      attachmentSize = arrayBuffer?.byteLength || 0;
      if (attachmentSize <= 0) {
        throw new Error("Attachment generation failed.");
      }

      const attachmentBlob = new Blob([arrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      if (attachmentBlob.size <= 0) {
        throw new Error("Attachment generation failed.");
      }

      attachmentContentBase64 = await blobToBase64(attachmentBlob);
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      attachmentSize = attachmentBlob.size;
    } else {
      const pdfBlob = createChatExportPdfBlob({
        title: "SAP Chat Export",
        sectionLabel: emailPayload.kind === "range"
          ? `Selected range: ${exportFromDate} to ${exportToDate}`
          : "Current section",
        summary,
        rows: fullRows,
        chartData: fullRows.length > 0 ? buildChartFromRows(fullRows) : null,
        filters: emailFilters,
        includeResultTable: fullRows.length > 0,
      });

      if (!pdfBlob || pdfBlob.size <= 0) {
        throw new Error("Attachment generation failed.");
      }

      attachmentContentBase64 = await blobToBase64(pdfBlob);
      contentType = "application/pdf";
      attachmentSize = pdfBlob.size;
    }

    if (!attachmentContentBase64 || attachmentSize <= 0) {
      throw new Error("Attachment generation failed.");
    }

    onStatusChange?.("Sending email...");

    const emailBodyText = customMessageEnabled && String(customMessage || "").trim()
      ? String(customMessage || "").trim()
      : emailPayload.kind === "range"
        ? `Please find the ${selectedFormat.toUpperCase()} report attached for ${exportFromDate} to ${exportToDate}.`
        : `Please find the ${selectedFormat.toUpperCase()} report attached for the current section.`;

    const to = recipientType === "me" ? senderEmail : String(recipientEmail || "").trim();

    try {
      const response = await authFetch(`${apiBase}/chat/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to,
          senderEmail,
          senderName,
          subject: emailPayload.kind === "range"
            ? `SAP Chat Export (${exportFromDate} to ${exportToDate})`
            : "SAP Chat Export (Current section)",
          customMessage: emailBodyText,
          attachment: {
            filename: fileName,
            contentType,
            contentBase64: attachmentContentBase64,
          },
        }),
      });

      const payload = await response.json().catch(() => ({}));

      console.log("Email API Response:", response);
      console.log("Email API Response Payload:", payload);

      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || payload?.message || "Failed to send email. Please try again.");
      }

      showDownloadToast(
        "success",
        "Email sent",
        `Email sent successfully to ${recipientType === "me" ? senderEmail : to}`
      );

      return { ok: true };
    } catch (error) {
      console.error("Email API Error:", error);
      const message = error?.message || "Failed to send email. Please try again.";
      showDownloadToast("error", "Email failed", message);
      return { ok: false, message };
    }
  }

  
  function onMessagesScroll(e) {
    const el = e.target;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setShowScrollDown(!isNearBottom);
  }

  async function handleViewCrStatus({ objectId, processType = "YMHF" }) {
    const selectedId = normalizeSystemId(selectedSystem?.systemId || activeSession?.systemId || "");
    const selectedState = getSystemConnectionState(selectedId, availableSystems);

    if (selectedId && !selectedState.connected) {
      const notice = buildDisconnectedSystemNotice();
      updateActiveMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: notice.text,
          suggestions: notice.suggestions,
        },
      ]);
      return;
    }

    const resolvedConnection = selectedState.connected
      ? {
          systemId: selectedState.systemId,
          sapUser: String(selectedState.matched?.sapUser || activeSession?.sapUser || selectedSystem?.sapUser || "").trim(),
        }
      : resolvedConnectedSystem;

    if (!resolvedConnection?.systemId) {
      updateActiveMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: "Cannot fetch CR status because no active SAP system is selected.",
        },
      ]);
      return;
    }

    if (!resolvedConnection?.sapUser) {
      updateActiveMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: "Cannot fetch CR status because no active SAP user is available.",
        },
      ]);
      return;
    }

    try {
      const data = await getSolmanChangeRequestDetails({
        systemId: resolvedConnection.systemId,
        sapUser: resolvedConnection.sapUser,
        objectId,
        processType,
      });

      const item = data?.result?.results?.[0];

      if (!item) {
        updateActiveMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `No details found for CR ${objectId}.`,
          },
        ]);
        return;
      }

      updateActiveMessages((m) => [
        ...m,
        {
          role: "assistant",
          text:
            `CR ${item.OBJECT_ID}\n` +
            `Short Description: ${item.SHORT_DESC || "-"}\n` +
            `Status: ${item.STATUS || "-"}\n` +
            `Priority: ${item.PRIORITY || "-"}\n` +
            `Created On: ${item.CREATED_ON || "-"}\n` +
            `Last Changed By: ${item.LAST_CHANGED_BY || "-"}\n` +
            `Last Changed At: ${item.LAST_CHANGED_AT || "-"}\n` +
            `Category: ${item.CATEGORY || "-"}`,
        },
      ]);
    } catch (err) {
      updateActiveMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: err?.message || "Failed to fetch change request details.",
        },
      ]);
    }
  }

  const handleConnectedFromSapLogin = async (payload) => {
    try {
      localStorage.removeItem("forceSapLogin");
    } catch {}

    const sid = normalizeSystemId(payload?.systemId || payload?.system?.systemId);
    const sapUser = String(payload?.sapUser || payload?.system?.sapUser || "").trim();

    if (sid) {
      const connectedSystem = normalizeSelectedSystem({
        systemId: sid,
        sapUser,
        name: payload?.system?.name || sid,
        connected: true,
        isConnected: true,
        status: "connected",
        active: true,
      });

      const next = normalizeActiveSession({
        systemId: sid,
        sapUser,
        firstName: payload?.firstName,
        fullName: payload?.fullName,
      });

      setActiveSession(next);
      setSelectedSystem(connectedSystem);

      localStorage.setItem("sapActiveSession", JSON.stringify(next));
      localStorage.setItem("sapSelectedSystem", JSON.stringify(connectedSystem));
      localStorage.setItem("sapConnected", "true");
      window.dispatchEvent(new Event("sapActiveSessionChanged"));
      window.dispatchEvent(new Event("sapSelectedSystemChanged"));
    }

    await loadTiles();
    await loadSystems();

    setSapView("chat");
  };

  const handleDisconnect = async (system = null) => {
    try {
      const sid = normalizeSystemId(
        system?.systemId ||
        activeSession?.systemId ||
        selectedSystem?.systemId
      );

      const disconnectedSelection = sid
        ? normalizeSelectedSystem({
            ...(system || selectedSystem || {}),
            systemId: sid,
            sapUser: String(
              system?.sapUser || activeSession?.sapUser || selectedSystem?.sapUser || ""
            ).trim(),
            connected: false,
            isConnected: false,
            status: "disconnected",
            active: false,
          })
        : null;

      if (disconnectedSelection) {
        setSelectedSystem(disconnectedSelection);
      }

      setActiveSession(null);
      setShowSolmanCrForm(false);
      setPendingAction(null);

      localStorage.removeItem("sapActiveSession");
      localStorage.removeItem("sapConnected");
      if (disconnectedSelection) {
        localStorage.setItem("sapSelectedSystem", JSON.stringify(disconnectedSelection));
      }
      window.dispatchEvent(new Event("sapActiveSessionChanged"));
      window.dispatchEvent(new Event("sapSelectedSystemChanged"));

      await authFetch(`${apiBase}/sap/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sid ? { systemId: sid } : {}),
      }).catch(() => {});
    } finally {
      await loadTiles();
      await loadSystems();
    }
  };

  const openSapLogin = (system = null) => {
    try {
      localStorage.removeItem("forceSapLogin");
    } catch {}

    setSelectedSystem(system);
    setSapView("saplogin");
    setShowSolmanCrForm(false);
    setPendingAction(null);
  };

  const handleSystemSelect = useCallback((system) => {
    setSelectedSystem(system);

    try {
      const prev = JSON.parse(localStorage.getItem("sapActiveSystem") || "null");
      const payload = {
        systemId: system?.systemId ? normalizeSystemId(system.systemId) : null,
        name: system?.name || "",
        username: prev?.username || "User",
        sapUser: system?.sapUser || prev?.sapUser || null,
      };

      if (payload.systemId) {
        localStorage.setItem("sapActiveSystem", JSON.stringify(payload));
      }

      localStorage.setItem(
        "sapSelectedSystem",
        JSON.stringify(
          normalizeSelectedSystem({
            ...system,
            systemId: payload.systemId,
            sapUser: system?.sapUser || prev?.sapUser || null,
            connected: true,
            isConnected: true,
            status: "connected",
            active: true,
          })
        )
      );
      window.dispatchEvent(new Event("sapSelectedSystemChanged"));
    } catch {}

    localStorage.removeItem("chatSessionId");
    setActiveId("draft");
    onNewChat();
  }, []);

  const solmanCreateCrForm = showSolmanCrForm ? (
    <div className="px-4 pb-4">
      <SolmanCreateCrForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onCancel={() => {
          setShowSolmanCrForm(false);
        }}
        onSuccess={async (data) => {
          const crId =
            data?.changeRequestId ||
            data?.result?.changeRequestId ||
            data?.result?.objectId ||
            String(data?.message || "").match(/CR\s+(\d+)/i)?.[1] ||
            "";
          const successMessage = data?.message || "Change request created successfully.";
          const statusText = data?.status ? `Status: ${data.status}` : "";
          const collected = pendingAction?.collected || {};
          const summary = data?.summary || collected || {};
          console.log("[Chat] SolMan create success callback", {
            rawData: data,
            crId,
            successMessage,
            statusText,
            summary,
            collected,
          });
          const successData = {
            viewType: "solman_create_cr_success",
            changeRequestId: crId,
            status: data?.status || summary?.status || "",
            shortDesc:
              summary?.shortDesc ||
              summary?.ShortDesc ||
              data?.shortDesc ||
              collected?.ShortDesc ||
              "",
            deliveryResponsible:
              summary?.deliveryResponsible ||
              summary?.DeliveryResponsible ||
              data?.deliveryResponsible ||
              collected?.DeliveryResponsible ||
              "",
            developer:
              summary?.developer ||
              summary?.Developer ||
              data?.developer ||
              collected?.Developer ||
              "",
            tester:
              summary?.tester ||
              summary?.Tester ||
              data?.tester ||
              collected?.Tester ||
              "",
            landscape:
              summary?.landscape ||
              summary?.Landscape ||
              data?.landscape ||
              collected?.Landscape ||
              "",
            workItemReference:
              summary?.workItemReference ||
              summary?.WorkItemReference ||
              data?.workItemReference ||
              collected?.WorkItemReference ||
              "",
            url:
              summary?.url ||
              summary?.URL ||
              data?.url ||
              collected?.REQ_URL_NAV?.[0]?.URL ||
              "",
            urlName:
              summary?.urlName ||
              summary?.URL_NAME ||
              data?.urlName ||
              collected?.REQ_URL_NAV?.[0]?.URL_NAME ||
              "",
          };

          setShowSolmanCrForm(false);
          setPendingAction(null);

          updateActiveMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: [successMessage, statusText].filter(Boolean).join(" "),
              summary: successMessage,
              data: successData,
            },
          ]);
        }}
      />
    </div>
  ) : null;

  const solmanCreateTransportRequestForm = showSolmanTransportRequestForm ? (
    <div className="px-4 pb-4">
      <SolmanCreateTransportRequestForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onSuccess={(data) => {
          const result = data?.result || data || {};
          const changeRequestId = String(result?.changeRequestId || result?.CrNumber || result?.CRNumber || result?.changeRequest || "").trim();
          const transportRequest = String(result?.transportRequest || result?.TrNumber || result?.TRNumber || "").trim();
          const workbenchTransport = String(result?.workbenchTransport || result?.WorkbenchTR || "").trim();
          const customizingTransport = String(result?.customizingTransport || result?.CustomizingTR || "").trim();
          const sapMessage = String(result?.message || data?.message || "Transport Request created successfully.").trim();

          setShowSolmanTransportRequestForm(false);
          setPendingAction(null);

          const messageLines = [
            sapMessage,
            changeRequestId ? `CR Number: ${changeRequestId}` : null,
            transportRequest ? `TR Number: ${transportRequest}` : null,
            workbenchTransport ? `Workbench TR: ${workbenchTransport}` : null,
            customizingTransport ? `Customizing TR: ${customizingTransport}` : null,
          ].filter(Boolean);

          updateActiveMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: messageLines.join("\n"),
              summary: sapMessage,
              data: result,
            },
          ]);
        }}
        onCancel={() => {
          setShowSolmanTransportRequestForm(false);
        }}
      />
    </div>
  ) : null;

  const solmanCreateTransportTaskForm = showSolmanTransportTaskForm ? (
    <div className="px-4 pb-4">
      <SolmanCreateTransportTaskForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onSuccess={(data) => {
          setShowSolmanTransportTaskForm(false);
          setPendingAction(null);

          updateActiveMessages((m) => [
            ...m,
            {
              role: "assistant",
              text:
                data?.message ||
                `Transport task creation completed for CR ${data?.summary?.changeRequest || ""}.`,
              summary: data?.message || "Transport task created successfully.",
              data,
            },
          ]);
        }}
        onCancel={() => {
          setShowSolmanTransportTaskForm(false);
        }}
      />
    </div>
  ) : null;

  const solmanImportTransportToProductionForm = showSolmanImportTransportToProductionForm ? (
    <div className="px-4 pb-4">
      <SolmanImportTransportToProductionForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onSubmit={async ({ transportNumber }) => {
          const result = await importTransportToProduction({
            systemId: resolvedConnectedSystem?.systemId || "",
            sapUser: resolvedConnectedSystem?.sapUser || "",
            transportNumber,
            sessionId: isMongoId(activeId) ? activeId : "",
          });

          updateActiveMessages((messages) => [
            ...messages,
            {
              role: "assistant",
              text: result?.message || `Transport ${transportNumber} imported to production.`,
              summary: result?.message || "Transport imported to production.",
              data: result,
            },
          ]);

          setShowSolmanImportTransportToProductionForm(false);
          setPendingAction(null);
        }}
        onCancel={() => {
          setShowSolmanImportTransportToProductionForm(false);
        }}
      />
    </div>
  ) : null;

  const solmanReleaseTransportTaskForm = showSolmanReleaseTaskForm ? (
    <div className="px-4 pb-4">
      <SolmanReleaseTransportTaskForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onSuccess={(data) => {
          setShowSolmanReleaseTaskForm(false);
          setPendingAction(null);

          updateActiveMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: data?.message || "Task released successfully.",
              summary: data?.message || "Task released successfully."
            ,
              data,
            },
          ]);
        }}
        onCancel={() => {
          setShowSolmanReleaseTaskForm(false);
        }}
      />
    </div>
  ) : null;

  const solmanReleaseTransportForm = showSolmanReleaseTransportForm ? (
    <div className="px-4 pb-4">
      <ReleaseTransportForm
        systemId={resolvedConnectedSystem?.systemId || ""}
        sapUser={resolvedConnectedSystem?.sapUser || ""}
        sessionId={isMongoId(activeId) ? activeId : ""}
        initialValues={pendingAction?.collected || {}}
        pendingAction={pendingAction}
        onSuccess={(data) => {
          setShowSolmanReleaseTransportForm(false);
          setPendingAction(null);

          const result = data?.data || data || {};
          const transportNumber = String(result?.transportNumber || data?.transportNumber || "").trim();
          const status = String(result?.status || data?.status || "").trim();
          const warning = Boolean(result?.warning || data?.warning);
          const message = String(result?.message || data?.message || "Transport released successfully.").trim();
          const messages = Array.isArray(result?.messages) ? result.messages : Array.isArray(data?.messages) ? data.messages : [];
          const formattedMessages = messages
            .map((item) => String(item?.MSG_DESC || item?.MsgDesc || item?.message || item?.MESSAGE || item || "").trim())
            .filter(Boolean);

          const detailLines = [
            warning ? "⚠ Transport released with warning." : "✅ Transport released successfully.",
            transportNumber ? `Transport Number : ${transportNumber}` : null,
            status ? `Status : ${status}` : null,
            message ? `SAP Message : ${message}` : null,
            formattedMessages.length > 0 ? "" : null,
            formattedMessages.length > 0 ? "Messages" : null,
            ...formattedMessages.map((line) => `• ${line}`),
          ].filter((line) => line !== null);

          updateActiveMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: detailLines.join("\n"),
              summary: message || "Transport released successfully.",
              data: {
                viewType: warning ? "solman_release_transport_warning" : "solman_release_transport_success",
                transportNumber,
                status,
                warning,
                message,
                messages: formattedMessages,
                raw: result?.raw || data?.raw || null,
              },
            },
          ]);
        }}
        onCancel={() => {
          setShowSolmanReleaseTransportForm(false);
        }}
      />
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 bg-[#f7f7f8] text-zinc-800">
      {sapView === "saplogin" ? (
        <SapLogin
          onConnected={handleConnectedFromSapLogin}
          selectedSystem={selectedSystem}
          onBack={() => {
            let force = false;
            try {
              force = localStorage.getItem("forceSapLogin") === "1";
            } catch {}
            if (force) return;

            setSapView("chat");
            setSelectedSystem(null);
          }}
        />
      ) : (
        <div className="flex h-full overflow-hidden">
          <Sidebar
            sidebarOpen={sidebarOpen}
            collapsed={collapsed}
            activeId={activeId}
            conversations={conversations}
            editingChatId={editingChatId}
            editingTitle={editingTitle}
            menuOpenId={menuOpenId}
            setSidebarOpen={setSidebarOpen}
            setCollapsed={setCollapsed}
            setMenuOpenId={setMenuOpenId}
            setEditingChatId={setEditingChatId}
            setEditingTitle={setEditingTitle}
            saveRename={saveRename}
            cancelRename={cancelRename}
            onNewChat={onNewChat}
            setActiveId={setActiveId}
            handleDelete={handleDelete}
            userName={userName}
            onAddNewSystem={() => openSapLogin(null)}
            systems={systems}
            onOpenSapLogin={openSapLogin}
            onSystemsChanged={async () => {
              await loadSystems();
              await loadTiles();
            }}
            activeSession={activeSession}
          />

          <ChatWindow
            loading={loading}
            input={input}
            listening={listening}
            supported={supported}
            showScrollDown={showScrollDown}
            activeConv={activeConv}
            sessionId={isMongoId(activeConv?.id) ? activeConv.id : null}
            editingIndex={editingIndex}
            editingText={editingText}
            statusText={statusText}
            copiedAtIndex={copiedAtIndex}
            bottomRef={bottomRef}
            inputRef={inputRef}
            setSidebarOpen={setSidebarOpen}
            setInput={setInput}
            onSend={onSend}
            pendingAction={pendingAction}
            onStop={onStop}
            onKeyDown={onKeyDown}
            onMicClick={onMicClick}
            onCopyAssistant={onCopyAssistant}
            onDownloadAssistant={onDownloadAssistant}
            onEmailAssistant={onEmailAssistant}
            onToast={onToast}
            startEditMessage={startEditMessage}
            cancelEdit={cancelEdit}
            applyEditLocal={applyEditLocal}
            setEditingText={setEditingText}
            onMessagesScroll={onMessagesScroll}
            onDisconnect={handleDisconnect}
            userName={userName}
            onOpenSapLogin={openSapLogin}
            systems={systems}
            onSystemSelect={handleSystemSelect}
            setConversations={setConversations}
            activeSession={activeSession}
            setActiveSession={setActiveSession}
            setActiveId={setActiveId}
            onConnected={async () => {
              await loadTiles();
              await loadSystems();
            }}
            tiles={tiles}
            showSolmanCrForm={showSolmanCrForm}
            setShowSolmanCrForm={setShowSolmanCrForm}
            solmanCreateCrForm={solmanCreateCrForm}
            solmanCreateTransportRequestForm={solmanCreateTransportRequestForm}
            solmanCreateTransportTaskForm={solmanCreateTransportTaskForm}
            solmanImportTransportToProductionForm={solmanImportTransportToProductionForm}
            solmanReleaseTransportTaskForm={solmanReleaseTransportTaskForm}
            solmanReleaseTransportForm={solmanReleaseTransportForm}
          />
        </div>
      )}
    </div>
  );
}

//old logic