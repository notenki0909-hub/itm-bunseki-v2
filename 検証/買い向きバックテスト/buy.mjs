// 買い向きのバックテスト: Trend Tracker(Pine)の「上昇転換日に買い、線を終値で割った日(=下降転換)か満期の早い方で手仕舞い」
import fs from 'fs';
const DIR = process.argv[2] || 'data';
const SYMS = ['QQQ', 'SPY', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'IWM'];
const NEXP = 110;            // コールの満期(営業日)。約150暦日
const PER = 10, MULT = 3.0;  // ATR期間・倍率(Pineの初期値)

// --- Black-Scholes(金利0・配当なし) ---
const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const bsCall = (S, K, T, s) => { if (T <= 0) return Math.max(0, S - K); const sd = s * Math.sqrt(T); const d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd; return S * ncdf(d1) - K * ncdf(d1 - sd); };
const hv = (c, i, w = 20) => { const r = []; for (let k = i - w + 1; k <= i; k++) r.push(Math.log(c[k] / c[k - 1])); const m = r.reduce((a, b) => a + b, 0) / w; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (w - 1)) * Math.sqrt(252); };
const iv = (c, i) => Math.max(0.10, hv(c, i) * 1.15); // 実際のIVではなく、HV20×1.15の仮定

// --- Trend Tracker(Pine v6を忠実に) ---
function trendTracker(h, l, c) {
  const n = c.length, tr = [], atr = [], up = [], dn = [], trend = [];
  for (let i = 0; i < n; i++) tr.push(i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  for (let i = 0; i < n; i++) {
    if (i < PER - 1) atr.push(NaN);
    else if (i === PER - 1) atr.push(tr.slice(0, PER).reduce((a, b) => a + b, 0) / PER);
    else atr.push((atr[i - 1] * (PER - 1) + tr[i]) / PER);
  }
  for (let i = 0; i < n; i++) {
    const src = (h[i] + l[i]) / 2;
    let u = src - MULT * atr[i], d = src + MULT * atr[i];
    if (i > 0 && !Number.isNaN(atr[i])) {
      const u1 = Number.isNaN(up[i - 1]) ? u : up[i - 1];
      const d1 = Number.isNaN(dn[i - 1]) ? d : dn[i - 1];
      if (c[i - 1] > u1) u = Math.max(u, u1);
      if (c[i - 1] < d1) d = Math.min(d, d1);
    }
    up.push(u); dn.push(d);
    let t = i === 0 ? 1 : trend[i - 1];
    if (i > 0 && !Number.isNaN(atr[i])) {
      const u1 = Number.isNaN(up[i - 1]) ? up[i] : up[i - 1];
      const d1 = Number.isNaN(dn[i - 1]) ? dn[i] : dn[i - 1];
      t = (t === -1 && c[i] > d1) ? 1 : (t === 1 && c[i] < u1) ? -1 : t;
    }
    trend.push(t);
  }
  return { up, dn, trend, atr };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
const pc = (x, d = 1) => (x * 100).toFixed(d) + '%';

const rows = []; // 1取引 = 1行
for (const sym of SYMS) {
  const d = JSON.parse(fs.readFileSync(DIR + '/' + sym + '.json', 'utf8'));
  const { dates, closes: c, highs: h, lows: l } = d; const n = c.length;
  const tt = trendTracker(h, l, c);
  const flipUp = (i) => i > 20 && tt.trend[i] === 1 && tt.trend[i - 1] === -1;
  const flipDn = (j) => tt.trend[j] === -1 && tt.trend[j - 1] === 1;
  const mk = (i, kind) => {
    // 手仕舞い: 下降転換(線を終値で割った日)か、満期(NEXP営業日後)の早い方
    let exit = null, why = '';
    for (let j = i + 1; j < n && j <= i + NEXP; j++) { if (tt.trend[j] === -1) { exit = j; why = 'line'; break; } if (j === i + NEXP) { exit = j; why = 'exp'; } }
    const open = exit === null;           // データが足りず、まだ決着していない
    const S0 = c[i], K = S0, T0 = NEXP / 252, s0 = iv(c, i);
    const prem = bsCall(S0, K, T0, s0);
    const out = { sym, kind, date: dates[i], open, why };
    if (!open) {
      const j = exit; const Sx = c[j]; const Tr = (NEXP - (j - i)) / 252;
      const val = why === 'exp' ? Math.max(0, Sx - K) : bsCall(Sx, K, Tr, iv(c, j));
      out.stock = Sx / S0 - 1; out.call = val / prem - 1; out.days = j - i;
      // 線を使わず満期まで保有(比較用)
      if (i + NEXP < n) { out.stockHold = c[i + NEXP] / S0 - 1; out.callHold = Math.max(0, c[i + NEXP] - K) / prem - 1; }
      // 株: 満期の上限なし(線を割るまで)
      let e2 = null; for (let j2 = i + 1; j2 < n; j2++) if (tt.trend[j2] === -1) { e2 = j2; break; }
      if (e2 !== null) out.stockNoCap = c[e2] / S0 - 1;
    }
    return out;
  };
  for (let i = 21; i < n; i++) {
    if (flipUp(i)) rows.push(mk(i, 'flip'));      // 本命: 上昇転換日
    if (tt.trend[i] === 1) rows.push(mk(i, 'trendDay')); // 比較: 上昇トレンド中の毎日(転換シグナルの価値を見る)
  }
}

function stat(rs, f, label) {
  const xs = rs.filter((r) => !r.open && r[f] !== undefined && !Number.isNaN(r[f])).map((r) => r[f]);
  if (!xs.length) return `${label}: n=0`;
  const w = xs.filter((v) => v > 0), lo = xs.filter((v) => v <= 0);
  const aw = w.length ? mean(w) : 0, al = lo.length ? mean(lo) : 0;
  return `${label}: n=${xs.length} 平均${pc(mean(xs))} 中央値${pc(med(xs))} 勝率${pc(w.length / xs.length, 0)} 平均勝ち${pc(aw)} 平均負け${pc(al)} 最悪${pc(Math.min(...xs))} 最良${pc(Math.max(...xs))}`;
}
const flips = rows.filter((r) => r.kind === 'flip');
const tdays = rows.filter((r) => r.kind === 'trendDay');
console.log(`=== 条件: 上昇転換日に買い / 手仕舞い=線を終値で割った日か満期(${NEXP}営業日)の早い方 / コール=ATM・満期${NEXP}営業日(IV=HV20×1.15の仮定) / 7銘柄 ${DIR} ===`);
console.log(`上昇転換の回数: ${flips.length}回（未決着${flips.filter((r) => r.open).length}回を除く ${flips.filter((r) => !r.open).length}回）`);
console.log('\n--- 本命(上昇転換日に買い・線割れか満期で手仕舞い) ---');
console.log(stat(flips, 'stock', '株        '));
console.log(stat(flips, 'call', 'コール買い'));
console.log(`手仕舞いの内訳: 線割れ ${flips.filter((r) => !r.open && r.why === 'line').length}件 / 満期 ${flips.filter((r) => !r.open && r.why === 'exp').length}件 ／ 平均保有日数 ${mean(flips.filter((r) => !r.open).map((r) => r.days)).toFixed(0)}営業日`);
const cl = flips.filter((r) => !r.open && r.call !== undefined);
console.log(`コールで -50%以下: ${pc(cl.filter((r) => r.call <= -0.5).length / cl.length, 0)} / 全損近く(-90%以下): ${pc(cl.filter((r) => r.call <= -0.9).length / cl.length, 0)}`);
console.log('\n--- 比較: 線を使わず、転換日に買って満期まで保有 ---');
console.log(stat(flips, 'stockHold', '株        '));
console.log(stat(flips, 'callHold', 'コール買い'));
console.log('\n--- 比較: 株を、線を割るまで保有(満期の上限なし) ---');
console.log(stat(flips, 'stockNoCap', '株        '));
console.log('\n--- 比較: 上昇トレンド中の毎日に買い(転換日に限らない)・同じ手仕舞い ---');
console.log(stat(tdays, 'stock', '株        '));
console.log(stat(tdays, 'call', 'コール買い'));
console.log(stat(tdays, 'stockHold', '株(満期保有)'));
console.log(stat(tdays, 'callHold', 'コール(満期保有)'));
console.log('\n--- 銘柄別(本命: 転換日に買い) ---');
for (const s of SYMS) {
  const r = flips.filter((x) => x.sym === s);
  console.log(s, stat(r, 'stock', '株').replace('株: ', '株 '), '|', stat(r, 'call', 'C').replace('C: ', 'コール '));
}
console.log('\n--- 年ごと(本命・コール) ---');
for (const y of [...new Set(flips.map((x) => x.date.slice(0, 4)))].sort()) {
  const r = flips.filter((x) => x.date.startsWith(y));
  console.log(y, stat(r, 'stock', '株').replace('株: ', '株 '), '|', stat(r, 'call', 'C').replace('C: ', 'コール '));
}
fs.writeFileSync(DIR + '/buy_rows.json', JSON.stringify(rows));
