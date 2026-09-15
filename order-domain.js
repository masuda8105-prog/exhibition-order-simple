export const ORDER_TYPE = Object.freeze({ NORMAL: "normal", SPOT: "spot" });
export const HANDOFF = Object.freeze({ NOW: "now", LATER: "later", HOTEL: "hotel", SHIP: "ship" });
export const PAYMENT = Object.freeze({ CREDIT: "credit", CASH: "cash" });
export function isPickupOrder(order) { return order?.type === ORDER_TYPE.SPOT && order?.handoff === HANDOFF.LATER; }
export function needsSlackShare(order) { return order?.type === ORDER_TYPE.SPOT && [HANDOFF.LATER, HANDOFF.HOTEL, HANDOFF.SHIP].includes(order?.handoff); }
export function isOrderConfirmed(order) {
  if (!needsSlackShare(order)) return true;
  // Older shared orders remain confirmed without rewriting their stored data.
  return Boolean(order.slackShared && order.submissionState !== "pending"
    && (!isPickupOrder(order) || pickupNumber(order)));
}
export function confirmationError(order) {
  const error = validateDraft(order);
  if (error) return error;
  if (!needsSlackShare(order)) return "";
  if (!order.editingId) return "先に共有用の控えを作成してください。";
  if (isPickupOrder(order) && !pickupNumber(order)) return "先にお渡し番号を発行してください。";
  if (!order.slackShared) return "Slackに投稿してから「Slackに共有済み」をチェックしてください。";
  return "";
}
export function confirmOrder(order, now = new Date().toISOString()) {
  const error = confirmationError(order);
  if (error) throw new Error(error);
  return { ...order, submissionState: "confirmed", confirmedAt: order.confirmedAt || now };
}
export function sharedContentKey(order) {
  // Operational updates (payment received / handover) do not require reposting.
  const fields = ["type", "handoff", "store", "phone", "customer", "customerRegion", "account", "staff", "paymentMethod", "pickupDate", "hotelName", "guestName", "roomNo", "checkoutDate", "shipAddress", "notes"];
  return JSON.stringify([fields.map(key => order?.[key] || ""), (order?.items || []).map(item => [item.code, item.name, Number(item.price), Number(item.qty)])]);
}
export function prepareOrder(order, savedOrder) {
  if (!needsSlackShare(order)) return { ...order, submissionState: "confirmed" };
  const unchanged = savedOrder && sharedContentKey(order) === sharedContentKey(savedOrder);
  return {
    ...order,
    submissionState: unchanged && isOrderConfirmed(savedOrder) ? "confirmed" : "pending",
    confirmedAt: unchanged ? savedOrder.confirmedAt || "" : "",
    slackShared: Boolean(unchanged && savedOrder.slackShared),
    slackSharedAt: unchanged ? savedOrder.slackSharedAt || "" : "",
  };
}
export function workflowStatus(order) {
  if (!needsSlackShare(order)) return "done";
  if (!isOrderConfirmed(order)) return "active";
  if (isPickupOrder(order) && order.delivered) return "done";
  return order.slackShared ? (isPickupOrder(order) ? "waiting" : "done") : "active";
}
export function setSlackShared(order, shared, now = new Date().toISOString()) {
  if (!needsSlackShare(order)) return { ...order };
  const next = { ...order, slackShared: Boolean(shared), slackSharedAt: shared ? (order.slackSharedAt || now) : "" };
  if (!shared || !isOrderConfirmed(order)) { next.submissionState = "pending"; next.confirmedAt = ""; }
  return { ...next, workflowStatus: workflowStatus(next) };
}
export function pickupNumber(order) {
  return isPickupOrder(order) && /^[1-9]\d*$/.test(String(order.pickupNumber || "")) ? `JEX-${order.pickupNumber}` : "";
}
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
  return ({ [PAYMENT.CASH]: "現金", [PAYMENT.CREDIT]: "クレジット" })[method] || "未設定";
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
