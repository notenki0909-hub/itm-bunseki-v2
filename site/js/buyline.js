// 買いページの計算(純粋関数のみ。DOM・fetchに依存しない)。
//  ・ATR(Wilder。Pine Trend Trackerと同じ式)
//  ・固定の手仕舞い線: 買った日の終値 ∓ 倍率×ATR。動かさず、トレンド判定も使わない(Pineは「ここまで下がったら手仕舞う」の目安としてだけ使う)
//  ・買う条件(最低条件と同じ考え方: 1〜7営業日前との比較で、X%以上の下落(または上昇)が1日以上)の下落率Xごとに、
//    この銘柄の過去の結果を求める(線で手仕舞い、または満期の早い方)
// 検証(検証/買い向きバックテスト)と同じ前提: オプション価格はBlack-Scholes(金利0・配当なし・手数料なし)、
// IVは実際の値ではなく「直近20営業日のHV×1.15(下限10%)」の仮定。
import { bsPrice, solveFlatIv, TRADING_DAYS_PER_YEAR } from "./optionModel.js";

export const BUY_X_LIST = [1, 2, 3, 5, 7, 10];      // 比べる下落率(%)
export const BUY_ATR_MULTS = [2, 3, 4, 5];           // 比べるATR倍率
export const DEFAULT_ATR_MULT = 2;                   // 初期値(ユーザー指示で、Pineの初期値3から2に変更。2026-11-23)
// 買い系スプレッド(ブルコール・ベアプット)の価値: 買い側(権利行使価格K)−売り側(K2)。K2=nullなら単体の買い。
export function legWorth(kind, S, K, K2, T, iv, r = 0) {
  const a = bsPrice(kind, S, K, T, iv, r);
  return K2 > 0 ? a - bsPrice(kind, S, K2, T, iv, r) : a;
}
// 満期時の価値(本質価値)。スプレッドは、買い側−売り側
export function legIntrinsic(kind, S, K, K2) {
  const f = (k) => (kind === "call" ? Math.max(0, S - k) : Math.max(0, k - S));
  return K2 > 0 ? f(K) - f(K2) : f(K);
}
export const ATR_PERIOD = 10;                        // ATRの期間(Pineの初期値。20でもほぼ同じ結果だった)
export const IV_HV_FACTOR = 1.15;                    // 過去の検証用のIVの仮定: HV×1.15

