// ロールオーバー計算機（ブルプット）の画面。計算は rollCalc.js(純粋関数)、ITM確率の目安は calc.js の既存関数を使う。
import { initThemeBar } from "./theme.js";
import { rollSimple, rollDetail } from "./rollCalc.js";
import { computeHv, hvTheory, computeItmAnalysis } from "./calc.js";
import { tradingDaysBetween, previousTradingDay } from "./usMarket.js";

const STORAGE_KEY = "itm-roll-v1";
const $ = (id) => document.getElementById(id);
const els = {
  modeSimple: $("modeSimple"), modeDetail: $("modeDetail"), modeHint: $("modeHint"),
  oldSell: $("rollOldSell"), oldBuy: $("rollOldBuy"), q0: $("rollQ0"),
  newSell: $("rollNewSell"), newBuy: $("rollNewBuy"), q1: $("rollQ1"),
  p0: $("rollP0"), b: $("rollB"), n: $("rollN"), nLabel: $("rollNLabel"), x: $("rollX"),
  inputNote: $("rollInputNote"),
  resultCard: $("rollResultCard"), summary: $("rollSummary"), resultNote: $("rollResultNote"),
  chartCard: $("rollChartCard"), chart: $("rollChart"), chartNote: $("rollChartNote"),
  itmCard: $("rollItmCard"), ticker: $("rollTicker"), expiry: $("rollExpiry"), itmBtn: $("rollItmBtn"),
  itmStatus: $("rollItmStatus"), itmSummary: $("rollItmSummary"), itmNote: $("rollItmNote"),
};
const INPUT_KEYS = ["oldSell", "oldBuy", "q0", "newSell", "newBuy", "q1", "p0", "b", "n", "x", "ticker", "expiry"];

let mode = "simple"; // "simple" | "detail"
let itmPrice = null; // ITM確率の目安を取得したときの最新の終値(グラフの現在値の線に使う)

// ---- 保存・復元 ----
function save() {
  try {
    const v = { mode };
    for (const k of INPUT_KEYS) v[k] = els[k].value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch (e) { /* 保存できなくても致命的ではない */ }
}
function restore() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!v) return;
    for (const k of INPUT_KEYS) if (typeof v[k] === "string") els[k].value = v[k];
    if (v.mode === "detail") mode = "detail";
  } catch (e) { /* 無視 */ }
}

