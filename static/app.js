/* ═══════════════════════════════════════════════════════════════════════════
   Kudagu Kaapi CRM — app.js  v3.0
   Features: delete orders/customers, 3-dot order menu, inline status,
   "completed" status with payment method, active/completed order split,
   quick status on dashboard, delivered-on-record toggle, merged dash cards.
═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const DEFAULT_SIZES = ['100g','250g','500g','1kg'];
const VL  = {'100g':'100g','250g':'250g','500g':'500g','1kg':'1 kg'};
const W   = {'100g':7,'250g':10,'500g':14,'1kg':30};
const SIZE_GRAMS = {'100g':100,'250g':250,'500g':500,'1kg':1000};

const CHANNELS = [
  {id:'retail',   label:'Retail',   sub:'In-store / offline'},
  {id:'website',  label:'Website',  sub:'Online store'},
  {id:'whatsapp', label:'WhatsApp', sub:'Direct message'},
];
const CHANNEL_MAP = Object.fromEntries(CHANNELS.map(c=>[c.id,c]));

// Statuses — "completed" replaces delivered/payment_received
const STATUS_OPTS = {
  online: [
    {id:'pending',   label:'Pending'},
    {id:'confirmed', label:'Confirmed'},
    {id:'shipped',   label:'Shipped'},
    {id:'completed', label:'Completed'},
    {id:'cancelled', label:'Cancelled'},
    {id:'returned',  label:'Returned'},
  ],
  retail: [
    {id:'confirmed', label:'Confirmed'},
    {id:'completed', label:'Completed'},
    {id:'cancelled', label:'Cancelled'},
  ],
};
function statusOpts(ch){ return ch==='retail'?STATUS_OPTS.retail:STATUS_OPTS.online; }

const PAYMENT_METHODS = ['Cash','UPI','Card','Bank Transfer','Other'];
const EXAMPLE_AWB = 'AWB123456789';

const STATUS_CLS = {
  pending:  'st-pending',
  confirmed:'st-confirmed',
  shipped:  'st-shipped',
  completed:'st-completed',
  cancelled:'st-cancelled',
  returned: 'st-returned',
};
const STATUS_LABEL = {
  pending:'Pending',confirmed:'Confirmed',shipped:'Shipped',
  completed:'Completed',cancelled:'Cancelled',returned:'Returned',
};

const DEFAULT_WA_TPL = `Hi {{customer_name}}, your last order was on {{last_order_date}}. Would you like to order {{product_name}} ({{variant}}) again? We'd love to offer you a great deal!`;

const WA_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;

// ─── STATE ───────────────────────────────────────────────────────────────────
let S = null;
let _lastActionEl = null;
let _lastActionAt = 0;
let _uiReqDepth = 0;
let _uiLoadingEl = null;

function _isActionEl(el){
  if(!el) return false;
  return !!el.closest('button, .btn, .nb, .bnav-item, .smenu-item');
}
function _setUiLoading(el, on){
  if(!el) return;
  if(on){
    el.classList.add('is-loading');
    if(el.tagName==='BUTTON'){
      el.dataset.wasDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    }else{
      el.setAttribute('aria-disabled','true');
    }
    return;
  }
  el.classList.remove('is-loading');
  if(el.tagName==='BUTTON'){
    const wasDisabled = el.dataset.wasDisabled==='1';
    el.disabled = wasDisabled;
    delete el.dataset.wasDisabled;
  }else{
    el.removeAttribute('aria-disabled');
  }
}
function _beginUiRequest(){
  if(_uiReqDepth===0){
    const recent = _lastActionEl && (Date.now()-_lastActionAt<=2200) ? _lastActionEl : null;
    if(recent){
      _uiLoadingEl = recent;
      _setUiLoading(_uiLoadingEl, true);
    }
  }
  _uiReqDepth += 1;
}
function _endUiRequest(){
  _uiReqDepth = Math.max(0, _uiReqDepth - 1);
  if(_uiReqDepth===0){
    if(_uiLoadingEl) _setUiLoading(_uiLoadingEl, false);
    _uiLoadingEl = null;
    _lastActionEl = null;
    _lastActionAt = 0;
  }
}

document.addEventListener('click', (e)=>{
  const t=e.target;
  if(!(t instanceof Element)) return;
  const actionEl=t.closest('button, .btn, .nb, .bnav-item, .smenu-item');
  if(!actionEl || !_isActionEl(actionEl)) return;
  _lastActionEl = actionEl;
  _lastActionAt = Date.now();
}, true);

const _nativeFetch = window.fetch.bind(window);
window.fetch = async (...args)=>{
  const track = !!(_lastActionEl && (Date.now()-_lastActionAt<=2200));
  if(track) _beginUiRequest();
  try{
    return await _nativeFetch(...args);
  }finally{
    if(track) _endUiRequest();
  }
};

// ─── API ─────────────────────────────────────────────────────────────────────
const api = {
  async get(p){ const r=await fetch(p); if(!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); },
  async post(p,b){ const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(!r.ok){const m=await r.text();throw new Error(m);} return r.json(); },
  async put(p,b){ const r=await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(!r.ok){const m=await r.text();throw new Error(m);} return r.json(); },
  async del(p){ const r=await fetch(p,{method:'DELETE'}); if(!r.ok) throw new Error(`DELETE ${p} → ${r.status}`); return r.json(); },
};
async function postJSONWithTimeout(path, body, timeoutMs=45000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(path,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{}),
      signal: ctrl.signal,
    });
    if(!r.ok){ const m=await r.text(); throw new Error(m||`POST ${path} → ${r.status}`); }
    return r.json();
  }catch(e){
    if(e.name==='AbortError') throw new Error('Sync timed out. Please try again.');
    throw e;
  }finally{
    clearTimeout(t);
  }
}

// ─── PRICING ─────────────────────────────────────────────────────────────────
function getPricing(pid,sz){ const p=S.products.find(x=>x.id===pid); if(!p||!p.pricing||!p.pricing[sz]) return null; return p.pricing[sz]; }
function getSalePrice(pid,sz,ch){ const pr=getPricing(pid,sz); if(!pr||!pr.salePrices) return 0; return parseFloat(pr.salePrices[ch]||pr.salePrices.retail||0); }
function getTotalCost(pid,sz){ const pr=getPricing(pid,sz); if(!pr) return 0; return (pr.expenses||[]).reduce((s,e)=>s+(parseFloat(e.cost)||0),0); }
function orderRevenue(o){ return getSalePrice(o.prodId,o.variant,o.channel||'retail')*(o.qty||1); }
function paymentGatewayCommissionPct(){
  const raw=parseFloat(S?.shippingProfile?.paymentGatewayCommissionPct);
  return Number.isFinite(raw)&&raw>=0 ? raw : 3;
}
function websiteGatewayCommission(amount, channel){
  if((channel||'').toLowerCase()!=='website') return 0;
  const pct=paymentGatewayCommissionPct();
  return (parseFloat(amount||0)||0) * (pct/100);
}
function orderCommissionBreakup(o){
  const rev=orderRevenue(o);
  const manual=parseFloat(o.commission||0)||0;
  const gateway=websiteGatewayCommission(rev,o.channel||'retail');
  return {manual,gateway,total:manual+gateway};
}
function orderProfit(o){
  const sp=getSalePrice(o.prodId,o.variant,o.channel||'retail'); if(!sp) return null;
  const comm=orderCommissionBreakup(o).total;
  return (sp-getTotalCost(o.prodId,o.variant))*(o.qty||1)-(parseFloat(o.discount||0))-comm;
}
// Only completed orders count toward revenue/profit
function isCompleted(o){ return o.status==='completed'; }

// ─── FINANCIALS ──────────────────────────────────────────────────────────────
function mRange(off=0){ const n=new Date(),y=n.getFullYear(),m=n.getMonth()+off; return{s:new Date(y,m,1).getTime(),e:new Date(y,m+1,1).getTime()}; }
function yRange(off=0){ const y=new Date().getFullYear()+off; return{s:new Date(y,0,1).getTime(),e:new Date(y+1,0,1).getTime()}; }
function sumRev(os){ return os.filter(isCompleted).reduce((s,o)=>s+orderRevenue(o),0); }
function sumProf(os){ return os.filter(isCompleted).reduce((s,o)=>{const p=orderProfit(o);return s+(p??0);},0); }
function calcFin(){
  const cm=mRange(0),pm=mRange(-1),cy=yRange(0),py=yRange(-1);
  const oM=S.orders.filter(o=>o.at>=cm.s&&o.at<cm.e);
  const oPM=S.orders.filter(o=>o.at>=pm.s&&o.at<pm.e);
  const oY=S.orders.filter(o=>o.at>=cy.s&&o.at<cy.e);
  const oPY=S.orders.filter(o=>o.at>=py.s&&o.at<py.e);
  const rM=sumRev(oM),rPM=sumRev(oPM),rY=sumRev(oY),rPY=sumRev(oPY);
  const allComp=S.orders.filter(isCompleted);
  return{
    revAll:sumRev(S.orders),profAll:sumProf(S.orders),
    revM:rM,profM:sumProf(oM),
    activeCount:S.orders.filter(o=>!isCompleted(o)&&o.status!=='cancelled'&&o.status!=='returned').length,
    completedToday:S.orders.filter(o=>isCompleted(o)&&o.at>=new Date().setHours(0,0,0,0)).length,
    mom:rPM>0?((rM-rPM)/rPM*100):null,
    yoy:rPY>0?((rY-rPY)/rPY*100):null,
  };
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────
function fd(ts){ return new Date(ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function fC(v){ return v==null?'—':'₹'+Number(v).toFixed(0); }
function fPct(v){ if(v==null)return'—';return(v>=0?'+':'')+v.toFixed(1)+'%'; }
function pCls(v){ return v==null?'neutral':v>=0?'up':'down'; }
function pArr(v){ return v==null?'':v>=0?' ↑':' ↓'; }
function todayISO(){ const n=new Date(); return`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; }
function chBadge(ch){ const l={retail:'Retail',website:'Website',whatsapp:'WhatsApp'}; return`<span class="ch-badge ch-badge--${ch}">${l[ch]||ch}</span>`; }
function stBadge(st){ return`<span class="status-badge ${STATUS_CLS[st]||''}">${STATUS_LABEL[st]||st}</span>`; }
function variantToGrams(v){
  if(SIZE_GRAMS[v]) return SIZE_GRAMS[v];
  const s=String(v||'').trim().toLowerCase();
  if(s.endsWith('kg')){ const n=parseFloat(s.replace('kg','').trim()); return isNaN(n)?0:n*1000; }
  if(s.endsWith('g')){ const n=parseFloat(s.replace('g','').trim()); return isNaN(n)?0:n; }
  return 0;
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
function toast(msg,type=''){ const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=msg; g('toasts').appendChild(el); setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},2800); }

// ─── MODAL ───────────────────────────────────────────────────────────────────
function openModal(html,size=''){
  const box=g('modal-box'); box.className='modal-box'+(size?' modal-'+size:''); box.innerHTML=html;
  g('modal').classList.add('open');
}
function closeModal(){ g('modal').classList.remove('open'); g('modal-box').innerHTML=''; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });

// ─── CONTEXT MENU (3-dot) ────────────────────────────────────────────────────
let _menuOpen = null;
function positionCtxMenu(menu, anchorRect){
  const gap = 6;
  const pad = 8;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  // Allow menu to shrink on narrow screens.
  menu.style.maxWidth = `calc(100vw - ${pad * 2}px)`;
  let menuW = menu.offsetWidth || 180;
  let menuH = menu.offsetHeight || 120;

  // Prefer right-aligned to trigger; clamp within viewport.
  let left = anchorRect.right - menuW;
  if(left < pad){
    left = anchorRect.left;
  }
  left = Math.max(pad, Math.min(left, vw - menuW - pad));

  // Prefer below trigger; flip above if needed; clamp within viewport.
  let top = anchorRect.bottom + gap;
  if(top + menuH > vh - pad){
    top = anchorRect.top - menuH - gap;
  }
  top = Math.max(pad, Math.min(top, vh - menuH - pad));

  // .ctx-menu uses `position: fixed`, so use viewport coordinates directly.
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  // Second pass after layout/animation start to avoid occasional mis-measurement.
  requestAnimationFrame(()=>{
    menuW = menu.offsetWidth || menuW;
    menuH = menu.offsetHeight || menuH;
    let l = parseFloat(menu.style.left) || left;
    let t = parseFloat(menu.style.top) || top;
    l = Math.max(pad, Math.min(l, vw - menuW - pad));
    t = Math.max(pad, Math.min(t, vh - menuH - pad));
    menu.style.left = `${l}px`;
    menu.style.top  = `${t}px`;
  });
}
function openOrderMenu(oid, btnEl){
  // close any open menu first
  closeOrderMenu();
  const ord=S.orders.find(o=>o.id===oid);
  const canShip=!!ord && (ord.channel==='website' || ord.channel==='whatsapp');
  const menu=document.createElement('div');
  menu.className='ctx-menu'; menu.id='ctx-menu';
  menu.innerHTML=`
    <button class="ctx-item" onclick="closeOrderMenu();openEditOrder(${oid})">Edit Order</button>
    ${canShip
      ? `<button class="ctx-item" onclick="closeOrderMenu();shippingLabel(${oid},'download')">Download Label</button>
         <button class="ctx-item" onclick="closeOrderMenu();shippingLabel(${oid},'print')">Print Label</button>`
      : `<div class="ctx-item" style="cursor:default;opacity:.65">Label - Not Valid</div>`
    }
    <hr class="ctx-divider">
    <button class="ctx-item ctx-danger" onclick="closeOrderMenu();deleteOrder(${oid})">Delete Order</button>`;
  document.body.appendChild(menu);
  // position near the button (always keep within viewport)
  const r=btnEl.getBoundingClientRect();
  positionCtxMenu(menu, r);
  _menuOpen=oid;
  setTimeout(()=>document.addEventListener('click',_closeMenuOutside,{once:true}),10);
}
function _closeMenuOutside(e){ if(!e.target.closest('#ctx-menu')) closeOrderMenu(); }
function closeOrderMenu(){ const m=g('ctx-menu'); if(m) m.remove(); _menuOpen=null; }
function safeDateISO(ts){
  const d=ts?new Date(ts):new Date();
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function isMissingFullAddress(c){
  const a=String(c?.address||'').trim();
  return !a || a.length < 10;
}
function awbBarcodeSvg(awb){
  const s=String(awb||'').trim().toUpperCase();
  if(!s) return '';
  // Lightweight deterministic bar pattern (visual barcode for AWB text).
  let bits='1010';
  for(let i=0;i<s.length;i++){
    const b=s.charCodeAt(i).toString(2).padStart(8,'0');
    bits += b + '0';
  }
  bits += '1101';
  const module=2, h=56, w=bits.length*module;
  let x=0, rects='';
  for(const bit of bits){
    if(bit==='1') rects += `<rect x="${x}" y="0" width="${module}" height="${h}" fill="#111"/>`;
    x += module;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h+18}" viewBox="0 0 ${w} ${h+18}">${rects}<text x="${w/2}" y="${h+14}" font-size="12" text-anchor="middle" fill="#111" font-family="Arial, sans-serif">${esc(s)}</text></svg>`;
}
function awbQrImg(awb){
  const txt=encodeURIComponent(String(awb||'').trim());
  return `<img alt="AWB QR" src="https://quickchart.io/qr?size=170&text=${txt}" style="width:170px;height:170px;object-fit:contain" />`;
}
function waPhoneForOrder(order){
  const raw=String(order?.cphone||'').replace(/\D/g,'');
  if(!raw) return '';
  if(raw.length===10) return `91${raw}`;
  if(raw.length===12 && raw.startsWith('91')) return raw;
  if(raw.length>10) return raw;
  return '';
}
function buildShippedWaText(order, shipping){
  const track=shipping?.trackingUrl ? `\nTracking Link: ${shipping.trackingUrl}` : '';
  return `Hi ${order.cname}, your order #${order.id} for ${order.prod} has been shipped on ${shipping.shipDate}.\nAWB: ${shipping.awb}\nCourier: ${shipping.courier}${track}`;
}
function buildTrackingLink(template, awb){
  const tpl=String(template||'').trim();
  const code=encodeURIComponent(String(awb||'').trim());
  if(!tpl || !code) return '';
  return tpl
    .replace(/\{\{\s*awb\s*\}\}/ig, code)
    .replace(/\{\s*awb\s*\}/ig, code)
    .replace(/__awb__/ig, code)
    .replace(/:awb\b/ig, code);
}
function getTrackingTemplateMap(){
  return (S.shippingProfile && S.shippingProfile.trackingTemplates) ? S.shippingProfile.trackingTemplates : {};
}
function normalizeCodeType(v){
  return String(v||'').toLowerCase()==='qr' ? 'qr' : 'barcode';
}
function getCourierConfigs(){
  const prof=S.shippingProfile||{};
  const out=[];
  const seen=new Set();
  const raw=Array.isArray(prof.couriers)?prof.couriers:[];
  raw.forEach(row=>{
    const name=String(row?.name||'').trim();
    if(!name) return;
    const key=name.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      trackingTemplate:String(row?.trackingTemplate||'').trim(),
      codeType:normalizeCodeType(row?.codeType),
    });
  });
  if(!out.length){
    const map=getTrackingTemplateMap();
    Object.keys(map).forEach(name=>{
      const n=String(name||'').trim();
      if(!n) return;
      out.push({name:n,trackingTemplate:String(map[name]||'').trim(),codeType:'barcode'});
    });
  }
  return out;
}
function courierConfigByName(courier){
  const key=String(courier||'').trim().toLowerCase();
  if(!key) return null;
  return getCourierConfigs().find(c=>c.name.toLowerCase()===key) || null;
}
function trackingTemplateForCourier(courier){
  const cfg=courierConfigByName(courier);
  if(cfg && cfg.trackingTemplate) return cfg.trackingTemplate;
  const rawMap=getTrackingTemplateMap();
  const direct=rawMap[courier];
  if(direct) return direct;
  const key=String(courier||'').trim().toLowerCase();
  if(!key) return '';
  const match=Object.keys(rawMap).find(k=>String(k||'').trim().toLowerCase()===key);
  return match ? String(rawMap[match]||'').trim() : '';
}
function defaultCodeTypeForCourier(courier){
  const cfg=courierConfigByName(courier);
  return cfg ? normalizeCodeType(cfg.codeType) : 'barcode';
}
function courierSelectOptions(selected=''){
  const cur=String(selected||'').trim();
  const opts=getCourierConfigs();
  if(!opts.length){
    return `<option value="">No couriers configured</option>`;
  }
  const hasCur=!!cur && !opts.some(o=>o.name.toLowerCase()===cur.toLowerCase());
  const base=`<option value="">Select courier</option>${opts.map(o=>`<option value="${esc(o.name)}" ${cur.toLowerCase()===o.name.toLowerCase()?'selected':''}>${esc(o.name)}</option>`).join('')}`;
  return hasCur ? `${base}<option value="${esc(cur)}" selected>${esc(cur)}</option>` : base;
}
function buildLabelHtml(order, customer, ship){
  const prof=S.shippingProfile||{};
  const missingAddr=isMissingFullAddress(customer);
  const codeType=(ship.codeType||'barcode')==='qr'?'qr':'barcode';
  const codeHtml=codeType==='qr'?awbQrImg(ship.awb):awbBarcodeSvg(ship.awb);
  const productLine=`${order.prod} · ${VL[order.variant]||order.variant} × ${order.qty}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shipping Label - Order #${order.id}</title>
  <style>
  body{font-family:Arial,sans-serif;background:#f6f6f6;padding:20px}
  .label{width:760px;max-width:100%;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:10px;padding:18px}
  .row{display:flex;gap:16px}.col{flex:1}.h{font-size:12px;color:#777;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
  .v{font-size:14px;line-height:1.5;color:#111}.box{border:1px solid #e5e5e5;border-radius:8px;padding:12px}
  .warn{margin-bottom:10px;padding:10px;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:8px}
  .meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.pill{padding:4px 10px;border:1px solid #ddd;border-radius:20px;font-size:12px}
  .barcode{margin-top:12px;text-align:center}
  </style></head><body>
  <div class="label">
    ${missingAddr?`<div class="warn">Warning: Customer record does not have full address.</div>`:''}
    <div class="meta">
      <span class="pill">Order #${order.id}</span>
      <span class="pill">Courier: ${esc(ship.courier)}</span>
      <span class="pill">Ship Date: ${esc(ship.shipDate)}</span>
      <span class="pill">AWB: ${esc(ship.awb)}</span>
    </div>
    <div class="row">
      <div class="col box">
        <div class="h">From</div>
        <div class="v"><strong>${esc(prof.companyName||'')}</strong><br>${esc(prof.address||'')}<br>${esc(prof.phone||'')}</div>
      </div>
      <div class="col box">
        <div class="h">To</div>
        <div class="v"><strong>${esc(customer.name||order.cname||'')}</strong><br>${esc(customer.address||'')}<br>${esc(customer.area||order.carea||'')}<br>${esc(customer.phone||order.cphone||'')}</div>
      </div>
    </div>
    <div class="box" style="margin-top:12px">
      <div class="h">Shipment Details</div>
      <div class="v">${esc(productLine)}<br>Channel: ${esc(order.channel||'retail')}<br>Packed by: ${esc(prof.companyName||'')}</div>
    </div>
    <div class="barcode">${codeHtml}</div>
  </div></body></html>`;
}
async function copyTrackingLinkFromModal(){
  const link=(g('ship-track-link')?.value||'').trim();
  if(!link){ toast('Tracking link not available. Set courier template first.','err'); return; }
  try{
    await navigator.clipboard.writeText(link);
    toast('Tracking link copied','ok');
  }catch(e){
    toast('Could not copy link','err');
  }
}
function openShippedStatusPopup(oid, from='orders'){
  const order=S.orders.find(o=>o.id===oid); if(!order){ toast('Order not found','err'); return; }
  const ship=order.shipping||{};
  const courierVal=(ship.courier||'').trim();
  openModal(`
    <div class="modal-title">Mark as Shipped</div>
    <div style="font-size:12px;color:var(--text-3);margin-top:6px">Order #${order.id} · ${esc(order.cname)} · ${esc(order.prod)}</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
      <div class="fg"><label>Shipped Date <span class="req">*</span></label><input id="ship-date" type="date" value="${esc(ship.shipDate||safeDateISO(Date.now()))}"></div>
      <div class="fr">
        <div class="fg"><label>AWB Number <span class="req">*</span></label><input id="ship-awb" type="text" value="${esc(ship.awb||'')}" placeholder="Courier AWB" oninput="updateTrackingLinkPreview()"></div>
        <div class="fg"><label>Courier <span class="req">*</span></label><select id="ship-courier" onchange="onCourierInputChange()">${courierSelectOptions(courierVal)}</select></div>
      </div>
      <div class="fg">
        <label>Tracking Link</label>
        <div class="fr" style="grid-template-columns:1fr auto">
          <input id="ship-track-link" type="text" readonly value="${esc(ship.trackingUrl||'')}" placeholder="Auto-generated from template + AWB">
          <button class="btn btn-s" onclick="copyTrackingLinkFromModal()">Copy</button>
        </div>
        <div id="ship-track-note" style="font-size:11.5px;color:var(--text-3);margin-top:4px">No template configured for this courier. Set it in Settings → Shipping.</div>
      </div>
      <div style="font-size:11.5px;color:var(--text-3)">AWB code format is auto-picked from courier settings (QR/Barcode).</div>
      <div class="toggle-row">
        <div>
          <div class="toggle-lbl">Notify Customer on WhatsApp</div>
          <div class="toggle-sub">Open prefilled shipped message after save</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="ship-wa-toggle" checked>
          <span class="toggle-track"></span>
        </label>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1;background:var(--blue)" onclick="submitShippedStatus(${oid},'${from}')">Confirm Shipped</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
  updateTrackingLinkPreview();
}
async function submitShippedStatus(oid, from='orders'){
  const order=S.orders.find(o=>o.id===oid); if(!order){ toast('Order not found','err'); return; }
  const shipDate=(g('ship-date')?.value||'').trim();
  const awb=(g('ship-awb')?.value||'').trim();
  const courier=(g('ship-courier')?.value||'').trim();
  if(!shipDate || !awb || !courier){ toast('Shipped date, AWB and courier are required','err'); return; }
  const codeType=defaultCodeTypeForCourier(courier);
  const trackingUrl=buildTrackingLink(trackingTemplateForCourier(courier), awb);
  const shipping={shipDate,awb,courier,codeType,trackingUrl,updatedAt:Date.now()};
  const doWa=!!g('ship-wa-toggle')?.checked;
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status:'shipped',shipping});
    syncOrder(updated); closeModal();
    rOrders(); rDash(); updBadge();
    toast('Order marked as shipped','ok');
    if(doWa){
      const p=waPhoneForOrder(updated);
      if(p){
        const text=buildShippedWaText(updated, shipping);
        window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`,'_blank');
      }else{
        toast('Customer phone is invalid for WhatsApp','err');
      }
    }
  }catch(e){ toast('Error: '+e.message,'err'); }
}
function updateTrackingLinkPreview(){
  const courier=(g('ship-courier')?.value||'').trim();
  const awb=(g('ship-awb')?.value||'').trim();
  const tpl=trackingTemplateForCourier(courier);
  const link=buildTrackingLink(tpl, awb);
  const inp=g('ship-track-link');
  const note=g('ship-track-note');
  if(inp) inp.value=link;
  if(note){
    if(!tpl) note.textContent='No template configured for this courier. Set it in Settings → Shipping.';
    else if(!link) note.textContent='Enter AWB number to generate tracking link.';
    else note.textContent='Tracking link ready to share with customer.';
    note.style.color=!tpl?'var(--amber)':(link?'var(--green)':'var(--text-3)');
  }
}
function onCourierInputChange(){
  updateTrackingLinkPreview();
}
async function submitShippingLabel(oid, action){
  const order=S.orders.find(o=>o.id===oid); if(!order) return;
  const customer=S.customers.find(c=>c.id===order.cid)||{};
  const shipDate=(g('ship-date')?.value||'').trim();
  const awb=(g('ship-awb')?.value||'').trim();
  const courier=(g('ship-courier')?.value||'').trim();
  if(!shipDate || !awb || !courier){ toast('Shipping date, AWB and courier are required','err'); return; }
  const codeType=defaultCodeTypeForCourier(courier);
  const trackingUrl=buildTrackingLink(trackingTemplateForCourier(courier), awb);
  const shipping={shipDate,awb,courier,codeType,trackingUrl,updatedAt:Date.now()};
  try{
    const updated=await api.put(`/api/orders/${oid}`,{shipping});
    syncOrder(updated);
  }catch(e){ toast('Could not save shipping details: '+e.message,'err'); return; }
  closeModal();
  if(action==='print'){
    const html=buildLabelHtml(order, customer, shipping);
    const w=window.open('','_blank');
    if(!w){ toast('Popup blocked. Please allow popups for print','err'); return; }
    w.document.open(); w.document.write(html); w.document.close();
    w.focus(); setTimeout(()=>w.print(),250);
    toast('Label opened for printing','ok');
    return;
  }
  try{
    const r=await fetch(`/api/orders/${oid}/shipping-label.pdf`);
    if(!r.ok){
      const msg=await r.text();
      throw new Error(msg || `PDF download failed (${r.status})`);
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`shipping-label-order-${oid}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('Shipping label PDF downloaded','ok');
  }catch(e){
    toast('Could not download PDF label: '+e.message,'err');
  }
}
function shippingLabel(oid,action){
  const order=S.orders.find(o=>o.id===oid); if(!order){toast('Order not found','err');return;}
  if(!(order.channel==='website' || order.channel==='whatsapp')){
    toast('Label - Not Valid','err');
    return;
  }
  const customer=S.customers.find(c=>c.id===order.cid)||{};
  const ship=order.shipping||{};
  const warn=isMissingFullAddress(customer);
  const missingCompany = !String(S.shippingProfile?.companyName||'').trim() || !String(S.shippingProfile?.address||'').trim();
  const courierVal=(ship.courier||'').trim();
  openModal(`
    <div class="modal-title">${action==='print'?'Print':'Download'} Shipping Label</div>
    <div style="font-size:12px;color:var(--text-3);margin-top:6px">Order #${order.id} · ${esc(order.cname)} · ${esc(order.prod)}</div>
    ${warn?`<div style="margin-top:10px;padding:10px;border:1px solid var(--red-bd);background:var(--red-bg);color:var(--red);border-radius:8px;font-size:12px">Warning: Customer does not have full address in record.</div>`:''}
    ${missingCompany?`<div style="margin-top:10px;padding:10px;border:1px solid var(--amber-bd);background:var(--amber-bg);color:var(--amber);border-radius:8px;font-size:12px">Warning: Company shipping details are incomplete. Update in Settings → Shipping.</div>`:''}
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
      <div class="fg"><label>Shipping Date <span class="req">*</span></label><input id="ship-date" type="date" value="${esc(ship.shipDate||safeDateISO(Date.now()))}"></div>
      <div class="fr">
        <div class="fg"><label>AWB Number <span class="req">*</span></label><input id="ship-awb" type="text" value="${esc(ship.awb||'')}" placeholder="Courier AWB" oninput="updateTrackingLinkPreview()"></div>
        <div class="fg"><label>Courier <span class="req">*</span></label><select id="ship-courier" onchange="onCourierInputChange()">${courierSelectOptions(courierVal)}</select></div>
      </div>
      <div class="fg">
        <label>Tracking Link</label>
        <div class="fr" style="grid-template-columns:1fr auto">
          <input id="ship-track-link" type="text" readonly value="${esc(ship.trackingUrl||'')}" placeholder="Auto-generated from template + AWB">
          <button class="btn btn-s" onclick="copyTrackingLinkFromModal()">Copy</button>
        </div>
        <div id="ship-track-note" style="font-size:11.5px;color:var(--text-3);margin-top:4px">No template configured for this courier. Set it in Settings → Shipping.</div>
      </div>
      <div style="font-size:11.5px;color:var(--text-3)">AWB code format is auto-picked from courier settings (QR/Barcode).</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitShippingLabel(${oid},'${action}')">${action==='print'?'Print Label':'Download Label'}</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
  updateTrackingLinkPreview();
}

// ─── MOBILE HELPERS ──────────────────────────────────────────────────────────
function isMobile(){ return window.innerWidth < 600; }

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
// Sidebar nav: dashboard=0, orders=1, alerts=2, inventory=3, customers=4, settings=5
function nav(p){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  g('view-'+p).classList.add('active');
  // Desktop sidebar
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
  const IDX={dashboard:0,orders:1,alerts:2,inventory:3,customers:4,settings:5};
  if(IDX[p]!==undefined) document.querySelectorAll('.nb')[IDX[p]].classList.add('active');
  // Mobile bottom nav
  document.querySelectorAll('.bnav-item').forEach(b=>b.classList.remove('active'));
  const BIDX={dashboard:'bnav-dashboard',orders:'bnav-orders',alerts:'bnav-alerts',inventory:'bnav-inventory',customers:'bnav-customers',settings:'bnav-settings'};
  if(BIDX[p]) { const el=g(BIDX[p]); if(el) el.classList.add('active'); }
  // Scroll to top on mobile when switching views
  if(isMobile()) window.scrollTo({top:0,behavior:'smooth'});
  if(p==='dashboard') rDash();
  if(p==='orders')    rOrders();
  if(p==='alerts')    rAlerts();
  if(p==='inventory') rInventory();
  if(p==='customers') rCustomers();
  if(p==='sales')     { populateProdSelect(); setDefaultDate(); }
  if(p==='settings')  { sPanel('products'); rSettings(); }
}
function sPanel(id){
  document.querySelectorAll('.settings-panel').forEach(p=>p.classList.remove('active'));
  g('sp-'+id).classList.add('active');
  document.querySelectorAll('.smenu-item').forEach(b=>b.classList.remove('active'));
  const items=document.querySelectorAll('.smenu-item');
  const map={products:0,'new-product':1,'wa-messages':2,shipping:3};
  if(map[id]!==undefined) items[map[id]].classList.add('active');
  if(id==='wa-messages') rWaMessages();
  if(id==='shipping') rShippingSettings();
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────

// "Add Customer" button on the Customers page opens a modal form
function openAddCustomerModal(){
  openModal(`
    <div class="modal-title">Add Customer</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fr">
        <div class="fg"><label>Full Name <span class="req">*</span></label><input id="fn" type="text" placeholder="e.g. Ravi Kumar" autocomplete="off"></div>
        <div class="fg"><label>Phone <span class="req">*</span></label><input id="fp" type="tel" placeholder="10-digit number"></div>
      </div>
      <div class="fr">
        <div class="fg"><label>Area / Locality <span class="req">*</span></label><input id="fa" type="text" placeholder="e.g. Jayanagar, Bangalore"></div>
        <div class="fg"><label>Email <span style="color:var(--text-3);font-weight:400">(optional)</span></label><input id="fe" type="email" placeholder="ravi@email.com"></div>
      </div>
      <div class="fg"><label>Address <span style="color:var(--text-3);font-weight:400">(optional)</span></label><textarea id="fx" rows="2" placeholder="Full delivery address…"></textarea></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="saveC()">Save Customer</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'lg');
}

async function saveC(){
  const name=g('fn').value.trim(),phone=g('fp').value.trim(),area=g('fa').value.trim();
  if(!name||!phone||!area){toast('Name, phone & area required','err');return;}
  if(!/^\d{10}$/.test(phone)){toast('Phone must be 10 digits','err');return;}
  try{
    const c=await api.post('/api/customers',{name,phone,area,email:g('fe').value.trim(),address:g('fx').value.trim(),at:Date.now()});
    S.customers.push(c); S.cid=c.id+1;
    closeModal();
    toast(name+' added','ok'); rCustomers();
  }catch(e){toast('Error: '+e.message,'err');}
}

function rCustomers(){
  const grid=g('cg');
  g('cs-sub').textContent=S.customers.length+' customer'+(S.customers.length!==1?'s':'')+' registered';
  if(!S.customers.length){
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="ei"></div><div class="et">No customers yet</div><div class="es">Add your first customer to get started</div></div>`;
    return;
  }
  grid.innerHTML=S.customers.map(c=>{
    const oc=S.orders.filter(o=>o.cid===c.id).length;
    const ini=c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return`<div class="cc">
      <div class="cc-top">
        <div class="cav">${ini}</div>
        <div style="flex:1;min-width:0"><div class="cnm">${esc(c.name)}</div><div class="car">${esc(c.area)}</div></div>
        <button class="c-menu-btn" onclick="openCustomerMenu(${c.id},this)" title="Options">···</button>
      </div>
      <div class="cm">
        <div class="cmr"><span class="cmi">↗</span>${esc(c.phone)}</div>
        ${c.email?`<div class="cmr"><span class="cmi">@</span>${esc(c.email)}</div>`:''}
        ${c.address?`<div class="cmr" style="font-size:11.5px"><span class="cmi">⌂</span>${esc(c.address)}</div>`:''}
      </div>
      <div class="cf">
        <span class="pill pn">${oc} order${oc!==1?'s':''}</span>
        ${oc>=5?`<span class="pill pg">Smart alerts on</span>`:`<span class="pill pn">${oc}/5 for smart</span>`}
      </div>
    </div>`;
  }).join('');
}

// 3-dot context menu for customer card
function openCustomerMenu(cid, btn){
  closeOrderMenu(); // reuse same close logic
  const menu=document.createElement('div');
  menu.className='ctx-menu'; menu.id='ctx-menu';
  menu.innerHTML=`<button class="ctx-item" onclick="closeOrderMenu();openEditCustomer(${cid})">Edit Customer</button>`;
  document.body.appendChild(menu);
  const r=btn.getBoundingClientRect();
  positionCtxMenu(menu, r);
  setTimeout(()=>document.addEventListener('click',_closeMenuOutside,{once:true}),10);
}

function openEditCustomer(cid){
  const c=S.customers.find(x=>x.id===cid); if(!c) return;
  openModal(`
    <div class="modal-title">Edit Customer</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fr">
        <div class="fg"><label>Full Name <span class="req">*</span></label><input id="ec-name" value="${esc(c.name)}"></div>
        <div class="fg"><label>Phone <span class="req">*</span></label><input id="ec-phone" type="tel" value="${esc(c.phone)}"></div>
      </div>
      <div class="fr">
        <div class="fg"><label>Area / Locality <span class="req">*</span></label><input id="ec-area" value="${esc(c.area)}"></div>
        <div class="fg"><label>Email</label><input id="ec-email" type="email" value="${esc(c.email||'')}"></div>
      </div>
      <div class="fg"><label>Address</label><textarea id="ec-address" rows="2">${esc(c.address||'')}</textarea></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditCustomer(${cid})">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
      <hr style="margin:4px 0">
      <button class="btn btn-danger btn-full" onclick="confirmDeleteCustomer(${cid})">Delete Customer</button>
    </div>`,'lg');
}

async function submitEditCustomer(cid){
  const name=g('ec-name').value.trim(),phone=g('ec-phone').value.trim(),area=g('ec-area').value.trim();
  if(!name||!phone||!area){toast('Name, phone & area required','err');return;}
  if(!/^\d{10}$/.test(phone)){toast('Phone must be 10 digits','err');return;}
  try{
    const updated=await api.put(`/api/customers/${cid}`,{name,phone,area,email:g('ec-email').value.trim(),address:g('ec-address').value.trim()});
    const idx=S.customers.findIndex(c=>c.id===cid); if(idx>=0) S.customers[idx]=updated;
    S.orders.forEach(o=>{if(o.cid===cid){o.cname=name;o.cphone=phone;}});
    closeModal(); toast(name+' updated','ok'); rCustomers();
  }catch(e){toast('Error: '+e.message,'err');}
}

function confirmDeleteCustomer(cid){
  const c=S.customers.find(x=>x.id===cid); if(!c) return;
  const oc=S.orders.filter(o=>o.cid===cid).length;
  openModal(`
    <div class="modal-title" style="color:var(--red)">Delete Customer</div>
    <div style="margin-top:12px;font-size:13.5px;color:var(--text-2);line-height:1.7">
      <strong>${esc(c.name)}</strong> has <strong>${oc} order${oc!==1?'s':''}</strong> on record.<br>
      Their orders will remain but will lose the customer link.
    </div>
    <div style="display:flex;gap:8px;margin-top:20px">
      <button class="btn btn-danger" style="flex:1" onclick="doDeleteCustomer(${cid})">Confirm Delete</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`);
}

async function doDeleteCustomer(cid){
  try{
    await api.del(`/api/customers/${cid}`);
    S.customers=S.customers.filter(c=>c.id!==cid);
    closeModal(); toast('Customer deleted'); rCustomers();
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── SALE STATE ──────────────────────────────────────────────────────────────
let selC=null,selV=null,qty=1,selCh='retail',saleDelivered=false;

function setDefaultDate(){ const el=g('sale-date'); if(el) el.value=todayISO(); }

function cs_search(){
  const q=g('cs').value.trim().toLowerCase(),dd=g('cs-dd');
  const hits=S.customers.filter(c=>c.name.toLowerCase().includes(q)||c.phone.includes(q)||c.area.toLowerCase().includes(q)).slice(0,8);
  if(!hits.length){dd.classList.remove('open');return;}
  dd.innerHTML=hits.map(c=>{const oc=S.orders.filter(o=>o.cid===c.id).length;return`<div class="ddi" onclick="pickC(${c.id})"><div><div class="ddi-n">${c.name}</div><div class="ddi-m">${c.phone} · ${c.area}</div></div><span class="ddi-a">${oc} order${oc!==1?'s':''}</span></div>`;}).join('');
  dd.classList.add('open');
}
function pickC(id){
  selC=S.customers.find(c=>c.id===id); g('cs').value=selC.name; g('cs-dd').classList.remove('open');
  const ini=selC.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const oc=S.orders.filter(o=>o.cid===id).length;
  const el=g('sel-c'); el.style.display='block';
  el.innerHTML=`<div class="sc-box"><div style="display:flex;align-items:center;gap:10px"><div class="sc-av">${ini}</div><div><div class="sc-n">${selC.name}</div><div class="sc-m">${selC.area} · ${oc} previous order${oc!==1?'s':''}</div></div></div><button class="btn btn-g btn-xs" onclick="clearC()">✕</button></div>`;
  refreshSum();
}
function clearC(){ selC=null;g('cs').value='';g('sel-c').style.display='none';refreshSum(); }
document.addEventListener('click',e=>{ if(!e.target.closest('.sw')) g('cs-dd').classList.remove('open'); });

function populateProdSelect(){
  const sel=g('ps'); sel.innerHTML='<option value="">Select product…</option>';
  S.products.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;sel.appendChild(o);});
  selV=null;selCh='retail';saleDelivered=false;g('vr-row').innerHTML='';renderChannelPicker();updateDeliveredToggle();refreshSum();
}
function onProdChange(){ const pid=g('ps').value;selV=null;if(!pid){g('vr-row').innerHTML='';refreshSum();return;}
  const prod=S.products.find(p=>p.id===pid);
  g('vr-row').innerHTML=(prod.sizes||DEFAULT_SIZES).map(sz=>`<button class="vb" data-v="${sz}" onclick="pickV('${sz}')"><span class="vs">${VL[sz]||sz}</span><span class="vh">~${W[sz]||'?'}d cycle</span></button>`).join('');
  refreshSum();
}
function pickV(v){ selV=v;document.querySelectorAll('.vb').forEach(b=>b.classList.remove('on'));const b=document.querySelector(`[data-v="${v}"]`);if(b)b.classList.add('on');refreshSum(); }
function aQ(d){ qty=Math.max(1,qty+d);g('qv').textContent=qty;refreshSum(); }
function pickChannel(ch){ selCh=ch;document.querySelectorAll('.ch-btn').forEach(b=>b.classList.remove('on'));const b=document.querySelector(`.ch-btn[data-ch="${ch}"]`);if(b)b.classList.add('on');refreshSum(); }
function renderChannelPicker(){ const wrap=g('channel-picker');if(!wrap)return;wrap.innerHTML=CHANNELS.map(c=>`<button class="ch-btn ${c.id===selCh?'on':''}" data-ch="${c.id}" onclick="pickChannel('${c.id}')"><span class="ch-btn-label">${c.label}</span><span class="ch-btn-sub">${c.sub}</span></button>`).join(''); }

function toggleDelivered(){
  saleDelivered=!saleDelivered;
  updateDeliveredToggle();
  refreshSum();
}
function updateDeliveredToggle(){
  const toggle=g('delivered-toggle');
  const pmRow=g('sale-pm-row');
  if(!toggle) return;
  toggle.classList.toggle('on',saleDelivered);
  if(pmRow) pmRow.style.display=saleDelivered?'flex':'none';
}

function refreshSum(){
  const pid=g('ps').value,box=g('sale-sum');
  if(!selC||!pid||!selV){box.style.display='none';return;}
  box.style.display='block';
  const prod=S.products.find(p=>p.id===pid);
  const sp=getSalePrice(pid,selV,selCh),cost=getTotalCost(pid,selV),ad=(W[selV]||10)*qty;
  const disc=parseFloat(g('sale-discount')?.value||0)||0;
  const comm=parseFloat(g('sale-commission')?.value||0)||0;
  let priceRows='';
  if(sp>0){
    const rev=sp*qty;
    const pgComm=websiteGatewayCommission(rev,selCh);
    const gross=(sp-cost)*qty,net=gross-disc-comm-pgComm;
    priceRows=`<hr class="sdiv">
      <div class="sr"><span class="sk">Sale price / pack</span><span class="sval">₹${sp.toFixed(0)}</span></div>
      <div class="sr"><span class="sk">Revenue</span><span class="sval">₹${rev.toFixed(0)}</span></div>
      ${disc>0?`<div class="sr"><span class="sk">Discount</span><span class="sval" style="color:var(--amber)">−₹${disc.toFixed(0)}</span></div>`:''}
      ${comm>0?`<div class="sr"><span class="sk">Manual commission</span><span class="sval" style="color:var(--amber)">−₹${comm.toFixed(0)}</span></div>`:''}
      ${pgComm>0?`<div class="sr"><span class="sk">Gateway commission (${paymentGatewayCommissionPct().toFixed(2)}%)</span><span class="sval" style="color:var(--amber)">−₹${pgComm.toFixed(0)}</span></div>`:''}
      <div class="sr"><span class="sk">Net profit</span><span class="sval" style="color:${net>=0?'var(--green)':'var(--red)'}">₹${net.toFixed(0)}</span></div>`;
  } else {
    priceRows=`<hr class="sdiv"><div class="sr"><span class="sk" style="color:var(--amber)">⚠ No price set for this channel</span></div>`;
  }
  const statusNote=saleDelivered?`<div class="sr"><span class="sk">Status</span><span class="sval"><span class="status-badge st-completed">Completed</span></span></div>`:'';
  g('sum-body').innerHTML=`
    <div class="sr"><span class="sk">Customer</span><span class="sval">${selC.name}</span></div>
    <div class="sr"><span class="sk">Product</span><span class="sval">${prod.name}</span></div>
    <div class="sr"><span class="sk">Size</span><span class="sval">${VL[selV]||selV}</span></div>
    <div class="sr"><span class="sk">Qty</span><span class="sval">${qty} pack${qty>1?'s':''}</span></div>
    <div class="sr"><span class="sk">Channel</span><span class="sval">${CHANNEL_MAP[selCh]?.label||selCh}</span></div>
    ${statusNote}
    <hr class="sdiv">
    <div class="sr"><span class="sk">Alert if no re-order within</span><span class="sval">${ad} days</span></div>
    ${priceRows}`;
}

async function recSale(){
  const pid=g('ps').value;
  if(!selC){toast('Select a customer','err');return;}
  if(!pid){toast('Select a product','err');return;}
  if(!selV){toast('Select a pack size','err');return;}
  const prod=S.products.find(p=>p.id===pid);
  const dateVal=g('sale-date').value;
  let at=Date.now();
  if(dateVal){const[y,m,d]=dateVal.split('-').map(Number);const dt=new Date(y,m-1,d,12,0,0);if(!isNaN(dt.getTime()))at=dt.getTime();}
  const disc=parseFloat(g('sale-discount')?.value||0)||0;
  const comm=parseFloat(g('sale-commission')?.value||0)||0;
  const status=saleDelivered?'completed':(selCh==='retail'?'confirmed':'pending');
  const pm=saleDelivered?(g('sale-pm')?.value||''):'';
  try{
    const order=await api.post('/api/orders',{cid:selC.id,cname:selC.name,cphone:selC.phone,carea:selC.area,prod:prod.name,prodId:pid,variant:selV,qty,channel:selCh,discount:disc,commission:comm,status,paymentMethod:pm,at});
    S.orders.unshift(order);S.oid=order.id+1;
    updBadge();clearC();selV=null;qty=1;selCh='retail';saleDelivered=false;
    g('ps').value='';g('vr-row').innerHTML='';g('qv').textContent='1';
    if(g('sale-discount'))g('sale-discount').value='';
    if(g('sale-commission'))g('sale-commission').value='';
    g('sale-sum').style.display='none';setDefaultDate();renderChannelPicker();updateDeliveredToggle();
    toast('Sale recorded','ok');
    if(status==='completed') rDash(); // refresh dashboard counts
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
function rOrders(){
  const active=S.orders.filter(o=>!isCompleted(o));
  const done  =S.orders.filter(isCompleted);
  g('os').textContent=S.orders.length+' total · '+active.length+' active · '+done.length+' completed';
  const body=g('ob');
  if(!S.orders.length){body.innerHTML=`<div class="empty"><div class="ei">📋</div><div class="et">No orders yet</div><div class="es">Record your first sale</div></div>`;return;}
  body.innerHTML=buildOrderTable(active,'Active Orders',false)+buildOrderTable(done,'Completed Orders',true);
}

function buildOrderTable(orders,title,collapsible){
  if(!orders.length) return collapsible?'':`<div style="padding:18px 16px;color:var(--text-3);font-size:13px">No ${title.toLowerCase()} yet</div>`;
  const id='ot-'+title.replace(/\s/g,'-').toLowerCase();
  const header=`<div class="orders-section-header ${collapsible?'collapsible':''}" onclick="${collapsible?`toggleSection('${id}')`:''}" id="${id}-hdr">
    <span class="orders-section-title">${title}</span>
    <span class="orders-section-count">${orders.length}</span>
    ${collapsible?`<span class="section-chevron" id="${id}-chev">▼</span>`:''}
  </div>`;
  // Desktop table
  const desktopTable=`<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Customer</th><th>Product</th><th>Size</th><th>Qty</th><th>Channel</th><th>Status</th><th>Revenue</th><th>Profit</th><th>Date</th><th></th></tr></thead>
    <tbody>${orders.map(o=>orderRow(o)).join('')}</tbody>
  </table></div>`;
  // Mobile card list
  const mobileCards=`<div class="order-card-list">${orders.map(o=>orderMobileCard(o)).join('')}</div>`;
  return `${header}<div id="${id}">${desktopTable}${mobileCards}</div>`;
}

function orderRow(o){
  const rev=orderRevenue(o),prof=orderProfit(o);
  const disc=parseFloat(o.discount||0);
  const comm=orderCommissionBreakup(o);
  const opts=statusOpts(o.channel||'retail');
  const statusBtn=`<div class="status-dropdown-wrap">
    <button class="status-badge ${STATUS_CLS[o.status||'pending']} status-clickable" onclick="toggleStatusDropdown(${o.id},this)">${STATUS_LABEL[o.status]||o.status} ▾</button>
    <div class="status-dropdown" id="sdrop-${o.id}">
      ${opts.map(s=>`<button class="sdrop-item ${s.id===o.status?'active':''}" onclick="quickStatus(${o.id},'${s.id}',this)">${s.label}</button>`).join('')}
    </div>
  </div>`;
  return`<tr>
    <td><span class="pill pn" style="font-size:10.5px;font-family:monospace">#${o.id}</span></td>
    <td><div style="font-weight:600">${o.cname}</div><div style="font-size:11.5px;color:var(--text-3)">${o.carea}</div></td>
    <td style="color:var(--text-2);max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.prod}</td>
    <td><span class="pill pn">${VL[o.variant]||o.variant}</span></td>
    <td style="font-weight:600">${o.qty}</td>
    <td>${chBadge(o.channel||'retail')}</td>
    <td>${statusBtn}</td>
    <td style="font-weight:600">${rev>0&&isCompleted(o)?'₹'+rev.toFixed(0):'<span style="color:var(--text-3)">—</span>'}</td>
    <td>
      <div style="font-weight:600;color:${prof===null?'var(--text-3)':prof>=0?'var(--green)':'var(--red)'}">${prof===null||!isCompleted(o)?'—':'₹'+prof.toFixed(0)}</div>
      ${disc>0||comm.total>0?`<div style="font-size:10.5px;color:var(--text-3);margin-top:1px">${[disc>0?`-₹${disc}d`:'',comm.manual>0?`-₹${comm.manual.toFixed(0)}mc`:'',comm.gateway>0?`-₹${comm.gateway.toFixed(0)}pg`:''].filter(Boolean).join(' ')}</div>`:''}
    </td>
    <td style="color:var(--text-3)">${fd(o.at)}</td>
    <td><button class="btn btn-g btn-xs dots-btn" onclick="openOrderMenu(${o.id},this)" title="More options">⋯</button></td>
  </tr>`;
}

function toggleSection(id){
  const body=g(id),chev=g(id+'-chev');
  if(!body) return;
  const hidden=body.style.display==='none';
  body.style.display=hidden?'':'none';
  if(chev) chev.textContent=hidden?'▼':'▶';
}

// Mobile order card — compact single-card layout for small screens
function orderMobileCard(o){
  const rev=orderRevenue(o),prof=orderProfit(o);
  const disc=parseFloat(o.discount||0),comm=orderCommissionBreakup(o);
  const opts=statusOpts(o.channel||'retail');
  const stSel=`<select class="inline-status-sel ${STATUS_CLS[o.status||'pending']}" onchange="mobileQuickStatus(${o.id},this)">${opts.map(s=>`<option value="${s.id}" ${o.status===s.id?'selected':''}>${s.label}</option>`).join('')}</select>`;
  const profLine=isCompleted(o)&&prof!==null?`<span style="font-size:12px;font-weight:700;color:${prof>=0?'var(--green)':'var(--red)'}">₹${prof.toFixed(0)} profit</span>`:'';
  return`<div class="order-card">
    <div class="order-card-top">
      <div>
        <div class="order-card-name">${esc(o.cname)}</div>
        <div class="order-card-prod">${esc(o.prod)} · ${VL[o.variant]||o.variant} × ${o.qty}</div>
      </div>
      <div class="order-card-right">
        ${isCompleted(o)&&rev>0?`<span class="order-card-rev">₹${rev.toFixed(0)}</span>`:''}
        <span style="font-size:11px;color:var(--text-3)">${fd(o.at)}</span>
      </div>
    </div>
    <div class="order-card-meta">
      ${chBadge(o.channel||'retail')}
      ${stSel}
      ${profLine}
      ${disc>0||comm.total>0?`<span style="font-size:11px;color:var(--text-3)">${[disc>0?`-₹${disc}d`:'',comm.manual>0?`-₹${comm.manual.toFixed(0)}mc`:'',comm.gateway>0?`-₹${comm.gateway.toFixed(0)}pg`:''].filter(Boolean).join(' ')}</span>`:''}
    </div>
    <div class="order-card-actions">
      <button class="btn btn-g btn-xs" style="flex:1;justify-content:center" onclick="openEditOrder(${o.id})">Edit order</button>
      <button class="btn btn-g btn-xs dots-btn" onclick="openOrderMenu(${o.id},this)">⋯</button>
    </div>
  </div>`;
}

// Quick status from mobile card select
async function mobileQuickStatus(oid, sel){
  const newStatus=sel.value;
  const o=S.orders.find(x=>x.id===oid);
  if(shouldWebsitePendingConfirm(o,newStatus)){
    if(o) sel.value=o.status;
    showWebsitePendingConfirmPopup(oid,newStatus,'mobile');
    return;
  }
  if(newStatus==='completed'){
    if(o) sel.value=o.status;
    showPaymentPopup(oid,newStatus); return;
  }
  if(newStatus==='shipped'){
    if(o) sel.value=o.status;
    openShippedStatusPopup(oid,'mobile'); return;
  }
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status:newStatus});
    syncOrder(updated); rOrders(); rDash(); updBadge(); toast('Status updated','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}

// Status dropdown (inline)
let _openDrop=null;
function toggleStatusDropdown(oid,btn){
  const drop=g('sdrop-'+oid);
  if(!drop) return;
  if(_openDrop&&_openDrop!==drop){_openDrop.classList.remove('open');}
  drop.classList.toggle('open');
  _openDrop=drop.classList.contains('open')?drop:null;
  if(drop.classList.contains('open')){
    setTimeout(()=>document.addEventListener('click',_closeDrop,{once:true}),10);
  }
}
function _closeDrop(e){ if(!e.target.closest('.status-dropdown-wrap')&&_openDrop){_openDrop.classList.remove('open');_openDrop=null;} }

async function quickStatus(oid, newStatus, btnEl){
  const o=S.orders.find(x=>x.id===oid);
  if(shouldWebsitePendingConfirm(o,newStatus)){
    showWebsitePendingConfirmPopup(oid,newStatus,'orders');
    return;
  }
  if(newStatus==='completed'){
    // Show payment popup before completing
    showPaymentPopup(oid, newStatus);
    return;
  }
  if(newStatus==='shipped'){
    showShippedStatusGuard(oid);
    return;
  }
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status:newStatus});
    syncOrder(updated);
    // close any open dropdown
    if(_openDrop){_openDrop.classList.remove('open');_openDrop=null;}
    rOrders(); rDash(); updBadge();
    toast('Status updated','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}
function showShippedStatusGuard(oid){
  const o=S.orders.find(x=>x.id===oid);
  if(!o) return;
  if(!(o.channel==='website' || o.channel==='whatsapp')){
    toast('Shipped status is for Website/WhatsApp orders','err');
    return;
  }
  if(_openDrop){_openDrop.classList.remove('open');_openDrop=null;}
  openShippedStatusPopup(oid,'orders');
}

function shouldWebsitePendingConfirm(order,newStatus){
  if(!order) return false;
  const ch=String(order.channel||'').toLowerCase();
  const st=String(order.status||'').toLowerCase();
  const ns=String(newStatus||'').toLowerCase();
  return ch==='website' && st==='pending' && (ns==='confirmed' || ns==='shipped' || ns==='completed');
}
function showWebsitePendingConfirmPopup(oid,newStatus,from='orders'){
  if(_openDrop){_openDrop.classList.remove('open');_openDrop=null;}
  const o=S.orders.find(x=>x.id===oid); if(!o) return;
  const rev=orderRevenue(o);
  const pgPct=paymentGatewayCommissionPct();
  const pgAmt=websiteGatewayCommission(rev,'website');
  const actionLabel=newStatus==='shipped'?'Confirm & Continue to Shipping':(newStatus==='completed'?'Confirm & Complete':'Confirm & Mark Confirmed');
  openModal(`
    <div style="text-align:center;margin-bottom:6px">
      <div style="width:48px;height:48px;background:var(--blue-bg);border:1px solid var(--blue-bd);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:22px">✓</div>
      <div class="modal-title">Confirm Website Order Details</div>
      <div style="font-size:12.5px;color:var(--text-3);margin-top:6px">
        Order <strong>#${oid}</strong> · ${esc(o.cname)}<br>
        ${esc(o.prod)} · ${VL[o.variant]||o.variant} · ${o.qty} pack${o.qty>1?'s':''}
      </div>
    </div>
    <div class="sumbox" style="margin-bottom:14px">
      <div class="sr"><span class="sk">Revenue</span><span class="sval">₹${rev.toFixed(0)}</span></div>
      <div class="sr"><span class="sk">Gateway commission</span><span class="sval">₹${pgAmt.toFixed(0)} (${pgPct.toFixed(2)}%)</span></div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">To change this %, update Settings → Shipping → Website Payment Gateway Commission.</div>
    </div>
    <div class="fg" style="margin-bottom:16px">
      <label>Payment Method <span class="req">*</span></label>
      <select id="web-pm-select">
        <option value="">— Select —</option>
        ${PAYMENT_METHODS.map(m=>`<option value="${m}" ${o.paymentMethod===m?'selected':''}>${m}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-p" style="flex:1;background:var(--blue)" onclick="submitWebsitePendingConfirm(${oid},'${newStatus}','${from}')">${actionLabel}</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`);
}
async function submitWebsitePendingConfirm(oid,newStatus,from='orders'){
  const pm=g('web-pm-select')?.value||'';
  if(!pm){ toast('Select payment method','err'); return; }
  try{
    let updated;
    if(newStatus==='shipped'){
      updated=await api.put(`/api/orders/${oid}`,{paymentMethod:pm});
      syncOrder(updated); closeModal();
      openShippedStatusPopup(oid,from);
      return;
    }
    updated=await api.put(`/api/orders/${oid}`,{status:newStatus,paymentMethod:pm});
    syncOrder(updated); closeModal();
    rOrders(); rDash(); updBadge();
    toast('Status updated','ok');
  }catch(e){ toast('Error: '+e.message,'err'); }
}

function showPaymentPopup(oid, newStatus){
  // Close any open status dropdown first
  if(_openDrop){_openDrop.classList.remove('open');_openDrop=null;}
  const o=S.orders.find(x=>x.id===oid); if(!o) return;
  openModal(`
    <div style="text-align:center;margin-bottom:4px">
      <div style="width:48px;height:48px;background:var(--green-bg);border:1px solid var(--green-bd);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:22px">✓</div>
      <div class="modal-title">Mark as Completed</div>
      <div style="font-size:13px;color:var(--text-3);margin-top:6px;margin-bottom:20px">
        Order <strong>#${oid}</strong> for <strong>${esc(o.cname)}</strong><br>
        ${o.prod} · ${VL[o.variant]||o.variant} · ${o.qty} pack${o.qty>1?'s':''}
      </div>
    </div>
    <div class="fg" style="margin-bottom:18px">
      <label>Payment Method <span class="req">*</span></label>
      <select id="pm-select">
        <option value="">— Select —</option>
        ${PAYMENT_METHODS.map(m=>`<option value="${m}">${m}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-p" style="flex:1;background:var(--green)" onclick="submitComplete(${oid})">Confirm Completed</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`);
}

async function submitComplete(oid){
  const pm=g('pm-select')?.value||'';
  if(!pm){toast('Select a payment method','err');return;}
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status:'completed',paymentMethod:pm});
    syncOrder(updated); closeModal();
    rOrders(); rDash(); updBadge();
    toast('Order completed ✓','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}

function syncOrder(updated){
  const idx=S.orders.findIndex(o=>o.id===updated.id);
  if(idx>=0) S.orders[idx]=updated;
}

// ─── EDIT ORDER (full modal) ──────────────────────────────────────────────────
function openEditOrder(oid){
  const o=S.orders.find(x=>x.id===oid); if(!o) return;
  const opts=statusOpts(o.channel||'retail');
  const stOpts=opts.map(s=>`<option value="${s.id}" ${o.status===s.id?'selected':''}>${s.label}</option>`).join('');
  const pmOpts=PAYMENT_METHODS.map(m=>`<option value="${m}" ${o.paymentMethod===m?'selected':''}>${m}</option>`).join('');
  const prod=S.products.find(p=>p.id===o.prodId);
  const sizes=(prod?.sizes||DEFAULT_SIZES).map(sz=>`<option value="${sz}" ${o.variant===sz?'selected':''}>${VL[sz]||sz}</option>`).join('');
  openModal(`
    <div class="modal-title">Edit Order <span style="color:var(--text-3);font-size:13px;font-weight:400">#${oid}</span></div>
    <div style="font-size:12px;color:var(--text-3);margin:4px 0 18px">${esc(o.cname)} · ${chBadge(o.channel||'retail')}</div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="fr">
        <div class="fg"><label>Pack Size</label><select id="eo-var">${sizes}</select></div>
        <div class="fg"><label>Quantity</label><input type="number" id="eo-qty" value="${o.qty}" min="1"></div>
      </div>
      <div class="fr">
        <div class="fg"><label>Discount (₹)</label><div class="input-prefix"><span>₹</span><input type="number" id="eo-disc" value="${o.discount||0}" min="0" oninput="eoPreview(${oid})"></div></div>
        <div class="fg"><label>Commission (₹)</label><div class="input-prefix"><span>₹</span><input type="number" id="eo-comm" value="${o.commission||0}" min="0" oninput="eoPreview(${oid})"></div></div>
      </div>
      <div class="fr">
        <div class="fg"><label>Status</label><select id="eo-status">${stOpts}</select></div>
        <div class="fg"><label>Payment Method</label><select id="eo-pm"><option value="">Not set</option>${pmOpts}</select></div>
      </div>
      <div class="fg">
        <label>Order Date</label>
        <input type="date" id="eo-date" value="${dateToISO(o.at)}">
      </div>
      <div class="sumbox" id="eo-preview"></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditOrder(${oid})">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'lg');
  eoPreview(oid);
}

function eoPreview(oid){
  const o=S.orders.find(x=>x.id===oid); if(!o) return;
  const prev=g('eo-preview'); if(!prev) return;
  const sz=g('eo-var')?.value||o.variant;
  const qty=parseInt(g('eo-qty')?.value||o.qty)||1;
  const sp=getSalePrice(o.prodId,sz,o.channel||'retail');
  const cost=getTotalCost(o.prodId,sz);
  const disc=parseFloat(g('eo-disc')?.value||0)||0;
  const comm=parseFloat(g('eo-comm')?.value||0)||0;
  if(!sp){prev.innerHTML=`<span style="color:var(--text-3);font-size:12.5px">No pricing set for this channel</span>`;return;}
  const rev=sp*qty;
  const pgComm=websiteGatewayCommission(rev,o.channel||'retail');
  const gross=(sp-cost)*qty,net=gross-disc-comm-pgComm;
  prev.innerHTML=`
    <div class="sr"><span class="sk">Revenue</span><span class="sval">₹${rev.toFixed(0)}</span></div>
    <div class="sr"><span class="sk">Gross profit</span><span class="sval">₹${gross.toFixed(0)}</span></div>
    ${disc>0?`<div class="sr"><span class="sk">Discount</span><span class="sval" style="color:var(--amber)">−₹${disc.toFixed(0)}</span></div>`:''}
    ${comm>0?`<div class="sr"><span class="sk">Manual commission</span><span class="sval" style="color:var(--amber)">−₹${comm.toFixed(0)}</span></div>`:''}
    ${pgComm>0?`<div class="sr"><span class="sk">Gateway commission (${paymentGatewayCommissionPct().toFixed(2)}%)</span><span class="sval" style="color:var(--amber)">−₹${pgComm.toFixed(0)}</span></div>`:''}
    <hr class="sdiv">
    <div class="sr"><span class="sk">Net profit</span><span class="sval" style="color:${net>=0?'var(--green)':'var(--red)'};font-size:14px">₹${net.toFixed(0)}</span></div>`;
}

async function submitEditOrder(oid){
  const status=g('eo-status').value;
  const discount=parseFloat(g('eo-disc').value||0)||0;
  const commission=parseFloat(g('eo-comm').value||0)||0;
  const pm=g('eo-pm').value||'';
  const qty=parseInt(g('eo-qty').value)||1;
  const variant=g('eo-var').value;
  const dateVal=g('eo-date').value;
  let at=S.orders.find(x=>x.id===oid)?.at||Date.now();
  if(dateVal){const[y,m,d]=dateVal.split('-').map(Number);const dt=new Date(y,m-1,d,12,0,0);if(!isNaN(dt.getTime()))at=dt.getTime();}
  // If setting to completed, require payment method
  if(status==='completed'&&!pm){
    toast('Select a payment method for completed orders','err'); return;
  }
  if(status==='shipped'){
    const o=S.orders.find(x=>x.id===oid);
    if(o && (o.channel==='website' || o.channel==='whatsapp')){
      closeModal();
      openShippedStatusPopup(oid,'edit');
      return;
    }
  }
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status,discount,commission,paymentMethod:pm,qty,variant,at});
    syncOrder(updated); closeModal();
    rOrders(); rDash(); updBadge();
    toast('Order updated','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── DELETE ORDER ─────────────────────────────────────────────────────────────
async function deleteOrder(oid){
  const o=S.orders.find(x=>x.id===oid); if(!o) return;
  openModal(`
    <div class="modal-title" style="color:var(--red)">Delete Order?</div>
    <div style="margin-top:12px;font-size:13.5px;color:var(--text-2);line-height:1.6">
      Order <strong>#${oid}</strong> · ${esc(o.cname)}<br>
      ${esc(o.prod)} · ${VL[o.variant]||o.variant} · ${o.qty} pack${o.qty>1?'s':''}<br>
      <span style="color:var(--text-3)">${fd(o.at)}</span>
    </div>
    <div style="display:flex;gap:8px;margin-top:20px">
      <button class="btn btn-danger" style="flex:1" onclick="doDeleteOrder(${oid})">Yes, Delete</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`);
}
async function doDeleteOrder(oid){
  try{
    await api.del(`/api/orders/${oid}`);
    S.orders=S.orders.filter(o=>o.id!==oid);
    closeModal(); toast('Order deleted'); rOrders(); rDash(); updBadge();
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── STOCK ALERTS (from Inventory app on port 8001) ──────────────────────────
let stockAlerts = [];   // populated by pollStockAlerts()
let inventorySnapshot = [];
let inventorySnapshotAt = null;
const INVENTORY_URL = 'http://localhost:8001';  // adjust if inventory runs elsewhere

async function pollStockAlerts(){
  try{
    const data = await fetch(`${INVENTORY_URL}/api/stock`).then(r=>r.ok?r.json():[]);
    inventorySnapshot = Array.isArray(data)?data:[];
    inventorySnapshotAt = Date.now();
    stockAlerts = inventorySnapshot.filter(p=>p.isLow);
    if(g('np-comp-rows')){
      const rows=getCompositionRows();
      renderCompositionRows(rows.length?rows:[{inventoryProductId:'',percentage:100}]);
    }
    updBadge(); // recount badge including stock alerts
  }catch(e){
    // Inventory app not running — silently degrade, no stock alerts shown
    stockAlerts = [];
    inventorySnapshot = [];
    inventorySnapshotAt = null;
  }
}

// ─── ALERTS ──────────────────────────────────────────────────────────────────
function getAlerts(){
  const now=Date.now(),alerts=[],byC={};
  S.orders.forEach(o=>(byC[o.cid]=byC[o.cid]||[]).push(o));
  Object.keys(byC).forEach(cid=>{
    const orders=byC[cid].sort((a,b)=>b.at-a.at),last=orders[0];
    const cust=S.customers.find(c=>c.id==cid);if(!cust)return;
    const n=orders.length;let ad,mode,avg=null;
    if(n>=5){const gaps=[];for(let i=0;i<Math.min(n-1,5);i++)gaps.push((orders[i].at-orders[i+1].at)/864e5);avg=Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);ad=Math.round(avg*.9);mode='smart';}
    else{ad=(W[last.variant]||10)*last.qty;mode='def';}
    const dl=ad-(now-last.at)/864e5;
    if(dl<=3)alerts.push({cust,last,dl:Math.round(dl),mode,avg,n});
  });
  return alerts.sort((a,b)=>a.dl-b.dl);
}
function rAlerts(){
  const alerts=getAlerts(), body=g('al-body');
  const hasReorder = alerts.length > 0;
  const hasStock   = stockAlerts.length > 0;

  if(!hasReorder && !hasStock){
    body.innerHTML=`<div class="empty"><div class="ei">✓</div><div class="et">No alerts right now</div><div class="es">All customers are on track and stock levels are healthy</div></div>`;
    return;
  }

  let html = '';

  // ── Stock alerts section ──
  if(hasStock){
    html += `<div class="alert-section-header alert-section-stock">
      <span class="alert-section-title">Low Stock</span>
      <span class="alert-section-count">${stockAlerts.length}</span>
      <span class="alert-section-badge stock">Inventory</span>
    </div>`;
    html += stockAlerts.map(s=>{
      const isCrit = s.stockGrams <= s.lowStockThreshold * 0.5;
      return`<div class="ai stock-alert ${isCrit?'stock-critical':'stock-low'}">
        <div class="adot ${isCrit?'ov':'ds'}"></div>
        <div class="ab">
          <div class="an">${esc(s.name)}</div>
          <div class="ad">
            ${isCrit?'Critical — ':'Low — '}
            ${fGrams(s.stockGrams)} remaining · threshold ${fGrams(s.lowStockThreshold)}
          </div>
          <div class="at2">
            <span class="pill ${isCrit?'pr':'pa'}">${isCrit?'Critical stock':'Low stock'}</span>
            <span class="pill pn">Inventory alert</span>
          </div>
        </div>
        <div class="aa">
          <button class="btn btn-s btn-sm" onclick="nav('inventory')">View Inventory →</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── Reorder alerts section ──
  if(hasReorder){
    html += `<div class="alert-section-header ${hasStock?'mt12':''}">
      <span class="alert-section-title">Customer Re-order</span>
      <span class="alert-section-count">${alerts.length}</span>
      <span class="alert-section-badge reorder">Follow-up</span>
    </div>`;
    html += alerts.map(a=>{
      const ov=a.dl<=0,cls=a.mode==='smart'?'sm':ov?'ov':'ds';
      const wa=buildWaUrl(a);
      let pills=ov?`<span class="pill pr">${Math.abs(a.dl)}d overdue</span>`:`<span class="pill pa">Due in ${a.dl}d</span>`;
      if(a.mode==='smart')pills+=` <span class="pill pg">Smart · avg ${a.avg}d</span>`;
      else pills+=` <span class="pill pn">${a.n}/5 orders</span>`;
      const desc=a.mode==='smart'?`Based on ${a.n} orders — avg every ${a.avg} days. Last: ${a.last.prod} (${VL[a.last.variant]||a.last.variant})`:`Last: ${a.last.prod} ${VL[a.last.variant]||a.last.variant} ×${a.last.qty} on ${fd(a.last.at)}`;
      return`<div class="ai ${cls}"><div class="adot ${cls}"></div><div class="ab"><div class="an">${a.cust.name} <span style="font-size:12px;color:var(--text-3);font-weight:400">· ${a.cust.area}</span></div><div class="ad">${desc}</div><div class="at2">${pills}</div></div><div class="aa"><a href="${wa}" target="_blank" class="btn btn-follow-up btn-sm">${WA_ICON} Follow Up</a></div></div>`;
    }).join('');
  }

  body.innerHTML = html;
}

function rInventory(){
  const body=g('inv-body'); if(!body) return;
  const stat=g('inv-stats');
  const sub=g('inv-sub');
  const updated=g('inv-updated');
  const items=inventorySnapshot||[];
  const total=items.reduce((s,p)=>s+(Number(p.stockGrams)||0),0);
  const low=items.filter(p=>p.isLow);
  const inv=calcInventoryUsageFromOrders();
  const completed=(S.orders||[]).filter(o=>o.status==='completed');
  const synced=completed.filter(o=>o.inventorySynced).length;
  const syncPct=completed.length?((synced/completed.length)*100):0;
  sub.textContent=items.length?`${items.length} products synced from inventory app`:'Inventory service not connected';
  if(updated) updated.textContent=inventorySnapshotAt?`Last sync: ${new Date(inventorySnapshotAt).toLocaleString('en-IN')}`:'Last sync: —';
  if(stat){
    stat.innerHTML=`
      <div class="sbox accent-top"><div class="sbox-inner"><div class="sbox-half"><div class="sl">Tracked</div><div class="sv">${items.length}</div><div class="sn">Inventory products</div></div><div class="sbox-half"><div class="sl">Low Stock</div><div class="sv ${low.length?'red':''}">${low.length}</div><div class="sn">${low.length?'Needs restock':'Healthy levels'}</div></div></div></div>
      <div class="sbox accent-top"><div class="sbox-inner"><div class="sbox-half"><div class="sl">Inventory Moved</div><div class="sv">${fGrams(inv.moved)}</div><div class="sn">${inv.connected?`Inventory left: ${fGrams(total)}`:'Inventory app offline'}</div></div><div class="sbox-half"><div class="sl">Completed Synced</div><div class="sv">${synced}/${completed.length}</div><div class="sn">${completed.length?`${syncPct.toFixed(0)}% synced to inventory`:'No completed orders yet'}</div></div></div></div>`;
  }
  if(!items.length){
    body.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">Inventory app is not reachable</div><div class="es">Run the inventory service to view stock inside CRM.</div></div>`;
    return;
  }
  body.innerHTML=items.map(p=>{
    const crit=(Number(p.stockGrams)||0)<=Number(p.lowStockThreshold||0)*0.5;
    const cls=crit?'pr':p.isLow?'pa':'pg';
    return `<div class="ai">
      <div class="ab">
        <div class="an">${esc(p.name)}</div>
        <div class="ad">${fGrams(Number(p.stockGrams)||0)} remaining · threshold ${fGrams(Number(p.lowStockThreshold)||0)}</div>
      </div>
      <div class="aa">
        <span class="pill ${cls}">${crit?'Critical':p.isLow?'Low':'Healthy'}</span>
      </div>
    </div>`;
  }).join('');
}
async function refreshInventoryView(){
  await pollStockAlerts();
  rInventory();
  toast('Inventory refreshed','ok');
}
function setInventorySyncBtnLoading(on){
  const btn=g('inv-sync-btn'); if(!btn) return;
  if(on){
    btn.disabled=true;
    btn.dataset.prev=btn.innerHTML;
    btn.innerHTML=`<span class="btn-spin"></span> Syncing...`;
  }else{
    btn.disabled=false;
    btn.innerHTML=btn.dataset.prev||'Sync & Refresh';
  }
}
async function syncCompletedOrdersToInventory(){
  try{
    const res=await postJSONWithTimeout('/api/inventory/sync-completed-orders',{},45000);
    S=await api.get('/api/data');
    await pollStockAlerts();
    rInventory(); rDash(); rOrders(); rAlerts(); updBadge();
    toast(`Synced ${res.syncedNow} completed order(s) to inventory`,'ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
async function syncAndRefreshInventory(){
  setInventorySyncBtnLoading(true);
  try{
    const res=await postJSONWithTimeout('/api/inventory/sync-completed-orders',{},45000);
    S=await api.get('/api/data');
    await pollStockAlerts();
    rInventory(); rDash(); rOrders(); rAlerts(); updBadge();
    const n=(res.reconciledNow ?? res.syncedNow ?? 0);
    toast(`Synced ${n} completed order(s) and refreshed`,'ok');
  }catch(e){
    const msg=(e&&e.message||'');
    if(msg.includes('409') || msg.toLowerCase().includes('already in progress')){
      toast('Sync already running. Please wait and refresh.','err');
    }else{
      toast('Error: '+msg,'err');
    }
  }finally{
    setInventorySyncBtnLoading(false);
  }
}

// ─── fGrams helper for CRM (mirrors inventory app) ────────────────────────────
function fGrams(g){ return g >= 1000 ? (g/1000).toFixed(2)+' kg' : Number(g||0).toFixed(0)+' g'; }
function updBadge(){
  const n = getAlerts().length + stockAlerts.length;
  // Desktop sidebar badge
  const el=g('nav-alerts'); const ex=el.querySelector('.n-badge'); if(ex) ex.remove();
  if(n>0) el.insertAdjacentHTML('beforeend',`<span class="n-badge">${n}</span>`);
  // Mobile bottom nav badge
  const mb=g('bnav-badge');
  if(mb){ mb.textContent=n; mb.style.display=n>0?'flex':'none'; }
}
function calcInventoryUsageFromOrders(){
  let moved=0;
  (S.orders||[]).forEach(o=>{
    if(o.status!=='completed') return;
    const prod=(S.products||[]).find(p=>p.id===o.prodId);
    const comp=(prod&&Array.isArray(prod.composition))?prod.composition:[];
    if(!comp.length) return;
    const pack=variantToGrams(o.variant);
    const qty=parseFloat(o.qty||0)||0;
    if(pack<=0||qty<=0) return;
    const total=pack*qty;
    comp.forEach(c=>{
      const pct=parseFloat(c.percentage||0)||0;
      if(pct>0) moved += total*(pct/100);
    });
  });
  const left=(inventorySnapshot||[]).reduce((s,p)=>s+(parseFloat(p.stockGrams)||0),0);
  return { moved, left, connected:(inventorySnapshot||[]).length>0 };
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function rDash(){
  const alerts=getAlerts();
  g('dd').textContent=new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const f=calcFin();
  const inv=calcInventoryUsageFromOrders();
  const hasData=S.orders.some(o=>isCompleted(o)&&orderRevenue(o)>0);

  // Row 1: Customers+Orders merged | Revenue+Profit merged
  g('sg').innerHTML=`
    <div class="sbox accent-top">
      <div class="sbox-inner">
        <div class="sbox-half">
          <div class="sl">Customers</div>
          <div class="sv">${S.customers.length}</div>
          <div class="sn">${S.orders.length} total orders</div>
        </div>
        <div class="sbox-half">
          <div class="sl">Inventory Moved</div>
          <div class="sv">${fGrams(inv.moved)}</div>
          <div class="sn">${inv.connected?`Inventory left: ${fGrams(inv.left)}`:'Inventory app offline'}</div>
        </div>
      </div>
    </div>
    <div class="sbox ${alerts.length?'red-top':'accent-top'}">
      <div class="sbox-inner">
        <div class="sbox-half">
          <div class="sl">Revenue</div>
          <div class="sv">${hasData?fC(f.revAll):'—'}</div>
          <div class="sn">${hasData?'This month: '+fC(f.revM):'Add pricing in Settings'}</div>
        </div>
        <div class="sbox-half">
          <div class="sl">Alerts</div>
          <div class="sv ${alerts.length?'red':''}">${alerts.length}</div>
          <div class="sn">${alerts.length?'Need follow-up':'All on track'}</div>
        </div>
      </div>
    </div>`;

  // Row 2: MoM | YoY merged
  g('sg2').innerHTML=`
    <div class="sbox ${f.mom==null?'accent-top':f.mom>=0?'green-top':'red-top'}">
      <div class="sbox-inner">
        <div class="sbox-half">
          <div class="sl">MoM Change</div>
          <div class="sv ${f.mom==null?'':f.mom>=0?'green':'red'}">${f.mom==null?'—':fPct(f.mom)+pArr(f.mom)}</div>
          <div class="sn ${pCls(f.mom)}">${f.mom==null?'Not enough data':'This month: '+fC(f.revM)}</div>
        </div>
        <div class="sbox-half">
          <div class="sl">Profit</div>
          <div class="sv ${!hasData?'':f.profAll>=0?'green':'red'}">${hasData?fC(f.profAll):'—'}</div>
          <div class="sn">${hasData?'This month: '+fC(f.profM):'—'}</div>
        </div>
      </div>
    </div>
    <div class="sbox ${f.yoy==null?'accent-top':f.yoy>=0?'green-top':'red-top'}">
      <div class="sbox-inner">
        <div class="sbox-half">
          <div class="sl">YoY Change</div>
          <div class="sv ${f.yoy==null?'':f.yoy>=0?'green':'red'}">${f.yoy==null?'—':fPct(f.yoy)+pArr(f.yoy)}</div>
          <div class="sn ${pCls(f.yoy)}">${f.yoy==null?'Not enough data':'vs last year'}</div>
        </div>
        <div class="sbox-half">
          <div class="sl">Avg Order Value</div>
          <div class="sv">${hasData&&S.orders.filter(isCompleted).length>0?fC(f.revAll/S.orders.filter(isCompleted).length):'—'}</div>
          <div class="sn">${hasData?'Per completed order':'—'}</div>
        </div>
      </div>
    </div>`;

  // Recent orders — clean design-system rows
  const dO=g('d-orders');
  const recent=S.orders.slice(0,6);
  dO.innerHTML=recent.length?recent.map(o=>{
    const rev=orderRevenue(o),opts=statusOpts(o.channel||'retail');
    const stCls=STATUS_CLS[o.status||'pending'];
    const stLbl=STATUS_LABEL[o.status]||o.status;
    const stSelect=`<select class="inline-status-sel ${stCls}" onchange="dashQuickStatus(${o.id},this)">${opts.map(s=>`<option value="${s.id}" ${o.status===s.id?'selected':''}>${s.label}</option>`).join('')}</select>`;
    return`<div class="dash-order-row">
      <div class="dash-order-info">
        <div class="dor-name">${esc(o.cname)}</div>
        <div class="dor-prod">${esc(o.prod)} · ${VL[o.variant]||o.variant} · <span class="ch-badge ch-badge--${o.channel||'retail'}" style="padding:1px 6px;font-size:10.5px">${CHANNEL_MAP[o.channel||'retail']?.label||o.channel}</span></div>
      </div>
      <div class="dash-order-meta">
        ${isCompleted(o)&&rev>0?`<span style="font-size:12px;font-weight:700;color:var(--green)">₹${rev.toFixed(0)}</span>`:`<span style="font-size:11.5px;color:var(--text-3)">${fd(o.at)}</span>`}
        ${stSelect}
      </div>
    </div>`;
  }).join(''):`<div class="empty" style="padding:28px 18px"><div class="ei">📋</div><div class="et">No orders yet</div></div>`;

  // Alerts panel
  const dA=g('d-al');
  g('d-ab').innerHTML=alerts.length?`<span class="pill pr" style="font-size:10px;padding:1px 7px">${alerts.length}</span>`:'';
  dA.innerHTML=alerts.length?alerts.slice(0,4).map(a=>{
    const ov=a.dl<=0,wa=buildWaUrl(a);
    return`<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)"><div class="adot ${a.mode==='smart'?'sm':ov?'ov':'ds'}" style="flex-shrink:0"></div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${a.cust.name}</div><div style="font-size:11.5px;color:var(--text-3)">${a.last.prod} · ${VL[a.last.variant]||a.last.variant}</div><div style="margin-top:5px">${ov?`<span class="pill pr">${Math.abs(a.dl)}d overdue</span>`:`<span class="pill pa">Due in ${a.dl}d</span>`}</div></div><a href="${wa}" target="_blank" class="btn btn-follow-up btn-xs" style="flex-shrink:0">${WA_ICON} Remind</a></div>`;
  }).join(''):`<div class="empty" style="padding:28px 18px"><div class="ei">✓</div><div class="et">All customers on track</div></div>`;
}

async function dashQuickStatus(oid,sel){
  const newStatus=sel.value;
  const o=S.orders.find(x=>x.id===oid);
  if(shouldWebsitePendingConfirm(o,newStatus)){
    if(o) sel.value=o.status;
    showWebsitePendingConfirmPopup(oid,newStatus,'dashboard');
    return;
  }
  if(newStatus==='completed'){
    // reset select to old value, show popup
    if(o) sel.value=o.status;
    showPaymentPopup(oid,newStatus);
    return;
  }
  if(newStatus==='shipped'){
    const o=S.orders.find(x=>x.id===oid);
    if(o) sel.value=o.status;
    if(o && !(o.channel==='website' || o.channel==='whatsapp')){
      toast('Shipped status is for Website/WhatsApp orders','err');
      return;
    }
    openShippedStatusPopup(oid,'dashboard');
    return;
  }
  try{
    const updated=await api.put(`/api/orders/${oid}`,{status:newStatus});
    syncOrder(updated); rDash(); updBadge(); toast('Status updated','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function rSettings(){
  const c=g('prod-list-container');
  if(!S.products.length){c.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">No products yet</div></div>`;return;}
  c.innerHTML=S.products.map(p=>buildProdCard(p)).join('');
}
function buildProdCard(p){
  const compRows=(p.composition&&p.composition.length)?p.composition:[{inventoryProductId:'',percentage:100}];
  const compEditorRows=buildExistingCompRows(p.id, compRows);
  const compTotal=(p.composition||[]).reduce((s,c)=>s+(parseFloat(c.percentage)||0),0);
  const compOk=(p.composition||[]).length>0 && Math.abs(compTotal-100)<=0.01;
  const st=p.sizes.map((sz,i)=>`<button class="size-tab ${i===0?'active':''}" onclick="switchSizeTab('${p.id}','${sz}')" id="tab-${p.id}-${sz}">${VL[sz]||sz}</button>`).join('');
  const sp=p.sizes.map((sz,i)=>buildSizePanel(p,sz,i===0)).join('');
  const comp=(p.composition||[]).map(c=>`${c.inventoryProductName||c.inventoryProductId} ${Number(c.percentage||0).toFixed(0)}%`).join(' + ');
  const sub=[p.sizes.map(s=>VL[s]||s).join(' · '), comp?`Mix: ${comp}`:'Mix: Not configured'].join(' · ');
  return`<div class="prod-card" id="pcard-${p.id}"><div class="prod-card-header" onclick="toggleProdCard('${p.id}')"><div><div class="prod-card-title">${p.name}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${sub}</div></div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:var(--text-3)" id="pcard-chevron-${p.id}">▼</span><button class="btn btn-danger btn-xs" onclick="event.stopPropagation();delProduct('${p.id}')">Delete</button></div></div><div class="prod-card-body" id="pcard-body-${p.id}"><div class="sl-label" style="margin-bottom:10px">Composition (Inventory Mapping)</div><div id="pc-comp-rows-${p.id}" style="display:flex;flex-direction:column;gap:8px">${compEditorRows}</div><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px"><button class="btn btn-s btn-sm" onclick="addExistingCompRow('${p.id}')">＋ Add Ingredient</button><div id="pc-comp-hint-${p.id}" style="font-size:12px;color:${compOk?'var(--green)':'var(--amber)'}">${(p.composition||[]).length?`Total: <strong>${compTotal.toFixed(2)}%</strong> ${compOk?'✓':'(must be 100%)'}`:'Set at least one ingredient. Total must be 100%.'}</div></div><div style="margin-top:10px"><button class="btn btn-p btn-sm" onclick="saveExistingComposition('${p.id}')">Save Composition</button></div><hr><div class="size-tab-row">${st}</div><div id="size-panels-${p.id}">${sp}</div></div></div>`;
}
function inventoryProductOptions(selected=''){
  const base='<option value="">Select inventory product…</option>';
  const list=inventorySnapshot.length
    ? inventorySnapshot.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')
    : '<option value="">Inventory app not connected</option>';
  return base+list;
}
function buildExistingCompRows(pid, rows){
  return rows.map((r,i)=>`<div class="pc-comp-row" style="display:grid;grid-template-columns:1fr 120px 40px;gap:8px;align-items:center">
    <select id="pc-comp-prod-${pid}-${i}">${inventoryProductOptions(r.inventoryProductId||'')}</select>
    <div class="input-prefix"><span>%</span><input id="pc-comp-pct-${pid}-${i}" type="number" min="0.01" max="100" step="0.01" value="${r.percentage||''}" oninput="refreshExistingCompHint('${pid}')"></div>
    <button class="btn btn-g btn-xs" onclick="removeExistingCompRow('${pid}',${i})">✕</button>
  </div>`).join('');
}
function getExistingCompRows(pid){
  const wrap=g(`pc-comp-rows-${pid}`); if(!wrap) return [];
  const rows=[]; let i=0;
  while(g(`pc-comp-prod-${pid}-${i}`)){
    rows.push({
      inventoryProductId:(g(`pc-comp-prod-${pid}-${i}`)?.value||'').trim(),
      percentage:parseFloat(g(`pc-comp-pct-${pid}-${i}`)?.value||0)||0,
    });
    i++;
  }
  return rows;
}
function renderExistingCompRows(pid, rows){
  const wrap=g(`pc-comp-rows-${pid}`); if(!wrap) return;
  wrap.innerHTML=buildExistingCompRows(pid, rows);
  refreshExistingCompHint(pid);
}
function addExistingCompRow(pid){
  const rows=getExistingCompRows(pid);
  rows.push({inventoryProductId:'',percentage:0});
  renderExistingCompRows(pid, rows);
}
function removeExistingCompRow(pid, idx){
  const rows=getExistingCompRows(pid).filter((_,i)=>i!==idx);
  renderExistingCompRows(pid, rows.length?rows:[{inventoryProductId:'',percentage:100}]);
}
function refreshExistingCompHint(pid){
  const rows=getExistingCompRows(pid).filter(r=>r.inventoryProductId||r.percentage>0);
  const total=rows.reduce((s,r)=>s+(parseFloat(r.percentage)||0),0);
  const el=g(`pc-comp-hint-${pid}`); if(!el) return;
  if(!rows.length){ el.textContent='Set at least one ingredient. Total must be 100%.'; el.style.color='var(--text-3)'; return; }
  const ok=Math.abs(total-100)<=0.01;
  el.innerHTML=`Total: <strong>${total.toFixed(2)}%</strong> ${ok?'✓':'(must be 100%)'}`;
  el.style.color=ok?'var(--green)':'var(--amber)';
}
async function saveExistingComposition(pid){
  const prod=S.products.find(p=>p.id===pid); if(!prod) return;
  const rows=getExistingCompRows(pid).filter(r=>r.inventoryProductId||r.percentage>0);
  if(!rows.length){ toast('Add at least one composition row','err'); return; }
  if(rows.some(r=>!r.inventoryProductId||r.percentage<=0)){ toast('Each composition row needs product + percentage','err'); return; }
  const totalPct=rows.reduce((s,r)=>s+r.percentage,0);
  if(Math.abs(totalPct-100)>0.01){ toast('Composition total must be exactly 100%','err'); return; }
  const composition=rows.map(r=>{const inv=inventorySnapshot.find(p=>p.id===r.inventoryProductId);return{inventoryProductId:r.inventoryProductId,inventoryProductName:inv?.name||r.inventoryProductId,percentage:r.percentage};});
  try{
    const updated=await api.put(`/api/products/${pid}`,{composition});
    const idx=S.products.findIndex(p=>p.id===pid); if(idx>=0) S.products[idx]=updated;
    toast(`Saved composition for ${updated.name}`,'ok');
    rSettings();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
function buildSizePanel(p,sz,isActive){
  const pr=(p.pricing&&p.pricing[sz])||{salePrices:{retail:0,website:0,whatsapp:0},expenses:[]};
  const sp=pr.salePrices||{retail:0,website:0,whatsapp:0};
  const exRows=(pr.expenses||[]).map((e,i)=>buildExpRow(p.id,sz,i,e.name,e.cost)).join('');
  const tc=(pr.expenses||[]).reduce((s,e)=>s+(parseFloat(e.cost)||0),0);
  const ci=CHANNELS.map(c=>`<div class="fg"><label>${c.label}</label><div class="input-prefix"><span>₹</span><input type="number" id="sp-${c.id}-${p.id}-${sz}" value="${sp[c.id]||0}" min="0" placeholder="0" oninput="calcMargin('${p.id}','${sz}')"></div></div>`).join('');
  return`<div class="size-panel ${isActive?'active':''}" id="sp-${p.id}-${sz}"><div class="sl-label" style="margin-bottom:10px">Sale Prices — ${VL[sz]||sz}</div><div class="fr3" style="margin-bottom:18px">${ci}</div><div class="sl-label">Cost / Expenses per pack</div><div id="expenses-${p.id}-${sz}">${exRows}</div><button class="btn btn-s btn-sm mt8" onclick="addExpRow('${p.id}','${sz}')">＋ Add Expense</button><div class="margin-display mt12" id="margin-display-${p.id}-${sz}">${buildMarginHTML(p.id,sz,tc,sp)}</div><div style="margin-top:14px"><button class="btn btn-p btn-sm" onclick="saveSizePricing('${p.id}','${sz}')">Save ${VL[sz]||sz} Pricing</button></div></div>`;
}
function buildMarginHTML(pid,sz,tc,sp){
  const rows=CHANNELS.map(c=>{const price=parseFloat(sp[c.id])||0;if(!price)return'';const margin=price-tc,mpct=price>0?(margin/price*100):0;return`<div class="margin-row"><span class="margin-key">${c.label}</span><span class="margin-val ${margin>=0?'pos':'neg'}">₹${margin.toFixed(0)} <span style="font-size:11px">(${mpct.toFixed(1)}%)</span></span></div>`;}).filter(Boolean).join('');
  return`<div class="margin-row"><span class="margin-key">Total Cost / pack</span><span class="margin-val ${tc>0?'neg':''}">${tc>0?'₹'+tc.toFixed(0):'—'}</span></div>${rows||'<div style="font-size:12px;color:var(--text-3);padding:4px 0">Set sale prices above to see margins</div>'}`;
}
function buildExpRow(pid,sz,idx,name='',cost=''){ return`<div class="expense-row" id="er-${pid}-${sz}-${idx}"><input type="text" value="${esc(String(name))}" placeholder="Expense name" id="en-${pid}-${sz}-${idx}" oninput="calcMargin('${pid}','${sz}')"><div class="input-prefix"><span>₹</span><input type="number" value="${cost}" placeholder="0" min="0" id="ec-${pid}-${sz}-${idx}" oninput="calcMargin('${pid}','${sz}')"></div><button class="del-btn" onclick="removeExpRow('${pid}','${sz}',${idx})">✕</button></div>`; }
function toggleProdCard(pid){ const b=g('pcard-body-'+pid),c=g('pcard-chevron-'+pid);b.classList.toggle('collapsed');c.textContent=b.classList.contains('collapsed')?'▶':'▼'; }
function switchSizeTab(pid,sz){ const prod=S.products.find(p=>p.id===pid);(prod.sizes||DEFAULT_SIZES).forEach(s=>{const t=g(`tab-${pid}-${s}`),p=g(`sp-${pid}-${s}`);if(t)t.classList.remove('active');if(p)p.classList.remove('active');});const t=g(`tab-${pid}-${sz}`),p=g(`sp-${pid}-${sz}`);if(t)t.classList.add('active');if(p)p.classList.add('active'); }
function getExpRows(pid,sz){ const rows=[];let i=0;while(g(`er-${pid}-${sz}-${i}`)){const n=g(`en-${pid}-${sz}-${i}`).value.trim(),c=g(`ec-${pid}-${sz}-${i}`).value;if(n||c)rows.push({name:n,cost:parseFloat(c)||0});i++;}return rows; }
function calcMargin(pid,sz){ const disp=g(`margin-display-${pid}-${sz}`);if(!disp)return;const exp=getExpRows(pid,sz);const tc=exp.reduce((s,e)=>s+(parseFloat(e.cost)||0),0);const sp={};CHANNELS.forEach(c=>{sp[c.id]=parseFloat((g(`sp-${c.id}-${pid}-${sz}`)||{}).value||0)||0;});disp.innerHTML=buildMarginHTML(pid,sz,tc,sp); }
function addExpRow(pid,sz){ let i=0;while(g(`er-${pid}-${sz}-${i}`))i++;const c=g(`expenses-${pid}-${sz}`);const d=document.createElement('div');d.innerHTML=buildExpRow(pid,sz,i,'','');c.appendChild(d.firstChild);calcMargin(pid,sz); }
function removeExpRow(pid,sz,idx){ const el=g(`er-${pid}-${sz}-${idx}`);if(el){el.remove();calcMargin(pid,sz);} }
async function saveSizePricing(pid,sz){ const prod=S.products.find(p=>p.id===pid);if(!prod.pricing)prod.pricing={};const salePrices={};CHANNELS.forEach(c=>{salePrices[c.id]=parseFloat((g(`sp-${c.id}-${pid}-${sz}`)||{}).value||0)||0;});if(!Object.values(salePrices).some(v=>v>0)){toast('Set at least one sale price','err');return;}prod.pricing[sz]={salePrices,expenses:getExpRows(pid,sz)};try{await api.put(`/api/products/${pid}`,{pricing:prod.pricing});toast(`Saved ${prod.name} — ${VL[sz]||sz}`,'ok');calcMargin(pid,sz);}catch(e){toast('Error: '+e.message,'err');} }
function getCompositionRows(){
  const rows=[];
  document.querySelectorAll('#np-comp-rows .comp-row').forEach((row)=>{
    rows.push({
      inventoryProductId:(row.querySelector('.comp-prod')?.value||'').trim(),
      percentage:parseFloat(row.querySelector('.comp-pct')?.value||0)||0,
    });
  });
  return rows;
}
function renderCompositionRows(rows){
  const wrap=g('np-comp-rows'); if(!wrap) return;
  const opts=inventorySnapshot.length
    ? `<option value="">Select inventory product…</option>${inventorySnapshot.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}`
    : '<option value="">Inventory app not connected</option>';
  wrap.innerHTML=rows.map((r,i)=>`<div class="comp-row" style="display:grid;grid-template-columns:1fr 120px 40px;gap:8px;align-items:center">
    <select class="comp-prod" onchange="refreshCompositionHint()">${opts}</select>
    <div class="input-prefix"><span>%</span><input class="comp-pct" type="number" min="0.01" max="100" step="0.01" value="${r.percentage||''}" oninput="refreshCompositionHint()"></div>
    <button class="btn btn-g btn-xs" onclick="removeCompositionRow(${i})">✕</button>
  </div>`).join('');
  document.querySelectorAll('#np-comp-rows .comp-row').forEach((row,i)=>{
    const sel=row.querySelector('.comp-prod');
    if(sel && rows[i]?.inventoryProductId) sel.value=rows[i].inventoryProductId;
  });
  refreshCompositionHint();
}
function addCompositionRow(){
  const rows=getCompositionRows();
  rows.push({inventoryProductId:'',percentage:0});
  renderCompositionRows(rows);
}
function removeCompositionRow(idx){
  const rows=getCompositionRows().filter((_,i)=>i!==idx);
  renderCompositionRows(rows.length?rows:[{inventoryProductId:'',percentage:100}]);
}
function resetCompositionBuilder(){ renderCompositionRows([{inventoryProductId:'',percentage:100}]); }
function refreshCompositionHint(){
  const rows=getCompositionRows().filter(r=>r.inventoryProductId||r.percentage>0);
  const total=rows.reduce((s,r)=>s+(parseFloat(r.percentage)||0),0);
  const el=g('np-comp-hint'); if(!el) return;
  if(!rows.length){ el.textContent='Set at least one ingredient. Total must be 100%.'; el.style.color='var(--text-3)'; return; }
  const ok=Math.abs(total-100)<=0.01;
  el.innerHTML=`Total: <strong>${total.toFixed(2)}%</strong> ${ok?'✓':'(must be 100%)'}`;
  el.style.color=ok?'var(--green)':'var(--amber)';
}
async function addProduct(){
  const name=g('np-name').value.trim();if(!name){toast('Enter a product name','err');return;}
  const sizes=[];document.querySelectorAll('#np-sizes-wrap input[type=checkbox]').forEach(cb=>{if(cb.checked)sizes.push(cb.value);});
  if(!sizes.length){toast('Select at least one size','err');return;}
  const rawRows=getCompositionRows().filter(r=>r.inventoryProductId||r.percentage>0);
  if(!rawRows.length){toast('Add at least one composition row','err');return;}
  if(rawRows.some(r=>!r.inventoryProductId||r.percentage<=0)){toast('Each composition row needs product + percentage','err');return;}
  const totalPct=rawRows.reduce((s,r)=>s+r.percentage,0);
  if(Math.abs(totalPct-100)>0.01){toast('Composition total must be exactly 100%','err');return;}
  const composition=rawRows.map(r=>{const inv=inventorySnapshot.find(p=>p.id===r.inventoryProductId);return{inventoryProductId:r.inventoryProductId,inventoryProductName:inv?.name||r.inventoryProductId,percentage:r.percentage};});
  try{
    const product=await api.post('/api/products',{name,sizes,waTpl:'',pricing:{},composition});
    S.products.push(product);S.pid=parseInt(product.id.replace('p',''))+1;g('np-name').value='';resetCompositionBuilder();
    toast(name+' added','ok');sPanel('products');rSettings();populateProdSelect();
  }catch(e){toast('Error: '+e.message,'err');}
}
async function delProduct(pid){ if(!confirm('Delete this product?'))return;try{await api.del(`/api/products/${pid}`);S.products=S.products.filter(p=>p.id!==pid);rSettings();populateProdSelect();toast('Product deleted');}catch(e){toast('Error: '+e.message,'err');} }

// ─── WA TEMPLATES ────────────────────────────────────────────────────────────
function getWaTpl(pid){ const prod=S.products.find(p=>p.id===pid);if(prod&&prod.waTpl&&prod.waTpl.trim())return prod.waTpl;return(S.waDefaultTpl&&S.waDefaultTpl.trim())?S.waDefaultTpl:DEFAULT_WA_TPL; }
function applyWaTokens(tpl,d){ return tpl.replace(/\{\{customer_name\}\}/g,d.customer_name||'').replace(/\{\{last_order_date\}\}/g,d.last_order_date||'').replace(/\{\{product_name\}\}/g,d.product_name||'').replace(/\{\{variant\}\}/g,d.variant||'').replace(/\{\{qty\}\}/g,d.qty||''); }
function buildWaUrl(alert){ const tpl=getWaTpl(alert.last.prodId);const msg=applyWaTokens(tpl,{customer_name:alert.cust.name,last_order_date:fd(alert.last.at),product_name:alert.last.prod,variant:VL[alert.last.variant]||alert.last.variant,qty:String(alert.last.qty)});return`https://wa.me/91${alert.cust.phone}?text=${encodeURIComponent(msg)}`; }
function rWaMessages(){ const de=g('wa-tpl-default');if(de)de.value=S.waDefaultTpl||DEFAULT_WA_TPL;previewWa('default');const c=g('wa-prod-cards');if(!c)return;c.innerHTML=S.products.map(p=>{const tpl=p.waTpl||'';const tokens=['{{customer_name}}','{{last_order_date}}','{{product_name}}','{{variant}}','{{qty}}'];const chips=tokens.map(t=>`<span class="token-chip" onclick="insertToken('wa-tpl-${p.id}','${t}','${p.id}')">${t}</span>`).join('');return`<div class="wa-card"><div class="wa-card-header"><div><div class="wa-card-title">${p.name}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${tpl?'Custom template set':'Using default template'}</div></div>${tpl?`<button class="btn btn-danger btn-xs" onclick="clearProdWaTpl('${p.id}')">Reset</button>`:`<span class="pill pn" style="font-size:11px">Default</span>`}</div><div class="wa-card-body"><div class="fg"><label>Message <span style="color:var(--text-3);font-weight:400">(blank = use default)</span></label><textarea id="wa-tpl-${p.id}" rows="3" oninput="previewWa('${p.id}')" placeholder="Leave blank to use the default template…">${tpl}</textarea></div><div class="token-chips">${chips}</div><div style="font-size:11px;color:var(--text-3);margin-top:6px;font-style:italic">Preview:</div><div class="wa-preview" id="wa-prev-${p.id}"></div><div style="margin-top:12px"><button class="btn btn-p btn-sm" onclick="saveWaTpl('${p.id}')">Save for ${p.name}</button></div></div></div>`;}).join('');S.products.forEach(p=>previewWa(p.id)); }
function insertToken(taId,token,pk){ const el=g(taId);if(!el)return;const s=el.selectionStart,e=el.selectionEnd;el.value=el.value.slice(0,s)+token+el.value.slice(e);el.selectionStart=el.selectionEnd=s+token.length;el.focus();previewWa(pk); }
function previewWa(key){ const taId=key==='default'?'wa-tpl-default':`wa-tpl-${key}`;const prId=key==='default'?'wa-prev-default':`wa-prev-${key}`;const el=g(taId),pr=g(prId);if(!el||!pr)return;let tpl=el.value.trim();if(!tpl&&key!=='default')tpl=S.waDefaultTpl||DEFAULT_WA_TPL;if(!tpl)tpl=DEFAULT_WA_TPL;pr.innerHTML=applyWaTokens(tpl,{customer_name:'Priya Shankar',last_order_date:'12 Jun 2025',product_name:key==='default'?'Coorg Filter Coffee':((S.products.find(p=>p.id===key)||{}).name||'Product'),variant:'250g',qty:'1'}).replace(/\n/g,'<br>'); }
async function saveWaTpl(key){ if(key==='default'){const el=g('wa-tpl-default');if(!el)return;S.waDefaultTpl=el.value.trim();try{await api.put('/api/settings',{waDefaultTpl:S.waDefaultTpl});toast('Default template saved','ok');rWaMessages();}catch(e){toast('Error: '+e.message,'err');}}else{const prod=S.products.find(p=>p.id===key);if(!prod)return;const el=g(`wa-tpl-${key}`);if(!el)return;prod.waTpl=el.value.trim();try{await api.put(`/api/products/${key}`,{waTpl:prod.waTpl});toast(`Template saved for ${prod.name}`,'ok');rWaMessages();}catch(e){toast('Error: '+e.message,'err');}} }
async function clearProdWaTpl(pid){ const prod=S.products.find(p=>p.id===pid);if(!prod)return;prod.waTpl='';try{await api.put(`/api/products/${pid}`,{waTpl:''});toast('Reset to default');rWaMessages();}catch(e){toast('Error: '+e.message,'err');} }

// ─── SHIPPING SETTINGS ───────────────────────────────────────────────────────
let SHIPPING_ROWS = [];
function loadShippingRowsFromProfile(){
  const rows=getCourierConfigs();
  SHIPPING_ROWS=rows.length?rows.map(r=>({...r})):[{name:'',trackingTemplate:'',codeType:'barcode'}];
}
function renderShippingRows(){
  const wrap=g('ship-track-templates');
  if(!wrap) return;
  wrap.innerHTML=SHIPPING_ROWS.map((row,i)=>{
    const ex=buildTrackingLink(row.trackingTemplate, EXAMPLE_AWB);
    return `<div class="card" style="padding:12px;border:1px solid var(--border)">
      <div class="fr" style="align-items:end">
        <div class="fg">
          <label>Courier Service</label>
          <input id="ship-courier-name-${i}" type="text" value="${esc(row.name)}" placeholder="e.g. Professional Courier" oninput="updateShippingRow(${i},'name',this.value)">
        </div>
        <div class="fg">
          <label>Label Code Type</label>
          <select id="ship-code-type-${i}" onchange="updateShippingRow(${i},'codeType',this.value)">
            <option value="barcode" ${normalizeCodeType(row.codeType)==='barcode'?'selected':''}>Barcode</option>
            <option value="qr" ${normalizeCodeType(row.codeType)==='qr'?'selected':''}>QR Code</option>
          </select>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button type="button" class="btn btn-danger btn-sm" onclick="removeShippingRow(${i})">Remove</button>
        </div>
      </div>
      <div class="fg" style="margin-top:8px;gap:4px">
        <label>Tracking URL Template</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ship-track-${i}" type="text" value="${esc(row.trackingTemplate)}" placeholder="https://tracking.example.com?awb={{awb}}" oninput="updateShippingRow(${i},'trackingTemplate',this.value);updateTrackingTemplatePreview(${i})">
          <button type="button" class="btn btn-sm" onclick="insertAwbPlaceholder(${i})">Insert AWB</button>
        </div>
        <div id="ship-track-prev-${i}" style="font-size:11.5px;color:${ex?'var(--green)':'var(--text-3)'}">${ex?`Example: ${ex}`:'Use {{awb}} placeholder for AWB insertion.'}</div>
      </div>
    </div>`;
  }).join('');
}
function addShippingRow(){
  SHIPPING_ROWS.push({name:'',trackingTemplate:'',codeType:'barcode'});
  renderShippingRows();
}
function removeShippingRow(i){
  SHIPPING_ROWS.splice(i,1);
  if(!SHIPPING_ROWS.length) SHIPPING_ROWS.push({name:'',trackingTemplate:'',codeType:'barcode'});
  renderShippingRows();
}
function updateShippingRow(i,key,val){
  if(!SHIPPING_ROWS[i]) return;
  if(key==='codeType') SHIPPING_ROWS[i][key]=normalizeCodeType(val);
  else SHIPPING_ROWS[i][key]=String(val||'');
}
function rShippingSettings(){
  const p=S.shippingProfile||{};
  if(g('ship-company')) g('ship-company').value=p.companyName||'';
  if(g('ship-address')) g('ship-address').value=p.address||'';
  if(g('ship-phone')) g('ship-phone').value=p.phone||'';
  if(g('ship-email')) g('ship-email').value=p.email||'';
  if(g('ship-gstin')) g('ship-gstin').value=p.gstin||'';
  if(g('ship-pg-commission')) g('ship-pg-commission').value=(Number.isFinite(parseFloat(p.paymentGatewayCommissionPct))?parseFloat(p.paymentGatewayCommissionPct):3);
  loadShippingRowsFromProfile();
  renderShippingRows();
}
function updateTrackingTemplatePreview(i){
  const inp=g(`ship-track-${i}`); const prev=g(`ship-track-prev-${i}`);
  if(!inp||!prev) return;
  const ex=buildTrackingLink(inp.value, EXAMPLE_AWB);
  prev.textContent=ex?`Example: ${ex}`:'Use {{awb}} placeholder for AWB insertion.';
  prev.style.color=ex?'var(--green)':'var(--text-3)';
}
function insertAwbPlaceholder(i){
  const inp=g(`ship-track-${i}`);
  if(!inp) return;
  const token='{{awb}}';
  const s=typeof inp.selectionStart==='number'?inp.selectionStart:inp.value.length;
  const e=typeof inp.selectionEnd==='number'?inp.selectionEnd:inp.value.length;
  inp.value = inp.value.slice(0,s) + token + inp.value.slice(e);
  const pos=s+token.length;
  inp.selectionStart=pos;
  inp.selectionEnd=pos;
  inp.focus();
  updateTrackingTemplatePreview(i);
}
async function saveShippingSettings(){
  const rows=[];
  const seen=new Set();
  for(const row of SHIPPING_ROWS){
    const name=String(row.name||'').trim();
    const trackingTemplate=String(row.trackingTemplate||'').trim();
    const codeType=normalizeCodeType(row.codeType);
    if(!name && !trackingTemplate) continue;
    if(!name){
      toast('Courier service name is required for each row','err');
      return;
    }
    const key=name.toLowerCase();
    if(seen.has(key)){
      toast(`Duplicate courier: ${name}`,'err');
      return;
    }
    seen.add(key);
    rows.push({name,trackingTemplate,codeType});
  }
  const templates={};
  rows.forEach(r=>{ templates[r.name]=r.trackingTemplate; });
  const profile={
    companyName:(g('ship-company')?.value||'').trim(),
    address:(g('ship-address')?.value||'').trim(),
    phone:(g('ship-phone')?.value||'').trim(),
    email:(g('ship-email')?.value||'').trim(),
    gstin:(g('ship-gstin')?.value||'').trim(),
    paymentGatewayCommissionPct:Math.max(0,parseFloat(g('ship-pg-commission')?.value||3)||0),
    couriers: rows,
    trackingTemplates: templates,
  };
  try{
    await api.put('/api/settings',{shippingProfile:profile});
    S.shippingProfile=profile;
    loadShippingRowsFromProfile();
    toast('Shipping details saved','ok');
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function g(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function dateToISO(ts){ const d=new Date(ts);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// ─── BOOT ────────────────────────────────────────────────────────────────────
async function init(){
  try{ S=await api.get('/api/data'); }
  catch(err){ g('toasts').innerHTML=`<div class="toast err">Cannot reach server: ${err.message}</div>`; return; }
  // Poll inventory stock levels (silently fails if inventory app is not running)
  await pollStockAlerts();
  // Re-poll every 5 minutes
  setInterval(pollStockAlerts, 5 * 60 * 1000);
  updBadge(); rDash(); populateProdSelect(); setDefaultDate(); resetCompositionBuilder();
}
window.addEventListener('DOMContentLoaded',init);
