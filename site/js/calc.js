// ITM分析の計算ロジック（純粋関数のみ。DOM・fetchに依存しない）
// 将来オプションタイプや判定基準を追加・変更する場合はこのファイルだけを触ればよい設計。

// オプションタイプごとの初期値。
// ratio: 権利行使価格 = 終値 × ratio
// itmWhen: 'below'(終値がストライクを下回るとITM=プット系) / 'above'(上回るとITM=コール系)
export const OPTION_TYPES = {
  put_sell:  { label: "プット売", ratio: 0.90, itmWhen: "below" },
  call_sell: { label: "コール売", ratio: 1.20, itmWhen: "above" },
  call_buy:  { label: "コール買", ratio: 1.05, itmWhen: "above" },
  put_buy:   { label: "プット買", ratio: 0.95, itmWhen: "below" },
};

export const WINDOW_OPTIONS = [10, 20, 30, 60, 90, 120, 150];
export const DEFAULT_WINDOW = 30;

// 集計期間（「過去」とみなす営業日数）の選択肢。1営業日=1本のデータ。
export const PERIOD_OPTIONS = [
  { label: "6ヶ月", days: 130 },
  { label: "1年", days: 253 },
  { label: "1.6年", days: 400 },
  { label: "2年", days: 500 },
  { label: "3年", days: 750 },
];
export const DEFAULT_PERIOD_DAYS = 253;

export const MOMENTUM_LOOKBACK_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
export const DEFAULT_MOMENTUM_LOOKBACK = 7;

// 「変動幅の統計」で表示する期間の一覧。3か月/半年/1年は営業日換算(1年=253営業日基準)。
export const VOLATILITY_PERIODS = [
  { label: "1営業日", days: 1 },
  { label: "5営業日", days: 5 },
  { label: "11営業日(半月)", days: 11 },
  { label: "22営業日(1か月)", days: 22 },
  { label: "3か月", days: 63 },
  { label: "半年", days: 126 },
  { label: "1年", days: 253 },
];
// 「直近1年の変動幅(額)」の対象範囲(営業日数)。
export const RECENT_VOLATILITY_WINDOW = 253;

/**
 * 指定した営業日数(days)だけ離れた2点間の騰落率を、取得済みの全データ(closes)から
 * ローリングウィンドウですべて求め、絶対値の平均・最大上昇率・最大下落率を返す。
 * 符号は無視して絶対値で平均するため、「その期間でどれくらい値が動きやすいか」の指標になる
 * (上昇・下落のどちらかに偏った平均ではない)。
 * あわせて、各ウィンドウ(開始日〜days営業日後)の内側での「安値から高値への最大上昇」
 * (maxRunUpPct)と「高値から安値への最大下落=ドローダウン」(maxDrawdownPct、負の値)も、
 * 全ウィンドウの中での最大値として返す。始点→終点の騰落率(maxRisePct/maxFallPct)と違い、
 * 途中でいったん動いて戻った分も拾える。
 * @param {number[]} closes
 * @param {number} days
 * @returns {{avgAbsPct:number, maxRisePct:number, maxFallPct:number,
 *            maxRunUpPct:number, maxDrawdownPct:number, count:number}|null}
 */
export function computeVolatilityStats(closes, days) {
  if (!Array.isArray(closes)) return null;
  const n = closes.length;
  if (n <= days) return null;
  let sumAbs = 0;
  let count = 0;
  let maxRise = -Infinity;
  let maxFall = Infinity;
  let maxRunUp = 0;
  let maxDrawdown = 0;
  for (let i = 0; i + days < n; i++) {
    const c0 = closes[i];
    const c1 = closes[i + days];
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const change = c1 / c0 - 1;
    sumAbs += Math.abs(change);
    count++;
    if (change > maxRise) maxRise = change;
    if (change < maxFall) maxFall = change;

    let peak = c0;
    let trough = c0;
    for (let k = 1; k <= days; k++) {
      const c = closes[i + k];
      if (!(c > 0)) continue;
      if (c > peak) peak = c;
      else if (c / peak - 1 < maxDrawdown) maxDrawdown = c / peak - 1;
      if (c < trough) trough = c;
      else if (c / trough - 1 > maxRunUp) maxRunUp = c / trough - 1;
    }
  }
  if (count === 0) return null;
  return {
    avgAbsPct: sumAbs / count, maxRisePct: maxRise, maxFallPct: maxFall,
    maxRunUpPct: maxRunUp, maxDrawdownPct: maxDrawdown, count,
  };
}

