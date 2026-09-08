import { createClient } from "@supabase/supabase-js";
import { clearOrderData } from "./order-privacy.js";
import {
  ORDER_TYPE,
  HANDOFF,
  PAYMENT,
  compactKey,
  handoffLabel,
  orderTypeLabel,
  paymentLabel,
  phoneHasUnexpectedCharacters,
  syntaxKey,
  totalPrice,
  totalQuantity,
  validateDraft,
} from "./order-domain.js";

const SETTINGS_KEY = "exhibitionSimple.settings.v2";
const $ = (id) => document.getElementById(id);
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const isLocalDemo = ["127.0.0.1", "localhost"].includes(location.hostname)
  && new URLSearchParams(location.search).get("local-development") === "1";
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.sessionStorage,
    },
  })
  : null;

const state = {
  session: null,
  profile: null,
  products: [],
  accounts: [],
  draft: null,
  createdAt: null,
  settings: loadSettings(),
  authUserId: "",
};

function loadSettings() {
  try {
    return { eventName: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { eventName: "" };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ eventName: state.settings.eventName || "" }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function yen(value) {
  return `¥${Math.round(Number(value) || 0).toLocaleString("ja-JP")}`;
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(date);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2100);
}

function focusProductInput(query) {
  if (!window.matchMedia("(pointer: coarse)").matches) query.focus();
}

function showError(message) {
  $("sheetError").textContent = message;
  $("sheetError").classList.remove("hidden");
  $("sheetPanel").scrollTo({ top: 0, behavior: "smooth" });
}

function clearError() {
  $("sheetError").textContent = "";
  $("sheetError").classList.add("hidden");
}

function showLogin(message = "") {
  clearCurrentOrder();
  state.authUserId = "";
  state.session = null;
  state.profile = null;
  state.products = [];
  state.accounts = [];
  state.draft = null;
  $("appView").classList.add("hidden");
  $("receiptView").classList.add("hidden");
  $("sheet").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("loginMessage").textContent = message;
  $("loginButton").disabled = !supabase;
  $("loginPassword").value = "";
}

function prepareProduct(product) {
  const code = String(product.product_no ?? product.code ?? "");
  return {
    code,
    name: String(product.product_name ?? product.name ?? ""),
    price: Number(product.wholesale_price ?? product.price ?? 0),
    syntax: syntaxKey(code),
    compact: compactKey(code),
  };
}

async function fetchAllProducts() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("products")
      .select("product_no,product_name,wholesale_price")
      .eq("is_active", true)
      .order("product_no", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  if (!rows.length) throw new Error("利用可能な商品がありません。");
  return rows.map(prepareProduct);
}

async function fetchAccountOptions() {
  const { data, error } = await supabase
    .from("exhibition_accounts")
    .select("account_name")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("account_name", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => String(row.account_name)).filter(Boolean);
}

async function openForSession(session) {
  if (!session?.user?.id || state.authUserId === session.user.id) return;
  state.authUserId = session.user.id;
  $("loginMessage").textContent = "スタッフ権限と商品マスタを確認しています…";
  try {
    const { data: profile, error: profileError } = await supabase
      .from("exhibition_staff")
      .select("display_name,active")
      .eq("user_id", session.user.id)
      .eq("active", true)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) throw new Error("このアカウントには有効なスタッフ権限がありません。");
    const [products, accounts] = await Promise.all([fetchAllProducts(), fetchAccountOptions()]);
    state.session = session;
    state.profile = profile;
    state.products = products;
    state.accounts = accounts;
    showApp();
  } catch (error) {
    console.error(error);
    state.authUserId = "";
    await supabase.auth.signOut();
    showLogin(error.message || "商品マスタを取得できませんでした。");
  }
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("receiptView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("eventName").textContent = state.settings.eventName || "EXHIBITION";
  $("staffName").textContent = `${state.profile.display_name} ／ 商品マスタ ${state.products.length.toLocaleString("ja-JP")}件`;
  startNewOrder();
}

async function boot() {
  bindStaticEvents();
  if (isLocalDemo) {
    state.profile = { display_name: "テスト担当", active: true };
    state.products = [
      prepareProduct({ product_no: "D001", product_name: "動作確認商品 A", wholesale_price: 0 }),
      prepareProduct({ product_no: "D002", product_name: "動作確認商品 B", wholesale_price: 0 }),
      prepareProduct({ product_no: "141-TEST", product_name: "ハイフン検索確認商品", wholesale_price: 0 }),
    ];
    state.accounts = ["テスト帳合先"];
    showApp();
    return;
  }
  if (!supabase) {
    $("loginButton").disabled = true;
    showLogin("Supabaseの公開接続設定がありません。VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。");
    return;
  }
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.error(error);
  if (session) await openForSession(session);
  else showLogin();
  supabase.auth.onAuthStateChange((event, nextSession) => {
    queueMicrotask(() => {
      if (event === "SIGNED_OUT" || !nextSession) showLogin();
      else if (event === "SIGNED_IN") openForSession(nextSession);
    });
  });
}

function freshDraft() {
  return {
    stage: "products",
    productQuery: "",
    keypadMode: "number",
    type: "",
    handoff: "",
    items: [],
    store: "",
    phone: "",
    customer: "",
    customerRegion: "domestic",
    account: "",
    accountChoice: "",
    accountOther: "",
    staff: state.profile?.display_name || "",
    paymentMethod: PAYMENT.CREDIT,
    paid: false,
    pickupDate: dateOffset(1),
    hotelName: "",
    guestName: "",
    roomNo: "",
    checkoutDate: "",
    shipAddress: "",
    notes: "",
  };
}

function clearCurrentOrder() {
  clearOrderData(state, [$("sheetBody"), $("receiptCard"), $("sheetError")]);
}

function startNewOrder() {
  clearCurrentOrder();
  state.draft = freshDraft();
  state.createdAt = null;
  $("receiptCard").classList.remove("hidden");
  $("printPrivacyNotice").classList.remove("hidden");
  $("printedActions").classList.add("hidden");
  $("receiptActions").classList.remove("hidden");
  $("receiptView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  openSheet();
  renderDraft();
}

function openSheet() {
  $("sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  clearError();
}

function closeSheet() {
  $("sheet").classList.add("hidden");
  $("sheet").classList.remove("productFullscreen");
  document.body.style.overflow = "";
}

function renderDraft() {
  clearError();
  if (!state.draft) return;
  $("sheet").classList.toggle("productFullscreen", state.draft.stage === "products");
  if (state.draft.stage === "products") renderProductStep();
  else if (state.draft.stage === "type") renderTypeStep();
  else renderInfoStep();
}

function resolveProducts(query) {
  const syntax = syntaxKey(query);
  const compact = compactKey(query);
  if (!syntax || !compact) return [];
  const syntaxMatches = state.products.filter((product) => product.syntax === syntax);
  return syntaxMatches.length ? syntaxMatches : state.products.filter((product) => product.compact === compact);
}

function findSuggestions(query, limit = 12) {
  const syntax = syntaxKey(query);
  const compact = compactKey(query);
  if (!syntax || !compact) return [];
  const exact = resolveProducts(query);
  const seen = new Set(exact.map((product) => product.code));
  const prefix = state.products.filter((product) => !seen.has(product.code)
    && (product.syntax.startsWith(syntax) || product.compact.startsWith(compact)));
  return [...exact, ...prefix].slice(0, limit);
}

function addProduct(product) {
  const existing = state.draft.items.find((item) => item.code === product.code);
  if (existing) existing.qty = Math.min(999, existing.qty + 1);
  else state.draft.items.push({ code: product.code, name: product.name, price: product.price, qty: 1 });
  state.draft.productQuery = "";
  $("productQ").value = "";
  renderProductResults("");
  renderCart();
  toast(existing ? `No.${product.code} の数量を ${existing.qty} にしました` : `No.${product.code} を追加しました`);
  focusProductInput($("productQ"));
}

function addExactQuery() {
  const matches = resolveProducts($("productQ").value);
  if (matches.length === 1) addProduct(matches[0]);
  else if (matches.length > 1) showError("同じ省略表記に複数商品があります。候補から選んでください。");
  else showError("品番が見つかりません。入力内容を確認してください。");
}

function renderProductStep() {
  const draft = state.draft;
  $("stepLabel").textContent = "1 / 3　商品";
  $("sheetTitle").textContent = "商品を追加";
  $("sheetBody").innerHTML = `
    <div class="step productStep">
      <p class="stepIntro">品番を入力して追加してください。すべての商品を入れ終わったら次へ進みます。</p>
      <div class="productSearch">
        <form id="productSearchForm" class="productSearchRow" autocomplete="off">
          <input id="productQ" type="search" inputmode="search" placeholder="1053 / No.1053 / 141-712" aria-label="品番">
          <button id="addExactButton" class="primary compact" type="submit">追加</button>
          <button id="clearPQ" class="secondary compact" type="button" aria-label="検索をクリア">×</button>
        </form>
        <div class="masterLine">商品マスタ ${state.products.length.toLocaleString("ja-JP")}件・品番の全角／No.／ハイフンなし検索に対応</div>
        <div class="productKeypadDock">
          <div class="keypadTitle"><b>固定入力キー</b><button id="keypadMode" class="keypadModeLabel" type="button">数字・記号</button></div>
          <div id="productKeypad" class="productKeypad numberKeys"></div>
        </div>
        <div id="productResults" class="productResults" role="listbox" aria-label="商品候補"></div>
      </div>
      <div class="section productCartSection">
        <div class="sectionTitle">注文明細 <span id="cartCount">0点</span></div>
        <div id="cartLines" class="cart"></div>
      </div>
    </div>
    <div class="stickyActions one"><button id="toType" class="primary">お客様情報入力へ</button></div>`;
  const query = $("productQ");
  query.value = draft.productQuery;
  query.addEventListener("input", () => {
    draft.productQuery = query.value;
    renderProductResults(query.value);
  });
  query.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addExactQuery();
  });
  $("productSearchForm").addEventListener("submit", (event) => { event.preventDefault(); addExactQuery(); });
  $("clearPQ").addEventListener("click", () => { query.value = ""; draft.productQuery = ""; renderProductResults(""); query.focus(); });
  $("toType").addEventListener("click", () => {
    if (!draft.items.length) return showError("商品を1点以上追加してください。");
    draft.stage = "type";
    renderDraft();
  });
  bindProductKeypad();
  renderCart();
  renderProductResults(query.value);
  setTimeout(() => focusProductInput(query), 0);
}

function bindProductKeypad() {
  const draft = state.draft;
  const query = $("productQ");
  const wrap = $("productKeypad");
  const modeButton = $("keypadMode");
  const numeric = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "-", "0", "⌫"];
  const alpha = ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "A", "S", "D", "F", "G", "H", "J", "K", "L", "Z", "X", "C", "V", "B", "N", "M", "-", "⌫"];
  function paint() {
    const values = draft.keypadMode === "alpha" ? alpha : numeric;
    wrap.className = `productKeypad ${draft.keypadMode === "alpha" ? "alphaKeys" : "numberKeys"}`;
    wrap.innerHTML = values.map((key) => `<button type="button" class="keypadKey" data-key="${escapeHtml(key)}">${escapeHtml(key)}</button>`).join("")
      + '<div class="keypadUtility"><button type="button" class="keypadKey" data-key="mode">数字／英字</button><button type="button" class="keypadKey" data-key="clear">クリア</button><button type="button" class="keypadKey addKey" data-key="add">追加</button></div>';
    modeButton.textContent = draft.keypadMode === "alpha" ? "英字・記号" : "数字・記号";
    wrap.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => {
      query.blur();
      const key = button.dataset.key;
      if (key === "mode") draft.keypadMode = draft.keypadMode === "alpha" ? "number" : "alpha";
      else if (key === "clear") query.value = "";
      else if (key === "add") return addExactQuery();
      else if (key === "⌫") query.value = query.value.slice(0, -1);
      else query.value += key;
      draft.productQuery = query.value;
      renderProductResults(query.value);
      if (key === "mode") paint();
    }));
  }
  modeButton.addEventListener("click", () => {
    query.blur();
    draft.keypadMode = draft.keypadMode === "alpha" ? "number" : "alpha";
    paint();
  });
  paint();
}

