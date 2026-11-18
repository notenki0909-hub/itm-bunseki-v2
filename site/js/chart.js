// 日数別ITM確率の棒グラフをSVG文字列として生成する（純粋関数）。
// 既存の「銘柄診断ツール」サイトと同じくインラインSVG方式（外部チャートライブラリ不使用）。

// 色はその日のITM率(絶対値)を表す。売り/買いでしきい値・色が異なる
// (売りはITMが少ないほど良いので寒色系中心、買いはITMが多いほど良いので
// 暖色系中心、というように基準そのものを分けている)。
import { otmRateColor } from "./heatmap.js";

const LIGHT_GRAY = "color-mix(in srgb, var(--muted) 25%, var(--card))";
const LIGHT_YELLOW = "color-mix(in srgb, var(--gradYellow) 55%, var(--card))";

export const DAY_PROB_BANDS = {
  sell: [
    { max: 0.05, label: "5%以下", color: "var(--gradLightBlue)" },
    { max: 0.10, label: "5〜10%", color: "var(--gradBlue)" },
    { max: Infinity, label: "10%超", color: "var(--gradPurple)" },
  ],
  buy: [
    { max: 0.10, label: "10%未満", color: LIGHT_GRAY },
    { max: 0.20, label: "10〜20%", color: LIGHT_YELLOW },
    { max: 0.30, label: "20〜30%", color: "var(--gradOrange)" },
    { max: Infinity, label: "30%以上", color: "var(--gradRed)" },
  ],
};

function barColor(v, group) {
  const bands = DAY_PROB_BANDS[group] || DAY_PROB_BANDS.sell;
  const band = bands.find((b) => v <= b.max);
  return band ? band.color : bands[bands.length - 1].color;
}

/**
 * @param {(number|null)[]} dayProb dayProb[d-1] = d営業日後のITM確率(0-1)
 * @param {'sell'|'buy'} group 色の基準を売り/買いで切り替えるために使う
 * @param {'itm'|'otm'} mode "otm"のときは、各営業日のOTM確率(=1−ITM確率)を、OTM率の7段階配色で表示する
 * @returns {string} SVG文字列
 */
export function renderDayProbChart(dayProb, group, mode = "itm") {
  const isOtm = mode === "otm";
  const w = 640;
  const barGap = 2;
  const leftPad = 34;
  const rightPad = 8;
  const topPad = 10;
  const bottomPad = 22;
  const chartH = 160;
  const h = topPad + chartH + bottomPad;
  const n = dayProb.length;
  const barW = n > 0 ? (w - leftPad - rightPad) / n - barGap : 0;

  let bars = "";
  let hits = ""; // クリックで説明を出すための、各営業日の列全体を覆う透明な領域(ITM率0%の棒もクリックできるように)
  let labels = "";
  const labelStep = Math.max(1, Math.ceil(n / 15));

  for (let i = 0; i < n; i++) {
    const v = dayProb[i] === null ? null : (isOtm ? 1 - dayProb[i] : dayProb[i]);
    const x = leftPad + i * (barW + barGap);
    const barH = v === null ? 0 : Math.max(0, v) * chartH;
    const y = topPad + (chartH - barH);
    const color = v === null ? "var(--line)" : (isOtm ? otmRateColor(v, group) : barColor(v, group));
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}"></rect>`;
    const tip = `${i + 1}営業日後${isOtm ? "のOTM" : ""}: ${v === null ? "データ不足" : (v * 100).toFixed(1) + "%"}`;
    hits += `<rect class="chart-hit" data-tip="${tip}" x="${(x - barGap / 2).toFixed(1)}" y="${topPad}" width="${(barW + barGap).toFixed(1)}" height="${chartH}" fill="transparent"></rect>`;
    if ((i + 1) % labelStep === 0 || i === 0 || i === n - 1) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 6}" font-size="9" text-anchor="middle" fill="var(--muted)">${i + 1}</text>`;
    }
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = topPad + chartH * (1 - f);
    return `<line x1="${leftPad}" y1="${y.toFixed(1)}" x2="${w - rightPad}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="${leftPad - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--muted)">${Math.round(f * 100)}%</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="過去の営業日ごとの${isOtm ? "OTM" : "ITM"}確率">` +
    gridLines + bars + hits + labels +
    `</svg>`;
}

