import { HANDOFF, ORDER_TYPE, pickupNumber, workflowStatus } from "./order-domain.js";

// Separate order group: production keeps its own event_name filter.
export const SYNC_EVENT_NAME = "exhibition-order-simple";

export function orderNumber(order) {
  const original = order?.receiptNo || order?.orderNo || "";
  const previousReceipt = /^受付-(\d{8})-([A-Z0-9]{8})$/i.exec(original);
  if (previousReceipt) return `${previousReceipt[1].slice(2)}-${previousReceipt[2].toUpperCase()}`;
  if (original) return original;
  if (!order?.localId) return "登録前";
  const date = new Date(order.createdAt || "");
  const stamp = Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "2-digit", month: "2-digit", day: "2-digit",
  }).format(date).replaceAll("-", "");
  return `${stamp ? `${stamp}-` : ""}${order.localId.slice(0, 8).toUpperCase()}`;
}

export function orderLabel(order) {
  if (order?.type === ORDER_TYPE.NORMAL) return "国内通常注文";
  return ({
    [HANDOFF.NOW]: "現売り・その場渡し",
    [HANDOFF.LATER]: "現売り・後日受取",
    [HANDOFF.HOTEL]: "現売り・ホテル配送",
    [HANDOFF.SHIP]: "現売り・指定先配送",
  })[order?.handoff] || "現売り";
}

export function payloadForOrder(order) {
  return {
    receiptNo: order.receiptNo || "",
    type: order.type || "",
    handoff: order.handoff || "",
    customerRegion: order.customerRegion || "domestic",
    store: order.store || "",
    phone: order.phone || "",
    customer: order.customer || "",
    workflowStatus: workflowStatus(order),
    account: order.account || "",
    accountChoice: order.accountChoice || "",
    accountOther: order.accountOther || "",
    staff: order.staff || "",
    paymentMethod: order.paymentMethod || "",
    paid: Boolean(order.paid),
    delivered: Boolean(order.delivered),
    deliveredAt: order.deliveredAt || "",
    shipped: Boolean(order.shipped),
    prepared: order.prepared || "none",
    headOfficeShared: Boolean(order.headOfficeShared),
    headOfficeSharedAt: order.headOfficeSharedAt || "",
    slackShared: Boolean(order.slackShared),
    slackSharedAt: order.slackSharedAt || "",
    submissionState: order.submissionState || "",
    confirmedAt: order.confirmedAt || "",
    pickupDate: order.pickupDate || "",
    notes: order.notes || "",
    hotelName: order.hotelName || "",
    guestName: order.guestName || "",
    roomNo: order.roomNo || "",
    checkoutDate: order.checkoutDate || "",
    shipAddress: order.shipAddress || "",
    items: (order.items || []).map((item) => ({
      productId: item.productId || "",
      code: String(item.code || ""),
      name: String(item.name || ""),
      price: Number(item.price || 0),
      imageUrl: item.imageUrl || "",
      status: item.status || "active",
      orderable: item.orderable !== false,
      lineId: item.lineId || "",
      qty: Number(item.qty || 0),
    })),
  };
}

export function orderFromRow(row) {
  const payload = row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload
    : {};
  return {
    ...payload,
    pickupNumber: row?.simple_pickup_number == null ? "" : String(row.simple_pickup_number),
    items: Array.isArray(payload.items) ? payload.items.map((item) => ({ ...item })) : [],
    localId: String(row?.id || ""),
    createdAt: row?.created_at || "",
    updatedAt: row?.updated_at || "",
    cloudUpdatedAt: row?.updated_at || "",
    editingId: "",
  };
}

export function orderMatches(order, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  return [
    orderNumber(order), pickupNumber(order), order?.receiptNo, order?.orderNo, order?.localId, order?.store, order?.customer, order?.phone,
    ...(order?.items || []).flatMap((item) => [item.code, item.name]),
  ].join(" ").toLowerCase().includes(normalized);
}
