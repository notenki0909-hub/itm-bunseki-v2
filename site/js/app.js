import {
  OPTION_TYPES, DEFAULT_WINDOW,
  PERIOD_OPTIONS, DEFAULT_PERIOD_DAYS,
  MOMENTUM_LOOKBACK_OPTIONS, DEFAULT_MOMENTUM_LOOKBACK,
  computeItmAnalysis, computeConditionalItmAnalysis,
  computeRecentMomentumStrip, computeMomentum, typeGroup, BADGE_LABELS,
  RISK_VARIANT_LABELS,
  baseEntryIndices, computeDepthEntryResults, summarizeDepthResults,
  VOLATILITY_PERIODS, computeVolatilityStats, computeRecentVolatilityAmount,
  computeHv, computeHvSeries, hvPosition, hvTheory, computeEmpiricalCone,
} from "./calc.js";
import { computeBuyStudy, computeFixedLineTable, computeAtr, assumedIvAt, BUY_X_LIST, BUY_ATR_MULTS, DEFAULT_ATR_MULT, ATR_PERIOD } from "./buyline.js";
import { renderDayProbChart, DAY_PROB_BANDS, renderConeChart, renderHvHistoryChart } from "./chart.js";
import { renderEntryHeatmap, ENTRY_HEATMAP_BANDS, renderDepthHeatmap, DEPTH_HEATMAP_BANDS, renderOtmHeatmap, OTM_HEATMAP_BANDS, OTM_RATE_BANDS } from "./heatmap.js";
import { initThemeBar } from "./theme.js";
import { isPriceDataStale } from "./marketTime.js";
import { stressTest, ivTimeTable, solveFlatIv, resolveIvs, positionValue, judgeIvHv, bsPrice, TRADING_DAYS_PER_YEAR } from "./optionModel.js";
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
// 売りページ(index.html)と買いページ(buy.html)は、同じコードで動く。body の data-page="buy" が買いページ。
// 取引タイプ・保存先(タブの状態)・一部のカードが、ページごとに違う。
const PAGE = document.body.dataset.page === "buy" ? "buy" : "sell";
const PAGE_TYPES = PAGE === "buy" ? ["call_buy", "put_buy"] : ["put_sell", "call_sell"];
const OTHER_PAGE = PAGE === "buy" ? "index.html" : "buy.html";
// 画面の節の名前(番号つき)。買いページは、リスク確認が3番目に来るため、売りページと番号が違う
const SEC = PAGE === "buy"
  ? { risk: "3 リスク確認", past: "4 過去の実績", hv: "5 HV", iv: "6 IV", summary: "7 まとめ" }
  : { risk: "7 リスク確認", past: "3 過去の実績", hv: "4 HV", iv: "5 IV", summary: "6 まとめ" };
const isPageType = (k) => PAGE_TYPES.includes(k);
const SELL_STORAGE_KEY = "itm-tool-state-v1";
const BUY_STORAGE_KEY = "itm-tool-state-buy-v1";
const STORAGE_KEY = PAGE === "buy" ? BUY_STORAGE_KEY : SELL_STORAGE_KEY;
let migratedTabCount = 0; // 売りページを開いたとき、買い系のタブを買いページへ移した数

// 端末をまたいだ共有用。タブの「設定」だけ(取得済みデータは含めない)をURLに載せる。
// URLが長くなりすぎるのを避けるため、価格データは含めず、開いた側で再取得させる設計。
function tabRecipe(t) {
  return {
    symbol: t.symbol,
    typeKey: t.typeKey,
    ratio: t.ratio,
    windowDays: t.windowDays,
    periodDays: t.periodDays,
    periodManual: t.periodManual,
    conditionMode: t.conditionMode,
    momentumLookback: t.momentumLookback,
    minMatchDays: t.minMatchDays,
    momentumDirection: t.momentumDirection,
    momentumThresholdPct: t.momentumThresholdPct,
    rrVariant: t.rrVariant,
    rrDepth: t.rrDepth,
    rrBeBase: t.rrBeBase,
    rrPremium: t.rrPremium,
    rrPayPremium: t.rrPayPremium,
    rrProfitRatio: t.rrProfitRatio,
    rrSpreadWidth: t.rrSpreadWidth,
    rrIvSell: t.rrIvSell,
    rrIvBuy: t.rrIvBuy,
    rrSellStrike: t.rrSellStrike,
    rrBuyStrike: t.rrBuyStrike,
    rrPremMode: t.rrPremMode,
    rrPremSell: t.rrPremSell,
    rrPremBuy: t.rrPremBuy,
    stopPick: t.stopPick,
    planQty: t.planQty,
    buyAtrMult: t.buyAtrMult,
    buyRate: t.buyRate,
  };
}

function applyRecipe(t, rec) {
  Object.assign(t, {
    symbol: rec.symbol ?? t.symbol,
    typeKey: rec.typeKey || t.typeKey,
    ratio: rec.ratio ?? t.ratio,
    windowDays: rec.windowDays ?? t.windowDays,
    periodDays: rec.periodDays ?? t.periodDays,
    periodManual: rec.periodManual ?? t.periodManual,
    conditionMode: rec.conditionMode || t.conditionMode,
    momentumLookback: rec.momentumLookback ?? t.momentumLookback,
    minMatchDays: rec.minMatchDays ?? t.minMatchDays,
    momentumDirection: rec.momentumDirection || t.momentumDirection,
    momentumThresholdPct: rec.momentumThresholdPct ?? t.momentumThresholdPct,
    rrVariant: rec.rrVariant || t.rrVariant,
    rrDepth: rec.rrDepth ?? t.rrDepth,
    rrBeBase: rec.rrBeBase ?? t.rrBeBase,
    rrPremium: rec.rrPremium ?? t.rrPremium,
    rrPayPremium: rec.rrPayPremium ?? t.rrPayPremium,
    rrProfitRatio: rec.rrProfitRatio ?? t.rrProfitRatio,
    rrSpreadWidth: rec.rrSpreadWidth ?? t.rrSpreadWidth,
    rrIvSell: rec.rrIvSell ?? t.rrIvSell,
    rrIvBuy: rec.rrIvBuy ?? t.rrIvBuy,
    rrSellStrike: rec.rrSellStrike ?? t.rrSellStrike,
    rrBuyStrike: rec.rrBuyStrike ?? t.rrBuyStrike,
    rrPremMode: rec.rrPremMode || t.rrPremMode,
    rrPremSell: rec.rrPremSell ?? t.rrPremSell,
    rrPremBuy: rec.rrPremBuy ?? t.rrPremBuy,
    stopPick: rec.stopPick ?? t.stopPick,
    planQty: rec.planQty ?? t.planQty,
    buyAtrMult: rec.buyAtrMult ?? t.buyAtrMult,
    buyRate: rec.buyRate ?? t.buyRate,
  });
  // 買いページは、単体注文のみ(スプレッドは未対応)
  if (PAGE === "buy") t.rrVariant = "naked";
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
        // 高値・安値は、買いページ(ATR)でだけ使うため、買いページだけ保存する
        ...(PAGE === "buy" ? { highsFull: t.highsFull, lowsFull: t.lowsFull } : {}),
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

  // このページの取引タイプのタブだけを開く。売りページに残っていた買い系のタブは、買いページの保存先へ移す。
  const own = payload.tabs.filter((r) => isPageType(r.typeKey));
  const other = payload.tabs.filter((r) => !isPageType(r.typeKey));
  if (PAGE === "sell" && other.length) {
    try {
      const rawBuy = localStorage.getItem(BUY_STORAGE_KEY);
      const buyPayload = rawBuy ? JSON.parse(rawBuy) : { activeIndex: 0, tabs: [] };
      for (const r of other) {
        // 買い系のタブは、高値・安値がない(開いたときに取り直す)。同じ銘柄・同じタイプが既にあれば、移さない
        if (!buyPayload.tabs.some((b) => b.symbol === r.symbol && b.typeKey === r.typeKey)) buyPayload.tabs.push(r);
      }
      localStorage.setItem(BUY_STORAGE_KEY, JSON.stringify(buyPayload));
      migratedTabCount = other.length;
    } catch (e) { /* 移せなくても、売りページは動く */ }
  }
  if (own.length === 0) return false;

  for (const rec of own) {
    const t = newTabState();
    applyRecipe(t, rec);
    t.closesFull = rec.closesFull || null;
    t.datesFull = rec.datesFull || null;
    t.highsFull = rec.highsFull || null;
    t.lowsFull = rec.lowsFull || null;
    t.fetchedAt = rec.fetchedAt ?? null; // 古い保存状態には無い(=古いデータとして扱い、開いたときに取り直す)
    tabs.push(t);
  }
  const idx = Math.min(Math.max(PAGE === "sell" && other.length ? 0 : (payload.activeIndex || 0), 0), tabs.length - 1);
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
      t.highsFull = data.highs ?? null;
      t.lowsFull = data.lows ?? null;
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
  hvTheorySummary: document.getElementById("hvTheorySummary"),
  ivConeWrap: document.getElementById("ivConeWrap"),
  ivConeLegend: document.getElementById("ivConeLegend"),
  hvTheoryNote: document.getElementById("hvTheoryNote"),
  expiryNote: document.getElementById("expiryNote"),
  latestPrice: document.getElementById("latestPrice"),
  condResultCard: document.getElementById("condResultCard"),
  volDetails: document.getElementById("volDetails"),
  conclBody: document.getElementById("conclBody"),
  pageNotice: document.getElementById("pageNotice"),
  buyAtrMultSelect: document.getElementById("buyAtrMultSelect"),
  buyRateInput: document.getElementById("buyRateInput"),
  buyRateHint: document.getElementById("buyRateHint"),
  buyRateBtn: document.getElementById("buyRateBtn"),
  premJudge: document.getElementById("premJudge"),
  buyStudyCard: document.getElementById("buyStudyCard"),
  periodCompareCard: document.getElementById("periodCompareCard"),
  periodCompareBody: document.getElementById("periodCompareBody"),
  periodCompareNote: document.getElementById("periodCompareNote"),
  buyStudyBody: document.getElementById("buyStudyBody"),
  buyStudyNote: document.getElementById("buyStudyNote"),
  buyRiskCard: document.getElementById("buyRiskCard"),
  buyRiskSummary: document.getElementById("buyRiskSummary"),
  buyRiskBody: document.getElementById("buyRiskBody"),
  buyRiskNote: document.getElementById("buyRiskNote"),
  buyTimeIntro: document.getElementById("buyTimeIntro"),
  buyTimeHead: document.getElementById("buyTimeHead"),
  buyTimeBody: document.getElementById("buyTimeBody"),
  buyTimeNote: document.getElementById("buyTimeNote"),
  buyPlanCard: document.getElementById("buyPlanCard"),
  buyPlanBody: document.getElementById("buyPlanBody"),
  buyPlanCopyBtn: document.getElementById("buyPlanCopyBtn"),
  buyPlanCopyHint: document.getElementById("buyPlanCopyHint"),

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
  ratioCard: document.getElementById("ratioCard"),
  ratioTargetInput: document.getElementById("ratioTargetInput"),
  ratioEffHint: document.getElementById("ratioEffHint"),
  riskCapitalInput: document.getElementById("riskCapitalInput"),
  planQtyInput: document.getElementById("planQtyInput"),
  riskSummary: document.getElementById("riskSummary"),
  riskNote: document.getElementById("riskNote"),
  riskClearPick: document.getElementById("riskClearPick"),
  bandRow1: document.getElementById("bandRow1"),
  bandRow2: document.getElementById("bandRow2"),
  bandNav: document.getElementById("bandNav"),
  condGate: document.getElementById("condGate"),
  riskTabStress: document.getElementById("riskTabStress"),
  riskTabTime: document.getElementById("riskTabTime"),
  stressWrap: document.getElementById("stressWrap"),
  ivTimeWrap: document.getElementById("ivTimeWrap"),
  planCard: document.getElementById("planCard"),
  planBody: document.getElementById("planBody"),
  planCopyBtn: document.getElementById("planCopyBtn"),
  planCopyHint: document.getElementById("planCopyHint"),
  ratioMinPremInput: document.getElementById("ratioMinPremInput"),
  ratioStepBtns: document.getElementById("ratioStepBtns"),
  ratioPremHint: document.getElementById("ratioPremHint"),
  ratioSummary: document.getElementById("ratioSummary"),
  ratioActions: document.getElementById("ratioActions"),
  ratioBody: document.getElementById("ratioBody"),
  ratioNote: document.getElementById("ratioNote"),
  orderLine: document.getElementById("orderLine"),
  orderTypeLabel: document.getElementById("orderTypeLabel"),
  orderMaxLossField: document.getElementById("orderMaxLossField"),
  orderMaxLoss: document.getElementById("orderMaxLoss"),
  orderMaxLossHint: document.getElementById("orderMaxLossHint"),
  spBtn: document.getElementById("spBtn"),
  rrPayPremiumInput: document.getElementById("rrPayPremiumInput"),
  rrDepthInput: document.getElementById("rrDepthInput"),
  rrDepthPct: document.getElementById("rrDepthPct"),
  beBaseCheck: document.getElementById("beBaseCheck"),
  beBaseHint: document.getElementById("beBaseHint"),
  rrBreakEvenSummary: document.getElementById("rrBreakEvenSummary"),
  rrPremiumInput: document.getElementById("rrPremiumInput"),
  rrProfitRatioInput: document.getElementById("rrProfitRatioInput"),
  rrSpreadWidthInput: document.getElementById("rrSpreadWidthInput"),
  ivHvSummary: document.getElementById("ivHvSummary"),
  ivHvNote: document.getElementById("ivHvNote"),
  ivHvCompare: document.getElementById("ivHvCompare"),
  ivTimeIntro: document.getElementById("ivTimeIntro"),
  ivTimeHead: document.getElementById("ivTimeHead"),
  ivTimeBody: document.getElementById("ivTimeBody"),
  ivTimeNote: document.getElementById("ivTimeNote"),
  rrSellStrikeInput: document.getElementById("rrSellStrikeInput"),
  rrBuyStrikeInput: document.getElementById("rrBuyStrikeInput"),
  rrSellStrikeHint: document.getElementById("rrSellStrikeHint"),
  rrBuyStrikeWarn: document.getElementById("rrBuyStrikeWarn"),
  rrWidthHint: document.getElementById("rrWidthHint"),
  premModeNet: document.getElementById("premModeNet"),
  premModeLegs: document.getElementById("premModeLegs"),
  premLegsRow: document.getElementById("premLegsRow"),
  rrPremSellInput: document.getElementById("rrPremSellInput"),
  rrPremBuyInput: document.getElementById("rrPremBuyInput"),
  rrPremiumHint: document.getElementById("rrPremiumHint"),
  rrIvSellInput: document.getElementById("rrIvSellInput"),
  rrIvBuyInput: document.getElementById("rrIvBuyInput"),
  stressIntro: document.getElementById("stressIntro"),
  stressHead: document.getElementById("stressHead"),
  stressBody: document.getElementById("stressBody"),
  stressNote: document.getElementById("stressNote"),
};

