import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF, ORDER_TYPE, compactKey, syntaxKey, validateDraft, withShipping, totalPrice, totalQuantity } from "../order-domain.js";

test("品番表記を同じ検索キーへ正規化する", () => {
  assert.equal(syntaxKey("Ｎｏ．１０５３"), "1053");
  assert.equal(compactKey("141-712"), compactKey("141712"));
});

test("国内通常注文は店舗・電話・帳合先を必須にする", () => {
  const draft = { items: [{ qty: 1 }], type: ORDER_TYPE.NORMAL, store: "店舗", phone: "03-0000-0000", staff: "担当", account: "" };
  assert.equal(validateDraft(draft), "卸屋・帳合先を入力してください。");
  draft.account = "帳合先";
  assert.equal(validateDraft(draft), "");
});

test("ホテル配送はホテル名・宿泊者名を空欄で保存できる", () => {
  const draft = { items: [{ qty: 1 }], type: ORDER_TYPE.SPOT, handoff: HANDOFF.HOTEL, store: "店舗", phone: "1", customer: "顧客", paymentMethod: "cash", hotelName: "", guestName: "" };
  assert.equal(validateDraft(draft), "");
  draft.hotelName = "ホテル";
  assert.equal(validateDraft(draft), "");
  draft.guestName = "顧客";
  assert.equal(validateDraft(draft), "");
});

test("送料は何度追加しても500円一回だけで、商品点数に含めない", () => {
  const products = [{ code: "TEST", name: "テスト商品", price: 1000, qty: 2 }];
  const items = withShipping(withShipping(products));
  assert.equal(items.length, 2);
  assert.equal(totalPrice(items), 2500);
  assert.equal(totalQuantity(items), 2);
  assert.equal(products.length, 1);
  assert.equal(validateDraft({ items: withShipping([]) }), "商品を1点以上追加してください。");
  assert.equal(totalPrice(items.filter((item) => item.code !== "送料")), 2000);
});