// ---- 入力の読み取り ----
function num(el) {
  if (el.value === "") return null;
  const v = Number(el.value);
  return Number.isFinite(v) ? v : null;
}
const fmt = (v) => v.toFixed(2);
const signed = (v) => `${Math.round(v * 100) / 100 >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
const usd = (v) => `${Math.round(v * 100) >= 0 ? "+" : "−"}${Math.abs(v * 100).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル`;
const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

// ---- 数字のカード(「名前：数字」の形。分析ページと同じ見た目) ----
function statCard({ name, value, suffix = "", suffixClass = "", sub = "", note = "" }) {
  return `<div class="stat" data-note="${note}">`
    + `<div class="stat-head"><span class="stat-name">${name}：</span><b>${value}</b>${suffix ? `<span class="stat-suffix ${suffixClass}">${suffix}</span>` : ""}</div>`
    + (sub ? `<span class="stat-sub">${sub}</span>` : "")
    + `</div>`;
}
const judgeClass = (level) => (level === "profit" ? "roll-profit" : level === "loss" ? "roll-loss" : "");

// カードをクリックすると、直後に説明欄を出す(もう一度で閉じる)
document.addEventListener("click", (e) => {
  const el = e.target.closest(".stat[data-note]");
  if (!el) return;
  if (el.classList.contains("active")) {
    el.classList.remove("active");
    const box = el.nextElementSibling;
    if (box && box.classList.contains("explain-box")) box.remove();
    return;
  }
  el.classList.add("active");
  const box = document.createElement("div");
  box.className = "explain-box";
  box.textContent = el.dataset.note;
  el.insertAdjacentElement("afterend", box);
});

// ---- 表示の切り替え(簡易版／詳細版) ----
function applyMode() {
  const detail = mode === "detail";
  els.modeSimple.classList.toggle("active", !detail);
  els.modeDetail.classList.toggle("active", detail);
  document.querySelectorAll(".roll-detail").forEach((el) => { el.hidden = !detail; });
  els.modeHint.textContent = detail
    ? "枚数に加えて、権利行使価格も入力します。最大利益・最大損失・損益分岐点・グラフも表示します。"
    : "受取・支払いの数字と、枚数だけで、総合損益を計算します。";
  els.itmCard.hidden = !detail;
  render();
}

// ---- 結果の描画 ----
function render() {
  const p0 = num(els.p0), b = num(els.b), n = num(els.n);
  const q0 = num(els.q0) ?? 1, q1 = num(els.q1) ?? 1;
  const xPct = num(els.x);
  const x = xPct === null ? 0.8 : Math.min(100, Math.max(0, xPct)) / 100;
  const xText = `${Math.round(x * 1000) / 10}%`;
  els.inputNote.textContent = xPct === null ? "新規の利確割合が未入力のため、講座の基準の80%で計算しています。" : "";

  const hide = (msg) => {
    els.resultCard.hidden = true;
    els.chartCard.hidden = true;
    els.inputNote.textContent = [els.inputNote.textContent, msg].filter(Boolean).join(" ");
  };
  if (p0 === null || b === null || n === null || p0 < 0 || b < 0 || n < 0) {
    hide("既存建玉の当初の受取、反対売買の支払い、新規の受取を入力すると表示します。");
    return;
  }
  if (!(q0 > 0) || !(q1 > 0)) { hide("枚数は1以上で入力してください。"); return; }

  let r;
  let noteExtra = "";
  if (mode === "simple") {
    r = rollSimple({ p0, b, n, x, q0, q1 });
    els.chartCard.hidden = true;
  } else {
    r = rollDetail({
      oldSell: num(els.oldSell), oldBuy: num(els.oldBuy), q0,
      newSell: num(els.newSell), newBuy: num(els.newBuy), q1,
      p0, b, n, x,
    });
    if (r.errors.length) { hide(r.errors.join(" ")); return; }
    renderChart(r);
    noteExtra = ` 参考：既存建玉を損切りせず満期まで持った場合の最大損失は、${fmt(r.oldMaxLoss)}（100株で${Math.round(r.oldMaxLoss * 100).toLocaleString("ja-JP")}ドル）です。`;
  }
  const { realized, net, newPrem, total, judgeTotal, cover, newProfit } = r;
  const qtyText = `既存${q0}枚・新規${q1}枚`;
  const items = [];

  items.push(statCard({
    name: "既存建玉の決済損益", value: signed(realized), sub: `当初の受取 − 反対売買の支払い（${usd(realized)}）`,
    suffix: realized < 0 ? "（損失）" : realized > 0 ? "（利益）" : "", suffixClass: realized < 0 ? "roll-loss" : "roll-profit",
    note: "既存のブルプットを反対売買で決済したときの損益です。（当初の受取プレミアム − 反対売買時の支払い額）× 既存の枚数。マイナスなら損失です。",
  }));
  items.push(statCard({
    name: "ローリング価格", value: signed(net), suffix: net >= 0 ? "（受取）" : "（支払い）",
    sub: `新規の受取${fmt(newPrem)} − 反対売買の支払い${fmt(q0 * b)}。当初の受取は含みません${q0 > 1 ? `（既存1枚あたり ${signed(net / q0)}）` : ""}`,
    note: "証券会社（サクソバンク）のローリング注文に表示される価格と同じ計算です。新規の受取プレミアム（新規1組の受取 × 新規の枚数）− 既存建玉の反対売買時の支払い（既存1組の支払い × 既存の枚数）。既存建玉の当初の受取プレミアムは含まれません。プラスなら受取、マイナスなら支払いです。",
  }));
  items.push(statCard({
    name: "ローリング価格＋当初の受取", value: signed(total), suffix: "（総合損益）", suffixClass: judgeClass(judgeTotal.level),
    sub: `新規を${xText}受け取った場合の通算：${judgeTotal.word}`,
    note: `ローリング価格に、既存建玉の当初の受取プレミアムを加えた価格で、新規の受取を利確割合（${xText}）だけ受け取った場合の通算です。これが総合損益です。\n総合損益 ＝ 当初の受取 − 反対売買の支払い ＋ 新規の受取 × 利確割合（${xText}）（${qtyText}の合計。100株あたり ${usd(total)}）。\nプラスなら利確、0なら損益0、マイナスなら損切です（今は「${judgeTotal.word}」）。ローリング後に残るのは新規建玉だけなので、新規の受取を何割利確するかで、損益が決まります。`,
  }));
  items.push(statCard({
    name: "損失の補えた割合",
    value: cover ? `${Math.round(cover.ratio * 1000) / 10}%` : "―",
    sub: cover
      ? (cover.remaining > 0 ? `新規の受取（${xText}）${fmt(newProfit)} ÷ 当初の損失${fmt(cover.loss)}。残りの損失 ${fmt(cover.remaining)}（${usd(-cover.remaining)}）` : `新規の受取（${xText}）${fmt(newProfit)} ÷ 当初の損失${fmt(cover.loss)}。全額を補えています`)
      : "既存建玉は損失なし（補う損失がありません）",
    note: "新規の受取プレミアムを利確割合で受け取ったとき、既存建玉の当初の損失（反対売買の支払い − 当初の受取）のうち、どれだけを補えたかの割合です。100%以上なら、損失を全額補えています。既存建玉が損失でない場合は、「―」です。",
  }));
  const keepRate = Math.round((1 - x) * 1000) / 1000; // 受取のうち、買い戻しに払う割合(例: 70%利確なら0.3)
  items.push(statCard({
    name: `新規1枚当たりの${Math.round(x * 100) / 10}割り利確指値`, value: fmt(r.newBuybackPerSpread),
    sub: `新規1組の受取${fmt(n)} × ${keepRate}。新規1組の利益${fmt(n * x)}${q1 > 1 ? `。新規${q1}枚の利益${fmt(newProfit)}` : ""}`,
    note: `ローリング後の新規建玉を、受取の${xText}の利益で利確するときの、買い戻しの指値（1組あたり）です。受取 ×（1−利確割合）＝ 受取 × ${keepRate}。`,
  }));
  if (mode === "detail") {
    items.push(statCard({
      name: "損益分岐点（満期時の株価）", value: r.breakEven === null ? "―" : fmt(r.breakEven), sub: r.breakEven === null ? r.breakEvenNote : "満期時にこの株価なら、通算損益が0です",
      note: "新規を満期まで持った場合に、通算損益が0になる満期時の株価です。新規の売りの権利行使価格 − 最大利益 ÷ 新規の枚数。",
    }));
  }
  els.summary.innerHTML = items.join("");
  els.resultNote.textContent = `金額は1株あたりで、${qtyText}の合計です（ ）内は100株あたりのドルです。${noteExtra}`;
  els.resultCard.hidden = false;
}

// ---- 満期時の通算損益のグラフ(詳細版) ----
function renderChart(r) {
  const newSell = num(els.newSell), newBuy = num(els.newBuy);
  const w = 640, h = 270, padL = 64, padR = 22, padT = 22, padB = 40;
  const width = newSell - newBuy;
  const pad = Math.max(width * 0.6, newSell * 0.02);
  let x0 = newBuy - pad, x1 = newSell + pad;
  if (itmPrice !== null) { x0 = Math.min(x0, itmPrice - pad * 0.3); x1 = Math.max(x1, itmPrice + pad * 0.3); }
  const yMax = Math.max(r.maxProfit, 0), yMin = Math.min(r.maxLoss, 0);
  const span = yMax - yMin || 1;
  const yTop = yMax + span * 0.14, yBot = yMin - span * 0.14;
  const X = (v) => padL + ((w - padL - padR) * (v - x0)) / (x1 - x0);
  const Y = (v) => padT + ((h - padT - padB) * (yTop - v)) / (yTop - yBot);
  const f = (v) => v.toFixed(1);
  const pts = [[x0, r.maxLoss], [newBuy, r.maxLoss], [newSell, r.maxProfit], [x1, r.maxProfit]];
  const line = pts.map(([sx, sy]) => `${f(X(sx))},${f(Y(sy))}`).join(" ");
  const area = `${line} ${f(X(x1))},${f(Y(0))} ${f(X(x0))},${f(Y(0))}`;
  const dollars = (v) => `${Math.round(v * 100) >= 0 ? "+" : "−"}${Math.abs(v * 100).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}ドル`;
  let svg = `<svg viewBox="0 0 ${w} ${h}" class="chart roll-chart-svg" role="img" aria-label="満期時の通算損益">`
    + `<defs><clipPath id="rollClipUp"><rect x="0" y="0" width="${w}" height="${f(Y(0))}"/></clipPath>`
    + `<clipPath id="rollClipDown"><rect x="0" y="${f(Y(0))}" width="${w}" height="${h}"/></clipPath></defs>`
    + `<polygon points="${area}" fill="var(--gA)" fill-opacity="0.22" clip-path="url(#rollClipUp)"/>`
    + `<polygon points="${area}" fill="var(--gC)" fill-opacity="0.22" clip-path="url(#rollClipDown)"/>`
    + `<line x1="${padL}" y1="${f(Y(0))}" x2="${w - padR}" y2="${f(Y(0))}" stroke="var(--muted)" stroke-width="1"/>`
    + `<text x="${padL - 6}" y="${f(Y(0) + 4)}" font-size="10.5" text-anchor="end" fill="var(--muted)">0</text>`
    + `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  // 最大利益・最大損失の目盛り
  svg += `<text x="${padL - 6}" y="${f(Y(r.maxProfit) + 4)}" font-size="10.5" text-anchor="end" fill="var(--fg)">${dollars(r.maxProfit)}</text>`;
  svg += `<text x="${padL - 6}" y="${f(Y(r.maxLoss) + 4)}" font-size="10.5" text-anchor="end" fill="var(--fg)">${dollars(r.maxLoss)}</text>`;
  // 権利行使価格(縦の点線)
  const vline = (v, label, color, dy) => `<line x1="${f(X(v))}" y1="${padT}" x2="${f(X(v))}" y2="${h - padB}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3"/>`
    + `<text x="${f(X(v))}" y="${h - padB + dy}" font-size="10.5" text-anchor="middle" fill="var(--fg)">${label}</text>`;
  svg += vline(newBuy, `買 ${fmt(newBuy)}`, "var(--muted)", 14);
  svg += vline(newSell, `売 ${fmt(newSell)}`, "var(--muted)", 14);
  if (r.breakEven !== null) {
    svg += `<circle cx="${f(X(r.breakEven))}" cy="${f(Y(0))}" r="4.5" fill="var(--fg)"/>`
      + `<text x="${f(X(r.breakEven))}" y="${f(Y(0) - 9)}" font-size="11" font-weight="700" text-anchor="middle" fill="var(--fg)">損益分岐点 ${fmt(r.breakEven)}</text>`;
  }
  if (itmPrice !== null) {
    svg += `<line x1="${f(X(itmPrice))}" y1="${padT}" x2="${f(X(itmPrice))}" y2="${h - padB}" stroke="var(--gradOrange)" stroke-width="1.6"/>`
      + `<text x="${f(X(itmPrice))}" y="${padT - 6}" font-size="10.5" font-weight="700" text-anchor="middle" fill="var(--gradOrange)">現在値 ${fmt(itmPrice)}</text>`;
  }
  svg += `<text x="${w - padR}" y="${h - 4}" font-size="10.5" text-anchor="end" fill="var(--muted)">満期時の株価 →</text></svg>`;
  els.chart.innerHTML = svg;
  els.chartNote.textContent = "緑＝通算でプラス、赤＝マイナスの範囲です。新規を満期まで持った場合のグラフで、新規を途中で利確する場合は、上の総合損益を見てください。";
  els.chartCard.hidden = false;
}

