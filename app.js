import { createClient } from "@supabase/supabase-js";
import logoUrl from "./assets/sun_nishimura_logo.jpg";
import { clearOrderData } from "./order-privacy.js";
import { MAX_PHOTOS, createAttachmentStore, preparePhoto } from "./order-attachments.js";
import {
  SYNC_EVENT_NAME,
  orderFromRow,
  orderLabel,
  orderMatches,
  orderNumber,
  payloadForOrder,
} from "./order-sync.js";
import {
  ORDER_TYPE,
  HANDOFF,
  PAYMENT,
  paymentLabel,
  isPickupOrder,
  isOrderConfirmed,
  confirmationError,
  confirmOrder,
  prepareOrder,
  needsSlackShare,
  workflowStatus,
  setSlackShared,
  pickupNumber,
  isShipping,
  withShipping,
  compactKey,
  phoneHasUnexpectedCharacters,
  syntaxKey,
  totalPrice,
  totalQuantity,
  validateDraft,
} from "./order-domain.js";

const $ = (id) => document.getElementById(id);
const attachmentStore = createAttachmentStore();
let attachmentBusy = false;
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
      storageKey: "exhibitionSimple.auth.v1",
      storage: window.localStorage,
    },
  })
  : null;

const state = {
  session: null,
  profile: null,
  products: [],
  accounts: [],
  orders: [],
  draft: null,
  createdAt: null,
  authUserId: "",
  syncTimer: null,
  orderChannel: null,
  saving: false,
  syncInFlight: null,
  dataEpoch: 0,
};

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
  $("connectionView").classList.add("hidden");
  state.dataEpoch++;
  clearCurrentOrder();
  clearInterval(state.syncTimer);
  if (state.orderChannel && supabase) supabase.removeChannel(state.orderChannel);
  state.syncTimer = null;
  state.orderChannel = null;
  state.authUserId = "";
  state.session = null;
  state.profile = null;
  state.products = [];
  state.accounts = [];
  state.orders = [];
  $("orderHistory").replaceChildren();
  $("orderSearch").value = "";
  document.body.style.overflow = "";
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

function newUuid() {
  return crypto.randomUUID();
}

function permanentReceipt(id) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" })
    .format(new Date()).replaceAll("-", "");
  return `受付-${day}-${id.slice(0, 8).toUpperCase()}`;
}

async function fetchOrders() {
  const epoch = state.dataEpoch;
  const rows = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("exhibition_app_orders")
      .select("id,payload,created_at,updated_at,simple_pickup_number")
      .eq("event_name", SYNC_EVENT_NAME)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  if (epoch !== state.dataEpoch || !state.session) return;
  state.orders = rows.map(orderFromRow);
  renderHistory();
  setSyncStatus("online", `保存済み・同期完了 ${formatTime(new Date())}`);
}

function setSyncStatus(mode, message) {
  const dot = $("syncDot");
  if (dot) dot.className = `syncDot ${mode}`;
  if ($("syncStatus")) $("syncStatus").textContent = message;
}

async function syncOrders({ quiet = false } = {}) {
  if (!supabase || !state.session || isLocalDemo) return;
  if (state.syncInFlight) return state.syncInFlight;
  if (!quiet) setSyncStatus("busy", "注文を同期しています…");
  state.syncInFlight = fetchOrders().catch((error) => {
    console.error(error);
    setSyncStatus("error", "同期できません。通信を確認してください");
    if (!quiet) toast("注文を同期できませんでした");
  }).finally(() => { state.syncInFlight = null; });
  return state.syncInFlight;
}