function hideBuyCards() {
  for (const c of [els.buyStudyCard, els.buyRiskCard, els.buyPlanCard]) if (c) c.hidden = true;
  if (els.periodCompareCard) els.periodCompareCard.hidden = true;
}

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function newTabState() {
  return {
    id: nextTabId++,
    symbol: null,
    otmView: false,   // 「過去の営業日ごとのITM確率」とエントリー日ごとのITM状況を、OTM表示にしているか。表示だけの一時的な切替で、保存・共有はしない
    fetchedAt: null,  // closesFullをサーバーが取得した時刻(UTCミリ秒)。古いかの判定に使う
    highsFull: null,  // 高値・安値(買いページだけ。ATRに使う)。closesFullと同じ並び
    lowsFull: null,
    buyAtrMult: DEFAULT_ATR_MULT, // 買いページ: 固定の手仕舞い線のATR倍率
    buyRate: null,        // 買いページ: 金利(年%)。自動入力(米国債利回り)または手入力
    closesFull: null, // フェッチした生データ(最大件数)。期間セレクターはこれをローカルでスライスするだけ
    datesFull: null,  // closesFullと同じ並びの日付文字列
    typeKey: PAGE_TYPES[0],
    ratio: OPTION_TYPES[PAGE_TYPES[0]].ratio,
    windowDays: DEFAULT_WINDOW,
    periodManual: false, // 集計期間を自分で選んだか(選んでいなければ、分析のたびに、慎重な見方の基準の期間を自動で選ぶ)
    periodDays: PAGE === "buy" ? 750 : DEFAULT_PERIOD_DAYS, // 買いページの初期値は3年(件数が多く、期間による偏りが出にくい)。売りは1年
    conditionMode: "countWithin7", // 既定は「直近7営業日中の該当日数」(最低条件の判定と同じ見方)
    momentumLookback: DEFAULT_MOMENTUM_LOOKBACK,
    minMatchDays: 3,
    momentumDirection: "down",
    momentumThresholdPct: 5,
    rrVariant: "naked",
    rrDepth: null,
    rrBeBase: false, // 買いページ: 損益分岐点(権利行使価格＋支払いプレミアム)を、判定の基準にする
    rrPremium: null,
    rrPayPremium: null,
    rrProfitRatio: null,
    rrSpreadWidth: null,
    rrIvSell: null,
    rrIvBuy: null,
    rrSellStrike: null,
    rrBuyStrike: null,
    rrPremMode: "net",
    rrPremSell: null,
    rrPremBuy: null,
    stopPick: null,   // 表で選んだ損切りの場面("-0.1|1"＝ストレステスト(株価の変化|IV上昇の列番号)、"time|30|0.3"＝IVの変化と時間の経過の表)。null=選んでいない。null=ATRの損切りの目安
    planQty: 1,       // 発注枚数。新しいタブの初期値は1枚(空欄にすると、損切りの上限＝資金の2%に収まる最大枚数で計算)
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
  if (els.beBaseCheck) els.beBaseCheck.checked = !!t.rrBeBase;
  els.rrPremiumInput.value = t.rrPremium ?? "";
  els.rrPayPremiumInput.value = t.rrPayPremium ?? "";
  els.rrProfitRatioInput.value = t.rrProfitRatio ?? "";
  els.rrSpreadWidthInput.value = t.rrSpreadWidth ?? "";
  els.rrIvSellInput.value = t.rrIvSell ?? "";
  els.rrIvBuyInput.value = t.rrIvBuy ?? "";
  els.rrSellStrikeInput.value = t.rrSellStrike ?? "";
  els.rrBuyStrikeInput.value = t.rrBuyStrike ?? "";
  els.rrPremSellInput.value = t.rrPremSell ?? "";
  els.rrPremBuyInput.value = t.rrPremBuy ?? "";
  if (els.buyAtrMultSelect) els.buyAtrMultSelect.value = String(t.buyAtrMult);
  // トータル資金額(全タブ共通)と発注枚数(タブごと)の入力欄。買いページでは、ここで反映する(売りページは、リスク確認の描画でも反映する)
  els.riskCapitalInput.value = riskCapital() > 0 ? riskCapital() : "";
  els.planQtyInput.value = t.planQty > 0 ? t.planQty : "";
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  syncOrderDerived(t);
  setStatus("");

  if (t.closesFull) {
    renderAll(t);
  } else {
    els.volatilityCard.hidden = true;
    els.hvCard.hidden = true;
    els.latestPrice.hidden = true;
    els.todayCard.hidden = true;
    els.result.hidden = true;
    els.ratioCard.hidden = true;
    els.orderCard.hidden = true;
    els.conditionCard.hidden = true;
    els.planCard.hidden = true;
    hideBuyCards();
    renderConclusion(null);
    renderTopBand(null);
    syncSections();
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
  if (!isStaleData(t.fetchedAt, t.datesFull) && !(PAGE === "buy" && !t.highsFull)) return; // 買いページは、高値・安値がないときも取り直す
  t.refreshing = true;
  if (activeTabId === t.id) setStatus(`${t.symbol} の最新の株価データを確認中…（それまでは保存済みのデータを表示しています）`);
  try {
    const data = await fetchHistory(t.symbol);
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    t.highsFull = data.highs ?? null;
    t.lowsFull = data.lows ?? null;
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
    .filter(([key]) => isPageType(key))
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
  for (const [inp, h] of [[els.windowDateInput, els.windowHint]]) {
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
    .map((p) => `<option value="${p.days}" ${p.days === (PAGE === "buy" ? 750 : DEFAULT_PERIOD_DAYS) ? "selected" : ""}>${p.label}</option>`)
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
  if (hit && !isStaleData(hit.fetchedAt, hit.dates) && (PAGE !== "buy" || hit.highs)) return hit;
  // 買いページは、ATR用に高値・安値も受け取る(hl=1)。売りページは従来どおり終値だけ。
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}${PAGE === "buy" ? "&hl=1" : ""}`);
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
  els.ratioCard.hidden = true;
  els.orderCard.hidden = true;
  els.conditionCard.hidden = true;
  els.planCard.hidden = true;
  hideBuyCards();
  renderConclusion(null);
    renderTopBand(null);
  syncSections();
  try {
    const data = await fetchHistory(symbol);
    t.symbol = data.symbol;
    t.closesFull = data.closes;
    t.datesFull = data.dates;
    t.highsFull = data.highs ?? null;
    t.lowsFull = data.lows ?? null;
    t.fetchedAt = data.fetchedAt ?? Date.now();
    setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました`);
    addTickerToHistory(data.symbol);
    t.ratioNormalize = true;
    // 集計期間を自分で選んでいないときは、慎重な見方の基準の期間(1年以上で、売り=ITM発生率が最も高い／買い=最も低い)を初期値にする
    let autoPeriod = null;
    if (!t.periodManual) {
      const { basis } = periodCompareRows(t);
      if (basis) { t.periodDays = basis.p.days; els.periodSelect.value = String(t.periodDays); autoPeriod = basis.p.label; }
    }
    renderAll(t);
    if (autoPeriod) setStatus(`${data.symbol} の${data.closes.length}日分の終値を取得しました。集計期間は、慎重な見方の基準の「${autoPeriod}」を選びました`);
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
  const newPeriod = Number(els.periodSelect.value) || DEFAULT_PERIOD_DAYS;
  if (newPeriod !== t.periodDays) t.periodManual = true; // 自分で期間を変えたら、自動の選択はしない
  t.periodDays = newPeriod;
  t.conditionMode = els.conditionModeSelect.value;
  t.momentumLookback = Number(els.momentumLookbackSelect.value) || DEFAULT_MOMENTUM_LOOKBACK;
  t.minMatchDays = Number(els.minMatchDaysInput.value) || 1;
  t.momentumDirection = els.momentumDirectionSelect.value;
  t.momentumThresholdPct = Number(els.momentumThresholdInput.value) || 0;
  if (els.buyAtrMultSelect) t.buyAtrMult = Number(els.buyAtrMultSelect.value) || DEFAULT_ATR_MULT;
  updateConditionModeUI(t.conditionMode);

  t.rrDepth = els.rrDepthInput.value === "" ? null : Math.max(0, Number(els.rrDepthInput.value));
  if (els.beBaseCheck) t.rrBeBase = els.beBaseCheck.checked;
  t.rrPremium = els.rrPremiumInput.value === "" ? null : Number(els.rrPremiumInput.value);
  t.rrPayPremium = els.rrPayPremiumInput.value === "" ? null : Number(els.rrPayPremiumInput.value);
  t.rrProfitRatio = els.rrProfitRatioInput.value === "" ? null : Number(els.rrProfitRatioInput.value);
  t.rrSpreadWidth = els.rrSpreadWidthInput.value === "" ? null : Number(els.rrSpreadWidthInput.value);
  t.rrIvSell = els.rrIvSellInput.value === "" ? null : Number(els.rrIvSellInput.value);
  t.rrIvBuy = els.rrIvBuyInput.value === "" ? null : Number(els.rrIvBuyInput.value);
  t.rrSellStrike = els.rrSellStrikeInput.value === "" ? null : Number(els.rrSellStrikeInput.value);
  t.rrBuyStrike = els.rrBuyStrikeInput.value === "" ? null : Number(els.rrBuyStrikeInput.value);
  t.rrPremSell = els.rrPremSellInput.value === "" ? null : Number(els.rrPremSellInput.value);
  t.rrPremBuy = els.rrPremBuyInput.value === "" ? null : Number(els.rrPremBuyInput.value);
  updateRiskRewardInputUI(t.typeKey, t.rrVariant);
  t.ratioNormalize = true;
  syncOrderDerived(t);

  if (t.closesFull) renderAll(t);
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

// 取得済みの全データ(終値・日付・高値・安値)を返す
function viewDataOf(t) {
  return { closes: t.closesFull, dates: t.datesFull, highs: t.highsFull, lows: t.lowsFull };
}


// ---- 権利行使価格は整数が基本 ----
// 権利行使価格(売り建て側)は、入力があればその値。空欄のときは、終値×比率を「整数」に丸めた値。
// 丸める向きは、現在値から離れる側(プット系=切り捨て、コール系=切り上げ。ITMになりにくい側)。
// 分析のITM確率は、この権利行使価格を終値で割った比率(実効比率)で計算する。
function roundStrike(price, ratio, itmWhen) {
  const v = price * ratio;
  return Math.max(1, itmWhen === "below" ? Math.floor(v + 1e-9) : Math.ceil(v - 1e-9));
}
function effStrikeOf(t, price) {
  if (!(price > 0)) return null;
  if (typeGroup(t.typeKey) === "sell" && t.rrSellStrike > 0) return t.rrSellStrike;
  return roundStrike(price, t.ratio, OPTION_TYPES[t.typeKey].itmWhen);
}
function effRatioOf(t, price) {
  const s = effStrikeOf(t, price);
  return s > 0 && price > 0 ? s / price : t.ratio;
}
// 権利行使価格÷終値の比率を、4桁で表示用に丸める。4桁に丸めても同じ整数の権利行使価格になるよう、
// プット系は切り上げ、コール系は切り下げ(権利行使価格が、現在値から離れる側に残る向き)。
function ratio4(strike, price, itmWhen) {
  const raw = strike / price;
  return itmWhen === "below" ? Math.ceil(raw * 1e4 - 1e-9) / 1e4 : Math.floor(raw * 1e4 + 1e-9) / 1e4;
}
const fmtStrike = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function renderAll(t) {
  band.hvItm = null;
  band.ivhv = null;
  band.cond = null;
  band.hvSigma = null;
  band.hvPos = null;
  band.buyLine = null;
  syncOrderDerived(t);
  syncWindowInputs(t);
  renderLatestPrice(t);
  renderVolatilityCard(t);
  renderHvCard(t);
  renderTodayCard(t);
  renderMainAnalysis(t);
  renderRatioCard(t);
  renderOrderCard(t);
  renderPlanCard(t);
  setupStatExplain();
  renderConditionCard(t);
  if (PAGE === "buy") renderBuyStudy(t);
  renderPeriodCompare(t);
  renderConclusion(t);
  renderTopBand(t);
  syncSections();
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
  const strike = effStrikeOf(t, price);
  const depthDollar = depthDollarOf(t);
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

// 一番上のパネルに、最新の株価(終値)・日付・前日比を表示する。
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
  let change = "";
  if (i >= 1) {
    const diff = close - closes[i - 1];
    const rate = diff / closes[i - 1];
    const sign = diff >= 0 ? "+" : "−";
    const cls = diff >= 0 ? "up" : "down";
    change = `<span class="lp-change ${cls}">前日比 ${sign}${Math.abs(diff).toFixed(2)}（${sign}${Math.abs(rate * 100).toFixed(2)}%）</span>`;
  }
  el.innerHTML = `<span class="lp-symbol">${t.symbol}</span>`
    + `<span class="lp-main"><span class="lp-label">最新の終値：</span><b class="lp-price">${close.toFixed(2)}</b><span class="lp-unit">ドル</span></span>`
    + `<span class="lp-date">（${date}）</span>${change}`;
  el.hidden = false;
}

// 数字のカード。「何の数字か」を数字の前に目立たせる(例: 「HV：53.2%」「満期時ITM率：11.7%（HV換算）」)。
//  name=何の数字か(数字の前に「：」つきで表示) / value=数字 / suffix=数字の後ろの補足(例: （HV換算）) / line=その下の補足の一行 / sub=小さな説明
function statCardHtml({ name, value, suffix = "", line = "", sub = "", note = "", attrs = "" }) {
  return `<div class="stat" ${attrs} data-note="${note}">`
    + `<div class="stat-head"><span class="stat-name">${name}：</span><b>${value}</b>${suffix ? `<span class="stat-suffix">${suffix}</span>` : ""}</div>`
    + (line ? `<span class="stat-line">${line}</span>` : "")
    + (sub ? `<span class="stat-sub">${sub}</span>` : "")
    + `</div>`;
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
      name: "HV",
      line: label,
      value: hv === null ? "―" : pct(hv),
      sub: pos
        ? `${hvBarHtml(pos)}<span class="hv-line">過去1年のHVの幅：${pct(pos.min, 0)}〜${pct(pos.max, 0)}（ふだん＝中央値 ${pct(pos.median, 0)}）</span><span class="hv-line">${hvPositionText(pos)}</span>`
        : "データ不足",
      note: `${extraNote}大きな数字（%）は、直近${d}営業日の、日々の騰落率のばらつきを年率に換算した値（HV）です。「直近${d}営業日」は、計算に使う期間の長さです。\n棒と「過去1年のHVの幅」： 過去1年の毎日について、その日までの直近${d}営業日のHVを計算し（約252個）、その最小〜最大を表します。棒の左端が最小、右端が最大です。黒い目印がいまのHV、灰色の縦線が中央値（ふだんの水準）です。「幅」の%も、HVの値です。\n「高い方から◯番目」： その約252個のHVを高い順に並べたとき、いまのHVが何番目かです。1番目なら、過去1年で最も荒れている時期です。`,
    };
  };
  const statHtml = (it) => statCardHtml({ ...it, attrs: `data-target="hvExplain" data-hv-days="${it.days}"` });
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
  const strike = effStrikeOf(t, price);
  const depthDollar = depthDollarOf(t);
  const hvN = computeHv(closes, days);
  const theory = hvN === null ? null : hvTheory({ price, strike, depthDollar, itmWhen: type.itmWhen, days, hv: hvN });
  band.hvItm = theory ? theory.probItmAtExpiry : null;
  if (!theory) {
    els.hvTheorySummary.innerHTML = "";
    coneBase = null;
    drawCone(t, null);
    els.hvTheoryNote.textContent = "データが足りないため、表示できません。";
    els.hvCard.hidden = false;
    setupStatExplain();
    return;
  }

  const depthText = depthDollar > 0 ? `権利行使価格${type.itmWhen === "below" ? "−" : "＋"}${depthDollar}ドル` : "権利行使価格";
  const dist = theory.distancePct;
  const sideText = theory.zScore >= 0 ? "OTM側" : "ITM側";
  const items = [
    {
      name: "1σの値動き", value: `±${theory.sigmaAmount.toFixed(2)}ドル`, suffix: "（HV基準）",
      sub: `満期まで。±${pct(theory.sigmaPct)}（直近${days}営業日のHV ${pct(hvN)}×√(${days}/252)）`,
      note: `直近${days}営業日（満期までの営業日数と同じ長さ）のHVから見た、満期までの1σ（標準偏差）の値動きです。株価の変動が正規分布に近いと仮定すると、満期時の株価が現在値±この幅に収まる確率は約68%です。\n1σ＝現在値×HV×√(営業日数÷252)。目安であり、将来を保証するものではありません。`,
    },
    {
      name: "権利行使価格", value: `${dist >= 0 ? "+" : ""}${pct(dist)}`,
      sub: `ITMの水準の、現在値からの位置。${depthText}＝${fmtStrike(Math.round(theory.barrier * 100) / 100)}・${Math.abs(theory.zScore).toFixed(2)}σ（${sideText}）`,
      note: `ITMとみなす水準（${depthText}）が、現在値から何%離れているか、またそれがHVから見て何σ分の距離かを表します。\nσの値が大きいほど、HVから見てITMになりにくい水準です。「OTM側」は現在値よりITMの反対側、「ITM側」はすでにITMの側にあることを表します。\n水準は、現在値×権利行使価格の比率（上の入力欄の比率）から求めています。`,
    },
  ];
  // グラフ(コーン図)の材料。売り系は「5 IV」の節に、買い系は「4 HV」の節に描く(売り系は、IVがあれば、IV基準の帯も重ねる)
  const asOfDate = viewDates[viewDates.length - 1];
  const expiryDate = shiftTradingDays(asOfDate, -days);
  coneBase = { pastCloses: closes.slice(-61), price, days, theory, type, dist, asOfDate, expiryDate };
  drawCone(t, null);
  els.hvTheorySummary.innerHTML = items.map((it) => statCardHtml({ ...it, attrs: 'data-target="hvExplain"' })).join("");

  // いまのHVが過去1年の中で高い/低い位置にあるときは、実績との差の理由として添える
  let regime = "";
  const posN = hvPosition(closes, days);
  band.hvSigma = { z: theory.zScore, dist, sideText, sigmaPct: theory.sigmaPct, days };
  band.hvPos = posN ? { text: hvPositionText(posN), hv: hvN, percentile: posN.percentile } : { text: "", hv: hvN, percentile: null };
  if (posN) {
    if (posN.percentile >= 0.8) regime = `直近${days}営業日のHV（${pct(hvN)}）について、${hvPositionText(posN)}。過去の平均より荒れている時期です。実績を調べた期間とは、荒れ具合が違う可能性があります。`;
    else if (posN.percentile <= 0.2) regime = `直近${days}営業日のHV（${pct(hvN)}）について、${hvPositionText(posN)}。過去の平均より穏やかな時期です。実績を調べた期間とは、荒れ具合が違う可能性があります。`;
  }
  els.hvTheoryNote.textContent = `${regime}${regime ? " " : ""}ITMになる確率（HV換算）は、「${SEC.summary}」で、IV換算・過去の実績と並べて見ます。※HVは過去の値動きの大きさで、IV（オプション価格に織り込まれた将来の変動の大きさ）ではありません。`;
  els.hvCard.hidden = false;
  setupStatExplain();
}

// コーン図(満期までの値動きの目安と、権利行使価格の位置)。「6 まとめ」に描く。
// 3つの見方を重ねる: ①HV基準の±1σ・±2σ(青) ②IV基準の±1σ(オレンジの点線の枠。売り系でIVが分かれば) ③過去の実績の約68%の範囲(灰色の帯)と最小・最大(点線)。
// 材料(coneBase)は、renderHvCardが置く。IVは、renderIvHvが分かったときに渡す。
let coneBase = null;
// 「ITMの水準の拡大図」の表示状態(ボタンで切り替える)。ITMの水準のまわり(満期時の各線が重なりやすい範囲)に、縦軸を絞る。
let coneFocus = false;
let lastCone = null; // 直近のdrawConeの引数(表示の切替での描き直し用)
function setupConeFocus() {
  const btn = document.getElementById("coneFocusBtn");
  btn.addEventListener("click", () => {
    coneFocus = !coneFocus;
    if (lastCone) drawCone(lastCone.t, lastCone.iv);
  });
}
function drawCone(t, iv) {
  lastCone = { t, iv };
  const wrap = els.ivConeWrap;
  const legend = els.ivConeLegend;
  wrap.innerHTML = "";
  legend.textContent = "";
  const cb = coneBase;
  if (!cb) return;
  const sell = typeGroup(t.typeKey) === "sell";
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const { theory, dist, days } = cb;
  const ivSigma = iv && iv.thIv ? iv.thIv.sigmaPct : null;
  const pc = periodClosesOf(t);
  const emp = computeEmpiricalCone(pc, days);
  // 損益分岐点＝権利行使価格±プレミアム(売りは受取、買いは支払い)。プレミアムが未入力なら、線は引かない
  const grp = typeGroup(t.typeKey);
  const premBe = grp === "sell" ? t.rrPremium : t.rrPayPremium;
  const strikeBe = grp === "sell" ? sellStrikeOf(t, cb.price) : effStrikeOf(t, cb.price);
  const beVal = premBe !== null && premBe > 0 ? strikeBe + (cb.type.itmWhen === "below" ? -premBe : premBe) : null;
  const beIsBarrier = isBeBase(t); // 判定の基準が損益分岐点のときは、赤い破線が損益分岐点
  const side = theory.zScore >= 0 ? "外" : "内";
  const sigmaText = ivSigma !== null
    ? `HV ${Math.abs(theory.zScore).toFixed(2)}σ／IV ${Math.abs(iv.thIv.zScore).toFixed(2)}σ${side}`
    : `${Math.abs(theory.zScore).toFixed(2)}σ${side}`;
  wrap.innerHTML = renderConeChart({
    pastCloses: cb.pastCloses, price: cb.price, days, sigmaPct: theory.sigmaPct, barrier: theory.barrier, itmWhen: cb.type.itmWhen,
    nowLabel: `いま（${cb.asOfDate.slice(5)}）`, expiryLabel: `満期 ${cb.expiryDate.slice(5)}（${days}営業日後）`,
    barrierLabel: `${beIsBarrier ? "損益分岐点（判定の基準）" : "ITMの水準"} ${theory.barrier.toFixed(2)}（${dist >= 0 ? "+" : ""}${pct(dist)}・${sigmaText}）`,
    markBefore: days > MARK_BEFORE_EXPIRY ? MARK_BEFORE_EXPIRY : null,
    markLabel: `2週間前（満期${MARK_BEFORE_EXPIRY}営業日前） ${shiftTradingDays(cb.expiryDate, MARK_BEFORE_EXPIRY).slice(5)}`,
    // 満期までの期間の半分(2週間前より前にあるときだけ)
    halfBefore: Math.round(days / 2) > MARK_BEFORE_EXPIRY ? Math.round(days / 2) : null,
    halfLabel: `満期までの半分（残り${Math.round(days / 2)}営業日） ${shiftTradingDays(cb.expiryDate, Math.round(days / 2)).slice(5)}`,
    ivSigmaPct: ivSigma,
    empCone: emp,
    focus: coneFocus,
    breakEven: beVal !== null && !beIsBarrier ? beVal : null,
    itmStrike: Math.abs(strikeBe - theory.barrier) > 0.005 ? strikeBe : null,
  });
  const beText = beVal !== null && !beIsBarrier ? `紫の点線＝損益分岐点（権利行使価格${cb.type.itmWhen === "below" ? "−" : "＋"}${grp === "sell" ? "受取" : "支払い"}プレミアム＝${beVal.toFixed(2)}、現在値から${((beVal / cb.price - 1) * 100).toFixed(1)}%）。` : "";
  const itmText = Math.abs(strikeBe - theory.barrier) > 0.005 ? `細い赤の実線＝ITMの水準（権利行使価格${strikeBe.toFixed(2)}）。` : "";
  const halfDays = Math.round(days / 2);
  const markText = days > MARK_BEFORE_EXPIRY ? `灰色の縦線＝${halfDays > MARK_BEFORE_EXPIRY ? `満期までの期間の半分（残り${halfDays}営業日。値は線の左）と、` : ""}2週間前（満期の${MARK_BEFORE_EXPIRY}営業日前。値は線の右）。それぞれ、その日の日付と、そのときのHV・IVの±1σの株価を表示します。` : "";
  const ivText = ivSigma !== null
      ? "オレンジの点線の枠＝IV基準の±1σ（市場が見込む範囲）。IVは、売り建て側の1つの値を全体に当てはめた目安です。"
      : "IV（売り建て側）か受取プレミアム額を入力すると、IV基準の±1σの枠が重なります。";
  let empText = "";
  if (emp) {
    const trials = Math.max(1, Math.round(emp.count / days));
    empText = `灰色の帯＝過去の実績の約68%の範囲（過去の各エントリー日から、同じ営業日数が経ったときの株価の変化の、下位16%〜上位84%）、黒の点線＝過去の最大・最小（過去1回の出来事で、参考）。実績は、集計期間の${emp.count}件のエントリーから求めています（判定期間が重なるため、独立した試行は約${trials}回分）。調べた期間の相場つきに左右されます。`;
  }
  const btnF = document.getElementById("coneFocusBtn");
  btnF.textContent = coneFocus ? "全体表示に戻す" : "ITMの水準の拡大図を見る";
  btnF.setAttribute("aria-pressed", String(coneFocus));
  const focusText = coneFocus ? "【拡大図】縦軸を、ITMの水準と、満期時の各線（HV・IVの1σ、実績の帯と最小・最大）が近い範囲に絞っています。範囲の外の線や、いまの株価は見えません。「全体表示に戻す」で、全体に戻ります。" : "";
  legend.textContent = `${focusText}${markText}${itmText}${beText}青の帯＝HV基準の±1σ（満期時に約68%がこの範囲）、薄い青＝±2σ（約95%）。${ivText}${empText}赤い破線＝ITMの水準、その先の薄い赤＝ITM側。HVの帯は、直近${days}営業日のHVから求めた目安で、いまの株価（黒い点）から満期まで広がります。`;
}

function renderTodayCard(t) {
  // 集計期間の長さで、末尾を切り出す
  const closes = t.closesFull.slice(-t.periodDays);
  const dates = t.datesFull.slice(-t.periodDays);
  const latestIdx = closes.length - 1;
  const latestClose = closes[latestIdx];
  const strike = effStrikeOf(t, latestClose);

  els.todayDate.textContent = closes.length.toLocaleString("ja-JP");
  els.todayRange.textContent = `${dates[0]} 〜 ${dates[latestIdx]}`;
  els.todayClose.textContent = latestClose.toFixed(2);
  els.todayCloseDate.textContent = dates[latestIdx];

  els.todayCard.hidden = false;
}

// 判定する深さ(ドル)。買いページで「損益分岐点を基準にする」にチェックがあり、支払いプレミアム額が入っているときは、
// 支払いプレミアム額(＝損益分岐点−権利行使価格)。それ以外は、入力した深さ(空欄＝0)。
function isBeBase(t) {
  return PAGE === "buy" && !!t.rrBeBase && t.rrPayPremium !== null && t.rrPayPremium > 0;
}
function depthDollarOf(t) {
  return isBeBase(t) ? t.rrPayPremium : (t.rrDepth ?? 0);
}

// 判定する深さ(ドル)を、現在の権利行使価格(本日の終値×比率)に対する割合に換算する。
// 過去の各エントリーにも同じ割合を当てはめる(過去の株価水準が今と違っても公平に比べられるように
// するため)。分析結果・エントリー条件で絞り込みなどで共通に使う。
function depthInfo(t, closes) {
  const depthDollar = depthDollarOf(t);
  const todayStrike = effStrikeOf(t, closes[closes.length - 1]);
  const depthPct = todayStrike > 0 ? depthDollar / todayStrike : 0;
  return { depthDollar, todayStrike, depthPct };
}

// 判定する深さを入力しているとき、ラベルに付ける「（◯ドル）」。空欄(0ドル)なら空文字。
function depthSuffixOf(t) {
  if (isBeBase(t)) return "（損益分岐点）";
  const d = depthDollarOf(t);
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
    ratio: effRatioOf(t, closes[closes.length - 1]),
    itmWhen: type.itmWhen,
    window: t.windowDays,
    group: typeGroup(t.typeKey),
    depthPct,
  }, dates);

  const beBase = isBeBase(t);
  els.rrDepthInput.disabled = beBase;
  if (els.beBaseHint) {
    els.beBaseHint.textContent = beBase
      ? `判定の基準＝損益分岐点 ${fmtStrike(type.itmWhen === "below" ? todayStrike - depthDollar : todayStrike + depthDollar)}（権利行使価格${fmtStrike(todayStrike)}${type.itmWhen === "below" ? "−" : "＋"}支払いプレミアム${depthDollar}）。「判定する深さ」の入力は使いません`
      : (t.rrBeBase ? "支払いプレミアム額を入力すると、その額が判定する深さになります" : "チェックすると、過去の実績の判定の基準が、損益分岐点（権利行使価格＋支払いプレミアム。プット買いは−）になります。");
  }
  // 深さが0なら「ITM」、深さがあれば「ITM＋(−)◯ドル」、深さが支払いプレミアム(損益分岐点)なら「損益分岐点」
  const depthWord = depthDollar > 0
    ? (beBase ? "損益分岐点" : `ITM${type.itmWhen === "below" ? "−" : "＋"}${depthDollar}ドル`)
    : "ITM";
  els.rrDepthPct.textContent = depthDollar > 0
    ? `＝ 権利行使価格の約${(depthPct * 100).toFixed(2)}%（現在の権利行使価格${fmtStrike(todayStrike)}に対して）（一度でも${depthWord}になれば該当）`
    : `＝ 0%（一度でも${depthWord}になれば該当）`;
  const depthTitle = depthSuffixOf(t);
  document.querySelectorAll(".dep-sfx").forEach((el) => { el.textContent = depthTitle; });
  // ITM/OTM表示の切替。OTM表示のときの「OTM」は、深さを入力していれば「その深さのITMではなかった」こと
  const otmMode = !!t.otmView;
  // 損益分岐点を基準にしているときは、見出しも「損益分岐点以上の確率」のようにする(プット系は以下)
  const beWord = type.itmWhen === "below" ? "以下" : "以上";
  const kindTitle = beBase ? (otmMode ? `損益分岐点${type.itmWhen === "below" ? "超" : "未満"}の` : `損益分岐点${beWord}の`) : (otmMode ? "OTM" : "ITM");
  const kindDepth = beBase ? "" : (otmMode ? (depthDollar > 0 ? `（ITM${depthDollar}ドル未満）` : "") : depthTitle);
  els.dayProbKind.textContent = kindTitle;
  els.heatmapKind.textContent = kindTitle;
  els.dayProbDepth.textContent = kindDepth;
  els.heatmapDepth.textContent = kindDepth;
  els.otmToggleBtn.textContent = otmMode ? "ITM確率に切替" : "OTM確率に切替";
  els.otmToggleBtn.setAttribute("aria-pressed", otmMode ? "true" : "false");
  els.otmToggleBtn.classList.toggle("active", otmMode);

  els.symbolLabel.textContent = t.symbol;
  els.resultTypeLabel.textContent = `：${type.label}、権利行使価格${fmtStrike(todayStrike)}（比率${ratio4(todayStrike, closes[closes.length - 1], type.itmWhen)}）`;
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
      { ratio: effRatioOf(t, closes[closes.length - 1]), itmWhen: type.itmWhen, window: t.windowDays, depthPct }), group);
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
    ratio: effRatioOf(t, closes[closes.length - 1]),
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
  // 最低条件: 1〜7営業日前との比較のうち、設定した変化率以上の値動きが1日でもあるか(推奨は、該当日数の設定値以上)
  {
    let hitDays7 = 0;
    let any7 = false;
    for (let k = 1; k <= 7; k++) {
      const m = computeMomentum(closes, latestIdx, k);
      if (m === null) continue;
      any7 = true;
      if (t.momentumDirection === "down" ? m <= -thresholdFrac : m >= thresholdFrac) hitDays7++;
    }
    band.cond = any7 ? { hitDays: hitDays7, rec: t.minMatchDays, down: t.momentumDirection === "down" } : null;
    renderCondGate();
  }
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

  renderConditionMatrix(t, closes, type, thresholdFrac);
  els.conditionCard.hidden = false;
}