/**
 * 「直近1年の変動幅(額)」を計算する。終点(end)が直近recentWindow営業日以内に
 * 収まるウィンドウだけに絞って、始点との差額(絶対値)を平均する。
 * 始点がrecentWindowより前のデータにまたがることはある(例えば1年(253営業日)の
 * 期間を見るには、終点だけでなく253営業日分遡った始点のデータも必要なため)。
 * @param {number[]} closes
 * @param {number} days
 * @param {number} [recentWindow]
 * @returns {{avgAbsAmount:number, count:number}|null}
 */
export function computeRecentVolatilityAmount(closes, days, recentWindow = RECENT_VOLATILITY_WINDOW) {
  if (!Array.isArray(closes)) return null;
  const n = closes.length;
  if (n <= days) return null;
  const endFrom = Math.max(days, n - recentWindow);
  let sumAbs = 0;
  let count = 0;
  for (let end = endFrom; end < n; end++) {
    const start = end - days;
    const c0 = closes[start];
    const c1 = closes[end];
    if (!(c0 > 0) || !(c1 > 0)) continue;
    sumAbs += Math.abs(c1 - c0);
    count++;
  }
  if (count === 0) return null;
  return { avgAbsAmount: sumAbs / count, count };
}

// 判定バッジの7段階しきい値。表示中の「期間内ITM確率」と矛盾しないよう、
// バッジも同じ overallItmProb（有利方向への確率に変換した値）から直接算出する。
// オプション売りは「利益は限定的・損失は相対的に大きい」非対称な構造のため、
// 損益分岐点となる勝率は50%よりかなり高くなるのが一般的。有利確率50%を
// 「ほぼ最悪」の位置に置き、最も不利な段階を最悪(最終段階)とする。
// 売り系は「勝率は最低85%は欲しい」というユーザー基準に合わせ、買い系より
// 厳しめのしきい値を使う(90%未満はもう「熱」ではなく「好機」、85%未満は
// 「可もなく不可もなく」)。「ITM」ラベルは廃止し、60%未満を一律「大ピンチ」とする。
const BADGE_PROB_THRESHOLDS = {
  sell: [0.95, 0.90, 0.85, 0.80, 0.70, 0.60],
  buy:  [0.95, 0.85, 0.75, 0.65, 0.55, 0.50],
};
export const BADGE_LABELS = {
  sell: ["激熱", "熱", "好機", "可もなく不可もなく", "ひやひや", "ピンチ", "大ピンチ"],
  buy:  ["激熱", "熱", "好機", "ITM", "OTM", "ピンチ", "大ピンチ"],
};

// 「有利方向への確率」を0(最も有利)〜6(最も不利)の7段階に変換する。総合判定
// バッジが使う(営業日ごとのITM確率チャート・エントリー日ごとのヒートマップは、
// 別のしきい値(絶対値ベース)を使っており、この関数とは独立している)。
// 売り/買いでしきい値が異なるため、groupを指定する(省略時はsell扱い)。
export function favorableProbToLevel(favorableProb, group) {
  if (favorableProb === null || favorableProb === undefined || Number.isNaN(favorableProb)) return null;
  const thresholds = BADGE_PROB_THRESHOLDS[group] || BADGE_PROB_THRESHOLDS.sell;
  for (let i = 0; i < thresholds.length; i++) {
    if (favorableProb >= thresholds[i]) return i;
  }
  return thresholds.length; // 6 = 最下段(ピンチ/大ピンチ)
}

