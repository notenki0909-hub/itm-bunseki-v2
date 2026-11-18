// 年ごとの比較: 転換日に買い(線で手仕舞い) / 転換日に買い(満期保有) / 基準(毎日買い・満期保有)
import fs from 'fs';
const DIR = process.argv[2] || 'data';
const SYMS=['QQQ','SPY','AAPL','MSFT','NVDA','AMZN','IWM'], N=110;
const ncdf=(x)=>{const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;};
const bs=(S,K,T,s)=>{if(T<=0)return Math.max(0,S-K);const sd=s*Math.sqrt(T);const d1=(Math.log(S/K)+0.5*sd*sd)/sd;return S*ncdf(d1)-K*ncdf(d1-sd);};
const hv=(c,i,w=20)=>{const r=[];for(let k=i-w+1;k<=i;k++)r.push(Math.log(c[k]/c[k-1]));const m=r.reduce((a,b)=>a+b,0)/w;return Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(w-1))*Math.sqrt(252);};
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN; const pc=(x)=>isNaN(x)?'  -  ':(x*100).toFixed(0)+'%';
const base={}; // 年 -> {stock:[],call:[]}
for(const s of SYMS){const d=JSON.parse(fs.readFileSync(DIR+'/'+s+'.json','utf8'));const c=d.closes,dt=d.dates;
 for(let i=21;i+N<c.length;i++){const y=dt[i].slice(0,4);const iv=Math.max(0.1,hv(c,i)*1.15);const p=bs(c[i],c[i],N/252,iv);(base[y]??={stock:[],call:[]});base[y].stock.push(c[i+N]/c[i]-1);base[y].call.push(Math.max(0,c[i+N]-c[i])/p-1);}}
const rows=JSON.parse(fs.readFileSync(DIR+'/buy_rows.json','utf8')).filter(r=>r.kind==='flip'&&!r.open);
console.log('年    | 株: 線で手仕舞い / 満期保有 / 基準(毎日買い) | コール: 線で手仕舞い / 満期保有 / 基準 | 回数 | 下落(基準の株が−の割合)');
for(const y of Object.keys(base).sort()){
  const r=rows.filter(x=>x.date.startsWith(y));const b=base[y];
  const hold=r.filter(x=>x.stockHold!==undefined);
  console.log(`${y} | ${pc(mean(r.map(x=>x.stock)))} / ${pc(mean(hold.map(x=>x.stockHold)))} / ${pc(mean(b.stock))} | ${pc(mean(r.map(x=>x.call)))} / ${pc(mean(hold.map(x=>x.callHold)))} / ${pc(mean(b.call))} | ${r.length} | ${pc(b.stock.filter(v=>v<0).length/b.stock.length)}`);
}