function renderProductResults(query) {
  const wrap = $("productResults");
  if (!query.trim()) {
    wrap.classList.remove("open");
    wrap.innerHTML = "";
    return;
  }
  const exactCodes = new Set(resolveProducts(query).map((product) => product.code));
  const suggestions = findSuggestions(query);
  wrap.innerHTML = suggestions.length ? suggestions.map((product) => `
    <button type="button" class="productRow ${exactCodes.has(product.code) ? "exact" : ""}" data-product-code="${escapeHtml(product.code)}" role="option">
      <span><span class="productCodeLine"><b>No.${escapeHtml(product.code)}</b>${exactCodes.has(product.code) ? '<em class="matchBadge">一致</em>' : ""}</span><small>${escapeHtml(product.name)}</small></span>
      <span class="addBtn">追加</span>
    </button>`).join("") : '<div class="empty">該当する品番がありません。</div>';
  wrap.classList.add("open");
  wrap.querySelectorAll("[data-product-code]").forEach((button) => button.addEventListener("click", () => {
    const product = state.products.find((row) => row.code === button.dataset.productCode);
    if (product) addProduct(product);
  }));
}

function renderCart() {
  const draft = state.draft;
  const wrap = $("cartLines");
  $("cartCount").textContent = `${totalQuantity(draft.items)}点`;
  $("toType").disabled = !draft.items.length;
  if (!draft.items.length) {
    wrap.innerHTML = '<div class="empty compactEmpty">商品はまだありません。</div>';
    return;
  }
  wrap.innerHTML = draft.items.map((item, index) => `
    <div class="cartLine" data-item-index="${index}">
      <div><b>No.${escapeHtml(item.code)}</b><small>${escapeHtml(item.name)}</small></div>
      <div class="qty">
        <button type="button" data-qty-action="minus" aria-label="数量を減らす">−</button>
        <input type="number" min="1" max="999" inputmode="numeric" value="${item.qty}" data-qty-action="input" aria-label="数量">
        <button type="button" data-qty-action="plus" aria-label="数量を増やす">＋</button>
        <button type="button" class="remove" data-qty-action="remove" aria-label="削除">×</button>
      </div>
    </div>`).join("");
  wrap.querySelectorAll("[data-qty-action]").forEach((control) => {
    const row = control.closest("[data-item-index]");
    const index = Number(row.dataset.itemIndex);
    const action = control.dataset.qtyAction;
    const update = () => {
      const item = draft.items[index];
      if (!item) return;
      if (action === "plus") item.qty = Math.min(999, item.qty + 1);
      if (action === "minus") item.qty = Math.max(1, item.qty - 1);
      if (action === "input") item.qty = Math.min(999, Math.max(1, Math.round(Number(control.value) || 1)));
      if (action === "remove") draft.items.splice(index, 1);
      renderCart();
    };
    control.addEventListener(action === "input" ? "change" : "click", update);
  });
}