// 「エントリー条件で絞り込み」の、直近7営業日の詳細マトリクス。
// 直近7営業日(新しい日が上)の、日付・終値・その日の権利行使価格(終値×比率)と、
// 7営業日前〜1営業日前との比較(変化率)を並べる。条件(方向・変化率)に当てはまるマスに色をつけ、右端に、その日がエントリー条件に該当するかを出す。
//  ・「直近7営業日中の該当日数」: 7つのマスのうち、色のついた数が、該当日数(◯日以上)に達すれば該当
//  ・「N営業日前と比較」: 指定した比較営業日数のマスだけで判定(その列だけに色をつける)
function renderConditionMatrix(t, closes, type, thresholdFrac) {
  const tbl = document.getElementById("condMatrix");
  const note = document.getElementById("condMatrixNote");
  const dates = periodDatesOf(t);
  const latestIdx = closes.length - 1;
  const isCount = t.conditionMode === "countWithin7";
  const down = t.momentumDirection === "down";
  const ratio = effRatioOf(t, closes[latestIdx]);
  const hits = (m) => m !== null && (down ? m <= -thresholdFrac : m >= thresholdFrac);
  const pct = (m) => (m === null ? "―" : `${m >= 0 ? "+" : ""}${(m * 100).toFixed(1)}%`);
  const lbs = [7, 6, 5, 4, 3, 2, 1];
  const head = `<thead><tr><th>日付</th><th>終値</th><th>権利行使価格</th>${lbs.map((n) => `<th${!isCount && n === t.momentumLookback ? ' class="cm-sel"' : ""}>${n}営業日前比</th>`).join("")}<th>条件に</th></tr></thead>`;
  const rows = [];
  for (let j = 0; j < 7; j++) {
    const i = latestIdx - j;
    if (i < 0) break;
    const ms = lbs.map((n) => computeMomentum(closes, i, n));
    const cells = ms.map((m, k) => {
      const n = lbs[k];
      const counted = isCount || n === t.momentumLookback;
      return `<td class="${counted && hits(m) ? "cm-hit" : ""}${!isCount && n === t.momentumLookback ? " cm-sel" : ""}">${pct(m)}</td>`;
    }).join("");
    let judge;
    if (isCount) {
      const hitDays = ms.filter((m) => hits(m)).length;
      const anyData = ms.some((m) => m !== null);
      judge = !anyData ? "―" : `${hitDays}/7日 ${hitDays >= t.minMatchDays ? "<b>該当</b>" : "該当しない"}`;
    } else {
      const m = ms[lbs.indexOf(t.momentumLookback)] ?? null;
      judge = m === null ? "―" : hits(m) ? "<b>該当</b>" : "該当しない";
    }
    const k = roundStrike(closes[i], ratio, type.itmWhen);
    rows.push(`<tr><td>${dates[i]}${j === 0 ? '<br><span class="ratio-mark">本日</span>' : ""}</td><td>${closes[i].toFixed(2)}</td><td>${fmtStrike(k)}</td>${cells}<td>${judge}</td></tr>`);
  }
  tbl.innerHTML = `${head}<tbody>${rows.join("")}</tbody>`;
  const dirWord = down ? "下落" : "上昇";
  note.textContent = isCount
    ? `色のついたマスは、${dirWord}が${t.momentumThresholdPct}%以上のマスです。7つのマスのうち、${t.minMatchDays}日以上に色がつくと、その日はエントリー条件に該当します。権利行使価格は、その日の終値×比率（${Number(ratio.toFixed(4))}）を整数にした値です。`
    : `色のついたマスは、${t.momentumLookback}営業日前と比べて、${dirWord}が${t.momentumThresholdPct}%以上のマスです（条件に使うのは、${t.momentumLookback}営業日前比の列だけ）。権利行使価格は、その日の終値×比率（${Number(ratio.toFixed(4))}）を整数にした値です。`;
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

// 売りの権利行使価格: 入力があればその値、なければ、終値×比率の整数部分(effStrikeOf。比率のほうを、その整数に合わせて直す)。分析・注文内容まわりのすべての計算で、これを基準にする。
function sellStrikeOf(t, price) {
  return effStrikeOf(t, price);
}

// 注文内容の「売り・買いの権利行使価格」「売り・買いのプレミアム」から、差額と受取プレミアム額を自動で決める(売り系スプレッドのみ)。
//  - 買いの権利行使価格を入力したとき: 権利行使価格の差額＝売り(入力、なければ終値×比率)−買い。差額の欄は入力できなくなり、自動の値を表示する。
//  - 受取プレミアムの入力方法が「売りと買いを入力」のとき: 受取プレミアム額＝売りのプレミアム−買いのプレミアム。受取の欄は自動の値を表示する。
// t.rrSpreadWidth / t.rrPremium に、自動の値を入れる(以降の計算は、これまで通り、この2つを使う)。
function syncOrderDerived(t) {
  const group = typeGroup(t.typeKey);
  const isSellSp = group === "sell" && t.rrVariant === "spread";
  const isPut = OPTION_TYPES[t.typeKey].itmWhen === "below";
  const view = t.closesFull && t.closesFull.length ? viewDataOf(t) : null;
  const latest = view && view.closes.length ? view.closes[view.closes.length - 1] : null;
  const itmWhen = OPTION_TYPES[t.typeKey].itmWhen;
  const sellEff = latest !== null ? effStrikeOf(t, latest) : null;
  const entered = group === "sell" && t.rrSellStrike > 0;

  // 売りの権利行使価格の表示(売り系は、単体でもスプレッドでも入力できる)
  if (group === "sell" && sellEff !== null) {
    els.rrSellStrikeHint.textContent = entered
      ? `入力値を使います（終値に対する比率は${ratio4(sellEff, latest, itmWhen)}）。分析のITM確率も、この権利行使価格で計算します`
      : `空欄のときは、比率から決めた ${fmtStrike(sellEff)} を使います（比率は、権利行使価格が${fmtStrike(sellEff)}になるように合わせます）`;
  } else {
    els.rrSellStrikeHint.textContent = "";
  }
  // 比率の入力欄の下: いま使っている権利行使価格
  const ratioHint = sellEff === null ? ""
    : entered ? `売りの権利行使価格 ${fmtStrike(sellEff)}（入力値）を使用中。比率を変更すると、この入力は消えます`
      : `権利行使価格 ${fmtStrike(sellEff)} になるように、比率を合わせています`;
  els.ratioEffHint.textContent = ratioHint;

  // 比率を、権利行使価格(整数)になるように合わせる。
  //  ・売りの権利行使価格を入力しているとき: 常に、その価格に合わせた比率を表示する(価格が主、比率は従)。
  //  ・空欄のとき: 比率を変えたあと・分析したときだけ(t.ratioNormalize)、整数の権利行使価格になる比率に直す
  //    (毎回直すと、株価が動くたびに比率が少しずつずれていくため)。
  // 4桁に丸めても同じ整数になるよう、プット系は切り上げ、コール系は切り下げ(権利行使価格が、現在値から離れる側に残る向き)で丸める。
  // 入力欄に文字を打っている最中は、書き換えない(入力が終わったとき(changeイベント)に直す)。
  if (latest !== null && sellEff > 0 && (entered || t.ratioNormalize)) {
    const r4 = ratio4(sellEff, latest, itmWhen);
    const typing = !t.ratioCommit && document.activeElement === els.ratioInput;
    if (!typing) {
      t.ratio = r4;
      els.ratioInput.value = r4;
    }
  }
  t.ratioNormalize = false;
  t.ratioCommit = false;

  // 差額
  let widthAuto = false;
  let warn = "";
  if (isSellSp && t.rrBuyStrike > 0 && sellEff > 0) {
    const ok = isPut ? t.rrBuyStrike < sellEff : t.rrBuyStrike > sellEff;
    if (ok) {
      t.rrSpreadWidth = Math.round(Math.abs(sellEff - t.rrBuyStrike) * 100) / 100;
      widthAuto = true;
      els.rrWidthHint.textContent = `売り ${fmtStrike(sellEff)} − 買い ${fmtStrike(t.rrBuyStrike)}（自動計算）`;
    } else {
      t.rrSpreadWidth = null;
      warn = isPut ? "買いの権利行使価格は、売りより低い値にしてください（ブルプット）" : "買いの権利行使価格は、売りより高い値にしてください（ベアコール）";
      els.rrWidthHint.textContent = "";
    }
  } else {
    els.rrWidthHint.textContent = "";
  }
  els.rrBuyStrikeWarn.textContent = warn;
  els.rrSpreadWidthInput.disabled = widthAuto;
  if (widthAuto || (isSellSp && t.rrBuyStrike > 0 && warn)) els.rrSpreadWidthInput.value = t.rrSpreadWidth ?? "";

  // 受取プレミアム
  const legs = isSellSp && t.rrPremMode === "legs";
  els.premModeNet.classList.toggle("active", !legs);
  els.premModeLegs.classList.toggle("active", legs);
  els.premLegsRow.hidden = !legs;
  els.rrPremiumInput.disabled = legs;
  if (legs) {
    const net = t.rrPremSell !== null && t.rrPremBuy !== null ? Math.round((t.rrPremSell - t.rrPremBuy) * 100) / 100 : null;
    t.rrPremium = net !== null && net >= 0 ? net : null;
    els.rrPremiumInput.value = t.rrPremium ?? "";
    els.rrPremiumHint.textContent = net === null ? "売りと買いのプレミアムを入力すると、自動で計算します"
      : net < 0 ? "買いのプレミアムが、売りより高くなっています" : `売り ${t.rrPremSell.toFixed(2)} − 買い ${t.rrPremBuy.toFixed(2)}（自動計算）`;
  } else {
    els.rrPremiumHint.textContent = "";
  }
}

// 現在の権利行使価格(本日の終値×比率)。データ未取得ならnull。
function todayStrikeOf(t) {
  if (!t.closesFull || !t.closesFull.length) return null;
  const c = viewDataOf(t).closes;
  return effStrikeOf(t, c[c.length - 1]);
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
  const { todayStrike: ratioStrike } = depthInfo(t, closes);
  const latest = closes[closes.length - 1];
  // 売りの権利行使価格(入力があればその値。なければ、比率から決めた整数の値)
  const todayStrike = ratioStrike;

  els.orderTypeLabel.textContent = `：${isSp ? labels.spread : labels.naked}`;

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
    strikeText = `権利行使価格${fmtStrike(todayStrike)}ドル`;
  } else {
    // 比率で決まる権利行使価格(売り系は売り建て側、買い系は買い建て側)と、差額分だけ離れたもう一方の脚。
    // プット系はもう一方が安い側、コール系は高い側。
    const w = t.rrSpreadWidth;
    const far = w === null ? null : (pc === "P" ? todayStrike - w : todayStrike + w);
    const farText = far === null ? "―" : fmtStrike(far);
    strikeText = group === "sell"
      ? `${fmtStrike(todayStrike)}${pc}売/${farText}${pc}買`
      : `${fmtStrike(todayStrike)}${pc}買/${farText}${pc}売`;
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
    renderIvHv(t, latest, type.itmWhen);
    renderOrderExit(t, dates[dates.length - 1]);
    renderStressTest(t, latest, type.itmWhen);
    renderIvTime(t, latest, type.itmWhen, dates[dates.length - 1]); // 時間の経過の表で選んだ場面があれば、ここで損切りの場面を差し替える
    renderRiskPlan(t);
  }
  renderBreakEvenPrice(t, closes, todayStrike);
  if (PAGE === "buy" && group === "buy") {
    updateRateUI(t);
    renderBuyIv(t, latest, todayStrike);
    renderBuyRisk(t, latest, todayStrike, dates[dates.length - 1]);
    renderBuyPlan(t, latest, todayStrike, dates[dates.length - 1]);
  }
  els.orderCard.hidden = false;
}

// 利確割合(%)。未入力のときは講座の基準の80%(8割利確=2割を支払って決済)。
const DEFAULT_PROFIT_PERCENT = 80;
// 満期の何営業日前に、値動きのグラフへ縦線(判断日)を引くか
const MARK_BEFORE_EXPIRY = 10;
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
      name: "利確の支払い価格", line: "買い戻しの指値",
      value: hasPremium ? money(premium * (1 - ratio / 100)) : "―",
      sub: hasPremium ? `受取${money(premium)}×(1−${ratio}%)${ratioNote}` : noInput,
      note: "反対売買（買い戻し）で決済するときの指値価格です。受取プレミアム×(1−利確割合)。\n注文が約定したらすぐに、この価格で利確注文を出しておきます（講座の基準は、受取りの2割を支払う＝8割を手元に残す）。\nスプレッドの場合は、2つの脚の差し引き後の価格で出します。\n1株あたりの価格で、手数料は含みません。",
    },
    {
      name: "利確したときの利益額",
      value: hasPremium ? money(premium * ratio / 100) : "―",
      sub: hasPremium ? `100株(1契約)で${perContract(premium * ratio / 100)}ドル` : noInput,
      note: "利確の支払い価格で決済できた場合に、手元に残る利益額（1株あたり）です。受取プレミアム×利確割合。手数料は含みません。",
    },
    {
      name: "ロスカットの逆指値価格",
      value: hasPremium ? `${money(premium * STOP_MULTIPLE_MIN)}〜${money(premium * STOP_MULTIPLE_MAX)}` : "―",
      sub: hasPremium ? `受取${money(premium)}の${STOP_MULTIPLE_MIN}〜${STOP_MULTIPLE_MAX}倍` : noInput,
      note: "ロスカット（損切り）を逆指値の注文で出すときの価格の目安です。講座の基準は、受取プレミアムの1.9〜2倍です。\n現在値がこの価格を超えたときに、買い戻しの注文が出ます。\n逆指値は、発動した後に指定価格より不利な価格で約定することがあります。\nロスカットを入れるかどうか、倍率を何倍にするかは、ご自身のリスク許容度で決めてください。",
    },
    {
      name: "ロスカット時の損失額",
      value: hasPremium ? `${money(premium * (STOP_MULTIPLE_MIN - 1))}〜${money(premium * (STOP_MULTIPLE_MAX - 1))}` : "―",
      sub: hasPremium ? `100株(1契約)で${perContract(premium * (STOP_MULTIPLE_MIN - 1))}〜${perContract(premium * (STOP_MULTIPLE_MAX - 1))}ドル` : noInput,
      note: "逆指値の価格で決済できた場合の損失額（1株あたり）です。逆指値の価格−受取プレミアム。\n2倍で決済すると、受け取ったプレミアムと同じ額の損失になります。\n実際の約定価格がずれた場合は、この額と異なります。手数料は含みません。",
    },
  ];
  els.orderExitSummary.innerHTML = items.map((it) => statCardHtml({ ...it, attrs: 'data-target="orderExplain"' })).join("");
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
      name: "満期日", value: fmtDate(expiry), sub: `残り${days}営業日（${cal}暦日）・${EXPIRY_KIND_LABEL[expiryKind(expiry)]}`,
      note: "上の「満期日（判定期間）」で入力した満期日です。基準日（最新の終値の日）から、この営業日数後になります。\n実際にその満期日があるかは、銘柄ごとに異なります。証券会社のオプションチェーンで確認してください。",
    },
    {
      name: "2週間前の判断日", value: reviewDate === null ? "―" : fmtDate(reviewDate),
      sub: reviewDate === null ? "満期まで10営業日以内のため、ありません" : "満期まで残り10営業日",
      note: "満期まで残り10営業日（約2週間）になる日です。この時点で利益が出ていれば、利確するか、取引を継続するかを検討する目安日です。\n満期が近いほど、株価が急に動いたときに回復を待つ期間が短くなります。",
    },
    {
      name: "3日前の決済日", value: fmtDate(closeDate), sub: "満期の3営業日前",
      note: "満期の3営業日前です（金曜満期なら火曜日）。遅くともこの日までに、反対売買で決済します。",
    },
  ];
  els.expirySummary.innerHTML = dateItems.map((it) => statCardHtml({ ...it, attrs: 'data-target="orderExplain"' })).join("");
  els.expiryNote.textContent =
    `${EXPIRY_KIND_NOTE[expiryKind(expiry)]}実際にあるかは、証券会社のオプションチェーンで確認してください。`
    + (cal > GUIDE_MAX_CALENDAR_DAYS ? " 講座の満期の目安（約60暦日まで）を超えています。" : "")
    + " 休場日は、毎年決まっている祝日のみ反映しています（臨時の休場は反映されません）。";
}

