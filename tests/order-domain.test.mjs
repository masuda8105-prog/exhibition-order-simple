import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF, ORDER_TYPE, compactKey, syntaxKey, validateDraft } from "../order-domain.js";

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

test("ホテル配送はホテル名と宿泊者名を必須にする", () => {
  const draft = { items: [{ qty: 1 }], type: ORDER_TYPE.SPOT, handoff: HANDOFF.HOTEL, store: "店舗", phone: "1", customer: "顧客", paymentMethod: "cash", hotelName: "", guestName: "" };
  assert.equal(validateDraft(draft), "ホテル名を入力してください。");
  draft.hotelName = "ホテル";
  assert.equal(validateDraft(draft), "宿泊者名を入力してください。");
  draft.guestName = "顧客";
  assert.equal(validateDraft(draft), "");
});
