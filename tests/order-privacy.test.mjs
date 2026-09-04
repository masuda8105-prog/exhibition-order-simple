import test from "node:test";
import assert from "node:assert/strict";
import { clearOrderData } from "../order-privacy.js";

test("注文・顧客情報と画面内のコピーを消去し、ログイン・端末設定を維持する", () => {
  const state = {
    draft: { store: "テスト店舗", customer: "テスト顧客", phone: "000", notes: "テスト", items: [{ code: "D001", qty: 2 }] },
    createdAt: new Date(),
    profile: { display_name: "テスト担当" },
    settings: { eventName: "テスト展示会" },
    products: [{ code: "D001" }],
    session: { user: { id: "test" } },
  };
  const retained = { profile: state.profile, settings: state.settings, products: state.products, session: state.session };
  const containers = Array.from({ length: 3 }, () => ({
    children: ["顧客情報"],
    replaceChildren(...children) { this.children = children; },
  }));
  clearOrderData(state, containers);
  assert.equal(state.draft, null);
  assert.equal(state.createdAt, null);
  for (const container of containers) assert.deepEqual(container.children, []);
  for (const [key, value] of Object.entries(retained)) assert.equal(state[key], value);
  // Repeated print or logout events must remain safe.
  clearOrderData(state, containers);
  assert.equal(state.draft, null);
});
