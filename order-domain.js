export const ORDER_TYPE = Object.freeze({ NORMAL: "normal", SPOT: "spot" });
export const HANDOFF = Object.freeze({ NOW: "now", LATER: "later", HOTEL: "hotel", SHIP: "ship" });
export const PAYMENT = Object.freeze({ CREDIT: "credit", CASH: "cash" });
export const SHIPPING_CODE = "送料";
export const SHIPPING_PRICE = 500;
export function isShipping(item) { return item?.code === SHIPPING_CODE; }
export function withShipping(items = []) {
  return [...items.filter((item) => !isShipping(item)), { code: SHIPPING_CODE, name: "送料（一律）", price: SHIPPING_PRICE, qty: 1 }];
}

export function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

export function syntaxKey(value) {
  return normalizeText(value)
    .replace(/^№\s*/u, "")
    .replace(/^no[.\s]*/u, "")
    .replace(/[‐‑‒–—―ー−]/gu, "-")
    .replace(/\s+/gu, "");
}

export function compactKey(value) {
  return syntaxKey(value).replace(/[^a-z0-9]/gu, "");
}

export function phoneHasUnexpectedCharacters(value) {
  return Boolean(String(value ?? "").trim() && !/^[0-9+()\-\s]+$/.test(String(value)));
}

export function orderTypeLabel(type) {
  return type === ORDER_TYPE.SPOT ? "現売り対応" : "国内通常注文";
}

export function handoffLabel(handoff) {
  return ({
    [HANDOFF.NOW]: "在庫あり・その場渡し",
    [HANDOFF.LATER]: "翌日・翌々日に受取",
    [HANDOFF.HOTEL]: "ホテルへ配送",
    [HANDOFF.SHIP]: "指定住所へ配送",
  })[handoff] || "";
}

export function paymentLabel(method) {
  return method === PAYMENT.CASH ? "現金" : "クレジット";
}

export function totalQuantity(items = []) {
  return items.reduce((sum, item) => sum + (isShipping(item) ? 0 : Number(item.qty || 0)), 0);
}

export function totalPrice(items = []) {
  return items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
}

export function validateDraft(draft) {
  if (!draft.items?.some((item) => !isShipping(item))) return "商品を1点以上追加してください。";
  if (!draft.type) return "注文方法を選択してください。";
  if (draft.type === ORDER_TYPE.SPOT && !draft.handoff) return "商品の渡し方を選択してください。";
  if (!String(draft.store || "").trim()) return "店舗名を入力してください。";
  if (!String(draft.phone || "").trim()) return "電話番号を入力してください。";
  if (draft.type === ORDER_TYPE.NORMAL) {
    if (!String(draft.account || "").trim()) return "卸屋・帳合先を入力してください。";
    if (!String(draft.staff || "").trim()) return "受注担当者を確認してください。";
    return "";
  }
  if (!String(draft.customer || "").trim()) return "お客様名を入力してください。";
  if (!draft.paymentMethod) return "会計方法を選択してください。";
  if (draft.handoff === HANDOFF.LATER && !draft.pickupDate) return "受取予定日を入力してください。";
  if (draft.handoff === HANDOFF.SHIP && !String(draft.shipAddress || "").trim()) return "配送先住所を入力してください。";
  return "";
}