// ---- 満期までの値動きの目安(コーン図)と、ITMの水準 ----
// 左: 直近の株価(終値)の推移。右: いまの株価を起点に、満期まで広がる±1σ・±2σの範囲(HVから求めた目安)。
// 赤い横線=ITMとみなす水準(権利行使価格。判定する深さを入れていれば、その分だけ奥)。線の先(プット系は下、コール系は上)がITM側。
// 帯の幅は、現在値×σ×√(経過日数÷満期までの日数)(線形)。画面の「±◯ドル」と同じ計算。純粋関数(SVG文字列を返す)。
/**
 * @param {object} p
 * @param {number[]} p.pastCloses 直近の終値(古い順。最後がいまの株価)
 * @param {number} p.price いまの株価
 * @param {number} p.days 満期までの営業日数
 * @param {number} p.sigmaPct 満期までの1σ(割合。0.08=±8%)
 * @param {number} p.barrier ITMの水準の株価
 * @param {'below'|'above'} p.itmWhen ITMが現在値の下側(プット系)か上側(コール系)か
 * @param {string} p.nowLabel 「いま」の下に出す文字(日付など)
 * @param {string} p.expiryLabel 満期の下に出す文字
 * @param {string} p.barrierLabel ITMの水準に添える文字
 * @param {number|null} p.markBefore 満期のこの営業日数前に縦線を引く(満期までの日数より小さいときだけ。例: 10＝満期の10営業日前)。その位置の±1σの株価も出す
 * @param {string} p.markLabel 縦線の下に出す文字(日付など)
 * @param {number|null} p.ivSigmaPct IV基準の満期までの1σ(割合)。あれば、HV基準の帯(青)にIV基準の±1σの帯(オレンジ)を重ねる
 * @param {{lo:number[],hi:number[],min:number[],max:number[]}|null} p.empCone 過去の実績の帯(営業日ごとの変化率。k=0〜days)。あれば、約68%の範囲を灰色の帯、最小・最大を点線で重ねる
 */