function beginOrderSync() {
  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => {
    if (document.visibilityState === "visible") syncOrders({ quiet: true });
  }, 10000);
  if (state.orderChannel) supabase.removeChannel(state.orderChannel);
  state.orderChannel = supabase
    .channel(`simple-orders-${state.authUserId}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "exhibition_app_orders",
      filter: `event_name=eq.${SYNC_EVENT_NAME}`,
    }, () => syncOrders({ quiet: true }))
    .subscribe();
}

async function saveDraftToCloud() {
  if (state.saving) return null;
  state.saving = true;
  setSyncStatus("busy", state.draft.editingId ? "変更を保存しています…" : "注文を保存しています…");
  try {
    const draft = state.draft;
    if (!draft.localId) draft.localId = newUuid();
    if (draft.handoff === HANDOFF.LATER && !draft.receiptNo) draft.receiptNo = permanentReceipt(draft.localId);
    const payload = payloadForOrder(draft);
    let result;
    if (draft.editingId) {
      const { data, error } = await supabase
        .from("exhibition_app_orders")
        .update({ payload })
        .eq("id", draft.editingId)
        .eq("event_name", SYNC_EVENT_NAME)
        .eq("updated_at", draft.cloudUpdatedAt)
        .is("deleted_at", null)
        .select("id,payload,created_at,updated_at,simple_pickup_number")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        await syncOrders({ quiet: true });
        throw new Error("SYNC_CONFLICT");
      }
      result = orderFromRow(data);
    } else {
      const { data, error } = await supabase
        .from("exhibition_app_orders")
        .insert({ id: draft.localId, event_name: SYNC_EVENT_NAME, payload })
        .select("id,payload,created_at,updated_at,simple_pickup_number")
        .single();
      if (error && error.code !== "23505") throw error;
      if (error) {
        const existing = await supabase.from("exhibition_app_orders")
          .select("id,payload,created_at,updated_at,simple_pickup_number")
          .eq("id", draft.localId).eq("event_name", SYNC_EVENT_NAME)
          .is("deleted_at", null).single();
        if (existing.error) throw existing.error;
        const savedPayload = payloadForOrder(orderFromRow(existing.data));
        if (JSON.stringify(savedPayload) !== JSON.stringify(payload)) throw new Error("SYNC_CONFLICT");
        result = orderFromRow(existing.data);
      } else result = orderFromRow(data);
    }
    state.dataEpoch++;
    state.orders = [result, ...state.orders.filter((order) => order.localId !== result.localId)];
    state.draft = { ...result, editingId: result.localId, stage: "info" };
    state.createdAt = new Date(result.createdAt);
    renderHistory();
    setSyncStatus("online", `保存済み・同期完了 ${formatTime(new Date())}`);
    return state.draft;
  } finally {
    state.saving = false;
  }
}

function renderHistory() {
  const container = $("orderHistory");
  if (!container) return;
  const query = $("orderSearch")?.value || "";
  const list = state.orders.filter((order) => orderMatches(order, query));
  $("orderCount").textContent = `${state.orders.length}件`;
  container.innerHTML = list.length ? list.map((order) => `
    <article class="orderCard">
      <div class="orderCardTop">
        <div><small>${escapeHtml(orderNumber(order))}</small><h3>${escapeHtml(order.store || "店舗名なし")}</h3></div>
        <b>${yen(totalPrice(order.items))}</b>
      </div>
      <div class="orderCardMeta">${escapeHtml(orderLabel(order))}・${totalQuantity(order.items)}点${order.customer ? `・${escapeHtml(order.customer)}` : ""}</div>
      ${pickupNumber(order) ? `<div class="pickupBadge">お渡し番号 <b>${escapeHtml(pickupNumber(order))}</b></div>` : ""}
      ${needsSlackShare(order) ? `<div class="orderCardMeta ${isOrderConfirmed(order) ? "" : "orderPending"}">${escapeHtml(statusLabel(order))} ／ ${order.slackShared ? "Slack共有済み" : "Slack未共有"}</div>` : ""}
      <div class="orderCardBottom"><span>${escapeHtml(formatDateTime(order.updatedAt || order.createdAt))}</span><button type="button" class="secondary compact" data-open-order="${escapeHtml(order.localId)}">${needsSlackShare(order) && !isOrderConfirmed(order) ? "共有・確定を続ける" : "変更・印刷"}</button></div>
    </article>`).join("") : '<div class="historyEmpty">保存済み注文はありません。</div>';
  container.querySelectorAll("[data-open-order]").forEach((button) => button.addEventListener("click", () => {
    const order = state.orders.find((item) => item.localId === button.dataset.openOrder);
    if (order) openSavedOrder(order);
  }));
}

function formatDateTime(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function openSavedOrder(order) {
  state.draft = {
    ...order,
    items: (order.items || []).map((item) => ({ ...item })),
    editingId: order.localId,
    stage: "info",
    productQuery: "",
    keypadMode: "number",
  };
  state.createdAt = new Date(order.createdAt || Date.now());
  renderReceipt();
  closeSheet();
  $("appView").classList.add("hidden");
  $("receiptView").classList.remove("hidden");
  $("receiptActions").classList.remove("hidden");
  $("printedActions").classList.remove("hidden");
  window.scrollTo({ top: 0 });
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
    if (!profile) throw new Error("STAFF_DISABLED");
    const [products, accounts] = await Promise.all([fetchAllProducts(), fetchAccountOptions()]);
    state.session = session;
    state.profile = profile;
    state.products = products;
    state.accounts = accounts;
    await fetchOrders();
    showApp();
    beginOrderSync();
  } catch (error) {
    console.error(error);
    state.authUserId = "";
    if (error.message === "STAFF_DISABLED") {
      await supabase.auth.signOut({ scope: "local" });
      showLogin("このアカウントには有効なスタッフ権限がありません。");
    } else showConnectionRetry();
  }
}

function showConnectionRetry() {
  $("loginView").classList.add("hidden");
  $("connectionView").classList.remove("hidden");
  $("connectionMessage").textContent = "接続できませんでした。ログイン情報は保持しています。通信を確認して再接続してください。";
  $("retryConnection").disabled = false;
}

async function restoreSession() {
  $("loginView").classList.add("hidden");
  $("connectionView").classList.remove("hidden");
  $("connectionMessage").textContent = "ログイン状態を確認しています…";
  $("retryConnection").disabled = true;
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (session) await openForSession(session);
    else showLogin();
  } catch (error) {
    console.error(error);
    showConnectionRetry();
  }
}

function showApp() {
  $("connectionView").classList.add("hidden");
  $("loginPassword").value = "";
  $("loginView").classList.add("hidden");
  $("receiptView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("staffName").textContent = `${state.profile.display_name} ／ 商品 ${state.products.length.toLocaleString("ja-JP")}件`;
  renderHistory();
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
    state.orders = [orderFromRow({ id: "11111111-1111-4111-8111-111111111111", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), payload: { receiptNo: "受付-20260908-DEMO0001", type: ORDER_TYPE.SPOT, handoff: HANDOFF.LATER, store: "サンプル眼鏡店", phone: "06-0000-0000", customer: "西村様", staff: "テスト担当", paymentMethod: PAYMENT.CREDIT, paid: false, pickupDate: dateOffset(1), notes: "動作確認用（保存されません）", items: [{ code: "D001", name: "動作確認商品 A", price: 5200, qty: 1 }] } })];
    showApp();
    return;
  }
  if (!supabase) {
    $("loginButton").disabled = true;
    showLogin("Supabaseの公開接続設定がありません。VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。");
    return;
  }
  supabase.auth.onAuthStateChange((event, nextSession) => {
    // Run database requests after the Auth callback releases its storage lock.
    setTimeout(() => {
      if (event === "SIGNED_OUT") showLogin();
      else if (nextSession) {
        state.session = nextSession;
        if (event === "SIGNED_IN") openForSession(nextSession);
      }
    }, 0);
  });
  await restoreSession();
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
    editingId: "",
    cloudUpdatedAt: "",
    localId: "",
    receiptNo: "",
  };
}

function clearCurrentOrder() {
  attachmentStore.clear();
  clearOrderData(state, [$("sheetBody"), $("receiptCard"), $("receiptOperations"), $("sheetError")]);
}

function startNewOrder() {
  if (state.saving) return;
  if (state.draft?.editingId && needsSlackShare(state.draft) && !isOrderConfirmed(state.draft)
      && !$("receiptView").classList.contains("hidden")) {
    toast("Slack共有と注文確定を済ませてください。中断する場合は「一時保存して一覧へ」を押してください。");
    return;
  }
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

function showHistory() {
  closeSheet();
  state.draft = null;
  state.createdAt = null;
  $("receiptView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  renderHistory();
  window.scrollTo({ top: 0 });
}

function openSheet() {
  $("sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  clearError();
}

function closeSheet() {
  if (state.saving) return;
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
  if (!syntax) return [];
  const exact = resolveProducts(query);
  const seen = new Set(exact.map((product) => product.code));
  const nameQuery = query.normalize("NFKC").trim().toLowerCase();
  const prefix = state.products.filter((product) => !seen.has(product.code)
    && (product.syntax.startsWith(syntax) || (compact && product.compact.startsWith(compact))
      || product.name.normalize("NFKC").toLowerCase().includes(nameQuery)));
  return [...exact, ...prefix].slice(0, limit);
}

function addProduct(product, { keepSearch = false } = {}) {
  const existing = state.draft.items.find((item) => item.code === product.code);
  if (existing) existing.qty = Math.min(999, existing.qty + 1);
  else state.draft.items.push({ code: product.code, name: product.name, price: product.price, qty: 1 });
  // Candidate taps keep the existing DOM and focus so variants can be added
  // consecutively without moving the list or reopening the mobile keyboard.
  if (!keepSearch) {
    state.draft.productQuery = "";
    $("productQ").value = "";
    renderProductResults("");
  }
  renderCart();
  toast(existing ? `No.${product.code} の数量を ${existing.qty} にしました` : `No.${product.code} を追加しました`);
  if (!keepSearch) focusProductInput($("productQ"));
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
          <input id="productQ" type="search" inputmode="search" placeholder="品番・商品名で検索" aria-label="品番・商品名">
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
  $("clearPQ").addEventListener("click", () => { query.value = ""; draft.productQuery = ""; renderProductResults(""); focusProductInput(query); });
  $("toType").addEventListener("click", () => {
    if (!draft.items.some((item) => !isShipping(item))) return showError("商品を1点以上追加してください。");
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
      + '<div class="keypadUtility"><button type="button" class="keypadKey" data-key="mode">数字／英字</button><button type="button" class="keypadKey" data-key="clear">クリア</button><button type="button" class="keypadKey addKey" data-key="add">追加</button></div><button type="button" class="keypadKey shippingKey" data-key="shipping">＋ 送料500円</button>';
    modeButton.textContent = draft.keypadMode === "alpha" ? "英字・記号" : "数字・記号";
    wrap.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => {
      query.blur();
      const key = button.dataset.key;
      if (key === "shipping") {
        const alreadyAdded = draft.items.some(isShipping);
        draft.items = withShipping(draft.items);
        renderCart();
        toast(alreadyAdded ? "送料500円は追加済みです" : "送料500円を追加しました");
        return;
      }
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
      <span><span class="productCodeLine"><b>No.${escapeHtml(product.code)}</b>${exactCodes.has(product.code) ? '<em class="matchBadge">一致</em>' : ""}</span><small>${escapeHtml(product.name)}</small><span class="productPrice">卸単価 ${yen(product.price)}</span></span>
      <span class="addBtn">追加</span>
    </button>`).join("") : '<div class="empty">該当する品番がありません。</div>';
  wrap.classList.add("open");
  wrap.querySelectorAll("[data-product-code]").forEach((button) => button.addEventListener("click", () => {
    const product = state.products.find((row) => row.code === button.dataset.productCode);
    if (product) addProduct(product, { keepSearch: true });
  }));
}

