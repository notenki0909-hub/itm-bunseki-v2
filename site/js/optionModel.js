// オプション価格の理論値(Black-Scholes)と、ストレステスト(株価・IVが動いたときの現在値)の計算(純粋関数。DOM・fetch非依存)。
// 単純化した仮定: 金利0・配当なし、満期までの時間は「営業日数÷252」(年)。株価が対数正規分布に従う前提の近似であり、
// 実際の価格とはずれる(スキュー・金利・配当・流動性など)。あくまで目安として使う。
import { normalCdf } from "./calc.js";

export const TRADING_DAYS_PER_YEAR = 252;

/**
 * ヨーロピアンオプションの理論価格(金利0・配当なし)。
 * @param {'put'|'call'} kind
 * @param {number} S 株価
 * @param {number} K 権利行使価格
 * @param {number} T 満期までの年数
 * @param {number} sigma IV(年率。0.3=30%)
 */
export function bsPrice(kind, S, K, T, sigma) {
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, kind === "call" ? S - K : K - S);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / v;
  const d2 = d1 - v;
  return kind === "call"
    ? S * normalCdf(d1) - K * normalCdf(d2)
    : K * normalCdf(-d2) - S * normalCdf(-d1);
}

/**
 * 売りポジションの買い戻しに必要な価格(=現在値)。
 * 単体は売り脚のみ。スプレッド(ブルプット/ベアコール)は、売り脚の価格−買い脚の価格(買い脚は買い建て側)。
 * @param {{kind:'put'|'call', S:number, strikeSell:number, strikeBuy:number|null, T:number, ivSell:number, ivBuy:number}} p
 */
export function positionValue({ kind, S, strikeSell, strikeBuy, T, ivSell, ivBuy }) {
  const sell = bsPrice(kind, S, strikeSell, T, ivSell);
  if (strikeBuy === null) return sell;
  return sell - bsPrice(kind, S, strikeBuy, T, ivBuy);
}

/**
 * 入力した受取プレミアム(スプレッドは差し引き後の正味)に合う、全体のIV(売り脚・買い脚とも同じIV)を逆算する。
 * IVを低い方から探して、最初にモデル価格が受取プレミアムに届くところを二分法で詰める。
 * (スプレッドの価格はIVが非常に高いと下がるため、低い方の解を採用する。)
 * 見つからない(受取プレミアムがモデルで再現できない)ときはnull。
 */
export function solveFlatIv({ kind, S, strikeSell, strikeBuy, T, premium }) {
  if (!(premium > 0) || !(T > 0)) return null;
  const f = (iv) => positionValue({ kind, S, strikeSell, strikeBuy, T, ivSell: iv, ivBuy: iv });
  let lo = 0.01;
  if (f(lo) >= premium) return lo;
  let hi = null;
  for (let iv = 0.02; iv <= 4; iv += 0.01) {
    if (f(iv) >= premium) { hi = iv; lo = iv - 0.01; break; }
  }
  if (hi === null) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= premium) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 計算に使うIV(売り脚・買い脚)を決める。売り脚のIVの入力があればそれ(買い脚は入力があればそれ、なければ売り脚と同じ)、
 * なければ入力した受取プレミアムに合う全体のIVを逆算する。決められないときはnull。
 * @returns {null|{source:'input'|'calibrated', sellIv:number, buyIv:number}}
 */
export function resolveIvs({ kind, price, strikeSell, strikeBuy, T, premium, ivSell, ivBuy }) {
  if (ivSell !== null && ivSell > 0) {
    return { source: "input", sellIv: ivSell, buyIv: ivBuy !== null && ivBuy > 0 ? ivBuy : ivSell };
  }
  const iv = solveFlatIv({ kind, S: price, strikeSell, strikeBuy, T, premium });
  return iv === null ? null : { source: "calibrated", sellIv: iv, buyIv: iv };
}

/**
 * ストレステスト: 株価がshockPctだけ動き、IVがivUpだけ上がったときの現在値と損益を、表にして返す。
 *
 * @param {object} p
 * @param {'put'|'call'} p.kind プット系(株価下落が不利)かコール系(株価上昇が不利)か
 * @param {number} p.price 現在の株価
 * @param {number} p.strikeSell 売り建て側の権利行使価格
 * @param {number|null} p.strikeBuy 買い建て側の権利行使価格(単体はnull)
 * @param {number} p.days 満期までの営業日数
 * @param {number|null} p.premium 入力した受取プレミアム(未入力ならnull)
 * @param {number|null} p.ivSell 入力した売り脚のIV(年率の割合。未入力ならnull)
 * @param {number|null} p.ivBuy 入力した買い脚のIV(未入力ならnull。売り脚と同じとして計算)
 * @param {number[]} p.shocks 株価の変化(割合。例: [-0.05,-0.1])。0は「いま」
 * @param {number[]} p.ivUps IVの上昇幅(割合の絶対値。例: [0, 0.1])
 * @returns {null|{rows:object[], meta:object}} 計算できないときはnull
 */