/**
 * @param {number[]} closes 古い順の終値配列
 * @param {{ratio:number, itmWhen:'below'|'above', window:number, group:'sell'|'buy', depthPct?:number}} params
 *   depthPct: 権利行使価格から何割(例0.03=3%)以上深いITMを「ITM」とみなすか。0または省略なら、
 *   従来どおり権利行使価格を超えた(下回った)時点でITMとみなす。
 * @param {string[]} [dates] closesと同じ並びの日付文字列(YYYY-MM-DD)。渡すとperEntryに日付が入る
 * @returns {{
 *   entryCount:number,
 *   itmEntryCount:number,
 *   totalItmDays:number,
 *   overallItmProb:number|null,
 *   dayProb:(number|null)[],
 *   badge:string,
 *   badgeLevel:number|null,
 *   perEntry:{date:string|null, itmDaysInWindow:number, maxDepthPct:number}[]
 *     maxDepthPct: 判定期間内の終値が権利行使価格から最も深く入った割合(0=一度もITMにならなかった)
 *     maxOtmPct: 逆に、権利行使価格から最も深くOTM(ITMの反対側)になった割合(0=一度もOTMにならなかった)
 *     maxDepthDay/maxOtmDay(と、その日付maxDepthDate/maxOtmDate): それぞれの最大になった日(エントリーから何営業日後か。
 *       最初にその値になった日)。どちらが先に起きたかを見るために使う
 * }}
 */
export function computeItmAnalysis(closes, params, dates) {
  const { ratio, itmWhen, window, group, depthPct = 0 } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";

  const dayItmCounts = new Array(window + 1).fill(0);
  const dayTotalCounts = new Array(window + 1).fill(0);
  let entryCount = 0;
  let entriesItmWithinWindow = 0;
  let totalItmDays = 0;
  const perEntry = [];

  for (let i = 0; i + window < n; i++) {
    const strike = closes[i] * ratio;
    if (!(strike > 0)) continue;
    entryCount++;
    let itmDaysInWindow = 0;
    let maxDepthPct = 0;
    let maxOtmPct = 0;
    let maxDepthDay = 0; // 最大ITM深さになった日(エントリーから何営業日後か。最初にその値になった日)
    let maxOtmDay = 0;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const depthNow = isBelow ? -fwd : fwd;
      if (depthNow > maxDepthPct) { maxDepthPct = depthNow; maxDepthDay = d; }
      if (-depthNow > maxOtmPct) { maxOtmPct = -depthNow; maxOtmDay = d; }
      const itm = depthPct > 0
        ? (isBelow ? fwd <= -depthPct : fwd >= depthPct)
        : (isBelow ? fwd < 0 : fwd > 0);
      dayTotalCounts[d]++;
      if (itm) {
        dayItmCounts[d]++;
        itmDaysInWindow++;
      }
    }
    if (itmDaysInWindow > 0) entriesItmWithinWindow++;
    totalItmDays += itmDaysInWindow;
    perEntry.push({
      date: dates ? dates[i] : null, itmDaysInWindow, maxDepthPct, maxOtmPct,
      maxDepthDay, maxOtmDay,
      maxDepthDate: dates && maxDepthDay ? dates[i + maxDepthDay] : null,
      maxOtmDate: dates && maxOtmDay ? dates[i + maxOtmDay] : null,
    });
  }

  const dayProb = [];
  for (let d = 1; d <= window; d++) {
    dayProb.push(dayTotalCounts[d] ? dayItmCounts[d] / dayTotalCounts[d] : null);
  }

  const overallItmProb = entryCount ? entriesItmWithinWindow / entryCount : null;
  const { label: badge, level: badgeLevel } = classifyBadge(overallItmProb, group);

  return {
    entryCount,
    itmEntryCount: entriesItmWithinWindow,
    totalItmDays,
    overallItmProb,
    dayProb,
    badge,
    badgeLevel,
    perEntry,
  };
}

// level: 0(最も有利=激熱)〜6(最も不利=ピンチ/大ピンチ)。色の濃淡付けに使う。
function classifyBadge(overallItmProb, group) {
  const labels = BADGE_LABELS[group] || BADGE_LABELS.sell;
  if (overallItmProb === null || Number.isNaN(overallItmProb)) return { label: "―", level: null };
  // 買い(buy)はITM確率が高いほど有利、売り(sell)はITM確率が低いほど有利なので
  // 「有利方向への確率」に揃えてからしきい値判定する。
  const favorableProb = group === "sell" ? 1 - overallItmProb : overallItmProb;
  const level = favorableProbToLevel(favorableProb, group);
  return { label: labels[level], level };
}

export function typeGroup(typeKey) {
  return typeKey === "put_sell" || typeKey === "call_sell" ? "sell" : "buy";
}

