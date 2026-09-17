import { useEffect, useRef, useState } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";

export default function ReplyTable({ columns, rows, forceGrid = false, renderCell = null }) {
  const isFallback =
    !columns || columns.length === 0 || columns[0] === "Output";

  const safeRows = Array.isArray(rows) ? rows : [];
  const scrollAreaRef = useRef(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  function isBlankLike(value) {
    const text = String(value ?? "").trim();
    return !text || text === "-";
  }

  function getColumnValue(row, column, colIdx) {
    if (Array.isArray(row)) {
      return row[colIdx] ?? row[column] ?? "";
    }

    if (!row || typeof row !== "object") {
      return "";
    }

    const aliasMap = {
      PoNo: ["PoNo", "PO Number", "PONumber", "PO_NO"],
      PoItem: ["PoItem", "PO Item", "POItem", "PO_ITEM"],
      SuppAcoutNo: [
        "SuppAcoutNo",
        "SuppAccountNo",
        "SupplierAccountNo",
        "supplierAccountNo",
        "SupplierAccountNumber",
        "SupplierGLAccount",
        "GLAccount",
        "G/L account",
        "G/L Account",
        "GL Account",
      ],
    };

    const aliases = aliasMap[column] || [column];

    for (const key of aliases) {
      const value = row?.[key];
      if (!isBlankLike(value)) {
        return value;
      }
    }

    if (column === "PoNo" && row?.__metadata?.id) {
      const match = String(row.__metadata.id).match(/\('([^']+)'\)/);
      if (match) return match[1];
    }

    return "";
  }

  const safeColumns = Array.isArray(columns) ? columns : [];
  const visibleColumns =
    safeColumns.includes("PoNo") &&
    safeRows.length > 0 &&
    safeRows.every((row) => isBlankLike(getColumnValue(row, "PoNo", safeColumns.indexOf("PoNo"))))
      ? safeColumns.filter((column) => column !== "PoNo")
      : safeColumns;

  const labelMap = {
    "#": "Serial No",
    PoNo: "PO Number",
    PoItem: "PO Item",
    ItemDeliDt: "Delivery Date",
    ShortText: "Description",
    MatNo: "Material Number",
    Plant: "Plant",
    StrLoc: "Storage Location",
    MatGrp: "Material Group",
    Menge: "Quantity",
    NetPrice: "Net Price",
    CurKey: "Currency",
    SuppAcoutNo: "Supplier",
    UserCreated: "Created By",
    CrtDate: "Created Date",
    ExcngRate: "Exchange Rate",
    Wemng: "Goods Receipt Quantity",
    CompanyCode: "Company Code",





  };

  useEffect(() => {
    const element = scrollAreaRef.current;

    if (!element) {
      return undefined;
    }

    const updateOverflow = () => {
      const overflow = element.scrollWidth > element.clientWidth + 1;
      const nextCanScrollLeft = element.scrollLeft > 1;
      const nextCanScrollRight = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;

      setHasHorizontalOverflow(overflow);
      setCanScrollLeft(overflow && nextCanScrollLeft);
      setCanScrollRight(overflow && nextCanScrollRight);
    };

    updateOverflow();

    element.addEventListener("scroll", updateOverflow, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => {
        element.removeEventListener("scroll", updateOverflow);
        window.removeEventListener("resize", updateOverflow);
      };
    }

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);

    return () => {
      element.removeEventListener("scroll", updateOverflow);
      observer.disconnect();
    };
  }, [safeColumns.length, safeRows.length, visibleColumns.length, forceGrid]);

  const scrollByOffset = (direction) => {
    const element = scrollAreaRef.current;
    if (!element) return;

    const delta = 360;
    element.scrollBy({ left: direction * delta, behavior: "smooth" });
  };

  const showLeftArrow = hasHorizontalOverflow && isHovered && canScrollLeft;
  const showRightArrow = hasHorizontalOverflow && isHovered && canScrollRight;

  return (
    <div
      className="w-full p-1"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative w-full max-w-full">
        {hasHorizontalOverflow && (
          <>
            <button
              type="button"
              onClick={() => scrollByOffset(-1)}
              disabled={!showLeftArrow}
              aria-label="Scroll table left"
              className={`absolute left-2 top-1/2 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-sm backdrop-blur transition-all duration-200 hover:bg-white ${showLeftArrow ? "opacity-100 translate-x-0" : "pointer-events-none opacity-0 -translate-x-1"}`}
            >
              <FiChevronLeft className="text-lg" />
            </button>

            <button
              type="button"
              onClick={() => scrollByOffset(1)}
              disabled={!showRightArrow}
              aria-label="Scroll table right"
              className={`absolute right-2 top-1/2 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-sm backdrop-blur transition-all duration-200 hover:bg-white ${showRightArrow ? "opacity-100 translate-x-0" : "pointer-events-none opacity-0 translate-x-1"}`}
            >
              <FiChevronRight className="text-lg" />
            </button>
          </>
        )}

        {hasHorizontalOverflow && (
          <>
            <div
              className={`pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-white to-transparent transition-opacity duration-200 ${showLeftArrow ? "opacity-100" : "opacity-0"}`}
            />
            <div
              className={`pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-white to-transparent transition-opacity duration-200 ${showRightArrow ? "opacity-100" : "opacity-0"}`}
            />
          </>
        )}

        <div
          ref={scrollAreaRef}
          className="w-full max-w-full overflow-x-auto scrollbar-none scroll-smooth"
        >
          <table className="w-max min-w-full text-left text-[11px] sm:text-xs border-collapse">
            {!isFallback && (
              <thead className="bg-slate-900 text-white font-semibold">
                <tr>
                  {visibleColumns.map((c) => (
                    <th
                      key={c}
                      className="px-3 py-3 border border-slate-800/80 whitespace-nowrap"
                    >
                      {labelMap[c] || c}
                    </th>
                  ))}
                </tr>
              </thead>
            )}

            <tbody>
              {safeRows.map((row, idx) => (
                <tr key={idx} className="bg-white text-slate-700 border-t border-slate-200">
                  {!isFallback ? (
                    visibleColumns.map((c, colIdx) => {
                      const cellValue = getColumnValue(row, c, colIdx);
                      const rendered = typeof renderCell === "function" ? renderCell({
                        value: cellValue,
                        row,
                        column: c,
                        columnIndex: colIdx,
                        rowIndex: idx,
                      }) : null;

                      return (
                        <td
                          key={`${c}-${colIdx}`}
                          className="px-3 py-3 whitespace-nowrap border border-slate-200"
                        >
                          {rendered ?? String(cellValue ?? "")}
                        </td>
                      );
                    })
                  ) : (
                    <td className="px-3 py-2 border border-slate-200">
                      {row.Output || row.text || ""}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}