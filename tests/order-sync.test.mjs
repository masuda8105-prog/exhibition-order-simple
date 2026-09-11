import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF, ORDER_TYPE, withShipping, totalPrice, totalQuantity } from "../order-domain.js";
import { orderFromRow, orderLabel, orderMatches, orderNumber, payloadForOrder } from "../order-sync.js";

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

test("注文番号は既存データを書き換えず短縮し、再表示しても変わらない", () => {
  const saved = { localId: "abcdef12-1234-4000-8000-123456789012", createdAt: "2026-09-10T23:00:00Z" };
  assert.equal(orderNumber(saved), "260911-ABCDEF12");
  assert.equal(orderNumber({ ...saved, receiptNo: "受付-20260911-ABCDEF12" }), "260911-ABCDEF12");
  assert.equal(orderNumber({ ...saved, orderNo: "SN-001" }), "SN-001");
  assert.equal(orderNumber({}), "登録前");
});

test("送料は共有保存から復元しても金額・点数が変わらない", () => {
  const order = { items: withShipping([{ code: "TEST", name: "テスト商品", price: 1000, qty: 2 }]) };
  const restored = orderFromRow({ id: "test-id", payload: payloadForOrder(order) });
  assert.equal(totalPrice(restored.items), 2500);
  assert.equal(totalQuantity(restored.items), 2);
  assert.equal(totalPrice(withShipping(restored.items)), 2500);
});