// 生のITM確率(比率)を、そのタイプにとっての「有利方向への確率」に変換する。
// 営業日ごとのITM確率チャート・エントリー日ごとのヒートマップでも共通で使う。
export function toFavorableProb(rawItmProb, group) {
  if (rawItmProb === null || rawItmProb === undefined || Number.isNaN(rawItmProb)) return null;
  return group === "sell" ? 1 - rawItmProb : rawItmProb;
}

/**
 * indexの終値が、そのlookbackDays営業日前と比べて何%変動したか。
 * 元Excelの「N営業日前比較」列と同じ定義。
 * @returns {number|null} データが足りない場合はnull
 */
export function computeMomentum(closes, index, lookbackDays) {
  const base = index - lookbackDays;
  if (base < 0 || index < 0 || index >= closes.length) return null;
  return closes[index] / closes[base] - 1;
}

/**
 * 最新日について、1〜maxLookback営業日前との比較を並べたもの（「本日の状況」表示用）。
 */
export function computeRecentMomentumStrip(closes, maxLookback = 7) {
  const latest = closes.length - 1;
  const strip = [];
  for (let n = 1; n <= maxLookback; n++) {
    strip.push({ daysAgo: n, change: computeMomentum(closes, latest, n) });
  }
  return strip;
}

// エントリー条件で絞り込みの、値動き条件の判定方法。
// "lookback": N営業日前と比較して、指定した変化率条件を満たすか(単一日の比較)。
// "countWithin7": 直近7営業日それぞれ(1〜7営業日前比較)について条件を満たす日を数え、
//   その日数が指定した日数以上あるか(何日も同じ方向に動き続けたか、を見る)。
export const CONDITION_MODES = ["lookback", "countWithin7"];
const CONDITION_WITHIN_DAYS = 7;

/**
 * 「過去、直近の値動きが今日と似ていた日」に絞り込んだ場合のITM確率を計算する。
 * computeItmAnalysisと同じ判定基準を使うが、対象エントリーを値動き条件でフィルタする点が異なる。
 *
 * @param {number[]} closes
 * @param {{ratio:number, itmWhen:'below'|'above', window:number, depthPct?:number,
 *           conditionMode:'lookback'|'countWithin7', momentumLookback:number,
 *           momentumDirection:'down'|'up', momentumThresholdPct:number, minMatchDays:number}} params
 * @returns {{matchedCount:number, matchedItmCount:number, matchedItmProb:number|null,
 *            matchedTotalItmDays:number, entryIndices:number[]}}
 */
export function computeConditionalItmAnalysis(closes, params) {
  const {
    ratio, itmWhen, window, momentumDirection, momentumThresholdPct,
    conditionMode = "lookback", momentumLookback, minMatchDays, depthPct = 0,
  } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";
  const thresholdFrac = momentumThresholdPct / 100;
  const startIndex = conditionMode === "countWithin7" ? CONDITION_WITHIN_DAYS : momentumLookback;

  let matchedCount = 0;
  let matchedItmCount = 0;
  let matchedTotalItmDays = 0;
  // 該当日のエントリー日インデックスの一覧。リスクリワード分析で、該当日だけを
  // 対象に「判定する深さに届いたか」を数え直すために使う(母数は該当日数=matchedCount)。
  const entryIndices = [];

  for (let i = startIndex; i + window < n; i++) {
    let matches;
    if (conditionMode === "countWithin7") {
      let hitDays = 0;
      for (let k = 1; k <= CONDITION_WITHIN_DAYS; k++) {
        const m = computeMomentum(closes, i, k);
        if (m === null) continue;
        const hit = momentumDirection === "down" ? m <= -thresholdFrac : m >= thresholdFrac;
        if (hit) hitDays++;
      }
      matches = hitDays >= minMatchDays;
    } else {
      const momentum = computeMomentum(closes, i, momentumLookback);
      if (momentum === null) continue;
      matches = momentumDirection === "down" ? momentum <= -thresholdFrac : momentum >= thresholdFrac;
    }
    if (!matches) continue;

    const strike = closes[i] * ratio;
    if (!(strike > 0)) continue;
    matchedCount++;

    let itmAny = false;
    let itmDaysInWindow = 0;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const itm = depthPct > 0
        ? (isBelow ? fwd <= -depthPct : fwd >= depthPct)
        : (isBelow ? fwd < 0 : fwd > 0);
      if (itm) { itmAny = true; itmDaysInWindow++; }
    }
    if (itmAny) matchedItmCount++;
    matchedTotalItmDays += itmDaysInWindow;
    entryIndices.push(i);
  }

  return {
    matchedCount,
    matchedItmCount,
    matchedItmProb: matchedCount ? matchedItmCount / matchedCount : null,
    matchedTotalItmDays,
    entryIndices,
  };
}

