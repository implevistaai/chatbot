export const PO_FIELDS = [
  "PoNo",
  "PoItem",
  "MatNo",
  "SuppAcoutNo",
  "CompanyCode",
  "NetPrice",
  "Menge",
  "ItemDeliDt",
  "Wemng",
  "CurKey",
  "ExcngRate",
  "CrtDate",
  "UserCreated",
  "Plant",
  "StrLoc",
  "MatGrp",
];

export const PO_FIELD_LABELS = {
  PoNo: "Purchase Order Number",
  PoItem: "Purchase Order Item",
  MatNo: "Material Number",
  SuppAcoutNo: "Supplier",
  CompanyCode: "Company Code",
  NetPrice: "Net Price",
  Menge: "Quantity",
  ItemDeliDt: "Delivery Date",
  Wemng: "Goods Receipt Quantity",
  CurKey: "Currency Key",
  ExcngRate: "Exchange Rate",
  CrtDate: "Created Date",
  UserCreated: "Created By",
  Plant: "Plant",
  StrLoc: "Storage Location",
  MatGrp: "Material Group",
  NoForDocCond: "Doc Condition",
};

export function getPoAllowlistFallback() {
  return {
    fields: [...PO_FIELDS],
    labels: { ...PO_FIELD_LABELS },
  };
}