// 「ITMになる確率の3点比較(IV換算・HV換算・過去の実績)」のHTMLを作る(売り系のIVとHVの比較セクション用)。
//  ・IV換算: 市場の見込み(IV)から求めた理論上の確率 ・HV換算: 過去の実際の値動き(HV)から求めた理論上の確率 ・過去の実績: 同じ条件で過去にITMになった割合(分析結果と同じ)
// 2つの見方で並べる: 「満期時にITM」(理論は正規分布の近似、実績は判定期間の最終日にITMだった割合。同じ条件で比べられる)と、
// 「期間中に一度でもITMに届く」(理論は満期時の2倍・上限100%の目安、実績は毎日の終値で一度でも届いた割合。理論のほうが多めに出やすい)。
// 結論の一文は、同じ条件で比べられる「満期時」で、IV換算と実績の差から作る。
function ivHvCompareHtml(t, thIv, thHv, days, itmWhen, group = "sell") {
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const pc = periodClosesOf(t);
  const pd = periodDatesOf(t);
  const { depthPct } = depthInfo(t, pc);
  const an = computeItmAnalysis(pc, { ratio: effRatioOf(t, pc[pc.length - 1]), itmWhen, window: days, group, depthPct }, pd);
  if (!an.entryCount) return "";
  const actExp = an.dayProb[days - 1] ?? null;
  const actTouch = an.overallItmProb;
  const rowsOf = (vals) => {
    const max = Math.max(...vals.map((x) => x.v ?? 0), 0.01);
    return vals.map((x) =>
      `<div class="cmp3-row"><span class="cmp3-lab">${x.lab}</span><span class="cmp3-track">${x.v === null ? "" : `<span class="cmp3-bar ${x.cls}" style="width:${Math.max(1, (x.v / max) * 100).toFixed(1)}%"></span>`}</span><b class="cmp3-val">${x.v === null ? "―" : pct(x.v)}</b></div>`).join("");
  };
  const grp = (title, vals) => `<div class="cmp3-group"><div class="cmp3-gtitle">${title}</div>${rowsOf(vals)}</div>`;
  const html = grp("満期時にITMになる確率", [
      { lab: "IV換算", cls: "cmp3-iv", v: thIv.probItmAtExpiry },
      { lab: "HV換算", cls: "cmp3-hv", v: thHv.probItmAtExpiry },
      { lab: "過去の実績", cls: "cmp3-act", v: actExp },
    ])
    + grp("期間中に一度でもITMに届く確率", [
      { lab: "IV換算", cls: "cmp3-iv", v: thIv.probTouch },
      { lab: "HV換算", cls: "cmp3-hv", v: thHv.probTouch },
      { lab: "過去の実績", cls: "cmp3-act", v: actTouch },
    ]);

  // 結論の一文(満期時。IV換算と実績の比較)
  let verdict = "";
  if (actExp !== null && group === "buy") {
    // 買い手向け: ITMになりやすい(IV換算が大きい)ほど、市場はその分プレミアムを高く見ている(割高)
    const ivP = thIv.probItmAtExpiry;
    if (actExp === 0 && ivP > 0) {
      verdict = `過去の実績では、満期時にITM${depthSuffixOf(t)}だったことは一度もありません。市場の見込み(IV換算)は${pct(ivP)}で、過去の実績より、ITMになりやすいと見ています。そのぶん、支払うプレミアムは、過去の実績のリスクに対して割高な側です。ただし、調べた期間の値動きが穏やかだっただけの可能性もあります。`;
    } else if (actExp > 0) {
      const r = ivP / actExp;
      if (r >= 1.25) verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})より、満期時にITMになりやすいと見ています。そのぶん、支払うプレミアムは、過去の実績のリスクに対して割高な側です。ただし、調べた期間の値動きが穏やかだっただけの可能性もあります。`;
      else if (r <= 0.8) verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})より、満期時にITMになりにくいと見ています。そのぶん、支払うプレミアムは、過去の実績に対して割安な側です。ただし、調べた期間が荒れていただけの可能性もあります。`;
      else verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})と、ほぼ同じ水準です。`;
    }
  } else if (actExp !== null) {
    const ivP = thIv.probItmAtExpiry;
    if (actExp === 0 && ivP > 0) {
      verdict = `過去の実績では、満期時にITMだったことは一度もありません。市場の見込み(IV換算)は${pct(ivP)}で、過去の実績より、ITMになりやすいと見ています。過去と同じ値動きなら、受け取るプレミアムが、過去の実績のリスクを上回る側です（ただし、市場は、過去の実績より大きな動きを見込んでいるので、リスクも高めです）。ただし、調べた期間の値動きが穏やかだっただけの可能性もあります。`;
    } else if (actExp > 0) {
      const r = ivP / actExp;
      if (r >= 1.25) verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})より、満期時にITMになりやすいと見ています。過去と同じ値動きなら、受け取るプレミアムが、過去の実績のリスクを上回る側です（ただし、市場は、過去の実績より大きな動きを見込んでいるので、リスクも高めです）。ただし、調べた期間の値動きが穏やかだっただけの可能性もあります。`;
      else if (r <= 0.8) verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})より、満期時にITMになりにくいと見ています。過去と同じ値動きなら、受け取るプレミアムが、過去の実績のリスクに見合わない側です（市場は、過去の実績より穏やかな動きを見込んでいます）。ただし、調べた期間が荒れていただけの可能性もあります。`;
      else verdict = `市場の見込み(IV換算 ${pct(ivP)})は、過去の実績(${pct(actExp)})と、ほぼ同じ水準です。`;
    }
  }
  const trials = Math.max(1, Math.round(an.entryCount / days));
  const expCount = actExp === null ? null : Math.round(actExp * an.entryCount);
  const period = pd && pd.length ? `${pd[0]}〜${pd[pd.length - 1]}` : "";
  const note = `過去の実績は、${period ? `${period}の` : ""}${an.entryCount}件のエントリーから求めています（判定期間が重なるため、独立した試行は約${trials}回分です）。`
    + (expCount === null ? "" : `満期時にITMだったのは${expCount}件、期間中に一度でも届いたのは${an.itmEntryCount}件です。`)
    + "「期間中に一度でも届く」の理論値は、毎日の終値だけを見る実績より、多めに出やすい点に注意してください。";
  const explain = "同じ権利行使価格（判定する深さ込み）について、ITMになる確率を3つの見方で並べます。\n"
    + "IV換算＝市場のこれからの見込み（IV）から求めた理論上の確率。HV換算＝過去に実際に動いた大きさ（HV）から求めた理論上の確率。過去の実績＝同じ条件で、過去にITMになった割合（分析結果と同じ）。\n"
    + "「満期時」は、判定期間の最終日にITMだった割合で、理論と実績を同じ条件で比べられます。「期間中に一度でも」の理論値は、毎日の終値だけを見る実績より、多めに出やすいです。\n"
    + "棒の長さは、それぞれの段の中での比較です。将来を保証するものではありません。";
  return `<div class="chart-title" data-note="${explain}">ITMになる確率の3点比較（IV換算・HV換算・過去の実績）</div>`
    + html
    + (verdict ? `<p class="sub cmp3-verdict">${verdict}</p>` : "")
    + `<p class="sub">${note}</p>`;
}

// 「推奨比率の逆算」(売り系のみ)。比率を動かして、過去の実績のITM発生率(分析結果と同じ計算)を求め、
// 目標(ITM発生率◯%以下)を満たす「最も現在値に近い比率」(受取が多くなる側)を選ぶ。
// プット売り系は1.00から0.70まで、コール売り系は1.00から1.30まで、0.01刻み。判定する深さは、いまの入力の割合をそのまま使う。
// ITM発生率は、比率が現在値から遠いほど必ず下がる(各エントリーのITM判定は、権利行使価格が遠いほど厳しくなる)ので、近い側から探して最初に条件を満たした比率を選ぶ。
const RATIO_TARGET_KEY = "itm-tool-ratio-target-v1";
const RATIO_MINPREM_KEY = "itm-tool-ratio-minprem-v1";
const RATIO_STEP_KEY = "itm-tool-ratio-step-v1"; // 一覧の刻み: "ratio"(比率1%刻み)・"1"・"5"・"10"(ドル)
function ratioStepSetting() {
  try {
    const v = localStorage.getItem(RATIO_STEP_KEY);
    if (v === "1" || v === "5" || v === "10") return Number(v);
  } catch (e) { /* 既定値を使う */ }
  return 0; // 0=比率1%刻み
}
function ratioSetting(key, def, max) {
  try {
    const raw = localStorage.getItem(key);
    const v = Number(raw);
    if (raw !== null && raw !== "" && Number.isFinite(v) && v >= 0 && v <= max) return v;
  } catch (e) { /* 既定値を使う */ }
  return def;
}
const ratioTargetPct = () => ratioSetting(RATIO_TARGET_KEY, 5, 100);
const ratioMinPremium = () => ratioSetting(RATIO_MINPREM_KEY, 0.45, 1000);

function renderRatioCard(t) {
  const group = typeGroup(t.typeKey);
  if (group !== "sell") { els.ratioCard.hidden = true; return; }
  const type = OPTION_TYPES[t.typeKey];
  const isPut = type.itmWhen === "below";
  const kind = isPut ? "put" : "call";
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const days = t.windowDays;
  const price = closes[closes.length - 1];
  const { depthPct } = depthInfo(t, closes);
  const { closes: vc } = viewDataOf(t);
  const hv = vc ? computeHv(vc, days) : null;
  const target = ratioTargetPct();
  const minPrem = ratioMinPremium();
  els.ratioTargetInput.value = target;
  els.ratioMinPremInput.value = minPrem;
  const stepDollar = ratioStepSetting();
  els.ratioStepBtns.querySelectorAll("[data-step]").forEach((b) => {
    const on = b.dataset.step === (stepDollar ? String(stepDollar) : "ratio");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const pctText = (v, d = 1) => (v * 100).toFixed(d) + "%";

  // 受取プレミアムの理論値(スプレッド注文で、差額と、IV(入力 or 受取から逆算)があるときだけ)。IVは比率によらず一律とみなす。
  const width = t.rrSpreadWidth;
  const spreadOk = t.rrVariant === "spread" && width > 0;
  const T = days / TRADING_DAYS_PER_YEAR;
  const buyStrikeOf = (sellStrike) => (isPut ? sellStrike - width : sellStrike + width);
  let ivs = null;
  if (spreadOk) {
    const nowSell = sellStrikeOf(t, price);
    ivs = resolveIvs({
      kind, price, strikeSell: nowSell, strikeBuy: buyStrikeOf(nowSell), T,
      premium: t.rrPremium !== null && t.rrPremium > 0 ? t.rrPremium : null,
      ivSell: t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null,
      ivBuy: t.rrIvBuy !== null && t.rrIvBuy > 0 ? t.rrIvBuy / 100 : null,
    });
    if (ivs && buyStrikeOf(nowSell) <= 0) ivs = null;
  }
  els.ratioPremHint.textContent = ivs
    ? `受取は、${ivs.source === "input" ? `入力したIV（売り建て側 ${(ivs.sellIv * 100).toFixed(1)}%${t.rrIvBuy > 0 ? `、買い建て側 ${(ivs.buyIv * 100).toFixed(1)}%` : ""}）` : `入力した受取プレミアム額から逆算したIV ${(ivs.sellIv * 100).toFixed(1)}%`}と、差額${width}ドルから、Black-Scholesの式（金利0・配当なし、IVは比率によらず一律）で計算した理論値です。実際のオプションチェーンの値とは、ずれます。`
    : (spreadOk
      ? "受取の下限も判定するには、「注文内容」で、IV（売り建て側）か、受取プレミアム額を入力してください。"
      : "受取の下限も判定するには、「注文内容」で、スプレッド注文（SP）にして、権利行使価格の差額と、IV（売り建て側）または受取プレミアム額を入力してください。");

  // 一覧は、1%刻みの比率に当たる「整数の権利行使価格」を、現在値に近い側から並べる(同じ整数になる比率は1行にまとめる)。
  // いま使っている権利行使価格(入力値、または比率から決めた値)が一覧にないときは、追加する。
  const itmWhen = type.itmWhen;
  // 刻みを1・5・10ドルにしたときは、その倍数の権利行使価格を並べる(現在値から30%離れるまで)。
  const nominalOf = new Map();
  if (stepDollar > 0) {
    const limit = price * (isPut ? 0.7 : 1.3);
    let K = isPut ? Math.floor(price / stepDollar + 1e-9) * stepDollar : Math.ceil(price / stepDollar - 1e-9) * stepDollar;
    for (let n = 0; n < 400 && K > 0 && (isPut ? K >= limit : K <= limit); n++) {
      nominalOf.set(K, null);
      K += isPut ? -stepDollar : stepDollar;
    }
  } else {
    for (let k = 0; k <= 30; k++) {
      const r = Math.round((1 + (isPut ? -k : k) * 0.01) * 100) / 100;
      const K = roundStrike(price, r, itmWhen);
      if (!nominalOf.has(K)) nominalOf.set(K, r);
    }
  }
  // 講座の基準(比率0.90・0.85。プット売りのみ)の権利行使価格は、刻みにかかわらず目印をつける
  const baseK = isPut ? { [roundStrike(price, 0.9, itmWhen)]: "講座の基準", [roundStrike(price, 0.85, itmWhen)]: "講座の基準（より安全）" } : {};
  const curK = effStrikeOf(t, price);
  if (!nominalOf.has(curK)) nominalOf.set(curK, null);
  const strikes = [...nominalOf.keys()].sort((x, y) => (isPut ? y - x : x - y));

  const rows = [];
  let trials = 0;
  strikes.forEach((K, k) => {
    const r = K / price;
    const an = computeItmAnalysis(closes, { ratio: r, itmWhen: type.itmWhen, window: days, group, depthPct }, dates);
    if (k === 0) trials = Math.max(1, Math.round(an.entryCount / days));
    const th = hv === null ? null : hvTheory({ price, strike: K, depthDollar: depthDollarOf(t), itmWhen: type.itmWhen, days, hv });
    let prem = null;
    if (ivs) {
      const bs = buyStrikeOf(K);
      if (bs > 0) prem = positionValue({ kind, S: price, strikeSell: K, strikeBuy: bs, T, ivSell: ivs.sellIv, ivBuy: ivs.buyIv });
    }
    rows.push({ ratio: r, nominal: nominalOf.get(K), strike: K, itm: an.overallItmProb, badge: an.badge, level: an.badgeLevel, theory: th ? th.probItmAtExpiry : null, prem });
  });
  // ITM条件: 現在値から遠い側(kが大きい側)で満たされる。最初に満たす=推奨の権利行使価格
  const kRec = rows.findIndex((x) => x.itm !== null && x.itm <= target / 100);
  const rec = kRec >= 0 ? rows[kRec] : null;
  // 受取条件: 現在値に近い側(kが小さい側)で満たされる。満たす最も遠い権利行使価格が、受取の下限
  let kPrem = -1;
  if (ivs) { for (let k = 0; k < rows.length; k++) { if (rows[k].prem !== null && rows[k].prem >= minPrem) kPrem = k; else break; } }
  const cur = rows.find((x) => x.strike === curK) || null;
  const bandOk = ivs && rec && kPrem >= kRec;
  const inBand = (k) => bandOk && k >= kRec && k <= kPrem;
  const ratioOf = (x) => ratio4(x.strike, price, itmWhen);

  // 結果
  const cards = [];
  if (rec) {
    cards.push(statCardHtml({
      name: "推奨の権利行使価格", value: fmtStrike(rec.strike), suffix: `（ITM発生率 ${pctText(rec.itm)}）`,
      sub: `現在値${price.toFixed(2)}の${(rec.ratio * 100).toFixed(1)}%（比率${ratioOf(rec)}）。目標 ${target}%以下を満たす、最も現在値に近い権利行使価格${rec.prem !== null ? `。受取（理論）${rec.prem.toFixed(2)}` : ""}`,
      note: `権利行使価格（整数）を現在値に近い側から${isPut ? "下げて" : "上げて"}、過去の実績のITM発生率（分析結果と同じ計算。この権利行使価格を、終値で割った比率で計算）が目標（${target}%以下）を最初に満たした権利行使価格です。受取プレミアムは、現在値に近いほど多くなるため、条件を満たす最も近い権利行使価格を選んでいます。`,
      attrs: 'data-target="ratioExplain"',
    }));
  } else {
    const far = rows[rows.length - 1];
    cards.push(statCardHtml({
      name: "推奨の権利行使価格", value: "なし", sub: `権利行使価格${fmtStrike(far.strike)}（比率${ratioOf(far)}）まで離しても、ITM発生率は${far.itm === null ? "―" : pctText(far.itm)}で、目標（${target}%以下）に届きません`,
      note: "探した範囲（現在値から30%離れるまで）では、目標を満たす権利行使価格がありませんでした。目標のITM発生率を上げるか、満期日を短くすると、見つかることがあります。",
      attrs: 'data-target="ratioExplain"',
    }));
  }
  if (ivs) {
    const lowerWord = isPut ? "以上" : "以下";
    const premLimit = kPrem >= 0 ? rows[kPrem] : null;
    cards.push(statCardHtml({
      name: `受取${minPrem}以上を保てる権利行使価格`,
      value: premLimit ? `${fmtStrike(premLimit.strike)}${lowerWord}` : "なし",
      suffix: "（理論値）",
      sub: premLimit
        ? (kPrem === rows.length - 1 ? `探した範囲のすべてで、受取は${minPrem}以上です` : `権利行使価格${fmtStrike(premLimit.strike)}（比率${ratioOf(premLimit)}）で受取 ${premLimit.prem.toFixed(2)}。これより遠いと${minPrem}を下回ります`)
        : `現在値に最も近い権利行使価格でも、受取（理論）が${minPrem}に届きません`,
      note: `スプレッドの受取（理論値）が、下限（${minPrem}）以上を保てる、最も現在値から遠い権利行使価格です。現在値から遠い（安全な側の）権利行使価格ほど、受取は少なくなるため、これより遠い権利行使価格は、受取の条件を満たしません。IVは権利行使価格によらず一律とみなした理論値で、実際のオプションチェーンの値とは、ずれます。`,
      attrs: 'data-target="ratioExplain"',
    }));
    if (rec) {
      const pk = kPrem >= 0 ? rows[kPrem].strike : rec.strike;
      const lo = Math.min(rec.strike, pk);
      const hi = Math.max(rec.strike, pk);
      cards.push(statCardHtml({
        name: "条件を両立する権利行使価格", value: bandOk ? `${fmtStrike(lo)}〜${fmtStrike(hi)}` : "なし",
        sub: bandOk
          ? `ITM発生率${target}%以下 かつ 受取${minPrem}以上。このうち最も現在値に近い${fmtStrike(rec.strike)}が、受取も最大です`
          : `ITM発生率${target}%以下を満たす権利行使価格（${fmtStrike(rec.strike)}）では、受取（理論）${rec.prem === null ? "―" : rec.prem.toFixed(2)}で、${minPrem}に届きません`,
        note: bandOk
          ? "ITM発生率の目標と、受取の下限の、両方を満たす権利行使価格の幅です。幅が広いほど、余裕があります。"
          : "ITM発生率の条件を満たす権利行使価格では、受取が下限に届きません。権利行使価格の差額を広げる、満期を長くする、目標のITM発生率を上げる、などで、両立することがあります。",
        attrs: 'data-target="ratioExplain"',
      }));
    }
  }
  els.ratioSummary.innerHTML = cards.join("");
  if (rec) {
    const same = cur && rec.strike === cur.strike;
    els.ratioActions.innerHTML = same
      ? `<span class="field-hint">いまの権利行使価格（${fmtStrike(curK)}）が、推奨の権利行使価格です。</span>`
      : `<button type="button" class="sp-btn" data-use-strike="${rec.strike}">この権利行使価格（${fmtStrike(rec.strike)}）を採用する</button> <span class="field-hint">「売りの権利行使価格」に入力して、分析をやり直します（いま：${fmtStrike(curK)}${cur && cur.itm !== null ? `、ITM発生率 ${pctText(cur.itm)}` : ""}）</span>`;
  } else {
    els.ratioActions.innerHTML = "";
  }

  // 一覧(近い側から)
  const baseLabel = (K) => baseK[K] || "";
  els.ratioBody.innerHTML = rows.map((x, k) => {
    const marks = [];
    if (rec && x.strike === rec.strike) marks.push("推奨");
    if (cur && x.strike === cur.strike) marks.push("いまの設定");
    const lab = baseLabel(x.strike);
    if (lab) marks.push(lab);
    const cls = rec && x.strike === rec.strike ? "ratio-rec" : cur && x.strike === cur.strike ? "ratio-cur" : inBand(k) ? "ratio-band" : "";
    const premLine = x.prem === null ? "" : `<br><span class="ratio-prem ${x.prem >= minPrem ? "ok" : "ng"}">受取 ${x.prem.toFixed(2)}${x.prem >= minPrem ? " ✓" : " ✗"}</span>`;
    return `<tr class="${cls}"><td><b>${fmtStrike(x.strike)}</b> <span class="ratio-strike">（比率${ratioOf(x)}）</span>${marks.length ? `<br><span class="ratio-mark">${marks.join("・")}</span>` : ""}</td>`
      + `<td>${x.itm === null ? "―" : pctText(x.itm)}<br><span class="badge ${badgeLevelClass(x.level)}">${x.badge}</span></td>`
      + `<td>${x.theory === null ? "―" : pctText(x.theory)}${premLine}</td>`
      + `<td><button type="button" class="sp-btn" data-use-strike="${x.strike}">採用</button></td></tr>`;
  }).join("");
  els.ratioNote.textContent = `過去の実績に基づく目安です。独立した試行は、件数÷判定期間の営業日数で、約${trials}回分しかありません。選んだ権利行使価格が、たまたま過去に当てはまっただけの可能性もあります。判定する深さは、いまの入力の割合のまま使っています。満期時ITM率（HV換算）は、HVから求めた理論上の確率です。`
    + (ivs ? " 受取（理論）は、✓が下限以上、✗が下限未満です。薄い色の行は、ITM発生率と受取の両方の条件を満たす比率です。" : "");
  els.ratioCard.hidden = false;
  setupStatExplain();
}

// 権利行使価格を、「売りの権利行使価格」の入力欄に反映して、分析をやり直す(入力欄のinputイベントで、通常の再計算が走る)
function applyStrike(k) {
  els.rrSellStrikeInput.value = k;
  els.rrSellStrikeInput.dispatchEvent(new Event("input", { bubbles: true }));
}

// 「IVとHVの比較」を描画する(売り系のみ)。
// IV(オプション価格に織り込まれた将来の変動の大きさ)が、HV(過去の実際の値動きの大きさ。満期と同じ長さ)の何倍かを見て、
// 市場の見込み(IV)が、過去の値動き(HV)より高め(受け取るプレミアムは多め。ただし市場は大きな動きを見込んでいるのでリスクも高め)か低め(プレミアムは少なめ)かの目安にする。
// 「有利/不利」とは書かない(プレミアムの多さだけを指すのか、取引全体の損得かが紛らわしいため)。
// あわせて、HVの代わりにIVを使った理論上の確率(満期時にITM)を、HV換算の確率と並べて見せる(IVが高いほど、ITMになりやすい見積もりになる)。
// IVは、売り建て側のIVの入力があればそれを使い、なければ受取プレミアム額から逆算した全体のIVを使う。
function renderIvHv(t, price, itmWhen) {
  const kind = itmWhen === "below" ? "put" : "call";
  const isSp = t.rrVariant === "spread";
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const clear = (msg) => {
    drawCone(t, null);
    els.ivHvSummary.innerHTML = "";
    els.ivHvCompare.innerHTML = "";
    els.ivHvNote.textContent = msg;
  };
  const premium = t.rrPremium !== null && t.rrPremium > 0 ? t.rrPremium : null;
  const ivIn = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  const days = t.windowDays;
  const { closes } = viewDataOf(t);
  const hv = closes ? computeHv(closes, days) : null;
  if (hv === null) { clear("HVを計算するためのデータが足りないため、表示できません。"); return; }

  let iv;
  let source;
  const strikeSell = sellStrikeOf(t, price);
  if (ivIn !== null) {
    iv = ivIn;
    source = "input";
  } else {
    if (premium === null) { clear("IV（売り建て側）か、受取プレミアム額を入力すると表示します。"); return; }
    if (isSp && !(t.rrSpreadWidth > 0)) { clear("受取プレミアム額からIVを逆算するには、権利行使価格の差額を入力してください（IVを直接入力する場合は不要です）。"); return; }
    const strikeBuy = isSp ? (kind === "put" ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
    if (strikeBuy !== null && !(strikeBuy > 0)) { clear("権利行使価格の差額が大きすぎます（買い建て側の権利行使価格が0以下になります）。"); return; }
    iv = solveFlatIv({ kind, S: price, strikeSell, strikeBuy, T: days / TRADING_DAYS_PER_YEAR, premium });
    if (iv === null) { clear("受取プレミアム額に合うIVが見つかりませんでした。受取プレミアム額（スプレッドは差し引き後の正味の額）や権利行使価格の差額を、確認してください。"); return; }
    source = "calibrated";
  }

  const ratio = iv / hv;
  const judge = judgeIvHv(ratio);
  const depthDollar = depthDollarOf(t);
  const thIv = hvTheory({ price, strike: strikeSell, depthDollar, itmWhen, days, hv: iv });
  const thHv = hvTheory({ price, strike: strikeSell, depthDollar, itmWhen, days, hv });
  const pos = hvPosition(closes, days);
  drawCone(t, { thIv });

  const ivSuffix = source === "input" ? "（売り建て側・入力値）" : "（受取プレミアム額から逆算）";
  const ivSub = source === "input"
    ? "証券会社のオプションチェーンの値"
    : `受取プレミアム額${premium.toFixed(2)}に合うIV（${isSp ? "売り脚・買い脚を同じIVとみなした目安" : "売り脚のIV"}）`;
  const meaningShort = judge.level === "rich" ? "受け取るプレミアムは多め。ただし、市場は大きな動きを見込んでいるので、リスクも高め"
    : judge.level === "cheap" ? "受け取るプレミアムは少なめ。ただし、市場は穏やかな動きを見込んでいる"
      : "標準的な水準";
  band.ivhv = { ratio, word: judge.word, phrase: judge.phrase, meaning: meaningShort, iv, hv };
  const items = [
    {
      name: "IV", value: pct(iv), suffix: ivSuffix, sub: ivSub,
      note: `IV（インプライド・ボラティリティ）は、オプションの価格に織り込まれた、これからの値動きの見込みの大きさ（年率）です。HVが「過去に実際に動いた大きさ」なのに対し、IVは「市場がこれから動くと見込んでいる大きさ」で、実際の値動きではありません。IVが高いほど、オプションの価格（プレミアム）も高くなります。\n${source === "input" ? "売り建て側の権利行使価格のIVとして入力した値を使っています。" : "IVが未入力のため、入力した受取プレミアム額に合うIVを、Black-Scholesの式（金利0・配当なし）で逆算しています。スプレッドの場合は、売り脚と買い脚が同じIVだと仮定した目安です（実際は、遠い権利行使価格ほどIVが高いことが多いため、売り脚のIVとはずれます）。"}`,
    },
    {
      name: "IV÷HV", value: `${ratio.toFixed(2)}倍`,
      sub: `HV ${pct(hv)}（「4 HV」と同じ値）で割った倍率。${judge.phrase}／${meaningShort}`,
      note: `IVがHVの何倍かを見て、市場のこれからの見込み（IV）が、過去の実際の値動き（HV）より高めか低めかを判断する目安です。IVが高いほど、オプションの価格（プレミアム）も高くなります。\n1.2倍以上＝高め（受け取るプレミアムは多め。ただし、市場は大きな動きを見込んでいるので、リスクも高め）／0.8倍以下＝低め（受け取るプレミアムは少なめ。ただし、市場は穏やかな動きを見込んでいる）／その間＝同程度。この基準は、このツールの簡易的なものです。
「受け取る額が多い」ことと「取引が得になる」ことは別です。実際の値動きが、IVの見込みより小さく収まれば、売りは得になります。\n一般に、IVはHVより少し高めになりやすいため、「同程度」の幅を広めに取っています。`,
    },
  ];
  // 1σの値動き(IV基準)。「4 HV」の同名のカードと同じ計算で、HVの代わりにIVを使う。
  if (thIv) {
    items.push({
      name: "1σの値動き", value: `±${thIv.sigmaAmount.toFixed(2)}ドル`, suffix: "（IV基準）",
      sub: `満期まで。±${pct(thIv.sigmaPct)}（IV ${pct(iv)}×√(${days}/252)）`,
      note: `市場の見込み（IV）から見た、満期までの1σ（標準偏差）の値動きです。株価の変動が正規分布に近いと仮定すると、満期時の株価が現在値±この幅に収まる確率は約68%です。
