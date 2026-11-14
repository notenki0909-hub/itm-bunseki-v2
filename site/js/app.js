import {
  OPTION_TYPES, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup, BADGE_LABELS,
  RISK_VARIANT_LABELS,
  baseEntryIndices, computeDepthEntryResults, summarizeDepthResults,
  VOLATILITY_PERIODS, computeVolatilityStats, computeRecentVolatilityAmount,
  computeHv, computeHvSeries, hvPosition, hvTheory,
} from "./calc.js";
import { renderDayProbChart, DAY_PROB_BANDS, renderConeChart, renderHvHistoryChart } from "./chart.js";
import { renderEntryHeatmap, ENTRY_HEATMAP_BANDS, renderDepthHeatmap, DEPTH_HEATMAP_BANDS, renderOtmHeatmap, OTM_HEATMAP_BANDS, OTM_RATE_BANDS } from "./heatmap.js";
import { initThemeBar } from "./theme.js";
import { isPriceDataStale } from "./marketTime.js";
import { stressTest } from "./optionModel.js";
import { WEEKDAY_JA, weekday, parseYmd, isTradingDay, previousTradingDay, shiftTradingDays, tradingDaysBetween, expiryKind, EXPIRY_KIND_LABEL, EXPIRY_KIND_NOTE } from "./usMarket.js";
import { addTickerToHistory, setupTickerHistoryDropdown, loadTickerHistory, mergeTickerHistory } from "./tickerHistory.js";

// 複数銘柄・複数タイプを切り替えながら見比べられるよう「タブ」単位で状態を持つ。
// タブの切り替えは常にメモリ上のデータを出し直すだけで、APIへの再アクセスは発生しない。
// 実アクセスが起きるのは「分析する」ボタンを押した瞬間だけ、という原則はタブ導入後も変わらない。

let nextTabId = 1;
const tabs = [];
let activeTabId = null;

// 同一ブラウザ内でのタブ間重複フェッチを防ぐための銘柄→データのメモリキャッシュ。
// (サーバー側のKVキャッシュとは別レイヤー。こちらは「同じ人が複数タブで同じ銘柄を見る」場合、
//  自サーバーへのリクエストすら発生させないためのもの。ページ再読み込みで消える一時キャッシュ)
const priceCache = new Map();

// 同一端末での永続化(localStorage)。ページ遷移・リロード・ブラウザ再起動をまたいで
// タブの状態(取得済みデータ込み)を復元できるようにする。
const STORAGE_KEY = "itm-tool-state-v1";

// 端末をまたいだ共有用。タブの「設定」だけ(取得済みデータは含めない)をURLに載せる。
// URLが長くなりすぎるのを避けるため、価格データは含めず、開いた側で再取得させる設計。
function tabRecipe(t) {
  return {
    symbol: t.symbol,
    typeKey: t.typeKey,
    ratio: t.ratio,
    windowDays: t.windowDays,
    periodDays: t.periodDays,
    conditionMode: t.conditionMode,
    momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
    rrVariant: t.rrVariant,
    rrDepth: t.rrDepth,
    rrPremium: t.rrPremium,
    rrPayPremium: t.rrPayPremium,
    rrProfitRatio: t.rrProfitRatio,
    rrSpreadWidth: t.rrSpreadWidth,
    rrIvSell: t.rrIvSell,
    rrIvBuy: t.rrIvBuy,
  };
}

function applyRecipe(t, rec) {
  Object.assign(t, {
    symbol: rec.symbol ?? t.symbol,
    typeKey: rec.typeKey || t.typeKey,
    ratio: rec.ratio ?? t.ratio,
    windowDays: rec.windowDays ?? t.windowDays,
    periodDays: rec.periodDays ?? t.periodDays,
    conditionMode: rec.conditionMode || t.conditionMode,
    momentumLookback: rec.momentumLookback ?? t.momentumLookback,
    minMatchDays: rec.minMatchDays ?? t.minMatchDays,
    momentumDirection: rec.momentumDirection || t.momentumDirection,
    momentumThresholdPct: rec.momentumThresholdPct ?? t.momentumThresholdPct,
    rrVariant: rec.rrVariant || t.rrVariant,
    rrDepth: rec.rrDepth ?? t.rrDepth,
    rrPremium: rec.rrPremium ?? t.rrPremium,
    rrPayPremium: rec.rrPayPremium ?? t.rrPayPremium,
    rrProfitRatio: rec.rrProfitRatio ?? t.rrProfitRatio,
    rrSpreadWidth: rec.rrSpreadWidth ?? t.rrSpreadWidth,
    rrIvSell: rec.rrIvSell ?? t.rrIvSell,
    rrIvBuy: rec.rrIvBuy ?? t.rrIvBuy,
  });
  // 古い保存状態・共有リンクの引き継ぎ。
  //  - 買い系の支払いプレミアム額は、以前はrrLossBasis(さらに前はrrPremium)に保存していた。
  //    今は専用のrrPayPremiumに保存する(受取プレミアムと意味が違うため、別々に持つ)。
  //  - 売り系スプレッドのスプレッド幅は、以前はrrLossBasisに保存していた。今はrrSpreadWidthに統一。
  if (rec.rrPayPremium === null || rec.rrPayPremium === undefined) {
    if (typeGroup(t.typeKey) === "buy") {
      const legacy = rec.rrPremium ?? rec.rrLossBasis;
      if (legacy !== null && legacy !== undefined) {
        t.rrPayPremium = legacy;
        t.rrPremium = null;
      }
    }
  }
  if ((rec.rrSpreadWidth === null || rec.rrSpreadWidth === undefined)
      && typeGroup(t.typeKey) === "sell" && t.rrVariant === "spread"
      && rec.rrLossBasis !== null && rec.rrLossBasis !== undefined) {
    t.rrSpreadWidth = rec.rrLossBasis;
  }
}

