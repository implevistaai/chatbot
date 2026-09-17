import MessageBubble from "../MessageBubble";
import toast from "react-hot-toast";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildExportFilename } from "../../utils/downloadChatPdf";
import {
  FiCopy,
  FiCheck,
  FiEdit2,
  FiDownload,
  FiMail,
  FiRefreshCw,
  FiChevronDown,
} from "react-icons/fi";

function normalizeBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "1", "connected", "online", "active"].includes(v)) return true;
    if (["false", "no", "0", "disconnected", "offline", "inactive"].includes(v)) return false;
  }

      {emailDialogOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10001] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeEmailDialog} />

          <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-white/20 bg-white shadow-[0_25px_90px_rgba(15,23,42,0.38)]">
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-900 to-cyan-700 px-6 py-4 text-white">
              <p className="text-xs uppercase tracking-[0.24em] text-sky-200">Email Delivery</p>
              <h3 className="mt-1 text-xl font-semibold">Send report by email</h3>
              <p className="mt-2 text-sm text-sky-100/90">
                Choose the current section or a particular date range before selecting a format.
              </p>
            </div>

            <div className="px-6 py-5">
              <div className={`mb-5 grid gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 ${emailWizardSteps.length === 6 ? "grid-cols-6" : "grid-cols-5"}`}>
                {emailWizardSteps.map((label, index) => {
                  const active = emailStep === index + 1;
                  const completed = emailStep > index + 1;
                  return (
                    <div
                      key={label}
                      className={`rounded-2xl px-3 py-2 text-center transition ${
                        active
                          ? "bg-sky-600 text-white"
                          : completed
                            ? "bg-sky-100 text-sky-900"
                            : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-5">
                {emailStep === 1 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Who would you like to send this report to?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "me", label: "Send to Me" },
                        { value: "other", label: "Send to Another Person" },
                      ].map((option) => {
                        const active = emailDraft.recipientType === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, recipientType: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>

                    {emailDraft.recipientType === "other" && (
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-700">Recipient email address</span>
                        <input
                          type="email"
                          value={emailDraft.recipientEmail}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, recipientEmail: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                          placeholder="john.doe@company.com"
                        />
                      </label>
                    )}
                  </div>
                )}

                {emailStep === 2 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">What do you want to send?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "current", label: "Current section" },
                        { value: "range", label: "Particular date range" },
                      ].map((option) => {
                        const active = emailDraft.scope === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, scope: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {emailIsRange && emailStep === 3 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Select date range</p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">From Date</span>
                        <input
                          type="date"
                          value={emailDraft.fromDate}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, fromDate: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                        />
                      </label>

                      <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">To Date</span>
                        <input
                          type="date"
                          value={emailDraft.toDate}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, toDate: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                        />
                      </label>
                    </div>
                    <p className="text-xs text-slate-500">These dates are required only when sending a particular date range.</p>
                  </div>
                )}

                {((!emailIsRange && emailStep === 3) || (emailIsRange && emailStep === 4)) && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Select file format</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "pdf", label: "PDF" },
                        { value: "xlsx", label: "Excel (.xlsx)" },
                      ].map((option) => {
                        const active = emailDraft.format === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, format: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {((!emailIsRange && emailStep === 4) || (emailIsRange && emailStep === 5)) && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Would you like to add a custom email message?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: true, label: "Yes" },
                        { value: false, label: "No" },
                      ].map((option) => {
                        const active = emailDraft.customMessageEnabled === option.value;
                        return (
                          <button
                            key={String(option.value)}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, customMessageEnabled: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>

                    {emailDraft.customMessageEnabled && (
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-700">Message</span>
                        <textarea
                          rows={5}
                          value={emailDraft.customMessage}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, customMessage: e.target.value }))}
                          className="w-full resize-none rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                          placeholder="Hi, please find the report attached."
                        />
                      </label>
                    )}
                  </div>
                )}

                {((!emailIsRange && emailStep === 5) || (emailIsRange && emailStep === 6)) && (
                  <div className="space-y-3 rounded-3xl bg-slate-50 p-4 text-sm text-slate-700">
                    <div><span className="font-medium">Recipient:</span> {emailDraft.recipientType === "me" ? "Send to Me" : emailDraft.recipientEmail || "-"}</div>
                    <div><span className="font-medium">Scope:</span> {emailDraft.scope === "current" ? "Current section" : "Particular date range"}</div>
                    {emailDraft.scope === "range" ? (
                      <div><span className="font-medium">Date range:</span> {emailDraft.fromDate || "-"} to {emailDraft.toDate || "-"}</div>
                    ) : null}
                    <div><span className="font-medium">Format:</span> {emailDraft.format.toUpperCase()}</div>
                    <div><span className="font-medium">Custom message:</span> {emailDraft.customMessageEnabled ? "Yes" : "No"}</div>
                  </div>
                )}

                {emailError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {emailError}
                  </div>
                ) : null}

                {emailStatus ? (
                  <div className={`rounded-2xl px-4 py-3 text-sm ${emailStatus === "Sending email..." ? "border border-sky-200 bg-sky-50 text-sky-700" : emailStatus.startsWith("Email sent successfully") ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "border border-slate-200 bg-slate-50 text-slate-700"}`}>
                    {emailStatus}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
              <button
                type="button"
                onClick={closeEmailDialog}
                disabled={emailBusy}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={prevEmailStep}
                  disabled={emailBusy || emailStep === 1}
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Back
                </button>

                {emailStep < emailMaxStep ? (
                  <button
                    type="button"
                    onClick={nextEmailStep}
                    disabled={emailBusy || !canAdvanceEmailStep()}
                    className="rounded-2xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={confirmEmail}
                    disabled={emailBusy || !safeOnEmailAssistant}
                    className="rounded-2xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {emailBusy ? "Sending..." : "Send Email"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
  return fallback;
}

function isTileConnected(tile) {
  if (!tile || typeof tile !== "object") return false;

  if (tile.connected === true) return true;
  if (tile.isConnected === true) return true;

  const status = String(tile.status || "").trim().toLowerCase();
  if (["connected", "online", "active"].includes(status)) return true;
  if (["disconnected", "offline", "inactive"].includes(status)) return false;

  return normalizeBool(tile.connected, false) || normalizeBool(tile.isConnected, false);
}

function normalizeIsoDate(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

function buildEmailAttachmentName(draft) {
  const format = String(draft?.format || "pdf").toLowerCase() === "xlsx" ? "xlsx" : "pdf";
  if (String(draft?.scope || "current").toLowerCase() === "range") {
    const fromDate = normalizeIsoDate(draft?.fromDate || "") || "from-date";
    const toDate = normalizeIsoDate(draft?.toDate || "") || "to-date";
    return `report_${fromDate}_to_${toDate}.${format}`;
  }

  return `report_current_section_current_to_section.${format}`;
}

export default function ChatScreen({
  isConnected,
  userName,
  activeSession,

  normalizeSystemId,

  tiles = [],
  onAddNewSystem,
  onReconnectSystem,

  messagesElRef,
  onMessagesScrollInternal,
  activeConv,
  msgLoadingMore,
  editingIndex,
  editingText,
  setEditingText,
  startEditMessage,
  cancelEdit,
  applyEditLocal,
  onSend,
  pendingAction,
  onCopyAssistant,
  onDownloadAssistant,
  onEmailAssistant,
  onToast,

  loading,
  bottomRef,
  showScrollDown,
  statusText,
  inlineForm,
}) {
  async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
      } catch {
        return false;
      }
    }
  }

  const [copiedIndex, setCopiedIndex] = useState(null);
  const [regeneratingIndex, setRegeneratingIndex] = useState(null);
  const [downloadMenuIndex, setDownloadMenuIndex] = useState(null);
  const [downloadMenuStyle, setDownloadMenuStyle] = useState(null);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadStatus, setDownloadStatus] = useState("");
  const [downloadTarget, setDownloadTarget] = useState(null);
  const [downloadDraft, setDownloadDraft] = useState({
    fromDate: "",
    toDate: "",
    format: "pdf",
  });
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const [emailTarget, setEmailTarget] = useState(null);
  const [emailStep, setEmailStep] = useState(1);
  const [emailDraft, setEmailDraft] = useState({
    recipientType: "me",
    recipientEmail: "",
    scope: "current",
    fromDate: "",
    toDate: "",
    format: "pdf",
    customMessageEnabled: false,
    customMessage: "",
  });
  const downloadButtonRefs = useRef(new Map());

  const safeOnSend = typeof onSend === "function" ? onSend : null;
  const safeOnCopyAssistant = typeof onCopyAssistant === "function" ? onCopyAssistant : null;
  const safeOnDownloadAssistant = typeof onDownloadAssistant === "function" ? onDownloadAssistant : null;
  const safeOnEmailAssistant = typeof onEmailAssistant === "function" ? onEmailAssistant : null;
  const safeOnToast = typeof onToast === "function" ? onToast : null;
  const safeStartEditMessage = typeof startEditMessage === "function" ? startEditMessage : null;
  const safeCancelEdit = typeof cancelEdit === "function" ? cancelEdit : null;
  const safeApplyEditLocal = typeof applyEditLocal === "function" ? applyEditLocal : null;
  const safeSetEditingText = typeof setEditingText === "function" ? setEditingText : null;
  const emailIsRange = emailDraft.scope === "range";
  const emailAttachmentReady = emailDraft.format && (!emailIsRange || (String(emailDraft.fromDate || "").trim() && String(emailDraft.toDate || "").trim()));
  const emailAttachmentName = buildEmailAttachmentName(emailDraft);
  const emailStatusIsWorking = /generating report|generating attachment|preparing attachment|sending email/i.test(String(emailStatus || ""));
  const emailWizardSteps = emailIsRange
    ? ["Recipient", "Scope", "Date Range", "Format", "Message", "Confirm"]
    : ["Recipient", "Scope", "Format", "Message", "Confirm"];
  const emailMaxStep = emailWizardSteps.length;
  const downloadRangeReady = Boolean(String(downloadDraft.fromDate || "").trim()) && Boolean(String(downloadDraft.toDate || "").trim()) && Boolean(downloadDraft.format);
  const downloadFilename = buildExportFilename({
    baseName: "report",
    fromDate: downloadDraft.fromDate,
    toDate: downloadDraft.toDate,
    format: downloadDraft.format,
  });

  useEffect(() => {
    if (downloadMenuIndex === null) {
      setDownloadMenuStyle(null);
      return;
    }

    const updateMenuPosition = () => {
      const trigger = downloadButtonRefs.current.get(downloadMenuIndex);
      if (!trigger) {
        setDownloadMenuStyle(null);
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const menuWidth = 256;
      const menuHeight = 118;
      const gap = 10;
      const padding = 12;

      let left = rect.right - menuWidth;
      if (left < padding) left = padding;
      if (left + menuWidth > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - padding - menuWidth);
      }

      let top = rect.top - menuHeight - gap;
      if (top < padding) {
        top = rect.bottom + gap;
      }

      const maxTop = window.innerHeight - padding - menuHeight;
      if (top > maxTop) top = Math.max(padding, maxTop);

      setDownloadMenuStyle({
        position: "fixed",
        top: `${top}px`,
        left: `${left}px`,
        width: `${menuWidth}px`,
        zIndex: 9999,
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [downloadMenuIndex]);

  useEffect(() => {
    if (downloadMenuIndex === null) return;

    const handlePointerDown = (event) => {
      const trigger = downloadButtonRefs.current.get(downloadMenuIndex);
      const clickedTrigger = Boolean(trigger && trigger.contains(event.target));
      const clickedMenu = Boolean(event.target?.closest?.('[data-download-menu="true"]'));

      if (!clickedTrigger && !clickedMenu) {
        setDownloadMenuIndex(null);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [downloadMenuIndex]);

  const tileList = Array.isArray(tiles) ? tiles : [];

  const connectionMeta = useMemo(() => {
    const totalSystems = tileList.length;
    const connectedSystems = tileList.filter(isTileConnected);
    const connectedCount = connectedSystems.length;

    if (totalSystems === 0) {
      return {
        state: "no_systems",
        message: "No SAP system has been added yet. Connect a system from the header to continue.",
      };
    }

    if (connectedCount === 0) {
      return {
        state: "all_disconnected",
        message: "All SAP systems are disconnected. Connect a system from the header to continue.",
      };
    }

    return {
      state: "available_but_not_connected",
      message: "An SAP system is available, but this chat session is not connected yet. Connect a system from the header to continue.",
    };
  }, [tileList]);

  const handleCopyText = async (text, idx) => {
    if (!text) return;

    try {
      const ok = await copyTextToClipboard(text);
      if (!ok) throw new Error("Copy failed");
      toast.success("Copied!");
      setCopiedIndex(idx);

      setTimeout(() => {
        setCopiedIndex(null);
      }, 1500);
    } catch {
      toast.error("Copy failed.");
    }
  };

  const handleRegenerateMessage = (idx) => {
    if (!isConnected) return;
    if (!safeOnCopyAssistant) return;

    setRegeneratingIndex(idx);
    safeOnCopyAssistant(idx);

    setTimeout(() => {
      setRegeneratingIndex(null);
    }, 1500);
  };

  const handleDownloadChoice = (group, mode) => {
    setDownloadMenuIndex(null);
    if (!safeOnDownloadAssistant) {
      safeOnToast?.({
        type: "error",
        title: "Download unavailable",
        message: "Download is not available right now.",
      });
      return;
    }

    if (mode === "range") {
      const message = group?.messages?.[0] || group;
      const extractedFilters = message?.extracted?.filters || {};

      setDownloadTarget({
        group,
        message,
        filters: extractedFilters,
      });
      setDownloadDraft({
        fromDate: normalizeIsoDate(extractedFilters?.fromDate || ""),
        toDate: normalizeIsoDate(extractedFilters?.toDate || ""),
        format: "pdf",
      });
      setDownloadError("");
      setDownloadStatus("");
      setDownloadDialogOpen(true);
      return;
    }

    const message = group?.messages?.[0] || group;
    const extractedFilters = message?.extracted?.filters || {};
    const fromDate = normalizeIsoDate(extractedFilters?.fromDate || "");
    const toDate = normalizeIsoDate(extractedFilters?.toDate || "");

    safeOnToast?.({
      type: "info",
      title: "Preparing download",
      message: mode === "current"
        ? "Building current section PDF..."
        : "Building PDF for the selected date range...",
      duration: 1200,
    });

    safeOnDownloadAssistant({ group, mode, fromDate, toDate });
  };

  const closeDownloadDialog = () => {
    if (downloadBusy) return;
    setDownloadDialogOpen(false);
    setDownloadError("");
    setDownloadStatus("");
    setDownloadTarget(null);
  };

  const confirmDownloadRange = async () => {
    if (!safeOnDownloadAssistant || !downloadTarget) return;

    const fromDate = String(downloadDraft.fromDate || "").trim();
    const toDate = String(downloadDraft.toDate || "").trim();
    const format = String(downloadDraft.format || "pdf").trim().toLowerCase() === "xlsx" ? "xlsx" : "pdf";

    if (!fromDate || !toDate) {
      setDownloadError("Both From Date and To Date are required.");
      return;
    }

    if (fromDate > toDate) {
      setDownloadError("From Date cannot be later than To Date.");
      return;
    }

    setDownloadBusy(true);
    setDownloadError("");
    setDownloadStatus("Generating file...");

    try {
      const result = await safeOnDownloadAssistant({
        group: downloadTarget.group,
        mode: "range",
        fromDate,
        toDate,
        format,
      });

      if (result?.ok === false) {
        const failureMessage = result?.message || "Download failed. Please try again.";
        setDownloadError(failureMessage);
        setDownloadStatus(failureMessage);
        return;
      }

      setDownloadStatus("Download started successfully.");
      safeOnToast?.({
        type: "success",
        title: "Download started",
        message: `Started ${format.toUpperCase()} export for ${fromDate} to ${toDate}.`,
      });

      setTimeout(() => {
        setDownloadDialogOpen(false);
        setDownloadTarget(null);
        setDownloadStatus("");
      }, 1200);
    } catch (error) {
      const failureMessage = error?.message || "Download failed. Please try again.";
      setDownloadError(failureMessage);
      setDownloadStatus(failureMessage);
    } finally {
      setDownloadBusy(false);
    }
  };

  const handleEmailChoice = (group) => {
    setDownloadMenuIndex(null);

    const message = group?.messages?.[0] || group;
    const extractedFilters = message?.extracted?.filters || {};

    setEmailTarget({ group, message, filters: extractedFilters });
    setEmailDraft({
      recipientType: "me",
      recipientEmail: "",
      scope: "current",
      fromDate: normalizeIsoDate(extractedFilters?.fromDate || ""),
      toDate: normalizeIsoDate(extractedFilters?.toDate || ""),
      format: "pdf",
      customMessageEnabled: false,
      customMessage: "",
    });
    setEmailStep(1);
    setEmailError(safeOnEmailAssistant ? "" : "Email is not available right now.");
    setEmailStatus("");
    setEmailDialogOpen(true);

    if (!safeOnEmailAssistant) {
      safeOnToast?.({
        type: "error",
        title: "Email unavailable",
        message: "Email is not available right now.",
      });
    }
  };

  const closeEmailDialog = () => {
    if (emailBusy) return;
    setEmailDialogOpen(false);
    setEmailError("");
    setEmailStatus("");
    setEmailTarget(null);
  };

  const canAdvanceEmailStep = () => {
    if (emailStep === 1) {
      if (emailDraft.recipientType === "other") {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(emailDraft.recipientEmail || "").trim());
      }
      return true;
    }

    if (emailStep === 2) return Boolean(emailDraft.scope);

    if (emailIsRange) {
      if (emailStep === 3) {
        return Boolean(String(emailDraft.fromDate || "").trim()) && Boolean(String(emailDraft.toDate || "").trim());
      }

      if (emailStep === 4) return Boolean(emailDraft.format);
      if (emailStep === 5) return true;
      if (emailStep === 6) return true;
      return Boolean(emailDraft.format);
    }

    if (emailStep === 3) return Boolean(emailDraft.format);
    if (emailStep === 4) return true;
    if (emailStep === 5) return true;
    return Boolean(emailDraft.format);
  };

  const nextEmailStep = () => {
    setEmailError("");
    setEmailStep((current) => Math.min(emailMaxStep, current + 1));
  };

  const prevEmailStep = () => {
    setEmailError("");
    setEmailStep((current) => Math.max(1, current - 1));
  };

  const confirmEmail = async () => {
    if (!safeOnEmailAssistant || !emailTarget) return;

    setEmailBusy(true);
    setEmailError("");
    setEmailStatus("Generating report...");

    try {
      const result = await safeOnEmailAssistant({
        group: emailTarget.group,
        recipientType: emailDraft.recipientType,
        recipientEmail: emailDraft.recipientEmail,
        scope: emailDraft.scope,
        fromDate: emailDraft.fromDate,
        toDate: emailDraft.toDate,
        format: emailDraft.format,
        customMessageEnabled: emailDraft.customMessageEnabled,
        customMessage: emailDraft.customMessage,
        onStatusChange: setEmailStatus,
      });

      if (result?.ok === false) {
        const failureMessage = result?.message || "Failed to send email. Please try again.";
        setEmailError(failureMessage);
        setEmailStatus(failureMessage);
        return;
      }

      const recipientLabel = emailDraft.recipientType === "me"
        ? "your email"
        : String(emailDraft.recipientEmail || "").trim();
      const successMessage = `Email sent successfully to ${recipientLabel}`;
      setEmailStatus(successMessage);
      safeOnToast?.({
        type: "success",
        title: "Email sent",
        message: successMessage,
      });

      setTimeout(() => {
        setEmailDialogOpen(false);
        setEmailTarget(null);
        setEmailStatus("");
      }, 1200);
    } catch (error) {
      console.error("Email API Error:", error);
      const failureMessage = error?.message || "Failed to send email. Please try again.";
      setEmailError(failureMessage);
      setEmailStatus(failureMessage);
    } finally {
      setEmailBusy(false);
    }
  };

  const handleSuggestion = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (value?.action?.type === "add_system") {
        onAddNewSystem?.();
        return;
      }

      if (value?.action?.type === "reconnect_system") {
        const sid = String(value?.action?.systemId || "").trim().toUpperCase();
        if (sid) {
          onReconnectSystem?.(sid, value);
          return;
        }

        onAddNewSystem?.();
        return;
      }

      if (!safeOnSend || !isConnected) return;
      safeOnSend(value);
      return;
    }

    if (!safeOnSend || !isConnected) return;

    const text = String(value || "").trim();
    if (!text) return;

    if (text === "Add System") {
      onAddNewSystem?.();
      return;
    }

    const upper = text.toUpperCase();

    if (pendingAction && ["ROW", "INDIA", "PRD", "QAS", "DEV", "QA", "UAT", "PROD"].includes(upper)) {
      safeOnSend({
        overrideText: upper,
        displayText: upper,
        businessScope: upper,
        pendingContext: pendingAction,
      });
      return;
    }

    // Important:
    // Do NOT convert suggestion text like "Use S4D" into forcedSystemId.
    // That can keep stale disconnected systems alive after reconnect.
    safeOnSend({
      overrideText: text,
      displayText: text,
    });
  };

  const groupedMessages = [];
  const messages = Array.isArray(activeConv?.messages) ? activeConv.messages : [];

  const isGreetingMessage = (message) => {
    const text = String(message?.text || message?.summary || "").trim().toLowerCase();
    return text === "hi, welcome to implevista ai. how may i assist you?";
  };

  const isLandscapeSelectionPrompt = (message) => {
    const text = String(message?.text || message?.summary || "").trim().toLowerCase();
    return (
      text === "which landscape would you like to view the change requests from?" ||
      text === "which landscape would you like to analyze for cr status distribution?"
    );
  };

  const shouldShowAssistantActions = (assistantGroup) => {
    const groupMessages = Array.isArray(assistantGroup?.messages) ? assistantGroup.messages : [];
    if (groupMessages.length === 0) return false;

    if (groupMessages.some(isGreetingMessage)) {
      return false;
    }

    if (groupMessages.some(isLandscapeSelectionPrompt)) {
      return false;
    }

    const hasRenderableContent = groupMessages.some((message) => {
      const text = String(message?.text || "").trim();
      const summary = String(message?.summary || "").trim();
      const hasData = Boolean(message?.data && typeof message.data === "object");
      const hasChart = Boolean(message?.chart);
      const hasAction = Boolean(message?.action);
      return Boolean(text || summary || hasData || hasChart || hasAction);
    });

    const isQuickReplyPromptOnly = groupMessages.every((message) => {
      const hasData = Boolean(message?.data && typeof message.data === "object");
      const hasChart = Boolean(message?.chart);
      const hasAction = Boolean(message?.action);
      const hasSummary = Boolean(String(message?.summary || "").trim());
      const hasSuggestions = Array.isArray(message?.suggestions) && message.suggestions.length > 0;
      return hasSuggestions && !hasData && !hasChart && !hasAction && !hasSummary;
    });

    return hasRenderableContent && !isQuickReplyPromptOnly;
  };

  const isRenderableAssistantMessage = (message) => {
    if (!message || message.role !== "assistant") return false;

    const text = String(message?.text || "").trim();
    const summary = String(message?.summary || "").trim();
    const hasData = Boolean(message?.data && typeof message.data === "object");
    const hasChart = Boolean(message?.chart);
    const hasSuggestions = Array.isArray(message?.suggestions) && message.suggestions.length > 0;
    const hasAction = Boolean(message?.action);

    return Boolean(text || summary || hasData || hasChart || hasSuggestions || hasAction);
  };

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];

    if (current?.role === "assistant") {
      if (!isRenderableAssistantMessage(current)) {
        continue;
      }

      const grouped = [current];

      while (i + 1 < messages.length && messages[i + 1]?.role === "assistant") {
        if (isRenderableAssistantMessage(messages[i + 1])) {
          grouped.push(messages[i + 1]);
        }
        i++;
      }

      if (grouped.length === 0) {
        continue;
      }

      groupedMessages.push({
        role: "assistant-group",
        messages: grouped,
      });
    } else {
      groupedMessages.push(current);
    }
  }

  return (
    <>
      {isConnected ? (
        <section
          ref={messagesElRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 pt-4 pb-36 overscroll-contain"
          onScroll={onMessagesScrollInternal}
        >
          <div className="mx-auto max-w-4xl space-y-4">
            {msgLoadingMore && activeConv?.messages?.length > 0 && (
              <div className="px-4 py-2 text-xs text-gray-400 italic">
                Loading moreΓÇª
              </div>
            )}

            {groupedMessages.map((m, idx) => {
              const isUser = m?.role === "user";
              const isAssistantGroup = m?.role === "assistant-group";
              const isEditing = editingIndex === idx;
              const showAssistantActions = isAssistantGroup ? shouldShowAssistantActions(m) : false;
              const groupKey = String(
                isAssistantGroup
                  ? m?.messages?.map((msg, subIdx) => msg?.id || msg?.createdAt || `${msg?.text || "msg"}_${subIdx}`).join("|")
                  : m?.id || m?.createdAt || `${m?.text || "msg"}_${idx}`
              );

              return (
                <div
                  key={groupKey}
                  id={isUser ? `chat-msg-${m?.id || groupKey}` : undefined}
                  data-role={isUser ? "user" : undefined}
                  className="group"
                >
                  {isUser && !isEditing && (
                    <div className="flex flex-col items-end">
                      <MessageBubble
                        role={m.role}
                          text={m.text || m.summary || ""}
                        summary={m.summary}
                        systemId={activeSession?.systemId || activeConv?.systemId}
                        sapUser={activeSession?.sapUser || activeConv?.sapUser}
                      />

                      <div className="mt-1 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity pr-2">
                        <button
                          type="button"
                          onClick={() => handleCopyText(m.text, idx)}
                          className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                          title="Copy"
                        >
                          {copiedIndex === idx ? (
                            <FiCheck size={15} className="text-green-600" />
                          ) : (
                            <FiCopy size={15} />
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => safeStartEditMessage?.(idx)}
                          className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                          title="Edit"
                        >
                          <FiEdit2 size={15} />
                        </button>
                      </div>
                    </div>
                  )}

                  {isUser && isEditing && (
                    <div className="rounded-2xl bg-gray-100 p-3">
                      <div className="mb-2 text-xs text-blue-600">
                        Editing message to save & resend, or else click cancel.
                      </div>

                      <textarea
                        value={editingText}
                        onChange={(e) => safeSetEditingText?.(e.target.value)}
                        rows={3}
                        className="w-full resize-none rounded-xl border border-zinc-800 bg-white px-3 py-2 text-sm text-black outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-400/20"
                      />

                      <div className="mt-2 flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => safeCancelEdit?.()}
                          className="rounded-xl border border-zinc-800 px-3 py-2 text-sm text-white bg-black"
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            if (!safeApplyEditLocal || !safeOnSend) return;

                            const newText = safeApplyEditLocal({
                              removeFollowingAssistant: true,
                            });

                            if (newText) {
                              safeOnSend({
                                overrideText: newText,
                                displayText: newText,
                                fromEdit: true,
                              });
                            }
                          }}
                          className="rounded-xl px-3 py-2 text-sm font-semibold text-white bg-green-600"
                          disabled={!isConnected}
                        >
                          Save & resend
                        </button>
                      </div>
                    </div>
                  )}

                  {isAssistantGroup && (
                    <div className="relative" data-assistant-group="true">
                      <div className="space-y-3">
                        {m.messages.map((msg, subIdx) => (
                          <div key={msg?.id || msg?.createdAt || `${groupKey}_${subIdx}`}>
                            <MessageBubble
                              role={msg?.role}
                              text={msg?.text}
                              summary={msg?.summary}
                              data={msg?.data}
                              chart={msg?.chart}
                              suggestions={msg?.suggestions}
                              action={msg?.action}
                              showAvatar={subIdx === 0}
                              systemId={activeSession?.systemId || activeConv?.systemId}
                              sapUser={activeSession?.sapUser || activeConv?.sapUser}
                              onSuggestionClick={(value) => {
                                handleSuggestion(value);
                              }}
                            />
                          </div>
                        ))}
                      </div>

                      {showAssistantActions && (
                        <div className="relative mt-2 flex items-center gap-2 ml-12">
                          <button
                            type="button"
                            onClick={() => {
                              const fullText = m.messages.map((msg) => msg?.text || "").join("\n\n");
                              handleCopyText(fullText, idx);
                            }}
                            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                            title="Copy"
                          >
                            {copiedIndex === idx ? (
                              <FiCheck size={15} className="text-green-600" />
                            ) : (
                              <FiCopy size={15} />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRegenerateMessage(idx)}
                            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                            title="Regenerate"
                            disabled={regeneratingIndex === idx || !isConnected}
                          >
                            <FiRefreshCw
                              size={15}
                              className={regeneratingIndex === idx ? "animate-spin" : ""}
                            />
                          </button>

                          <button
                            type="button"
                            onClick={() => handleEmailChoice(m)}
                            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                            title="Email"
                          >
                            <FiMail size={15} />
                          </button>

                          <div className="relative">
                            <button
                              type="button"
                              onClick={() =>
                                setDownloadMenuIndex(downloadMenuIndex === idx ? null : idx)
                              }

                              ref={(node) => {
                                if (node) {
                                  downloadButtonRefs.current.set(idx, node);
                                } else {
                                  downloadButtonRefs.current.delete(idx);
                                }
                              }}
                              className="relative flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-200 text-gray-500 hover:text-black transition"
                              title="Download"
                            >
                              <FiDownload size={15} />
                            </button>
                          </div>

                          {downloadMenuIndex === idx &&
                            downloadMenuStyle &&
                            typeof document !== "undefined" &&
                            createPortal(
                              <div
                                data-download-menu="true"
                                className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_20px_50px_rgba(0,0,0,0.15)]"
                                style={downloadMenuStyle}
                              >
                                <div className="px-4 py-3 border-b border-gray-100">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                    Download Options
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => handleDownloadChoice(m, "current")}
                                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                  Download current section
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleDownloadChoice(m, "range")}
                                  className="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                  Download by Date Range
                                </button>
                              </div>,
                              document.body
                            )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {inlineForm && <div className="mx-auto max-w-4xl">{inlineForm}</div>}

            {loading && (
              <div className="flex items-center gap-3 px-2 py-2">
                <div className="h-10 w-10 rounded-full overflow-hidden bg-white shrink-0 border border-gray-200 shadow-sm">
                  <video
                    src="/bot.mp4"
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="h-full w-full object-cover"
                  />
                </div>

                <div className="text-sm text-gray-500 italic animate-pulse">
                  {statusText || "Preparing results..."}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </section>
      ) : (
        <section className="flex-1 flex items-center justify-center px-4 py-4 overflow-hidden">
          <div className="mx-auto max-w-2xl w-full">
            <div className="bg-gradient-to-br from-green-50 to-indigo-50 rounded-2xl border border-green-600 p-6 text-center shadow-lg">
              <h2 className="text-xl sm:text-2xl font-bold text-green-800 mb-1">
                Welcome, {userName}!
              </h2>

              <p className="text-xs sm:text-sm text-black-600 mb-5">
                {connectionMeta.message}
              </p>
            </div>
          </div>
        </section>
      )}

      {showScrollDown && isConnected && (
        <button
          type="button"
          onClick={() =>
            bottomRef?.current?.scrollIntoView({
              behavior: "smooth",
            })
          }
          className="fixed bottom-20 right-6 z-20 w-10 h-10 flex items-center justify-center rounded-full bg-white border shadow-lg hover:bg-gray-50 transition"
        >
          <FiChevronDown size={18} />
        </button>
      )}

      {emailDialogOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10001] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeEmailDialog} />

          <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-white/20 bg-white shadow-[0_25px_90px_rgba(15,23,42,0.38)]">
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-900 to-cyan-700 px-6 py-4 text-white">
              <p className="text-xs uppercase tracking-[0.24em] text-sky-200">Email Delivery</p>
              <h3 className="mt-1 text-xl font-semibold">Send report by email</h3>
              <p className="mt-2 text-sm text-sky-100/90">
                Choose the current section or a particular date range before selecting a format.
              </p>
            </div>

            <div className="px-6 py-5">
              <div className={`mb-5 grid gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 ${emailWizardSteps.length === 6 ? "grid-cols-6" : "grid-cols-5"}`}>
                {emailWizardSteps.map((label, index) => {
                  const active = emailStep === index + 1;
                  const completed = emailStep > index + 1;
                  return (
                    <div
                      key={label}
                      className={`rounded-2xl px-3 py-2 text-center transition ${
                        active
                          ? "bg-sky-600 text-white"
                          : completed
                            ? "bg-sky-100 text-sky-900"
                            : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-5">
                {emailStep === 1 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Who would you like to send this report to?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "me", label: "Send to Me" },
                        { value: "other", label: "Send to Another Person" },
                      ].map((option) => {
                        const active = emailDraft.recipientType === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, recipientType: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>

                    {emailDraft.recipientType === "other" && (
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-700">Recipient email address</span>
                        <input
                          type="email"
                          value={emailDraft.recipientEmail}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, recipientEmail: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                          placeholder="john.doe@company.com"
                        />
                      </label>
                    )}
                  </div>
                )}

                {emailStep === 2 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">What do you want to send?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "current", label: "Current section" },
                        { value: "range", label: "Particular date range" },
                      ].map((option) => {
                        const active = emailDraft.scope === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, scope: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {emailIsRange && emailStep === 3 && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Select date range</p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">From Date</span>
                        <input
                          type="date"
                          value={emailDraft.fromDate}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, fromDate: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                        />
                      </label>

                      <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">To Date</span>
                        <input
                          type="date"
                          value={emailDraft.toDate}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, toDate: e.target.value }))}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                        />
                      </label>
                    </div>
                    <p className="text-xs text-slate-500">These dates are required only when sending a particular date range.</p>
                  </div>
                )}

                {((!emailIsRange && emailStep === 3) || (emailIsRange && emailStep === 4)) && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Select file format</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: "pdf", label: "PDF" },
                        { value: "xlsx", label: "Excel (.xlsx)" },
                      ].map((option) => {
                        const active = emailDraft.format === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, format: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {((!emailIsRange && emailStep === 4) || (emailIsRange && emailStep === 5)) && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-700">Would you like to add a custom email message?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        { value: true, label: "Yes" },
                        { value: false, label: "No" },
                      ].map((option) => {
                        const active = emailDraft.customMessageEnabled === option.value;
                        return (
                          <button
                            key={String(option.value)}
                            type="button"
                            onClick={() => setEmailDraft((curr) => ({ ...curr, customMessageEnabled: option.value }))}
                            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                              active
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>

                    {emailDraft.customMessageEnabled && (
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-700">Message</span>
                        <textarea
                          rows={5}
                          value={emailDraft.customMessage}
                          onChange={(e) => setEmailDraft((curr) => ({ ...curr, customMessage: e.target.value }))}
                          className="w-full resize-none rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                          placeholder="Hi, please find the report attached."
                        />
                      </label>
                    )}
                  </div>
                )}

                {((!emailIsRange && emailStep === 5) || (emailIsRange && emailStep === 6)) && (
                  <div className="space-y-3 rounded-3xl bg-slate-50 p-4 text-sm text-slate-700">
                    <div><span className="font-medium">Recipient:</span> {emailDraft.recipientType === "me" ? "Send to Me" : emailDraft.recipientEmail || "-"}</div>
                    <div><span className="font-medium">Scope:</span> {emailDraft.scope === "current" ? "Current section" : "Particular date range"}</div>
                    {emailDraft.scope === "range" ? (
                      <div><span className="font-medium">Date range:</span> {emailDraft.fromDate || "-"} to {emailDraft.toDate || "-"}</div>
                    ) : null}
                    <div><span className="font-medium">Format:</span> {emailDraft.format.toUpperCase()}</div>
                    <div><span className="font-medium">Attachment:</span> {emailAttachmentName}</div>
                    <div><span className="font-medium">Attachment status:</span> {emailAttachmentReady ? "Ready to attach automatically" : "Not ready"}</div>
                    <div><span className="font-medium">Custom message:</span> {emailDraft.customMessageEnabled ? "Yes" : "No"}</div>
                  </div>
                )}

                {emailError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {emailError}
                  </div>
                ) : null}

                {emailStatus ? (
                  <div className={`rounded-2xl px-4 py-3 text-sm ${emailStatusIsWorking ? "border border-sky-200 bg-sky-50 text-sky-700" : emailStatus.startsWith("Email sent successfully") ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "border border-slate-200 bg-slate-50 text-slate-700"}`}>
                    {emailStatus}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
              <button
                type="button"
                onClick={closeEmailDialog}
                disabled={emailBusy}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={prevEmailStep}
                  disabled={emailBusy || emailStep === 1}
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Back
                </button>

                {emailStep < emailMaxStep ? (
                  <button
                    type="button"
                    onClick={nextEmailStep}
                    disabled={emailBusy || !canAdvanceEmailStep()}
                    className="rounded-2xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={confirmEmail}
                    disabled={emailBusy || !safeOnEmailAssistant || !emailAttachmentReady}
                    className="rounded-2xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {emailBusy ? "Sending..." : "Send Email"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {downloadDialogOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10002] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeDownloadDialog} />

          <div className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-white/20 bg-white shadow-[0_25px_90px_rgba(15,23,42,0.38)]">
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-900 to-cyan-700 px-6 py-4 text-white">
              <p className="text-xs uppercase tracking-[0.24em] text-sky-200">Export Data</p>
              <h3 className="mt-1 text-xl font-semibold">Download by Date Range</h3>
              <p className="mt-2 text-sm text-sky-100/90">
                Select a valid date range and file format before downloading.
              </p>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-slate-700">From Date</span>
                  <input
                    type="date"
                    value={downloadDraft.fromDate}
                    onChange={(e) => {
                      setDownloadError("");
                      setDownloadDraft((curr) => ({ ...curr, fromDate: e.target.value }));
                    }}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-slate-700">To Date</span>
                  <input
                    type="date"
                    value={downloadDraft.toDate}
                    onChange={(e) => {
                      setDownloadError("");
                      setDownloadDraft((curr) => ({ ...curr, toDate: e.target.value }));
                    }}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
                  />
                </label>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-700">Select Download Format</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { value: "pdf", label: "PDF" },
                    { value: "xlsx", label: "Excel (.xlsx)" },
                  ].map((option) => {
                    const active = downloadDraft.format === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setDownloadError("");
                          setDownloadDraft((curr) => ({ ...curr, format: option.value }));
                        }}
                        className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition ${
                          active
                            ? "border-sky-500 bg-sky-50 text-sky-900"
                            : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-3xl bg-slate-50 p-4 text-sm text-slate-700 space-y-2">
                <div><span className="font-medium">Filename:</span> {downloadFilename}</div>
                <div><span className="font-medium">Status:</span> {downloadRangeReady ? "Ready to download" : "Select both dates and a format"}</div>
              </div>

              {downloadError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {downloadError}
                </div>
              ) : null}

              {downloadStatus ? (
                <div className={`rounded-2xl px-4 py-3 text-sm ${downloadStatus === "Generating file..." ? "border border-sky-200 bg-sky-50 text-sky-700" : downloadStatus === "Download started successfully." ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "border border-slate-200 bg-slate-50 text-slate-700"}`}>
                  {downloadStatus}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
              <button
                type="button"
                onClick={closeDownloadDialog}
                disabled={downloadBusy}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={confirmDownloadRange}
                disabled={downloadBusy || !safeOnDownloadAssistant || !downloadRangeReady}
                className="rounded-2xl bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {downloadBusy ? "Generating..." : "Download"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