export function renderConeChart({ pastCloses, price, days, sigmaPct, barrier, itmWhen, nowLabel = "いま", expiryLabel = "満期", barrierLabel = "ITMの水準", markBefore = null, markLabel = "", ivSigmaPct = null, empCone = null }) {
  const w = 640;
  const h = 300;
  const padL = 50;
  const padR = 92;
  const padT = 14;
  const padB = 40;
  const nPast = Math.max(1, pastCloses.length - 1);
  const xNow = padL + (w - padL - padR) * 0.3;
  const xEnd = w - padR;
  const xPast = (k) => padL + (xNow - padL) * (k / nPast);
  const xFut = (t) => xNow + (xEnd - xNow) * (t / days);

  const hasIv = ivSigmaPct !== null && ivSigmaPct > 0;
  const spanSig = Math.max(2 * sigmaPct, hasIv ? ivSigmaPct : 0);
  const empMin = empCone ? Math.min(...empCone.min) : 0;
  const empMax = empCone ? Math.max(...empCone.max) : 0;
  const lo = Math.min(...pastCloses, price * (1 - spanSig), price * (1 + empMin), barrier);
  const hi = Math.max(...pastCloses, price * (1 + spanSig), price * (1 + empMax), barrier);
  const pad = (hi - lo) * 0.06;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const y = (v) => padT + (h - padT - padB) * (1 - (v - yMin) / (yMax - yMin));
  const f = (v) => v.toFixed(1);

  // 左のグリッド線と価格の目盛り(5本)
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    grid += `<line x1="${padL}" y1="${f(y(v))}" x2="${xEnd}" y2="${f(y(v))}" stroke="var(--line)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${f(y(v) + 3)}" font-size="10" text-anchor="end" fill="var(--muted)">${v.toFixed(v >= 100 ? 0 : 1)}</text>`;
  }

  // コーン(±1σ・±2σ)
  const steps = 24;
  const band = (mult, sig = sigmaPct) => {
    const up = [];
    const dn = [];
    for (let s = 0; s <= steps; s++) {
      const t = (days * s) / steps;
      const spread = price * sig * mult * Math.sqrt(t / days);
      up.push(`${f(xFut(t))},${f(y(price + spread))}`);
      dn.push(`${f(xFut(t))},${f(y(price - spread))}`);
    }
    return `${up.join(" ")} ${dn.reverse().join(" ")}`;
  };
  const cone = `<polygon points="${band(2)}" fill="color-mix(in srgb, var(--accent) 10%, transparent)" stroke="none"/>`
    + `<polygon points="${band(1)}" fill="color-mix(in srgb, var(--accent) 24%, transparent)" stroke="var(--accent)" stroke-width="1"/>`
    + (hasIv ? `<polygon points="${band(1, ivSigmaPct)}" fill="color-mix(in srgb, var(--gradOrange) 10%, transparent)" stroke="var(--gradOrange)" stroke-width="1.8" stroke-dasharray="6 3"/>` : "");

  // 過去の実績の帯(約68%の範囲＝灰色の帯、最小・最大＝点線)
  let emp = "";
  if (empCone) {
    const ptsOf = (arr) => arr.map((r, k) => `${f(xFut(k))},${f(y(price * (1 + r)))}`);
    const poly = (a, b) => `${ptsOf(a).join(" ")} ${ptsOf(b).reverse().join(" ")}`;
    emp = `<polygon points="${poly(empCone.hi, empCone.lo)}" fill="color-mix(in srgb, var(--muted) 30%, transparent)" stroke="var(--muted)" stroke-width="1.2"/>`
      + `<polyline points="${ptsOf(empCone.max).join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.3" stroke-dasharray="2 3" opacity="0.7"/>`
      + `<polyline points="${ptsOf(empCone.min).join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.3" stroke-dasharray="2 3" opacity="0.7"/>`;
  }

  // ITM側の領域(赤い薄い帯)と、ITMの水準の線
  const yb = y(barrier);
  const zoneTop = itmWhen === "below" ? yb : padT;
  const zoneBottom = itmWhen === "below" ? h - padB : yb;
  const zone = `<rect x="${f(xNow)}" y="${f(zoneTop)}" width="${f(xEnd - xNow)}" height="${f(Math.max(0, zoneBottom - zoneTop))}" fill="color-mix(in srgb, var(--gradRed) 12%, transparent)"/>`;
  const barrierLine = `<line x1="${f(xNow)}" y1="${f(yb)}" x2="${f(xEnd)}" y2="${f(yb)}" stroke="var(--gradRed)" stroke-width="1.8" stroke-dasharray="6 4"/>`;
  const barrierText = `<text x="${f(xNow + 6)}" y="${f(itmWhen === "below" ? yb - 5 : yb + 13)}" font-size="11" font-weight="700" fill="var(--gradRed)">${barrierLabel}</text>`;

  // 過去の株価
  const pastPts = pastCloses.map((c, k) => `${f(xPast(k))},${f(y(c))}`).join(" ");
  const past = `<polyline points="${pastPts}" fill="none" stroke="var(--muted)" stroke-width="1.6"/>`;

  // いまの株価(点と横の破線)、満期の縦線
  const nowDot = `<line x1="${f(xNow)}" y1="${f(y(price))}" x2="${f(xEnd)}" y2="${f(y(price))}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>`
    + `<circle cx="${f(xNow)}" cy="${f(y(price))}" r="4" fill="var(--fg)"/>`;
  const expiryLine = `<line x1="${f(xNow)}" y1="${padT}" x2="${f(xNow)}" y2="${h - padB}" stroke="var(--line)" stroke-width="1"/>`
    + `<line x1="${f(xEnd)}" y1="${padT}" x2="${f(xEnd)}" y2="${h - padB}" stroke="var(--muted)" stroke-width="1"/>`;

  // 右端の価格ラベル(+1σ・いま・−1σ。IVがあれば、HV・IVの両方)。縦に近いものは、重ならないよう下へずらす
  const labItems = (hasIv || empCone)
    ? [
      { v: price * (1 + sigmaPct), text: `HV +1σ ${(price * (1 + sigmaPct)).toFixed(1)}`, color: "var(--accent)" },
      ...(hasIv ? [{ v: price * (1 + ivSigmaPct), text: `IV +1σ ${(price * (1 + ivSigmaPct)).toFixed(1)}`, color: "var(--gradOrange)" }] : []),
      { v: price, text: `いま ${price.toFixed(1)}`, color: "var(--fg)" },
      { v: price * (1 - sigmaPct), text: `HV −1σ ${(price * (1 - sigmaPct)).toFixed(1)}`, color: "var(--accent)" },
      ...(hasIv ? [{ v: price * (1 - ivSigmaPct), text: `IV −1σ ${(price * (1 - ivSigmaPct)).toFixed(1)}`, color: "var(--gradOrange)" }] : []),
    ]
    : [
      { v: price * (1 + sigmaPct), text: `+1σ ${(price * (1 + sigmaPct)).toFixed(1)}`, color: "var(--accent)" },
      { v: price, text: `いま ${price.toFixed(1)}`, color: "var(--fg)" },
      { v: price * (1 - sigmaPct), text: `−1σ ${(price * (1 - sigmaPct)).toFixed(1)}`, color: "var(--accent)" },
    ];
  if (empCone) {
    const e = (arr) => price * (1 + arr[arr.length - 1]);
    labItems.push(
      { v: e(empCone.max), text: `実績最大 ${e(empCone.max).toFixed(1)}`, color: "var(--fg)" },
      { v: e(empCone.hi), text: `実績84% ${e(empCone.hi).toFixed(1)}`, color: "var(--muted)" },
      { v: e(empCone.lo), text: `実績16% ${e(empCone.lo).toFixed(1)}`, color: "var(--muted)" },
      { v: e(empCone.min), text: `実績最小 ${e(empCone.min).toFixed(1)}`, color: "var(--fg)" },
    );
  }
  const nudge = (items) => {
    const sorted = items.map((it) => ({ ...it, yy: y(it.v) + 3 })).sort((p, q) => p.yy - q.yy);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].yy - sorted[i - 1].yy < 12) sorted[i].yy = sorted[i - 1].yy + 12;
    return sorted;
  };
  const rightLabels = nudge(labItems).map((it) => `<text x="${f(xEnd + 6)}" y="${f(it.yy)}" font-size="10.5" fill="${it.color}">${it.text}</text>`).join("");
  const bottomLabels = `<text x="${f(xNow)}" y="${h - 20}" font-size="10.5" text-anchor="middle" fill="var(--muted)">${nowLabel}</text>`
    + `<text x="${f(xEnd)}" y="${h - 20}" font-size="10.5" text-anchor="middle" fill="var(--muted)">${expiryLabel}</text>`
    + `<text x="${f(padL)}" y="${h - 20}" font-size="10.5" text-anchor="start" fill="var(--muted)">直近${nPast}営業日</text>`;

  // 満期のN営業日前の縦線と、その位置(いまからの経過日数＝days−N)の±1σの株価(IVがあれば、HV・IVの両方)
  let mark = "";
  if (markBefore !== null && markBefore > 0 && markBefore < days) {
    const t = days - markBefore;
    const x = xFut(t);
    const line = "var(--muted)";
    const one = (sig, col, pre) => {
      const spread = price * sig * Math.sqrt(t / days);
      const vUp = price + spread;
      const vDn = price - spread;
      return `<circle cx="${f(x)}" cy="${f(y(vUp))}" r="3.5" fill="${col}"/><circle cx="${f(x)}" cy="${f(y(vDn))}" r="3.5" fill="${col}"/>`
        + `<text x="${f(x + 6)}" y="${f(y(vUp) - 5)}" font-size="10.5" font-weight="700" fill="${col}">${pre}+1σ ${vUp.toFixed(1)}</text>`
        + `<text x="${f(x + 6)}" y="${f(y(vDn) + 13)}" font-size="10.5" font-weight="700" fill="${col}">${pre}−1σ ${vDn.toFixed(1)}</text>`;
    };
    mark = `<line x1="${f(x)}" y1="${padT}" x2="${f(x)}" y2="${h - padB}" stroke="${line}" stroke-width="1.8" stroke-dasharray="5 3"/>`
      + one(sigmaPct, "var(--accent)", (hasIv || empCone) ? "HV " : "")
      + (hasIv ? one(ivSigmaPct, "var(--gradOrange)", "IV ") : "")
      + `<text x="${f(x)}" y="${h - 6}" font-size="10.5" font-weight="700" text-anchor="middle" fill="${line}">${markLabel}</text>`;
  }

  return `<svg viewBox="0 0 ${w} ${h}" class="chart cone-chart" role="img" aria-label="満期までの値動きの目安とITMの水準">`
    + grid + zone + cone + emp + past + expiryLine + nowDot + barrierLine + barrierText + mark + rightLabels + bottomLabels
    + `</svg>`;
}