function persistState() {
  try {
    const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
    const payload = {
      activeIndex,
      tabs: tabs.map((t) => ({
        ...tabRecipe(t),
        closesFull: t.closesFull,
        datesFull: t.datesFull,
        fetchedAt: t.fetchedAt,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // 保存できなくても致命的ではない(プライベートブラウジング等で失敗することがある)ので無視する
  }
}

function loadFromSavedState() {
  let payload;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    payload = JSON.parse(raw);
  } catch (e) {
    return false;
  }
  if (!payload || !Array.isArray(payload.tabs) || payload.tabs.length === 0) return false;

  for (const rec of payload.tabs) {
    const t = newTabState();
    applyRecipe(t, rec);
    t.closesFull = rec.closesFull || null;
    t.datesFull = rec.datesFull || null;
    t.fetchedAt = rec.fetchedAt ?? null; // 古い保存状態には無い(=古いデータとして扱い、開いたときに取り直す)
    tabs.push(t);
  }
  const idx = Math.min(Math.max(payload.activeIndex || 0, 0), tabs.length - 1);
  switchTab(tabs[idx].id);
  return true;
}

// 新形式は {tabs, tickerHistory} のオブジェクト。配列そのものだった旧形式の
// 共有リンク(このセクション追加前に発行されたもの)も後方互換で読み込める。
function parseShareParam() {
  try {
    const raw = new URLSearchParams(location.search).get("share");
    if (!raw) return null;
    // URLSearchParams.get() は自動でデコード済みなので、ここでさらに decodeURIComponent はしない
    const parsed = JSON.parse(raw);
    const recipes = Array.isArray(parsed) ? parsed : parsed.tabs;
    const tickerHistory = Array.isArray(parsed) ? [] : parsed.tickerHistory;
    if (!Array.isArray(recipes) || recipes.length === 0) return null;
    return { recipes, tickerHistory: Array.isArray(tickerHistory) ? tickerHistory : [] };
  } catch (e) {
    return null;
  }
}

async function loadFromShareRecipes(recipes) {
  for (const rec of recipes) {
    const t = newTabState();
    applyRecipe(t, rec);
    tabs.push(t);
  }
  renderTabBar();
  switchTab(tabs[0].id);
  setStatus("共有された設定を読み込み中…");

  for (const t of tabs) {
    if (!t.symbol) continue;
    try {
      const data = await fetchHistory(t.symbol);
      t.closesFull = data.closes;
      t.datesFull = data.dates;
      t.fetchedAt = data.fetchedAt ?? Date.now();
    } catch (e) {
      // このタブだけ取得失敗。「分析する」ボタンで再試行できる
    }
  }
  renderTabBar();
  const active = activeTab();
  if (active?.closesFull) renderAll(active);
  setStatus("共有された設定を読み込みました");
  persistState();
  // URLの共有パラメータは読み込み後に消し、通常のURLに戻す
  history.replaceState(null, "", location.pathname);
}

function buildShareUrl() {
  const recipes = tabs.filter((t) => t.symbol).map(tabRecipe);
  const payload = { tabs: recipes, tickerHistory: loadTickerHistory() };
  const url = new URL(location.href);
  url.search = "";
  // URLSearchParams.set() が自動でエンコードするので、ここで encodeURIComponent はしない
  url.searchParams.set("share", JSON.stringify(payload));
  return url.toString();
}

async function onShareLink() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus("共有リンクをコピーしました");
  } catch (e) {
    window.prompt("このリンクをコピーしてください", url);
  }
}

const DETAIL_HANDOFF_KEY = "itm-detail-handoff";

// 詳細マトリクスページへは、今のタブの設定(レシピ)だけを渡す。詳細マトリクス側でも
// 銘柄・タイプ・比率・判定期間・集計期間を変更できるようにしたため、価格データそのものは
// 渡さず、詳細マトリクス側で(KVキャッシュ経由の軽い)再取得をさせる設計にした。
function onOpenDetail() {
  const t = activeTab();
  if (!t || !t.closesFull) {
    setStatus("先に「分析する」でデータを取得してください", true);
    return;
  }
  try {
    sessionStorage.setItem(DETAIL_HANDOFF_KEY, JSON.stringify(tabRecipe(t)));
  } catch (e) {
    // 保存できなくても致命的ではない(詳細マトリクス側は空の状態から入力すればよい)
  }
  window.location.href = "detail.html";
}

const els = {
  tabBar: document.getElementById("tabBar"),
  shareBtn: document.getElementById("shareBtn"),
  openDetailBtn: document.getElementById("openDetailBtn"),
  ticker: document.getElementById("ticker"),
  tickerHistoryDropdown: document.getElementById("tickerHistoryDropdown"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  typeSelect: document.getElementById("typeSelect"),
  ratioInput: document.getElementById("ratioInput"),
  windowDateInput: document.getElementById("windowDateInput"),
  windowHint: document.getElementById("windowHint"),
  orderWindowDateInput: document.getElementById("orderWindowDateInput"),
  orderWindowHint: document.getElementById("orderWindowHint"),
  periodSelect: document.getElementById("periodSelect"),
  status: document.getElementById("status"),

  volatilityCard: document.getElementById("volatilityCard"),
  volatilityTableBody: document.getElementById("volatilityTableBody"),

  todayCard: document.getElementById("todayCard"),
  todayDate: document.getElementById("todayDate"),
  todayRange: document.getElementById("todayRange"),
  todayClose: document.getElementById("todayClose"),
  todayCloseDate: document.getElementById("todayCloseDate"),
  recoveryAvgStat: document.getElementById("recoveryAvgStat"),
  recoveryAvg: document.getElementById("recoveryAvg"),
  recoveryAvgSub: document.getElementById("recoveryAvgSub"),
  recoveryUnrecStat: document.getElementById("recoveryUnrecStat"),
  recoveryUnrec: document.getElementById("recoveryUnrec"),
  recoveryUnrecSub: document.getElementById("recoveryUnrecSub"),
  orderExitSummary: document.getElementById("orderExitSummary"),
  orderExitNote: document.getElementById("orderExitNote"),
  expirySummary: document.getElementById("expirySummary"),
  hvCard: document.getElementById("hvCard"),
  hvMatchTitle: document.getElementById("hvMatchTitle"),
  hvMatchSummary: document.getElementById("hvMatchSummary"),
  hvTheoryTitle: document.getElementById("hvTheoryTitle"),
  hvTheorySummary: document.getElementById("hvTheorySummary"),
  hvConeWrap: document.getElementById("hvConeWrap"),
  hvConeLegend: document.getElementById("hvConeLegend"),
  hvTheoryNote: document.getElementById("hvTheoryNote"),
  expiryNote: document.getElementById("expiryNote"),
  latestPrice: document.getElementById("latestPrice"),
  todayTitle: document.getElementById("todayTitle"),
  statusDateInput: document.getElementById("statusDateInput"),
  statusDateReset: document.getElementById("statusDateReset"),
  statusDateHint: document.getElementById("statusDateHint"),
  todayStrike: document.getElementById("todayStrike"),
  momentumStrip: document.getElementById("momentumStrip"),

  result: document.getElementById("result"),
  badge: document.getElementById("badge"),
  entryCount: document.getElementById("entryCount"),
  itmCount: document.getElementById("itmCount"),
  totalItmDays: document.getElementById("totalItmDays"),
  overallProb: document.getElementById("overallProb"),
  chartWrap: document.getElementById("chartWrap"),
  heatmapWrap: document.getElementById("heatmapWrap"),
  depthHeatmapWrap: document.getElementById("depthHeatmapWrap"),
  depthHeatmapLegend: document.getElementById("depthHeatmapLegend"),
  otmHeatmapWrap: document.getElementById("otmHeatmapWrap"),
  otmHeatmapLegend: document.getElementById("otmHeatmapLegend"),
  symbolLabel: document.getElementById("symbolLabel"),
  dayProbDepth: document.getElementById("dayProbDepth"),
  dayProbKind: document.getElementById("dayProbKind"),
  heatmapKind: document.getElementById("heatmapKind"),
  otmToggleBtn: document.getElementById("otmToggleBtn"),
  depthRiskBox: document.getElementById("depthRiskBox"),
  depthRiskLine: document.getElementById("depthRiskLine"),
  heatmapDepth: document.getElementById("heatmapDepth"),
  resultTypeLabel: document.getElementById("resultTypeLabel"),
  badgeLegend: document.getElementById("badgeLegend"),
  dayProbLegend: document.getElementById("dayProbLegend"),
  entryHeatmapLegend: document.getElementById("entryHeatmapLegend"),

  conditionCard: document.getElementById("conditionCard"),
  conditionModeSelect: document.getElementById("conditionModeSelect"),
  conditionModeNote: document.getElementById("conditionModeNote"),
  momentumLookbackSelect: document.getElementById("momentumLookbackSelect"),
  minMatchDaysInput: document.getElementById("minMatchDaysInput"),
  momentumDirectionSelect: document.getElementById("momentumDirectionSelect"),
  momentumThresholdInput: document.getElementById("momentumThresholdInput"),
  matchedCount: document.getElementById("matchedCount"),
  matchedItmCount: document.getElementById("matchedItmCount"),
  matchedTotalItmDays: document.getElementById("matchedTotalItmDays"),
  matchedProb: document.getElementById("matchedProb"),
  todayMatchBadge: document.getElementById("todayMatchBadge"),

  orderCard: document.getElementById("orderCard"),
  orderTicker: document.getElementById("orderTicker"),
  orderClose: document.getElementById("orderClose"),
  orderLine: document.getElementById("orderLine"),
  orderTypeLabel: document.getElementById("orderTypeLabel"),
  orderMaxLossField: document.getElementById("orderMaxLossField"),
  orderMaxLoss: document.getElementById("orderMaxLoss"),
  orderMaxLossHint: document.getElementById("orderMaxLossHint"),
  orderDepthPct: document.getElementById("orderDepthPct"),
  spBtn: document.getElementById("spBtn"),
  rrPayPremiumInput: document.getElementById("rrPayPremiumInput"),
  rrDepthInput: document.getElementById("rrDepthInput"),
  rrDepthPct: document.getElementById("rrDepthPct"),
  rrBreakEvenSummary: document.getElementById("rrBreakEvenSummary"),
  rrPremiumInput: document.getElementById("rrPremiumInput"),
  rrProfitRatioInput: document.getElementById("rrProfitRatioInput"),
  rrSpreadWidthInput: document.getElementById("rrSpreadWidthInput"),
  rrIvSellInput: document.getElementById("rrIvSellInput"),
  rrIvBuyInput: document.getElementById("rrIvBuyInput"),
  stressIntro: document.getElementById("stressIntro"),
  stressHead: document.getElementById("stressHead"),
  stressBody: document.getElementById("stressBody"),
  stressNote: document.getElementById("stressNote"),
};

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function newTabState() {
  return {
    id: nextTabId++,
    symbol: null,
    otmView: false,   // 「過去の営業日ごとのITM確率」とエントリー日ごとのITM状況を、OTM表示にしているか。表示だけの一時的な切替で、保存・共有はしない
    statusDate: null, // 「本日の状況」で見る過去の日付(YYYY-MM-DD)。null=本日。表示だけの一時的な指定で、保存・共有はしない
    fetchedAt: null,  // closesFullをサーバーが取得した時刻(UTCミリ秒)。古いかの判定に使う
    closesFull: null, // フェッチした生データ(最大件数)。期間セレクターはこれをローカルでスライスするだけ
    datesFull: null,  // closesFullと同じ並びの日付文字列
    typeKey: "put_sell",
    ratio: OPTION_TYPES.put_sell.ratio,
    windowDays: DEFAULT_WINDOW,
    periodDays: DEFAULT_PERIOD_DAYS,
    conditionMode: "lookback",
    momentumLookback: DEFAULT_MOMENTUM_LOOKBACK,
    minMatchDays: 3,
    momentumDirection: "down",
    momentumThresholdPct: 5,
    rrVariant: "naked",
    rrDepth: null,
    rrPremium: null,
    rrPayPremium: null,
    rrProfitRatio: null,
    rrSpreadWidth: null,
    rrIvSell: null,
    rrIvBuy: null,
  };
}

function createTab() {
  const t = newTabState();
  tabs.push(t);
  switchTab(t.id);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const next = tabs[Math.max(0, idx - 1)];
    switchTab(next.id);
  } else {
    renderTabBar();
    persistState();
  }
}

function switchTab(id) {
  activeTabId = id;
  const t = activeTab();
  if (!t) return;

  els.ticker.value = t.symbol || "";
  els.typeSelect.value = t.typeKey;
  els.ratioInput.value = t.ratio;
  syncWindowInputs(t);
  els.periodSelect.value = String(t.periodDays);
  els.conditionModeSelect.value = t.conditionMode;
  els.momentumLookbackSelect.value = String(t.momentumLookback);
  els.minMatchDaysInput.value = t.minMatchDays;
  els.momentumDirectionSelect.value = t.momentumDirection;
  els.momentumThresholdInput.value = t.momentumThresholdPct;
  updateConditionModeUI(t.conditionMode);

  els.rrDepthInput.value = t.rrDepth ?? "";
  els.rrPremiumInput.value = t.rrPremium ?? "";
  els.rrPayPremiumInput.value = t.rrPayPremium ?? "";
  els.rrProfitRatioInput.value = t.rrProfitRatio ?? "";
  els.rrSpreadWidthInput.value = t.rrSpreadWidth ?? "";
  els.rrIvSellInput.value = t.rrIvSell ?? "";
  els.rrIvBuyInput.value = t.rrIvBuy ?? "";
  els.statusDateInput.value = t.statusDate ?? "";
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  syncMirrors();
  setStatus("");

  if (t.closesFull) {
    renderAll(t);
  } else {
    els.volatilityCard.hidden = true;
    els.hvCard.hidden = true;
    els.latestPrice.hidden = true;
    els.todayCard.hidden = true;
    els.result.hidden = true;
    els.orderCard.hidden = true;
    els.conditionCard.hidden = true;
  }
  renderTabBar();
  persistState();
  refreshIfStale(t);
}

// タブを開いたとき、保存済みのデータが古ければ(取得時刻がデータ更新時刻より前なら)、
// そのタブの銘柄だけを取り直して表示を更新する。取り直しの間は古いデータを表示したままにする。
// 開いていないタブは取りにいかない。サーバー側にキャッシュがあれば、外部APIは叩かれない。
async function refreshIfStale(t) {
  if (!t || !t.symbol || !t.closesFull || t.refreshing) return;
  if (!isStaleData(t.fetchedAt, t.datesFull)) return;
  t.refreshing = true;
  if (activeTabId === t.id) setStatus(`${t.symbol} の最新の株価データを確認中…（それまでは保存済みのデータを表示しています）`);
  try {
    const data = await fetchHistory(t.symbol);
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    t.fetchedAt = data.fetchedAt ?? Date.now();
    persistState();
    if (activeTabId === t.id) {
      renderAll(t);
      setStatus(`${t.symbol} の最新の株価データ（${data.dates[data.dates.length - 1]}まで）に更新しました`);
    }
  } catch (e) {
    if (activeTabId === t.id) {
      setStatus("最新の株価データの取得に失敗しました。保存済みのデータを表示しています（「分析する」で再試行できます）", true);
    }
  } finally {
    t.refreshing = false;
  }
}

function tabLabel(t) {
  if (!t.symbol) return "新規タブ";
  return `${t.symbol}・${OPTION_TYPES[t.typeKey].label}`;
}

function renderTabBar() {
  els.tabBar.innerHTML = "";
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab" + (t.id === activeTabId ? " active" : "");
    btn.textContent = tabLabel(t);
    btn.addEventListener("click", () => switchTab(t.id));

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "タブを閉じる";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    btn.appendChild(closeBtn);

    els.tabBar.appendChild(btn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "tab-add";
  addBtn.textContent = "＋ 新規タブ";
  addBtn.addEventListener("click", createTab);
  els.tabBar.appendChild(addBtn);
}

function initTypeOptions() {
  els.typeSelect.innerHTML = Object.entries(OPTION_TYPES)
    .map(([key, t]) => `<option value="${key}">${t.label}</option>`)
    .join("");
}

// ---- 満期日(判定期間)の入力 ----
// 判定期間は、満期日の日付で入力する(上の入力欄と注文内容の2か所。どちらで入力しても連動する)。
// 入力した日付までの営業日数が判定期間(t.windowDays)になる。保存するのは営業日数だけで、
// 日付が進むと、表示する満期日の日付は(営業日数が同じまま)後ろにずれる。
const MIN_WINDOW_DAYS = 5;     // 選べる最短(営業日)
const MAX_WINDOW_DAYS = 150;   // 選べる最長(営業日)。従来の判定期間の最大値に合わせた
const GUIDE_MAX_CALENDAR_DAYS = 60; // 講座の想定の上限(暦日)。超えても選べるが、ひとこと添える

function etTodayYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const o = {};
  for (const p of parts) if (p.type !== "literal") o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

// 満期日までの営業日数を数える基準日。データを取得済みなら最新の終値の日(日付指定中はその日)、
// 未取得なら、米国の今日(休場日なら直近の営業日)。
function asOfDateOf(t) {
  if (t && t.closesFull && t.closesFull.length) {
    const dates = viewDataOf(t).dates;
    return dates[dates.length - 1];
  }
  return previousTradingDay(etTodayYmd());
}

function calendarDaysBetween(a, b) {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}

// 満期日の入力欄(2か所)に、現在の判定期間に対応する満期日・選べる範囲・残り日数のヒントを表示する。
// 入力中の欄は上書きしない(commitのあとだけforce)。messageは調整したときの説明。
function syncWindowInputs(t, message = "", force = false) {
  const asOf = asOfDateOf(t);
  const exp = shiftTradingDays(asOf, -t.windowDays);
  const min = shiftTradingDays(asOf, -MIN_WINDOW_DAYS);
  const max = shiftTradingDays(asOf, -MAX_WINDOW_DAYS);
  const cal = calendarDaysBetween(asOf, exp);
  const base = `残り${t.windowDays}営業日（${cal}暦日）・${EXPIRY_KIND_LABEL[expiryKind(exp)]}${cal > GUIDE_MAX_CALENDAR_DAYS ? "・講座の想定の約60暦日を超えています" : ""}`;
  const hint = message ? `${message}　${base}` : base;
  for (const [inp, h] of [[els.windowDateInput, els.windowHint], [els.orderWindowDateInput, els.orderWindowHint]]) {
    inp.min = min;
    inp.max = max;
    if (force || document.activeElement !== inp) inp.value = exp;
    h.textContent = hint;
  }
}

// 満期日が入力されたとき: 営業日数に直して判定期間にし、全体を再計算する。休場日は直前の営業日に直し、
// 選べる範囲(5〜150営業日)を超えていれば範囲内に直して、その旨を表示する。
function commitWindowDate(value) {
  const t = activeTab();
  if (!t || !value) return;
  const asOf = asOfDateOf(t);
  let date = value;
  let message = "";
  if (!isTradingDay(date)) {
    const prev = previousTradingDay(date);
    message = `${date}は休場日のため、直前の営業日${prev}にしました。`;
    date = prev;
  }
  let days = tradingDaysBetween(asOf, date);
  if (days < MIN_WINDOW_DAYS) { days = MIN_WINDOW_DAYS; message = `選べる最短（${MIN_WINDOW_DAYS}営業日後）に調整しました。`; }
  else if (days > MAX_WINDOW_DAYS) { days = MAX_WINDOW_DAYS; message = `選べる最長（${MAX_WINDOW_DAYS}営業日後）に調整しました。`; }
  t.windowDays = days;
  if (t.closesFull) renderAll(t);
  syncWindowInputs(t, message, true);
  renderTabBar();
  persistState();
}

function initPeriodOptions() {
  els.periodSelect.innerHTML = PERIOD_OPTIONS
    .map((p) => `<option value="${p.days}" ${p.days === DEFAULT_PERIOD_DAYS ? "selected" : ""}>${p.label}</option>`)
    .join("");
}

function initMomentumLookbackOptions() {
  els.momentumLookbackSelect.innerHTML = MOMENTUM_LOOKBACK_OPTIONS
    .map((d) => `<option value="${d}" ${d === DEFAULT_MOMENTUM_LOOKBACK ? "selected" : ""}>${d}営業日前と比較</option>`)
    .join("");
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("err", !!isError);
}

// データが「古いか」は、取得時刻がデータ更新時刻(米国市場の引けの1時間後)より前かで判定する
// (marketTime.js。サーバー側のキャッシュも同じ判定)。
function isStaleData(fetchedAt, dates) {
  return isPriceDataStale(fetchedAt, dates && dates.length ? dates[dates.length - 1] : undefined);
}

async function fetchHistory(symbol) {
  // 同一ブラウザ内で既に取得済みで、まだ古くなければAPIを叩かず使い回す(タブをまたいでも共有)
  const hit = priceCache.get(symbol);
  if (hit && !isStaleData(hit.fetchedAt, hit.dates)) return hit;
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  priceCache.set(symbol, data);
  return data;
}

async function onAnalyze() {
  const t = activeTab();
  if (!t) return;
  const symbol = els.ticker.value.trim().toUpperCase();
  if (!symbol) {
    setStatus("ティッカーを入力してください", true);
    return;
  }
  els.analyzeBtn.disabled = true;
  setStatus("取得中…");
  els.volatilityCard.hidden = true;
  els.hvCard.hidden = true;
  els.latestPrice.hidden = true;
  els.todayCard.hidden = true;
  els.result.hidden = true;
  els.orderCard.hidden = true;
  els.conditionCard.hidden = true;
  try {
    const data = await fetchHistory(symbol);
    t.symbol = data.symbol;
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    t.fetchedAt = data.fetchedAt ?? Date.now();
    setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました`);
    addTickerToHistory(data.symbol);
    renderAll(t);
    renderTabBar();
    persistState();
  } catch (e) {
    setStatus(`取得に失敗しました: ${e.message}`, true);
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

function onFormChange() {
  const t = activeTab();
  if (!t) return;
  t.typeKey = els.typeSelect.value;
  t.ratio = Number(els.ratioInput.value) || OPTION_TYPES[t.typeKey].ratio;
  t.periodDays = Number(els.periodSelect.value) || DEFAULT_PERIOD_DAYS;
  t.conditionMode = els.conditionModeSelect.value;
  t.momentumLookback = Number(els.momentumLookbackSelect.value) || DEFAULT_MOMENTUM_LOOKBACK;
  t.minMatchDays = Number(els.minMatchDaysInput.value) || 1;
  t.momentumDirection = els.momentumDirectionSelect.value;
  t.momentumThresholdPct = Number(els.momentumThresholdInput.value) || 0;
  updateConditionModeUI(t.conditionMode);

  t.rrDepth = els.rrDepthInput.value === "" ? null : Math.max(0, Number(els.rrDepthInput.value));
  t.rrPremium = els.rrPremiumInput.value === "" ? null : Number(els.rrPremiumInput.value);
  t.rrPayPremium = els.rrPayPremiumInput.value === "" ? null : Number(els.rrPayPremiumInput.value);
  t.rrProfitRatio = els.rrProfitRatioInput.value === "" ? null : Number(els.rrProfitRatioInput.value);
  t.rrSpreadWidth = els.rrSpreadWidthInput.value === "" ? null : Number(els.rrSpreadWidthInput.value);
  t.rrIvSell = els.rrIvSellInput.value === "" ? null : Number(els.rrIvSellInput.value);
  t.rrIvBuy = els.rrIvBuyInput.value === "" ? null : Number(els.rrIvBuyInput.value);
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);

  if (t.closesFull) renderAll(t);
  syncMirrors();
  renderTabBar();
  persistState();
}

// 条件タイプに応じて、使わない入力欄を無効化し、簡単な説明を出す。
function updateConditionModeUI(mode) {
  const isCount = mode === "countWithin7";
  els.momentumLookbackSelect.disabled = isCount;
  els.minMatchDaysInput.disabled = !isCount;
  els.conditionModeNote.textContent = isCount
    ? "直近7営業日それぞれ(1〜7営業日前比較)について、指定した変化率条件を満たす日を数え、その日数が指定した日数以上あった日をエントリー日とします。「比較営業日数」は使いません。"
    : "指定した比較営業日数の1点だけで、変化率条件を満たすかを判定します。";
}

// 集計期間で末尾N件にスライスした配列を返す(ローカル計算のみ。APIは叩かない)
function periodClosesOf(t) {
  return viewDataOf(t).closes.slice(-t.periodDays);
}
function periodDatesOf(t) {
  return viewDataOf(t).dates.slice(-t.periodDays);
}

// 「状況を見る日付」を指定しているときは、その日までのデータだけを返す(指定した日が最新だった
// つもりで、すべてのカードを計算するため)。未指定なら取得済みの全データ。
function viewDataOf(t) {
  const { endIdx } = resolveStatusDate(t);
  if (endIdx === t.closesFull.length - 1) return { closes: t.closesFull, dates: t.datesFull };
  return { closes: t.closesFull.slice(0, endIdx + 1), dates: t.datesFull.slice(0, endIdx + 1) };
}

// 日付指定中のとき、見出しに付ける「（◯◯時点）」。本日なら空文字。
function asOfSuffixOf(t) {
  const { asOf } = resolveStatusDate(t);
  return asOf ? `（${asOf}時点）` : "";
}

function renderAll(t) {
  syncWindowInputs(t);
  renderLatestPrice(t);
  renderVolatilityCard(t);
  renderHvCard(t);
  renderTodayCard(t);
  renderMainAnalysis(t);
  renderOrderCard(t);
  renderConditionCard(t);
}

// 「変動幅の統計」カードを描画する。集計期間セレクターの影響を受けず、
// 常に取得済みの全データ(closesFull、最大800営業日)を使う。
function renderVolatilityCard(t) {
  const closes = t.closesFull ? viewDataOf(t).closes : null;
  if (!closes || closes.length < 2) {
    els.volatilityCard.hidden = true;
    return;
  }
  els.volatilityTableBody.innerHTML = VOLATILITY_PERIODS.map(({ label, days }) => {
    const stats = computeVolatilityStats(closes, days);
    const recent = computeRecentVolatilityAmount(closes, days);
    const pctText = stats ? (stats.avgAbsPct * 100).toFixed(2) + "%" : "―";
    const riseText = stats ? "+" + (stats.maxRisePct * 100).toFixed(2) + "%" : "―";
    const fallText = stats ? (stats.maxFallPct * 100).toFixed(2) + "%" : "―";
    const runUpText = stats ? "+" + (stats.maxRunUpPct * 100).toFixed(2) + "%" : "―";
    const drawdownText = stats ? (stats.maxDrawdownPct * 100).toFixed(2) + "%" : "―";
    const amountText = recent ? recent.avgAbsAmount.toFixed(2) : "―";
    return `<tr><td>${label}</td><td>${pctText}</td><td>${riseText}</td><td>${fallText}</td><td>${runUpText}</td><td>${drawdownText}</td><td>${amountText}</td></tr>`;
  }).join("");
  els.volatilityCard.hidden = false;
}

// 過去1年の中でのいまのHVの位置を、日数と言葉で表す(例: 「過去1年の252日中、いまより高かった日は1日（高い方）」)。
function hvPositionText(pos) {
  if (!pos) return "データ不足";
  let word;
  if (pos.higherCount === 0) word = "過去1年で最も荒れている";
  else if (pos.higherCount / pos.count <= 0.02) word = "ほぼ最も荒れている";
  else if (pos.lowerCount === 0) word = "過去1年で最も穏やか";
  else if (pos.percentile >= 0.8) word = "高い方";
  else if (pos.percentile <= 0.2) word = "低い方";
  else word = "平均的";
  return `過去1年の${pos.count}日中、高い方から${pos.higherCount + 1}番目（${word}）`;
}

// HVカードをクリックしたときの説明欄に添える、「同じHVで、満期の長さだけを変えた比較」の表。
// 満期が長いほど、動く幅(1σ)が大きくなり、ITMの確率が上がることを見せる。
// (満期までの値動きのグラフは、カードの下にすでに表示しているので、ここでは出さない。)
const HV_COMPARE_MATURITIES = [10, 20, 30, 45, 60];
function hvCompareBlockHtml(t, closes, dates, days) {
  const hv = computeHv(closes, days);
  if (hv === null) return "";
  const type = OPTION_TYPES[t.typeKey];
  const window = t.windowDays;
  const price = closes[closes.length - 1];
  const strike = price * t.ratio;
  const depthDollar = t.rrDepth ?? 0;
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const sigmaText = (th) => `${Math.abs(th.zScore).toFixed(2)}σ${th.zScore >= 0 ? "外" : "内"}`;
  const asOfDate = dates[dates.length - 1];
  const maturities = [...new Set([...HV_COMPARE_MATURITIES, window])].sort((a, b) => a - b);
  const rows = maturities.map((dd) => {
    const th = hvTheory({ price, strike, depthDollar, itmWhen: type.itmWhen, days: dd, hv });
    if (!th) return "";
    const exp = shiftTradingDays(asOfDate, -dd);
    const now = dd === window;
    return `<tr${now ? ' class="hv-cmp-now"' : ""}><td>${dd}営業日${now ? "（いまの満期）" : ""}</td><td>${exp.slice(5)}</td><td>±${pct(th.sigmaPct)}</td><td>${sigmaText(th)}</td><td>${pct(th.probItmAtExpiry)}</td><td>約${pct(th.probTouch, 0)}</td></tr>`;
  }).join("");
  return `<div class="hv-history"><div class="hv-history-title">同じHV（${pct(hv)}）で、満期の長さだけを変えて比べると</div>`
    + `<div class="hv-scroll"><table class="volatility-table hv-compare"><thead><tr><th>満期までの長さ</th><th>満期日</th><th>1σの値動き</th><th>ITMの水準</th><th>満期時にITMの確率</th><th>期間中に届く目安</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div class="hv-history-note">満期が長いほど、動く幅（1σ）が大きくなり、ITMの確率が上がります（1σ＝HV×√(満期の営業日数÷252)）。HVは固定なので、変わるのは「満期までの長さ」だけです。</div></div>`;
}

// HVカードをクリックしたときの説明欄に添える、過去1年のHVの推移グラフ(その期間のHV)。
// 過去1年の毎日について「その日までの直近days営業日のHV」を並べた折れ線。
function hvHistoryChartHtml(days) {
  const t = activeTab();
  if (!t || !t.closesFull) return "";
  const { closes, dates } = viewDataOf(t);
  const series = computeHvSeries(closes, days, 252);
  const pos = hvPosition(closes, days);
  if (series.length < 2 || !pos) return "";
  const start = closes.length - series.length;
  const points = series.map((hv, i) => ({ date: dates[start + i], hv }));
  return `<div class="hv-history"><div class="hv-history-title">過去1年の「直近${days}営業日のHV」の推移</div>`
    + renderHvHistoryChart({ points, median: pos.median })
    + `<div class="hv-history-note">毎日の「その日までの直近${days}営業日のHV」を、約${series.length}日分並べた折れ線です。黒い点がいま、赤い点が過去1年の最大、青い点が最小、灰色の点線が中央値（ふだんの水準）です（最大がいまに近いときは、赤い点は黒い点と重なります）。線がふだん（点線）より上にあるほど、荒れている時期です。</div></div>`
    + hvCompareBlockHtml(t, closes, dates, days);
}

// 過去1年のHVの範囲を表す棒。左端=過去1年の最小、右端=過去1年の最大。黒い目印=いまのHV、灰色の縦線=中央値(ふだんの水準)。
function hvBarHtml(pos) {
  const clamp = (v) => Math.max(0, Math.min(1, v)) * 100;
  const span = pos.max - pos.min;
  const now = span > 0 ? clamp((pos.current - pos.min) / span) : 50;
  const med = span > 0 ? clamp((pos.median - pos.min) / span) : 50;
  return `<span class="hv-bar" aria-hidden="true"><span class="hv-bar-med" style="left:${med.toFixed(1)}%"></span><span class="hv-bar-now" style="left:${now.toFixed(1)}%"></span></span>`;
}

// 一番上のパネルに、最新の株価(終値)・日付・前日比を表示する。日付を指定しているときは、その日(基準日)の終値。
// データを取得していないタブでは隠す。
function renderLatestPrice(t) {
  const el = els.latestPrice;
  if (!t || !t.closesFull || t.closesFull.length < 1) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const { closes, dates } = viewDataOf(t);
  const i = closes.length - 1;
  const close = closes[i];
  const date = dates[i];
  const asOf = resolveStatusDate(t).asOf;
  let change = "";
  if (i >= 1) {
    const diff = close - closes[i - 1];
    const rate = diff / closes[i - 1];
    const sign = diff >= 0 ? "+" : "−";
    const cls = diff >= 0 ? "up" : "down";
    change = `<span class="lp-change ${cls}">前日比 ${sign}${Math.abs(diff).toFixed(2)}（${sign}${Math.abs(rate * 100).toFixed(2)}%）</span>`;
  }
  el.innerHTML = `<span class="lp-symbol">${t.symbol}</span><span class="lp-label">${asOf ? "終値" : "最新の終値"}</span>`
    + `<b class="lp-price">${close.toFixed(2)}</b><span class="lp-unit">ドル</span>`
    + `<span class="lp-date">（${date}${asOf ? "時点" : ""}）</span>${change}`;
  el.hidden = false;
}

// 「HV（歴史的ボラティリティ）」カードを描画する。基準日までの全データ(closesFull、最大800営業日)の終値から計算する。
//  1) 直近の期間ごとのHV(年率)と、過去1年の中でのいまの高さ(いまより高かった日数)
//  2) 満期(判定期間)までの1σの値動き、権利行使価格の位置(何σ外か)、HVから見た理論上の確率(目安)と、過去の実績の比較
// 理論上の確率は「株価が対数正規分布に従い、平均的な上昇・下落はない」という単純な仮定の目安で、将来を保証するものではない。
function renderHvCard(t) {
  const { closes, dates: viewDates } = viewDataOf(t);
  if (!closes || closes.length < 12) {
    els.hvCard.hidden = true;
    return;
  }
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  // 期間d営業日のHVのカード(大きな数字、過去1年の範囲の棒、幅・中央値、順位)
  const hvCardItem = (d, label, extraNote) => {
    const hv = computeHv(closes, d);
    const pos = hv === null ? null : hvPosition(closes, d);
    return {
      days: d,
      label,
      value: hv === null ? "―" : pct(hv),
      sub: pos
        ? `${hvBarHtml(pos)}<span class="hv-line">過去1年のHVの幅：${pct(pos.min, 0)}〜${pct(pos.max, 0)}（ふだん＝中央値 ${pct(pos.median, 0)}）</span><span class="hv-line">${hvPositionText(pos)}</span>`
        : "データ不足",
      note: `${extraNote}大きな数字（%）は、直近${d}営業日の、日々の騰落率のばらつきを年率に換算した値（HV）です。「直近${d}営業日」は、計算に使う期間の長さです。\n棒と「過去1年のHVの幅」： 過去1年の毎日について、その日までの直近${d}営業日のHVを計算し（約252個）、その最小〜最大を表します。棒の左端が最小、右端が最大です。黒い目印がいまのHV、灰色の縦線が中央値（ふだんの水準）です。「幅」の%も、HVの値です。\n「高い方から◯番目」： その約252個のHVを高い順に並べたとき、いまのHVが何番目かです。1番目なら、過去1年で最も荒れている時期です。`,
    };
  };
  const statHtml = (it) =>
    `<div class="stat" data-target="hvExplain" data-hv-days="${it.days}" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span><span class="stat-sub">${it.sub}</span></div>`;
  // 満期と同じ長さのHV(グラフと「1σの値動き」の計算に使う値)
  const matchDays = t.windowDays;
  els.hvMatchTitle.textContent = `満期（${matchDays}営業日）と同じ長さのHV（年率）`;
  els.hvMatchSummary.innerHTML = statHtml(hvCardItem(
    matchDays, `直近${matchDays}営業日（満期と同じ長さ）`,
    "このHVを、下のグラフと「満期までの1σの値動き」の計算に使っています。満期日を変えると、この期間の長さも変わります。\n"));

  // 満期(判定期間)までの値動きの目安
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const days = t.windowDays;
  const price = closes[closes.length - 1];
  const strike = price * t.ratio;
  const depthDollar = t.rrDepth ?? 0;
  const hvN = computeHv(closes, days);
  const theory = hvN === null ? null : hvTheory({ price, strike, depthDollar, itmWhen: type.itmWhen, days, hv: hvN });
  els.hvTheoryTitle.textContent = `満期（${days}営業日）までの値動きの目安と、権利行使価格の位置`;
  if (!theory) {
    els.hvTheorySummary.innerHTML = "";
    els.hvConeWrap.innerHTML = "";
    els.hvConeLegend.textContent = "";
    els.hvTheoryNote.textContent = "データが足りないため、表示できません。";
    els.hvCard.hidden = false;
    setupStatExplain();
    return;
  }

  // 実績(分析結果と同じ: 判定期間内に毎日の終値で一度でもITM(判定する深さ以上)に届いた割合)
  const pc = periodClosesOf(t);
  const pd = periodDatesOf(t);
  const { depthPct } = depthInfo(t, pc);
  const analysis = computeItmAnalysis(pc, {
    ratio: t.ratio, itmWhen: type.itmWhen, window: days, group, depthPct,
  }, pd);
  const actual = analysis.overallItmProb;

  const depthText = depthDollar > 0 ? `権利行使価格${type.itmWhen === "below" ? "−" : "＋"}${depthDollar}ドル` : "権利行使価格";
  const dist = theory.distancePct;
  const sideText = theory.zScore >= 0 ? "OTM側" : "ITM側";
  const items = [
    {
      label: `満期までの1σの値動き`, value: `±${theory.sigmaAmount.toFixed(2)}ドル`,
      sub: `±${pct(theory.sigmaPct)}（直近${days}営業日のHV ${pct(hvN)}×√(${days}/252)）`,
      note: `直近${days}営業日（満期までの営業日数と同じ長さ）のHVから見た、満期までの1σ（標準偏差）の値動きです。株価の変動が正規分布に近いと仮定すると、満期時の株価が現在値±この幅に収まる確率は約68%です。\n1σ＝現在値×HV×√(営業日数÷252)。目安であり、将来を保証するものではありません。`,
    },
    {
      label: `ITMの水準の位置`, value: `${dist >= 0 ? "+" : ""}${pct(dist)}`,
      sub: `${depthText}＝${theory.barrier.toFixed(2)}・${Math.abs(theory.zScore).toFixed(2)}σ（${sideText}）`,
      note: `ITMとみなす水準（${depthText}）が、現在値から何%離れているか、またそれがHVから見て何σ分の距離かを表します。\nσの値が大きいほど、HVから見てITMになりにくい水準です。「OTM側」は現在値よりITMの反対側、「ITM側」はすでにITMの側にあることを表します。\n水準は、現在値×権利行使価格の比率（上の入力欄の比率）から求めています。`,
    },
    {
      label: `HV換算の理論上の確率（満期時にITM）`, value: pct(theory.probItmAtExpiry),
      sub: `期間中に一度でも届く目安 約${pct(theory.probTouch, 0)}`,
      note: `HVから、満期時にITMの水準を超えている（プット系は下回る、コール系は上回る）確率を、正規分布の近似で求めたものです。\n「期間中に一度でも届く」目安は、満期時の確率の2倍（上限100%）で、毎日の終値だけを見る実績よりやや多めに出ます。\n株価の平均的な上昇・下落はないと仮定した単純な近似です。将来を保証するものではありません。`,
    },
    {
      label: `過去の実績（ITM発生率）`, value: actual === null ? "―" : pct(actual),
      sub: `分析結果と同じ値（判定期間内に一度でも届いた割合）`,
      note: `「分析結果」のITM発生エントリー数の割合と同じ値です。判定期間${days}営業日のあいだに、毎日の終値で一度でもITMの水準に届いたエントリー日の割合です。`,
    },
  ];
  // グラフ: 直近の株価の推移 + いまから満期まで広がる±1σ・±2σの範囲 + ITMの水準
  const asOfDate = viewDates[viewDates.length - 1];
  const expiryDate = shiftTradingDays(asOfDate, -days);
  els.hvConeWrap.innerHTML = renderConeChart({
    pastCloses: closes.slice(-61), price, days, sigmaPct: theory.sigmaPct, barrier: theory.barrier, itmWhen: type.itmWhen,
    nowLabel: `いま（${asOfDate.slice(5)}）`, expiryLabel: `満期 ${expiryDate.slice(5)}（${days}営業日後）`,
    barrierLabel: `ITMの水準 ${theory.barrier.toFixed(2)}（${dist >= 0 ? "+" : ""}${pct(dist)}・${Math.abs(theory.zScore).toFixed(2)}σ${theory.zScore >= 0 ? "外" : "内"}）`,
  });
  els.hvConeLegend.textContent = `濃い帯＝±1σ（満期時に約68%がこの範囲）、薄い帯＝±2σ（約95%）。赤い破線＝ITMの水準、その先の薄い赤＝ITM側。帯は、直近${days}営業日のHVから求めた目安で、いまの株価（黒い点）から満期まで広がります。`;
  els.hvTheorySummary.innerHTML = items.map((it) =>
    `<div class="stat" data-target="hvExplain" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span><span class="stat-sub">${it.sub}</span></div>`
  ).join("");

  let compare = "";
  if (actual !== null && theory.probTouch > 0) {
    const ratio = actual / theory.probTouch;
    const word = ratio < 0.8 ? "少なく" : ratio > 1.25 ? "多く" : "同じくらいに";
    const meaning = ratio < 0.8
      ? (group === "sell" ? "過去は、HVから見た理論より穏やかな値動きで、売りには有利な側にずれていました。" : "過去は、HVから見た理論より届きにくく、買いには不利な側にずれていました。")
      : ratio > 1.25
        ? (group === "sell" ? "過去は、HVから見た理論より届きやすく、売りには不利な側にずれていました。" : "過去は、HVから見た理論より届きやすく、買いには有利な側にずれていました。")
        : "過去の実績は、HVから見た理論と、ほぼ合っていました。";
    compare = `過去の実績（${pct(actual)}）は、理論上の「期間中に一度でも届く目安」（約${pct(theory.probTouch, 0)}）より${word}なっています。${meaning}`;
  }
  // いまのHVが過去1年の中で高い/低い位置にあるときは、実績との差の理由として添える
  let regime = "";
  const posN = hvPosition(closes, days);
  if (posN) {
    if (posN.percentile >= 0.8) regime = `直近${days}営業日のHV（${pct(hvN)}）について、${hvPositionText(posN)}。過去の平均より荒れている時期です。理論と実績の差には、この影響が考えられます。`;
    else if (posN.percentile <= 0.2) regime = `直近${days}営業日のHV（${pct(hvN)}）について、${hvPositionText(posN)}。過去の平均より穏やかな時期です。理論と実績の差には、この影響が考えられます。`;
  }
  els.hvTheoryNote.textContent = `${compare}${compare ? " " : ""}${regime}${regime ? " " : ""}※HVは過去の値動きの大きさで、IV（オプション価格に織り込まれた将来の変動の大きさ）ではありません。理論上の確率は単純な近似の目安です。`;
  els.hvCard.hidden = false;
  setupStatExplain();
}

// 「本日の状況」を、入力された過去の日付の時点で見るための基準日を決める。
// 入力日が休場日なら、その日以前で最も近い営業日にする。データの最初より前の日付は使えない。
// 戻り値: {endIdx(closesFull上の基準日の位置), asOf(基準日。本日のときnull), hint(補足文)}
function resolveStatusDate(t) {
  const last = t.closesFull.length - 1;
  const want = t.statusDate;
  if (!want) return { endIdx: last, asOf: null, hint: "" };
  const first = t.datesFull[0];
  if (want < first) {
    return { endIdx: last, asOf: null, hint: `データは${first}以降です。本日の状況を表示しています` };
  }
  let idx = last;
  while (idx > 0 && t.datesFull[idx] > want) idx--;
  if (idx === last && t.datesFull[last] <= want) {
    return { endIdx: last, asOf: null, hint: want === t.datesFull[last] ? "" : `${t.datesFull[last]}が最新のため、本日の状況を表示しています` };
  }
  const actual = t.datesFull[idx];
  return { endIdx: idx, asOf: actual, hint: actual === want ? "" : `${want}は休場日のため、直前の営業日${actual}を表示しています` };
}

function renderTodayCard(t) {
  const { endIdx, asOf, hint } = resolveStatusDate(t);
  // 基準日までのデータだけを使い、集計期間の長さで末尾を切り出す(本日のときは従来と同じ)
  const upto = t.closesFull.slice(0, endIdx + 1);
  const uptoDates = t.datesFull.slice(0, endIdx + 1);
  const closes = upto.slice(-t.periodDays);
  const dates = uptoDates.slice(-t.periodDays);
  els.todayTitle.textContent = asOf ? `${asOf} 時点の状況` : "本日の状況";
  els.statusDateInput.min = t.datesFull[0];
  els.statusDateInput.max = t.datesFull[t.datesFull.length - 1];
  els.statusDateReset.hidden = !t.statusDate;
  els.statusDateHint.textContent = hint;
  const latestIdx = closes.length - 1;
  const latestClose = closes[latestIdx];
  const strike = latestClose * t.ratio;

  els.todayDate.textContent = closes.length.toLocaleString("ja-JP");
  els.todayRange.textContent = `${dates[0]} 〜 ${dates[latestIdx]}`;
  els.todayClose.textContent = latestClose.toFixed(2);
  els.todayCloseDate.textContent = dates[latestIdx];
  els.todayStrike.textContent = strike.toFixed(2);

  const strip = computeRecentMomentumStrip(closes, 7);
  els.momentumStrip.innerHTML = strip.map(({ daysAgo, change }) => {
    const cls = change === null ? "" : change >= 0 ? "up" : "down";
    const text = change === null ? "―" : (change >= 0 ? "+" : "") + (change * 100).toFixed(1) + "%";
    return `<div class="momentum-cell"><span class="m-label">${daysAgo}営業日前比</span><span class="m-value ${cls}">${text}</span></div>`;
  }).join("");

  els.todayCard.hidden = false;
}

// 判定する深さ(ドル)を、現在の権利行使価格(本日の終値×比率)に対する割合に換算する。
// 過去の各エントリーにも同じ割合を当てはめる(過去の株価水準が今と違っても公平に比べられるように
// するため)。分析結果・エントリー条件で絞り込みなどで共通に使う。
function depthInfo(t, closes) {
  const depthDollar = t.rrDepth ?? 0;
  const todayStrike = closes[closes.length - 1] * t.ratio;
  const depthPct = todayStrike > 0 ? depthDollar / todayStrike : 0;
  return { depthDollar, todayStrike, depthPct };
}

// 判定する深さを入力しているとき、ラベルに付ける「（◯ドル）」。空欄(0ドル)なら空文字。
function depthSuffixOf(t) {
  const d = t.rrDepth ?? 0;
  return d > 0 ? `（${d}ドル）` : "";
}

// 売り系で「判定する深さ」を入力しているとき、総合判定の下に「深さに届くと1契約あたり◯ドルの損失リスク」を
// 表示する。深さを深くするほど届く割合は下がって判定は良く見えるが、届いたときの損失は大きくなるため、
// その重さを金額で示す。金額は深さ×100株(1契約)で、受取プレミアムは差し引かない。
// スプレッド(ブルプット/ベアコール)は、差額を入力済みなら差額×100株で頭打ちにする。買い系は表示しない。
const SHARES_PER_CONTRACT = 100;
function renderDepthRisk(t, analysis, depthDollar, group) {
  const box = els.depthRiskBox;
  if (group !== "sell" || !(depthDollar > 0)) {
    box.hidden = true;
    els.depthRiskLine.textContent = "";
    return;
  }
  const money = (v) => v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  const width = t.rrVariant === "spread" ? t.rrSpreadWidth : null;
  const capped = width !== null && width > 0 && depthDollar > width;
  const rate = analysis.overallItmProb === null
    ? "―"
    : (analysis.overallItmProb * 100).toFixed(1) + "%";
  const freq = `過去の実績では、判定期間内に${rate}（${analysis.itmEntryCount.toLocaleString("ja-JP")}/${analysis.entryCount.toLocaleString("ja-JP")}件）の割合で届きました。`;
  const head = capped
    ? `ITM（${money(depthDollar)}ドル）に届くと、損失はスプレッドの上限（権利行使価格の差額${money(width)}ドル）で頭打ちとなり、1契約（${SHARES_PER_CONTRACT}株）あたり最大${money(width * SHARES_PER_CONTRACT)}ドルの損失リスクを負います。`
    : `ITM（${money(depthDollar)}ドル）に届くと、1契約（${SHARES_PER_CONTRACT}株）あたり${money(depthDollar * SHARES_PER_CONTRACT)}ドルの損失リスクを負います。`;
  els.depthRiskLine.textContent = `${head}${freq}`;
  box.hidden = false;
}

function renderMainAnalysis(t) {
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const { depthDollar, todayStrike, depthPct } = depthInfo(t, closes);
  const analysis = computeItmAnalysis(closes, {
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    group: typeGroup(t.typeKey),
    depthPct,
  }, dates);

  els.rrDepthPct.textContent = depthDollar > 0
    ? `＝ 権利行使価格の約${(depthPct * 100).toFixed(2)}%（現在の権利行使価格${todayStrike.toFixed(2)}に対して）`
    : "＝ 0%（一度でもITMになれば該当）";
  const depthTitle = depthSuffixOf(t);
  document.querySelectorAll(".dep-sfx").forEach((el) => { el.textContent = depthTitle; });
  // ITM/OTM表示の切替。OTM表示のときの「OTM」は、深さを入力していれば「その深さのITMではなかった」こと
  const otmMode = !!t.otmView;
  const kindTitle = otmMode ? "OTM" : "ITM";
  const kindDepth = otmMode ? (depthDollar > 0 ? `（ITM${depthDollar}ドル未満）` : "") : depthTitle;
  els.dayProbKind.textContent = kindTitle;
  els.heatmapKind.textContent = kindTitle;
  els.dayProbDepth.textContent = kindDepth;
  els.heatmapDepth.textContent = kindDepth;
  els.otmToggleBtn.textContent = otmMode ? "ITM確率に切替" : "OTM確率に切替";
  els.otmToggleBtn.setAttribute("aria-pressed", otmMode ? "true" : "false");
  els.otmToggleBtn.classList.toggle("active", otmMode);

  els.symbolLabel.textContent = t.symbol;
  els.resultTypeLabel.textContent = `：${type.label}、×${t.ratio}${asOfSuffixOf(t)}`;
  els.badge.textContent = analysis.badge;
  els.badge.className = "badge " + badgeLevelClass(analysis.badgeLevel);
  els.entryCount.textContent = analysis.entryCount.toLocaleString("ja-JP");
  els.itmCount.textContent = analysis.itmEntryCount.toLocaleString("ja-JP");
  els.totalItmDays.textContent = analysis.totalItmDays.toLocaleString("ja-JP");
  els.overallProb.textContent = analysis.overallItmProb === null
    ? "―"
    : (analysis.overallItmProb * 100).toFixed(1) + "%";
  const group = typeGroup(t.typeKey);
  renderRecoveryStats(closes, t, type, depthPct, group);
  els.chartWrap.innerHTML = renderDayProbChart(analysis.dayProb, group, otmMode ? "otm" : "itm");
  els.heatmapWrap.innerHTML = renderEntryHeatmap(analysis.perEntry, t.windowDays, group,
    depthDollar > 0 ? (otmMode ? `／OTM＝ITM(${depthDollar}ドル以上)ではなかった日` : `(${depthDollar}ドル以上)`) : "",
    otmMode ? "otm" : "itm");
  hideCellTip();
  renderDepthRisk(t, analysis, depthDollar, group);
  els.badgeLegend.innerHTML = renderBadgeLegend(group);
  els.dayProbLegend.innerHTML = renderColorLegend(otmMode ? OTM_RATE_BANDS[group] : DAY_PROB_BANDS[group]);
  els.entryHeatmapLegend.innerHTML = renderColorLegend(otmMode ? OTM_RATE_BANDS[group] : ENTRY_HEATMAP_BANDS[group]);
  els.depthHeatmapWrap.innerHTML = renderDepthHeatmap(analysis.perEntry, t.windowDays, group,
    { depthPct, depthDollar });
  els.depthHeatmapLegend.innerHTML = renderColorLegend(DEPTH_HEATMAP_BANDS[group])
    + (depthDollar > 0
      ? `<span class="hm-cell hm-mark" style="background:var(--card)"></span><span>判定する深さ（${depthDollar}ドル）に届いた日</span>`
      : "");
  els.otmHeatmapWrap.innerHTML = renderOtmHeatmap(analysis.perEntry, t.windowDays, group);
  els.otmHeatmapLegend.innerHTML = renderColorLegend(OTM_HEATMAP_BANDS[group]);
  els.result.hidden = false;
}

// 参考値: 判定する深さに届いたエントリーが、その後OTMに戻るまでの営業日数(平均・中央値)と、
// 判定期間の最終日までOTMに戻らなかった割合。勝率や総合判定の計算には使わない。
// (以前はリスクリワード分析にあった指標。Ver2ではリスクリワード分析を廃止し、分析結果に移した)
function renderRecoveryStats(closes, t, type, depthPct, group) {
  const res = summarizeDepthResults(
    computeDepthEntryResults(closes, baseEntryIndices(closes, t.windowDays),
      { ratio: t.ratio, itmWhen: type.itmWhen, window: t.windowDays, depthPct }), group);
  const { hitCount, recoveredCount, unrecoveredCount, avgRecoveryDays, medianRecoveryDays } = res;
  els.recoveryAvg.textContent = avgRecoveryDays === null ? "―" : avgRecoveryDays.toFixed(1) + "日";
  els.recoveryAvgSub.textContent = avgRecoveryDays === null
    ? (hitCount > 0 ? "OTMに戻ったエントリーなし" : "深さに届いたエントリーなし")
    : `中央値${Number.isInteger(medianRecoveryDays) ? medianRecoveryDays : medianRecoveryDays.toFixed(1)}日・戻った${recoveredCount}件の平均`;
  els.recoveryUnrec.textContent = hitCount > 0 ? (unrecoveredCount / hitCount * 100).toFixed(1) + "%" : "―";
  els.recoveryUnrecSub.textContent = hitCount > 0 ? `${unrecoveredCount}件/${hitCount}件` : "";
  els.recoveryAvgStat.dataset.note = group === "sell"
    ? "設定した深さに初めて届いた日から、初めてOTMに戻った日までの営業日数の平均です(参考値)。\n「深さに届いても、平均で◯日待てばOTMに戻る」という目安になり、売り建玉を持ち続けて待つ判断の材料になります。\n期間内にOTMに戻らなかったエントリーは平均・中央値に含めていません。右の「OTMに戻らなかった割合」と合わせて見てください。\n総合判定の計算には使っていません。"
    : "設定した深さに初めて届いた日から、初めてOTMに戻った日までの営業日数の平均です(参考値)。\n買いでは「利益が出る深さに届いた後、平均で何日その状態が続いたか(OTMに戻るまで)」という意味になります。\n期間内にOTMに戻らなかったエントリーは平均・中央値に含めていません。\n総合判定の計算には使っていません。";
  els.recoveryUnrecStat.dataset.note = group === "sell"
    ? "設定した深さに届いたエントリーのうち、判定期間の最終日までOTMに戻らなかった割合です(参考値)。\n「待てば戻る」とは言えなかったケースの割合で、この割合が高いと、待つ戦略は危険です。"
    : "設定した深さに届いたエントリーのうち、判定期間の最終日までOTMに戻らなかった(ITMのまま終わった)割合です(参考値)。";
}

// 総合判定バッジの7段階配色の凡例(選択中のタイプのラベルで表示)
function renderBadgeLegend(group) {
  const labels = BADGE_LABELS[group] || BADGE_LABELS.sell;
  const items = labels.map((label, i) => {
    return `<span class="badge b${i}" style="padding:2px 8px;font-size:11px">${label}</span>`;
  }).join("");
  return `<span>総合判定の凡例（左が有利／右が不利）：</span>${items}`;
}

// 色つき帯グラフ(営業日ごとのITM確率・エントリー日ごとのITM状況)共通の凡例
function renderColorLegend(bands) {
  const items = bands.map((b) => {
    return `<span class="hm-cell" style="background:${b.color}"></span><span>${b.label}</span>`;
  }).join("");
  return items;
}

function renderConditionCard(t) {
  const closes = periodClosesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const { depthPct } = depthInfo(t, closes);

  const conditional = computeConditionalItmAnalysis(closes, {
    depthPct,
    ratio: t.ratio,
    itmWhen: type.itmWhen,
    window: t.windowDays,
    conditionMode: t.conditionMode,
    momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
  });

  els.matchedCount.textContent = conditional.matchedCount.toLocaleString("ja-JP");
  els.matchedItmCount.textContent = conditional.matchedItmCount.toLocaleString("ja-JP");
  els.matchedTotalItmDays.textContent = conditional.matchedTotalItmDays.toLocaleString("ja-JP");
  els.matchedProb.textContent = conditional.matchedItmProb === null
    ? "―"
    : (conditional.matchedItmProb * 100).toFixed(1) + "%";

  const thresholdFrac = t.momentumThresholdPct / 100;
  const latestIdx = closes.length - 1;
  let todayMatches;
  if (t.conditionMode === "countWithin7") {
    let hitDays = 0;
    let anyData = false;
    for (let k = 1; k <= 7; k++) {
      const m = computeMomentum(closes, latestIdx, k);
      if (m === null) continue;
      anyData = true;
      const hit = t.momentumDirection === "down" ? m <= -thresholdFrac : m >= thresholdFrac;
      if (hit) hitDays++;
    }
    todayMatches = !anyData ? null : hitDays >= t.minMatchDays;
  } else {
    const todayMomentum = computeMomentum(closes, latestIdx, t.momentumLookback);
    todayMatches = todayMomentum === null ? null
      : t.momentumDirection === "down" ? todayMomentum <= -thresholdFrac : todayMomentum >= thresholdFrac;
  }

  els.todayMatchBadge.textContent = todayMatches === null ? "データ不足" : todayMatches ? "該当する" : "該当しない";
  els.todayMatchBadge.className = "badge " + (todayMatches === null ? "b-neutral" : todayMatches ? "b-match" : "b-nomatch");

  els.conditionCard.hidden = false;
}

// プット売り(単体)の株購入価格は、権利行使される価格＝現在の権利行使価格(本日の終値×比率)
// そのものなので、入力させず自動で使う。
function isAutoStockPrice(typeKey, variant) {
  return typeKey === "put_sell" && variant === "naked";
}

// 注文内容の最大損失額の計算に使う「満期まで保有した場合の損失の基準額」。
//   プット売り(単体): 株購入価格＝現在の権利行使価格(自動)
//   売り系スプレッド(ブルプット/ベアコール): 権利行使価格の差額(スプレッド幅)
//   コール売り(単体): 損失無限大のため使わない(null)
function lossBasisOf(t) {
  if (isAutoStockPrice(t.typeKey, t.rrVariant)) {
    return todayStrikeOf(t);
  }
  if (t.rrVariant === "spread") return t.rrSpreadWidth;
  return null;
}

// 注文時のプレミアム額。売り系は受取プレミアム額、買い系は支払いプレミアム額。
function premiumOf(t) {
  return typeGroup(t.typeKey) === "sell" ? t.rrPremium : t.rrPayPremium;
}

// 売り/買い・単体/SPで使う入力欄が違うため、body属性に現在の状態を書き込み、
// CSS(data-only属性)で表示する欄を切り替える(使わない欄は非表示にし、値は保持する)。
function updateRiskRewardInputUI(typeKey, variant) {
  const group = typeGroup(typeKey);
  document.body.dataset.group = group;
  document.body.dataset.mode = variant === "spread" ? "sp" : "naked";

  const labels = RISK_VARIANT_LABELS[typeKey] || RISK_VARIANT_LABELS.put_sell;
  els.spBtn.textContent = variant === "spread" ? `${labels.naked}へ切替` : `${labels.spread}へ切替`;
  els.spBtn.setAttribute("aria-pressed", variant === "spread" ? "true" : "false");
  els.spBtn.classList.toggle("active", variant === "spread");
}

// 現在の権利行使価格(本日の終値×比率)。データ未取得ならnull。
function todayStrikeOf(t) {
  if (!t.closesFull || !t.closesFull.length) return null;
  const c = viewDataOf(t).closes;
  return c[c.length - 1] * t.ratio;
}

// 「注文内容」カードを描画する。注文の条件(取引タイプ・プレミアム・満期までの営業日数など)を
// 1行にまとめて表示し、満期時の損益分岐点もここに表示する。
function renderOrderCard(t) {
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const isSp = t.rrVariant === "spread";
  const labels = RISK_VARIANT_LABELS[t.typeKey] || RISK_VARIANT_LABELS.put_sell;
  const { todayStrike } = depthInfo(t, closes);
  const latest = closes[closes.length - 1];

  els.orderTypeLabel.textContent = `：${isSp ? labels.spread : labels.naked}${asOfSuffixOf(t)}`;
  els.orderTicker.textContent = t.symbol || "―";
  els.orderClose.textContent = `最新終値 ${latest.toFixed(2)}（${dates[dates.length - 1]}）`;
  els.orderDepthPct.textContent = els.rrDepthPct.textContent;

  const fmt = (v) => v.toFixed(2);
  // 売り系スプレッド(ブルプット/ベアコール)は、最大損失額(差額−受取プレミアム額)を利確割合の右に表示する
  const showMaxLoss = group === "sell" && isSp;
  els.orderMaxLossField.hidden = !showMaxLoss;
  if (showMaxLoss) {
    const width = lossBasisOf(t);
    if (width !== null && t.rrPremium !== null) {
      els.orderMaxLoss.textContent = fmt(width - t.rrPremium);
      els.orderMaxLossHint.textContent = `差額${fmt(width)}−受取${fmt(t.rrPremium)}`;
    } else {
      els.orderMaxLoss.textContent = "―";
      els.orderMaxLossHint.textContent = "差額と受取プレミアム額を入力すると表示";
    }
  }
  const pc = type.itmWhen === "below" ? "P" : "C";
  let strikeText;
  if (!isSp) {
    strikeText = `権利行使価格${fmt(todayStrike)}ドル`;
  } else {
    // 比率で決まる権利行使価格(売り系は売り建て側、買い系は買い建て側)と、差額分だけ離れたもう一方の脚。
    // プット系はもう一方が安い側、コール系は高い側。
    const w = t.rrSpreadWidth;
    const far = w === null ? null : (pc === "P" ? todayStrike - w : todayStrike + w);
    const farText = far === null ? "―" : fmt(far);
    strikeText = group === "sell"
      ? `${fmt(todayStrike)}${pc}売/${farText}${pc}買`
      : `${fmt(todayStrike)}${pc}買/${farText}${pc}売`;
  }
  const premium = premiumOf(t);
  const parts = [
    isSp ? labels.spread : labels.naked,
    strikeText,
    `満期まで${t.windowDays}営業日（${shiftTradingDays(dates[dates.length - 1], -t.windowDays)}）`,
    premium === null ? "プレミアム価格 未入力" : `プレミアム価格${fmt(premium)}ドル`,
  ];
  if (group === "sell") {
    const wari = profitPercentOf(t) / 10;
    parts.push(`${Number.isInteger(wari) ? wari : wari.toFixed(1)}割利確`);
  }
  els.orderLine.textContent = parts.join("　");

  if (group === "sell") {
    renderOrderExit(t, dates[dates.length - 1]);
    renderStressTest(t, latest, type.itmWhen);
  }
  renderBreakEvenPrice(t, closes, todayStrike);
  els.orderCard.hidden = false;
}

// 利確割合(%)。未入力のときは講座の基準の80%(8割利確=2割を支払って決済)。
const DEFAULT_PROFIT_PERCENT = 80;
function profitPercentOf(t) {
  return t.rrProfitRatio === null ? DEFAULT_PROFIT_PERCENT : t.rrProfitRatio;
}

// ロスカット逆指値の倍率(受取プレミアムに対して)。講座の基準は1.9〜2倍。
const STOP_MULTIPLE_MIN = 1.9;
const STOP_MULTIPLE_MAX = 2;
const SHARES_PER_CONTRACT_ORDER = 100;

// 売り系の「決済の目安」と「満期日の候補」を描画する(講座のルールをそのまま数字にしたもの)。
//  - 利確: 受取プレミアムの利確割合(基準8割)を残す=買い戻しの指値は 受取×(1−利確割合)
//  - ロスカット: 受取プレミアムの1.9〜2倍の逆指値(発動時の損失は受取プレミアム分に近い額)
//  - 満期日の候補: 基準日から30〜45暦日後の金曜。2週間(10営業日)前に利確か継続かを判断、3営業日前までに決済
// プレミアムは1株あたりの額。受取プレミアム未入力のときは、金額の項目を「―」にする。
function renderOrderExit(t, asOfDate) {
  const premium = t.rrPremium;
  const ratio = profitPercentOf(t);
  const hasPremium = premium !== null && premium >= 0;
  const money = (v) => v.toFixed(2);
  const perContract = (v) => (v * SHARES_PER_CONTRACT_ORDER).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  const noInput = "受取プレミアム額を入力すると表示";
  const ratioNote = t.rrProfitRatio === null ? `（利確割合が未入力のため、講座の基準${DEFAULT_PROFIT_PERCENT}%で計算）` : "";

  const items = [
    {
      label: "利確の支払い価格(買い戻しの指値)",
      value: hasPremium ? money(premium * (1 - ratio / 100)) : "―",
      sub: hasPremium ? `受取${money(premium)}×(1−${ratio}%)${ratioNote}` : noInput,
      note: "反対売買（買い戻し）で決済するときの指値価格です。受取プレミアム×(1−利確割合)。\n注文が約定したらすぐに、この価格で利確注文を出しておきます（講座の基準は、受取りの2割を支払う＝8割を手元に残す）。\nスプレッドの場合は、2つの脚の差し引き後の価格で出します。\n1株あたりの価格で、手数料は含みません。",
    },
    {
      label: "利確したときの利益額",
      value: hasPremium ? money(premium * ratio / 100) : "―",
      sub: hasPremium ? `100株(1契約)で${perContract(premium * ratio / 100)}ドル` : noInput,
      note: "利確の支払い価格で決済できた場合に、手元に残る利益額（1株あたり）です。受取プレミアム×利確割合。手数料は含みません。",
    },
    {
      label: "ロスカットの逆指値価格",
      value: hasPremium ? `${money(premium * STOP_MULTIPLE_MIN)}〜${money(premium * STOP_MULTIPLE_MAX)}` : "―",
      sub: hasPremium ? `受取${money(premium)}の${STOP_MULTIPLE_MIN}〜${STOP_MULTIPLE_MAX}倍` : noInput,
      note: "ロスカット（損切り）を逆指値の注文で出すときの価格の目安です。講座の基準は、受取プレミアムの1.9〜2倍です。\n現在値がこの価格を超えたときに、買い戻しの注文が出ます。\n逆指値は、発動した後に指定価格より不利な価格で約定することがあります。\nロスカットを入れるかどうか、倍率を何倍にするかは、ご自身のリスク許容度で決めてください。",
    },
    {
      label: "ロスカット時の損失額",
      value: hasPremium ? `${money(premium * (STOP_MULTIPLE_MIN - 1))}〜${money(premium * (STOP_MULTIPLE_MAX - 1))}` : "―",
      sub: hasPremium ? `100株(1契約)で${perContract(premium * (STOP_MULTIPLE_MIN - 1))}〜${perContract(premium * (STOP_MULTIPLE_MAX - 1))}ドル` : noInput,
      note: "逆指値の価格で決済できた場合の損失額（1株あたり）です。逆指値の価格−受取プレミアム。\n2倍で決済すると、受け取ったプレミアムと同じ額の損失になります。\n実際の約定価格がずれた場合は、この額と異なります。手数料は含みません。",
    },
  ];
  els.orderExitSummary.innerHTML = items.map((it) =>
    `<div class="stat" data-target="orderExplain" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span>`
    + (it.sub ? `<span class="stat-sub">${it.sub}</span>` : "") + `</div>`
  ).join("");
  els.orderExitNote.textContent = "講座の基準: 利確は受取りの8割（2割を支払って買い戻し）が基本です。サクソバンクでは利確注文とロスカット注文を同時に出せないため、利確注文を基本にして、ロスカットは株価や証拠金使用率を見ながらご自身で判断します。";

  // 満期日と、決済の目安日(基準日 = 最新の終値の日。満期日は入力欄の満期日)
  const days = t.windowDays;
  const expiry = shiftTradingDays(asOfDate, -days);
  const cal = calendarDaysBetween(asOfDate, expiry);
  const fmtDate = (d) => `${d}（${WEEKDAY_JA[weekday(d)]}）`;
  const reviewDate = days > 10 ? shiftTradingDays(expiry, 10) : null;
  const closeDate = shiftTradingDays(expiry, 3);
  const dateItems = [
    {
      label: "満期日", value: fmtDate(expiry), sub: `残り${days}営業日（${cal}暦日）・${EXPIRY_KIND_LABEL[expiryKind(expiry)]}`,
      note: "上の「満期日（判定期間）」で入力した満期日です。基準日（最新の終値の日）から、この営業日数後になります。\n実際にその満期日があるかは、銘柄ごとに異なります。証券会社のオプションチェーンで確認してください。",
    },
    {
      label: "2週間前の判断日", value: reviewDate === null ? "―" : fmtDate(reviewDate),
      sub: reviewDate === null ? "満期まで10営業日以内のため、ありません" : "満期まで残り10営業日",
      note: "満期まで残り10営業日（約2週間）になる日です。この時点で利益が出ていれば、利確するか、取引を継続するかを検討する目安日です。\n満期が近いほど、株価が急に動いたときに回復を待つ期間が短くなります。",
    },
    {
      label: "3日前の決済日", value: fmtDate(closeDate), sub: "満期の3営業日前",
      note: "満期の3営業日前です（金曜満期なら火曜日）。遅くともこの日までに、反対売買で決済します。",
    },
  ];
  els.expirySummary.innerHTML = dateItems.map((it) =>
    `<div class="stat" data-target="orderExplain" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span><span class="stat-sub">${it.sub}</span></div>`
  ).join("");
  els.expiryNote.textContent =
    `${EXPIRY_KIND_NOTE[expiryKind(expiry)]}実際にあるかは、証券会社のオプションチェーンで確認してください。`
    + (cal > GUIDE_MAX_CALENDAR_DAYS ? " 講座の満期の目安（約60暦日まで）を超えています。" : "")
    + " 休場日は、毎年決まっている祝日のみ反映しています（臨時の休場は反映されません）。";
}

// 「株価が動いたときの現在値の目安(ストレステスト)」を描画する(売り系のみ)。
// 売りポジションを今すぐ買い戻すときに必要な価格(現在値)が、株価の下落(コール系は上昇)とIVの上昇でどうなるかを、
// Black-Scholes(金利0・配当なし)で再計算した目安。IVは、入力があればそれを使い、なければ入力した受取プレミアム額から逆算する。
// 損益は「受取プレミアム額−そのときの現在値」(受取プレミアム額が未入力のときは、IVから計算した理論値を受取額の代わりに使う)。
const STRESS_SHOCK_STEPS = [0, 0.05, 0.10, 0.15, 0.20];
const STRESS_IV_UPS = [0, 0.10, 0.20];

function renderStressTest(t, price, itmWhen) {
  const kind = itmWhen === "below" ? "put" : "call";
  const isSp = t.rrVariant === "spread";
  const sign = kind === "put" ? -1 : 1;
  const dirText = kind === "put" ? "下がった" : "上がった";
  els.stressIntro.textContent = `株価が${dirText}とき（IVも同時に上がる場合を含む）に、いま買い戻すのに必要な価格（現在値）と、そのときの損益の目安です。満期まで${t.windowDays}営業日の状態を基準にしています。`;
  const clear = (msg) => {
    els.stressHead.innerHTML = "";
    els.stressBody.innerHTML = "";
    els.stressNote.textContent = msg;
  };
  const premium = t.rrPremium !== null && t.rrPremium > 0 ? t.rrPremium : null;
  const ivSell = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  const ivBuy = t.rrIvBuy !== null && t.rrIvBuy > 0 ? t.rrIvBuy / 100 : null;
  if (isSp && !(t.rrSpreadWidth > 0)) { clear("権利行使価格の差額を入力すると表示します。"); return; }
  if (premium === null && ivSell === null) { clear("受取プレミアム額、またはIV（売り建て側）を入力すると表示します。"); return; }

  const strikeSell = price * t.ratio;
  const strikeBuy = isSp ? (kind === "put" ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
  if (strikeBuy !== null && !(strikeBuy > 0)) { clear("権利行使価格の差額が大きすぎます（買い建て側の権利行使価格が0以下になります）。"); return; }
  const res = stressTest({
    kind, price, strikeSell, strikeBuy, days: t.windowDays, premium, ivSell, ivBuy,
    shocks: STRESS_SHOCK_STEPS.map((s) => s * sign), ivUps: STRESS_IV_UPS,
  });
  if (!res) { clear("受取プレミアム額に合うIVが見つかりませんでした。受取プレミアム額（スプレッドは差し引き後の正味の額）や権利行使価格の差額を、確認してください。"); return; }

  const { rows, meta } = res;
  if (meta.source === "input" && meta.v0 <= 0) {
    clear(`入力したIV（売り建て側 ${(meta.ivSell * 100).toFixed(1)}%、買い建て側 ${(meta.ivBuy * 100).toFixed(1)}%）の組み合わせでは、スプレッドの価格が0以下になります（買い建て側のほうが高くなる）。IVの差が大きすぎないか、確認してください。`);
    return;
  }
  const received = meta.received;
  const stopMin = received * 1.9;
  const maxValue = meta.width === null ? null : meta.width * 0.98;
  const money = (v) => v.toFixed(2);
  const pnlText = (pnl) => `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}（100株で${pnl >= 0 ? "+" : "−"}${Math.abs(pnl * 100).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル）`;
  els.stressHead.innerHTML = `<tr><th>株価の変化</th><th>株価</th>${STRESS_IV_UPS.map((up) =>
    `<th>${up === 0 ? "IVは変わらない" : `IVが＋${Math.round(up * 100)}ポイント`}<br><span class="stress-sub">IV ${((meta.ivSell + up) * 100).toFixed(1)}%</span></th>`).join("")}</tr>`;
  els.stressBody.innerHTML = rows.map((r) => {
    const label = r.shock === 0 ? "いま" : `${r.shock > 0 ? "+" : "−"}${Math.abs(r.shock * 100).toFixed(0)}%`;
    return `<tr><td>${label}</td><td>${money(r.price)}</td>${r.cells.map((c) => {
      const stop = c.value >= stopMin;
      const nearMax = maxValue !== null && c.value >= maxValue;
      const cls = nearMax ? "stress-max" : stop ? "stress-stop" : "";
      return `<td class="${cls}"><b>${money(c.value)}</b><br><span class="stress-pnl ${c.pnl < 0 ? "neg" : ""}">${pnlText(c.pnl)}</span></td>`;
    }).join("")}</tr>`;
  }).join("");

  const ivText = meta.source === "input"
    ? `IVは入力値を使っています（売り建て側 ${(meta.ivSell * 100).toFixed(1)}%${isSp ? `、買い建て側 ${(meta.ivBuy * 100).toFixed(1)}%${ivBuy === null ? "（売り建て側と同じ）" : ""}` : ""}）。`
    : `IVは、受取プレミアム額${money(premium)}に合うように逆算した ${(meta.ivSell * 100).toFixed(1)}%（売り脚・買い脚とも同じ）を使っています。`;
  const receivedText = premium === null
    ? `受取プレミアム額が未入力のため、IVから計算した理論値 ${money(meta.v0)} を受取額の代わりにしています。`
    : (meta.source === "input" && Math.abs(meta.v0 - premium) > Math.max(0.05, premium * 0.15)
      ? `※入力したIVから計算した現在値（理論値 ${money(meta.v0)}）と、入力した受取プレミアム額 ${money(premium)} が離れています。損益は、入力した受取プレミアム額を基準にしています。`
      : "");
  els.stressNote.textContent = [
    ivText,
    receivedText,
    `色付きのセルは、現在値が${money(stopMin)}以上（受取額の1.9倍以上＝ロスカットの逆指値の水準）です${maxValue !== null ? "。さらに濃い色は、スプレッド幅の上限（最大損失）に近い水準です" : ""}。`,
    "金利0・配当なし、株価がすぐに動いたとして（時間の経過なし）計算した目安です。実際の価格とは、スキュー・流動性などでずれます。すでに両方の権利行使価格を超えて動いている場合は、IVが上がるとスプレッドの価格がわずかに下がることがあります。",
  ].filter(Boolean).join(" ");
}

// SPボタン: 単体注文とスプレッド(SP)注文を切り替える。使わない側の入力欄は非表示になり、値は保持される。
function onToggleSp() {
  const t = activeTab();
  if (!t) return;
  t.rrVariant = t.rrVariant === "spread" ? "naked" : "spread";
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  if (t.closesFull) renderAll(t);
  syncMirrors();
  persistState();
}

// 同じ入力欄を複数の場所に置くための仕組み。値の持ち主(idで参照する正本)と、
// data-mirror="正本のid"を付けた入力欄(ミラー)の値を常に同期させる。
// ミラーで入力すると正本に値を移して同じ入力イベントを発火させるため、既存の処理がそのまま動く。
function setupMirrors() {
  const canonIds = new Set();
  document.querySelectorAll("[data-mirror]").forEach((m) => {
    const canon = document.getElementById(m.dataset.mirror);
    if (!canon) return;
    canonIds.add(m.dataset.mirror);
    const isSelect = m.tagName === "SELECT";
    if (isSelect) m.innerHTML = canon.innerHTML;
    const evt = isSelect ? "change" : "input";
    m.addEventListener(evt, () => {
      canon.value = m.value;
      canon.dispatchEvent(new Event(evt, { bubbles: true }));
    });
    if (!isSelect) {
      m.addEventListener("blur", () => {
        canon.dispatchEvent(new Event("blur"));
        syncMirrors();
      });
    }
  });
  canonIds.forEach((id) => {
    const canon = document.getElementById(id);
    canon.addEventListener(canon.tagName === "SELECT" ? "change" : "input", syncMirrors);
  });
  syncMirrors();
}

function syncMirrors() {
  document.querySelectorAll("[data-mirror]").forEach((m) => {
    const canon = document.getElementById(m.dataset.mirror);
    if (!canon) return;
    if (m.value !== canon.value) m.value = canon.value;
    m.disabled = canon.disabled;
  });
}

// 満期時の損益分岐点(株価)を描画する。単体・スプレッドとも、上部の比率で決まる権利行使価格
// (売り系は売り建て側、買い系は買い建て側)にプレミアムを加減した値になる
// (スプレッドでは、もう一方の脚との差額=スプレッド幅は損益分岐点に影響しない)。
// プット系は権利行使価格−プレミアム、コール系は権利行使価格＋プレミアム。
// 売り系は受取プレミアム額、買い系は支払いプレミアム額(スプレッドは差し引き後の正味の額)を使う。
function renderBreakEvenPrice(t, closes, todayStrike) {
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const isPut = type.itmWhen === "below";
  const premium = premiumOf(t);
  const premiumName = group === "sell" ? "受取プレミアム額" : "支払いプレミアム額";
  const formula = `権利行使価格${isPut ? "−" : "＋"}${premiumName}`;
  const latest = closes[closes.length - 1];
  const T = "orderExplain";

  const hasPremium = premium !== null && premium !== undefined && premium >= 0;
  const breakEven = hasPremium ? todayStrike + (isPut ? -premium : premium) : null;
  const diffPct = breakEven === null ? null : breakEven / latest - 1;

  const items = [
    {
      label: "現在の権利行使価格", value: todayStrike.toFixed(2), sub: "終値×比率",
      note: "本日の終値×権利行使価格の比率です。\nスプレッドの場合は、売り系は売り建てる側、買い系は買い建てる側の権利行使価格にあたります(もう一方の権利行使価格との差額は損益分岐点に影響しません)。",
    },
    {
      label: "損益分岐点(満期時の株価)", value: breakEven === null ? "―" : breakEven.toFixed(2),
      sub: breakEven === null ? `${premiumName}を入力すると表示` : formula,
      note: `満期時にこの株価であれば、損益がちょうどゼロになる価格です(${formula})。\n`
        + (group === "sell"
          ? (isPut ? "プット売りは、満期時の株価がこの価格を下回ると損失になります。" : "コール売りは、満期時の株価がこの価格を上回ると損失になります。")
          : (isPut ? "プット買いは、満期時の株価がこの価格を下回ると利益になります。" : "コール買いは、満期時の株価がこの価格を上回ると利益になります。"))
        + "\nスプレッドの場合は、プレミアムに差し引き後の正味の額(受取−支払い)を入力してください。\nプレミアムは1株あたりの額で、手数料は含みません。",
    },
    {
      label: "現在の株価との差", value: diffPct === null ? "―" : (diffPct >= 0 ? "+" : "") + (diffPct * 100).toFixed(2) + "%",
      sub: `現在の株価${latest.toFixed(2)}`,
      note: "損益分岐点が、現在の株価(最新の終値)から見て何%離れているかです。\n例えばプット売りで-8%なら、株価が現在より8%下がるまでは(満期時に)損失にならない、という余裕の目安になります。",
    },
  ];
  els.rrBreakEvenSummary.innerHTML = items.map((it) =>
    `<div class="stat" data-target="${T}" data-note="${it.note}"><b>${it.value}</b><span>${it.label}</span>`
    + (it.sub ? `<span class="stat-sub">${it.sub}</span>` : "") + `</div>`
  ).join("");
}

// badgeLevel(0=最も有利〜6=最も不利)をヒートマップ同様の色クラスに変換する
function badgeLevelClass(level) {
  return level === null || level === undefined ? "b-neutral" : `b${level}`;
}

// 各.stat項目・グラフの見出し・フォーム項目のラベルをクリックすると、その項目の
// すぐ下に説明欄を挿入する(フォーム項目はラベルの下ではなく.field全体の下)。
// もう一度クリックすると閉じる(トグル)。各項目は独立してON/OFFでき、他の項目を
// クリックしても閉じない。再描画のたびにDOMごと作り直される.stat項目があるため、DOMごと
// 作り直されるため、この関数は再描画後にも呼び直される。既に配線済みの要素
// (静的な項目)に二重で登録しないよう、配線済みフラグで判定する。
function setupStatExplain() {
  document.querySelectorAll(".stat[data-note], .chart-title[data-note], .field label[data-note], .card-title-toggle[data-note]").forEach((el) => {
    if (el.dataset.explainWired) return;
    el.dataset.explainWired = "1";
    el.addEventListener("click", () => {
      const anchor = el.closest(".field") || el;
      if (el.classList.contains("active")) {
        el.classList.remove("active");
        const box = anchor.nextElementSibling;
        if (box && box.classList.contains("explain-box")) box.remove();
        return;
      }
      el.classList.add("active");
      const box = document.createElement("div");
      box.className = "explain-box";
      box.textContent = el.dataset.note;
      // HVのカードは、説明に加えて、過去1年のHVの推移グラフを出す
      if (el.dataset.hvDays) box.insertAdjacentHTML("beforeend", hvHistoryChartHtml(Number(el.dataset.hvDays)));
      anchor.insertAdjacentElement("afterend", box);
    });
  });
}

// 各エリア(カード)の見出しの右上に「閉じる/開く」ボタンを付ける。閉じると見出し行だけを残して
// 折りたたむ。開閉の状態はブラウザに保存し、次回開いたときも引き継ぐ(全タブ共通)。
// ヒートマップのマス・営業日ごとのITM確率チャートの棒をクリックすると、その説明(日付・深さなど。data-tip属性)を吹き出しで表示する。
// 別のマスをクリックするとそちらに移り、マス以外の場所をクリックする(またはEscを押す)と消える。
// (以前はマウスを乗せると表示するtitle属性だったが、クリック操作に変更した。スマホのタップにも対応する)
let cellTipEl = null;
let cellTipTarget = null;
function hideCellTip() {
  if (cellTipEl) cellTipEl.hidden = true;
  if (cellTipTarget) cellTipTarget.classList.remove("hm-tip-active");
  cellTipTarget = null;
}
function setupCellTip() {
  cellTipEl = document.createElement("div");
  cellTipEl.className = "cell-tip";
  cellTipEl.hidden = true;
  document.body.appendChild(cellTipEl);
  document.addEventListener("click", (e) => {
    const cell = e.target.closest && e.target.closest("[data-tip]");
    if (!cell) {
      if (!cellTipEl.contains(e.target)) hideCellTip();
      return;
    }
    if (cell === cellTipTarget) { hideCellTip(); return; }
    hideCellTip();
    cellTipTarget = cell;
    cell.classList.add("hm-tip-active");
    cellTipEl.textContent = cell.dataset.tip;
    cellTipEl.hidden = false;
    const r = cell.getBoundingClientRect();
    const w = cellTipEl.offsetWidth;
    const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 8));
    cellTipEl.style.left = `${left}px`;
    cellTipEl.style.top = `${r.bottom + window.scrollY + 6}px`;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCellTip(); });
}

const COLLAPSE_KEY = "itm-tool-collapsed-v1";
function setupCollapsibleCards() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch (e) { saved = {}; }
  ["volatilityCard", "hvCard", "result", "orderCard", "conditionCard"].forEach((id) => {
    const card = document.getElementById(id);
    if (!card) return;
    const head = card.querySelector(":scope > .result-head, :scope > .order-head") || card.querySelector(":scope > h2");
    if (!head) return;
    head.classList.add("card-head");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card-toggle";
    const apply = (collapsed) => {
      card.classList.toggle("collapsed", collapsed);
      btn.textContent = collapsed ? "開く" : "閉じる";
      btn.setAttribute("aria-expanded", String(!collapsed));
    };
    apply(!!saved[id]);
    btn.addEventListener("click", () => {
      const collapsed = !card.classList.contains("collapsed");
      apply(collapsed);
      saved[id] = collapsed;
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(saved)); } catch (e) { /* 保存できなくても動作に支障はない */ }
    });
    card.appendChild(btn);
  });
}

function init() {
  initThemeBar("theme-bar");
  setupCollapsibleCards();
  setupCellTip();
  initTypeOptions();
  initPeriodOptions();
  initMomentumLookbackOptions();
  setupTickerHistoryDropdown(els.ticker, els.tickerHistoryDropdown);
  setupStatExplain();

  // 復元の優先順位: URLの共有パラメータ > 同一端末の保存状態 > 新規タブ
  const shareData = parseShareParam();
  if (shareData) {
    loadFromShareRecipes(shareData.recipes);
    mergeTickerHistory(shareData.tickerHistory);
  } else if (!loadFromSavedState()) {
    createTab();
  }

  els.analyzeBtn.addEventListener("click", onAnalyze);
  els.ticker.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAnalyze();
  });
  els.typeSelect.addEventListener("change", () => {
    els.ratioInput.value = OPTION_TYPES[els.typeSelect.value].ratio;
    onFormChange();
  });
  els.ratioInput.addEventListener("input", debounce(onFormChange, 250));
  // 満期日(判定期間)の入力。キーボード入力の途中経過で何度も再計算しないよう、入力が止まってから反映する
  const debouncedCommit = debounce((v) => commitWindowDate(v), 600);
  for (const inp of [els.windowDateInput, els.orderWindowDateInput]) {
    inp.addEventListener("change", () => debouncedCommit(inp.value));
  }
  els.periodSelect.addEventListener("change", onFormChange);
  els.conditionModeSelect.addEventListener("change", onFormChange);
  els.momentumLookbackSelect.addEventListener("change", onFormChange);
  els.minMatchDaysInput.addEventListener("input", debounce(onFormChange, 250));
  els.momentumDirectionSelect.addEventListener("change", onFormChange);
  els.momentumThresholdInput.addEventListener("input", debounce(onFormChange, 250));
  els.spBtn.addEventListener("click", onToggleSp);
  els.rrDepthInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrPayPremiumInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrPremiumInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrProfitRatioInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrSpreadWidthInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrIvSellInput.addEventListener("input", debounce(onFormChange, 250));
  els.rrIvBuyInput.addEventListener("input", debounce(onFormChange, 250));
  // 「本日の状況」の日付指定は、その表示だけを切り替える(他のカードは再計算しない)
  const onStatusDateChange = (value) => {
    const t = activeTab();
    if (!t || !t.closesFull) return;
    t.statusDate = value || null;
    els.statusDateInput.value = t.statusDate ?? "";
    renderAll(t); // 他のカードも、指定した日までのデータで再計算する
  };
  els.otmToggleBtn.addEventListener("click", () => {
    const t = activeTab();
    if (!t || !t.closesFull) return;
    t.otmView = !t.otmView;
    renderMainAnalysis(t);
  });
  els.statusDateInput.addEventListener("change", () => onStatusDateChange(els.statusDateInput.value));
  els.statusDateReset.addEventListener("click", () => onStatusDateChange(""));
  els.shareBtn.addEventListener("click", onShareLink);
  els.openDetailBtn.addEventListener("click", onOpenDetail);
  setupMirrors();
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