1σ＝現在値×IV×√(営業日数÷252)。「4 HV」の1σの値動き（HV基準）と同じ計算で、HVの代わりにIVを使っています。IVのほうが大きければ、1σも広くなります。
IVは、売り建て側の1つの値を全体に当てはめた目安です。将来を保証するものではありません。`,
    });
  }
  // 理論プレミアム価格(HV計算。売り脚・買い脚ともHVを一律のIVとみなして計算)。受取額(未入力なら、入力したIVで計算した理論値)と比べる。
  // IV÷HVと同じ関係(受取が理論価格より少ない=IVがHVより低め)を、金額で見たもの。
  const fairStrikeBuy = isSp && t.rrSpreadWidth > 0 ? (kind === "put" ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
  if ((!isSp || fairStrikeBuy > 0) && days > 0) {
    const Tfair = days / TRADING_DAYS_PER_YEAR;
    const hvPrice = positionValue({ kind, S: price, strikeSell, strikeBuy: fairStrikeBuy, T: Tfair, ivSell: hv, ivBuy: hv });
    const ivBuyIn = t.rrIvBuy !== null && t.rrIvBuy > 0 ? t.rrIvBuy / 100 : iv;
    const ref = premium !== null ? premium : positionValue({ kind, S: price, strikeSell, strikeBuy: fairStrikeBuy, T: Tfair, ivSell: iv, ivBuy: ivBuyIn });
    if (hvPrice > 0.005 && ref > 0) {
      const diff = ref - hvPrice;
      const sign = diff >= 0 ? "+" : "−";
      const refLabel = premium !== null ? "受取" : "IVで計算した理論プレミアム価格";
      items.push({
        name: "理論プレミアム価格", value: hvPrice.toFixed(2), suffix: "（HV計算）",
        sub: `${refLabel} ${ref.toFixed(2)}／差 ${sign}${Math.abs(diff).toFixed(2)}（${sign}${Math.abs((diff / hvPrice) * 100).toFixed(0)}%）`,
        note: `オプションの価格（プレミアム価格。1株あたり）の理論値です。満期（${days}営業日）と同じ長さのHVを、売り脚・買い脚ともに一律のIVとみなして、Black-Scholesの式（金利0・配当なし）で計算しました（スプレッドは、売り脚−買い脚の正味の価格）。過去の実際の値動きから見て妥当な受取額の目安で、注文を出すときの目安として使えます。\n受取額が、この価格より少ないとき＝IVがHVより低め（IV÷HVが1倍未満）、多いとき＝IVがHVより高め（1倍超）です。IV÷HVと同じ関係を、金額で見たものです。\n${premium === null ? "受取プレミアム額が未入力のため、入力したIVで計算した理論価格と比べています。\\n" : ""}HVは過去の値動きなので、市場の価格（IV）とは、ずれて当然です。決算発表などをまたぐ場合は、市場の価格のほうが高いのは自然です。目安であり、断定的な判定には使えません。`,
      });
    }
  }
  els.ivHvSummary.innerHTML = items.map((it) => statCardHtml({ ...it, attrs: 'data-target="orderExplain"' })).join("");
  els.ivHvCompare.innerHTML = thIv && thHv ? ivHvCompareHtml(t, thIv, thHv, days, itmWhen) : "";

  const meaning = judge.level === "rich"
    ? "売り手にとっては、受け取るプレミアムは多めです。ただし、市場が今後の大きな動き（決算発表など）を見込んでいるためで、ITMになる確率の見積もりも高く、リスクも高めです。実際の値動きがIVの見込みより小さく収まれば、売りは得になります。"
    : judge.level === "cheap"
      ? "売り手にとっては、受け取るプレミアムは少なめです。ただし、市場は穏やかな動きを見込んでいます。実際に大きく動くと、受け取る額に対して損失が大きくなります。"
      : "売り手にとっては、標準的な条件です。";
  els.ivHvNote.textContent = `IV${pct(iv)}は、満期と同じ長さのHV${pct(hv)}の${ratio.toFixed(2)}倍です。${judge.phrase}。${meaning}`
    + `※IVは、これからの値動きの見込みです（実際の値動きではありません）。HVは、過去に実際に動いた大きさです。決算発表などの予定された出来事をまたぐ場合は、IVが高いのは自然で、売り手に得とは限りません。判定の基準（1.2倍以上＝高め、0.8倍以下＝低め）は、このツールの簡易的なものです。`;
  setupStatExplain();
}

// 「IVの変化と時間の経過の影響(株価が変わらない場合)」の表を描画する(売り系のみ)。
// 株価は今の水準のまま動かないとして、IVが変わり(縦)、時間が経った(横)ときに、いまのポジションを買い戻すのに必要な価格(現在値)と損益を、
// Black-Scholes(金利0・配当なし、IVは全体が一律に動く)で再計算した目安。横は、講座の判断日に合わせて「いま」「2週間前(残り10営業日)」「3日前(残り3営業日)」。
// 緑=利確の目安(受取額×(1−利確割合))以下に届いたマス、橙=ロスカットの逆指値の水準(受取額の1.9倍)以上、濃い色=スプレッド幅の上限に近い水準。
const IVTIME_CHANGES = [-0.10, -0.05, 0, 0.10, 0.20, 0.30];

function renderIvTime(t, price, itmWhen, asOfDate) {
  const kind = itmWhen === "below" ? "put" : "call";
  const isSp = t.rrVariant === "spread";
  const days = t.windowDays;
  const clear = (msg) => {
    els.ivTimeIntro.textContent = "";
    els.ivTimeHead.innerHTML = "";
    els.ivTimeBody.innerHTML = "";
    els.ivTimeNote.textContent = msg;
  };
  const premium = t.rrPremium !== null && t.rrPremium > 0 ? t.rrPremium : null;
  const ivSell = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  const ivBuy = t.rrIvBuy !== null && t.rrIvBuy > 0 ? t.rrIvBuy / 100 : null;
  if (isSp && !(t.rrSpreadWidth > 0)) { clear("権利行使価格の差額を入力すると表示します。"); return; }
  if (premium === null && ivSell === null) { clear("受取プレミアム額、またはIV（売り建て側）を入力すると表示します。"); return; }
  const strikeSell = sellStrikeOf(t, price);
  const strikeBuy = isSp ? (kind === "put" ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
  if (strikeBuy !== null && !(strikeBuy > 0)) { clear("権利行使価格の差額が大きすぎます（買い建て側の権利行使価格が0以下になります）。"); return; }

  // 横: いま / 2週間前(残り10営業日) / 3日前(残り3営業日)。いまの満期がそれより短い列は出さない
  const cols = [{ remain: days, name: "いま" }];
  if (days > 10) cols.push({ remain: 10, name: "2週間前" });
  if (days > 3) cols.push({ remain: 3, name: "3日前" });
  const res = ivTimeTable({
    kind, price, strikeSell, strikeBuy, days, premium, ivSell, ivBuy,
    ivChanges: IVTIME_CHANGES, remains: cols.map((c) => c.remain),
  });
  if (!res) { clear("受取プレミアム額に合うIVが見つかりませんでした。受取プレミアム額（スプレッドは差し引き後の正味の額）や権利行使価格の差額を、確認してください。"); return; }
  const { rows, meta } = res;
  if (meta.source === "input" && meta.v0 <= 0) {
    clear(`入力したIV（売り建て側 ${(meta.ivSell * 100).toFixed(1)}%、買い建て側 ${(meta.ivBuy * 100).toFixed(1)}%）の組み合わせでは、スプレッドの価格が0以下になります（買い建て側のほうが高くなる）。IVの差が大きすぎないか、確認してください。`);
    return;
  }

  const received = meta.received;
  const stopMin = received * 1.9;
  const profitMax = received * (1 - profitPercentOf(t) / 100);
  const maxValue = meta.width === null ? null : meta.width * 0.98;
  const money = (v) => v.toFixed(2);
  const pnlText = (pnl) => `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}（100株で${pnl >= 0 ? "+" : "−"}${Math.abs(pnl * 100).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル）`;
  const dateOf = (remain) => shiftTradingDays(asOfDate, -(days - remain)).slice(5);

  els.ivTimeIntro.textContent = `株価は今の水準（${money(price)}）のまま動かず、IVだけが変わり、時間が経った場合に、いまのポジションを買い戻すのに必要な価格（現在値）と、そのときの損益の目安です。満期まで${days}営業日の状態を基準にしています。`;
  els.ivTimeHead.innerHTML = `<tr><th>IVの変化</th>${cols.map((c) =>
    `<th>${c.name}<br><span class="stress-sub">残り${c.remain}営業日（${dateOf(c.remain)}）</span></th>`).join("")}</tr>`;
  // 損切りの場面: この表のセルを選んでいるときは、損切りの場面(lastStress.picked)をこのセルに差し替える
  const pick = parseStopPick(t);
  let pickedCell = null;
  if (pick.type === "time") {
    for (const r of rows) {
      if (Math.abs(r.ivUp - pick.ivUp) > 1e-9) continue;
      const c = r.cells.find((x) => x.remain === pick.remain);
      if (c && c.value > received) pickedCell = { r, c };
    }
    if (!pickedCell) { // 選んでいたセルが、いまの条件(満期までの日数・IV)に無いときは、選択を外す
      t.stopPick = null;
      persistState();
      renderStressTest(t, price, itmWhen);
      pick.type = "stress";
    }
  }
  const limitInfo = limitInfoOf(t, received); // 損失が資金の2%になる買い戻し価格
  const limitValue = limitInfo.value;
  els.ivTimeIntro.textContent += ` ${limitLineText(limitInfo, money, maxValue)}`;
  els.ivTimeBody.innerHTML = rows.map((r) => {
    const label = r.ivUp === 0 ? "変わらない" : `${r.ivUp > 0 ? "＋" : "−"}${Math.abs(Math.round(r.ivUp * 100))}ポイント`;
    return `<tr><td>${label}<br><span class="stress-sub">IV ${(r.ivSell * 100).toFixed(1)}%</span></td>${r.cells.map((c) => {
      const nearMax = maxValue !== null && c.value >= maxValue;
      const stop = c.value >= stopMin;
      const profit = c.value <= profitMax;
      const over = limitValue !== null && c.value >= limitValue;
      const selectable = c.value > received; // 損失が出る場面だけ、損切りの場面に選べる
      const picked = pickedCell !== null && pickedCell.c === c;
      const cls = [nearMax ? "stress-max" : stop ? "stress-stop" : profit ? "stress-profit" : "", over ? "stress-over" : "", selectable ? "stress-pickable" : "", picked ? "stress-picked" : ""].filter(Boolean).join(" ");
      return `<td class="${cls}"${selectable ? ` data-stop-pick="time|${c.remain}|${r.ivUp}" title="クリックで、この場面を損切りの場面にします（もう一度クリックすると外れます）"` : ""}><b>${money(c.value)}</b><br><span class="stress-pnl ${c.pnl < 0 ? "neg" : ""}">${pnlText(c.pnl)}</span>${over ? '<br><span class="stress-overtag">資金2%超</span>' : ""}${picked ? '<br><span class="stress-picktag">損切りの場面に選択中</span>' : ""}</td>`;
    }).join("")}</tr>`;
  }).join("");
  if (pickedCell) {
    const { r, c } = pickedCell;
    const col = cols.find((x) => x.remain === c.remain);
    if (!lastStress) lastStress = { received: meta.received, meta, limitValue, picked: null };
    lastStress.picked = {
      key: "time", scene: "time", shock: 0, price, ivUp: r.ivUp, value: c.value, pnl: c.pnl, remain: c.remain, remainName: col.name,
      label: `株価は変わらず・${col.name}`,
    };
  }

  const ivText = meta.source === "input"
    ? `IVは入力値を使っています（売り建て側 ${(meta.ivSell * 100).toFixed(1)}%${isSp ? `、買い建て側 ${(meta.ivBuy * 100).toFixed(1)}%${ivBuy === null ? "（売り建て側と同じ）" : ""}` : ""}）。`
    : `IVは、受取プレミアム額${money(premium)}に合うように逆算した ${(meta.ivSell * 100).toFixed(1)}%（売り脚・買い脚とも同じ）を使っています。`;
  const receivedText = premium === null
    ? `受取プレミアム額が未入力のため、IVから計算した理論値 ${money(meta.v0)} を受取額の代わりにしています。`
    : (meta.source === "input" && Math.abs(meta.v0 - premium) > Math.max(0.05, premium * 0.15)
      ? `※入力したIVから計算した現在値（理論値 ${money(meta.v0)}）と、入力した受取プレミアム額 ${money(premium)} が離れています。損益は、入力した受取プレミアム額を基準にしています。`
      : "");
  els.ivTimeNote.textContent = [
    ivText,
    receivedText,
    `緑のセルは、現在値が利確の目安（受取額×（1−利確割合${profitPercentOf(t)}%）＝${money(profitMax)}）以下になり、利確の条件に届いています。橙のセルは、現在値が${money(stopMin)}以上（受取額の1.9倍以上＝ロスカットの逆指値の水準）です${maxValue !== null ? "。さらに濃い色は、スプレッド幅の上限（最大損失）に近い水準です" : ""}。`,
    `時間が経つと、株価が動かなくても現在値は下がります（時間の経過による価値の減り）。IVが上がると現在値は上がり、IVが下がると下がります（決算発表のあとは、IVが下がりやすい傾向があります）。株価も動く場合は、「株価が動いた場合」のタブ（ストレステスト）を見てください。損失が出るセル（現在値が受取額より高いセル）は、クリックすると「損切りの場面」として選べます（太い枠のセル。もう一度クリックすると外れます）。選んだ場面は、リスクリワードと、注文まとめに反映されます。`,
    "金利0・配当なし、IVは全体が一律に動くとして計算した目安です。実際の価格とは、スキュー・流動性などでずれます。",
  ].filter(Boolean).join(" ");
}

// ---- 損切りの目安(資金の2%まで)・リスクリワード・注文まとめ ----
// ・1回の損切りで許せる損失額＝「投資に回せるトータル資金額」の2%。
// ・発注する枚数を入れると、損失がこの2%になる買い戻し価格(損切りの目安の上限)が決まる。
//     損切りの買い戻し価格の上限 ＝ 受取プレミアム ＋ (資金×2% ÷ (100株×枚数))
// ・ストレステストの表(株価が動いた場合／株価が変わらず時間が経った場合)では、この価格以上になるセルに「2%超」の印を付ける。
// ・損切りの場面は、表のセルをクリックして選べる(任意)。選ぶと、その場面での損失・枚数の上限・リスクリワードを出す。
// ・リスクリワード＝利確したときの利益 ÷ 損切りしたときの損失(1株あたり)。場面を選ばないときの損失は、2%の上限。
const RISK_PCT = 0.02;
const RISK_CAPITAL_KEY = "itm-tool-risk-capital-v1";
const riskCapital = () => ratioSetting(RISK_CAPITAL_KEY, 0, 1e9);

// ストレステスト・リスクリワード・注文まとめの間で受け渡す、直近の計算結果
let lastStress = null; // {picked, received, meta, limitValue}。計算できなかったときはnull
let lastRisk = null;

// 損失が資金の2%になる買い戻し価格(=損切りの目安の上限)。表の「資金2%超」の印に使う。
// 発注枚数が未入力のときは、仮に1枚として計算する(assumed=true)。資金が未入力ならvalue=null。
function limitInfoOf(t, received) {
  const capital = riskCapital();
  const assumed = !(t.planQty > 0);
  const qty = assumed ? 1 : Math.floor(t.planQty);
  const allowed = capital > 0 ? capital * RISK_PCT : null;
  const value = allowed !== null && received !== null && received > 0 ? received + allowed / (SHARES_PER_CONTRACT_ORDER * qty) : null;
  return { value, qty, assumed, capital, allowed };
}

// 表の上に出す、資金2%の説明
function limitLineText(info, money, maxValue = null) {
  const usd = (v) => `${Math.abs(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル`;
  if (info.value === null) {
    return "【資金2%の目安】「注文プラン」でトータル資金額を入力すると、損失が資金の2%を超える場面に、赤枠の「資金2%超」の印が付きます。";
  }
  return `【資金2%の目安】資金${usd(info.capital)}の2%＝${usd(info.allowed)}。${info.qty}枚${info.assumed ? "（発注枚数が未入力のため、仮に1枚）" : ""}の場合、現在値（買い戻し価格）が ${money(info.value)} 以上になると、損失が資金の2%を超えます（赤枠の「資金2%超」）。${maxValue !== null && info.value >= maxValue ? "この枚数では、スプレッドの最大損失でも、損失は資金の2%以内に収まるため、印は付きません。" : ""}`;
}

// 損切りの場面の選択。"time|残り営業日|IVの変化"＝「IVの変化と時間の経過」の表のセル、"キー|IV列の番号"＝ストレステストの表のセル。選んでいないときはkey=null
function parseStopPick(t) {
  const tm = /^time\|(\d+)\|(-?[\d.]+)$/.exec(t.stopPick || "");
  if (tm) return { type: "time", remain: Number(tm[1]), ivUp: Number(tm[2]) };
  const m = /^(.+)\|(\d+)$/.exec(t.stopPick || "");
  return m ? { type: "stress", key: m[1], ivIdx: Number(m[2]) } : { type: "stress", key: null, ivIdx: 0 };
}

// IVの変化の言い方
const ivUpWord = (up) => (Math.abs(up) < 1e-9 ? "IVは変わらない" : `IVが${up > 0 ? "＋" : "−"}${Math.abs(Math.round(up * 100))}ポイント`);

// 選んだ損切りの場面の説明(株価・IV・時間)
function sceneDesc(p, money) {
  if (p.scene === "time") return `株価は変わらず（${money(p.price)}）・${p.remainName}（残り${p.remain}営業日）・${ivUpWord(p.ivUp)}`;
  return `株価${money(p.price)}（現在値から${p.shock >= 0 ? "+" : "−"}${Math.abs(p.shock * 100).toFixed(1)}%）・${ivUpWord(p.ivUp)}`;
}

// リスクリワードの数字をまとめる(資金の2%・発注枚数・選んだ損切りの場面・利確から)
function riskCtxOf(t) {
  const st = lastStress;
  const capital = riskCapital();
  const allowed = capital > 0 ? capital * RISK_PCT : null;
  const picked = st ? st.picked : null;
  const received = st ? st.received : null;
  const profitPerShare = received !== null ? received * (profitPercentOf(t) / 100) : null;
  const sceneLossPerShare = picked && received !== null ? picked.value - received : null;
  const sceneLossPerContract = sceneLossPerShare !== null ? sceneLossPerShare * SHARES_PER_CONTRACT_ORDER : null;
  // 選んだ場面で、損失が2%以内に収まる最大の枚数
  const maxQty = allowed !== null && sceneLossPerContract !== null && sceneLossPerContract > 0 ? Math.floor(allowed / sceneLossPerContract) : null;
  const qtyInput = t.planQty > 0 ? Math.floor(t.planQty) : null;
  const qty = qtyInput !== null ? qtyInput : (maxQty !== null ? maxQty : null);
  // 損失が2%になる買い戻し価格(損切りの目安の上限)
  const limitLossPerShare = allowed !== null && qty !== null && qty >= 1 ? allowed / (SHARES_PER_CONTRACT_ORDER * qty) : null;
  const limitValue = limitLossPerShare !== null && received !== null ? received + limitLossPerShare : null;
  // 場面を選んだときはその場面の損失、選んでいないときは2%の上限を損失とみなす
  const lossPerShare = sceneLossPerShare !== null ? sceneLossPerShare : limitLossPerShare;
  const lossPerContract = lossPerShare !== null ? lossPerShare * SHARES_PER_CONTRACT_ORDER : null;
  const totalLoss = qty !== null && lossPerContract !== null ? lossPerContract * qty : null;
  return {
    capital, allowed, picked, received, profitPerShare, sceneLossPerShare, lossPerShare, lossPerContract, maxQty, qtyInput, qty,
    limitLossPerShare, limitValue, totalLoss,
    rr: profitPerShare !== null && lossPerShare !== null && lossPerShare > 0 ? profitPerShare / lossPerShare : null,
    lossPctOfCapital: totalLoss !== null && capital > 0 ? totalLoss / capital : null,
  };
}

// 「損切りの目安（資金の2%まで）とリスクリワード」を描画する(売り系のみ。ストレステストの直後に呼ぶ)
function renderRiskPlan(t) {
  const ctx = riskCtxOf(t);
  lastRisk = ctx;
  const money = (v) => v.toFixed(2);
  const usd = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル`;
  // 入力中の欄は上書きしない(別の欄の入力で再描画されたときに、入力した値が消えないように)
  if (document.activeElement !== els.riskCapitalInput) els.riskCapitalInput.value = ctx.capital > 0 ? ctx.capital : "";
  if (document.activeElement !== els.planQtyInput) els.planQtyInput.value = t.planQty > 0 ? t.planQty : "";
  const T = "stopExplain";
  const items = [];
  const ok = ctx.totalLoss !== null && ctx.allowed !== null ? ctx.totalLoss <= ctx.allowed + 1e-9 : null;

  items.push({
    name: "1回の損切りの上限", value: ctx.allowed !== null ? usd(ctx.allowed) : "―",
    suffix: ctx.allowed !== null ? `（資金${usd(ctx.capital)}の${RISK_PCT * 100}%）` : "",
    sub: ctx.allowed !== null ? "損切りの損失は、この額まで" : "トータル資金額を入力すると表示",
    note: `投資に回せるトータル資金額の${RISK_PCT * 100}%を、1回の損切りで許せる損失額の上限としています。損切りの目安は、この額を基準にします。`,
    attrs: `data-target="${T}"`,
  });
  if (ctx.limitValue !== null) {
    items.push({
      name: "損切りの買い戻し価格（2%の上限）", value: money(ctx.limitValue),
      suffix: `（受取${money(ctx.received)}＋損失${money(ctx.limitLossPerShare)}）`,
      sub: `${ctx.qty}枚で、損失が${usd(ctx.allowed)}（資金の${RISK_PCT * 100}%）になる買い戻し価格${ctx.qtyInput === null ? "（選んだ場面から決めた枚数）" : ""}`,
      note: "ポジションの買い戻しに必要な価格（現在値）が、この価格に届いたら損切りする、という目安です。受取プレミアム＋（資金の2%÷（100株×枚数））で計算しています。逆指値の注文は、発動後に不利な価格で約定することがあります。\n2つの表（ストレステストと、IVの変化と時間の経過）では、この価格以上になるセルに「2%超」の印を付けています。",
      attrs: `data-target="${T}"`,
    });
  } else {
    items.push({
      name: "損切りの買い戻し価格（2%の上限）", value: "―",
      sub: ctx.allowed === null ? "トータル資金額を入力すると表示" : "発注する枚数を入力すると表示",
      note: "発注する枚数を入力すると、損失が資金の2%になる買い戻し価格（損切りの目安の上限）が決まります。",
      attrs: `data-target="${T}"`,
    });
  }
  if (ctx.picked) {
    const p = ctx.picked;
    items.push({
      name: "選んだ損切りの場面", value: p.label, suffix: "",
      sub: sceneDesc(p, money),
      note: "ストレステストの表（株価が動いた場合）、または「IVの変化と時間の経過の影響」の表（株価が変わらない場合）で、クリックして選んだセルです。この場面の「現在値」（買い戻しに必要な価格）が、この場面で損切りしたときの買い戻し価格になります。もう一度同じセルをクリックするか、下の「場面の選択を外す」を押すと、選択が外れます。",
      attrs: `data-target="${T}"`,
    });
    items.push({
      name: "この場面の買い戻し価格", value: money(p.value), suffix: "（目安）",
      sub: "選んだ場面の現在値",
      note: "選んだ場面で、ポジションを買い戻すのに必要な価格（Black-Scholes・金利0・配当なしの目安）です。実際の価格とは、ずれます。",
      attrs: `data-target="${T}"`,
    });
    if (ctx.sceneLossPerShare !== null) {
      items.push({
        name: "この場面の損失額", value: money(ctx.sceneLossPerShare), suffix: `（100株で${usd(ctx.sceneLossPerShare * SHARES_PER_CONTRACT_ORDER)}）`,
        sub: `買い戻し${money(p.value)} − 受取${money(ctx.received)}`,
        note: "この場面で損切りしたときの損失額（1株あたり）です。買い戻し価格−受取プレミアム額。手数料は含みません。",
        attrs: `data-target="${T}"`,
      });
    }
    items.push({
      name: "この場面での枚数の上限", value: ctx.maxQty !== null ? `${ctx.maxQty}枚` : "―",
      sub: ctx.maxQty === null ? "トータル資金額を入力すると表示"
        : (ctx.maxQty === 0 ? "1枚でも、2%を超えます" : `${usd(ctx.sceneLossPerShare * SHARES_PER_CONTRACT_ORDER)}×${ctx.maxQty}枚＝${usd(ctx.sceneLossPerShare * SHARES_PER_CONTRACT_ORDER * ctx.maxQty)}`),
      note: "1回の損切りの上限（資金の2%）を、この場面の損失額（1契約あたり）で割って、小数点以下を切り捨てた枚数です。この枚数以内なら、この場面で損切りしても、損失が資金の2%以内に収まります。",
      attrs: `data-target="${T}"`,
    });
  }
  items.push({
    name: "損切りしたときの損失", value: ctx.lossPerShare !== null ? money(ctx.lossPerShare) : "―",
    suffix: ctx.lossPerShare !== null ? `（100株で${usd(ctx.lossPerContract)}${ctx.qty !== null && ctx.qty !== 1 ? `、${ctx.qty}枚で${usd(ctx.totalLoss)}` : ""}）` : "",
    sub: ctx.lossPerShare === null ? "枚数を入力するか、損切りの場面を選ぶと表示"
      : (ctx.picked ? "選んだ場面の損失" : "資金の2%の上限どおりに損切りしたとき"),
    note: "損切りしたときの損失額（1株あたり）です。場面を選んでいないときは、資金の2%の上限どおりに損切りした場合の損失（＝2%の上限÷（100株×枚数））です。手数料は含みません。",
    attrs: `data-target="${T}"`,
  });
  if (ok !== null) {
    items.push({
      name: "資金に対する損失", value: `${(ctx.lossPctOfCapital * 100).toFixed(2)}%`,
      suffix: `（上限${RISK_PCT * 100}%）`,
      sub: ok ? "上限以内" : "※上限を超えています",
      note: "損切りしたときの損失（枚数分）が、トータル資金額の何%にあたるかです。2%以内に収まっているか、確認します。",
      attrs: `data-target="${T}"`,
    });
  }
  items.push({
    name: "リスクリワード", value: ctx.rr !== null ? `1：${ctx.rr.toFixed(2)}` : "―",
    suffix: ctx.rr !== null ? "（損失：利益）" : "",
    sub: ctx.rr !== null ? `損失${money(ctx.lossPerShare)}に対して、利確の利益${money(ctx.profitPerShare)}（受取の${profitPercentOf(t)}%）` : "枚数を入力するか、損切りの場面を選ぶと表示",
    note: "損切りしたときの損失を1としたときの、利確したときの利益の大きさです（1株あたり）。1：0.5なら、損失1に対して、利益は0.5です。\nスプレッド・単体の売りは、利益が受取プレミアムに限られるため、リスクリワードが1を下回ることが多くなります。そのぶん、勝率（ITMになりにくいこと）で補う考え方です。",
    attrs: `data-target="${T}"`,
  });
  els.riskSummary.innerHTML = items.map((it) => statCardHtml(it)).join("");
  els.riskClearPick.hidden = !ctx.picked;
  els.riskNote.textContent = "損切りの目安は、判断の材料のひとつです。実際に損切りするかどうかは、ご自身で決めてください。" + (ctx.qtyInput !== null ? ` 発注枚数は、入力した${ctx.qtyInput}枚で計算しています。` : "");
}

// 「注文まとめ」: 分析結果をもとに、最終的にどのようなP売り注文をして、利確・損切りの指値をどうするかを、1か所にまとめる
function renderPlanCard(t) {
  if (typeGroup(t.typeKey) !== "sell" || !t.closesFull) { els.planCard.hidden = true; return; }
  const ctx = lastRisk || riskCtxOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const isPut = type.itmWhen === "below";
  const kind = isPut ? "P" : "C";
  const isSp = t.rrVariant === "spread";
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const latest = closes[closes.length - 1];
  const asOf = dates[dates.length - 1];
  const days = t.windowDays;
  const expiry = shiftTradingDays(asOf, -days);
  const strikeSell = effStrikeOf(t, latest);
  const strikeBuy = isSp && t.rrSpreadWidth > 0 ? (isPut ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
  const money = (v) => v.toFixed(2);
  const usd = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル`;
  const NA = (msg) => `<span class="plan-na">―（${msg}）</span>`;
  const premium = t.rrPremium !== null && t.rrPremium > 0 ? t.rrPremium : null;
  const ratioP = profitPercentOf(t);
  const qty = ctx.qty;
  // 1枚のときは「1枚で」と「1枚で」が重なるので、2枚以上のときだけ、枚数分の合計を足す
  const multi = (v) => (qty !== null && qty !== 1 ? `、${qty}枚で${usd(v * qty)}` : "");
  const qtyText = qty !== null ? `${qty}枚${ctx.qtyInput === null ? "（選んだ損切りの場面で、損失が資金の2%以内に収まる最大枚数）" : ""}` : null;
  const lines = []; // [見出し, HTML, テキスト]
  const add = (h, html, text) => lines.push([h, html, text]);

  // 銘柄・取引
  const orderStrike = isSp
    ? `${fmtStrike(strikeSell)}${kind}売 / ${strikeBuy !== null ? fmtStrike(strikeBuy) : "―"}${kind}買`
    : `${fmtStrike(strikeSell)}${kind}売`;
  add("銘柄・取引", `${t.symbol}　${isSp ? (isPut ? "ブルプット" : "ベアコール") : (isPut ? "プット売り" : "コール売り")}（${asOf}の終値 ${money(latest)}）`,
    `${t.symbol} ${isSp ? (isPut ? "ブルプット" : "ベアコール") : (isPut ? "プット売り" : "コール売り")}（${asOf}終値${money(latest)}）`);
  // 発注
  const cal = calendarDaysBetween(asOf, expiry);
  add("発注する権利行使価格・満期", `<b>${orderStrike}</b>　満期 ${expiry}（${WEEKDAY_JA[weekday(expiry)]}・残り${days}営業日／${cal}暦日）`,
    `${orderStrike} 満期${expiry}（残り${days}営業日）`);
  add("受取プレミアム（売りの指値）", premium !== null ? `<b>${money(premium)}</b>（1株あたり）＝ 1枚で${usd(premium * SHARES_PER_CONTRACT_ORDER)}${multi(premium * SHARES_PER_CONTRACT_ORDER)}` : NA("「注文内容」で、受取プレミアム額を入力"),
    premium !== null ? `受取${money(premium)}/株（1枚${usd(premium * 100)}）` : "受取プレミアム 未入力");
  add("枚数", qtyText !== null ? `<b>${qtyText}</b>` : NA("発注枚数を入力"), qtyText !== null ? `枚数${qtyText}` : "枚数 未決定");
  // 利確
  if (premium !== null) {
    const buy = premium * (1 - ratioP / 100);
    add("利確（買い戻しの指値）", `<b>${money(buy)}</b>（受取の${ratioP}%を利益にする）　利益 ${money(premium * ratioP / 100)}/株 ＝ 1枚で${usd(premium * ratioP)}${multi(premium * ratioP)}`,
      `利確 買い戻し指値${money(buy)}（受取の${ratioP}%利確）、利益${money(premium * ratioP / 100)}/株`);
  } else {
    add("利確（買い戻しの指値）", NA("受取プレミアム額を入力"), "利確 未計算");
  }
  // 損切り
  const p = ctx.picked;
  if (ctx.limitValue !== null) {
    add("損切り（資金の2%まで）", `買い戻し価格が <b>${money(ctx.limitValue)}</b> に達したら、買い戻して損切り（${qty}枚で、損失が${usd(ctx.allowed)}＝資金の${RISK_PCT * 100}%）`,
      `損切り 買い戻し価格${money(ctx.limitValue)}に達したら（${qty}枚で損失${usd(ctx.allowed)}＝資金の${RISK_PCT * 100}%）`);
  } else {
    add("損切り（資金の2%まで）", NA("トータル資金額と発注枚数を入力"), "損切り 未計算");
  }
  if (p) {
    if (p.scene === "time") {
      add("損切りの場面（選択）", `株価が変わらないまま、<b>${ivUpWord(p.ivUp)}</b>・${p.remainName}（残り${p.remain}営業日）の状態。買い戻し価格は <b>${money(p.value)}</b>`,
        `場面 株価変わらず・${ivUpWord(p.ivUp)}・残り${p.remain}営業日、買い戻し${money(p.value)}`);
    } else {
      add("損切りの場面（選択）", `株価が <b>${money(p.price)}</b>（現在値から${p.shock >= 0 ? "+" : "−"}${Math.abs(p.shock * 100).toFixed(1)}%）まで${isPut ? "下がった" : "上がった"}状態${p.ivUp > 0 ? `・IVが＋${Math.round(p.ivUp * 100)}ポイント` : ""}。買い戻し価格は <b>${money(p.value)}</b>`,
        `場面 株価${money(p.price)}（${p.shock >= 0 ? "+" : "−"}${Math.abs(p.shock * 100).toFixed(1)}%）${p.ivUp > 0 ? `・IV＋${Math.round(p.ivUp * 100)}pt` : ""}、買い戻し${money(p.value)}`);
    }
  }
  if (ctx.lossPerShare !== null) {
    add("損切りしたときの損失", `${money(ctx.lossPerShare)}/株 ＝ 1枚で${usd(ctx.lossPerContract)}${qty !== null && qty !== 1 ? `、<b>${qty}枚で${usd(ctx.totalLoss)}</b>` : ""}${p ? "（選んだ場面の損失）" : ""}`,
      `損切り損失${money(ctx.lossPerShare)}/株（1枚${usd(ctx.lossPerContract)}${qty !== null ? `、${qty}枚${usd(ctx.totalLoss)}` : ""}）`);
  }
  // 資金に対する損失・リスクリワード
  if (ctx.capital > 0 && ctx.lossPctOfCapital !== null) {
    const ok = ctx.totalLoss <= ctx.allowed + 1e-9;
    add("資金に対する損失", `資金${usd(ctx.capital)}に対して <b>${(ctx.lossPctOfCapital * 100).toFixed(2)}%</b>（上限${RISK_PCT * 100}%＝${usd(ctx.allowed)}）→ ${ok ? "<b>上限以内</b>" : "<b class=\"plan-ng\">上限を超えています</b>"}`,
      `資金に対する損失${(ctx.lossPctOfCapital * 100).toFixed(2)}%（上限${RISK_PCT * 100}%）${ok ? "上限以内" : "上限超過"}`);
  } else {
    add("資金に対する損失", NA("トータル資金額を入力"), "資金に対する損失 未計算");
  }
  add("リスクリワード", ctx.rr !== null ? `損失：利益 ＝ <b>1：${ctx.rr.toFixed(2)}</b>` : NA("発注枚数・トータル資金額・受取プレミアム額が必要"), ctx.rr !== null ? `リスクリワード 1:${ctx.rr.toFixed(2)}` : "リスクリワード 未計算");
  // 判断日
  const reviewDate = days > 10 ? shiftTradingDays(expiry, 10) : null;
  const closeDate = shiftTradingDays(expiry, 3);
  add("日程の目安", `${reviewDate ? `2週間前の判断日 ${reviewDate}（${WEEKDAY_JA[weekday(reviewDate)]}）／` : ""}遅くとも ${closeDate}（${WEEKDAY_JA[weekday(closeDate)]}）までに決済`,
    `${reviewDate ? `判断日${reviewDate}／` : ""}決済期限${closeDate}`);
  // 根拠
  const { depthPct } = depthInfo(t, closes);
  const an = computeItmAnalysis(closes, { ratio: effRatioOf(t, latest), itmWhen: type.itmWhen, window: days, group: "sell", depthPct }, dates);
  const hv = computeHv(viewDataOf(t).closes, days);
  const th = hv === null ? null : hvTheory({ price: latest, strike: strikeSell, depthDollar: depthDollarOf(t), itmWhen: type.itmWhen, days, hv });
  const basis = [
    `ITM発生率（過去の実績） ${an.overallItmProb === null ? "―" : (an.overallItmProb * 100).toFixed(1) + "%"}（判定：${an.badge}）`,
    th ? `満期時ITM率（HV換算） ${(th.probItmAtExpiry * 100).toFixed(1)}%` : null,
  ].filter(Boolean);
  add("判断の根拠", basis.join("　／　"), `根拠: ${basis.join(" / ")}`);

  els.planBody.innerHTML = lines.map(([h, html]) => `<tr><th>${h}</th><td>${html}</td></tr>`).join("");
  lastPlanText = `【${t.symbol} 注文まとめ】\n` + lines.map(([h, , text]) => `${h}：${text}`).join("\n") + "\n※目安です。実際の価格・約定とはずれます。";
  els.planCard.hidden = false;
}
let lastPlanText = "";

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
  lastStress = null;
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

  const strikeSell = sellStrikeOf(t, price);
  const strikeBuy = isSp ? (kind === "put" ? strikeSell - t.rrSpreadWidth : strikeSell + t.rrSpreadWidth) : null;
  if (strikeBuy !== null && !(strikeBuy > 0)) { clear("権利行使価格の差額が大きすぎます（買い建て側の権利行使価格が0以下になります）。"); return; }
  const entries = STRESS_SHOCK_STEPS.map((s) => ({ shock: s * sign, key: String(s * sign) }));
  const res = stressTest({
    kind, price, strikeSell, strikeBuy, days: t.windowDays, premium, ivSell, ivBuy,
    shocks: entries.map((e) => e.shock), ivUps: STRESS_IV_UPS,
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
  // 損切りの場面: クリックしたセル(選んでいなければ、なし)。発注枚数を入れていれば、損失が資金の2%を超えるセルに印を付ける
  const limitInfo = limitInfoOf(t, received);
  const limitValue = limitInfo.value;
  els.stressIntro.textContent += ` ${limitLineText(limitInfo, money, maxValue)}`;
  const pick = parseStopPick(t);
  const pickEntryIdx = pick.type === "time" || pick.key === null ? -1 : entries.findIndex((e) => e.key === pick.key && e.shock !== 0);
  const ivIdx = pick.ivIdx < STRESS_IV_UPS.length ? pick.ivIdx : 0;
  els.stressBody.innerHTML = rows.map((r, ri) => {
    const e = entries[ri];
    const label = r.shock === 0 ? "いま" : `${r.shock > 0 ? "+" : "−"}${Math.abs(r.shock * 100).toFixed(0)}%`;
    return `<tr><td>${label}</td><td>${money(r.price)}</td>${r.cells.map((c, ci) => {
      const stop = c.value >= stopMin;
      const nearMax = maxValue !== null && c.value >= maxValue;
      const over = limitValue !== null && c.value >= limitValue;
      const selectable = e.shock !== 0;
      const picked = selectable && ri === pickEntryIdx && ci === ivIdx;
      const cls = [nearMax ? "stress-max" : stop ? "stress-stop" : "", over ? "stress-over" : "", selectable ? "stress-pickable" : "", picked ? "stress-picked" : ""].filter(Boolean).join(" ");
      return `<td class="${cls}"${selectable ? ` data-stop-pick="${e.key}|${ci}" title="クリックで、この場面を損切りの場面にします（もう一度クリックすると外れます）"` : ""}><b>${money(c.value)}</b><br><span class="stress-pnl ${c.pnl < 0 ? "neg" : ""}">${pnlText(c.pnl)}</span>${over ? '<br><span class="stress-overtag">資金2%超</span>' : ""}${picked ? '<br><span class="stress-picktag">損切りの場面に選択中</span>' : ""}</td>`;
    }).join("")}</tr>`;
  }).join("");
  if (pickEntryIdx >= 0) {
    const e = entries[pickEntryIdx];
    const r = rows[pickEntryIdx];
    const c = r.cells[ivIdx];
    lastStress = {
      received: meta.received, meta, limitValue,
      picked: {
        key: e.key, shock: r.shock, price: r.price, ivUp: STRESS_IV_UPS[ivIdx], value: c.value, pnl: c.pnl,
        label: `株価${r.shock > 0 ? "+" : "−"}${Math.abs(r.shock * 100).toFixed(0)}%`,
      },
    };
  } else {
    lastStress = { received: meta.received, meta, limitValue, picked: null };
  }

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
    "表のセルをクリックすると、その場面を「損切りの場面」として選べます（太い枠のセル。もう一度クリックすると外れます）。株価が変わらずに時間が経った場合の損失は、「株価が変わらず時間が経った場合」のタブ（IVの変化と時間の経過の影響）で見られます。選んだ場面は、リスクリワードと、注文まとめに反映されます。",
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
  persistState();
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
      name: "現在の権利行使価格", value: fmtStrike(todayStrike), sub: typeGroup(t.typeKey) === "sell" && t.rrSellStrike > 0 ? "入力した売りの権利行使価格" : "比率から決めた整数の値",
      note: "本日の終値×権利行使価格の比率です。\nスプレッドの場合は、売り系は売り建てる側、買い系は買い建てる側の権利行使価格にあたります(もう一方の権利行使価格との差額は損益分岐点に影響しません)。",
    },
    {
      name: "損益分岐点（満期時の株価）", value: breakEven === null ? "―" : breakEven.toFixed(2),
      sub: breakEven === null ? `${premiumName}を入力すると表示` : formula,
      note: `満期時にこの株価であれば、損益がちょうどゼロになる価格です(${formula})。\n`
        + (group === "sell"
          ? (isPut ? "プット売りは、満期時の株価がこの価格を下回ると損失になります。" : "コール売りは、満期時の株価がこの価格を上回ると損失になります。")
          : (isPut ? "プット買いは、満期時の株価がこの価格を下回ると利益になります。" : "コール買いは、満期時の株価がこの価格を上回ると利益になります。"))
        + "\nスプレッドの場合は、プレミアムに差し引き後の正味の額(受取−支払い)を入力してください。\nプレミアムは1株あたりの額で、手数料は含みません。",
    },
    {
      name: "損益分岐点と現在の株価の差", value: diffPct === null ? "―" : (diffPct >= 0 ? "+" : "") + (diffPct * 100).toFixed(2) + "%",
      sub: breakEven === null ? `現在の株価${latest.toFixed(2)}` : `損益分岐点${breakEven.toFixed(2)} ÷ 現在の株価${latest.toFixed(2)} − 1（権利行使価格との差ではありません）`,
      note: "損益分岐点が、現在の株価(最新の終値)から見て何%離れているかです。\n例えばプット売りで-8%なら、株価が現在より8%下がるまでは(満期時に)損失にならない、という余裕の目安になります。",
    },
  ];
  els.rrBreakEvenSummary.innerHTML = items.map((it) => statCardHtml({ ...it, attrs: `data-target="${T}"` })).join("");
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

// ---- 画面の構成: 上に固定する帯・セクション・最低条件の表示・リスクのタブ ----
// 帯に出す値。各描画関数が、計算のついでに置いていく(renderAllの最初にリセットする)
const band = { hvItm: null, ivhv: null, cond: null, hvSigma: null, hvPos: null, buyLine: null };

// セクション(3〜8)の表示を、中のカードの表示状態に合わせる。ナビの項目も同じ。
// 売り系だけのセクション(data-only="sell")は、買い系のときは出さない。
function syncSections() {
  const shown = (...cards) => cards.some((c) => !c.hidden);
  const set = (id, show) => {
    const sec = document.getElementById(id);
    const sellOnlyHidden = sec && sec.dataset.only === "sell" && document.body.dataset.group === "buy";
    const on = show && !sellOnlyHidden;
    if (sec) sec.hidden = !on;
    const a = els.bandNav.querySelector(`a[href="#${id}"]`);
    if (a) a.hidden = !on;
  };
  els.condResultCard.hidden = els.conditionCard.hidden;
  els.volDetails.hidden = els.volatilityCard.hidden;
  if (PAGE === "buy") {
    set("s5", shown(els.orderCard));
    set("sb7", shown(els.buyRiskCard));
    set("sb8", shown(els.buyPlanCard));
  }
  set("s3", shown(els.todayCard, els.result));
  set("s4", shown(els.hvCard));
  set("s5", shown(els.orderCard));
  set("s6", shown(els.result));
  set("s7", shown(els.orderCard));
  set("s8", shown(els.planCard));
}

// 上に固定する帯(銘柄・終値・取引・満期／最低条件・総合判定・ITM発生率・満期時ITM率・IV÷HV)。t=nullなら、未選択の表示
function renderTopBand(t) {
  const kv = (name, valueHtml) => `<span class="kv">${name} <b>${valueHtml}</b></span>`;
  if (!t || !t.closesFull || !t.symbol) {
    els.bandRow1.innerHTML = '<span class="sym" style="color:var(--muted)">―</span><span class="kv"><b>ティッカーを入力して「分析する」を押してください</b></span>';
    els.bandRow2.innerHTML = ["最低条件", "総合判定", "ITM発生率", "IV÷HV"].map((n) => kv(n, "―")).join("");
    return;
  }
  const closes = periodClosesOf(t);
  const dates = periodDatesOf(t);
  const latest = closes[closes.length - 1];
  const asOf = dates[dates.length - 1];
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const isSp = t.rrVariant === "spread";
  const labels = RISK_VARIANT_LABELS[t.typeKey] || RISK_VARIANT_LABELS.put_sell;
  const isPut = type.itmWhen === "below";
  const kind = isPut ? "P" : "C";
  const strike = effStrikeOf(t, latest);
  let strikes;
  if (group === "sell") {
    const buyK = isSp && t.rrSpreadWidth > 0 ? (isPut ? strike - t.rrSpreadWidth : strike + t.rrSpreadWidth) : null;
    strikes = isSp ? `${fmtStrike(strike)}${kind}売 / ${buyK !== null ? fmtStrike(buyK) : "―"}${kind}買` : `${fmtStrike(strike)}${kind}売`;
  } else {
    strikes = `${fmtStrike(strike)}${kind}買`;
  }
  const expiry = shiftTradingDays(asOf, -t.windowDays);
  els.bandRow1.innerHTML = `<span class="sym">${t.symbol}</span>`
    + `<span class="px">${latest.toFixed(2)}<span class="kv">　${asOf.slice(5)}の終値</span></span>`
    + `<span class="kv"><b>${isSp ? labels.spread : labels.naked}</b> ${strikes}</span>`
    + `<span class="kv">満期 <b>${expiry.slice(5)}</b>（${t.windowDays}営業日）</span>`;
  const pct = (v, d = 0) => (v * 100).toFixed(d) + "%";
  const c = band.cond;
  const parts = [
    c ? kv("最低条件", `<span class="${c.hitDays >= 1 ? "band-ok" : "band-ng"}">${c.hitDays >= 1 ? "満たす" : "満たしていません"}</span>`) : kv("最低条件", "―"),
    `<span class="${els.badge.className}">${els.badge.textContent}</span>`,
    kv("ITM発生率（実績）", els.overallProb.textContent),
  ];
  if (band.hvItm !== null) parts.push(kv("満期時ITM率（HV換算）", pct(band.hvItm)));
  if (band.ivhv) parts.push(kv("IV÷HV", `${band.ivhv.ratio.toFixed(2)}倍（${band.ivhv.word}）`));
  els.bandRow2.innerHTML = parts.join("");
}

// 「6 まとめ」の表。1〜5で見たことを、思考の順(前提の値動き → 過去の実績 → HV → IV)に1行ずつ並べる。
// 数字は、各カードが計算したものをそのまま使う(ここでは再計算しない)。確率の比較(IV換算・HV換算・実績)は、同じ節の「3点比較」に任せる。
function renderConclusion(t) {
  const body = els.conclBody;
  if (!t || !t.closesFull || !t.symbol || els.result.hidden) { body.innerHTML = ""; return; }
  const group = typeGroup(t.typeKey);
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const tag = (cls, name) => `<span class="basis-tag ${cls}"><i></i>${name}</span>`;
  const row = (n, cls, name, result, reading) =>
    `<tr><td class="cc-n">${n}</td><td>${tag(cls, name)}</td><td class="cc-res">${result}</td><td>${reading}</td></tr>`;
  const rows = [];

  const c = band.cond;
  if (c) {
    const word = c.down ? "下落" : "上昇";
    const ok = c.hitDays >= 1;
    rows.push(row(rows.length + 1, "basis-none", "直近の値動き",
      `${ok ? "最低条件：満たしています" : "最低条件：満たしていません"}`,
      `1〜7営業日前との比較のうち、設定した変化率以上の${word}が${c.hitDays}/7日（最低条件は1日以上、推奨は${c.rec}日以上）。`));
  }

  const dep = depthSuffixOf(t);
  const goodWord = group === "sell" ? "低いほど有利" : "高いほど有利";
  rows.push(row(rows.length + 1, "basis-act", "過去の実績",
    `ITM${dep}発生率 ${els.overallProb.textContent}（総合判定：${els.badge.textContent}）`,
    `過去のエントリー${els.entryCount.textContent}件のうち、${els.itmCount.textContent}件で、判定期間内に一度はITM${dep}に届きました（${goodWord}）。`));

  const hs = band.hvSigma;
  const hp = band.hvPos;
  if (hs) {
    const pctl = hp ? hp.percentile : null;
    const regimeNote = pctl === null ? "" : pctl >= 0.8 ? "過去1年の中では荒れている時期なので、実績を調べた期間より、動きが大きくなりやすい点に注意します。"
      : pctl <= 0.2 ? "過去1年の中では穏やかな時期です。" : "過去1年の中では、ふだんに近い水準です。";
    rows.push(row(rows.length + 1, "basis-hv", "HV",
      `権利行使価格は、満期までの値動き（1σ ±${pct(hs.sigmaPct)}）の ${Math.abs(hs.z).toFixed(2)}σ ${hs.z >= 0 ? "外側" : "内側"}`,
      `直近${hs.days}営業日のHVは${pct(hp ? hp.hv : 0)}。${regimeNote}`));
  }

  const iv = band.ivhv;
  if (iv) {
    rows.push(row(rows.length + 1, "basis-iv", "IV",
      `IV ${pct(iv.iv)}（HVの${iv.ratio.toFixed(2)}倍・${iv.word}）`,
      `${iv.phrase}。${iv.meaning}。`));
  }
  const bl = band.buyLine;
  if (PAGE === "buy" && bl) {
    rows.push(row(rows.length + 1, "basis-none", "固定の線",
      `手仕舞いの線 ${bl.line.toFixed(2)}（${bl.movePct >= 0 ? "+" : ""}${pct(bl.movePct)}）`,
      `買った日の終値から、ATR(${ATR_PERIOD})の${bl.mult}倍${bl.kind === "call" ? "下がった" : "上がった"}価格です。この線に届いたら手仕舞う目安で、期待値を上げる線ではなく、損失の大きさを決める線です。`));
  }
  body.innerHTML = rows.join("");
}

// ================= 買いページ専用 =================

// ---- 金利(買いページ) ----
// 金利は、年%の入力欄(空欄＝0)。IVとプレミアムの「両方」が入力されているときは、金利を使わない(入力もできない)。
//   理由: 証券会社のIVは、金利を含めて計算された値。IVも価格も入力されていれば、IVと価格の換算が要らないため。
// IVとプレミアムの「片方だけ」のとき(IVから価格を計算する／価格からIVを逆算する)は、金利があると、より正確になる。
//   満期が長い(90営業日超)ときは、「米国債利回りを入れる」ボタンで、米国財務省の米国債利回りを、満期の長さに合わせて入れる(押したときだけ)。
let ratesData = null; // /api/rates の結果 {date, points:[{months, rate}]}
async function loadRates() {
  if (ratesData) return true;
  try {
    const r = await fetch("/api/rates");
    const d = await r.json();
    if (d && Array.isArray(d.points) && d.points.length) { ratesData = d; return true; }
  } catch (e) { /* 取得できなかった */ }
  return false;
}
function rateForCalendarDays(calDays) {
  if (!ratesData) return null;
  const m = calDays / 30.4375;
  const pts = ratesData.points;
  if (m <= pts[0].months) return pts[0].rate;
  for (let i = 1; i < pts.length; i++) {
    if (m <= pts[i].months) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.rate + (b.rate - a.rate) * ((m - a.months) / (b.months - a.months));
    }
  }
  return pts[pts.length - 1].rate;
}
const hasPrem = (t) => t.rrPayPremium !== null && t.rrPayPremium > 0;
const hasIvIn = (t) => t.rrIvSell !== null && t.rrIvSell > 0;
const bothPremIv = (t) => hasPrem(t) && hasIvIn(t);
let rateNote = { text: "", days: null }; // ボタンを押した結果の案内(取得できた日付・失敗)。満期の長さを変えたら、出さない
function updateRateUI(t) {
  if (!els.buyRateInput) return;
  const both = bothPremIv(t);
  els.buyRateInput.disabled = both;
  if (document.activeElement !== els.buyRateInput) els.buyRateInput.value = both ? "" : (t.buyRate !== null && t.buyRate !== undefined ? t.buyRate : "");
  const longMat = t.windowDays > 90;
  const single = hasPrem(t) !== hasIvIn(t); // どちらか一方だけ
  els.buyRateBtn.hidden = !(single && longMat && !both);
  let hint;
  if (both) {
    hint = "IVとプレミアムの両方が入力されているため、金利は使いません（証券会社のIVは、金利を含む値です）。";
  } else if (single && longMat) {
    hint = "IVとプレミアムの片方だけで、満期が長いため、金利を入れると、より正確になります。より正確な分析が必要な場合は、金利を入力してください（「米国債利回りを入れる」で、満期に合わせた米国債の利回りが入ります）。";
  } else {
    hint = "より正確な分析が必要な場合は、金利（米国債の利回りが目安）を入力してください。空欄は、金利0として計算します。";
  }
  els.buyRateHint.textContent = (rateNote.text && rateNote.days === t.windowDays && !both ? rateNote.text + " " : "") + hint;
}
// 「米国債利回りを入れる」: 満期の長さに合わせて補間した利回りを、金利欄に入れる
async function fillRateFromTreasury() {
  const t = activeTab();
  if (!t || !t.closesFull) return;
  els.buyRateBtn.disabled = true;
  const ok = await loadRates();
  els.buyRateBtn.disabled = false;
  if (!ok) { rateNote = { text: "米国債利回りを取得できませんでした。手で入力してください。", days: t.windowDays }; updateRateUI(t); return; }
  const lastDate = t.datesFull[t.datesFull.length - 1];
  const cal = calendarDaysBetween(lastDate, shiftTradingDays(lastDate, -t.windowDays));
  const r = rateForCalendarDays(cal);
  t.buyRate = Math.round(r * 100) / 100;
  rateNote = { text: `米国債利回り（${ratesData.date}）を、満期${cal}暦日に合わせて補間した${t.buyRate}%を入れました。`, days: t.windowDays };
  persistState();
  renderAll(t);
}
// 計算に使う金利(小数)。IVとプレミアムの両方があるときは0
const rateOf = (t) => (!bothPremIv(t) && t.buyRate > 0 ? t.buyRate / 100 : 0);

// 集計期間ごとの、ITM発生率(期間中に一度でも・満期時)の比較。売り・買いとも。
// 慎重な見方の基準＝1年以上の期間のうち、売りはITM発生率が最も高い期間、買いは最も低い期間(6ヶ月は、短く偶然に左右されるため、基準から除く)。
// 集計期間を自分で選んでいないときは、分析のたびに、この基準の期間を初期値にする。
const PERIOD_BASIS_MIN_DAYS = 253;
function periodCompareRows(t) {
  const v = viewDataOf(t);
  const full = v.closes;
  const type = OPTION_TYPES[t.typeKey];
  const group = typeGroup(t.typeKey);
  const ratio = effRatioOf(t, full[full.length - 1]);
  const { depthPct } = depthInfo(t, full);
  const rows = [];
  for (const p of PERIOD_OPTIONS) {
    if (full.length < p.days) continue; // その期間のデータが足りない
    const an = computeItmAnalysis(full.slice(-p.days), { ratio, itmWhen: type.itmWhen, window: t.windowDays, group, depthPct }, v.dates.slice(-p.days));
    if (!an.entryCount) continue;
    rows.push({ p, n: an.entryCount, touch: an.overallItmProb, exp: an.dayProb[t.windowDays - 1] ?? null });
  }
  const pool = rows.filter((r) => r.p.days >= PERIOD_BASIS_MIN_DAYS && r.touch !== null);
  const pick = group === "sell" ? (a, b) => (b.touch > a.touch ? b : a) : (a, b) => (b.touch < a.touch ? b : a);
  const basis = pool.length ? pool.reduce(pick) : null;
  return { rows, basis, group, type };
}

function renderPeriodCompare(t) {
  const card = els.periodCompareCard;
  if (!card) return;
  const { rows, basis, group, type } = periodCompareRows(t);
  if (!rows.length) { card.hidden = true; return; }
  const f = (v) => (v === null || v === undefined ? "―" : (v * 100).toFixed(1) + "%");
  const tag = group === "sell" ? "最も高い（慎重な見方）" : "最も低い（慎重な見方）";
  els.periodCompareBody.innerHTML = rows.map((r) => {
    const sel = r.p.days === t.periodDays;
    const isBasis = basis !== null && r === basis;
    return `<tr class="${sel ? "bs-sel" : ""}"><td>${r.p.label}${sel ? '<br><span class="bs-sub">いまの設定</span>' : ""}${r.p.days < PERIOD_BASIS_MIN_DAYS ? '<br><span class="bs-sub">基準から除く</span>' : ""}</td>`
      + `<td>${r.n}件<br><span class="bs-sub">独立した場面は約${Math.max(1, Math.round(r.n / t.windowDays))}回分</span></td>`
      + `<td><b>${f(r.touch)}</b>${isBasis ? `<br><span class="bs-sub">${tag}</span>` : ""}</td><td>${f(r.exp)}</td>`
      + `<td>${sel ? "" : `<button type="button" class="sp-btn" data-use-period="${r.p.days}">この期間にする</button>`}</td></tr>`;
  }).join("");
  let note;
  if (group === "sell") {
    note = "売り手は、ITMに届く割合が高い期間ほど、慎重な見方になります（荒れた期間で見ます）。表では、1年以上の期間のうち「最も高い」期間が基準です。長い期間のほうが荒いとは限りません（期間のなかの相場の向きで変わります）。";
  } else {
    const kindWord = type.itmWhen === "above" ? "上昇相場が続いた期間は、コール買いのITM発生率が高く出ます" : "下落相場が続いた期間は、プット買いのITM発生率が高く出ます";
    note = `買い手は、ITMに届く割合が低い期間ほど、慎重な見方になります。表では、1年以上の期間のうち「最も低い」期間が基準です。長い期間のほうが穏やかとは限りません（期間のなかの相場の向きで変わります。${kindWord}）。`;
  }
  els.periodCompareNote.textContent = `${note}6ヶ月は、期間が短く、独立した場面が少ないため、基準から除いています。集計期間を自分で選ばないときは、分析のたびに、基準の期間を初期値にします。`;
  card.hidden = false;
}

// 入力したIVから計算した理論価格が、支払いプレミアムと大きく離れているときの注意文(離れていなければ空文字)
function premiumMismatchText(t, price, strike, where = "iv") {
  const premium = t.rrPayPremium !== null && t.rrPayPremium > 0 ? t.rrPayPremium : null;
  const ivIn = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  if (premium === null || ivIn === null) return "";
  const theo = bsPrice(buyKindOf(t), price, strike, t.windowDays / TRADING_DAYS_PER_YEAR, ivIn, rateOf(t));
  const tYears = t.windowDays / TRADING_DAYS_PER_YEAR;
  const rateAllow = strike * 0.05 * tYears * 0.6; // 満期が長いときの、金利(約4〜5%)のぶんのずれ(ツールは、IVとプレミアムの両方があるとき、金利0で計算する)
  if (Math.abs(theo - premium) <= Math.max(0.05, premium * 0.15) + rateAllow) return "";
  const head = `※入力したIV（${(ivIn * 100).toFixed(1)}%）から計算した理論価格は${theo.toFixed(2)}で、支払いプレミアム${premium.toFixed(2)}と離れています。`;
  return where === "risk"
    ? `${head}「${SEC.risk}」と時間の経過の表は、実際に払った支払いプレミアムを基準にするため、入力したIVは使わず、プレミアムから逆算したIVで計算しています。`
    : `${head}この「${SEC.iv}」の表示は入力したIVを使い、「${SEC.risk}」は支払いプレミアムから逆算したIVを使います。`;
}

// 支払いプレミアムが、高いか安いかの判定(入力欄の下)。支払いプレミアムから逆算したIVが、HV(満期と同じ長さ)の何倍かで見る(1.2倍以上＝割高、0.8倍以下＝割安)。
function renderPremiumJudge(t, price, strike, hv) {
  const el = els.premJudge;
  if (!el) return;
  const premium = hasPrem(t) ? t.rrPayPremium : null;
  if (premium === null || hv === null) { el.textContent = ""; el.className = "field-hint"; return; }
  const kind = buyKindOf(t);
  const T = t.windowDays / TRADING_DAYS_PER_YEAR;
  // IVを入力しているときは、入力したIV(証券会社の値。金利を含む)で判定する。空欄のときだけ、プレミアムから逆算したIV(金利は、入力欄の値)を使う
  const useInput = hasIvIn(t);
  const ivJ = useInput ? t.rrIvSell / 100 : solveFlatIv({ kind, S: price, strikeSell: strike, strikeBuy: null, T, premium, r: rateOf(t) });
  if (ivJ === null) { el.textContent = "支払いプレミアムに合うIVが見つかりません。入力を確認してください（桁や単位の間違いはありませんか）"; el.className = "field-hint"; return; }
  const ratio = ivJ / hv;
  const judge = judgeIvHv(ratio);
  const word = judge.level === "rich" ? "割高" : judge.level === "cheap" ? "割安" : "標準";
  const color = judge.level === "rich" ? "var(--gradRed)" : judge.level === "cheap" ? "var(--gradBlue)" : "var(--muted)";
  // HV計算の理論価格との比較は、IVを入力していないとき(プレミアムだけのとき)に出す(IV入力時は、金利を含む証券会社のIVで判定するため)
  let priceRatio = "";
  if (!useInput) {
    const hvPrice = bsPrice(kind, price, strike, T, hv, rateOf(t));
    if (hvPrice > 0.005) priceRatio = `HV計算の理論価格${hvPrice.toFixed(2)}の${(premium / hvPrice).toFixed(1)}倍。`;
  }
  el.innerHTML = `判定：<b style="color:${color}">${word}</b>　${priceRatio}${useInput ? "入力したIV" : "逆算IV"} ${(ivJ * 100).toFixed(1)}%はHV ${(hv * 100).toFixed(1)}%の${ratio.toFixed(2)}倍（1.2倍以上＝割高、0.8倍以下＝割安）`;
  el.className = "field-hint";
}

// 買いページの「5 IV」: IVの水準・IV÷HV・IV基準の1σ・理論プレミアム価格(HV計算)を、買い手向けの読み方で出す。
// IVは、入力(任意)があればその値、なければ支払いプレミアム額から逆算した値。どちらもなければ表示しない(コーン図のIVの帯も出ない)。
function renderBuyIv(t, price, strike) {
  if (!els.ivHvSummary) return;
  const kind = buyKindOf(t);
  const itmWhen = OPTION_TYPES[t.typeKey].itmWhen;
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const days = t.windowDays;
  const clear = (msg) => {
    drawCone(t, null);
    els.ivHvSummary.innerHTML = "";
    els.ivHvCompare.innerHTML = '<p class="sub">IV（任意）か、支払いプレミアム額を入力すると、3点比較を表示します。</p>';
    els.ivHvNote.textContent = msg;
  };
  const { closes } = viewDataOf(t);
  const hv = computeHv(closes, days);
  renderPremiumJudge(t, price, strike, hv);
  if (hv === null) { clear("HVを計算するためのデータが足りないため、表示できません。"); return; }
  const premium = t.rrPayPremium !== null && t.rrPayPremium > 0 ? t.rrPayPremium : null;
  const ivIn = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  const T = days / TRADING_DAYS_PER_YEAR;
  let iv = ivIn;
  let source = "input";
  if (iv === null) {
    if (premium === null) { clear("IV（任意）か、支払いプレミアム額を入力すると表示します。"); return; }
    iv = solveFlatIv({ kind, S: price, strikeSell: strike, strikeBuy: null, T, premium, r: rateOf(t) });
    source = "calibrated";
    if (iv === null) { clear("支払いプレミアム額に合うIVが見つかりませんでした。支払いプレミアム額や権利行使価格を、確認してください。"); return; }
  }
  const ratio = iv / hv;
  const judge = judgeIvHv(ratio);
  const depthDollar = depthDollarOf(t);
  const thIv = hvTheory({ price, strike, depthDollar, itmWhen, days, hv: iv });
  // 買い手向けの読み方: IVが高い＝オプションの価格(支払うプレミアム)は割高。IVが下がると、株価が動かなくても価格が下がる
  const meaning = judge.level === "rich"
    ? "IVが高め＝オプションの価格（支払うプレミアム）は割高です。決算発表のあとなどにIVが下がると、株価が思いどおりに動いても、価格が下がって損をしやすくなります"
    : judge.level === "cheap"
      ? "IVが低め＝オプションの価格（支払うプレミアム）は割安です。IVが上がると、価格が上がって有利になります。ただし、株価が動かないと、時間の経過で価格が下がる点は同じです"
      : "標準的な水準です";
  band.ivhv = { ratio, word: judge.word, phrase: judge.phrase, meaning, iv, hv };
  const ivSub = source === "input" ? "証券会社のオプションチェーンの値" : `支払いプレミアム額${premium.toFixed(2)}に合うIV`;
  const items = [
    {
      name: "IV", value: pct(iv), suffix: source === "input" ? "（入力値）" : "（支払いプレミアムから逆算）", sub: ivSub,
      note: `IV（インプライド・ボラティリティ）は、オプションの価格に織り込まれた、これからの値動きの見込みの大きさ（年率）です。HVが「過去に実際に動いた大きさ」なのに対し、IVは「市場がこれから動くと見込んでいる大きさ」で、実際の値動きではありません。\n買い手にとって、IVが高いほど、オプションの価格（支払うプレミアム）は高くなります（割高）。\n${source === "input" ? "入力したIVを使っています。" : "IVが未入力のため、入力した支払いプレミアム額に合うIVを、Black-Scholesの式（金利0・配当なし）で逆算しています。"}`,
    },
    {
      name: "IV÷HV", value: `${ratio.toFixed(2)}倍`,
      sub: `HV ${pct(hv)}（満期と同じ長さ・「${SEC.hv}」と同じ値）で割った倍率。${judge.word}（1.2倍以上＝高め、0.8倍以下＝低め）`,
      note: `IVがHVの何倍かを見て、市場のこれからの見込み（IV）が、過去の実際の値動き（HV）より高めか低めかを判断する目安です。\n1.2倍以上＝高め／0.8倍以下＝低め／その間＝同程度。この基準は、このツールの簡易的なものです（一般に、IVはHVより少し高めになりやすいため、「同程度」の幅を広めに取っています）。\n買い手は、高めのとき、オプションが割高です。決算発表などの予定された出来事をまたぐ場合は、IVが高いのは自然です。`,
    },
  ];
  if (thIv) {
    items.push({
      name: "1σの値動き", value: `±${thIv.sigmaAmount.toFixed(2)}ドル`, suffix: "（IV基準）",
      sub: `満期まで。±${pct(thIv.sigmaPct)}（IV ${pct(iv)}×√(${days}/252)）`,
      note: `市場の見込み（IV）から見た、満期までの1σ（標準偏差）の値動きです。株価の変動が正規分布に近いと仮定すると、満期時の株価が現在値±この幅に収まる確率は約68%です。\n1σ＝現在値×IV×√(営業日数÷252)。「${SEC.hv}」の1σの値動き（HV基準）と同じ計算で、HVの代わりにIVを使っています。\nIVは、1つの値を全体に当てはめた目安です。将来を保証するものではありません。`,
    });
  }
  const hvPrice = bsPrice(kind, price, strike, T, hv, rateOf(t));
  if (hvPrice > 0.005 && premium !== null) {
    const diff = premium - hvPrice;
    const sign = diff >= 0 ? "+" : "−";
    items.push({
      name: "理論プレミアム価格", value: hvPrice.toFixed(2), suffix: "（HV計算）",
      sub: `支払い ${premium.toFixed(2)}／差 ${sign}${Math.abs(diff).toFixed(2)}（${sign}${Math.abs(diff / hvPrice * 100).toFixed(0)}%）`,
      note: `満期（${days}営業日）と同じ長さのHVを、IVの代わりに使って、Black-Scholesの式（金利0・配当なし）で計算した、オプションの価格（1株あたり）の理論値です。過去の実際の値動きから見て妥当な価格の目安です。\n支払いプレミアムが、この価格より高い（差がプラス）ときは、IVがHVより高めで、割高です。低いときは割安です（IV÷HVと同じ関係を、金額で見たものです）。\nHVは過去の値動きなので、市場の価格（IV）とは、ずれて当然です。決算発表などをまたぐ場合は、市場の価格のほうが高いのは自然です。断定的な判定には使えません。`,
    });
  }
  els.ivHvSummary.innerHTML = items.map((it) => statCardHtml({ ...it, attrs: 'data-target="orderExplain"' })).join("");
  els.ivHvNote.textContent = `${premiumMismatchText(t, price, strike)}IV${pct(iv)}は、満期と同じ長さのHV${pct(hv)}の${ratio.toFixed(2)}倍（${judge.word}）です。${meaning}。`
    + `※IVは、これからの値動きの見込みです（実際の値動きではありません）。HVは、過去に実際に動いた大きさです。決算発表などの予定された出来事をまたぐ場合は、IVが高いのは自然で、買い手に不利とは限りません。判定の基準（1.2倍以上＝高め、0.8倍以下＝低め）は、このツールの簡易的なものです。ITMになる確率の3点比較（IV換算・HV換算・実績）は、「${SEC.summary}」にあります。`;
  // ITMになる確率の3点比較(IV換算・HV換算・過去の実績)
  const thHv = hvTheory({ price, strike, depthDollar, itmWhen, days, hv });
  els.ivHvCompare.innerHTML = thIv && thHv ? ivHvCompareHtml(t, thIv, thHv, days, itmWhen, "buy") : "";
  drawCone(t, { thIv });
  setupStatExplain();
}
const pctTxt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "―" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const buyKindOf = (t) => (OPTION_TYPES[t.typeKey].itmWhen === "above" ? "call" : "put");

// 「買う条件の下落率(上昇率)Xは、何%がよいか」の、この銘柄の過去の結果。固定の線(ATR×倍率)か満期の早い方で手仕舞う。
function renderBuyStudy(t) {
  const card = els.buyStudyCard;
  if (!card) return;
  const v = viewDataOf(t);
  if (!v.highs || !v.lows || v.closes.length < 60) { card.hidden = true; return; }
  const kind = buyKindOf(t);
  const price = v.closes[v.closes.length - 1];
  const ratio = effRatioOf(t, price);
  const direction = t.momentumDirection;
  const curX = t.momentumThresholdPct;
  const xs = [...new Set([...BUY_X_LIST, ...(curX > 0 ? [curX] : [])])].sort((a, b) => a - b);
  const rows = computeBuyStudy({ closes: v.closes, highs: v.highs, lows: v.lows, kind, ratio, window: t.windowDays, xList: [null, ...xs], direction, mult: t.buyAtrMult });
  const dirWord = direction === "down" ? "下落" : "上昇";
  const f = (s) => (s ? `${pctTxt(s.mean)}<br><span class="bs-sub">中央${pctTxt(s.median)}・勝率${(s.win * 100).toFixed(0)}%</span>` : "―");
  const body = rows.map((r) => {
    const label = r.x === null ? "条件なし（毎日買う・基準）" : `${dirWord} ${r.x}%以上`;
    const sel = r.x !== null && Math.abs(r.x - curX) < 1e-9;
    if (!r.n) return `<tr class="${sel ? "bs-sel" : ""}"><td>${label}</td><td colspan="4">当てはまる日がありません</td><td>${r.x === null ? "" : `<button type="button" class="sp-btn" data-use-x="${r.x}">この値にする</button>`}</td></tr>`;
    return `<tr class="${sel ? "bs-sel" : ""}"><td>${label}${sel ? '<br><span class="bs-sub">いまの設定</span>' : ""}</td>`
      + `<td>${r.n}件<br><span class="bs-sub">独立した場面は約${r.trials}回分</span></td>`
      + `<td>${f(r.opt)}</td>`
      + `<td>${(r.lineRate * 100).toFixed(0)}%<br><span class="bs-sub">平均${r.avgDays.toFixed(0)}日</span></td>`
      + `<td>${pctTxt(r.optHoldMean)}</td>`
      + `<td>${r.x === null ? "" : `<button type="button" class="sp-btn" data-use-x="${r.x}">この値にする</button>`}</td></tr>`;
  }).join("");
  els.buyStudyBody.innerHTML = body;
  const used = rows.filter((r) => r.x !== null && r.n > 0 && r.trials >= 3 && r.opt);
  let hint = "";
  if (used.length) {
    const best = used.reduce((a, b) => (b.opt.median > a.opt.median ? b : a));
    hint = `オプションの中央値が最も高いのは「${dirWord} ${best.x}%以上」（${best.n}件・独立した場面は約${best.trials}回分）です。独立した場面が少ない行は、偶然に左右されます。`;
  }
  const typeLabel = OPTION_TYPES[t.typeKey].label;
  els.buyStudyNote.innerHTML = `各行は、この銘柄の過去（取得済みの全データ。${v.closes.length}営業日）で、その条件に当てはまった日に買い、<b>固定の線（買った日の終値から、ATR(${ATR_PERIOD})の${t.buyAtrMult}倍）を終値で割った日、または満期（${t.windowDays}営業日）の早い方</b>で手仕舞った場合の結果です。`
    + `オプションは、いまの権利行使価格の比率（${ratio.toFixed(4)}）・満期の営業日数で、<b>IVは実際の値ではなく、直近20営業日のHV×1.15の仮定</b>（Black-Scholes・手数料なし）で計算しています。`
    + `<br>・<b>平均</b>＝1回あたりの平均損益率。大勝ちが少しあると、平均が大きくなります。<b>中央値</b>＝普通の取引の損益率（並べて真ん中）。<b>勝率</b>＝プラスで終わった割合。${typeLabel}は、平均が中央値より大きくなりやすい取引です。`
    + `<br>・「満期保有」は、線を使わず満期まで持った場合のオプションの平均です（線の効果を見る参考）。`
    + `<br>・件数は、日が重なるため、独立した場面は「件数÷満期の営業日数」回分ほどです。${hint}`
    + `<br>・複数銘柄・期間の検証（強い上昇相場に偏った期間）では、下落が大きいほど成績が良い傾向でしたが、大きな下落から反発した少数の場面に集中していました。将来を保証するものではありません。`;
  card.hidden = false;
}

// 固定の線(買った時点で決めて動かさない)。ATR倍率ごとに、線に届いたときの株・オプションの損失と、資金の2%に収まる数量を並べる。
function renderBuyRisk(t, price, strike, asOfDate) {
  const card = els.buyRiskCard;
  if (!card) return;
  const v = viewDataOf(t);
  if (!v.highs || !v.lows) {
    els.buyRiskSummary.innerHTML = "";
    els.buyRiskBody.innerHTML = "";
    els.buyRiskNote.textContent = "高値・安値を取得できていないため、固定の線を計算できません。「分析する」を押し直してください。";
    card.hidden = false;
    return;
  }
  const kind = buyKindOf(t);
  const atrArr = computeAtr(v.highs, v.lows, v.closes, ATR_PERIOD);
  const atr = atrArr[atrArr.length - 1];
  if (!(atr > 0)) { card.hidden = true; return; }
  const premium = t.rrPayPremium !== null && t.rrPayPremium > 0 ? t.rrPayPremium : null;
  const ivIn = t.rrIvSell !== null && t.rrIvSell > 0 ? t.rrIvSell / 100 : null;
  const assumed = assumedIvAt(v.closes, v.closes.length - 1);
  const capital = riskCapital();
  const tbl = computeFixedLineTable({
    price, atr, kind, strike, days: t.windowDays, premium, capital: capital > 0 ? capital : null, contracts: t.planQty,
    iv: premium !== null ? null : (ivIn !== null ? ivIn : assumed), rate: rateOf(t), mults: BUY_ATR_MULTS.includes(t.buyAtrMult) ? BUY_ATR_MULTS : [...BUY_ATR_MULTS, t.buyAtrMult].sort((a, b) => a - b),
  });
  const dirWord = kind === "call" ? "下がった" : "上がった";
  const sel = tbl.rows.find((r) => r.mult === t.buyAtrMult) || tbl.rows[0];
  band.buyLine = { line: sel.line, movePct: sel.movePct, mult: sel.mult, kind };
  const ivSrc = tbl.iv === null ? "（IVを計算できません）"
    : premium !== null ? "支払いプレミアムから逆算したIV" : (ivIn !== null ? "入力したIV" : "仮定のIV（直近20営業日のHV×1.15）");
  els.buyRiskSummary.innerHTML = [
    { name: "ATR", value: atr.toFixed(2), suffix: `（直近${ATR_PERIOD}営業日）`, sub: `株価の${(atr / price * 100).toFixed(1)}%。1日の値幅(高値−安値など)の平均的な大きさ`, note: `ATR(Average True Range)は、直近${ATR_PERIOD}営業日の「1日の値幅」の平均です（前日の終値からの飛びも含めます）。固定の線の幅の単位として使います。` },
    { name: `手仕舞いの線（ATR×${sel.mult}）`, value: sel.line.toFixed(2), sub: `買った日の終値${price.toFixed(2)}から ${sel.moveAmount.toFixed(2)}ドル（${pctTxt(sel.movePct, 1)}）${dirWord}価格`, note: "買った時点で決めて動かさない、1本の固定の線です。トレンドの判定や、日々の切り上げはしません。終値がこの線に届いたら手仕舞う、という目安です。" },
  ].map((it) => statCardHtml({ ...it, attrs: 'data-target="orderExplain"' })).join("");
  const money = (x) => (x === null || x === undefined ? "―" : x.toLocaleString("ja-JP", { maximumFractionDigits: 2 }));
  // 資金の2%の損切りの線が、ATR×2(表の最小の倍率)より近いときは、その行を一番上に出す
  const showRisk = tbl.riskRow && (tbl.riskRow.alreadyOver || tbl.riskRow.mult < Math.min(...BUY_ATR_MULTS));
  const rowsAll = showRisk ? [tbl.riskRow, ...tbl.rows] : tbl.rows;
  els.buyRiskBody.innerHTML = rowsAll.map((r) => {
    if (r.alreadyOver) {
      return `<tr class="bs-risk"><td><b>資金2%の損切り</b><br><span class="bs-sub">${r.contracts}枚の場合</span></td><td colspan="3"><b>すでに、いまの価格で、損失が資金の2%を超えています</b>（いまの理論価格との差で、1枚 ${money(r.nowLoss * 100)}ドルの損失。上限は${money(capital * 0.02)}ドル）。入力したIVから計算した理論価格が、支払いプレミアムよりずっと低いためです。IVを空欄にして、支払いプレミアムから逆算させてください</td></tr>`;
    }
    const isSel = !r.isRisk && r.mult === t.buyAtrMult;
    const qtyOpt = r.maxContracts === null ? "―（資金を入力）" : r.maxContracts === 0 ? "0枚（1枚でも2%超）" : `${r.maxContracts.toLocaleString("ja-JP")}枚`;
    const head = r.isRisk
      ? `<b>資金2%の損切り</b><br><span class="bs-sub">${r.contracts}枚の場合・ATR×${r.mult.toFixed(2)}</span>`
      : `ATR×${r.mult}${isSel ? '<br><span class="bs-sub">いまの設定</span>' : ""}`;
    return `<tr class="${isSel ? "bs-sel" : ""}${r.isRisk ? " bs-risk" : ""}"><td>${head}</td>`
      + `<td>${r.line.toFixed(2)}<br><span class="bs-sub">${pctTxt(r.movePct, 1)}</span></td>`
      + `<td>${r.value === null ? "―" : money(r.value)}<br><span class="bs-sub">プレミアム${tbl.premium === null ? "―" : money(tbl.premium)}</span></td>`
      + `<td>${r.optLoss === null ? "―" : `1枚 ${money(r.optLoss * 100)}ドル（支払いの${(r.optLossPct * 100).toFixed(0)}%）<br><span class="bs-sub">資金2%なら ${qtyOpt}</span>`}</td></tr>`;
  }).join("");
  const riskNote = showRisk && tbl.riskRow.alreadyOver ? "" : showRisk
    ? `<br>・一番上の「資金2%の損切り」は、${tbl.riskRow.contracts}枚${t.planQty ? "" : "（枚数が未入力のため1枚）"}で、損失が資金の2%になる株価の位置です。ATR×2より近い（${tbl.riskRow.mult.toFixed(2)}倍）ため、表に出しています。この線より先まで待つと、資金の2%を超えます。`
    : "";
  const warn = premium === null && ivIn === null ? "支払いプレミアム額（またはIV）が未入力のため、IVは仮定の値です。「2 注文プラン」に支払いプレミアム額を入れると、実際の価格に近づきます。 " : "";
  const capNote = capital > 0 ? `資金（${money(capital)}ドル）の2%＝${money(capital * 0.02)}ドルが、1回の手仕舞いで許せる損失の上限です。` : "「2 注文プラン」にトータル資金額を入れると、資金の2%に収まる枚数を出します。";
  const mism = premiumMismatchText(t, price, strike, "risk");
  els.buyRiskNote.innerHTML = `${mism ? mism + "<br>" : ""}${warn}${capNote}${riskNote}<br>・オプションの価格は、満期までの日数・IV（${ivSrc}${tbl.iv !== null ? `：${(tbl.iv * 100).toFixed(1)}%` : ""}）はそのままで、株価だけが線まで動いたとしたBlack-Scholes（金利0・配当なし）の目安です。実際は、IVの変化や時間の経過、売買の差でずれます。`
    + `<br>・オプションの損失は、最大でも支払ったプレミアムです。満期が短い・OTMのとき、線に届く前に全損することがあります。`
    + `<br>・線は、期待値を上げるものではなく、<b>損失の大きさを決めるもの</b>です（過去の検証では、倍率を大きくするほど、平均と勝率は上がり、最悪の損失が深くなりました）。`;
  renderBuyTime(t, price, strike, asOfDate, tbl, kind, capital, ivSrc);
  card.hidden = false;
}

// 買い建玉の、時間の経過の表。株価は今の水準のまま動かず、IVが変わり(縦)、時間が経った(横)ときの、オプション価格と損益。
// 買い手は、時間が経つと、株価が動かなくても価格が下がる(時間価値の減少)。損失が資金の2%以上になるセルに印を付ける。
const BUY_TIME_IV_CHANGES = [-0.10, -0.05, 0, 0.10, 0.20, 0.30];
function renderBuyTime(t, price, strike, asOfDate, tbl, kind, capital, ivSrc) {
  const clear = (msg) => {
    els.buyTimeIntro.textContent = "";
    els.buyTimeHead.innerHTML = "";
    els.buyTimeBody.innerHTML = "";
    els.buyTimeNote.textContent = msg;
  };
  if (!tbl || tbl.iv === null || !(tbl.premium > 0)) { clear("支払いプレミアム額（またはIV）を入力すると表示します。"); return; }
  const days = t.windowDays;
  const iv0 = tbl.iv;
  const pay = tbl.premium;
  // 横: いま／満期までの長さの半分(10営業日より長いときだけ)／2週間前(残り10営業日)
  const half = Math.round(days / 2);
  const cols = [{ remain: days, name: "いま" }];
  if (half > 10) cols.push({ remain: half, name: "満期までの半分" });
  if (days > 10) cols.push({ remain: 10, name: "2週間前" });
  const qty = t.planQty > 0 ? t.planQty : 1;
  const limit = capital > 0 ? capital * 0.02 : null;
  const money = (v) => v.toFixed(2);
  const dateOf = (remain) => shiftTradingDays(asOfDate, -(days - remain)).slice(5);
  els.buyTimeIntro.textContent = `株価は今の水準（${money(price)}）のまま動かず、IVだけが変わり、時間が経った場合の、買ったオプションの価格（太字）と、支払ったプレミアム（${money(pay)}）に対する損益です（1枚＝100株あたり）。買い手は、時間が経つと、株価が動かなくても価格が下がります（時間価値の減少）。価格は、残り日数ごとにBlack-Scholesで計算し直した値で、日ごとのセータ（1日あたりの減少額。満期に近いほど大きくなります）を足し合わせた値と一致します。`
    + (limit !== null ? `「資金2%超」は、${qty}枚${t.planQty > 0 ? "" : "（枚数が未入力のため1枚）"}で、損失が資金の2%（${limit.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル）以上になるセルです。` : "");
  els.buyTimeHead.innerHTML = `<tr><th>IVの変化</th>${cols.map((c) => `<th>${c.name}<br><span class="stress-sub">残り${c.remain}営業日（${dateOf(c.remain)}）</span></th>`).join("")}</tr>`;
  els.buyTimeBody.innerHTML = BUY_TIME_IV_CHANGES.filter((up) => iv0 + up >= 0.02).map((up) => {
    const label = up === 0 ? "変わらない" : `${up > 0 ? "＋" : "−"}${Math.abs(Math.round(up * 100))}ポイント`;
    const tds = cols.map((c) => {
      const value = bsPrice(kind, price, strike, c.remain / TRADING_DAYS_PER_YEAR, iv0 + up, rateOf(t));
      const pnl = value - pay; // 買い手の損益(1株)
      const over = limit !== null && pnl < 0 && -pnl * 100 * qty >= limit;
      const cls = [pnl >= 0 ? "stress-profit" : "", over ? "stress-over" : ""].filter(Boolean).join(" ");
      const sign = Math.abs(pnl * 100) < 0.5 ? "" : (pnl >= 0 ? "+" : "−"); // ほぼ0のときは符号なし
      return `<td class="${cls}"><b>${money(value)}</b><br><span class="stress-pnl ${pnl < 0 ? "neg" : ""}">${sign}${Math.abs(pnl * 100).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル（${sign}${Math.abs(pnl / pay * 100).toFixed(0)}%）</span>${over ? '<br><span class="stress-overtag">資金2%超</span>' : ""}</td>`;
    }).join("");
    return `<tr><td>${label}<br><span class="stress-sub">IV ${((iv0 + up) * 100).toFixed(1)}%</span></td>${tds}</tr>`;
  }).join("");
  els.buyTimeNote.textContent = `IVは、${ivSrc}（${(iv0 * 100).toFixed(1)}%）を基準に、全体が一律に動くとして計算しています。緑のセルは、支払ったプレミアム以上の価格（損益がプラス）です。金利0・配当なしのBlack-Scholesの目安で、実際の価格とは、スキュー・売買の差などでずれます。株価が動く場合は、上の表（固定の線）を見てください。`;
}

let lastBuyPlanText = "";
function renderBuyPlan(t, price, strike, asOfDate) {
  const card = els.buyPlanCard;
  if (!card) return;
  const v = viewDataOf(t);
  const kind = buyKindOf(t);
  const type = OPTION_TYPES[t.typeKey];
  const expiry = shiftTradingDays(asOfDate, -t.windowDays);
  const bl = band.buyLine;
  const premium = t.rrPayPremium !== null && t.rrPayPremium > 0 ? t.rrPayPremium : null;
  const capital = riskCapital();
  const ask = (m) => `―（${m}を入力）`;
  const money = (x) => x.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  // 発注枚数: 入力があればその値。空欄なら、資金の2%に収まる最大枚数
  let optLoss = null;
  let riskRow2 = null; // 損失が資金の2%になる線
  if (bl && premium !== null) {
    const atrArr = v.highs && v.lows ? computeAtr(v.highs, v.lows, v.closes, ATR_PERIOD) : null;
    const tbl = atrArr ? computeFixedLineTable({ price, atr: atrArr[atrArr.length - 1], kind, strike, days: t.windowDays, premium, iv: null, capital: capital > 0 ? capital : null, contracts: t.planQty, rate: rateOf(t), mults: [bl.mult] }) : null;
    optLoss = tbl ? tbl.rows[0] : null;
    riskRow2 = tbl ? tbl.riskRow : null;
  }
  const qty = t.planQty ?? (optLoss && optLoss.maxContracts !== null ? optLoss.maxContracts : null);
  const qtyNote = t.planQty ? "入力した枚数" : (qty !== null ? "資金の2%に収まる最大枚数" : "");
  const rows = [];
  const add = (k, val) => rows.push([k, val]);
  add("銘柄・取引", `${t.symbol}　${type.label}い（${kind === "call" ? "コール" : "プット"}）　基準日の終値 ${price.toFixed(2)}`);
  add("発注する権利行使価格・満期", `権利行使価格 ${fmtStrike(strike)}（終値の${(strike / price * 100).toFixed(1)}%）　満期 ${expiry}（残り${t.windowDays}営業日）`);
  add("支払いプレミアム（買いの指値）", premium === null ? ask("支払いプレミアム額") : `指値 ${money(premium)}　（1枚 ${money(premium * 100)}ドル）`);
  add("枚数", qty === null ? ask("トータル資金額（または枚数）") : qty === 0 ? "0枚（1枚でも、線に届いたときの損失が資金の2%を超えます。枚数を入力するか、資金・線の倍率を見直してください）" : `${qty}枚（${qtyNote}）　／　支払い合計 ${premium === null ? "―" : money(premium * 100 * qty)}ドル`);
  add("手仕舞いの線（固定）", bl ? `${bl.line.toFixed(2)}（買った日の終値から ${pctTxt(bl.movePct, 1)}・ATR×${bl.mult}）。終値がこの線に届いたら手仕舞う` : "―");
  add("損切り2%の線", capital > 0 && premium !== null
    ? (riskRow2 && riskRow2.alreadyOver
      ? "すでに、いまの価格で、損失が資金の2%を超えています（入力したIVの理論価格と、支払いプレミアムが食い違っています。IVを空欄にして、支払いプレミアムから逆算させてください）"
      : riskRow2
      ? `${riskRow2.line.toFixed(2)}（買った日の終値から ${pctTxt(riskRow2.movePct, 1)}・ATR×${riskRow2.mult.toFixed(2)}）。${riskRow2.contracts}枚${t.planQty ? "" : "（枚数が未入力のため1枚）"}で、損失が資金の2%（${money(capital * 0.02)}ドル）になる位置。この線より先まで待つと、資金の2%を超えます`
      : `ありません（全損しても、損失が資金の2%以内に収まります）`)
    : ask("支払いプレミアム額・トータル資金額"));
  add("線に届いたときのオプションの損失", optLoss && optLoss.optLoss !== null ? `1枚 ${money(optLoss.optLoss * 100)}ドル（支払いの${(optLoss.optLossPct * 100).toFixed(0)}%）${qty ? `　／　${qty}枚で ${money(optLoss.optLoss * 100 * qty)}ドル` : ""}` : ask("支払いプレミアム額"));
  add("資金に対する損失", optLoss && optLoss.optLoss !== null && qty && capital > 0 ? `${(optLoss.optLoss * 100 * qty / capital * 100).toFixed(2)}%（上限2%${optLoss.optLoss * 100 * qty / capital > 0.02 ? "を超えています" : "以内"}）` : ask("トータル資金額・枚数"));
  add("満期より前の判断日", `満期の10営業日前（${shiftTradingDays(expiry, MARK_BEFORE_EXPIRY)}）に、利益・損失を見直します`);
  const act = els.overallProb.textContent;
  add("判断の根拠", `ITM発生率（過去の実績）${act}・総合判定 ${els.badge.textContent}${band.hvItm !== null ? `／満期時ITM率（HV換算）${(band.hvItm * 100).toFixed(1)}%` : ""}${band.cond ? `／最低条件 ${band.cond.hitDays >= 1 ? "満たしている" : "満たしていない"}（${band.cond.hitDays}/7日）` : ""}`);
  els.buyPlanBody.innerHTML = rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join("");
  lastBuyPlanText = rows.map(([k, val]) => `${k}：${val.replace(/<[^>]+>/g, "")}`).join("\n");
  card.hidden = false;
}

// 「最低条件」の判定の表示。最低条件＝1〜7営業日前との比較のうち、設定した変化率以上の値動きが1日以上。推奨＝該当日数の設定値以上。
function renderCondGate() {
  const c = band.cond;
  if (!c) { els.condGate.hidden = true; return; }
  const word = c.down ? "下落" : "上昇";
  const detail = `1〜7営業日前との比較のうち、設定した変化率以上の${word}が<b>${c.hitDays}/7日</b>`;
  let cls;
  let html;
  if (c.hitDays >= 1 && c.hitDays >= c.rec) {
    cls = "ok";
    html = `<b>最低条件：満たしています</b>（推奨も満たしています）　${detail}あります（最低条件は1日以上、推奨は${c.rec}日以上）。`;
  } else if (c.hitDays >= 1) {
    cls = "mid";
    html = `<b>最低条件：満たしています</b>（推奨には届きません）　${detail}あります（最低条件は1日以上、推奨は${c.rec}日以上）。`;
  } else {
    cls = "ng";
    html = `<b>最低条件：満たしていません</b>　${detail}です（最低条件は1日以上）。下の画面は、そのまま見られます。`;
  }
  els.condGate.className = `gate ${cls}`;
  els.condGate.innerHTML = html;
  els.condGate.hidden = false;
}

// リスク確認のタブ(ストレステスト／IVの変化と時間の経過)
function setRiskTab(which) {
  const stress = which === "stress";
  els.stressWrap.hidden = !stress;
  els.ivTimeWrap.hidden = stress;
  for (const [btn, on] of [[els.riskTabStress, stress], [els.riskTabTime, !stress]]) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
}

function init() {
  initThemeBar("theme-bar");
  setupCellTip();
  initTypeOptions();
  initPeriodOptions();
  initMomentumLookbackOptions();
  setupTickerHistoryDropdown(els.ticker, els.tickerHistoryDropdown);
  setupStatExplain();
  setupConeFocus();

  // 復元の優先順位: URLの共有パラメータ > 同一端末の保存状態 > 新規タブ
  const shareData = parseShareParam();
  if (shareData) {
    // 共有リンクの取引タイプが、このページのものでなければ、もう一方のページへ移す(混ざっているときは、このページのタブだけ開く)
    const own = shareData.recipes.filter((r) => !r.typeKey || isPageType(r.typeKey));
    if (own.length === 0) {
      location.replace(`${OTHER_PAGE}${location.search}`);
      return;
    }
    loadFromShareRecipes(own);
    mergeTickerHistory(shareData.tickerHistory);
  } else if (!loadFromSavedState()) {
    createTab();
  }
  if (migratedTabCount > 0 && els.pageNotice) {
    els.pageNotice.innerHTML = `買い系のタブ（${migratedTabCount}件）は、<a href="buy.html">買いページ</a>に移しました。`;
    els.pageNotice.hidden = false;
  }

  els.analyzeBtn.addEventListener("click", onAnalyze);
  els.ticker.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAnalyze();
  });
  els.typeSelect.addEventListener("change", () => {
    els.ratioInput.value = OPTION_TYPES[els.typeSelect.value].ratio;
    if (PAGE === "buy") els.momentumDirectionSelect.value = OPTION_TYPES[els.typeSelect.value].itmWhen === "above" ? "down" : "up";
    els.rrSellStrikeInput.value = ""; // 取引タイプが変わると、入力した売りの権利行使価格は意味が変わるため消す
    onFormChange();
  });
  // 比率の入力が終わったとき(別の欄に移ったとき・Enter)、権利行使価格が整数になるように、比率を直す
  const onRatioCommit = () => {
    const t = activeTab();
    if (t) t.ratioCommit = true; // 入力欄にフォーカスが残っていても(Enterのとき)、比率を直す
    onFormChange();
  };
  els.ratioInput.addEventListener("change", onRatioCommit);
  // 比率を変えたら、入力した売りの権利行使価格は消して、比率から決める(どちらか一方で権利行使価格を決める)
  els.ratioInput.addEventListener("input", debounce(() => {
    els.rrSellStrikeInput.value = "";
    onFormChange();
  }, 250));
  // 推奨比率の逆算: 目標の変更と、「この比率を使う」ボタン
  const onRatioSetting = (el, key, max) => () => {
    const v = Number(el.value);
    if (el.value === "" || !Number.isFinite(v) || v < 0 || v > max) return;
    try { localStorage.setItem(key, String(v)); } catch (e) { /* 保存できなくても動作に支障はない */ }
    const t = activeTab();
    if (t && t.closesFull) renderRatioCard(t);
  };
  els.ratioTargetInput.addEventListener("input", onRatioSetting(els.ratioTargetInput, RATIO_TARGET_KEY, 100));
  els.ratioMinPremInput.addEventListener("input", onRatioSetting(els.ratioMinPremInput, RATIO_MINPREM_KEY, 1000));
  els.ratioStepBtns.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (!b) return;
    const v = b.dataset.step;
    try { localStorage.setItem(RATIO_STEP_KEY, v); } catch (e) { /* 保存できなくても動作に支障はない */ }
    const t = activeTab();
    if (t && t.closesFull) renderRatioCard(t);
  });
  els.ratioCard.addEventListener("click", (e) => {
    const b = e.target.closest("[data-use-strike]");
    if (b) applyStrike(b.dataset.useStrike);
  });
  // 満期日(判定期間)の入力。キーボード入力の途中経過で何度も再計算しないよう、入力が止まってから反映する
  const debouncedCommit = debounce((v) => commitWindowDate(v), 600);
  for (const inp of [els.windowDateInput]) {
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
  // 売り・買いの権利行使価格、売り・買いのプレミアム、受取プレミアムの入力方法
  for (const el of [els.rrSellStrikeInput, els.rrBuyStrikeInput, els.rrPremSellInput, els.rrPremBuyInput]) {
    el.addEventListener("input", debounce(onFormChange, 250));
  }
  const setPremMode = (mode) => {
    const t = activeTab();
    if (!t) return;
    t.rrPremMode = mode;
    onFormChange();
  };
  els.premModeNet.addEventListener("click", () => setPremMode("net"));
  els.premModeLegs.addEventListener("click", () => setPremMode("legs"));
  els.rrIvBuyInput.addEventListener("input", debounce(onFormChange, 250));
  // 損切りの場面(ストレステストの表のセル)の選択
  for (const body of [els.stressBody, els.ivTimeBody]) {
    body.addEventListener("click", (e) => {
      const td = e.target.closest("[data-stop-pick]");
      const t = activeTab();
      if (!td || !t || !t.closesFull) return;
      t.stopPick = t.stopPick === td.dataset.stopPick ? null : td.dataset.stopPick; // 選択中のセルをもう一度クリックすると外れる
      persistState();
      renderAll(t);
    });
  }
  els.riskTabStress.addEventListener("click", () => setRiskTab("stress"));
  els.riskTabTime.addEventListener("click", () => setRiskTab("time"));
  els.riskClearPick.addEventListener("click", () => {
    const t = activeTab();
    if (!t || !t.closesFull) return;
    t.stopPick = null;
    persistState();
    renderAll(t);
  });
  // リスクリワードのトータル資金額(全タブ共通・ブラウザに保存)と、発注枚数(タブごと)
  const onRiskSetting = (el, key, max) => () => {
    const v = el.value === "" ? 0 : Number(el.value);
    if (!Number.isFinite(v) || v < 0 || v > max) return;
    try { localStorage.setItem(key, String(v)); } catch (err) { /* 保存できなくても動作に支障はない */ }
    const t = activeTab();
    if (t && t.closesFull) renderAll(t);
  };
  els.riskCapitalInput.addEventListener("input", debounce(onRiskSetting(els.riskCapitalInput, RISK_CAPITAL_KEY, 1e9), 300));
  els.planQtyInput.addEventListener("input", debounce(() => {
    const t = activeTab();
    if (!t) return;
    const v = Number(els.planQtyInput.value);
    t.planQty = els.planQtyInput.value !== "" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
    persistState();
    if (t.closesFull) renderAll(t);
  }, 300));
  els.planCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(lastPlanText);
      els.planCopyHint.textContent = "コピーしました";
    } catch (err) {
      els.planCopyHint.textContent = "コピーできませんでした。表を選んで、コピーしてください";
    }
    setTimeout(() => { els.planCopyHint.textContent = ""; }, 3000);
  });
  els.otmToggleBtn.addEventListener("click", () => {
    const t = activeTab();
    if (!t || !t.closesFull) return;
    t.otmView = !t.otmView;
    renderMainAnalysis(t);
  });
  els.shareBtn.addEventListener("click", onShareLink);
  els.openDetailBtn.addEventListener("click", onOpenDetail);
  // 期間ごとのITM発生率の表の「この期間にする」(売り・買い共通)
  if (els.periodCompareBody) {
    els.periodCompareBody.addEventListener("click", (e) => {
      const b = e.target.closest("[data-use-period]");
      const t = activeTab();
      if (!b || !t || !t.closesFull) return;
      els.periodSelect.value = b.dataset.usePeriod;
      onFormChange();
    });
  }
  if (PAGE === "buy") {
    if (els.buyAtrMultSelect) els.buyAtrMultSelect.addEventListener("change", onFormChange);
    if (els.beBaseCheck) els.beBaseCheck.addEventListener("change", onFormChange);
    // 金利: 手で入力。空欄＝0。「米国債利回りを入れる」ボタン(IVとプレミアムの片方だけで、満期が長いとき)
    els.buyRateInput.addEventListener("input", debounce(() => {
      const t = activeTab();
      if (!t) return;
      const v = els.buyRateInput.value;
      t.buyRate = v === "" ? null : Math.max(0, Number(v));
      rateNote = { text: "", days: null };
      persistState();
      if (t.closesFull) renderAll(t);
    }, 300));
    els.buyRateBtn.addEventListener("click", fillRateFromTreasury);
    // 「買う条件の過去の結果」の表の「この値にする」ボタン: 下落率(上昇率)の入力に反映して、再計算する
    els.buyStudyBody.addEventListener("click", (e) => {
      const b = e.target.closest("[data-use-x]");
      const t = activeTab();
      if (!b || !t || !t.closesFull) return;
      els.momentumThresholdInput.value = b.dataset.useX;
      onFormChange();
    });
    els.buyPlanCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(lastBuyPlanText);
        els.buyPlanCopyHint.textContent = "コピーしました";
      } catch (err) {
        els.buyPlanCopyHint.textContent = "コピーできませんでした。表を選んで、コピーしてください";
      }
      setTimeout(() => { els.buyPlanCopyHint.textContent = ""; }, 3000);
    });
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
