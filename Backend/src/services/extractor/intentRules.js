export const INTENT_RULES = [
  {
    name: "latest_po_list",
    
    // quick phrase matches
    terms: [
      "show po",
      "show purchase order",
      "show purchase orders",
      "list po",
      "list purchase orders",
      "purchase order list",
      // filter content
      "latest po",
      "latest purchase order",
      "latest purchase orders",
      "recent po",
      "recent purchase orders",
      "most recent po",
      "most recent purchase orders",
      "show all latest po",
      "show latest po",
      "show latest purchase orders",
    ],

    // regex catches: "show all latest po", "get recent purchase orders", etc.
    patterns: [
      // contains: latest|recent|most recent  AND  po|purchase order(s)
      "\\b(latest|recent|most\\s+recent)\\b.*\\b(po|purchase\\s*order[s]?)\\b",
      // contains: show|list|get  AND  po|purchase order(s)
      "\\b(show|list|get)\\b.*\\b(po|purchase\\s*order[s]?)\\b",
    ],

    listMode: "latest_po",
    defaultOrderBy: [{ field: "CrtDate", dir: "desc" }],
    defaultLimit: 10,
  },
];