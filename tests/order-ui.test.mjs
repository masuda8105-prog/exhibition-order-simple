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

test("再開後の次のお渡し番号は区切りを付けずJEX-1と表示する", () => {
  const format = runInNewContext(`${appFunction("formatNextPickupNumber")}; formatNextPickupNumber`);
  assert.equal(format({generation:4,next_number:2}), "JEX-4-2");
  assert.equal(format({generation:5,next_number:1}), "JEX-1");
  assert.equal(format({generation:6,next_number:1}), "JEX-1");
});

test("注文履歴は状態別に分けず税込合計を表示する", () => {
  const history = { innerHTML: "", querySelectorAll: () => [] };
  const count = { textContent: "" };
  const search = { value: "" };
  const render = runInNewContext(`${appFunction("renderHistory")}; renderHistory`, {
    state: { orders: [{ localId: "one", store: "試験店", items: [{ code: "A", qty: 1, price: 100 }] }] },
    $: id => ({ orderHistory: history, orderCount: count, orderSearch: search })[id],
    orderMatches: () => true, orderNumber: () => "TEST-1", orderLabel: () => "現売り",
    totalQuantity: domain.totalQuantity, taxIncludedTotal: domain.taxIncludedTotal,
    pickupNumber: () => "", needsSlackShare: () => false, formatDateTime: () => "9/30 10:00",
    escapeHtml: String, yen: value => `¥${value}`,
  });
  render();
  assert.equal(count.textContent, "1件");
  assert.match(history.innerHTML, /税込合計<\/small>¥110/);
  assert.doesNotMatch(history.innerHTML, /受け取り待ち|要対応|完了/);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /注文履歴/);
  assert.doesNotMatch(html, /data-order-filter/);
});

test("トップは新しい注文を主役にし、履歴は操作時だけ開く", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="historyPanel" class="historyPanel hidden"/);
  assert.match(html, /id="showHistoryButton"[^>]*aria-expanded="false"/);
  assert.match(html, /id="newOrderButton"[^>]*>＋ 新しい注文/);
  const history = { hidden: true, classList: { toggle(name, hidden) { this.hidden = hidden; }, contains() { return this.hidden; } } };
  const toggle = { expanded: '', firstChild: { textContent: '' }, setAttribute(name, value) { this.expanded = value; } };
  const setVisible = runInNewContext(`${appFunction('setHistoryVisible')}; setHistoryVisible`, {
    $: id => id === 'historyPanel' ? history : toggle,
  });
  setVisible(true);
  assert.equal(toggle.expanded, 'true');
  assert.equal(history.classList.hidden, false);
  setVisible(false);
  assert.equal(toggle.expanded, 'false');
  assert.equal(history.classList.hidden, true);
});