// ---- ITM確率の目安(銘柄の株価データが必要。任意) ----
async function runItm() {
  const setStatus = (msg, isErr = false) => { els.itmStatus.textContent = msg; els.itmStatus.style.color = isErr ? "var(--gC)" : ""; };
  els.itmSummary.innerHTML = "";
  els.itmNote.textContent = "";
  const symbol = els.ticker.value.trim().toUpperCase();
  const expiry = els.expiry.value;
  const K = num(els.newSell);
  if (!symbol) { setStatus("ティッカーを入力してください。", true); return; }
  if (!expiry) { setStatus("新規の満期日を入力してください。", true); return; }
  if (!(K > 0)) { setStatus("新規の売りの権利行使価格を入力してください。", true); return; }
  els.itmBtn.disabled = true;
  setStatus("取得中…");
  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const closes = data.closes, dates = data.dates;
    const price = closes[closes.length - 1];
    const asOf = dates[dates.length - 1];
    const exp = previousTradingDay(expiry);
    const days = tradingDaysBetween(asOf, exp);
    if (days < 1) throw new Error(`満期日が、最新の終値の日（${asOf}）以前です。`);
    if (days >= closes.length - 1) throw new Error("満期までの営業日数が、取得できた株価データより長すぎます。");
    const hv = computeHv(closes, days);
    if (hv === null) throw new Error("HVを計算するためのデータが足りません。");
    const th = hvTheory({ price, strike: K, depthDollar: 0, itmWhen: "below", days, hv });
    if (!th) throw new Error("理論上の確率を計算できませんでした。");
    // 過去の実績: 直近1年(253営業日)で、同じ比率・同じ営業日数のブルプット(売り)がITMになった割合
    const n1y = Math.min(closes.length, 253);
    const pc = closes.slice(-n1y), pd = dates.slice(-n1y);
    const an = computeItmAnalysis(pc, { ratio: K / price, itmWhen: "below", window: days, group: "sell", depthPct: 0 }, pd);
    const actTouch = an.entryCount ? an.overallItmProb : null;
    const actExp = an.entryCount ? an.dayProb[days - 1] ?? null : null;
    itmPrice = price;
    const dist = th.distancePct;
    const items = [
      statCard({ name: "最新の終値", value: fmt(price), sub: `${data.symbol}（${asOf}）`, note: "取得できた最新営業日の終値です。グラフに、現在値の線として表示します。" }),
      statCard({
        name: "新規の売りの権利行使価格", value: `${dist >= 0 ? "+" : ""}${pct(dist)}`,
        sub: `現在値からの位置。${fmt(K)}・${Math.abs(th.zScore).toFixed(2)}σ（${th.zScore >= 0 ? "OTM側" : "ITM側"}）`,
        note: "新規の売りの権利行使価格が、最新の終値から何%離れているか、またそれが満期までのHVから見て何σ分の距離かです。σが大きいほど、ITMになりにくい水準です。",
      }),
      statCard({
        name: "HV", value: pct(hv), suffix: `（直近${days}営業日）`, sub: `満期（${exp}）までの営業日数と同じ長さ`,
        note: `新規の満期日までの営業日数（${days}営業日）と同じ長さの期間で測った、過去の実際の値動きの大きさ（年率）です。`,
      }),
      statCard({
        name: "満期時ITM率", value: pct(th.probItmAtExpiry), suffix: "（HV換算）", sub: `理論上の確率。期間中に一度でも届く目安 約${pct(th.probTouch, 0)}`,
        note: "HVから、満期時に株価が新規の売りの権利行使価格を下回っている確率を、正規分布の近似で求めたものです。「期間中に一度でも届く」目安は、毎日の終値だけを見る実績よりやや多めに出ます。株価の平均的な上昇・下落はないと仮定した単純な近似です。将来を保証するものではありません。",
      }),
      statCard({
        name: "ITM発生率", value: actTouch === null ? "―" : pct(actTouch), suffix: "（過去の実績）",
        sub: actTouch === null ? "データ不足" : `直近1年の${an.entryCount}件のうち、判定期間内に一度でも届いた割合。満期時は${actExp === null ? "―" : pct(actExp)}`,
        note: "直近1年の各営業日を、エントリー日とみなし、同じ比率の売りの権利行使価格が、判定期間（満期までの営業日数）のあいだに、毎日の終値で一度でもITMになった割合です（分析ページの「分析結果」と同じ計算）。判定期間が重なるため、独立した試行は、件数÷営業日数の回数分しかありません。",
      }),
    ];
    els.itmSummary.innerHTML = items.join("");
    els.itmNote.textContent = "HVは過去の値動きで、市場が織り込む将来の変動（IV）ではありません。理論上の確率は、単純な近似の目安です。実績は、調べた期間の値動きしだいです。";
    setStatus(`${data.symbol} の${closes.length}日分の終値を取得しました`);
    render();
  } catch (e) {
    setStatus(`取得または計算に失敗しました: ${e.message}`, true);
  } finally {
    els.itmBtn.disabled = false;
  }
}

// ---- 起動 ----
function init() {
  initThemeBar("theme-bar");
  restore();
  const onInput = () => { save(); render(); };
  for (const k of INPUT_KEYS) els[k].addEventListener("input", onInput);
  els.modeSimple.addEventListener("click", () => { mode = "simple"; save(); applyMode(); });
  els.modeDetail.addEventListener("click", () => { mode = "detail"; save(); applyMode(); });
  els.itmBtn.addEventListener("click", () => { save(); runItm(); });
  els.ticker.addEventListener("keydown", (e) => { if (e.key === "Enter") { save(); runItm(); } });
  applyMode();
}
init();
