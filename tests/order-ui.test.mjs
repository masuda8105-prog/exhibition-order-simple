import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as domain from "../order-domain.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function appFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\nfunction ", start + 1));
}

test("候補タップは検索・候補DOM・フォーカスを維持して枝番を連続追加できる", () => {
  const state = { draft: { items: [], productQuery: "893" } };
  const query = { value: "893" };
  let resultsRenders = 0, focusCalls = 0, cartRenders = 0;
  const add = runInNewContext(`${appFunction("addProduct")}; addProduct`, {
    state, $: () => query, renderProductResults: () => resultsRenders++,
    renderCart: () => cartRenders++, toast: () => {}, focusProductInput: () => focusCalls++,
  });
  const first = { code: "893-1", name: "架空試験商品1", price: 100 };
  const second = { code: "893-2", name: "架空試験商品2", price: 200 };
  add(first, { keepSearch: true });
  add(second, { keepSearch: true });
  add(first, { keepSearch: true });
  assert.equal(state.draft.items.length, 2);
  assert.equal(state.draft.items[0].qty, 2);
  assert.equal(state.draft.items[1].qty, 1);
  assert.equal(query.value, "893");
  assert.equal(state.draft.productQuery, "893");
  assert.equal(resultsRenders, 0);
  assert.equal(focusCalls, 0);
  assert.equal(cartRenders, 3);
  add(second);
  assert.equal(query.value, "");
  assert.equal(state.draft.productQuery, "");
  assert.equal(resultsRenders, 1);
  assert.equal(focusCalls, 1);
});

test("控えに現金・クレジットを表示し、ご案内定型文は出さない", () => {
  for (const [method, expected] of [["cash", "現金"], ["credit", "クレジット"], ["", "未設定"]]) {
    const card = { innerHTML: "", setAttribute() {} };
    const state = { draft: { type: "spot", paymentMethod: method, items: [], notes: "試験備考" } };
    const render = runInNewContext(`${appFunction("renderReceipt")}; renderReceipt`, {
      ...domain, state, $: () => card, orderLabel: () => "現売り", orderNumber: () => "TEST",
      receiptHandoffLabel: () => "その場渡し", receiptInfo: (label, value) => `${label}:${value}`,
      escapeHtml: (value) => String(value ?? ""), yen: (value) => `¥${value}`, logoUrl: "test.jpg",
      renderReceiptOperations: () => {},
    });
    render();
    assert.ok(card.innerHTML.includes(`会計方法:${expected}`));
    assert.ok(card.innerHTML.includes("試験備考"));
    assert.ok(!card.innerHTML.includes("ご案内"));
    state.draft.customerRegion = "overseas";
    state.draft.items = [{ code: "TEST-1", name: "商品名は原文", price: 100, qty: 1 }, ...domain.withShipping([])];
    render();
    assert.equal(card.lang, "en");
    assert.ok(card.innerHTML.includes(`Payment method:${({ cash: "Cash", credit: "Credit card" })[method] || "Not specified"}`));
    assert.ok(card.innerHTML.includes("Exhibition Order Receipt"));
    assert.ok(card.innerHTML.includes("Flat-rate shipping"));
    assert.ok(card.innerHTML.includes("商品名は原文"));
    assert.ok(card.innerHTML.includes('data-label="Qty"'));
    assert.ok(!card.innerHTML.includes("会計方法"));
    state.draft.customerRegion = "domestic";
    state.draft.type = "normal";
    state.draft.notes = "";
    render();
    assert.ok(!card.innerHTML.includes("会計方法:"));
    assert.ok(!card.innerHTML.includes('class="receiptNote"'));
    assert.equal(card.lang, "ja");
  }
});

test("海外の控えだけ受け渡し方法を英語にする", () => {
  const label = runInNewContext(`${appFunction("receiptHandoffLabel")}; receiptHandoffLabel`, domain);
  for (const [handoff, expected] of [["now", "Pay and collect"], ["later", "Scheduled pickup: 2026-09-16"], ["hotel", "Hotel delivery (入力ホテル)"], ["ship", "Delivery to specified address"]]) {
    const order = { type: "spot", customerRegion: "overseas", handoff, pickupDate: "2026-09-16", hotelName: "入力ホテル" };
    assert.ok(label(order).includes(expected));
    order.customerRegion = "domestic";
    assert.ok(!label(order).includes(expected));
  }
});

test("確定保存の失敗・競合では元の未確定状態に戻し、失敗を表示する", async () => {
  for (const reason of ["NETWORK_ERROR", "SYNC_CONFLICT"]) {
    const previous = { submissionState: "pending", slackShared: true };
    const state = { draft: previous };
    const controls = [{ disabled: false }, { disabled: true }];
    const errorLabel = { textContent: "", classList: { remove() {} } };
    let rendered = 0, toasted = 0;
    const save = runInNewContext(`async ${appFunction("saveReceiptProgress")}; saveReceiptProgress`, {
      state, document: { querySelectorAll: () => controls }, $: () => errorLabel,
      persistCurrentDraft: async () => { throw new Error(reason); },
      renderReceiptOperations: () => rendered++, toast: () => toasted++,
    });
    await save({submissionState: "confirmed", slackShared: true}, "成功");
    assert.equal(state.draft,previous);
    assert.equal(controls[0].disabled,false);
    assert.equal(controls[1].disabled,true);
    assert.equal(toasted,0);
    assert.equal(rendered,1);
    assert.ok(errorLabel.textContent.includes(reason === "SYNC_CONFLICT" ? "別のスタッフ" : "保存できません"));
  }
});
