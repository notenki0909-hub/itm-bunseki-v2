// ブルプットのローリング(既存建玉を反対売買で決済し、新しいブルプットを新規に建てる)の損益計算(純粋関数。DOM・fetch非依存)。
//
// 計算方式(ユーザー指定 2026-11-16。証券会社(サクソバンク)のローリング注文の表示に合わせる):
//  - ローリング価格(差引) D = 新規の受取プレミアム N − 既存建玉の反対売買時の支払い B。証券会社の画面に表示される価格で、既存建玉の当初の受取プレミアムは含まれない。
//  - 通算 T = D + 当初の受取プレミアム P0(= P0 − B + N)。プラス=利確、0=損益0、マイナス=損切。
//  - ローリング後に残るのは新規建玉だけなので、新規の受取プレミアムを「何割利確」とするかで総合損益が決まる:
//      総合損益 = P0 − B + N × x    (x=利確割合。100%なら T と同じ)
//  - 損失の補えた割合 = 新規の受取(x割利確後) N×x ÷ 当初の損失(B − P0)。当初が利益(B ≤ P0)のときは「補う損失なし」。
// 金額はすべて1株あたり。100株(1契約)あたりの金額は、表示側で100倍する。

/** 金額の符号から、利確/損益0/損切を判定する(小数第2位で丸めてから判定)。 */
export function judgeRoll(value) {
  const r = Math.round(value * 100) / 100;
  if (r > 0) return { level: "profit", word: "利確" };
  if (r === 0 || Math.abs(r) < 1e-9) return { level: "zero", word: "損益0" };
  return { level: "loss", word: "損切" };
}

function coverOf(loss, newProfit) {
  if (!(loss > 0)) return null; // 当初が利益(または損益0)のときは、補う損失がない
  return { ratio: newProfit / loss, covered: Math.min(newProfit, loss), remaining: Math.max(0, loss - newProfit), loss };
}

// 簡易版・詳細版に共通の計算。金額は「1株あたり×枚数」の合計。
//  p0=既存1組あたりの当初の受取 / b=既存1組あたりの反対売買の支払い / n=新規1組あたりの受取 / x=新規の利確割合(0〜1) / q0=既存の枚数 / q1=新規の枚数
function rollCore({ p0, b, n, x, q0, q1 }) {
  const realized = q0 * (p0 - b); // 既存建玉の決済損益の合計(マイナス=損失)
  const newPrem = q1 * n; // 新規の受取の合計(注文全体)
  const net = newPrem - q0 * b; // ローリング価格(差引)。新規の受取 − 反対売買の支払い。当初の受取は含まない
  const t100 = net + q0 * p0;
  const total = realized + newPrem * x;
  return {
    realized, newPrem, net,
    t100, judge100: judgeRoll(t100),
    total, judgeTotal: judgeRoll(total),
    newProfit: newPrem * x, // 新規を利確したときの利益(合計)
    newBuybackPerSpread: n * (1 - x), // 新規1組あたりの買い戻しの指値
    newBuybackTotal: newPrem * (1 - x),
    cover: coverOf(-realized, newPrem * x),
  };
}

/**
 * 簡易版: 受取・支払いの数字と枚数から、総合損益を計算する(権利行使価格は使わない)。
 * 枚数が1・1なら、既存1枚を決済し、新規の注文全体の受取を n として入力した計算と同じ。
 * @param {{p0:number, b:number, n:number, x:number, q0?:number, q1?:number}} p
 */
export function rollSimple({ p0, b, n, x, q0 = 1, q1 = 1 }) {
  return rollCore({ p0, b, n, x, q0, q1 });
}

/**
 * 詳細版: 権利行使価格と枚数も使う。金額は「1株あたり×枚数」の合計(100倍すれば、ドル)。
 * @param {object} p
 * @param {number} p.oldSell 既存の売り権利行使価格 / p.oldBuy 既存の買い権利行使価格 / p.q0 既存の枚数
 * @param {number} p.newSell 新規の売り権利行使価格 / p.newBuy 新規の買い権利行使価格 / p.q1 新規の枚数
 * @param {number} p.p0 既存1組あたりの当初の受取 / p.b 既存1組あたりの反対売買の支払い / p.n 新規1組あたりの受取 / p.x 新規の利確割合(0〜1)
 * @returns {{errors:string[], ...}} errors が空でないときは、計算していない
 */
export function rollDetail({ oldSell, oldBuy, q0, newSell, newBuy, q1, p0, b, n, x }) {
  const errors = [];
  if (!(oldSell > 0) || !(oldBuy > 0)) errors.push("既存建玉の売り・買いの権利行使価格を入力してください。");
  else if (!(oldSell > oldBuy)) errors.push("既存建玉は、売りの権利行使価格が買いより高い（ブルプット）ように入力してください。");
  if (!(newSell > 0) || !(newBuy > 0)) errors.push("新規の売り・買いの権利行使価格を入力してください。");
  else if (!(newSell > newBuy)) errors.push("新規は、売りの権利行使価格が買いより高い（ブルプット）ように入力してください。");
  if (!(q0 > 0) || !(q1 > 0)) errors.push("枚数は1以上で入力してください。");
  if (errors.length) return { errors };

  const core = rollCore({ p0, b, n, x, q0, q1 });
  const { realized, newPrem } = core;
  const widthOld = oldSell - oldBuy;
  const widthNew = newSell - newBuy;
  const maxProfit = realized + newPrem; // 新規を満期まで持ち、株価が新しい売りの権利行使価格以上のとき
  const maxLoss = realized + newPrem - q1 * widthNew; // 株価が新しい買いの権利行使価格以下のとき
  let breakEven = null;
  let breakEvenNote = "";
  if (maxProfit < 0) breakEvenNote = "どの株価でも、マイナスです";
  else if (maxLoss >= 0) breakEvenNote = "どの株価でも、損失になりません";
  else breakEven = newSell - maxProfit / q1; // 新しい買いと売りの権利行使価格の間で、通算損益が0になる株価
  return {
    errors,
    ...core,
    widthOld, widthNew,
    oldMaxLoss: q0 * (widthOld - p0), // 参考: 損切りせず、既存建玉を満期まで持った場合の最大損失
    maxProfit, maxLoss, breakEven, breakEvenNote,
    // 満期時の株価Sでの通算損益(新規を満期まで持った場合)
    payoffAt(S) {
      return realized + q1 * (n - Math.max(newSell - S, 0) + Math.max(newBuy - S, 0));
    },
  };
}