function renderTypeStep() {
  const draft = state.draft;
  const canContinue = draft.type && (draft.type !== ORDER_TYPE.SPOT || draft.handoff);
  $("stepLabel").textContent = "2 / 3　注文方法";
  $("sheetTitle").textContent = "どの対応ですか？";
  $("sheetBody").innerHTML = `
    <div class="step">
      <p class="stepIntro">実際の対応に一番近いものを選んでください。</p>
      <div class="choiceGrid">
        <button class="choice ${draft.type === ORDER_TYPE.NORMAL ? "on" : ""}" type="button" data-type="normal"><b>国内通常注文</b><small>卸屋・電話番号を入力して注文書を作成します。</small></button>
        <button class="choice ${draft.type === ORDER_TYPE.SPOT ? "on" : ""}" type="button" data-type="spot"><b>現売り対応</b><small>会場での会計・受け渡し、後日受取、配送です。</small></button>
      </div>
      ${draft.type === ORDER_TYPE.SPOT ? `
        <div class="section topGap">
          <div class="sectionTitle">商品の渡し方 *</div>
          <div class="choiceGrid handoffChoices">
            <button class="choice ${draft.handoff === HANDOFF.NOW ? "on" : ""}" type="button" data-handoff="now"><b>1　在庫あり・その場渡し</b><small>会計して、その場で商品をお渡しします。</small></button>
            <button class="choice ${draft.handoff === HANDOFF.LATER ? "on" : ""}" type="button" data-handoff="later"><b>2　翌日・翌々日に受取</b><small>受取予定日と会計状況を入力します。</small></button>
            <button class="choice ${draft.handoff === HANDOFF.HOTEL ? "on" : ""}" type="button" data-handoff="hotel"><b>3　ホテルへ配送</b><small>ホテル名と宿泊者情報を入力します。</small></button>
            <button class="choice ${draft.handoff === HANDOFF.SHIP ? "on" : ""}" type="button" data-handoff="ship"><b>4　指定住所へ配送</b><small>配送先住所を入力します。</small></button>
          </div>
        </div>` : ""}
    </div>
    <div class="stickyActions"><button id="backProducts" class="secondary" type="button">戻る</button><button id="toInfo" class="primary" type="button" ${canContinue ? "" : "disabled"}>入力へ進む</button></div>`;
  document.querySelectorAll("[data-type]").forEach((button) => button.addEventListener("click", () => {
    const previous = draft.type;
    draft.type = button.dataset.type;
    if (draft.type === ORDER_TYPE.SPOT && previous !== ORDER_TYPE.SPOT) draft.handoff = "";
    if (draft.type === ORDER_TYPE.NORMAL) draft.handoff = "";
    renderDraft();
  }));
  document.querySelectorAll("[data-handoff]").forEach((button) => button.addEventListener("click", () => { draft.handoff = button.dataset.handoff; renderDraft(); }));
  $("backProducts").addEventListener("click", () => { draft.stage = "products"; renderDraft(); });
  $("toInfo").addEventListener("click", () => {
    if (!draft.type) return showError("注文方法を選択してください。");
    if (draft.type === ORDER_TYPE.SPOT && !draft.handoff) return showError("商品の渡し方を選択してください。");
    draft.stage = "info";
    renderDraft();
  });
}

