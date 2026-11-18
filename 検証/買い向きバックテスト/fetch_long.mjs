// 長期間(約2400営業日)の日足(高値・安値・終値)を、Twelve Dataから取得して data_long/ に保存する。
// APIキーは ../../.dev.vars の TWELVEDATA_API_KEY(このツールのキー)を読む。キーは画面にも保存ファイルにも出さない。
import fs from 'fs';
const env = fs.readFileSync('../../.dev.vars', 'utf8');
const key = (env.match(/TWELVEDATA_API_KEY\s*=\s*"?([^"\r\n]+)"?/) || [])[1];
if (!key) { console.error('APIキーが見つかりません'); process.exit(1); }
const SYMS = ['QQQ', 'SPY', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'IWM'];
fs.mkdirSync('data_long', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const sym of SYMS) {
  const u = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=2400&order=ASC&apikey=${key}`;
  const res = await fetch(u);
  const j = await res.json();
  if (!j.values) { console.log(sym, 'NG', j.status, j.code, (j.message || '').replace(key, '***').slice(0, 120)); await sleep(15000); continue; }
  const v = j.values;
  const out = { symbol: sym, dates: v.map((x) => x.datetime), closes: v.map((x) => +x.close), highs: v.map((x) => +x.high), lows: v.map((x) => +x.low) };
  fs.writeFileSync(`data_long/${sym}.json`, JSON.stringify(out));
  console.log(sym, 'OK', out.dates.length, out.dates[0], '〜', out.dates[out.dates.length - 1]);
  await sleep(9000); // 無料枠の毎分の上限(8回)を避ける
}
