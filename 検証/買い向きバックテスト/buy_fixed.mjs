// 買い向きバックテスト(3回目): Pineは「買った時点で決めて動かさない固定の線」として使う。
//   線 = 買った日の終値 − 倍率×ATR(期間)  (Trend Supportの切り上げ・トレンド判定は使わない)
//   手仕舞い = 終値が線を割った日、または満期の早い方
//   買う条件 = 「最低条件」と同じ(1〜7営業日前との比較のうち、X%以上の下落が1日以上)。X=なし は、毎日買い(基準)
// 使い方: node buy_fixed.mjs data_long
import fs from 'fs';
const DIR = process.argv[2] || 'data_long';
const SYMS = ['QQQ', 'SPY', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'IWM'];

const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const bsCall = (S, K, T, s) => { if (T <= 0) return Math.max(0, S - K); const sd = s * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd; return S * ncdf(d1) - K * ncdf(d1 - sd); };
const hv = (c, i, w = 20) => { const r = []; for (let k = i - w + 1; k <= i; k++) r.push(Math.log(c[k] / c[k - 1])); const m = r.reduce((a, b) => a + b, 0) / w; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (w - 1)) * Math.sqrt(252); };
const ivAt = (c, i) => Math.max(0.10, hv(c, i) * 1.15);
function atrSeries(h, l, c, per) {
  const n = c.length, tr = [], atr = [];
  for (let i = 0; i < n; i++) tr.push(i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  for (let i = 0; i < n; i++) {
    if (i < per - 1) atr.push(NaN);
    else if (i === per - 1) atr.push(tr.slice(0, per).reduce((a, b) => a + b, 0) / per);
    else atr.push((atr[i - 1] * (per - 1) + tr[i]) / per);
  }
  return atr;
}
const data = {};
for (const s of SYMS) {
  const d = JSON.parse(fs.readFileSync(DIR + '/' + s + '.json', 'utf8'));
  data[s] = { ...d, atr: { 10: atrSeries(d.highs, d.lows, d.closes, 10), 20: atrSeries(d.highs, d.lows, d.closes, 20) } };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
const pc = (x, d = 0) => (Number.isNaN(x) ? '-' : (x * 100).toFixed(d) + '%');

// 買う条件: 1〜7営業日前との比較のうち、X以上の下落が1日以上(X=nullは毎日)
const entryOk = (c, i, X) => { if (X === null) return true; for (let k = 1; k <= 7; k++) if (i - k >= 0 && c[i] / c[i - k] - 1 <= -X) return true; return false; };

// 1回の検証。cfg: {X, mult(null=線なし), per, N, strikeRatio(K/S0)}
function run(cfg) {
  const out = [];
  for (const s of SYMS) {
    const { closes: c, atr } = data[s]; const n = c.length; const A = atr[cfg.per];
    for (let i = 25; i < n; i++) {
      if (!entryOk(c, i, cfg.X) || Number.isNaN(A[i])) continue;
      const S0 = c[i], K = S0 * cfg.strikeRatio, N = cfg.N;
      const prem = bsCall(S0, K, N / 252, ivAt(c, i));
      const L = cfg.mult === null ? -Infinity : S0 - cfg.mult * A[i];
      let exit = null, why = '';
      for (let j = i + 1; j < n && j <= i + N; j++) { if (c[j] <= L) { exit = j; why = 'line'; break; } if (j === i + N) { exit = j; why = 'exp'; } }
      if (exit === null) continue; // 未決着
      const Sx = c[exit];
      const val = why === 'exp' ? Math.max(0, Sx - K) : bsCall(Sx, K, (N - (exit - i)) / 252, ivAt(c, exit));
      out.push({ stock: Sx / S0 - 1, call: val / prem - 1, line: why === 'line', days: exit - i,
        stockHold: i + N < n ? c[i + N] / S0 - 1 : undefined, callHold: i + N < n ? Math.max(0, c[i + N] - K) / prem - 1 : undefined });
    }
  }
  return out;
}
const sumLine = (r) => {
  const st = r.map((x) => x.stock), ca = r.map((x) => x.call);
  const h = r.filter((x) => x.stockHold !== undefined);
  return `n=${String(r.length).padStart(5)} | 株 平均${pc(mean(st), 1).padStart(6)} 勝率${pc(st.filter((v) => v > 0).length / st.length)} 最悪${pc(Math.min(...st)).padStart(5)} 満期保有${pc(mean(h.map((x) => x.stockHold)), 1).padStart(6)} | コール 平均${pc(mean(ca)).padStart(5)} 中央${pc(med(ca)).padStart(5)} 勝率${pc(ca.filter((v) => v > 0).length / ca.length)} 満期保有${pc(mean(h.map((x) => x.callHold))).padStart(5)} | 線で手仕舞い${pc(r.filter((x) => x.line).length / r.length)} 保有${mean(r.map((x) => x.days)).toFixed(0)}日`;
};
const base = { per: 10, mult: 3, N: 110, strikeRatio: 1.0 };

console.log('=== A. 買う条件(最低条件と同じ)の下落率Xを変える。線=ATR10×3(固定)、コール=ATM・満期110営業日 ===');
for (const X of [null, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10]) console.log(`X=${X === null ? '毎日(基準)' : pc(X) + '以上'}`.padEnd(14), sumLine(run({ ...base, X })));

console.log('\n=== B. 線の設定を変える(固定の線)。買う条件=毎日(基準) と 最低条件X=5% ===');
for (const X of [null, 0.05]) {
  console.log(`-- 買う条件: ${X === null ? '毎日' : '最低条件 X=5%'}`);
  for (const per of [10, 20]) for (const mult of [1, 2, 3, 4, 5, null]) console.log(`ATR${per}×${mult === null ? '線なし' : mult}`.padEnd(12), sumLine(run({ ...base, X, per, mult })));
}

console.log('\n=== C. コールの条件を変える(線=ATR10×3固定)。買う条件=最低条件X=5% ===');
for (const N of [30, 60, 110, 180]) for (const [lab, sr] of [['ITM10%', 0.90], ['ITM5%', 0.95], ['ATM', 1.0], ['OTM5%', 1.05]]) console.log(`満期${N}営業日 ${lab}`.padEnd(16), sumLine(run({ ...base, X: 0.05, N, strikeRatio: sr })));
console.log('\n=== C2. 同じ(買う条件=毎日) ===');
for (const N of [30, 60, 110, 180]) for (const [lab, sr] of [['ITM10%', 0.90], ['ITM5%', 0.95], ['ATM', 1.0], ['OTM5%', 1.05]]) console.log(`満期${N}営業日 ${lab}`.padEnd(16), sumLine(run({ ...base, X: null, N, strikeRatio: sr })));
