import fs from 'fs';
const DIR = process.argv[2] || 'data';
const SYMS=['QQQ','SPY','AAPL','MSFT','NVDA','AMZN','IWM'], N=110;
const ncdf=(x)=>{const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;};
const bs=(S,K,T,s)=>{if(T<=0)return Math.max(0,S-K);const sd=s*Math.sqrt(T);const d1=(Math.log(S/K)+0.5*sd*sd)/sd;return S*ncdf(d1)-K*ncdf(d1-sd);};
const hv=(c,i,w=20)=>{const r=[];for(let k=i-w+1;k<=i;k++)r.push(Math.log(c[k]/c[k-1]));const m=r.reduce((a,b)=>a+b,0)/w;return Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(w-1))*Math.sqrt(252);};
const mean=a=>a.reduce((x,y)=>x+y,0)/(a.length||1); const pc=(x)=>(x*100).toFixed(1)+'%';
const st=[],ca=[];
for(const s of SYMS){const d=JSON.parse(fs.readFileSync(DIR+'/'+s+'.json','utf8'));const c=d.closes;
 for(let i=21;i+N<c.length;i++){const iv=Math.max(0.1,hv(c,i)*1.15);const p=bs(c[i],c[i],N/252,iv);st.push(c[i+N]/c[i]-1);ca.push(Math.max(0,c[i+N]-c[i])/p-1);}}
console.log('基準: シグナルなし・毎日買って満期('+N+'営業日)まで保有 n='+st.length);
console.log(' 株 平均'+pc(mean(st))+' 勝率'+pc(st.filter(v=>v>0).length/st.length)+' / コール(ATM) 平均'+pc(mean(ca))+' 勝率'+pc(ca.filter(v=>v>0).length/ca.length));
const rows=JSON.parse(fs.readFileSync(DIR+'/buy_rows.json','utf8')).filter(r=>r.kind==='flip'&&!r.open&&r.stockHold!==undefined);
console.log('転換日の買い n='+rows.length+': 線で手仕舞うより、満期まで持った方が良かった割合 株'+pc(rows.filter(r=>r.stockHold>r.stock).length/rows.length)+' / コール'+pc(rows.filter(r=>r.callHold>r.call).length/rows.length));
const pd=rows.map(r=>r.call/r.days*100), hd=rows.map(r=>r.callHold/110*100);
console.log('1営業日あたりの平均損益(コール): 線で手仕舞い '+mean(pd).toFixed(2)+'%/日(保有'+mean(rows.map(r=>r.days)).toFixed(0)+'日) / 満期保有 '+mean(hd).toFixed(2)+'%/日(110日)');
const worstStock=rows.map(r=>r.stock),worstHold=rows.map(r=>r.stockHold);
console.log('株の最悪: 線で手仕舞い '+pc(Math.min(...worstStock))+' / 満期保有 '+pc(Math.min(...worstHold))+' ; 下位10%平均: '+pc(mean(worstStock.sort((a,b)=>a-b).slice(0,8)))+' / '+pc(mean(worstHold.sort((a,b)=>a-b).slice(0,8))));