// ATR(Wilder)。最初のperiod-1個はNaN
export function computeAtr(highs, lows, closes, period = ATR_PERIOD) {
  const n = closes.length;
  const tr = [];
  for (let i = 0; i < n; i++) {
    tr.push(i === 0 ? highs[i] - lows[i] : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atr = [];
  for (let i = 0; i < n; i++) {
    if (i < period - 1) atr.push(NaN);
    else if (i === period - 1) atr.push(tr.slice(0, period).reduce((a, b) => a + b, 0) / period);
    else atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
  }
  return atr;
}

// 直近20営業日のHV(年率)。iはその日の位置
function hvAt(c, i, w = 20) {
  let sum = 0;
  const r = [];
  for (let k = i - w + 1; k <= i; k++) { const x = Math.log(c[k] / c[k - 1]); r.push(x); sum += x; }
  const m = sum / w;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (w - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}
export const assumedIvAt = (c, i) => Math.max(0.10, hvAt(c, i) * IV_HV_FACTOR);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function stats(xs) {
  if (!xs.length) return null;
  return { mean: mean(xs), median: median(xs), win: xs.filter((v) => v > 0).length / xs.length, worst: Math.min(...xs) };
}

// 固定の線の価格。call=買った日の終値の下、put=上
export function fixedLinePrice(price, atr, mult, kind) {
  return kind === "call" ? price - mult * atr : price + mult * atr;
}

/**
 * 買う条件の下落率(または上昇率)Xごとの、この銘柄の過去の結果。
 * @param {object} p
 * @param {number[]} p.closes 古い順の終値
 * @param {number[]} p.highs
 * @param {number[]} p.lows
 * @param {'call'|'put'} p.kind 買うオプションの種類(callなら、株価の上昇が利益。線は買った日の終値の下)
 * @param {number} p.ratio 権利行使価格＝買った日の終値×ratio
 * @param {number|null} p.ratio2 スプレッドの売り側の権利行使価格＝買った日の終値×ratio2(単体はnull)
 * @param {number} p.window 満期までの営業日数
 * @param {number[]} p.xList 比べる率(%)。nullを含めると「毎日買う(条件なし)」の基準も出す
 * @param {'down'|'up'} p.direction 買う条件の方向(1〜7営業日前との比較)
 * @param {number} p.mult ATR倍率(固定の線)
 * @returns {{x:number|null, n:number, trials:number, stock:object|null, opt:object|null, lineRate:number, avgDays:number, optHoldMean:number|null}[]}
 */
export function computeBuyStudy({ closes, highs, lows, kind, ratio, ratio2 = null, window, xList, direction, mult, atrPeriod = ATR_PERIOD }) {
  const n = closes.length;
  const atr = computeAtr(highs, lows, closes, atrPeriod);
  const first = Math.max(25, atrPeriod);
  const dirOk = (i, x) => {
    if (x === null) return true;
    for (let k = 1; k <= 7; k++) {
      if (i - k < 0) continue;
      const ch = closes[i] / closes[i - k] - 1;
      if (direction === "down" ? ch <= -x / 100 : ch >= x / 100) return true;
    }
    return false;
  };
  const sign = kind === "call" ? 1 : -1; // 原資産の動きを、買い方向の損益に直す
  const T = (j) => (window - j) / TRADING_DAYS_PER_YEAR;
  const rows = [];
  for (const x of xList) {
    const stockR = [];
    const optR = [];
    const holdR = [];
    const days = [];
    let lineHits = 0;
    for (let i = first; i < n; i++) {
      if (Number.isNaN(atr[i]) || !dirOk(i, x)) continue;
      const S0 = closes[i];
      const K = S0 * ratio;
      const K2 = ratio2 > 0 ? S0 * ratio2 : null;
      const prem = legWorth(kind, S0, K, K2, window / TRADING_DAYS_PER_YEAR, assumedIvAt(closes, i));
      if (!(prem > 0)) continue;
      const L = fixedLinePrice(S0, atr[i], mult, kind);
      let exit = -1;
      let byLine = false;
      for (let j = i + 1; j < n && j <= i + window; j++) {
        if (kind === "call" ? closes[j] <= L : closes[j] >= L) { exit = j; byLine = true; break; }
        if (j === i + window) exit = j;
      }
      if (exit < 0) continue; // データが足りず、まだ決着していない
      const Sx = closes[exit];
      const intrinsic = legIntrinsic(kind, Sx, K, K2);
      const val = byLine ? legWorth(kind, Sx, K, K2, T(exit - i), assumedIvAt(closes, exit)) : intrinsic;
      stockR.push(sign * (Sx / S0 - 1));
      optR.push(val / prem - 1);
      days.push(exit - i);
      if (byLine) lineHits++;
      if (i + window < n) {
        const Se = closes[i + window];
        holdR.push(legIntrinsic(kind, Se, K, K2) / prem - 1);
      }
    }
    rows.push({
      x, n: optR.length, trials: Math.max(1, Math.round(optR.length / window)),
      stock: stats(stockR), opt: stats(optR),
      lineRate: optR.length ? lineHits / optR.length : 0,
      avgDays: mean(days) ?? 0,
      optHoldMean: mean(holdR),
    });
  }
  return rows;
}

/**
 * 固定の線を、ATR倍率ごとに並べた表(いまの株価を基準)。線に届いたときの、株・オプションの損失と、資金の2%に収まる数量。
 * オプションの価値は、満期までの日数・IVはそのままで、株価だけが線に動いた(時間の経過なし)としたBlack-Scholesの目安。
 * @param {object} p {price, atr, kind, strike, strike2(スプレッドの売り側。単体はnull), days, premium, iv(年率。nullならpremiumから逆算), capital(null可), mults}
 */
export function computeFixedLineTable({ price, atr, kind, strike, strike2 = null, days, premium, iv, capital, contracts = null, mults = BUY_ATR_MULTS, rate = 0 }) {
  const T = days / TRADING_DAYS_PER_YEAR;
  const val = (S, v) => legWorth(kind, S, strike, strike2, T, v, rate); // 単体、またはスプレッド(買い側−売り側)の価値
  let useIv = iv;
  let ivSource = "input";
  if (!(useIv > 0) && premium > 0) {
    useIv = solveFlatIv({ kind, S: price, strikeSell: strike, strikeBuy: strike2, T, premium, r: rate });
    ivSource = "calibrated";
  }
  const pay = premium > 0 ? premium : (useIv > 0 ? val(price, useIv) : null);
  const riskMoney = capital > 0 ? capital * 0.02 : null;
  // 資金の2%の損切り: 発注する枚数(未入力なら1枚)で、オプションの損失が資金の2%になる株価の位置(線)。
  // 全損しても2%に収まる(1株あたりの損失の上限が、支払いプレミアム以上)ときは、2%の線はない。
  let riskRow = null;
  if (riskMoney !== null && useIv > 0 && pay > 0 && atr > 0) {
    const nCon = contracts > 0 ? contracts : 1;
    const allowed = riskMoney / (100 * nCon);
    if (allowed < pay) {
      const f = (L) => pay - val(L, useIv) - allowed; // 損失が上限を超えているほど正
      // いまの価格で、すでに損失が上限を超えているとき(入力したIVの理論価格が、支払いプレミアムより、ずっと低いとき)
      const already = f(price) > 0;
      let lo = kind === "call" ? price * 0.05 : price;
      let hi = kind === "call" ? price : price * 5;
      for (let i = 0; i < (already ? 0 : 80); i++) {
        const mid = (lo + hi) / 2;
        if (kind === "call") { if (f(mid) > 0) lo = mid; else hi = mid; }
        else if (f(mid) > 0) hi = mid; else lo = mid;
      }
      const L2 = kind === "call" ? Math.min(price, (lo + hi) / 2) : Math.max(price, (lo + hi) / 2);
      const move2 = Math.abs(price - L2);
      riskRow = already ? { isRisk: true, alreadyOver: true, contracts: nCon, nowLoss: pay - val(price, useIv) } : {
        isRisk: true, contracts: nCon, mult: move2 / atr, line: L2, movePct: L2 / price - 1, moveAmount: move2,
        value: val(L2, useIv), optLoss: allowed, optLossPct: allowed / pay,
        maxContracts: nCon, maxShares: move2 > 0 ? Math.floor(riskMoney / move2) : null,
      };
    }
  }
  return {
    iv: useIv > 0 ? useIv : null, ivSource, premium: pay, riskRow,
    rows: mults.map((m) => {
      const line = fixedLinePrice(price, atr, m, kind);
      const move = Math.abs(price - line);
      const value = useIv > 0 && line > 0 ? val(line, useIv) : null;
      const optLoss = value !== null && pay !== null ? Math.max(0, pay - value) : null; // 1株あたり(オプション)
      return {
        mult: m, line, movePct: line / price - 1, moveAmount: move,
        value, optLoss, optLossPct: optLoss !== null && pay > 0 ? optLoss / pay : null,
        maxContracts: riskMoney !== null && optLoss > 0 ? Math.floor(riskMoney / (optLoss * 100)) : null,
        maxShares: riskMoney !== null && move > 0 ? Math.floor(riskMoney / move) : null,
      };
    }),
  };
}
