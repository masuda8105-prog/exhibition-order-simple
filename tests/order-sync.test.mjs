import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF, ORDER_TYPE } from "../order-domain.js";
import { orderFromRow, orderLabel, orderMatches, payloadForOrder } from "../order-sync.js";

test("共有注文を既存ツール互換のpayloadへ変換し復元できる", () => {
  const source = {
    receiptNo: "受付-20260908-ABCDEF12",
    type: ORDER_TYPE.SPOT,
    handoff: HANDOFF.LATER,
    store: "西村眼鏡店",
    phone: "06-1234-5678",
    customer: "田中様",
    pickupDate: "2026-09-09",
    staff: "増田",
    items: [{ code: "1054", name: "ヤットコ", price: 5200, qty: 2 }],
  };
  const restored = orderFromRow({ id: "order-id", payload: payloadForOrder(source), created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T01:00:00Z" });
  assert.equal(restored.localId, "order-id");
  assert.equal(restored.store, source.store);
  assert.deepEqual(restored.items, [{ productId: "", code: "1054", name: "ヤットコ", price: 5200, imageUrl: "", status: "active", orderable: true, lineId: "", qty: 2 }]);
  assert.equal(orderLabel(restored), "現売り・後日受取");
});

test("履歴検索は店舗・顧客・品番・商品名を対象にする", () => {
  const order = { store: "西村眼鏡店", customer: "田中様", phone: "06-1234-5678", items: [{ code: "141-712", name: "鼻盛パッド" }] };
  for (const query of ["西村", "田中", "5678", "141-712", "鼻盛"]) assert.equal(orderMatches(order, query), true);
  assert.equal(orderMatches(order, "該当なし"), false);
});