test("通常注文の確認にも税抜・税込合計を出し写真入力は設けない", () => {
  assert.match(source, /<span>税抜合計<\/span>/);
  assert.match(source, /<span>税込合計（10％）<\/span>/);
  assert.doesNotMatch(source, /capture="environment"|uploadOrderPhoto|downloadOrderPhotos|attachmentPickerHtml/);
  const pdf = readFileSync(new URL("../order-pdf.js", import.meta.url), "utf8");
  assert.doesNotMatch(pdf, /shareAttachmentPage|attachment/);
});

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
    const card = { innerHTML: "", classList: { add() {} }, setAttribute() {} };
    const other = { classList: { add() {} }, textContent: "" };
    const state = { draft: { type: "spot", paymentMethod: method, items: [], notes: "試験備考" } };
    const render = runInNewContext(`${appFunction("receiptCopyHtml")}\n${appFunction("renderReceipt")}; renderReceipt`, {
      ...domain, state, $: id => id === "receiptCard" ? card : other, orderLabel: () => "現売り", orderNumber: () => "TEST",
      receiptInfo: (label, value) => `${label}:${value}`,
      escapeHtml: (value) => String(value ?? ""), yen: (value) => `¥${value}`, logoUrl: "test.jpg",
      renderReceiptOperations: () => {}, clearGeneratedPdf: () => {},
    });
    render();
    assert.ok(card.innerHTML.includes(`会計方法:${expected}`));
    assert.ok(card.innerHTML.includes("試験備考"));
    assert.ok(!card.innerHTML.includes("ご案内"));
    assert.equal((card.innerHTML.match(/<article /g) || []).length, 2);
    assert.ok(card.innerHTML.includes('data-copy="company" lang="ja"'));
    assert.ok(card.innerHTML.includes('data-copy="customer" lang="ja"'));
    state.draft.customerRegion = "overseas";
    state.draft.items = [{ code: "TEST-1", name: "商品名は原文", price: 100, qty: 1 }, ...domain.withShipping([])];
    render();
    assert.ok(card.innerHTML.includes('data-copy="company" lang="ja"'));
    assert.ok(card.innerHTML.includes('data-copy="customer" lang="en"'));
    assert.ok(card.innerHTML.includes(`Payment method:${({ cash: "Cash", credit: "Credit card" })[method] || "Not specified"}`));
    assert.ok(card.innerHTML.includes("Exhibition Order Receipt"));
    assert.ok(card.innerHTML.includes("Flat-rate shipping"));
    assert.ok(card.innerHTML.includes("税込合計"));
    assert.ok(card.innerHTML.includes("Total incl. tax"));
    assert.ok(card.innerHTML.includes("¥770"));
    assert.ok(card.innerHTML.includes("商品名は原文"));
    assert.ok(card.innerHTML.includes('data-label="Qty"'));
    const [companyHtml, customerHtml] = card.innerHTML.split('</article>');
    assert.ok(companyHtml.includes(`会計方法:${expected}`));
    assert.ok(!companyHtml.includes('Payment method:'));
    assert.ok(companyHtml.includes('会社控え'));
    assert.ok(customerHtml.includes('Customer Copy / お客様控え'));
    assert.ok(!customerHtml.includes('会計方法:'));
    state.draft.customerRegion = "domestic";
    state.draft.type = "normal";
    state.draft.notes = "";
    render();
    assert.ok(!card.innerHTML.includes("会計方法:"));
    assert.ok(card.innerHTML.includes('class="receiptNote"'));
    assert.ok(card.innerHTML.includes("備考"));
    assert.ok(!card.innerHTML.includes("ご案内"));
    assert.ok(!card.innerHTML.includes('lang="en"'));
  }
});