function renderCart() {
  const draft = state.draft;
  const wrap = $("cartLines");
  $("cartCount").textContent = `${totalQuantity(draft.items)}点`;
  $("toType").disabled = !draft.items.some((item) => !isShipping(item));
  if (!draft.items.length) {
    wrap.innerHTML = '<div class="empty compactEmpty">商品はまだありません。</div>';
    return;
  }
  wrap.innerHTML = draft.items.map((item, index) => `
    <div class="cartLine" data-item-index="${index}">
      <div><b>${isShipping(item) ? "送料" : `No.${escapeHtml(item.code)}`}</b><small>${escapeHtml(item.name)}</small></div>
      <div class="qty">
        ${isShipping(item) ? '<span class="shippingAmount">¥500（一律）</span>' : `
        <button type="button" data-qty-action="minus" aria-label="数量を減らす">−</button>
        <input type="number" min="1" max="999" inputmode="numeric" value="${item.qty}" data-qty-action="input" aria-label="数量">
        <button type="button" data-qty-action="plus" aria-label="数量を増やす">＋</button>`}
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
            <button class="choice ${draft.handoff === HANDOFF.HOTEL ? "on" : ""}" type="button" data-handoff="hotel"><b>3　ホテルへ配送</b><small>ホテル名・宿泊者情報は任意です（別紙記入可）。</small></button>
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
  document.querySelectorAll("[data-handoff]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.handoff === HANDOFF.LATER && draft.handoff !== HANDOFF.LATER) {
      draft.delivered = false;
      draft.deliveredAt = "";
    }
    draft.handoff = button.dataset.handoff;
    renderDraft();
  }));
  $("backProducts").addEventListener("click", () => { draft.stage = "products"; renderDraft(); });
  $("toInfo").addEventListener("click", () => {
    if (!draft.type) return showError("注文方法を選択してください。");
    if (draft.type === ORDER_TYPE.SPOT && !draft.handoff) return showError("商品の渡し方を選択してください。");
    draft.stage = "info";
    renderDraft();
  });
}

function statusLabel(order) {
  if (needsSlackShare(order) && !isOrderConfirmed(order)) return order.slackShared ? "未確定・確定待ち" : "未確定・Slack共有待ち";
  return { active: "要対応", waiting: "受け取り待ち", done: "完了" }[workflowStatus(order)];
}

function preparationLabel(order) {
  if (!needsSlackShare(order)) return "PDF・印刷へ";
  if (order.editingId && isOrderConfirmed(order)) return "変更を保存・確認へ";
  return isPickupOrder(order) && !pickupNumber(order) ? "① お渡し番号を発行" : "① 共有用の控えを作成";
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
    <div class="field"><label>会計状況</label><div class="seg"><button type="button" id="payDone" class="${draft.paid ? "on" : ""}">会計済</button><button type="button" id="payLater" class="${!draft.paid ? "on" : ""}">${draft.handoff === HANDOFF.LATER ? "受取時に会計" : "未会計"}</button></div></div>` : "";
  const pickupFields = draft.handoff === HANDOFF.LATER ? `
    <div class="field"><label for="fPickup">受取予定日 *</label><div class="quickDates"><button type="button" data-day="1" class="${draft.pickupDate === dateOffset(1) ? "on" : ""}">明日</button><button type="button" data-day="2" class="${draft.pickupDate === dateOffset(2) ? "on" : ""}">明後日</button></div><input id="fPickup" type="date" min="${dateOffset(1)}" value="${escapeHtml(draft.pickupDate)}"></div>` : "";
  const destinationFields = draft.handoff === HANDOFF.HOTEL ? `
    <div class="hintBox">ホテル・宿泊情報は別紙への記入でも構いません。以下は空欄で進めます。</div>
    <div class="field"><label for="fHotel">ホテル名（任意）</label><input id="fHotel" value="${escapeHtml(draft.hotelName)}"></div>
    <div class="two"><div class="field"><label for="fGuest">宿泊者名（任意）</label><input id="fGuest" value="${escapeHtml(draft.guestName)}"></div><div class="field"><label for="fRoom">部屋番号（任意）</label><input id="fRoom" value="${escapeHtml(draft.roomNo)}"></div></div>
    <div class="field"><label for="fCheckout">チェックアウト予定日</label><input id="fCheckout" type="date" value="${escapeHtml(draft.checkoutDate)}"></div>`
    : draft.handoff === HANDOFF.SHIP ? `<div class="field"><label for="fShip">配送先住所 *</label><textarea id="fShip">${escapeHtml(draft.shipAddress)}</textarea></div>` : "";
  const spotFields = `
    <div class="field"><label for="fCustomer">お客様名 *</label><input id="fCustomer" value="${escapeHtml(draft.customer)}" autocomplete="name"></div>
    <div class="two"><div class="field"><label for="fRegion">お客様</label><select id="fRegion"><option value="domestic" ${draft.customerRegion === "domestic" ? "selected" : ""}>国内</option><option value="overseas" ${draft.customerRegion === "overseas" ? "selected" : ""}>海外</option></select></div><div class="field"><label for="fPayment">会計方法 *</label><select id="fPayment"><option value="credit" ${draft.paymentMethod === PAYMENT.CREDIT ? "selected" : ""}>クレジット</option><option value="cash" ${draft.paymentMethod === PAYMENT.CASH ? "selected" : ""}>現金</option></select></div></div>
    ${paymentFields}${pickupFields}${destinationFields}`;
  const itemSummary = draft.items.map((item) => `<div class="summaryRow"><span>${isShipping(item) ? "送料（一律）" : `${escapeHtml(item.code)} ${escapeHtml(item.name)} × ${item.qty}`}</span><b>${normal && !isShipping(item) ? `${item.qty}点` : yen(item.price * item.qty)}</b></div>`).join("");
  $("sheetBody").innerHTML = `
    <div class="step">
      <div class="section">
        <div class="field"><label for="fStore">店舗名 *</label><input id="fStore" value="${escapeHtml(draft.store)}" placeholder="〇〇眼鏡店" autocomplete="organization"></div>
        <div class="field"><label for="fPhone">電話番号 *</label><input id="fPhone" inputmode="tel" autocomplete="tel" value="${escapeHtml(draft.phone)}"><div id="phoneWarning" class="fieldWarning ${phoneHasUnexpectedCharacters(draft.phone) ? "" : "hidden"}">数字、+、-、空白、括弧以外が含まれています。入力内容を確認してください。</div></div>
        ${normal ? normalFields : spotFields}
        <div class="field"><label for="fNotes">備考（任意）</label><textarea id="fNotes" placeholder="納期・連絡事項など">${escapeHtml(draft.notes)}</textarea></div>
      </div>
      <div class="section"><div class="sectionTitle">注文確認</div>${itemSummary}<div class="summaryRow total"><span>合計</span><b>${normal ? `${totalQuantity(draft.items)}点` : yen(totalPrice(draft.items))}</b></div></div>
      ${isPickupOrder(draft) ? `<div class="pickupBadge">お渡し番号 <b>${escapeHtml(pickupNumber(draft) || "下のボタンで発行")}</b></div>${draft.editingId && isOrderConfirmed(draft) ? `<div class="field"><label>お渡し状況</label><div class="seg"><button type="button" id="notDelivered" class="${!draft.delivered ? "on" : ""}">未お渡し</button><button type="button" id="markDelivered" class="${draft.delivered ? "on" : ""}">お渡し済み</button></div></div>` : ""}` : ""}
      <div class="hintBox sendHint">${needsSlackShare(draft) ? `① ${isPickupOrder(draft) ? "お渡し番号を発行" : "共有用の控えを作成"} → ② Slackに共有 → ③ 注文を確定<br>まず一時保存します。Slack共有前には確定されません。${draft.editingId ? "内容を変更した場合は、再度共有してください。発行済みのお渡し番号は変わりません。" : ""}` : "注文を共有履歴へ保存してから、注文書プレビューを開きます。"}</div>
      ${draft.paymentMethod === PAYMENT.CASH ? '<div class="hintBox topGap">現金は受取金額を確認してください。</div>' : ""}
    </div>
    <div class="stickyActions"><button id="backType" class="secondary" type="button">戻る</button><button id="previewOrder" class="primary" type="button">${preparationLabel(draft)}</button></div>`;
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
    draft.staff = draft.staff || state.profile.display_name;
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
  if ($("markDelivered")) $("markDelivered").addEventListener("click", () => { rememberInfo(normal); state.draft.delivered = true; state.draft.deliveredAt ||= new Date().toISOString(); renderDraft(); });
  if ($("notDelivered")) $("notDelivered").addEventListener("click", () => { rememberInfo(normal); state.draft.delivered = false; state.draft.deliveredAt = ""; renderDraft(); });
  document.querySelectorAll("[data-day]").forEach((button) => button.addEventListener("click", () => { rememberInfo(normal); state.draft.pickupDate = dateOffset(Number(button.dataset.day)); renderDraft(); }));
  $("backType").addEventListener("click", () => { rememberInfo(normal); state.draft.stage = "type"; renderDraft(); });
  const saveAndPreview = async () => {
    if (state.saving) return;
    rememberInfo(normal);
    if (now) state.draft.paid = true;
    const error = validateDraft(state.draft);
    if (error) return showError(error);
    state.draft = prepareOrder(state.draft, state.orders.find(order => order.localId === state.draft.editingId));
    const button = $("previewOrder");
    button.disabled = true;
    const controls = [...document.querySelectorAll("#sheet input,#sheet select,#sheet textarea,#sheet button")];
    controls.forEach((control) => { control.disabled = true; });
    button.textContent = "保存中…";
    try {
      await persistCurrentDraft();
      state.createdAt = new Date(state.draft.createdAt || Date.now());
      renderReceipt();
      closeSheet();
      $("appView").classList.add("hidden");
      $("receiptView").classList.remove("hidden");
      $("receiptCard").classList.remove("hidden");
      $("receiptActions").classList.remove("hidden");
      $("printedActions").classList.remove("hidden");
      window.scrollTo({ top: 0 });
    } catch (saveError) {
      console.error(saveError);
      showError(saveError.message === "SYNC_CONFLICT" ? "別の端末で先に変更されました。注文一覧から開き直してください。" : "注文を保存できませんでした。通信を確認して、もう一度お試しください。");
      setSyncStatus("error", "保存できませんでした。入力内容は保持しています");
      button.disabled = false;
      button.textContent = preparationLabel(state.draft);
    } finally {
      controls.forEach((control) => { control.disabled = false; });
    }
  };
  $("previewOrder").addEventListener("click", () => saveAndPreview());
}

async function persistCurrentDraft() {
  if (!isLocalDemo) return saveDraftToCloud();
  if (!state.draft.localId) state.draft.localId = newUuid();
  if (isPickupOrder(state.draft) && !state.draft.receiptNo) state.draft.receiptNo = permanentReceipt(state.draft.localId);
  const saved = saveLocalDemoDraft();
  state.orders = [saved, ...state.orders.filter(order => order.localId !== saved.localId)];
  state.draft = { ...saved, editingId: saved.localId, stage: "info" };
  renderHistory();
  return state.draft;
}

let demoPickupCounter = 0;
function saveLocalDemoDraft(nowIso = new Date().toISOString()) {
  if (isPickupOrder(state.draft) && !state.draft.pickupNumber) state.draft.pickupNumber = String(++demoPickupCounter);
  return orderFromRow({ id: state.draft.localId, simple_pickup_number: state.draft.pickupNumber || null, payload: payloadForOrder(state.draft), created_at: state.draft.createdAt || nowIso, updated_at: nowIso });
}

async function printReceipt({ sharing = false } = {}) {
  if (attachmentBusy) return toast("写真の読込みが終わるまでお待ちください。");
  if (isPickupOrder(state.draft) && !pickupNumber(state.draft)) {
    toast("お渡し番号を発行するため「戻って修正」から保存してください。");
    return;
  }
  try {
    await Promise.all([...$("receiptCard").querySelectorAll(".receiptBrandLogo")].map(image => image.decode()));
    if (sharing) await Promise.all([...$("receiptCard").querySelectorAll(".shareAttachmentPage img")].map(image => image.decode()));
    await document.fonts.ready;
    document.body.dataset.printCopy = sharing ? "sharing" : "both";
    window.print();
  } catch {
    delete document.body.dataset.printCopy;
    toast("印刷を開始できませんでした。通信とロゴの読込みを確認して再度お試しください。");
  }
}

function receiptInfo(label, value) {
  return `<div class="receiptInfoCard"><div class="receiptInfoLabel">${escapeHtml(label)}</div><div class="receiptInfoValue">${escapeHtml(value || "-")}</div></div>`;
}

function receiptHandoffLabel(order) {
  if (order.customerRegion === "overseas") {
    if (order.type === ORDER_TYPE.NORMAL) return "Processed after the exhibition";
    if (order.handoff === HANDOFF.NOW) return "Pay and collect at the venue";
    if (order.handoff === HANDOFF.LATER) return order.pickupDate ? `Scheduled pickup: ${order.pickupDate}` : "Later pickup";
    if (order.handoff === HANDOFF.HOTEL) return `Hotel delivery${order.hotelName ? ` (${order.hotelName})` : ""}`;
    if (order.handoff === HANDOFF.SHIP) return "Delivery to specified address";
    return "-";
  }
  if (order.type === ORDER_TYPE.NORMAL) return "帰社後にまとめて印刷";
  if (order.handoff === HANDOFF.NOW) return "その場で会計・お渡し";
  if (order.handoff === HANDOFF.LATER) return order.pickupDate ? `${order.pickupDate} 受取予定` : "後日受取";
  if (order.handoff === HANDOFF.HOTEL) return `本社対応・ホテル配送${order.hotelName ? `（${order.hotelName}）` : ""}`;
  if (order.handoff === HANDOFF.SHIP) return "本社対応・指定先配送";
  return "-";
}

function renderReceipt() {
  const draft = state.draft;
  const date = state.createdAt || new Date();
  $("receiptCard").innerHTML = receiptCopyHtml(draft, date, true) + receiptCopyHtml(draft, date, false) + attachmentPagesHtml(draft);
  renderReceiptOperations();
}

function receiptCopyHtml(draft, date, companyCopy) {
  const english = !companyCopy && draft.customerRegion === "overseas";
  const t = (ja, en) => english ? en : ja;
  const copyLabel = companyCopy ? "会社控え" : t("お客様控え", "Customer Copy / お客様控え");
  const handoffOrder = companyCopy ? { ...draft, customerRegion: "domestic" } : draft;
  const company = t("株式会社サンニシムラ", "SAN NISHIMURA CO., LTD.");
  const typeLabel = english ? (draft.type === ORDER_TYPE.NORMAL ? "Standard order" : "On-site sale") : orderLabel(draft);
  const payment = english ? ({ cash: "Cash", credit: "Credit card" })[draft.paymentMethod] || "Not specified" : paymentLabel(draft.paymentMethod);
  const info = [[t("店舗名", "Company / Store"), draft.store], [t("電話番号", "Phone"), draft.phone], [t("お客様名", "Customer"), draft.customer || "-"], [t("注文区分", "Order type"), typeLabel], [t("卸屋・帳合先", "Distributor / Account"), draft.account || "-"], [t("担当", "Staff"), draft.staff || state.profile?.display_name || "-"], [t("受け渡し", "Pickup / Delivery"), receiptHandoffLabel(handoffOrder)]];
  if (draft.type === ORDER_TYPE.SPOT) info.push([t("会計方法", "Payment method"), payment]);
  const rows = draft.items.map((item) => `
    <tr><td><b>${escapeHtml(isShipping(item) ? t(item.code, "Shipping") : item.code)}</b></td><td>${escapeHtml(isShipping(item) ? t(item.name, "Flat-rate shipping") : item.name)}</td><td class="num" data-label="${t("数量", "Qty")}">${item.qty}</td><td class="num" data-label="${t("単価", "Unit price")}">${yen(item.price)}</td><td class="num"><b>${yen(item.price * item.qty)}</b></td></tr>`).join("");
  const notesHtml = draft.notes ? `<div class="receiptNote"><b>${t("備考", "Notes")}</b>${escapeHtml(draft.notes).replace(/\n/g, "<br>")}</div>` : "";
  return `<article class="receiptSheet receiptCopy" data-copy="${companyCopy ? "company" : "customer"}" lang="${english ? "en" : "ja"}" aria-label="${copyLabel}">
    <div class="receiptCopyLabel">${copyLabel}</div>
    <div class="receiptHeaderSimple">
      <div class="receiptBrandBlock">
        <img class="receiptBrandLogo" src="${logoUrl}" alt="${company}">
        <div><div class="receiptBrandName">${company}</div>${english ? "" : '<div class="receiptBrandSub">SAN NISHIMURA CO., LTD.</div>'}</div>
      </div>
      <div class="receiptDocMeta"><div class="receiptDocTitle">${t("展示会 注文書", "Exhibition Order Receipt")}</div>${english ? "" : '<div class="receiptDocSub">Exhibition Order Receipt</div>'}<div class="receiptMetaLine"><b>${t("注文番号", "Order No.")}</b> ${escapeHtml(orderNumber(draft))}<br><b>${t("作成日時", "Issued (JST)")}</b> ${escapeHtml(new Date(date).toLocaleString(english ? "en-GB" : "ja-JP", { timeZone: "Asia/Tokyo" }))}</div></div>
    </div>
    <div class="receiptInfoBand">${info.map(([label, value]) => receiptInfo(label, value)).join("")}</div>
    ${isPickupOrder(draft) ? `<div class="receiptPickupNumber"><span>${t("お渡し番号", "Pickup No.")}</span><strong>${escapeHtml(pickupNumber(draft) || t("未発行・保存してください", "Not issued — save the order first"))}</strong><small>${t("お受け取り時に、この番号をご提示ください。", "Please present this number when collecting your order.")}</small></div>` : ""}
    <div class="receiptSection"><div class="receiptSectionHead"><div class="receiptSectionTitle">${t("注文明細", "Order details")}</div><div class="receiptSectionHint">${totalQuantity(draft.items)}${t("点", " items")}</div></div>
      <table class="receiptTable"><colgroup><col class="code"><col><col class="qty"><col class="unit"><col class="subtotal"></colgroup>
        <thead><tr><th>${t("品番", "Item No.")}</th><th>${t("商品名", "Product")}</th><th class="num">${t("数量", "Qty")}</th><th class="num">${t("単価", "Unit price")}</th><th class="num">${t("金額", "Amount")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="receiptFooterGrid">
      <div class="receiptMemoStack">${notesHtml}</div>
      <div><div class="receiptSummaryBox"><div class="receiptSummaryRow"><span>${t("点数", "Items")}</span><span>${totalQuantity(draft.items)}</span></div><div class="receiptSummaryRow total"><span>${t("合計", "Total")}</span><span>${yen(totalPrice(draft.items))}</span></div></div><div class="receiptCurrencyNote">${t("通貨：JPY", "Currency: JPY")}</div></div>
    </div>
    <div class="receiptFooterMini"><span>${company} ／ ${copyLabel}</span><span>${t("注文番号", "Order No.")} ${escapeHtml(orderNumber(draft))}</span></div></article>`;
}

function renderReceiptOperations() {
  const panel = $("receiptOperations");
  const order = state.draft;
  const required = needsSlackShare(order);
  $("receiptView").classList.toggle("slackWorkflow", required);
  const confirmed = isOrderConfirmed(order);
  const ready = Boolean(order.editingId && (!isPickupOrder(order) || pickupNumber(order)));
  $("startNextOrderButton").disabled = required && !confirmed;
  $("backToHistoryButton").textContent = required && !confirmed ? "一時保存して一覧へ" : "注文一覧へ";
  $("printPrivacyNotice").textContent = required && !confirmed
    ? "一時保存済み・まだ注文は確定していません。印刷してSlackに共有した後、上の「注文を確定」を押してください。"
    : "この注文は確定・保存済みです。印刷画面を閉じても入力内容は消えません。";
  $("printedActions").querySelector("p").textContent = required && !confirmed ? "次の注文へ進む前に、Slack共有と注文確定を済ませてください。" : "注文内容は保存されています。";
  if (!required) { panel.innerHTML = ""; return; }
  panel.innerHTML = `
    <section class="confirmationFlow" aria-label="注文確定までの手順">
      <div class="confirmationHeading"><h2>${confirmed ? "注文確定済み" : "あと少しで注文完了"}</h2><span class="confirmationStatus ${confirmed ? "done" : ""}">${confirmed ? "確定済み" : "未確定・一時保存"}</span></div>
      <ol class="confirmationSteps">
<li class="${ready ? "done" : "current"}"><span class="flowNumber">${ready ? "✓" : "1"}</span><div><h3>${isPickupOrder(order) ? "お渡し番号を発行" : "共有用の控えを作成"}</h3>${isPickupOrder(order) ? `<strong class="flowPickup">${escapeHtml(pickupNumber(order) || "未発行")}</strong>` : ""}<p>${ready ? (isPickupOrder(order) ? "一時保存済み。同じ注文を開き直しても番号は変わりません。" : "一時保存済み。共有用PDFを作成できます。") : "「戻って修正」から共有用の控えを作成してください。"}</p></div></li>
        <li class="${order.slackShared ? "done" : ready ? "current" : ""}"><span class="flowNumber">${order.slackShared ? "✓" : "2"}</span><div><h3>Slackに共有</h3><p>会社控え・お客様控え・添付写真を1つのPDFにまとめます。PDF保存してSlackへ投稿し、パソコンで開いて印刷してください。会社控えは常に日本語です。<br><b>このボタンだけではSlackに送信されません。</b></p><button id="receiptSlackSharedPrint" type="button" class="secondary" ${ready ? "" : "disabled"}>Slackへの共有（印刷）</button><label class="flowShareCheck" for="receiptSlackShared"><input id="receiptSlackShared" type="checkbox" ${order.slackShared ? "checked" : ""} ${ready ? "" : "disabled"}><span>Slackに共有済み<br><small>投稿できたことを確認してチェック</small></span></label>${order.slackSharedAt ? `<p>共有確認：${escapeHtml(formatDateTime(order.slackSharedAt))}</p>` : ""}</div></li>
        <li class="${confirmed ? "done" : order.slackShared ? "current" : ""}"><span class="flowNumber">${confirmed ? "✓" : "3"}</span><div><h3>注文を確定</h3><p>${confirmed ? (isPickupOrder(order) ? (order.delivered ? "注文確定済み・お渡し完了です。" : "注文確定済み・受け取り待ちです。") : "共有と注文確定が完了しました。") : order.slackShared ? "共有確認済みです。最後に下のボタンを押してください。" : "Slack共有済みにチェックすると、確定できます。"}</p><button id="confirmOrderButton" type="button" class="primary" ${confirmed || confirmationError(order) ? "disabled" : ""}>${confirmed ? "✓ 注文確定済み" : "③ 注文を確定する"}</button></div></li>
      </ol><p id="confirmationError" class="flowError hidden" role="alert"></p>
    </section>`;
  $("receiptSlackSharedPrint").addEventListener("click", () => printReceipt({ sharing: true }));
  $("receiptSlackSharedPrint").insertAdjacentHTML("beforebegin", attachmentPickerHtml(order, ready));
  bindAttachmentPicker(order);
  $("receiptSlackShared").addEventListener("change", async () => {
    if (!ready || state.saving) return;
    await saveReceiptProgress(setSlackShared(state.draft, $("receiptSlackShared").checked), "共有確認を保存しました。最後に「注文を確定する」を押してください。");
  });
  $("confirmOrderButton").addEventListener("click", async () => {
    if (state.saving || isOrderConfirmed(state.draft)) return;
    const error = confirmationError(state.draft);
    if (error) return toast(error);
    await saveReceiptProgress(confirmOrder(state.draft), "注文を確定しました。");
  });
}

function attachmentPickerHtml(order, ready) {
  const photos = attachmentStore.list(order.localId);
  const locked = !ready || order.slackShared || attachmentBusy;
  return `<div class="attachmentPicker"><h4>別紙・写真を添付（任意）</h4><p>ホテル送りの記入用紙などを追加できます。共有用PDFの控えの後ろに、写真1枚につき1ページで添付します。</p>
    <div class="attachmentButtons"><button id="choosePhotos" type="button" class="secondary" ${locked || photos.length >= MAX_PHOTOS ? "disabled" : ""}>写真フォルダから選ぶ</button><button id="takePhoto" type="button" class="secondary" ${locked || photos.length >= MAX_PHOTOS ? "disabled" : ""}>カメラで撮影</button></div>
    <input id="photoFiles" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden>
    <input id="cameraPhoto" type="file" accept="image/*" capture="environment" hidden>
    <p>最大${MAX_PHOTOS}枚・1枚20MBまで。写真はこの端末内のみです。再読み込み・ログアウト・新しい注文で消えるため、先にPDF保存・共有してください。</p>
    ${order.slackShared ? '<p>写真を変更する場合は、先に「Slackに共有済み」のチェックを外してください。</p>' : ""}
    <div class="attachmentList">${photos.map((photo, index) => `<div class="attachmentItem"><details><summary><img src="${photo.url}" alt="添付写真 ${index + 1}"><span>写真${index + 1}を大きく確認</span></summary><img class="attachmentLarge" src="${photo.url}" alt="${escapeHtml(photo.name)}"></details><button type="button" class="secondary" data-remove-photo="${photo.id}" ${locked ? "disabled" : ""}>写真${index + 1}を削除</button></div>`).join("")}</div>
    <p id="attachmentStatus" role="status">${photos.length}枚添付済み</p></div>`;
}

function attachmentPagesHtml(order) {
  return `<div class="shareAttachmentPages">${attachmentStore.list(order.localId).map((photo, index) => `<section class="shareAttachmentPage"><div class="receiptCopyLabel">会社控え・添付資料 ${index + 1}</div><p>注文番号 ${escapeHtml(orderNumber(order))}${pickupNumber(order) ? ` ／ お渡し番号 ${escapeHtml(pickupNumber(order))}` : ""}</p><img src="${photo.url}" alt="添付資料 ${index + 1}"></section>`).join("")}</div>`;
}

function bindAttachmentPicker(order) {
  $("choosePhotos").addEventListener("click", () => $("photoFiles").click());
  $("takePhoto").addEventListener("click", () => $("cameraPhoto").click());
  for (const id of ["photoFiles", "cameraPhoto"]) $(id).addEventListener("change", async event => {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length || attachmentBusy || state.draft?.localId !== order.localId || state.draft.slackShared) return;
    attachmentBusy = true;
    const generation = attachmentStore.generation;
    const controls = [...document.querySelectorAll("#receiptView button,#receiptView input")].map(control => [control,control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    $("attachmentStatus").textContent = "写真を読み込んでいます…";
    const errors = [];
    try {
      for (const file of files) {
        if (attachmentStore.generation !== generation) break;
        if (attachmentStore.list(order.localId).length >= MAX_PHOTOS) { errors.push(`最大${MAX_PHOTOS}枚までです。残りの写真は追加していません。`); break; }
        try { attachmentStore.add(order.localId, await preparePhoto(file), generation); }
        catch (error) { errors.push(`${file.name}: ${error.message}`); }
      }
    } finally {
      attachmentBusy = false;
      controls.forEach(([control,disabled]) => { control.disabled = disabled; });
      if (state.draft?.localId === order.localId) {
        renderReceipt();
        $("attachmentStatus").textContent = `${attachmentStore.list(order.localId).length}枚添付済み。${errors.join(" ") || "写真を開いて文字が読めるか確認してください。"}`;
      }
    }
  });
  document.querySelectorAll("[data-remove-photo]").forEach(button => button.addEventListener("click", () => {
    if (state.draft?.localId !== order.localId || state.draft.slackShared || attachmentBusy) return;
    attachmentStore.remove(order.localId,button.dataset.removePhoto);
    renderReceipt();
  }));
}

async function saveReceiptProgress(next, successMessage) {
  const previous = state.draft;
  const controls = [...document.querySelectorAll("#receiptView button,#receiptView input")].map(control => [control, control.disabled]);
  controls.forEach(([control]) => { control.disabled = true; });
  state.draft = next;
  let failure = "";
  try {
    await persistCurrentDraft();
    toast(successMessage);
  } catch (error) {
    state.draft = previous;
    failure = error.message === "SYNC_CONFLICT" ? "別のスタッフが変更しました。一覧から開き直し、最新の内容を確認してください。" : "保存できませんでした。注文は確定していません。通信を確認して再度お試しください。";
  } finally {
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    renderReceiptOperations();
  }
  if (failure) {
    $("confirmationError").textContent = failure;
    $("confirmationError").classList.remove("hidden");
  }
}

function bindStaticEvents() {
  window.addEventListener("afterprint", () => { delete document.body.dataset.printCopy; });
  $("retryConnection").addEventListener("click", restoreSession);
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
    if (state.saving) return;
    closeSheet();
    if (isLocalDemo) return showLogin("ローカル確認モードを終了しました。");
    await supabase.auth.signOut({ scope: "local" });
  });
  $("newOrderButton").addEventListener("click", startNewOrder);
  $("startNextOrderButton").addEventListener("click", startNewOrder);
  $("backToHistoryButton").addEventListener("click", showHistory);
  $("refreshOrders").addEventListener("click", () => isLocalDemo ? renderHistory() : syncOrders());
  $("orderSearch").addEventListener("input", renderHistory);
  $("closeSheetButton").addEventListener("click", closeSheet);
  $("backToEditButton").addEventListener("click", () => {
    $("receiptView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    state.draft.stage = "info";
    openSheet();
    renderDraft();
  });
  $("printButton").addEventListener("click", async () => {
    const button = $("printButton");
    button.disabled = true;
    try { await printReceipt(); } finally { button.disabled = false; }
  });
  window.addEventListener("online", () => {
    if (!state.authUserId && supabase && !isLocalDemo) restoreSession();
    else syncOrders({ quiet: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.authUserId && supabase && !isLocalDemo && !$("connectionView").classList.contains("hidden")) restoreSession();
    else syncOrders({ quiet: true });
  });
  window.addEventListener("afterprint", () => {
    if (!$("receiptView").classList.contains("hidden")) {
      $("printedActions").classList.remove("hidden");
    }
  });
}

boot();