// ============================================================
// リスクリワード分析
// ============================================================
// 「ITM発生エントリー数の割合」とは別に、判定期間内の終値が権利行使価格から
// 指定した深さ以上のITMに届いたかどうかで勝敗を決め、受取/支払い
// プレミアムと損失額(または獲得すべき利益額)を比較する機能。

// 取引の種類。上部の取引タイプ(OPTION_TYPESのキー)ごとに「単体(naked)」と
// 「スプレッド(spread)」の2種類を選べる。ラベルは元のオプション用語に合わせた。
export const RISK_VARIANT_LABELS = {
  put_sell: { naked: "プット売り", spread: "ブルプット" },
  call_sell: { naked: "コール売り", spread: "ベアコール" },
  put_buy: { naked: "プット買い", spread: "ベアプット" },
  call_buy: { naked: "コール買い", spread: "ブルコール" },
};

// 「絞り込みなし」の母集団(分析結果と同じ)のエントリー日インデックス一覧。
export function baseEntryIndices(closes, window) {
  const count = Math.max(0, closes.length - window);
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * 各エントリー日について、判定期間内のいずれかの営業日の終値が「権利行使価格から
 * depthPct(割合)以上深いITM」に届いたか、届いた場合はその後OTMに戻るまで何営業日
 * かかったか、を求める。
 * depthPctが0のときは「一度でもITMになったか」と同じ(ITM発生エントリーと同じ判定)。
 * 判定は日々の終値のみ(日中の高値・安値は保有していないため見ていない)。
 *
 * @param {number[]} closes
 * @param {number[]} entryIndices 対象エントリー日のインデックス
 * @param {{ratio:number, itmWhen:'below'|'above', window:number, depthPct:number}} params
 * @returns {{reached:boolean, recoveryDays:number|null}[]}
 *   recoveryDays: 初めて深さに届いた日から、初めてOTMに戻った日までの営業日数。
 *   判定期間内にOTMに戻らなかった場合はnull。
 */
export function computeDepthEntryResults(closes, entryIndices, params) {
  const { ratio, itmWhen, window, depthPct } = params;
  const isBelow = itmWhen === "below";
  const results = [];
  for (const i of entryIndices) {
    const strike = closes[i] * ratio;
    if (!(strike > 0) || i + window >= closes.length) continue;
    let reachDay = null;
    let recoverDay = null;
    for (let d = 1; d <= window; d++) {
      const fwd = closes[i + d] / strike - 1;
      const itm = isBelow ? fwd < 0 : fwd > 0;
      if (reachDay === null) {
        const deep = depthPct > 0 ? (isBelow ? fwd <= -depthPct : fwd >= depthPct) : itm;
        if (deep) reachDay = d;
      } else if (!itm) {
        recoverDay = d;
        break;
      }
    }
    results.push({
      reached: reachDay !== null,
      recoveryDays: reachDay !== null && recoverDay !== null ? recoverDay - reachDay : null,
    });
  }
  return results;
}

/**
 * computeDepthEntryResultsの結果から、勝率とOTMに戻るまでの日数の統計を求める。
 * 売り(group="sell")は深さに届いたエントリーを「負け」、
 * 買い(group="buy")は深さに届いたエントリーを「勝ち」として扱う
 * (ITMが有利か不利かは売り/買いで逆になるため)。
 * OTMに戻るまでの日数は参考値で、判定期間内に戻らなかったエントリーは平均・中央値
 * には含めず、戻らなかった件数として別に数える。
 *
 * @param {{reached:boolean, recoveryDays:number|null}[]} results
 * @param {'sell'|'buy'} group
 */
export function summarizeDepthResults(results, group) {
  const total = results.length;
  if (total === 0) {
    return {
      total: 0, hitCount: 0, winRate: null,
      recoveredCount: 0, unrecoveredCount: 0, avgRecoveryDays: null, medianRecoveryDays: null,
    };
  }
  const reached = results.filter((r) => r.reached);
  const hitCount = reached.length;
  const recovered = reached.filter((r) => r.recoveryDays !== null).map((r) => r.recoveryDays).sort((a, b) => a - b);
  const recoveredCount = recovered.length;
  const avgRecoveryDays = recoveredCount ? recovered.reduce((s, v) => s + v, 0) / recoveredCount : null;
  let medianRecoveryDays = null;
  if (recoveredCount) {
    const mid = Math.floor(recoveredCount / 2);
    medianRecoveryDays = recoveredCount % 2 ? recovered[mid] : (recovered[mid - 1] + recovered[mid]) / 2;
  }
  const winRate = group === "sell" ? 1 - hitCount / total : hitCount / total;
  return {
    total, hitCount, winRate,
    recoveredCount, unrecoveredCount: hitCount - recoveredCount, avgRecoveryDays, medianRecoveryDays,
  };
}

export const DETAIL_BEFORE_DAYS = 7;
// 「30営業日以内のITM日数」参考列の固定日数。判定期間(window)の選択値とは独立。元Excelの
// 「30営業日以内のP売ITM日数」列に合わせている。
export const DETAIL_ITM_REF_DAYS = 30;

/**
 * 元Excelに近い、エントリー日ごとの詳細マトリクスを計算する。
 * 各行=1エントリー日について、終値・権利行使価格・30営業日以内のITM日数(参考)・
 * 前7営業日比較(before)・判定期間分の先読み(after)を持つ。
 * afterは権利行使価格に対する生の乖離率（株価/権利行使価格-1）。正=株価が権利行使価格より上、負=下。
 * 集計期間の全エントリー日を対象とする(判定期間分を差し引かない)。先読みの日数分の
 * データが無いセルはnull(未確定)になる。
 *
 * @param {number[]} closes
 * @param {string[]} dates
 * @param {{ratio:number, window:number, itmWhen:'below'|'above'}} params
 * @returns {{date:string, close:number, strike:number, itmDaysRef:number|null,
 *            before:(number|null)[], after:(number|null)[]}[]}
 */
export function computeDetailMatrix(closes, dates, params) {
  const { ratio, window, itmWhen } = params;
  const n = closes.length;
  const isBelow = itmWhen === "below";
  const rows = [];

  for (let i = 0; i < n; i++) {
    const close = closes[i];
    const strike = close * ratio;
    const before = [];
    for (let k = 1; k <= DETAIL_BEFORE_DAYS; k++) {
      before.push(computeMomentum(closes, i, k));
    }
    const after = [];
    for (let d = 1; d <= window; d++) {
      after.push(i + d < n ? closes[i + d] / strike - 1 : null);
    }
    const refDays = Math.min(DETAIL_ITM_REF_DAYS, n - 1 - i);
    let itmDaysRef = null;
    if (refDays > 0) {
      itmDaysRef = 0;
      for (let d = 1; d <= refDays; d++) {
        const fwd = closes[i + d] / strike - 1;
        if (isBelow ? fwd < 0 : fwd > 0) itmDaysRef++;
      }
    }
    rows.push({ date: dates[i], close, strike, itmDaysRef, before, after });
  }
  return rows;
}

// ---- HV(歴史的ボラティリティ) ----
// HV = 日次の対数騰落率(終値の比の自然対数)の標準偏差(標本、n−1)を、年率に換算(×√252)した値。
// 「過去の値動きの大きさ」を1つの数字にしたもの。オプション価格に織り込まれる将来の変動の大きさ(IV)とは別物で、
// このツールでは終値だけから計算する(IVは取得できない)。
export const HV_TRADING_DAYS_PER_YEAR = 252;
const HV_RANK_LOOKBACK = 252; // HVの「1年の中での位置」を見る期間(営業日)

// closesの末尾から数えて、直近days個の日次騰落率からHV(年率、割合。0.25=25%)を求める。
// データが足りない(騰落率がdays個とれない)、またはdaysが2未満ならnull。
export function computeHv(closes, days) {
  if (!(days >= 2) || closes.length < days + 1) return null;
  return hvAt(closes, closes.length - 1, days);
}

function hvAt(closes, endIdx, days) {
  let sum = 0;
  let sumSq = 0;
  for (let i = endIdx - days + 1; i <= endIdx; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / days;
  const variance = Math.max(0, (sumSq - days * mean * mean) / (days - 1));
  return Math.sqrt(variance) * Math.sqrt(HV_TRADING_DAYS_PER_YEAR);
}

/**
 * 各日を終点とするHV(days日)の推移のうち、直近lookback個を返す(古い順)。
 * 現在のHVが、過去1年の中で高い方か低い方かを見るために使う。
 */
export function computeHvSeries(closes, days, lookback = HV_RANK_LOOKBACK) {
  const out = [];
  const first = Math.max(days, closes.length - lookback);
  for (let i = first; i < closes.length; i++) out.push(hvAt(closes, i, days));
  return out;
}

/**
 * 現在のHVの、過去1年の中での位置。
 *  percentile: 過去1年のうち、現在以下だった日の割合(0〜1。0.8なら「1年の80%の日より高い」)
 *  median: 過去1年のHVの中央値(「ふだん」の水準)
 *  higherCount / lowerCount: 過去1年のうち、いまより高かった日数・低かった日数
 *  min / max: 過去1年のHVの最小・最大
 *  rank: (現在−最小)÷(最大−最小)(0〜1。最大と最小の幅の中での位置)
 */
export function hvPosition(closes, days, lookback = HV_RANK_LOOKBACK) {
  if (closes.length < days + 2) return null;
  const series = computeHvSeries(closes, days, lookback);
  if (series.length < 2) return null;
  const current = series[series.length - 1];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const atMostCount = series.filter((v) => v <= current).length;
  const percentile = atMostCount / series.length;
  const sortedSeries = [...series].sort((a, b) => a - b);
  const mid = Math.floor(sortedSeries.length / 2);
  const median = sortedSeries.length % 2 ? sortedSeries[mid] : (sortedSeries[mid - 1] + sortedSeries[mid]) / 2;
  return {
    current, min, max, median, percentile, rank: max > min ? (current - min) / (max - min) : 0, count: series.length,
    higherCount: series.length - atMostCount, // 過去1年のうち、いまより高かった日数
    lowerCount: series.filter((v) => v < current).length, // 過去1年のうち、いまより低かった日数
  };
}

// 標準正規分布の累積分布関数(Abramowitz-Stegunの近似。誤差は約1.5e-7)
export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * HVから見た、権利行使価格の位置と、理論上の確率(目安)を求める。
 * 株価が対数正規分布に従い、平均的な上昇・下落(ドリフト)はないと仮定した、単純な近似。
 *  sigmaPct:   満期(days営業日)までの1σの値動き(割合)=HV×√(days/252)
 *  sigmaAmount: 同じく、現在値に対する金額
 *  zScore:     権利行使価格が現在値から何σ離れているか(ITMと反対側(OTM側)を正とする)
 *  probItmAtExpiry: 満期時にITMになる確率
 *  probTouch:  期間中に一度でもITMの水準に届く確率の目安(満期時の確率の2倍。上限100%。毎日の終値だけを見る実績よりやや多めに出る)
 * ITM側の価格は、プット系は権利行使価格−深さ、コール系は権利行使価格＋深さ(深さはドル)で見る。
 *
 * @param {{price:number, strike:number, depthDollar:number, itmWhen:'below'|'above', days:number, hv:number}} p
 */
export function hvTheory({ price, strike, depthDollar, itmWhen, days, hv }) {
  if (!(price > 0) || !(strike > 0) || !(hv > 0) || !(days > 0)) return null;
  const sigmaPct = hv * Math.sqrt(days / HV_TRADING_DAYS_PER_YEAR);
  const barrier = itmWhen === "below" ? strike - depthDollar : strike + depthDollar;
  if (!(barrier > 0)) return null;
  // OTM側を正とした距離(σ単位)。プット系は現在値より下に、コール系は上に、barrierがある
  const dist = Math.log(barrier / price) / sigmaPct;
  const zScore = itmWhen === "below" ? -dist : dist;
  const probItmAtExpiry = normalCdf(-zScore);
  return {
    sigmaPct,
    sigmaAmount: price * sigmaPct,
    barrier,
    distancePct: barrier / price - 1,
    zScore,
    probItmAtExpiry,
    probTouch: Math.min(1, 2 * probItmAtExpiry),
  };
}
