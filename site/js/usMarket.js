// 米国株式市場(NYSE/Nasdaq)の休場日と営業日の計算(純粋関数。DOM・fetch非依存)。
// 注文内容の「満期日の候補」「2週間前の判断日」「3日前の決済日」を求めるために使う。
// 日付は "YYYY-MM-DD" の文字列で扱い、内部ではUTCの日付計算だけを行う(時刻・タイムゾーンの影響を受けない)。
// 休場日は定例の祝日のみ(年によっては追加される臨時休場や半日取引は考慮しない)。

const DAY_MS = 86400000;

export function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatYmd(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  return formatYmd(new Date(parseYmd(ymd).getTime() + n * DAY_MS));
}

// 0=日 ... 6=土
export function weekday(ymd) {
  return parseYmd(ymd).getUTCDay();
}

export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

// その月の第n週の指定曜日(例: 第3月曜)
function nthWeekday(year, month, wd, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

// その月の最終の指定曜日(例: 5月の最終月曜)
function lastWeekday(year, month, wd) {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - wd + 7) % 7;
  return new Date(last.getTime() - back * DAY_MS);
}

// 復活祭(イースター)の日曜(グレゴリオ暦。Anonymous Gregorian algorithm)
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// 固定日の祝日の振替: 土曜なら前日の金曜、日曜なら翌日の月曜に休場する。
function observed(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const wd = d.getUTCDay();
  if (wd === 6) return new Date(d.getTime() - DAY_MS);
  if (wd === 0) return new Date(d.getTime() + DAY_MS);
  return d;
}

const holidayCache = new Map();

// その年の休場日("YYYY-MM-DD")の集合。
export function usMarketHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set();
  const add = (d) => set.add(formatYmd(d));
  // 元日: 土曜にあたる年は、前年12/31(金)には休場しない(取引所の規則)。日曜なら翌月曜が休場。
  const newYear = new Date(Date.UTC(year, 0, 1));
  if (newYear.getUTCDay() !== 6) add(observed(year, 1, 1));
  add(nthWeekday(year, 1, 1, 3)); // マーティン・ルーサー・キング・デー(1月第3月曜)
  add(nthWeekday(year, 2, 1, 3)); // 大統領の日(2月第3月曜)
  add(new Date(easterSunday(year).getTime() - 2 * DAY_MS)); // グッドフライデー
  add(lastWeekday(year, 5, 1)); // メモリアルデー(5月最終月曜)
  if (year >= 2022) add(observed(year, 6, 19)); // ジューンティーンス(2022年から)
  add(observed(year, 7, 4)); // 独立記念日
  add(nthWeekday(year, 9, 1, 1)); // レイバーデー(9月第1月曜)
  add(nthWeekday(year, 11, 4, 4)); // 感謝祭(11月第4木曜)
  add(observed(year, 12, 25)); // クリスマス
  holidayCache.set(year, set);
  return set;
}

export function isTradingDay(ymd) {
  const wd = weekday(ymd);
  if (wd === 0 || wd === 6) return false;
  const year = Number(ymd.slice(0, 4));
  return !usMarketHolidays(year).has(ymd);
}

// ymdがちょうど営業日でなければ、直前の営業日にする(満期日が休場日のときは前営業日になる)。
export function previousTradingDay(ymd) {
  let d = ymd;
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

// ymdのn営業日前(nが負なら後)の営業日。ymd自身が休場日の場合は、そこから数える。
export function shiftTradingDays(ymd, n) {
  let d = ymd;
  const step = n < 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isTradingDay(d)) left--;
  }
  return d;
}

// fromの翌日から、toまで(toを含む)の営業日数。to<=fromなら0。
export function tradingDaysBetween(from, to) {
  let count = 0;
  let d = from;
  while (d < to) {
    d = addDays(d, 1);
    if (isTradingDay(d)) count++;
  }
  return count;
}

/**
 * 満期日の候補を作る。基準日(エントリー日)から minDays〜maxDays 暦日後の「金曜満期」を並べる。
 * 金曜が休場日(グッドフライデーなど)の週は、その週の前営業日(木曜)を満期日とする。
 * 実際にどの満期日が存在するかは銘柄ごとに違うため、あくまで目安(最終確認は証券会社のオプションチェーン)。
 * 各候補に、残り暦日・残り営業日・2週間(10営業日)前の判断日・3営業日前の決済日を付ける。
 * (3営業日前: 金曜満期なら同じ週の火曜日。講座の「満期日3日前に反対売買で決済」に対応)
 *
 * @param {string} asOf 基準日 "YYYY-MM-DD"
 * @returns {{expiry:string, calendarDays:number, tradingDays:number, reviewDate:string, closeDate:string}[]}
 */
export function expiryCandidates(asOf, minDays = 30, maxDays = 45) {
  const out = [];
  const start = parseYmd(asOf).getTime();
  for (let n = minDays; n <= maxDays; n++) {
    const day = addDays(asOf, n);
    if (weekday(day) !== 5) continue; // 金曜だけ
    const expiry = previousTradingDay(day);
    const calendarDays = Math.round((parseYmd(expiry).getTime() - start) / DAY_MS);
    out.push({
      expiry,
      calendarDays,
      tradingDays: tradingDaysBetween(asOf, expiry),
      reviewDate: shiftTradingDays(expiry, 10),
      closeDate: shiftTradingDays(expiry, 3),
    });
  }
  return out;
}

/**
 * 満期日の種類の目安(実際にその満期日があるかは銘柄ごとに違うため、あくまで規則による目印)。
 *  - "monthly": 月次満期。第3金曜日(その日が休場なら前日の木曜)。オプションのある銘柄なら、ほぼ確実にある。
 *  - "weekly":  週次満期。第3金曜日以外の金曜日(金曜が休場なら木曜)。週次満期がある銘柄(主要銘柄に多い)だけにある。
 *  - "multi":   金曜日以外。週に複数回満期がある銘柄(QQQ・SPYなどの一部のETF)だけにある。
 * 第3金曜日は、その月の15日〜21日のどこかにある。
 *
 * @param {string} ymd 満期日 "YYYY-MM-DD"
 * @returns {"monthly"|"weekly"|"multi"}
 */
export function expiryKind(ymd) {
  let friday = null;
  if (weekday(ymd) === 5) friday = ymd;
  else if (weekday(ymd) === 4 && !isTradingDay(addDays(ymd, 1))) friday = addDays(ymd, 1); // 金曜が休場の週は木曜が満期
  if (friday === null) return "multi";
  const day = Number(friday.slice(8, 10));
  return day >= 15 && day <= 21 ? "monthly" : "weekly";
}

export const EXPIRY_KIND_LABEL = { monthly: "月次満期", weekly: "週次満期", multi: "金曜以外" };
export const EXPIRY_KIND_NOTE = {
  monthly: "月次満期（第3金曜日）です。オプションのある銘柄なら、ほぼ確実にあります。",
  weekly: "週次満期（第3金曜日以外の金曜日）です。週次満期がある銘柄でだけ選べます（主要銘柄に多く、銘柄によってはありません）。",
  multi: "金曜日以外の満期です。週に複数回満期がある銘柄（QQQ・SPYなどの一部のETF）だけにあります。",
};