test("全注文区分で会社控えを先に出し、両控えで番号・金額を一致させる", () => {
  const render = runInNewContext(`${appFunction("receiptCopyHtml")}; receiptCopyHtml`, {
    ...domain, state: {}, orderLabel: () => "現売り", orderNumber: () => "260916-TEST",
    receiptInfo: (label,value) => `${label}:${value}`, escapeHtml: value => String(value ?? ""),
    yen: value => `¥${value}`, logoUrl: "test.jpg",
  });
  for (const type of ['normal','spot']) for (const handoff of ['now','later','hotel','ship']) {
    const draft = {type,handoff,customerRegion:'overseas',staff:'試験',account:'試験帳合先',notes:'連絡事項',pickupNumber:'17',pickupDate:'2026-09-17',items:[{code:'TEST',name:'試験',qty:2,price:100}]};
    const before = JSON.stringify(draft);
    const company = render(draft,new Date('2026-09-16T01:00:00Z'),true);
    const customer = render(draft,new Date('2026-09-16T01:00:00Z'),false);
    assert.ok(company.includes('lang="ja"'));
    assert.ok(customer.includes('lang="en"'));
    for (const html of [company,customer]) {
      assert.ok(html.includes('260916-TEST'));
      assert.ok(html.includes('¥200'));
      assert.ok(html.includes('試験帳合先'));
      assert.ok(html.includes('連絡事項'));
      assert.ok(!html.includes('ご案内'));
      assert.ok(!html.includes('受け渡し:'));
      assert.ok(!html.includes('Pickup / Delivery:'));
      assert.equal(html.includes('JEX-17'),type === 'spot' && handoff === 'later');
      assert.equal(html.includes('class="receiptPickupTiming"'),type === 'spot' && handoff === 'later');
    }
    if(type === 'spot' && handoff === 'later') {
      assert.match(company, /お渡し日 2026\/09\/17<\/span><strong>13時以降/);
      assert.match(customer, /Pickup date 2026\/09\/17<\/span><strong>After 1:00 PM/);
    }
    assert.ok(!company.includes('Scheduled pickup:'));
    assert.ok(!company.includes('2026-09-17 受取予定'));
    assert.equal(JSON.stringify(draft),before);
  }
  const css = readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(css,/\.receiptCopy \+ \.receiptCopy \{ break-before: page !important/);
});

test("通常もSlack用も会社控え・お客様控えの2部をPDFにする", async () => {
  const calls = [];
  let decoded = 0;
  const document = { body: { dataset: {} }, fonts: { ready: Promise.resolve() }, querySelectorAll: () => [] };
  const state = { draft: { type: 'spot', handoff: 'later', pickupNumber: '3' } };
  const print = runInNewContext(`async ${appFunction('printReceipt')}; printReceipt`, {
    ...domain, state, document,
    $: () => ({ querySelectorAll: () => [1,2].map(() => ({decode:async () => { decoded++; }})) }),
    createOrderPdf: async () => { calls.push('2 copies'); return {blob:{},pages:2}; },
    offerOrderPdf: () => {}, orderNumber: () => 'TEST', toast: () => {},
  });
  await print();
  await print();
  assert.deepEqual(calls,['2 copies','2 copies']);
  assert.equal(decoded,4);
  state.draft.pickupNumber = '';
  await print();
  assert.equal(calls.length,2);
});

test("保存後はPDFを自動作成し、プレビュー横に作成ボタンを置かない", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="receiptCard" class="hidden"/);
  assert.match(html, /id="previewToggleButton"/);
  assert.doesNotMatch(html, /printButton|customerImageButton|receiptSlackShared|confirmOrderButton/);
  assert.doesNotMatch(source, /function shareCustomerCopy|function saveReceiptProgress|Slack共有と注文確定/);
  assert.match(source, /window\.scrollTo\(\{ top: 0 \}\);\s*await printReceipt\(\);/);
  const pdfSource = readFileSync(new URL('../order-pdf.js', import.meta.url), 'utf8');
  assert.match(pdfSource, /share\.textContent="PDFを共有"/);
  assert.match(pdfSource, /instruction\.textContent="Slackで宮川さん宛に送信し、PCで印刷してください。"/);
  const label = runInNewContext(`${appFunction('preparationLabel')}; preparationLabel`, domain);
  assert.equal(label({type:'normal'}), 'PDFを作成');
  assert.equal(label({type:'spot',handoff:'now'}), 'PDFを作成');
  assert.equal(label({type:'spot',handoff:'hotel'}), 'PDFを作成');
  assert.equal(label({type:'spot',handoff:'ship'}), 'PDFを作成');
  assert.equal(label({type:'spot',handoff:'later'}), 'お渡し番号を発行');
  assert.equal(label({type:'spot',handoff:'later',pickupNumber:'1'}), 'PDFを作成');
});

test("印刷用控えの本文・明細・合計を読める文字サイズに保つ", () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('@media print {\n'));
  for (const selector of ['.receiptInfoValue', '.receiptTable', '.receiptNote', '.receiptSummaryRow']) {
    assert.match(print, new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*font-size: 16px !important;`));
  }
  assert.match(print, /\.receiptSummaryRow\.total \{[^}]*font-size: 23px !important;/);
});

test("控えの情報欄に受け渡し項目を出さず、お渡し番号は維持する", () => {
  assert.doesNotMatch(appFunction("receiptCopyHtml"), /Pickup \/ Delivery|t\("受け渡し"/);
  assert.match(appFunction("receiptCopyHtml"), /receiptPickupNumber/);
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.receiptPickupTiming \{[^}]*color: #b42318;/);
});

test("PDF画面はお渡し番号だけを追加表示し、確認チェックを置かない", () => {
  const panel = { innerHTML: '' };
  const notice = { textContent: '' };
  const render = runInNewContext(`${appFunction('renderReceiptOperations')}; renderReceiptOperations`, {
    state: { draft: {type:'spot',handoff:'later',pickupNumber:'3'} },
    $: id => ({receiptOperations:panel,printPrivacyNotice:notice})[id],
    isPickupOrder: domain.isPickupOrder, pickupNumber: domain.pickupNumber, escapeHtml: String,
  });
  render();
  assert.match(panel.innerHTML, /JEX-3/);
  assert.doesNotMatch(panel.innerHTML, /Slack|確定|checkbox/);
});
