// 米国債の利回り(無リスク金利)を、米国財務省の公開データから取得して返すCloudflare Pages Function。
// 出典: U.S. Department of the Treasury「Daily Treasury Par Yield Curve Rates」(無料・APIキー不要)。
// 買いページが、満期の長さに合わせて補間し、金利(年%)の入力欄に、自動で入れるために使う。
//
// - 取得はサーバー側で行い、KV(PRICE_CACHE)に保存する。その日(米国東部時間の日付)の最初の利用のときだけ財務省にアクセスし、
//   同じ日の2回目以降は、保存した値を返す(財務省の更新は、営業日に1回のため)。利用がない日は、アクセスしない。
// - KVが未設定でも動く(その場合は、毎回取得する)。
// - 取得に失敗したときは、古い保存値があれば、それを返す。なければ、エラー(クライアントは手入力に戻る)。
// - 個人情報・入力内容は、一切、外部に送らない(公開の金利を、取得するだけ)。
const CACHE_KEY = "treasury-yield-curve";
// 米国東部時間の日付(YYYY-MM-DD)。保存した日と同じなら、再取得しない
const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = (ms) => ET_DAY.format(new Date(ms));
const BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=";

// タグ名(BC_1MONTH・BC_1_5MONTH・BC_1YEAR など)を、月数に直す
function monthsOf(tag) {
  const m = tag.match(/^BC_(\d+(?:_\d+)?)(MONTH|YEAR)$/);
  if (!m) return null;
  const n = Number(m[1].replace("_", "."));
  return m[2] === "YEAR" ? n * 12 : n;
}

function parseXml(xml) {
  const entries = xml.split("<m:properties>").slice(1).map((x) => x.split("</m:properties>")[0]);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  const dateMatch = last.match(/<d:NEW_DATE[^>]*>([^<]*)</);
  const points = [];
  for (const mm of last.matchAll(/<d:(BC_[0-9_]+(?:MONTH|YEAR))[^>]*>([^<]*)</g)) {
    const months = monthsOf(mm[1]);
    const rate = Number(mm[2]);
    if (months !== null && Number.isFinite(rate) && mm[2].trim() !== "") points.push({ months, rate });
  }
  points.sort((a, b) => a.months - b.months);
  if (!dateMatch || points.length < 3) return null;
  return { date: dateMatch[1].slice(0, 10), points: points.filter((p) => p.months <= 60) };
}

async function fetchMonth(ym) {
  const res = await fetch(BASE + ym);
  if (!res.ok) return null;
  return parseXml(await res.text());
}

export async function onRequestGet(context) {
  const { env } = context;
  const kv = env.PRICE_CACHE;
  const now = Date.now();
  const cached = kv ? await kv.get(CACHE_KEY, "json") : null;
  if (cached && cached.fetchedDay === etDay(now)) return json(cached, 200);

  let result = null;
  try {
    const d = new Date(now);
    const ym = (dt) => `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    result = await fetchMonth(ym(d));
    if (!result) { // 月初で、まだ今月のデータがないときは、前の月
      const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      result = await fetchMonth(ym(prev));
    }
  } catch (e) {
    result = null;
  }
  if (!result) {
    if (cached) return json(cached, 200); // 失敗したときは、古い保存値
    return json({ error: "rates unavailable" }, 502);
  }
  const body = { ...result, fetchedAt: now, fetchedDay: etDay(now), source: "U.S. Treasury Daily Par Yield Curve Rates" };
  if (kv) context.waitUntil(kv.put(CACHE_KEY, JSON.stringify(body), { expirationTtl: 7 * 24 * 60 * 60 }));
  return json(body, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