// ---- HVの過去1年の推移グラフ ----
// 過去1年の毎日について「その日までの直近◯営業日のHV」を並べた折れ線(約252点)。
// 灰色の点線=中央値(ふだんの水準)、赤い点=最大、青い点=最小、黒い点=いま。純粋関数(SVG文字列を返す)。
/**
 * @param {object} p
 * @param {{date:string, hv:number}[]} p.points 古い順。最後がいま
 * @param {number} p.median 中央値(割合)
 */
export function renderHvHistoryChart({ points, median }) {
  const w = 640;
  const h = 250;
  const padL = 46;
  const padR = 22;
  const padT = 16;
  const padB = 34;
  const n = points.length;
  const values = points.map((q) => q.hv);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  const yMax = Math.max(maxV * 1.15, 0.05);
  const x = (i) => padL + ((w - padL - padR) * i) / Math.max(1, n - 1);
  const y = (v) => padT + (h - padT - padB) * (1 - v / yMax);
  const f = (v) => v.toFixed(1);
  const pct = (v) => `${(v * 100).toFixed(0)}%`;

  // 目盛り(0%から4等分)
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    grid += `<line x1="${padL}" y1="${f(y(v))}" x2="${w - padR}" y2="${f(y(v))}" stroke="var(--line)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${f(y(v) + 3)}" font-size="10" text-anchor="end" fill="var(--muted)">${pct(v)}</text>`;
  }

  // 日付の目盛り(5か所)
  let xlabels = "";
  for (const i of [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round(((n - 1) * 3) / 4), n - 1]) {
    xlabels += `<text x="${f(x(i))}" y="${h - 14}" font-size="10" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" fill="var(--muted)">${points[i].date.slice(0, 7)}</text>`;
  }

  const line = points.map((q, i) => `${f(x(i))},${f(y(q.hv))}`).join(" ");
  const area = `${f(x(0))},${f(y(0))} ${line} ${f(x(n - 1))},${f(y(0))}`;
  const curve = `<polygon points="${area}" fill="color-mix(in srgb, var(--accent) 16%, transparent)"/>`
    + `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>`;

  // 中央値(ふだんの水準)
  const med = `<line x1="${padL}" y1="${f(y(median))}" x2="${w - padR}" y2="${f(y(median))}" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="5 4"/>`
    + `<text x="${padL + 6}" y="${f(y(median) - 5)}" font-size="10.5" fill="var(--muted)">ふだん（中央値）${pct(median)}</text>`;

  // 最大・最小・いま
  const iMax = values.indexOf(maxV);
  const iMin = values.indexOf(minV);
  const dot = (i, color, r) => `<circle cx="${f(x(i))}" cy="${f(y(values[i]))}" r="${r}" fill="${color}"/>`;
  const dateShort = (i) => points[i].date.slice(5);
  const anchorFor = (i) => (i > n * 0.8 ? "end" : i < n * 0.1 ? "start" : "middle");
  const dx = (i) => (i > n * 0.8 ? -6 : i < n * 0.1 ? 6 : 0);
  let marks = "";
  marks += dot(iMin, "var(--gradLightBlue)", 4)
    + `<text x="${f(x(iMin) + dx(iMin))}" y="${f(y(minV) + 15)}" font-size="10.5" text-anchor="${anchorFor(iMin)}" fill="var(--fg)">最小 ${pct(minV)}（${dateShort(iMin)}）</text>`;
  marks += dot(iMax, "var(--gradRed)", 4);
  // 最大が「いま」に近いときは、ラベルを省き(「いま」のラベルと重なるため)、赤い点は黒い点と重ねる
  if (iMax < n - 3) {
    marks += `<text x="${f(x(iMax) + dx(iMax))}" y="${f(y(maxV) - 8)}" font-size="10.5" text-anchor="${anchorFor(iMax)}" fill="var(--fg)">最大 ${pct(maxV)}（${dateShort(iMax)}）</text>`;
  }
  const last = n - 1;
  marks += dot(last, "var(--fg)", 4.5)
    + `<text x="${f(x(last) - 8)}" y="${f(y(values[last]) - 8)}" font-size="11" font-weight="700" text-anchor="end" fill="var(--fg)">いま ${(values[last] * 100).toFixed(1)}%</text>`;

  return `<svg viewBox="0 0 ${w} ${h}" class="chart hv-history-chart" role="img" aria-label="過去1年のHVの推移">`
    + grid + curve + med + marks + xlabels + `</svg>`;
}