export function stressTest({ kind, price, strikeSell, strikeBuy, days, premium, ivSell, ivBuy, shocks, ivUps }) {
  const T = days / TRADING_DAYS_PER_YEAR;
  if (!(price > 0) || !(strikeSell > 0) || !(T > 0)) return null;
  const ivs = resolveIvs({ kind, price, strikeSell, strikeBuy, T, premium, ivSell, ivBuy });
  if (!ivs) return null;
  const { source, sellIv, buyIv } = ivs;
  const value = (S, up) => positionValue({ kind, S, strikeSell, strikeBuy, T, ivSell: sellIv + up, ivBuy: buyIv + up });
  const v0 = value(price, 0);
  const received = premium !== null && premium > 0 ? premium : v0;
  const rows = shocks.map((shock) => {
    const S = price * (1 + shock);
    return {
      shock,
      price: S,
      cells: ivUps.map((up) => {
        const v = value(S, up);
        return { ivUp: up, value: v, pnl: received - v };
      }),
    };
  });
  const width = strikeBuy === null ? null : Math.abs(strikeSell - strikeBuy);
  return {
    rows,
    meta: { source, ivSell: sellIv, ivBuy: buyIv, v0, received, premiumInput: premium, width, maxLoss: width === null ? null : width - received },
  };
}

/**
 * IV÷HVの倍率から、市場の見込み(IV)が、過去の値動き(HV)より高めか低めかを判定する(売り手の目線)。
 * IVが高いほど、オプションの価格(プレミアム)も高くなる(受け取る額は多いが、市場が大きな動きを見込んでいるのでリスクも高い)。
 * 目安の基準(このツールの簡易的な基準): 1.2倍以上=高め、0.8倍以下=低め、その間=同程度。
 * 一般にIVはHVより少し高めになりやすいため、「同程度」の幅を持たせている。
 * @returns {{level:'rich'|'fair'|'cheap', word:string, phrase:string}}
 */
export const IV_HV_RICH = 1.2;
export const IV_HV_CHEAP = 0.8;
export function judgeIvHv(ratio) {
  if (ratio >= IV_HV_RICH) return { level: "rich", word: "高め", phrase: "過去の値動き(HV)より、市場の見込み(IV)が高め（プレミアム価格も高めになります）" };
  if (ratio <= IV_HV_CHEAP) return { level: "cheap", word: "低め", phrase: "過去の値動き(HV)より、市場の見込み(IV)が低め（プレミアム価格も低めになります）" };
  return { level: "fair", word: "同程度", phrase: "過去の値動き(HV)と、市場の見込み(IV)は同程度（プレミアム価格も標準的です）" };
}

/**
 * IVの変化×時間の経過の表(株価は今の水準のまま動かない場合)。
 * 縦=IVの変化(全体を一律に動かす。単位は割合の絶対値。-0.1=−10ポイント)、横=満期までの残り営業日数(いま、2週間前、3日前など)。
 * 各マスは、いまのポジションを買い戻すのに必要な価格(現在値)と、損益(受取額−現在値)。
 * 売り脚IVが下がって0以下になるような行は出さない(最小でIV 2%を下回る行は除く)。
 *
 * @param {object} p
 * @param {'put'|'call'} p.kind
 * @param {number} p.price 現在の株価(動かないものとする)
 * @param {number} p.strikeSell 売り建て側の権利行使価格
 * @param {number|null} p.strikeBuy 買い建て側の権利行使価格(単体はnull)
 * @param {number} p.days いまの満期までの営業日数
 * @param {number|null} p.premium 入力した受取プレミアム(未入力ならnull)
 * @param {number|null} p.ivSell 入力した売り脚のIV(割合。未入力ならnull)
 * @param {number|null} p.ivBuy 入力した買い脚のIV(未入力ならnull)
 * @param {number[]} p.ivChanges IVの変化(割合の絶対値。例: [-0.1, 0, 0.1])
 * @param {number[]} p.remains 満期までの残り営業日数(例: [30, 10, 3])
 * @returns {null|{rows:object[], meta:object}} 計算できないときはnull
 */
export function ivTimeTable({ kind, price, strikeSell, strikeBuy, days, premium, ivSell, ivBuy, ivChanges, remains }) {
  const T = days / TRADING_DAYS_PER_YEAR;
  if (!(price > 0) || !(strikeSell > 0) || !(T > 0)) return null;
  const ivs = resolveIvs({ kind, price, strikeSell, strikeBuy, T, premium, ivSell, ivBuy });
  if (!ivs) return null;
  const { source, sellIv, buyIv } = ivs;
  const value = (rem, up) => positionValue({
    kind, S: price, strikeSell, strikeBuy, T: rem / TRADING_DAYS_PER_YEAR, ivSell: sellIv + up, ivBuy: buyIv + up,
  });
  const v0 = value(days, 0);
  const received = premium !== null && premium > 0 ? premium : v0;
  const rows = ivChanges
    .filter((up) => Math.min(sellIv + up, buyIv + up) >= 0.02)
    .map((up) => ({
      ivUp: up,
      ivSell: sellIv + up,
      cells: remains.map((rem) => {
        const v = value(rem, up);
        return { remain: rem, value: v, pnl: received - v };
      }),
    }));
  const width = strikeBuy === null ? null : Math.abs(strikeSell - strikeBuy);
  return { rows, meta: { source, ivSell: sellIv, ivBuy: buyIv, v0, received, premiumInput: premium, width } };
}