function renderInfoStep() {
  const draft = state.draft;
  const normal = draft.type === ORDER_TYPE.NORMAL;
  const now = draft.handoff === HANDOFF.NOW;
  $("stepLabel").textContent = "3 / 3　入力・確認";
  $("sheetTitle").textContent = normal ? "通常注文を受ける" : "現売りを入力";
  const knownAccount = draft.accountChoice || (state.accounts.includes(draft.account) ? draft.account : draft.account ? "その他" : "");
  draft.accountChoice = knownAccount;
  if (knownAccount === "その他" && !draft.accountOther) draft.accountOther = draft.account;
  const accountOptions = state.accounts.map((name) => `<option value="${escapeHtml(name)}" ${knownAccount === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const normalFields = `
    <div class="field"><label for="fAccount">卸屋・帳合先 *</label><select id="fAccount"><option value="">選択してください</option>${accountOptions}<option value="その他" ${knownAccount === "その他" ? "selected" : ""}>その他</option></select></div>
    ${knownAccount === "その他" ? `<div class="field"><label for="fAccountOther">卸屋・帳合先名 *</label><input id="fAccountOther" value="${escapeHtml(draft.accountOther)}" placeholder="具体名を入力"></div>` : ""}
    <div class="field"><label for="fStaff">受注担当者 *</label><input id="fStaff" value="${escapeHtml(draft.staff)}" readonly></div>
    <div class="field"><label for="fCustomer">お客様名（任意）</label><input id="fCustomer" value="${escapeHtml(draft.customer)}" autocomplete="name"></div>`;
  const paymentFields = !now ? `
    <div class="field"><label>会計状況</label><div class="seg"><button type="button" id="payDone" class="${draft.paid ? "on" : ""}">会計済み</button><button type="button" id="payLater" class="${!draft.paid ? "on" : ""}">${draft.handoff === HANDOFF.LATER ? "受取時に会計" : "未会計"}</button></div></div>` : "";
  const pickupFields = draft.handoff === HANDOFF.LATER ? `
    <div class="field"><label for="fPickup">受取予定日 *</label><div class="quickDates"><button type="button" data-day="1" class="${draft.pickupDate === dateOffset(1) ? "on" : ""}">明日</button><button type="button" data-day="2" class="${draft.pickupDate === dateOffset(2) ? "on" : ""}">明後日</button></div><input id="fPickup" type="date" min="${dateOffset(1)}" value="${escapeHtml(draft.pickupDate)}"></div>` : "";
  const destinationFields = draft.handoff === HANDOFF.HOTEL ? `
    <div class="field"><label for="fHotel">ホテル名 *</label><input id="fHotel" value="${escapeHtml(draft.hotelName)}"></div>
    <div class="two"><div class="field"><label for="fGuest">宿泊者名 *</label><input id="fGuest" value="${escapeHtml(draft.guestName || draft.customer)}"></div><div class="field"><label for="fRoom">部屋番号（任意）</label><input id="fRoom" value="${escapeHtml(draft.roomNo)}"></div></div>
    <div class="field"><label for="fCheckout">チェックアウト予定日</label><input id="fCheckout" type="date" value="${escapeHtml(draft.checkoutDate)}"></div>`
    : draft.handoff === HANDOFF.SHIP ? `<div class="field"><label for="fShip">配送先住所 *</label><textarea id="fShip">${escapeHtml(draft.shipAddress)}</textarea></div>` : "";
  const spotFields = `
    <div class="field"><label for="fCustomer">お客様名 *</label><input id="fCustomer" value="${escapeHtml(draft.customer)}" autocomplete="name"></div>
    <div class="two"><div class="field"><label for="fRegion">お客様</label><select id="fRegion"><option value="domestic" ${draft.customerRegion === "domestic" ? "selected" : ""}>国内</option><option value="overseas" ${draft.customerRegion === "overseas" ? "selected" : ""}>海外</option></select></div><div class="field"><label for="fPayment">会計方法 *</label><select id="fPayment"><option value="credit" ${draft.paymentMethod === PAYMENT.CREDIT ? "selected" : ""}>クレジット</option><option value="cash" ${draft.paymentMethod === PAYMENT.CASH ? "selected" : ""}>現金</option></select></div></div>
    ${paymentFields}${pickupFields}${destinationFields}`;
  const itemSummary = draft.items.map((item) => `<div class="summaryRow"><span>${escapeHtml(item.code)} ${escapeHtml(item.name)} × ${item.qty}</span><b>${normal ? `${item.qty}点` : yen(item.price * item.qty)}</b></div>`).join("");
  $("sheetBody").innerHTML = `
    <div class="step">
      <div class="section">
        <div class="field"><label for="fStore">店舗名 *</label><input id="fStore" value="${escapeHtml(draft.store)}" placeholder="〇〇眼鏡店" autocomplete="organization"></div>
        <div class="field"><label for="fPhone">電話番号 *</label><input id="fPhone" inputmode="tel" autocomplete="tel" value="${escapeHtml(draft.phone)}"><div id="phoneWarning" class="fieldWarning ${phoneHasUnexpectedCharacters(draft.phone) ? "" : "hidden"}">数字、+、-、空白、括弧以外が含まれています。入力内容を確認してください。</div></div>
        ${normal ? normalFields : spotFields}
        <div class="field"><label for="fNotes">備考（任意）</label><textarea id="fNotes" placeholder="納期・連絡事項など">${escapeHtml(draft.notes)}</textarea></div>
      </div>
      <div class="section"><div class="sectionTitle">注文確認</div>${itemSummary}<div class="summaryRow total"><span>合計</span><b>${normal ? `${totalQuantity(draft.items)}点` : yen(totalPrice(draft.items))}</b></div></div>
      <div class="hintBox sendHint">入力内容は保存せず、このまま注文書プレビューを作成します。</div>
      ${draft.paymentMethod === PAYMENT.CASH ? '<div class="hintBox topGap">現金は受取金額を確認してください。</div>' : ""}
    </div>
    <div class="stickyActions"><button id="backType" class="secondary" type="button">戻る</button><button id="previewOrder" class="primary" type="button">PDF・印刷へ</button></div>`;
  bindInfoStep(normal, now);
}

function rememberInfo(normal) {
  const draft = state.draft;
  draft.store = $("fStore").value.trim();
  draft.phone = $("fPhone").value.trim();
  draft.customer = $("fCustomer")?.value.trim() || "";
  draft.notes = $("fNotes").value.trim();
  if (normal) {
    draft.accountChoice = $("fAccount").value;
    draft.accountOther = $("fAccountOther")?.value.trim() || "";
    draft.account = draft.accountChoice === "その他" ? draft.accountOther : draft.accountChoice;
    draft.staff = state.profile.display_name;
  } else {
    draft.customerRegion = $("fRegion").value;
    draft.paymentMethod = $("fPayment").value;
    if ($("fPickup")) draft.pickupDate = $("fPickup").value;
    if ($("fHotel")) draft.hotelName = $("fHotel").value.trim();
    if ($("fGuest")) draft.guestName = $("fGuest").value.trim();
    if ($("fRoom")) draft.roomNo = $("fRoom").value.trim();
    if ($("fCheckout")) draft.checkoutDate = $("fCheckout").value;
    if ($("fShip")) draft.shipAddress = $("fShip").value.trim();
  }
}

function bindInfoStep(normal, now) {
  document.querySelectorAll("#sheetBody input,#sheetBody select,#sheetBody textarea").forEach((element) => element.addEventListener("change", () => { rememberInfo(normal); clearError(); }));
  $("fPhone").addEventListener("input", () => {
    rememberInfo(normal);
    $("phoneWarning").classList.toggle("hidden", !phoneHasUnexpectedCharacters($("fPhone").value));
  });
  if ($("fAccount")) $("fAccount").addEventListener("change", () => { rememberInfo(normal); renderDraft(); });
  if ($("payDone")) $("payDone").addEventListener("click", () => { rememberInfo(normal); state.draft.paid = true; renderDraft(); });
  if ($("payLater")) $("payLater").addEventListener("click", () => { rememberInfo(normal); state.draft.paid = false; renderDraft(); });
  document.querySelectorAll("[data-day]").forEach((button) => button.addEventListener("click", () => { rememberInfo(normal); state.draft.pickupDate = dateOffset(Number(button.dataset.day)); renderDraft(); }));
  $("backType").addEventListener("click", () => { rememberInfo(normal); state.draft.stage = "type"; renderDraft(); });
  $("previewOrder").addEventListener("click", () => {
    rememberInfo(normal);
    if (now) state.draft.paid = true;
    const error = validateDraft(state.draft);
    if (error) return showError(error);
    state.createdAt = new Date();
    renderReceipt();
    closeSheet();
    $("appView").classList.add("hidden");
    $("receiptView").classList.remove("hidden");
    window.scrollTo({ top: 0 });
  });
}

function receiptInfo(label, value) {
  return `<div class="receiptInfoCard"><div class="receiptInfoLabel">${escapeHtml(label)}</div><div class="receiptInfoValue">${escapeHtml(value || "-")}</div></div>`;
}

function deliveryNotes(draft) {
  const lines = [];
  if (draft.handoff === HANDOFF.LATER) lines.push(`受取予定日：${draft.pickupDate}`);
  if (draft.handoff === HANDOFF.HOTEL) {
    lines.push(`ホテル：${draft.hotelName}`);
    lines.push(`宿泊者：${draft.guestName}${draft.roomNo ? `／部屋 ${draft.roomNo}` : ""}`);
    if (draft.checkoutDate) lines.push(`チェックアウト予定日：${draft.checkoutDate}`);
  }
  if (draft.handoff === HANDOFF.SHIP) lines.push(`配送先：${draft.shipAddress}`);
  if (draft.notes) lines.push(draft.notes);
  return lines.join("\n");
}

function renderReceipt() {
  const draft = state.draft;
  const spot = draft.type === ORDER_TYPE.SPOT;
  const date = state.createdAt || new Date();
  const info = spot ? [
    ["店舗名", draft.store], ["電話番号", draft.phone], ["お客様名", draft.customer],
    ["注文区分", orderTypeLabel(draft.type)], ["商品の渡し方", handoffLabel(draft.handoff)],
    ["会計方法", paymentLabel(draft.paymentMethod)], ["会計状況", draft.paid ? "会計済み" : "未会計"],
    ["受注担当", draft.staff],
  ] : [
    ["店舗名", draft.store], ["電話番号", draft.phone], ["お客様名", draft.customer || "-"],
    ["注文区分", orderTypeLabel(draft.type)], ["卸屋・帳合先", draft.account], ["受注担当", draft.staff],
  ];
  const rows = draft.items.map((item) => `
    <tr><td><b>${escapeHtml(item.code)}</b></td><td>${escapeHtml(item.name)}</td><td class="num">${item.qty}</td>${spot ? `<td class="num">${yen(item.price)}</td><td class="num"><b>${yen(item.price * item.qty)}</b></td>` : ""}</tr>`).join("");
  const notes = deliveryNotes(draft);
  $("receiptCard").innerHTML = `
    <div class="receiptHeaderSimple">
      <div class="receiptBrandBlock">
        <img class="receiptBrandLogo" src="./assets/sun_nishimura_logo.jpg" alt="株式会社サンニシムラ">
        <div><div class="receiptBrandName">株式会社サンニシムラ</div><div class="receiptBrandSub">SAN NISHIMURA CO., LTD.<br>${escapeHtml(state.settings.eventName || "展示会")}</div></div>
      </div>
      <div class="receiptDocMeta"><div class="receiptDocTitle">展示会 注文書</div><div class="receiptDocSub">Exhibition Order Receipt</div><div class="receiptTypeBadge ${spot ? "spot" : ""}">${escapeHtml(orderTypeLabel(draft.type))}</div><div class="receiptMetaLine"><b>作成日</b> ${escapeHtml(formatDate(date))}<br><b>受付時刻</b> ${escapeHtml(formatTime(date))}</div></div>
    </div>
    <div class="receiptInfoBand">${info.map(([label, value]) => receiptInfo(label, value)).join("")}</div>
    <div class="receiptSection"><div class="receiptSectionHead"><div class="receiptSectionTitle">注文明細</div><div class="receiptSectionHint">${totalQuantity(draft.items)}点</div></div>
      <table class="receiptTable ${spot ? "spot" : "normal"}">
        ${spot ? '<colgroup><col class="code"><col><col class="qty"><col class="unit"><col class="subtotal"></colgroup>' : '<colgroup><col class="code"><col><col class="qty"></colgroup>'}
        <thead><tr><th>品番</th><th>商品名</th><th class="num">数量</th>${spot ? '<th class="num">単価</th><th class="num">金額</th>' : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="receiptFooterGrid">
      <div class="receiptNote"><b>備考</b>${notes ? escapeHtml(notes).replace(/\n/g, "<br>") : '<div class="receiptBlankLines"></div>'}</div>
      <div><div class="receiptSummaryBox"><div class="receiptSummaryRow"><span>点数</span><span>${totalQuantity(draft.items)}</span></div>${spot ? `<div class="receiptSummaryRow total"><span>合計</span><span>${yen(totalPrice(draft.items))}</span></div>` : ""}</div>${spot ? '<div class="receiptCurrencyNote">通貨：JPY</div>' : ""}</div>
    </div>
    <div class="receiptFooterMini"><span>株式会社サンニシムラ</span><span>${escapeHtml(state.settings.eventName || "展示会")}・${escapeHtml(orderTypeLabel(draft.type))}</span></div>`;
}

function bindStaticEvents() {
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabase) return;
    $("loginButton").disabled = true;
    $("loginMessage").textContent = "ログインしています…";
    const { error } = await supabase.auth.signInWithPassword({
      email: $("loginEmail").value.trim(), password: $("loginPassword").value,
    });
    if (error) {
      $("loginMessage").textContent = "メールまたはパスワードを確認してください。";
      $("loginButton").disabled = false;
    }
  });
  $("logoutButton").addEventListener("click", async () => {
    closeSheet();
    if (isLocalDemo) return showLogin("ローカル確認モードを終了しました。");
    await supabase.auth.signOut();
  });
  $("newOrderButton").addEventListener("click", startNewOrder);
  $("startNextOrderButton").addEventListener("click", startNewOrder);
  $("closeSheetButton").addEventListener("click", closeSheet);
  $("backToEditButton").addEventListener("click", () => {
    $("receiptView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    state.draft.stage = "info";
    openSheet();
    renderDraft();
  });
  $("printButton").addEventListener("click", () => window.print());
  window.addEventListener("afterprint", () => {
    if (!$("receiptView").classList.contains("hidden")) {
      clearCurrentOrder();
      $("receiptCard").classList.add("hidden");
      $("printPrivacyNotice").classList.add("hidden");
      $("receiptActions").classList.add("hidden");
      $("printedActions").classList.remove("hidden");
    }
  });
  $("settingsButton").addEventListener("click", () => {
    $("eventNameInput").value = state.settings.eventName || "";
    $("settingsDialog").showModal();
  });
  $("settingsCloseButton").addEventListener("click", () => $("settingsDialog").close());
  $("settingsForm").addEventListener("submit", () => {
    state.settings.eventName = $("eventNameInput").value.trim();
    saveSettings();
    $("eventName").textContent = state.settings.eventName || "EXHIBITION";
    toast("端末設定を保存しました");
  });
}

boot();
