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
const DEFAULT_SHIPPED_WA_TPL = `Hi {{customer_name}}, your order #{{order_id}} for {{product_name}} has been shipped on {{ship_date}}.\nAWB: {{awb}}\nCourier: {{courier}}{{tracking_line}}`;

const WA_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;

// ─── STATE ───────────────────────────────────────────────────────────────────
let S = null;
let FULL_DATA_READY = false;
let FULL_DATA_PROMISE = null;
let DASH_BOOTSTRAP_METRICS = null;
let FEATURE_CONFIG = { usernamePasswordAuthEnabled:false, roleBasedAccessEnabled:false };
let AUTH_STATE = { enabled:false, roleModelEnabled:false, setupRequired:false, authenticated:true, user:null };
let ORDER_PAGES = { active: 1, completed: 1 };
let CUSTOMER_PAGE = 1;
const ORDERS_PAGE_SIZE = 40;
const CUSTOMERS_PAGE_SIZE = 24;
let MARKETING_TAG_FILTERS = [];
let CUSTOMER_EXPORT_SELECTION = [];
let _lastActionEl = null;
let _lastActionAt = 0;
let _uiReqDepth = 0;
let _uiLoadingEl = null;
let _marketingLastWaUrl = '';

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
function authContext(){
  const fallback={ enabled:false, authenticated:true, setupRequired:false, user:null, roleModelEnabled:false };
  if(AUTH_STATE && typeof AUTH_STATE==='object') return { ...fallback, ...AUTH_STATE };
  return fallback;
}
function currentUser(){ return authContext().user || null; }
function authEnabled(){ return !!authContext().enabled; }
function roleModelEnabled(){ return !!authContext().roleModelEnabled; }
function currentPermissions(){
  return currentUser()?.permissions || { pages:{}, dashboardCards:{}, actions:{} };
}
function hasPageAccess(page){
  if(authEnabled() && !currentUser()) return false;
  if(!roleModelEnabled()) return true;
  const user=currentUser();
  if(!user) return false;
  if(user.role==='admin') return true;
  return !!currentPermissions().pages?.[page];
}
function hasActionAccess(section, action){
  if(authEnabled() && !currentUser()) return false;
  if(!roleModelEnabled()) return true;
  const user=currentUser();
  if(!user) return false;
  if(user.role==='admin') return true;
  return !!currentPermissions().actions?.[section]?.[action];
}
function hasDashboardCard(card){
  if(authEnabled() && !currentUser()) return false;
  if(!roleModelEnabled()) return true;
  const user=currentUser();
  if(!user) return false;
  if(user.role==='admin') return true;
  return !!currentPermissions().dashboardCards?.[card];
}
function canViewFinancialData(){
  return hasDashboardCard('revenue') || hasDashboardCard('profit') || hasDashboardCard('avgOrderValue');
}
function allowedInventoryProductIds(){
  const products=Array.isArray(S?.products)?S.products:[];
  if(!products.length) return null;
  const ids=new Set();
  products.forEach((product)=>{
    const comp=Array.isArray(product?.composition)?product.composition:[];
    comp.forEach((row)=>{
      const id=String(row?.inventoryProductId||'').trim();
      if(id) ids.add(id);
    });
  });
  return ids;
}
function visibleInventorySnapshot(){
  const items=Array.isArray(inventorySnapshot)?inventorySnapshot:[];
  const allowed=allowedInventoryProductIds();
  if(allowed===null) return items;
  return items.filter((item)=>allowed.has(String(item?.id||'')));
}
async function handleAuthFailure(){
  try{
    const status=await refreshAuthState();
    if(authEnabled()){
      enterAuthMode(status);
      return;
    }
    hideAuthGate();
    setAppLocked(false);
  }catch(_){}
}
async function parseApiResponse(r){
  if(r.status===401){
    await handleAuthFailure();
  }
  if(!r.ok){
    const raw=await r.text();
    let message=raw||`${r.status}`;
    try{
      const parsed=JSON.parse(raw);
      if(parsed && typeof parsed.detail==='string' && parsed.detail.trim()){
        message=parsed.detail.trim();
      }
    }catch(_){}
    message=sanitizeUiErrorMessage(message, r.status);
    throw new Error(message);
  }
  return r.json();
}
const api = {
  async get(p){ const r=await fetch(p,{credentials:'same-origin'}); return parseApiResponse(r); },
  async post(p,b){ const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),credentials:'same-origin'}); return parseApiResponse(r); },
  async put(p,b){ const r=await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),credentials:'same-origin'}); return parseApiResponse(r); },
  async del(p){ const r=await fetch(p,{method:'DELETE',credentials:'same-origin'}); return parseApiResponse(r); },
};
const THEME_OPTIONS = {
  light: 'Light',
  dark: 'Dark',
  nord: 'Nord',
  solarized: 'Solarized',
  dracula: 'Dracula',
};
const THEME_STORAGE_KEY = 'kudagu-theme';
function normalizeTheme(theme){
  const key=String(theme||'').trim().toLowerCase();
  return THEME_OPTIONS[key] ? key : 'light';
}
function persistTheme(theme){
  try{ localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme)); }catch(_){}
}
function applyTheme(theme){
  const next=normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', next);
  persistTheme(next);
  if(!S) S={};
  S.uiPreferences={...(S.uiPreferences||{}), theme: next};
  rThemeSettings();
}
function rThemeSettings(){
  const current=normalizeTheme(S?.uiPreferences?.theme);
  Object.keys(THEME_OPTIONS).forEach((themeKey)=>{
    const btn=g(`theme-${themeKey}-btn`);
    if(btn) btn.classList.toggle('active', current===themeKey);
  });
  const status=g('theme-status');
  if(status) status.textContent=`Current theme: ${THEME_OPTIONS[current]}. Changes apply to CRM and inventory.`;
}
async function setTheme(theme){
  const previous=normalizeTheme(S?.uiPreferences?.theme);
  const next=normalizeTheme(theme);
  if(next===previous){
    applyTheme(next);
    return;
  }
  applyTheme(next);
  try{
    const res=await api.put('/api/settings',{uiPreferences:{theme:next}});
    applyTheme(res?.uiPreferences?.theme||next);
    toast(`Theme switched to ${next}`,'ok');
  }catch(e){
    applyTheme(previous);
    toast('Error: '+e.message,'err');
  }
}
async function refreshThemePreference(){
  try{
    const data=await api.get('/api/bootstrap');
    applyTheme(data?.state?.uiPreferences?.theme||'light');
  }catch(_){}
}
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
    if(!r.ok){
      const m=await r.text();
      throw new Error(sanitizeUiErrorMessage(m||`POST ${path} → ${r.status}`, r.status));
    }
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
function orderRevenue(o){
  const rr=parseFloat(o.realizedRevenue);
  if(Number.isFinite(rr)&&rr>=0) return rr;
  return getSalePrice(o.prodId,o.variant,o.channel||'retail')*(o.qty||1);
}
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
  if(!FULL_DATA_READY && DASH_BOOTSTRAP_METRICS){
    return DASH_BOOTSTRAP_METRICS;
  }
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
function fdt(ts){ return new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
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
  const m=s.match(/^([0-9]*\.?[0-9]+)\s*(kg|g|l|ml)\s*$/i);
  if(m){
    const n=parseFloat(m[1]||0);
    const u=String(m[2]||'').toLowerCase();
    if(!Number.isFinite(n)||n<=0) return 0;
    if(u==='kg') return n*1000;
    if(u==='g') return n;
    if(u==='l') return n*1000;
    if(u==='ml') return n;
  }
  return 0;
}
function defaultVariantCycleDays(v){
  const raw=String(v||'').trim();
  if(!raw) return 10;
  const m=raw.toLowerCase().match(/^([0-9]*\.?[0-9]+)\s*(kg|g|l|ml|pcs)\s*$/i);
  if(!m) return 10;
  const n=parseFloat(m[1]||0);
  const u=String(m[2]||'').toLowerCase();
  if(!Number.isFinite(n)||n<=0) return 10;
  if(u==='kg'||u==='g'){
    const g=u==='kg' ? n*1000 : n;
    if(g<=120) return 7;
    if(g<=300) return 10;
    if(g<=600) return 14;
    if(g<=1200) return 30;
    return 45;
  }
  if(u==='l'||u==='ml'){
    const ml=u==='l' ? n*1000 : n;
    if(ml<=120) return 7;
    if(ml<=300) return 10;
    if(ml<=600) return 14;
    if(ml<=1200) return 30;
    return 45;
  }
  if(u==='pcs'){
    if(n<=1) return 7;
    if(n<=3) return 14;
    if(n<=6) return 21;
    return 30;
  }
  return 10;
}
function variantCycleDays(pidOrProduct,v){
  const prod=typeof pidOrProduct==='string'
    ? (S?.products||[]).find(p=>p.id===pidOrProduct)
    : pidOrProduct;
  const variant=v;
  const raw=String(variant||'').trim();
  const pricing=(prod&&prod.pricing&&prod.pricing[raw])||null;
  const configured=parseInt(pricing?.reorderCycleDays,10);
  if(Number.isFinite(configured) && configured>0) return configured;
  return defaultVariantCycleDays(raw);
}
function variantIdToken(v){
  return encodeURIComponent(String(v||''));
}
function parseVariantTokens(raw){
  return String(raw||'')
    .split(/[,\n]/)
    .map(v=>v.trim())
    .filter(Boolean);
}
function normalizeVariantValue(raw, metric){
  const val=String(raw||'').trim();
  if(!val) return '';
  if(metric==='custom'){
    return val
      .replace(/[<>"'`\\]/g,'')
      .replace(/\s+/g,' ')
      .trim();
  }
  const n=parseFloat(val);
  if(!Number.isFinite(n) || n<=0) return '';
  const num=Number.isInteger(n) ? String(n) : String(n);
  if(metric==='pcs') return `${num}pcs`;
  return `${num}${metric}`;
}
function buildProductVariantsFromForm(){
  const metric=(g('np-variant-metric')?.value||'g').trim().toLowerCase();
  const raw = metric==='custom'
    ? (g('np-variant-custom')?.value||'')
    : (g('np-variant-values')?.value||'');
  const out=[];
  const seen=new Set();
  parseVariantTokens(raw).forEach((token)=>{
    const norm=normalizeVariantValue(token,metric);
    if(!norm) return;
    const key=norm.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push(norm);
  });
  return out;
}
function refreshVariantBuilderUI(){
  const metric=(g('np-variant-metric')?.value||'g').trim().toLowerCase();
  const customWrap=g('np-variant-custom-wrap');
  const valuesWrap=g('np-variant-values-wrap');
  if(customWrap) customWrap.style.display=metric==='custom'?'block':'none';
  if(valuesWrap) valuesWrap.style.display=metric==='custom'?'none':'block';
  const variants=buildProductVariantsFromForm();
  const preview=g('np-variant-preview');
  if(!preview) return;
  if(!variants.length){
    preview.textContent='Variants preview: add at least one value/label.';
    preview.style.color='var(--amber)';
    return;
  }
  preview.textContent=`Variants preview: ${variants.join(', ')}`;
  preview.style.color='var(--text-3)';
}
function isDistributorOrder(o){
  return !!(o&&o.distribution&&typeof o.distribution==='object'&&String(o.distribution.distributorName||'').trim());
}
function distributorLabel(o){
  if(!isDistributorOrder(o)) return '';
  return `Batch sold via ${o.distribution.distributorName}`;
}
function batchCommissionTotal(b){
  const qty=parseInt(b?.qty||0)||0;
  const rate=parseFloat(b?.commission||0)||0;
  return (b?.commissionMode==='batch') ? rate : (rate*qty);
}
function commissionModeLabel(mode){
  return mode==='batch'?'Whole batch':'Per pcs';
}
function getSavedDistributorNames(){
  const fromSettings = Array.isArray(S?.distributionChannels) ? S.distributionChannels : [];
  const fromBatches = (S?.distributorBatches||[]).map(b=>String(b?.distributorName||'').trim());
  const merged = [...fromSettings, ...fromBatches];
  const seen = new Set();
  return merged
    .map(name=>name.replace(/\s+/g,' ').trim())
    .filter(Boolean)
    .filter((name)=>{
      const key = name.toLowerCase();
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function distributorOptionsHtml(selected=''){
  const names=getSavedDistributorNames();
  const opts=['<option value="">Select distributor…</option>'];
  names.forEach((name)=>opts.push(`<option value="${esc(name)}" ${name===selected?'selected':''}>${esc(name)}</option>`));
  opts.push(`<option value="__new__" ${selected==='__new__'?'selected':''}>+ Add new distributor…</option>`);
  return opts.join('');
}
function renderDistributorSuggestions(){
  const sel = g('dist-name');
  if(!sel) return;
  const cur = sel.value || '';
  const names = getSavedDistributorNames();
  const selected = names.some(n=>n===cur) ? cur : (cur && cur!=='__new__' ? '__new__' : cur);
  sel.innerHTML = distributorOptionsHtml(selected||'');
  const custom=g('dist-name-custom');
  if(custom){
    const show=sel.value==='__new__';
    custom.style.display=show?'block':'none';
    if(!show) custom.value='';
  }
}
async function getJSONWithTimeout(path, timeoutMs=1500){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(path,{ signal: ctrl.signal });
    if(!r.ok){
      const m=await r.text();
      throw new Error(sanitizeUiErrorMessage(m||`GET ${path} → ${r.status}`, r.status));
    }
    return r.json();
  }catch(e){
    if(e.name==='AbortError') throw new Error(`GET ${path} timed out`);
    throw e;
  }finally{
    clearTimeout(t);
  }
}
function sanitizeUiErrorMessage(raw, status){
  const txt=String(raw||'').trim();
  const lower=txt.toLowerCase();
  if(lower.includes('<!doctype html') || lower.includes('<html')){
    if(lower.includes('netbird')){
      return `Proxy upstream error (${status||502}). Please try again.`;
    }
    return `Upstream service error (${status||502}). Please try again.`;
  }
  if(txt.length>260){
    return txt.slice(0,257)+'...';
  }
  return txt || `Request failed (${status||'error'})`;
}
function emptyState(){
  return {
    customers: [],
    customerProductTags: [],
    orders: [],
    products: [],
    distributorBatches: [],
    distributionChannels: [],
    operationalExpenses: [],
    closedFollowUps: [],
    cid: 1,
    oid: 1,
    dbid: 1,
    exid: 1,
    pid: 1,
    waDefaultTpl: DEFAULT_WA_TPL,
    shippingProfile: { paymentGatewayCommissionPct: 3, couriers: [], trackingTemplates: {} },
    marketingSettings: { aiBaseUrl: 'https://api.openai.com/v1', aiModel: '', aiApiKey: '', brandName: '', systemPrompt: '' },
    uiPreferences: { theme: 'light' },
    authContext: { ...AUTH_STATE },
  };
}

function normalizeCustomerProductTags(values){
  const arr=Array.isArray(values)?values:[values];
  const out=[];
  const seen=new Set();
  arr.forEach((raw)=>{
    const name=String(raw||'').replace(/\s+/g,' ').trim();
    if(!name) return;
    const key=name.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}
function getCustomerProductTagCatalog(){
  return normalizeCustomerProductTags(S?.customerProductTags||[]);
}
function syncCustomerProductTagCatalog(extraTags=[]){
  if(!S) S=emptyState();
  const combined=[
    ...(S.customerProductTags||[]),
    ...((S.customers||[]).flatMap(c=>normalizeCustomerProductTags(c?.productTags||[]))),
    ...normalizeCustomerProductTags(extraTags),
  ];
  S.customerProductTags=normalizeCustomerProductTags(combined);
}
const CUSTOMER_TAG_PICKERS={};
function ensureCustomerTagPicker(prefix, initialTags=[]){
  CUSTOMER_TAG_PICKERS[prefix]={selected:normalizeCustomerProductTags(initialTags), addingNew:false};
  renderCustomerTagPicker(prefix);
}
function getCustomerTagPickerState(prefix){
  if(!CUSTOMER_TAG_PICKERS[prefix]) CUSTOMER_TAG_PICKERS[prefix]={selected:[],addingNew:false};
  return CUSTOMER_TAG_PICKERS[prefix];
}
function renderCustomerTagPicker(prefix){
  const host=g(`${prefix}-tag-picker`);
  if(!host) return;
  const state=getCustomerTagPickerState(prefix);
  const catalog=getCustomerProductTagCatalog().filter(tag=>!state.selected.some(sel=>sel.toLowerCase()===tag.toLowerCase()));
  host.innerHTML=`
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <select id="${prefix}-tag-select" style="flex:1;min-width:180px">
        <option value="">Select existing tag...</option>
        ${catalog.map(tag=>`<option value="${esc(tag)}">${esc(tag)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-s btn-sm" onclick="addSelectedCustomerTag('${prefix}')">Add</button>
      <button type="button" class="btn btn-g btn-sm" onclick="toggleNewCustomerTagInput('${prefix}')">${state.addingNew?'Hide':'Create New'}</button>
    </div>
    <div id="${prefix}-tag-new-wrap" style="display:${state.addingNew?'flex':'none'};gap:8px;align-items:flex-start;flex-wrap:wrap;margin-top:8px">
      <input id="${prefix}-tag-new" type="text" placeholder="Type a new tag" style="flex:1;min-width:180px">
      <button type="button" class="btn btn-p btn-sm" onclick="createCustomerTag('${prefix}')">Create Tag</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${state.selected.length?state.selected.map((tag,idx)=>`<span class="pill pn" style="display:inline-flex;align-items:center;gap:6px">${esc(tag)} <button type="button" class="btn btn-g btn-xs" style="min-height:auto;padding:1px 6px" onclick="removeCustomerTag('${prefix}',${idx})">×</button></span>`).join(''):'<span style="font-size:12px;color:var(--text-3)">No tags selected.</span>'}
    </div>`;
}
function addSelectedCustomerTag(prefix){
  const sel=g(`${prefix}-tag-select`);
  const tag=String(sel?.value||'').trim();
  if(!tag) return;
  const state=getCustomerTagPickerState(prefix);
  state.selected=normalizeCustomerProductTags([...state.selected, tag]);
  syncCustomerProductTagCatalog([tag]);
  renderCustomerTagPicker(prefix);
}
function toggleNewCustomerTagInput(prefix){
  const state=getCustomerTagPickerState(prefix);
  state.addingNew=!state.addingNew;
  renderCustomerTagPicker(prefix);
}
function createCustomerTag(prefix){
  const input=g(`${prefix}-tag-new`);
  const tag=String(input?.value||'').replace(/\s+/g,' ').trim();
  if(!tag){ toast('Enter a tag name','err'); return; }
  const state=getCustomerTagPickerState(prefix);
  state.selected=normalizeCustomerProductTags([...state.selected, tag]);
  state.addingNew=false;
  syncCustomerProductTagCatalog([tag]);
  renderCustomerTagPicker(prefix);
}
function removeCustomerTag(prefix, idx){
  const state=getCustomerTagPickerState(prefix);
  state.selected=state.selected.filter((_,i)=>i!==idx);
  renderCustomerTagPicker(prefix);
}
function getSelectedCustomerTags(prefix){
  return normalizeCustomerProductTags(getCustomerTagPickerState(prefix).selected);
}
function firstAccessiblePage(){
  const pages=['dashboard','sales','orders','alerts','marketing','distribution','expenses','customers','settings'];
  return pages.find(hasPageAccess) || 'dashboard';
}
function appShellEls(){
  return [
    document.querySelector('.app'),
    g('bottom-nav'),
  ].filter(Boolean);
}
function setAppLocked(locked){
  appShellEls().forEach((el)=>{
    el.style.visibility=locked?'hidden':'';
    el.style.pointerEvents=locked?'none':'';
    el.setAttribute('aria-hidden', locked?'true':'false');
  });
}
function ensureAuthUi(){
  if(g('auth-gate')) return;
  const style=document.createElement('style');
  style.textContent=`
    .auth-gate{position:fixed;inset:0;z-index:1200;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(17,17,16,.18);backdrop-filter:blur(10px)}
    .auth-gate.open{display:flex}
    .auth-card{width:min(460px,100%);background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--sh-lg);padding:28px}
    .auth-title{font-family:'Syne',sans-serif;font-size:26px;font-weight:700}
    .auth-sub{font-size:13px;color:var(--text-3);margin-top:6px}
    .auth-stack{display:flex;flex-direction:column;gap:14px;margin-top:20px}
    .auth-note{font-size:12px;color:var(--text-3);margin-top:10px}
    .session-chip{margin-top:auto;padding:12px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
    .session-chip-name{font-size:12px;font-weight:700;color:var(--text)}
    .session-chip-sub{font-size:11px;color:var(--text-3)}
    .user-check-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
    .user-check-item{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);font-size:12px;line-height:1.35;cursor:pointer}
    .user-check-item input[type="checkbox"]{width:16px;height:16px;min-width:16px;min-height:16px;margin-top:1px;padding:0;border:none;box-shadow:none;background:transparent;appearance:auto;-webkit-appearance:checkbox}
  `;
  document.head.appendChild(style);
  const gate=document.createElement('div');
  gate.id='auth-gate';
  gate.className='auth-gate';
  document.body.appendChild(gate);
  const foot=document.querySelector('.sidebar');
  if(foot && !g('session-chip')){
    const chip=document.createElement('div');
    chip.id='session-chip';
    chip.className='session-chip';
    chip.innerHTML='<div id="session-chip-body"></div><button id="session-logout-btn" class="btn btn-s btn-sm" style="display:none" onclick="logoutUser()">Log Out</button>';
    foot.appendChild(chip);
  }
}
function renderSessionChip(){
  const body=g('session-chip-body');
  const logoutBtn=g('session-logout-btn');
  if(!body || !logoutBtn) return;
  if(!authEnabled()){
    body.innerHTML='<div class="session-chip-name">Single-User Mode</div><div class="session-chip-sub">Authentication is currently disabled</div>';
    logoutBtn.style.display='none';
    return;
  }
  if(!currentUser()){
    body.innerHTML='<div class="session-chip-name">Signed Out</div><div class="session-chip-sub">Authentication enabled</div>';
    logoutBtn.style.display='none';
    return;
  }
  const user=currentUser();
  const roleLabel=String(user.role||'admin').replace(/^\w/, (m)=>m.toUpperCase());
  body.innerHTML=`<div class="session-chip-name">${esc(user.displayName||user.username)}</div><div class="session-chip-sub">${esc(roleLabel)} Account · @${esc(user.username)}</div>`;
  logoutBtn.style.display='inline-flex';
}
function renderAuthGate(){
  ensureAuthUi();
  const gate=g('auth-gate');
  const setup=!!authContext().setupRequired;
  gate.innerHTML=`
    <div class="auth-card">
      <div class="auth-title">${setup?'Set Up Admin Account':'Sign In'}</div>
      <div class="auth-sub">${setup?'Create the first admin account for this CRM instance.':'Enter your username and password to continue.'}</div>
      <div class="auth-stack">
        <div class="fg">
          <label>Username</label>
          <input id="auth-username" type="text" autocomplete="username" placeholder="e.g. admin">
        </div>
        ${setup?`<div class="fg"><label>Display Name</label><input id="auth-display-name" type="text" placeholder="e.g. Main Admin"></div>`:''}
        <div class="fg">
          <label>Password</label>
          <input id="auth-password" type="password" autocomplete="${setup?'new-password':'current-password'}" placeholder="Minimum 8 characters">
        </div>
        <button class="btn btn-p btn-full" onclick="${setup?'submitAuthSetup()':'submitLogin()'}">${setup?'Create Admin Account':'Sign In'}</button>
        <div id="auth-error" class="auth-note" style="color:var(--red)"></div>
      </div>
    </div>`;
  gate.classList.add('open');
}
async function showAuthGate(){
  setAppLocked(true);
  renderAuthGate();
}
function hideAuthGate(){
  const gate=g('auth-gate');
  if(gate) gate.classList.remove('open');
}
async function fetchAuthStatus(){
  const r=await fetch('/api/auth/status',{credentials:'same-origin'});
  if(!r.ok) throw new Error(`Auth status failed: ${r.status}`);
  return r.json();
}
async function refreshAuthState(){
  const payload=await fetchAuthStatus();
  FEATURE_CONFIG=payload?.featureConfig||FEATURE_CONFIG;
  AUTH_STATE=payload?.auth||AUTH_STATE;
  if(S) S.authContext=AUTH_STATE;
  return AUTH_STATE;
}
function enterAuthMode(nextAuthState=null){
  if(nextAuthState && typeof nextAuthState==='object'){
    AUTH_STATE={...AUTH_STATE, ...nextAuthState};
    if(S) S.authContext=AUTH_STATE;
  }
  if(!S) S=emptyState();
  FULL_DATA_READY=false;
  FULL_DATA_PROMISE=null;
  DASH_BOOTSTRAP_METRICS=null;
  applyTheme(S?.uiPreferences?.theme||'light');
  setAppLocked(true);
  renderSessionChip();
  renderAuthGate();
}
function enterAppMode(){
  hideAuthGate();
  setAppLocked(false);
  renderSessionChip();
}
async function submitAuthSetup(){
  const username=g('auth-username')?.value?.trim()||'';
  const password=g('auth-password')?.value||'';
  const displayName=g('auth-display-name')?.value?.trim()||username;
  try{
    await api.post('/api/auth/setup',{username,password,displayName});
    hideAuthGate();
    window.location.replace('/');
    return;
  }catch(e){
    if(String(e?.message||'').toLowerCase().includes('setup is already complete')){
      try{
        await refreshAuthState();
        renderAuthGate();
      }catch(_){}
    }
    if(g('auth-error')) g('auth-error').textContent=e.message;
  }
}
async function submitLogin(){
  const username=g('auth-username')?.value?.trim()||'';
  const password=g('auth-password')?.value||'';
  try{
    await api.post('/api/auth/login',{username,password});
    hideAuthGate();
    window.location.replace('/');
    return;
  }catch(e){
    if(g('auth-error')) g('auth-error').textContent=e.message;
  }
}
async function logoutUser(){
  try{ await api.post('/api/auth/logout',{}); }catch(_){}
  hideAuthGate();
  window.location.replace('/');
}
function activeViewId(){
  const v=document.querySelector('.view.active');
  const id=String(v?.id||'');
  return id.startsWith('view-') ? id.slice(5) : 'dashboard';
}
async function fetchFullData(){
  S = await api.get('/api/data');
  AUTH_STATE=S?.authContext||AUTH_STATE;
  FULL_DATA_READY = true;
  DASH_BOOTSTRAP_METRICS = null;
  applyTheme(S?.uiPreferences?.theme||'light');
  return S;
}
function ensureFullDataLoaded(){
  if(FULL_DATA_READY) return Promise.resolve(S);
  if(!FULL_DATA_PROMISE){
    FULL_DATA_PROMISE = fetchFullData().finally(()=>{ FULL_DATA_PROMISE = null; });
  }
  return FULL_DATA_PROMISE;
}
function rerenderActiveView(){
  const p=activeViewId();
  if(p==='dashboard') rDash();
  if(p==='orders') rOrders();
  if(p==='alerts') rAlerts();
  if(p==='marketing') rMarketingView();
  if(p==='distribution') rDistribution();
  if(p==='expenses') rOperationalExpenses();
  if(p==='customers') rCustomers();
  if(p==='settings'){ sPanel('products'); rSettings(); }
}
function pagerMarkup(page,totalPages,onClick){
  if(totalPages<=1) return '';
  return `<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 0 2px">
    <button class="btn btn-s btn-xs" ${page<=1?'disabled':''} onclick="${onClick}(${page-1})">Prev</button>
    <span style="font-size:12px;color:var(--text-3)">Page ${page} / ${totalPages}</span>
    <button class="btn btn-s btn-xs" ${page>=totalPages?'disabled':''} onclick="${onClick}(${page+1})">Next</button>
  </div>`;
}
function onDistNameSelectChange(){
  const sel=g('dist-name');
  const custom=g('dist-name-custom');
  if(!sel||!custom) return;
  const show=sel.value==='__new__';
  custom.style.display=show?'block':'none';
  if(show) setTimeout(()=>custom.focus(),0);
}
function getDistNameValue(prefix='dist'){
  const sel=g(`${prefix}-name`);
  const custom=g(`${prefix}-name-custom`);
  if(!sel){
    return String(g(`${prefix}-name`)?.value||'').trim();
  }
  if(sel.value==='__new__'){
    return String(custom?.value||'').trim();
  }
  return String(sel.value||'').trim();
}
function rememberDistributorName(name){
  const cleaned = String(name||'').replace(/\s+/g,' ').trim();
  if(!cleaned) return;
  S.distributionChannels = Array.isArray(S.distributionChannels) ? S.distributionChannels : [];
  S.distributionChannels.push(cleaned);
  S.distributionChannels = getSavedDistributorNames();
  renderDistributorSuggestions();
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
function isTypingTarget(target){
  if(!(target instanceof Element)) return false;
  const tag=String(target.tagName||'').toLowerCase();
  return tag==='input' || tag==='textarea' || tag==='select' || !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable]');
}
function modalOpen(){
  return !!g('modal')?.classList.contains('open');
}
function runKeyboardShortcut(key){
  if(key==='r'){
    if(!hasPageAccess('sales') || !hasActionAccess('orders','create')) return false;
    nav('sales');
    setTimeout(()=>g('cs')?.focus(),0);
    return true;
  }
  if(key==='a'){
    if(!hasPageAccess('customers') || !hasActionAccess('customers','create')) return false;
    openAddCustomerModal();
    setTimeout(()=>g('fn')?.focus(),0);
    return true;
  }
  if(key==='s'){
    if(!hasPageAccess('settings')) return false;
    nav('settings');
    return true;
  }
  return false;
}
document.addEventListener('keydown',(e)=>{
  if(e.defaultPrevented) return;
  if(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if(isTypingTarget(e.target)) return;
  if(modalOpen()) return;
  const key=String(e.key||'').toLowerCase();
  if(runKeyboardShortcut(key)){
    e.preventDefault();
  }
});

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
  const canEdit=hasActionAccess('orders','edit');
  const canDelete=hasActionAccess('orders','delete');
  const canShipLabel=hasActionAccess('shipping','labels');
  const menu=document.createElement('div');
  menu.className='ctx-menu'; menu.id='ctx-menu';
  menu.innerHTML=`
    ${canEdit?`<button class="ctx-item" onclick="closeOrderMenu();openEditOrder(${oid})">Edit Order</button>`:''}
    ${canShip && canShipLabel
      ? `<button class="ctx-item" onclick="closeOrderMenu();shippingLabel(${oid},'download')">Download Label</button>
         <button class="ctx-item" onclick="closeOrderMenu();shippingLabel(${oid},'print')">Print Label</button>`
      : `<div class="ctx-item" style="cursor:default;opacity:.65">Label - Not Valid</div>`
    }
    ${canDelete?`<hr class="ctx-divider"><button class="ctx-item ctx-danger" onclick="closeOrderMenu();deleteOrder(${oid})">Delete Order</button>`:''}`;
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
  const tpl=String(S?.shippingProfile?.shippedWaTemplate||'').trim() || DEFAULT_SHIPPED_WA_TPL;
  const trackingUrl=String(shipping?.trackingUrl||'').trim();
  const data={
    customer_name:String(order?.cname||'').trim(),
    order_id:String(order?.id||'').trim(),
    product_name:String(order?.prod||'').trim(),
    ship_date:String(shipping?.shipDate||'').trim(),
    awb:String(shipping?.awb||'').trim(),
    courier:String(shipping?.courier||'').trim(),
    tracking_url:trackingUrl,
    tracking_line:trackingUrl?`\nTracking Link: ${trackingUrl}`:'',
  };
  return tpl
    .replace(/\{\{\s*customer_name\s*\}\}/ig, data.customer_name)
    .replace(/\{\{\s*order_id\s*\}\}/ig, data.order_id)
    .replace(/\{\{\s*product_name\s*\}\}/ig, data.product_name)
    .replace(/\{\{\s*ship_date\s*\}\}/ig, data.ship_date)
    .replace(/\{\{\s*awb\s*\}\}/ig, data.awb)
    .replace(/\{\{\s*courier\s*\}\}/ig, data.courier)
    .replace(/\{\{\s*tracking_url\s*\}\}/ig, data.tracking_url)
    .replace(/\{\{\s*tracking_line\s*\}\}/ig, data.tracking_line);
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
        <div class="split-input-row">
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
        <div class="split-input-row">
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
// Sidebar nav: dashboard=0, orders=1, alerts=2, marketing=3, distribution=4, customers=5, settings=6
function nav(p){
  if(!hasPageAccess(p)){
    const fallback=firstAccessiblePage();
    if(p!==fallback) return nav(fallback);
    toast('Access restricted for this account','err');
    return;
  }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  g('view-'+p).classList.add('active');
  // Desktop sidebar
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
  const IDX={dashboard:0,orders:1,alerts:2,marketing:3,distribution:4,expenses:5,customers:6,settings:7};
  if(IDX[p]!==undefined) document.querySelectorAll('.nb')[IDX[p]].classList.add('active');
  // Mobile bottom nav
  document.querySelectorAll('.bnav-item').forEach(b=>b.classList.remove('active'));
  const BIDX={dashboard:'bnav-dashboard',orders:'bnav-orders',alerts:'bnav-alerts',marketing:'bnav-marketing',distribution:'bnav-distribution',expenses:'bnav-expenses',customers:'bnav-customers',settings:'bnav-settings'};
  if(BIDX[p]) { const el=g(BIDX[p]); if(el) el.classList.add('active'); }
  // Scroll to top on mobile when switching views
  if(isMobile()) window.scrollTo({top:0,behavior:'smooth'});
  if(p==='dashboard') rDash();
  if(p==='orders')    rOrders();
  if(p==='alerts')    rAlerts();
  if(p==='marketing') rMarketingView();
  if(p==='distribution') rDistribution();
  if(p==='expenses') rOperationalExpenses();
  if(p==='customers') rCustomers();
  if(p==='sales')     { populateProdSelect(); setDefaultDate(); }
  if(p==='settings')  { sPanel('products'); rSettings(); }
}
function sPanel(id){
  if(id==='users' && !hasActionAccess('users','manage')){
    toast('Only admins can manage users','err');
    return;
  }
  document.querySelectorAll('.settings-panel').forEach(p=>p.classList.remove('active'));
  g('sp-'+id).classList.add('active');
  document.querySelectorAll('.smenu-item').forEach(b=>b.classList.remove('active'));
  const activeMenuPanel = id==='new-product' ? 'products' : id;
  const activeBtn=document.querySelector(`.smenu-item[data-panel="${activeMenuPanel}"]`);
  if(activeBtn) activeBtn.classList.add('active');
  const addBtn=g('smenu-add-product-btn');
  if(addBtn) addBtn.classList.toggle('active', id==='new-product');
  if(id==='wa-messages') rWaMessages();
  if(id==='appearance') rThemeSettings();
  if(id==='marketing-ai') rMarketingSettings();
  if(id==='shipping') rShippingSettings();
  if(id==='users') rUsersSettings();
}
function setNavVisibility(selector, visible){
  document.querySelectorAll(selector).forEach((el)=>{ el.style.display=visible?'':'none'; });
}
function applyPermissionUI(){
  const signedIn=!!currentUser();
  setNavVisibility('.sidebar .nb[onclick="nav(\'dashboard\')"]', hasPageAccess('dashboard'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'orders\')"]', hasPageAccess('orders'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'alerts\')"]', hasPageAccess('alerts'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'marketing\')"]', hasPageAccess('marketing'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'distribution\')"]', hasPageAccess('distribution'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'expenses\')"]', hasPageAccess('expenses'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'customers\')"]', hasPageAccess('customers'));
  setNavVisibility('.sidebar .nb[onclick="nav(\'settings\')"]', hasPageAccess('settings'));
  if(g('bnav-dashboard')) g('bnav-dashboard').style.display=hasPageAccess('dashboard')?'':'none';
  if(g('bnav-orders')) g('bnav-orders').style.display=hasPageAccess('orders')?'':'none';
  if(g('bnav-alerts')) g('bnav-alerts').style.display=hasPageAccess('alerts')?'':'none';
  if(g('bnav-marketing')) g('bnav-marketing').style.display=hasPageAccess('marketing')?'':'none';
  if(g('bnav-distribution')) g('bnav-distribution').style.display=hasPageAccess('distribution')?'':'none';
  if(g('bnav-expenses')) g('bnav-expenses').style.display=hasPageAccess('expenses')?'':'none';
  if(g('bnav-customers')) g('bnav-customers').style.display=hasPageAccess('customers')?'':'none';
  if(g('bnav-settings')) g('bnav-settings').style.display=hasPageAccess('settings')?'':'none';
  document.querySelectorAll('.dash-sale-btn, .mobile-topbar .btn').forEach((el)=>{ el.style.display=(hasPageAccess('sales') && hasActionAccess('orders','create'))?'':'none'; });
  document.querySelectorAll('[onclick="openAddCustomerModal()"]').forEach((el)=>{ el.style.display=(hasPageAccess('customers') && hasActionAccess('customers','create'))?'':'none'; });
  document.querySelectorAll('[onclick="createDistributorBatch()"]').forEach((el)=>{ el.style.display=(hasPageAccess('distribution') && hasActionAccess('distribution','create'))?'':'none'; });
  const usersBtn=document.querySelector('.smenu-item[data-panel="users"]');
  if(usersBtn) usersBtn.style.display=(signedIn && FEATURE_CONFIG.usernamePasswordAuthEnabled && hasActionAccess('users','manage'))?'':'none';
  const usersPanel=g('sp-users');
  if(usersPanel) usersPanel.style.display=(signedIn && FEATURE_CONFIG.usernamePasswordAuthEnabled && hasActionAccess('users','manage'))?'':'none';
  const activeSettingsPanel=document.querySelector('.settings-panel.active');
  if(activeSettingsPanel?.id==='sp-users' && (!signedIn || !FEATURE_CONFIG.usernamePasswordAuthEnabled || !hasActionAccess('users','manage'))){
    const fallback=hasPageAccess('settings') ? 'appearance' : null;
    if(fallback) sPanel(fallback);
  }
  const active=activeViewId();
  if(active && !hasPageAccess(active)) nav(firstAccessiblePage());
}

function marketingWaPhone(phone){
  let d=String(phone||'').replace(/\D+/g,'');
  if(d.length===10) d='91'+d;
  return d;
}
const MKT_RUNNER_KEY='kudagu_marketing_runner_v1';
const MKT_GROUPS_KEY='kudagu_marketing_groups_v1';
const MKT_ALLOWED_TOKENS=[
  '{{brand_name}}','{{customer_name}}','{{area}}','{{order_count}}','{{avg_order_value}}',
  '{{last_order_date}}','{{last_product_name}}','{{last_variant}}','{{preferred_channel}}',
];
let MKT_STATE={status:'idle',customerIds:[],currentIndex:0,total:0,delaySec:10,template:'',updatedAt:0};
let MKT_GROUPS=[];
let MKT_ACTIVE_GROUP_ID='';
let CUSTOMER_NAME_SEARCH='';
let CUSTOMER_FILTERS_EXPANDED=false;
let _mktTimer=null;
let _mktGroupMenuId='';

function getCustomerOrders(cid){
  return (S.orders||[]).filter(o=>Number(o.cid)===Number(cid)).sort((a,b)=>Number(a.at||0)-Number(b.at||0));
}
function avgOrderValueForCustomer(cid){
  const orders=getCustomerOrders(cid);
  if(!orders.length) return 0;
  const sum=orders.reduce((s,o)=>s+(Number(orderRevenue(o))||0),0);
  return sum/orders.length;
}
function avgGapDaysForCustomer(cid){
  const orders=getCustomerOrders(cid);
  if(orders.length<2) return Infinity;
  let sum=0;
  for(let i=1;i<orders.length;i++){
    const d=Math.abs((Number(orders[i].at||0)-Number(orders[i-1].at||0))/(1000*60*60*24));
    sum+=d;
  }
  return sum/(orders.length-1);
}
function preferredChannelForCustomer(cid){
  const orders=getCustomerOrders(cid);
  if(!orders.length) return '';
  const m={retail:0,whatsapp:0,website:0};
  orders.forEach(o=>{ const ch=String(o.channel||'').toLowerCase(); if(m[ch]!==undefined) m[ch]+=1; });
  return Object.entries(m).sort((a,b)=>b[1]-a[1])[0][0]||'';
}
function buildMarketingMergeData(c){
  const orders=getCustomerOrders(c.id);
  const last=orders.length?orders[orders.length-1]:null;
  const aov=avgOrderValueForCustomer(c.id);
  const brandName=String(S?.marketingSettings?.brandName||S?.shippingProfile?.companyName||'Our Brand').trim()||'Our Brand';
  return {
    brand_name:brandName,
    customer_name:String(c.name||''),
    area:String(c.area||''),
    order_count:String(orders.length),
    avg_order_value:`₹${aov.toFixed(0)}`,
    last_order_date:last?fd(last.at):'N/A',
    last_product_name:last?String(last.prod||''):'N/A',
    last_variant:last?(VL[last.variant]||last.variant):'N/A',
    preferred_channel:preferredChannelForCustomer(c.id)||'N/A',
  };
}
function fillMarketingTemplate(tpl,data){
  let out=String(tpl||'');
  Object.keys(data||{}).forEach(k=>{
    const v=String(data[k]??'');
    const re=new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`,'ig');
    out=out.replace(re,v);
  });
  return out;
}
function loadMarketingState(){
  try{
    const raw=localStorage.getItem(MKT_RUNNER_KEY);
    if(!raw) return;
    const obj=JSON.parse(raw);
    if(obj && typeof obj==='object') MKT_STATE={...MKT_STATE,...obj};
  }catch(_){}
}
function saveMarketingState(){
  MKT_STATE.updatedAt=Date.now();
  localStorage.setItem(MKT_RUNNER_KEY,JSON.stringify(MKT_STATE));
}
function clearMarketingTimer(){
  if(_mktTimer){ clearTimeout(_mktTimer); _mktTimer=null; }
}
function loadMarketingGroups(){
  try{
    const raw=localStorage.getItem(MKT_GROUPS_KEY);
    if(!raw){ MKT_GROUPS=[]; return; }
    const arr=JSON.parse(raw);
    MKT_GROUPS=Array.isArray(arr)?arr:[];
  }catch(_){ MKT_GROUPS=[]; }
}
function saveMarketingGroups(){
  localStorage.setItem(MKT_GROUPS_KEY,JSON.stringify(MKT_GROUPS));
}
function captureCurrentMarketingFilters(){
  return getMarketingFilters();
}
function setMarketingFilters(f){
  if(g('mkt-f-has-orders')) g('mkt-f-has-orders').value=f?.hasOrders||'any';
  if(g('mkt-f-area')) g('mkt-f-area').value=f?.area||'any';
  MARKETING_TAG_FILTERS = normalizeCustomerProductTags(
    Array.isArray(f?.productTags)
      ? f.productTags
      : (f?.productTag && f.productTag !== 'any' ? [f.productTag] : [])
  );
  refreshMarketingProductTags();
  if(g('mkt-f-channel')) g('mkt-f-channel').value=f?.channel||'any';
  if(g('mkt-f-aov-mode')) g('mkt-f-aov-mode').value=f?.aovMode||'any';
  if(g('mkt-f-aov-value')) g('mkt-f-aov-value').value=(f?.aovValue ?? '')===0 ? '' : String(f?.aovValue ?? '');
  if(g('mkt-f-regular')) g('mkt-f-regular').value=f?.regular||'any';
  if(g('mkt-f-reg-min-orders')) g('mkt-f-reg-min-orders').value=String(f?.regMinOrders||3);
  if(g('mkt-f-reg-max-gap')) g('mkt-f-reg-max-gap').value=String(f?.regMaxGap||45);
}
function refreshMarketingGroupsUI(){
  const wrap=g('mkt-group-buttons');
  if(!wrap) return;
  if(!MKT_GROUPS.length){
    wrap.innerHTML='<span style="font-size:12px;color:var(--text-3)">No saved groups yet.</span>';
    return;
  }
  wrap.innerHTML=MKT_GROUPS.map(gr=>{
    const on=MKT_ACTIVE_GROUP_ID===gr.id;
    const menuOpen=_mktGroupMenuId===gr.id;
    return `<div style="position:relative;display:inline-flex;align-items:center;gap:4px;background:${on?'var(--surface-2)':'transparent'};border:1px solid var(--border);border-radius:999px;padding:2px">
      <button class="btn btn-s btn-xs" style="border-radius:999px;min-height:30px;padding:6px 10px;${on?'background:var(--accent);color:#fff;':''}" onclick="applyMarketingGroup('${gr.id}')">${esc(gr.name)}</button>
      <button class="btn btn-s btn-xs" style="border-radius:999px;min-height:30px;padding:6px 9px" title="Group options" onclick="toggleMarketingGroupMenu('${gr.id}',event)">⋯</button>
      <div style="display:${menuOpen?'block':'none'};position:absolute;top:36px;right:0;z-index:30;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--sh);min-width:110px;padding:4px">
        <button class="ctx-item" style="width:100%" onclick="openEditMarketingGroupModal('${gr.id}')">Edit</button>
        <button class="ctx-item" style="width:100%;color:var(--red)" onclick="deleteMarketingGroup('${gr.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}
function toggleMarketingGroupMenu(id, ev){
  if(ev){ ev.preventDefault(); ev.stopPropagation(); }
  _mktGroupMenuId = (_mktGroupMenuId===id) ? '' : id;
  refreshMarketingGroupsUI();
}
document.addEventListener('click', ()=>{
  if(!_mktGroupMenuId) return;
  _mktGroupMenuId='';
  refreshMarketingGroupsUI();
});
function openSaveMarketingGroupModal(){
  openModal(`
    <div class="modal-title">Save Group</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
      <div class="fg">
        <label>Group Name <span class="req">*</span></label>
        <input id="mkt-group-name" type="text" placeholder="e.g. High AOV Regulars">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitSaveMarketingGroup()">Save Group</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'');
}
function openEditMarketingGroupModal(id){
  const grp=MKT_GROUPS.find(x=>x.id===id);
  if(!grp){ toast('Saved group not found','err'); return; }
  _mktGroupMenuId='';
  openModal(`
    <div class="modal-title">Edit Group</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
      <div class="fg">
        <label>Group Name <span class="req">*</span></label>
        <input id="mkt-group-edit-name" type="text" value="${esc(grp.name||'')}">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditMarketingGroup('${id}')">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'');
}
function submitSaveMarketingGroup(){
  const name=String(g('mkt-group-name')?.value||'').trim();
  if(!name){ toast('Group name is required','err'); return; }
  if(MKT_GROUPS.some(x=>String(x.name||'').toLowerCase()===name.toLowerCase())){
    toast('Group name already exists','err'); return;
  }
  const id=`grp-${Date.now()}`;
  MKT_GROUPS.push({id,name,filters:captureCurrentMarketingFilters(),createdAt:Date.now()});
  MKT_ACTIVE_GROUP_ID=id;
  saveMarketingGroups();
  refreshMarketingGroupsUI();
  closeModal();
  toast('Group saved','ok');
}
function submitEditMarketingGroup(id){
  const grp=MKT_GROUPS.find(x=>x.id===id);
  if(!grp){ toast('Saved group not found','err'); return; }
  const name=String(g('mkt-group-edit-name')?.value||'').trim();
  if(!name){ toast('Group name is required','err'); return; }
  if(MKT_GROUPS.some(x=>x.id!==id && String(x.name||'').toLowerCase()===name.toLowerCase())){
    toast('Group name already exists','err'); return;
  }
  grp.name=name;
  saveMarketingGroups();
  refreshMarketingGroupsUI();
  closeModal();
  toast('Group updated','ok');
}
function applyMarketingGroup(id){
  const grp=MKT_GROUPS.find(x=>x.id===id);
  if(!grp){ toast('Saved group not found','err'); return; }
  setMarketingFilters(grp.filters||{});
  MKT_ACTIVE_GROUP_ID=id;
  CUSTOMER_PAGE=1;
  refreshMarketingGroupsUI();
  refreshMarketingGroup();
  toast(`Applied group: ${grp.name}`,'ok');
}
function deleteMarketingGroup(id){
  const grp=MKT_GROUPS.find(x=>x.id===id);
  if(!grp) return;
  if(!confirm(`Delete saved group "${grp.name}"?`)) return;
  MKT_GROUPS=MKT_GROUPS.filter(x=>x.id!==id);
  _mktGroupMenuId='';
  if(MKT_ACTIVE_GROUP_ID===id) MKT_ACTIVE_GROUP_ID='';
  saveMarketingGroups();
  refreshMarketingGroupsUI();
  refreshMarketingGroup();
  toast('Group deleted','ok');
}
function updateMarketingProgressUI(){
  const total=Math.max(0,Number(MKT_STATE.total||0));
  const done=Math.min(total,Math.max(0,Number(MKT_STATE.currentIndex||0)));
  const pct=total?Math.round((done/total)*100):0;
  if(g('mkt-progress-bar')) g('mkt-progress-bar').style.width=`${pct}%`;
  if(g('mkt-progress-text')){
    const st=String(MKT_STATE.status||'idle');
    if(st==='idle') g('mkt-progress-text').textContent='No campaign running.';
    else g('mkt-progress-text').textContent=`${st.toUpperCase()} · ${done}/${total} sent · ${pct}%`;
  }
  updateMarketingToggleButton();
}
function updateMarketingToggleButton(){
  const btn=g('mkt-toggle-btn');
  if(!btn) return;
  const st=String(MKT_STATE.status||'idle');
  if(st==='running'){
    btn.textContent='Pause';
  }else if(st==='paused'){
    btn.textContent='Resume';
  }else{
    btn.textContent='Pause';
  }
}
function toggleMarketingRunState(){
  const st=String(MKT_STATE.status||'idle');
  if(st==='running'){
    pauseMarketingCampaign();
    return;
  }
  if(st==='paused'){
    resumeMarketingCampaign();
    return;
  }
  toast('Start campaign first using Go','err');
}
function getMarketingFilters(){
  return {
    hasOrders:(g('mkt-f-has-orders')?.value||'any'),
    area:(g('mkt-f-area')?.value||'any'),
    productTags:[...MARKETING_TAG_FILTERS],
    channel:(g('mkt-f-channel')?.value||'any'),
    aovMode:(g('mkt-f-aov-mode')?.value||'any'),
    aovValue:parseFloat(g('mkt-f-aov-value')?.value||0)||0,
    regular:(g('mkt-f-regular')?.value||'any'),
    regMinOrders:Math.max(1,parseInt(g('mkt-f-reg-min-orders')?.value||3)||3),
    regMaxGap:Math.max(1,parseFloat(g('mkt-f-reg-max-gap')?.value||45)||45),
  };
}
function isRegularCustomerByRule(c,f){
  const oc=getCustomerOrders(c.id).length;
  if(oc < f.regMinOrders) return false;
  return avgGapDaysForCustomer(c.id) <= f.regMaxGap;
}
function getMarketingGroupCustomers(){
  const f=getMarketingFilters();
  return (S.customers||[]).filter(c=>{
    const orders=getCustomerOrders(c.id);
    const hasOrders=orders.length>0;
    if(f.hasOrders==='yes' && !hasOrders) return false;
    if(f.hasOrders==='no' && hasOrders) return false;
    if(f.area!=='any' && String(c.area||'')!==f.area) return false;
    const productTags=normalizeCustomerProductTags(c.productTags||[]);
    if(Array.isArray(f.productTags) && f.productTags.length){
      const selected=new Set(f.productTags.map(tag=>String(tag||'').toLowerCase()));
      if(!productTags.some(tag=>selected.has(String(tag||'').toLowerCase()))) return false;
    }
    if(f.channel!=='any'){
      const anyCh=orders.some(o=>String(o.channel||'').toLowerCase()===f.channel);
      if(!anyCh) return false;
    }
    if(f.aovMode!=='any'){
      const aov=avgOrderValueForCustomer(c.id);
      if(f.aovMode==='above' && !(aov>f.aovValue)) return false;
      if(f.aovMode==='below' && !(aov<f.aovValue)) return false;
    }
    if(f.regular!=='any'){
      const reg=isRegularCustomerByRule(c,f);
      if(f.regular==='yes' && !reg) return false;
      if(f.regular==='no' && reg) return false;
    }
    return true;
  });
}
function refreshMarketingAreas(){
  const el=g('mkt-f-area');
  if(!el) return;
  const cur=el.value||'any';
  const areas=Array.from(new Set((S.customers||[]).map(c=>String(c.area||'').trim()).filter(Boolean))).sort();
  el.innerHTML=['<option value="any">All areas</option>',...areas.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`)].join('');
  if(areas.includes(cur)) el.value=cur; else el.value='any';
}
function refreshMarketingProductTags(){
  const host=g('mkt-f-product-tag-picker');
  if(!host) return;
  syncCustomerProductTagCatalog();
  const tags=getCustomerProductTagCatalog();
  const available=tags.filter(tag=>!MARKETING_TAG_FILTERS.some(sel=>sel.toLowerCase()===tag.toLowerCase()));
  host.innerHTML=`
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <select id="mkt-f-product-tag-select" style="flex:1;min-width:180px" onchange="addMarketingFilterTag(this.value);this.value=''">
        <option value="">All tags</option>
        ${available.map(tag=>`<option value="${esc(tag)}">${esc(tag)}</option>`).join('')}
      </select>
      ${MARKETING_TAG_FILTERS.length?'<button type="button" class="btn btn-s btn-sm" onclick="clearMarketingFilterTags()">Clear</button>':''}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${MARKETING_TAG_FILTERS.length
        ? MARKETING_TAG_FILTERS.map((tag,idx)=>`<span class="pill pn" style="display:inline-flex;align-items:center;gap:6px">${esc(tag)} <button type="button" class="btn btn-g btn-xs" style="min-height:auto;padding:1px 6px" onclick="removeMarketingFilterTag(${idx})">×</button></span>`).join('')
        : '<span style="font-size:12px;color:var(--text-3)">No tag filter selected.</span>'}
    </div>`;
}
function addMarketingFilterTag(tag){
  const clean=String(tag||'').trim();
  if(!clean) return;
  MARKETING_TAG_FILTERS=normalizeCustomerProductTags([...MARKETING_TAG_FILTERS, clean]);
  CUSTOMER_PAGE=1;
  refreshMarketingProductTags();
  refreshMarketingGroup();
}
function removeMarketingFilterTag(idx){
  MARKETING_TAG_FILTERS=MARKETING_TAG_FILTERS.filter((_,i)=>i!==idx);
  CUSTOMER_PAGE=1;
  refreshMarketingProductTags();
  refreshMarketingGroup();
}
function clearMarketingFilterTags(){
  MARKETING_TAG_FILTERS=[];
  CUSTOMER_PAGE=1;
  refreshMarketingProductTags();
  refreshMarketingGroup();
}
function buildMarketingGroupSummary(customers){
  const f=getMarketingFilters();
  const avgAov=customers.length?customers.reduce((s,c)=>s+avgOrderValueForCustomer(c.id),0)/customers.length:0;
  const tagsLabel=Array.isArray(f.productTags) && f.productTags.length ? f.productTags.join(', ') : 'any';
  return `Group size: ${customers.length} customers | Filters: ordered=${f.hasOrders}, area=${f.area}, tags=${tagsLabel}, channel=${f.channel}, regular=${f.regular}, AOV=${f.aovMode}${f.aovMode==='any'?'':` ${f.aovValue}`} | Group avg AOV: ₹${avgAov.toFixed(0)}`;
}
function refreshMarketingGroup(){
  const customers=getMarketingGroupCustomers();
  if(g('mkt-group-summary')) g('mkt-group-summary').textContent=buildMarketingGroupSummary(customers);
  if(g('mkt-group-sample')){
    const sample=customers.slice(0,5).map(c=>`${c.name} (${c.area||'-'})`).join(', ');
    g('mkt-group-sample').textContent=sample?`Sample: ${sample}${customers.length>5?' ...':''}`:'No customers match current filters.';
  }
  previewMarketingTemplate();
  if(g('cg')) rCustomers();
}
function setCustomerFiltersExpanded(expanded){
  CUSTOMER_FILTERS_EXPANDED=!!expanded;
  const body=g('mkt-filters-body');
  const btn=g('mkt-filters-toggle-btn');
  if(body) body.style.display=CUSTOMER_FILTERS_EXPANDED?'block':'none';
  if(btn){
    btn.textContent=CUSTOMER_FILTERS_EXPANDED?'Hide':'Expand';
    btn.title=CUSTOMER_FILTERS_EXPANDED?'Collapse filters':'Expand filters';
    btn.setAttribute('aria-label',btn.title);
  }
}
function toggleCustomerFiltersPanel(){
  setCustomerFiltersExpanded(!CUSTOMER_FILTERS_EXPANDED);
}
function handleCustomerNameSearch(value){
  CUSTOMER_NAME_SEARCH=String(value||'').trim().toLowerCase();
  CUSTOMER_PAGE=1;
  rCustomers();
}
function rMarketingView(){
  refreshMarketingAreas();
  refreshMarketingProductTags();
  loadMarketingGroups();
  refreshMarketingGroupsUI();
  loadMarketingState();
  if(MKT_STATE.status==='running'){
    MKT_STATE.status='paused';
    saveMarketingState();
    if(g('mkt-meta')) g('mkt-meta').textContent='Campaign restored in paused mode. Click Resume to continue.';
  }
  refreshMarketingGroup();
  updateMarketingProgressUI();
}
function previewMarketingTemplate(){
  const customers=getMarketingGroupCustomers();
  const tpl=(g('mkt-template')?.value||'').trim();
  if(!g('mkt-preview')) return;
  if(!tpl){ g('mkt-preview').innerHTML='Template preview will appear here.'; return; }
  if(!customers.length){ g('mkt-preview').innerHTML='No customers in selected group.'; return; }
  const merged=fillMarketingTemplate(tpl,buildMarketingMergeData(customers[0]));
  g('mkt-preview').innerHTML=esc(merged).replace(/\n/g,'<br>');
}
async function generateMarketingTemplate(){
  const customers=getMarketingGroupCustomers();
  if(!customers.length){ toast('No customers match current filters','err'); return; }
  const campaignBrief=(g('mkt-brief')?.value||'').trim();
  if(!campaignBrief){ toast('Enter campaign goal','err'); return; }
  try{
    const res=await api.post('/api/marketing/template',{
      campaignBrief,
      extraInstruction:(g('mkt-extra')?.value||'').trim(),
      groupSummary:buildMarketingGroupSummary(customers),
      allowedTokens:MKT_ALLOWED_TOKENS,
    });
    const tpl=String(res.template||'').trim();
    if(g('mkt-template')) g('mkt-template').value=tpl;
    previewMarketingTemplate();
    if(Array.isArray(res.issues) && res.issues.length){
      toast(`Template warning: ${res.issues.join(', ')}`,'err');
    }
    toast('Template generated','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function openMarketingChatForCustomer(c, templateText){
  const phone=marketingWaPhone(c.phone);
  if(!phone) return false;
  const msg=fillMarketingTemplate(templateText,buildMarketingMergeData(c));
  const wa=`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  window.open(wa,'_blank');
  _marketingLastWaUrl=wa;
  return true;
}
function marketingRunnerStep(){
  clearMarketingTimer();
  if(MKT_STATE.status!=='running') return;
  const ids=MKT_STATE.customerIds||[];
  if(MKT_STATE.currentIndex>=ids.length){
    MKT_STATE.status='completed';
    saveMarketingState();
    updateMarketingProgressUI();
    if(g('mkt-meta')) g('mkt-meta').textContent='Campaign completed.';
    return;
  }
  const cid=ids[MKT_STATE.currentIndex];
  const cust=(S.customers||[]).find(c=>Number(c.id)===Number(cid));
  if(cust) openMarketingChatForCustomer(cust, MKT_STATE.template||'');
  MKT_STATE.currentIndex += 1;
  saveMarketingState();
  updateMarketingProgressUI();
  if(MKT_STATE.currentIndex>=ids.length){
    MKT_STATE.status='completed';
    saveMarketingState();
    updateMarketingProgressUI();
    if(g('mkt-meta')) g('mkt-meta').textContent='Campaign completed.';
    return;
  }
  const waitMs=Math.max(3000,(Number(MKT_STATE.delaySec)||10)*1000);
  _mktTimer=setTimeout(marketingRunnerStep,waitMs);
}
function startMarketingCampaign(){
  const customers=getMarketingGroupCustomers();
  if(!customers.length){ toast('No customers in this group','err'); return; }
  const templateText=(g('mkt-template')?.value||'').trim();
  if(!templateText){ toast('Generate or enter template first','err'); return; }
  const delaySec=Math.max(3,parseInt(g('mkt-delay-sec')?.value||10)||10);
  MKT_STATE={
    status:'running',
    customerIds:customers.map(c=>c.id),
    currentIndex:0,
    total:customers.length,
    delaySec,
    template:templateText,
    updatedAt:Date.now(),
  };
  saveMarketingState();
  updateMarketingProgressUI();
  if(g('mkt-meta')) g('mkt-meta').textContent='Campaign started. WhatsApp chats will open sequentially.';
  marketingRunnerStep();
}
function pauseMarketingCampaign(){
  if(MKT_STATE.status!=='running') return;
  MKT_STATE.status='paused';
  saveMarketingState();
  clearMarketingTimer();
  updateMarketingProgressUI();
  if(g('mkt-meta')) g('mkt-meta').textContent='Campaign paused.';
}
function resumeMarketingCampaign(){
  if(!['paused','running'].includes(String(MKT_STATE.status||''))) return;
  if(MKT_STATE.currentIndex>=Number(MKT_STATE.total||0)){
    MKT_STATE.status='completed';
    saveMarketingState();
    updateMarketingProgressUI();
    return;
  }
  MKT_STATE.status='running';
  saveMarketingState();
  updateMarketingProgressUI();
  if(g('mkt-meta')) g('mkt-meta').textContent='Campaign resumed.';
  marketingRunnerStep();
}
function resetMarketingCampaign(){
  clearMarketingTimer();
  MKT_STATE={status:'idle',customerIds:[],currentIndex:0,total:0,delaySec:10,template:'',updatedAt:Date.now()};
  localStorage.removeItem(MKT_RUNNER_KEY);
  updateMarketingProgressUI();
  if(g('mkt-meta')) g('mkt-meta').textContent='Campaign reset.';
}
function rMarketingSettings(){
  const ms=S?.marketingSettings||{};
  if(g('mkt-ai-base-url')) g('mkt-ai-base-url').value=ms.aiBaseUrl||'https://api.openai.com/v1';
  if(g('mkt-ai-model')) g('mkt-ai-model').value=ms.aiModel||'';
  if(g('mkt-ai-brand-name')) g('mkt-ai-brand-name').value=ms.brandName||'';
  if(g('mkt-ai-api-key')) g('mkt-ai-api-key').value='';
  if(g('mkt-ai-system-prompt')) g('mkt-ai-system-prompt').value=ms.systemPrompt||'';
  const note=g('mkt-ai-key-note');
  if(note){
    if(ms.hasApiKey){
      const hint=String(ms.apiKeyPreview||'').trim();
      note.textContent=hint
        ? `API key is saved (${hint}). Input is intentionally cleared after save for security.`
        : 'API key is already saved. Input is intentionally cleared after save for security.';
    }else{
      note.textContent='No API key saved yet.';
    }
  }
}
async function saveMarketingSettings(){
  if(!hasActionAccess('settings','manage')){ toast('Settings access is restricted','err'); return; }
  const aiBaseUrl=(g('mkt-ai-base-url')?.value||'').trim();
  const aiModel=(g('mkt-ai-model')?.value||'').trim();
  const brandName=(g('mkt-ai-brand-name')?.value||'').trim();
  const aiApiKey=(g('mkt-ai-api-key')?.value||'').trim();
  const systemPrompt=(g('mkt-ai-system-prompt')?.value||'').trim();
  if(!aiModel){ toast('Model is required','err'); return; }
  const marketingSettings={ aiBaseUrl, aiModel, brandName, systemPrompt };
  if(aiApiKey) marketingSettings.aiApiKey=aiApiKey;
  const payload={ marketingSettings };
  try{
    await api.put('/api/settings',payload);
    await fetchFullData();
    const saved = S?.marketingSettings || {};
    const persisted =
      String(saved.aiBaseUrl||'').trim() === String(marketingSettings.aiBaseUrl||'').trim() &&
      String(saved.aiModel||'').trim() === String(marketingSettings.aiModel||'').trim() &&
      String(saved.systemPrompt||'').trim() === String(marketingSettings.systemPrompt||'').trim();
    // Compatibility fallback: some deployments may ignore marketingSettings in /api/settings.
    if(!persisted){
      const merged = { ...(S||{}), marketingSettings: { ...(saved||{}), ...marketingSettings } };
      if(aiApiKey) merged.marketingSettings.aiApiKey = aiApiKey;
      await api.put('/api/data', merged);
      await fetchFullData();
    }
    toast('Marketing AI settings saved','ok');
    rMarketingSettings();
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
async function clearMarketingApiKey(){
  if(!hasActionAccess('settings','manage')){ toast('Settings access is restricted','err'); return; }
  try{
    await api.put('/api/settings',{marketingSettings:{clearApiKey:true}});
    await fetchFullData();
    if(S?.marketingSettings?.hasApiKey){
      const merged={...(S||{}),marketingSettings:{...(S.marketingSettings||{}),aiApiKey:''}};
      await api.put('/api/data',merged);
      await fetchFullData();
    }
    toast('Saved API key cleared','ok');
    rMarketingSettings();
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────

function detectImportFormat(fileName){
  const n=String(fileName||'').toLowerCase();
  if(n.endsWith('.vcf')) return 'vcf';
  if(n.endsWith('.xlsx')) return 'xlsx';
  if(n.endsWith('.xlsm')) return 'xlsm';
  if(n.endsWith('.csv')) return 'csv';
  return '';
}
function bytesToBase64(bytes){
  let bin='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk){
    const sub=bytes.subarray(i, i+chunk);
    bin += String.fromCharCode.apply(null, sub);
  }
  return btoa(bin);
}
async function fileToBase64(file){
  const ab=await file.arrayBuffer();
  return bytesToBase64(new Uint8Array(ab));
}
function selectedCustomerExportIds(){
  return CUSTOMER_EXPORT_SELECTION.map((id)=>parseInt(id,10)).filter((id)=>Number.isFinite(id)&&id>0);
}
function setCustomerExportSelection(ids){
  CUSTOMER_EXPORT_SELECTION=Array.from(new Set((ids||[]).map((id)=>parseInt(id,10)).filter((id)=>Number.isFinite(id)&&id>0)));
}
function toggleCustomerExportSelection(id, checked){
  const numeric=parseInt(id,10);
  if(!Number.isFinite(numeric) || numeric<=0) return;
  if(checked) setCustomerExportSelection([...CUSTOMER_EXPORT_SELECTION, numeric]);
  else setCustomerExportSelection(CUSTOMER_EXPORT_SELECTION.filter((row)=>row!==numeric));
}
function syncCustomerExportButton(){
  const btn=g('customers-export-btn');
  if(btn) btn.style.display=hasActionAccess('users','manage')?'':'none';
}
function visibleCustomersForExport(){
  const customers=getMarketingGroupCustomers();
  return !CUSTOMER_NAME_SEARCH
    ? customers
    : customers.filter(c=>String(c.name||'').toLowerCase().includes(CUSTOMER_NAME_SEARCH));
}
function openCustomerExportModal(){
  if(!hasActionAccess('users','manage')){ toast('Only admins can export customers','err'); return; }
  const customers=visibleCustomersForExport();
  if(!customers.length){ toast('No customers available to export in this view','err'); return; }
  setCustomerExportSelection(selectedCustomerExportIds().filter((id)=>customers.some((c)=>Number(c.id)===id)));
  openModal(`
    <div class="modal-title">Export Customers</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
        <div style="font-size:12.5px;color:var(--text-2)">Choose customers to export as Excel. This file can be imported back into the app.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-s btn-sm" onclick="selectAllCustomerExports(true)">Select All</button>
          <button type="button" class="btn btn-s btn-sm" onclick="selectAllCustomerExports(false)">Clear</button>
        </div>
      </div>
      <div id="customer-export-list" style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:10px"></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="downloadSelectedCustomersExcel()">Download Excel</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'lg');
  renderCustomerExportList();
}
function renderCustomerExportList(){
  const host=g('customer-export-list');
  if(!host) return;
  const customers=visibleCustomersForExport();
  const selected=new Set(selectedCustomerExportIds());
  host.innerHTML=customers.map((c)=>`
    <label class="user-check-item" style="width:100%;justify-content:space-between">
      <span style="display:flex;align-items:flex-start;gap:10px">
        <input type="checkbox" ${selected.has(Number(c.id))?'checked':''} onchange="toggleCustomerExportSelection(${Number(c.id)}, this.checked)">
        <span>
          <div style="font-weight:700">${esc(c.name||'')}</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(c.phone||'')} · ${esc(c.area||'')}</div>
        </span>
      </span>
    </label>`).join('');
}
function selectAllCustomerExports(selectAll){
  const customers=visibleCustomersForExport();
  setCustomerExportSelection(selectAll ? customers.map((c)=>c.id) : []);
  renderCustomerExportList();
}
async function downloadSelectedCustomersExcel(){
  const ids=selectedCustomerExportIds();
  if(!ids.length){ toast('Select at least one customer','err'); return; }
  try{
    const res=await fetch('/api/customers/export',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({customerIds:ids}),
      credentials:'same-origin',
    });
    if(!res.ok){
      const raw=await res.text();
      let message=raw||`${res.status}`;
      try{
        const parsed=JSON.parse(raw);
        if(parsed?.detail) message=String(parsed.detail);
      }catch(_){}
      throw new Error(message);
    }
    const blob=await res.blob();
    const disposition=res.headers.get('Content-Disposition')||'';
    const match=/filename=\"?([^\";]+)\"?/i.exec(disposition);
    const fileName=match?.[1]||'customers-export.xlsx';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeModal();
    toast('Customer export downloaded','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function completedOrdersForExport(){
  return (S.orders||[]).filter((o)=>isCompleted(o));
}
function daysAgoISO(days){
  const d=new Date();
  d.setDate(d.getDate()-Math.max(0,parseInt(days||0,10)||0));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function openCompletedOrdersExportModal(){
  const done=completedOrdersForExport();
  if(!done.length){ toast('No completed orders to export','err'); return; }
  openModal(`
    <div class="modal-title">Export Completed Orders</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:16px">
      <div class="fg">
        <label>Date Range</label>
        <select id="orders-export-range" onchange="onCompletedOrdersExportRangeChange()">
          <option value="last_7_days">Last 7 days</option>
          <option value="last_1_month">Last 1 month</option>
          <option value="custom">Custom date range</option>
          <option value="all">All completed orders</option>
        </select>
      </div>
      <div id="orders-export-custom-row" style="display:none;gap:10px">
        <div class="fg" style="flex:1">
          <label>From</label>
          <input id="orders-export-start" type="date" value="${daysAgoISO(6)}" onclick="openNativePicker('orders-export-start')">
        </div>
        <div class="fg" style="flex:1">
          <label>To</label>
          <input id="orders-export-end" type="date" value="${todayISO()}" onclick="openNativePicker('orders-export-end')">
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-3)">Only orders marked as <strong>Completed</strong> will be exported.</div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="downloadCompletedOrdersExport()">Download CSV</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
}
function onCompletedOrdersExportRangeChange(){
  const range=g('orders-export-range')?.value||'last_7_days';
  const row=g('orders-export-custom-row');
  if(!row) return;
  row.style.display=range==='custom'?'flex':'none';
}
async function downloadCompletedOrdersExport(){
  const range=(g('orders-export-range')?.value||'last_7_days');
  const payload={range};
  if(range==='custom'){
    const startDate=(g('orders-export-start')?.value||'').trim();
    const endDate=(g('orders-export-end')?.value||'').trim();
    if(!startDate || !endDate){ toast('Select both start and end date','err'); return; }
    if(startDate>endDate){ toast('End date must be same day or after start date','err'); return; }
    payload.startDate=startDate;
    payload.endDate=endDate;
  }
  try{
    const res=await fetch('/api/orders/export-completed',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      credentials:'same-origin',
    });
    if(!res.ok){
      const raw=await res.text();
      let message=raw||`${res.status}`;
      try{
        const parsed=JSON.parse(raw);
        if(parsed?.detail) message=String(parsed.detail);
      }catch(_){}
      throw new Error(message);
    }
    const blob=await res.blob();
    const disposition=res.headers.get('Content-Disposition')||'';
    const match=/filename=\"?([^\";]+)\"?/i.exec(disposition);
    const fileName=match?.[1]||'completed-orders-export.csv';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeModal();
    toast('Completed orders export downloaded','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function openBulkImportModal(){
  openModal(`
    <div class="modal-title">Bulk Import Customers</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div style="font-size:12.5px;color:var(--text-2)">Supported files: <strong>.xlsx</strong>, <strong>.xlsm</strong>, <strong>.csv</strong>, <strong>.vcf</strong></div>
      <div class="fg"><label>File <span class="req">*</span></label><input id="bulk-file" type="file" accept=".xlsx,.xlsm,.csv,.vcf"></div>
      <div style="font-size:12px;color:var(--text-3)">Excel/CSV expected columns: <code>Name</code>, <code>Phone</code>, optional <code>Area</code>, <code>Email</code>, <code>Address</code>.</div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitBulkImport()">Import Customers</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'lg');
}
async function submitBulkImport(){
  const inp=g('bulk-file');
  const file=inp?.files?.[0];
  if(!file){ toast('Choose a file to import','err'); return; }
  const fmt=detectImportFormat(file.name);
  if(!fmt){ toast('Unsupported file. Use .xlsx, .xlsm, .csv, or .vcf','err'); return; }
  try{
    const contentBase64=await fileToBase64(file);
    const res=await api.post('/api/customers/import',{format:fmt,filename:file.name,contentBase64});
    const imported=Array.isArray(res.customers)?res.customers:[];
    if(imported.length){
      S.customers.push(...imported);
      const maxId=Math.max(0,...S.customers.map(c=>parseInt(c.id||0)||0));
      S.cid=maxId+1;
    }
    closeModal();
    rCustomers();
    toast(`Imported ${res.imported||0}, skipped ${res.skipped||0}`,(res.imported||0)>0?'ok':'');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}

// "Add Customer" button on the Customers page opens a modal form
function openAddCustomerModal(){
  if(!hasActionAccess('customers','create')){ toast('Customer creation is restricted','err'); return; }
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
      <div class="fg">
        <label>Add Tags <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
        <div id="customer-add-tag-picker"></div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Use tags to filter and group customers. You can select from existing tags or create new ones here.</div>
      </div>
      <div class="fg"><label>Address <span style="color:var(--text-3);font-weight:400">(optional)</span></label><textarea id="fx" rows="2" placeholder="Full delivery address…"></textarea></div>
      <div class="fg"><label>Notes <span style="color:var(--text-3);font-weight:400">(optional)</span></label><textarea id="fnotes" rows="2" placeholder="Any customer-specific notes…"></textarea></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="saveC()">Save Customer</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`,'lg');
  ensureCustomerTagPicker('customer-add',[]);
}

async function saveC(){
  const name=g('fn').value.trim(),phone=g('fp').value.trim(),area=g('fa').value.trim();
  if(!name||!phone||!area){toast('Name, phone & area required','err');return;}
  if(!/^\d{10}$/.test(phone)){toast('Phone must be 10 digits','err');return;}
  try{
    const c=await api.post('/api/customers',{name,phone,area,email:g('fe').value.trim(),address:g('fx').value.trim(),notes:g('fnotes').value.trim(),productTags:getSelectedCustomerTags('customer-add'),at:Date.now()});
    S.customers.push(c); S.cid=c.id+1;
    syncCustomerProductTagCatalog(c.productTags||[]);
    closeModal();
    toast(name+' added','ok'); rCustomers();
  }catch(e){toast('Error: '+e.message,'err');}
}

function openCustomerAnalytics(cid){
  const c=S.customers.find(x=>x.id===cid);
  if(!c) return;
  const tags=normalizeCustomerProductTags(c.productTags||[]);
  const orders=getCustomerOrders(cid);
  const completed=orders.filter(isCompleted);
  const totalOrders=orders.length;
  const completedOrders=completed.length;
  const totalRevenue=completed.reduce((s,o)=>s+(Number(orderRevenue(o))||0),0);
  const totalProfit=completed.reduce((s,o)=>s+((orderProfit(o)??0)),0);
  const avgOrderValue=completedOrders ? (totalRevenue/completedOrders) : 0;
  const avgGapDays=avgGapDaysForCustomer(cid);
  const reorderText=Number.isFinite(avgGapDays) ? `${avgGapDays.toFixed(1)} days` : 'Not enough data';
  const firstOrder=orders[0] || null;
  const lastOrder=orders[orders.length-1] || null;
  const ch=preferredChannelForCustomer(cid);
  const chLabel=ch ? (CHANNEL_MAP[ch]?.label || ch) : 'N/A';
  const byProd={};
  orders.forEach(o=>{
    const key=String(o.prod||'Unknown product').trim() || 'Unknown product';
    byProd[key]=(byProd[key]||0)+1;
  });
  const topProduct=Object.entries(byProd).sort((a,b)=>b[1]-a[1])[0];
  const topProductLabel=topProduct ? `${topProduct[0]} (${topProduct[1]} order${topProduct[1]!==1?'s':''})` : 'N/A';

  openModal(`
    <div class="modal-title">Customer Analytics</div>
    <div style="margin-top:4px;color:var(--text-2);font-size:12.5px">${esc(c.name)} · ${esc(c.area||'')}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px">
        <div style="font-size:11px;color:var(--text-3)">Avg Order Value</div>
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--text);margin-top:2px">${fC(avgOrderValue)}</div>
      </div>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px">
        <div style="font-size:11px;color:var(--text-3)">Reorder Frequency</div>
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--text);margin-top:2px">${esc(reorderText)}</div>
      </div>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px">
        <div style="font-size:11px;color:var(--text-3)">Total Revenue</div>
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--text);margin-top:2px">${fC(totalRevenue)}</div>
      </div>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px">
        <div style="font-size:11px;color:var(--text-3)">Total Profit</div>
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--text);margin-top:2px">${fC(totalProfit)}</div>
      </div>
    </div>

    <div style="margin-top:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-3)">Orders (All / Completed)</span>
        <strong>${totalOrders} / ${completedOrders}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-3)">Preferred Channel</span>
        <strong>${esc(chLabel)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-3)">Tags</span>
        <strong style="text-align:right">${esc(tags.join(', ')||'None')}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-3)">Top Item</span>
        <strong style="text-align:right">${esc(topProductLabel)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-3)">First Order</span>
        <strong>${firstOrder?fd(firstOrder.at):'N/A'}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;font-size:12px">
        <span style="color:var(--text-3)">Last Order</span>
        <strong>${lastOrder?fd(lastOrder.at):'N/A'}</strong>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:10px">
      <button class="btn btn-s" onclick="closeModal()">Close</button>
    </div>
  `,'lg');
  const box=g('modal-box');
  if(box) box.classList.add('modal-no-scroll');
}

function rCustomers(){
  const grid=g('cg');
  syncCustomerExportButton();
  if(!MKT_GROUPS.length) loadMarketingGroups();
  refreshMarketingAreas();
  refreshMarketingProductTags();
  const totalCustomers=(S.customers||[]).length;
  const customers=getMarketingGroupCustomers();
  const filteredCustomers=!CUSTOMER_NAME_SEARCH
    ? customers
    : customers.filter(c=>String(c.name||'').toLowerCase().includes(CUSTOMER_NAME_SEARCH));
  if(g('mkt-group-summary')) g('mkt-group-summary').textContent=buildMarketingGroupSummary(customers);
  if(g('mkt-group-sample')){
    const sample=customers.slice(0,5).map(c=>`${c.name} (${c.area||'-'})`).join(', ');
    g('mkt-group-sample').textContent=sample?`Sample: ${sample}${customers.length>5?' ...':''}`:'No customers match current filters.';
  }
  const activeGroup=MKT_GROUPS.find(x=>x.id===MKT_ACTIVE_GROUP_ID);
  if(g('cs-sub')){
    const suffix=activeGroup ? ` · group: ${activeGroup.name}` : '';
    const searchSuffix=CUSTOMER_NAME_SEARCH?` · search: "${CUSTOMER_NAME_SEARCH}"`:'';
    g('cs-sub').textContent=`${filteredCustomers.length} of ${totalCustomers} customer${totalCustomers!==1?'s':''}${suffix}${searchSuffix}`;
  }
  if(!totalCustomers){
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="ei"></div><div class="et">No customers yet</div><div class="es">Add your first customer to get started</div></div>`;
    return;
  }
  if(!customers.length){
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="ei"></div><div class="et">No customers in this filter</div><div class="es">Adjust group filters in this page or apply another saved group from Marketing.</div></div>`;
    return;
  }
  if(!filteredCustomers.length){
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="ei"></div><div class="et">No customer found</div><div class="es">Try a different name in search.</div></div>`;
    return;
  }
  const totalPages=Math.max(1,Math.ceil(filteredCustomers.length/CUSTOMERS_PAGE_SIZE));
  CUSTOMER_PAGE=Math.min(Math.max(1,CUSTOMER_PAGE),totalPages);
  const start=(CUSTOMER_PAGE-1)*CUSTOMERS_PAGE_SIZE;
  const pageCustomers=filteredCustomers.slice(start,start+CUSTOMERS_PAGE_SIZE);
  const cards=pageCustomers.map(c=>{
    const oc=S.orders.filter(o=>o.cid===c.id).length;
    const ini=c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const orderTag=oc>0?'Order recorded':'No order yet';
    const tags=normalizeCustomerProductTags(c.productTags||[]);
    return`<div class="cc" onclick="openCustomerAnalytics(${c.id})" style="cursor:pointer">
      <div class="cc-top">
        <div class="cav">${ini}</div>
        <div style="flex:1;min-width:0">
          <div class="cnm" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span>${esc(c.name)}</span>
          </div>
          <div class="car">${esc(c.area)}</div>
        </div>
        <button class="c-menu-btn" onclick="event.stopPropagation();openCustomerMenu(${c.id},this)" title="Options">···</button>
      </div>
      <div class="cm">
        <div class="cmr"><span class="cmi">↗</span>${esc(c.phone)}</div>
        ${c.email?`<div class="cmr"><span class="cmi">@</span>${esc(c.email)}</div>`:''}
        ${c.address?`<div class="cmr" style="font-size:11.5px"><span class="cmi">⌂</span>${esc(c.address)}</div>`:''}
        ${c.notes?`<div class="cmr" style="font-size:11.5px"><span class="cmi">✎</span>${esc(c.notes)}</div>`:''}
        ${tags.length?`<div class="cmr" style="font-size:11.5px;display:block"><span class="cmi">#</span><span style="display:inline-flex;gap:6px;flex-wrap:wrap;vertical-align:top;max-width:calc(100% - 18px)">${tags.map(tag=>`<span class="pill pn" style="font-size:11px;padding:4px 8px">${esc(tag)}</span>`).join('')}</span></div>`:''}
      </div>
      <div class="cf">
        <span class="pill pn">${oc} order${oc!==1?'s':''}</span>
        <span class="pill pn">${orderTag}</span>
        ${oc>=5?`<span class="pill pg">Smart alerts on</span>`:`<span class="pill pn">${oc}/5 for smart</span>`}
      </div>
    </div>`;
  }).join('');
  const pager=totalPages>1
    ? `<div style="grid-column:1/-1">${pagerMarkup(CUSTOMER_PAGE,totalPages,'setCustomerPage')}</div>`
    : '';
  grid.innerHTML=cards+pager;
}

function setCustomerPage(page){
  CUSTOMER_PAGE=Math.max(1,parseInt(page||1,10)||1);
  rCustomers();
}

// 3-dot context menu for customer card
function openCustomerMenu(cid, btn){
  closeOrderMenu(); // reuse same close logic
  const menu=document.createElement('div');
  menu.className='ctx-menu'; menu.id='ctx-menu';
  menu.innerHTML=`${hasActionAccess('customers','edit')?`<button class="ctx-item" onclick="closeOrderMenu();openEditCustomer(${cid})">Edit Customer</button>`:'<div class="ctx-item" style="cursor:default;opacity:.65">View only</div>'}`;
  document.body.appendChild(menu);
  const r=btn.getBoundingClientRect();
  positionCtxMenu(menu, r);
  setTimeout(()=>document.addEventListener('click',_closeMenuOutside,{once:true}),10);
}

function openEditCustomer(cid){
  if(!hasActionAccess('customers','edit')){ toast('Customer editing is restricted','err'); return; }
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
      <div class="fg">
        <label>Add Tags <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
        <div id="customer-edit-tag-picker"></div>
      </div>
      <div class="fg"><label>Address</label><textarea id="ec-address" rows="2">${esc(c.address||'')}</textarea></div>
      <div class="fg"><label>Notes <span style="color:var(--text-3);font-weight:400">(optional)</span></label><textarea id="ec-notes" rows="2">${esc(c.notes||'')}</textarea></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditCustomer(${cid})">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
      ${hasActionAccess('customers','delete')?`<hr style="margin:4px 0"><button class="btn btn-danger btn-full" onclick="confirmDeleteCustomer(${cid})">Delete Customer</button>`:''}
    </div>`,'lg');
  ensureCustomerTagPicker('customer-edit',c.productTags||[]);
}

async function submitEditCustomer(cid){
  const name=g('ec-name').value.trim(),phone=g('ec-phone').value.trim(),area=g('ec-area').value.trim();
  if(!name||!phone||!area){toast('Name, phone & area required','err');return;}
  if(!/^\d{10}$/.test(phone)){toast('Phone must be 10 digits','err');return;}
  try{
    const updated=await api.put(`/api/customers/${cid}`,{name,phone,area,email:g('ec-email').value.trim(),address:g('ec-address').value.trim(),notes:g('ec-notes').value.trim(),productTags:getSelectedCustomerTags('customer-edit')});
    const idx=S.customers.findIndex(c=>c.id===cid); if(idx>=0) S.customers[idx]=updated;
    syncCustomerProductTagCatalog(updated.productTags||[]);
    S.orders.forEach(o=>{if(o.cid===cid){o.cname=name;o.cphone=phone;o.carea=area;}});
    closeModal(); toast(name+' updated','ok'); rCustomers();
  }catch(e){toast('Error: '+e.message,'err');}
}

function confirmDeleteCustomer(cid){
  if(!hasActionAccess('customers','delete')){ toast('Customer deletion is restricted','err'); return; }
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

let CUSTOMER_SEARCH_HITS = [];
function cs_search(){
  const q=g('cs').value.trim().toLowerCase(),dd=g('cs-dd');
  const hits=S.customers.filter(c=>c.name.toLowerCase().includes(q)||c.phone.includes(q)||c.area.toLowerCase().includes(q)).slice(0,8);
  CUSTOMER_SEARCH_HITS = hits;
  if(!hits.length){dd.classList.remove('open');return;}
  dd.innerHTML=hits.map(c=>{const oc=S.orders.filter(o=>o.cid===c.id).length;return`<div class="ddi" onclick="pickC(${c.id})"><div><div class="ddi-n">${esc(c.name)}</div><div class="ddi-m">${esc(c.phone)} · ${esc(c.area)}</div></div><span class="ddi-a">${oc} order${oc!==1?'s':''}</span></div>`;}).join('');
  dd.classList.add('open');
}
function pickC(id){
  selC=S.customers.find(c=>c.id===id); g('cs').value=selC.name; g('cs-dd').classList.remove('open');
  const ini=selC.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const oc=S.orders.filter(o=>o.cid===id).length;
  const el=g('sel-c'); el.style.display='block';
  el.innerHTML=`<div class="sc-box"><div style="display:flex;align-items:center;gap:10px"><div class="sc-av">${esc(ini)}</div><div><div class="sc-n">${esc(selC.name)}</div><div class="sc-m">${esc(selC.area)} · ${oc} previous order${oc!==1?'s':''}</div></div></div><button class="btn btn-g btn-xs" onclick="clearC()">✕</button></div>`;
  refreshSum();
}
function clearC(){ selC=null;CUSTOMER_SEARCH_HITS=[];g('cs').value='';g('sel-c').style.display='none';refreshSum(); }
document.addEventListener('keydown',(e)=>{
  if(String(e.key||'')!=='Enter') return;
  const target=e.target;
  if(!(target instanceof Element)) return;
  if(target.id!=='cs') return;
  if(!Array.isArray(CUSTOMER_SEARCH_HITS) || !CUSTOMER_SEARCH_HITS.length) return;
  e.preventDefault();
  pickC(CUSTOMER_SEARCH_HITS[0].id);
});
document.addEventListener('click',e=>{ if(!e.target.closest('.sw')){ CUSTOMER_SEARCH_HITS=[]; g('cs-dd').classList.remove('open'); } });

function populateProdSelect(){
  const sel=g('ps'); sel.innerHTML='<option value="">Select product / service…</option>';
  S.products.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;sel.appendChild(o);});
  selV=null;selCh='retail';saleDelivered=false;g('vr-row').innerHTML='';renderChannelPicker();updateDeliveredToggle();refreshSum();
}
function onProdChange(){ const pid=g('ps').value;selV=null;if(!pid){g('vr-row').innerHTML='';refreshSum();return;}
  const prod=S.products.find(p=>p.id===pid);
  g('vr-row').innerHTML=(prod.sizes||DEFAULT_SIZES).map(sz=>`<button class="vb" data-v="${sz}" onclick="pickV('${sz}')"><span class="vs">${VL[sz]||sz}</span><span class="vh">~${variantCycleDays(prod,sz)}d cycle</span></button>`).join('');
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
  const sp=getSalePrice(pid,selV,selCh),cost=getTotalCost(pid,selV),ad=variantCycleDays(prod,selV)*qty;
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
    <div class="sr"><span class="sk">Customer</span><span class="sval">${esc(selC.name)}</span></div>
    <div class="sr"><span class="sk">Product / Service</span><span class="sval">${esc(prod.name)}</span></div>
    <div class="sr"><span class="sk">Size</span><span class="sval">${esc(VL[selV]||selV)}</span></div>
    <div class="sr"><span class="sk">Qty</span><span class="sval">${qty} pack${qty>1?'s':''}</span></div>
    <div class="sr"><span class="sk">Channel</span><span class="sval">${esc(CHANNEL_MAP[selCh]?.label||selCh)}</span></div>
    ${statusNote}
    <hr class="sdiv">
    <div class="sr"><span class="sk">Alert if no re-order within</span><span class="sval">${ad} days</span></div>
    ${priceRows}`;
}

async function recSale(){
  if(!hasActionAccess('orders','create')){ toast('Order creation is restricted','err'); return; }
  const pid=g('ps').value;
  if(!selC){toast('Select a customer','err');return;}
  if(!pid){toast('Select a product or service','err');return;}
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
  body.innerHTML=`
    <div style="display:flex;justify-content:flex-end;padding:12px 12px 0 12px">
      <button class="btn btn-s btn-sm" onclick="openCompletedOrdersExportModal()" ${done.length?'':'disabled'}>Export Completed Orders</button>
    </div>
  `+buildOrderTable(active,'Active Orders',false,'active')+buildOrderTable(done,'Completed Orders',true,'completed');
}

function buildOrderTable(orders,title,collapsible,bucket){
  if(!orders.length) return collapsible?'':`<div style="padding:18px 16px;color:var(--text-3);font-size:13px">No ${title.toLowerCase()} yet</div>`;
  const id='ot-'+title.replace(/\s/g,'-').toLowerCase();
  const totalPages=Math.max(1,Math.ceil(orders.length/ORDERS_PAGE_SIZE));
  const currPage=Math.min(Math.max(1,ORDER_PAGES[bucket]||1),totalPages);
  ORDER_PAGES[bucket]=currPage;
  const start=(currPage-1)*ORDERS_PAGE_SIZE;
  const pageOrders=orders.slice(start,start+ORDERS_PAGE_SIZE);
  const header=`<div class="orders-section-header ${collapsible?'collapsible':''}" onclick="${collapsible?`toggleSection('${id}')`:''}" id="${id}-hdr">
    <span class="orders-section-title">${title}</span>
    <span class="orders-section-count">${orders.length}</span>
    ${collapsible?`<span class="section-chevron" id="${id}-chev">▼</span>`:''}
  </div>`;
  // Desktop table
  const desktopTable=`<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Customer</th><th>Product / Service</th><th>Size</th><th>Qty</th><th>Channel</th><th>Status</th><th>Revenue</th><th>Profit</th><th>Date</th><th></th></tr></thead>
    <tbody>${pageOrders.map(o=>orderRow(o)).join('')}</tbody>
  </table></div>`;
  // Mobile card list
  const mobileCards=`<div class="order-card-list">${pageOrders.map(o=>orderMobileCard(o)).join('')}</div>`;
  const pager=totalPages>1?pagerMarkup(currPage,totalPages,`setOrderPage.bind(null,'${bucket}')`):'';
  return `${header}<div id="${id}">${desktopTable}${mobileCards}${pager}</div>`;
}

function setOrderPage(bucket,page){
  ORDER_PAGES[bucket]=Math.max(1,parseInt(page||1,10)||1);
  rOrders();
}

function orderRow(o){
  const rev=orderRevenue(o),prof=orderProfit(o);
  const disc=parseFloat(o.discount||0);
  const comm=orderCommissionBreakup(o);
  const opts=statusOpts(o.channel||'retail');
  const isDist=isDistributorOrder(o);
  const distName=isDist?String(o.distribution.distributorName||'').trim():'';
  const customerTitle=isDist?'Distributor Channel':o.cname;
  const customerSub=isDist?(distName?`via ${distName}`:'via Distributor'):o.carea;
  const statusBtn=`<div class="status-dropdown-wrap">
    <button class="status-badge ${STATUS_CLS[o.status||'pending']} status-clickable" onclick="toggleStatusDropdown(${o.id},this)">${STATUS_LABEL[o.status]||o.status} ▾</button>
    <div class="status-dropdown" id="sdrop-${o.id}">
      ${opts.map(s=>`<button class="sdrop-item ${s.id===o.status?'active':''}" onclick="quickStatus(${o.id},'${s.id}',this)">${s.label}</button>`).join('')}
    </div>
  </div>`;
  return`<tr>
    <td><span class="pill pn" style="font-size:10.5px;font-family:monospace">#${o.id}</span></td>
    <td>
      <div style="font-weight:600">${esc(customerTitle)}</div>
      <div style="font-size:11.5px;color:var(--text-3)">${esc(customerSub)}</div>
    </td>
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
  const isDist=isDistributorOrder(o);
  const distName=isDist?String(o.distribution.distributorName||'').trim():'';
  const customerTitle=isDist?'Distributor Channel':o.cname;
  const customerSub=isDist?(distName?`via ${esc(distName)}`:'via Distributor'):`${esc(o.prod)} · ${VL[o.variant]||o.variant} × ${o.qty}`;
  const stSel=`<select class="inline-status-sel ${STATUS_CLS[o.status||'pending']}" onchange="mobileQuickStatus(${o.id},this)">${opts.map(s=>`<option value="${s.id}" ${o.status===s.id?'selected':''}>${s.label}</option>`).join('')}</select>`;
  const profLine=isCompleted(o)&&prof!==null?`<span style="font-size:12px;font-weight:700;color:${prof>=0?'var(--green)':'var(--red)'}">₹${prof.toFixed(0)} profit</span>`:'';
  return`<div class="order-card">
    <div class="order-card-top">
      <div>
        <div class="order-card-name">${esc(customerTitle)}</div>
        <div class="order-card-prod">${customerSub}</div>
        ${isDist?`<div class="order-card-prod">${esc(o.prod)} · ${VL[o.variant]||o.variant} × ${o.qty}</div>`:''}
      </div>
      <div class="order-card-right">
        <div class="order-card-right-top">
          ${isCompleted(o)&&rev>0?`<span class="order-card-rev">₹${rev.toFixed(0)}</span>`:''}
          <button class="order-card-menu" onclick="openOrderMenu(${o.id},this)" title="More options">⋯</button>
        </div>
        <span style="font-size:11px;color:var(--text-3)">${fd(o.at)}</span>
      </div>
    </div>
    <div class="order-card-meta">
      ${chBadge(o.channel||'retail')}
      ${stSel}
      ${profLine}
      ${disc>0||comm.total>0?`<span style="font-size:11px;color:var(--text-3)">${[disc>0?`-₹${disc}d`:'',comm.manual>0?`-₹${comm.manual.toFixed(0)}mc`:'',comm.gateway>0?`-₹${comm.gateway.toFixed(0)}pg`:''].filter(Boolean).join(' ')}</span>`:''}
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

// ─── DISTRIBUTION ─────────────────────────────────────────────────────────────
function distProductOptions(selected=''){
  return `<option value="">Select product / service…</option>` + (S.products||[]).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('');
}
function distVariantOptions(pid, selected=''){
  const prod=(S.products||[]).find(p=>p.id===pid);
  const sizes=(prod?.sizes&&prod.sizes.length)?prod.sizes:DEFAULT_SIZES;
  return sizes.map(sz=>`<option value="${sz}" ${sz===selected?'selected':''}>${VL[sz]||sz}</option>`).join('');
}
function onDistProductChange(){
  const pid=g('dist-prod')?.value||'';
  const sel=g('dist-variant');
  if(!sel) return;
  sel.innerHTML=pid?distVariantOptions(pid):'<option value="">Select size…</option>';
}
async function createDistributorBatch(){
  if(!hasActionAccess('distribution','create')){ toast('Distribution batch creation is restricted','err'); return; }
  const distributorName=getDistNameValue('dist');
  const prodId=(g('dist-prod')?.value||'').trim();
  const variant=(g('dist-variant')?.value||'').trim();
  const qty=parseInt(g('dist-qty')?.value||0)||0;
  const commission=Math.max(0,parseFloat(g('dist-commission')?.value||0)||0);
  const commissionMode=(g('dist-comm-batch')?.checked)?'batch':'per_pcs';
  const notes=(g('dist-notes')?.value||'').trim();
  const dateVal=(g('dist-date')?.value||'').trim();
  let at=Date.now();
  if(dateVal){
    const [y,m,d]=dateVal.split('-').map(Number);
    const dt=new Date(y,m-1,d,12,0,0);
    if(!isNaN(dt.getTime())) at=dt.getTime();
  }
  if(!distributorName){ toast('Distributor name is required','err'); return; }
  if(!prodId||!variant){ toast('Select a product / service and variant','err'); return; }
  if(qty<=0){ toast('Quantity must be greater than 0','err'); return; }
  try{
    const batch=await api.post('/api/distribution/batches',{distributorName,prodId,variant,qty,commission,commissionMode,notes,at});
    S.distributorBatches=S.distributorBatches||[];
    S.distributorBatches.unshift(batch);
    rememberDistributorName(distributorName);
    if(g('dist-name')) g('dist-name').value='';
    if(g('dist-name-custom')) g('dist-name-custom').value='';
    onDistNameSelectChange();
    g('dist-prod').value='';
    g('dist-variant').innerHTML='<option value="">Select size…</option>';
    g('dist-qty').value='1';
    g('dist-date').value=todayISO();
    g('dist-commission').value='0';
    g('dist-comm-batch').checked=false;
    g('dist-notes').value='';
    rDistribution();
    toast('Distributor batch added','ok');
  }catch(e){ toast('Error: '+e.message,'err'); }
}
function openCompleteDistributorBatch(batchId){
  const b=(S.distributorBatches||[]).find(x=>x.id===batchId);
  if(!b) return;
  const suggested=(getSalePrice(b.prodId,b.variant,'retail')*(parseInt(b.qty||0)||0))||0;
  openModal(`
    <div class="modal-title">Complete Distributor Batch</div>
    <div style="font-size:12px;color:var(--text-3);margin-top:6px">
      ${esc(b.distributorName)} · ${esc(b.prod)} · ${VL[b.variant]||b.variant} × ${b.qty}
    </div>
    <div class="sumbox" style="margin-top:14px">
      <div class="sr"><span class="sk">Commission mode</span><span class="sval">${commissionModeLabel(b.commissionMode)}</span></div>
      <div class="sr"><span class="sk">Commission value</span><span class="sval">₹${(parseFloat(b.commission||0)||0).toFixed(2)}</span></div>
      <div class="sr"><span class="sk">Total commission</span><span class="sval">₹${batchCommissionTotal(b).toFixed(2)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
      <div class="fg">
        <label>Amount Collected (₹) <span class="req">*</span></label>
        <div class="input-prefix"><span>₹</span><input type="number" id="dist-amount-collected" min="0" step="0.01" value="${Number(suggested||0).toFixed(0)}"></div>
      </div>
      <div class="fg">
        <label>Payment Method</label>
        <select id="dist-pm">
          <option value="">— Select —</option>
          ${PAYMENT_METHODS.map(m=>`<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitCompleteDistributorBatch(${batchId})">Mark Completed</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
}
async function submitCompleteDistributorBatch(batchId){
  const amountCollected=parseFloat(g('dist-amount-collected')?.value||0);
  const paymentMethod=(g('dist-pm')?.value||'').trim();
  if(!Number.isFinite(amountCollected)||amountCollected<0){
    toast('Enter a valid collected amount','err');
    return;
  }
  try{
    const res=await api.post(`/api/distribution/batches/${batchId}/complete`,{amountCollected,paymentMethod,at:Date.now()});
    S.distributorBatches=(S.distributorBatches||[]).map(b=>b.id===batchId?res.batch:b);
    S.orders=S.orders||[];
    S.orders.unshift(res.order);
    closeModal();
    rDistribution();
    rOrders();
    rDash();
    updBadge();
    toast(`Batch completed via ${res.batch.distributorName}`,'ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function openDistributionBatchMenu(batchId, btnEl){
  closeOrderMenu();
  const b=(S.distributorBatches||[]).find(x=>x.id===batchId);
  if(!b) return;
  const menu=document.createElement('div');
  menu.className='ctx-menu';
  menu.id='ctx-menu';
  menu.innerHTML=`
    <button class="ctx-item" onclick="closeOrderMenu();openEditDistributorBatch(${batchId})">Edit Batch</button>
    <hr class="ctx-divider">
    <button class="ctx-item ctx-danger" onclick="closeOrderMenu();openDeleteDistributorBatch(${batchId})">Delete Batch</button>
  `;
  document.body.appendChild(menu);
  const r=btnEl.getBoundingClientRect();
  positionCtxMenu(menu, r);
  _menuOpen=`dist-${batchId}`;
  setTimeout(()=>document.addEventListener('click',_closeMenuOutside,{once:true}),10);
}
function onEditDistProductChange(){
  const pid=(g('edit-dist-prod')?.value||'').trim();
  const sel=g('edit-dist-variant');
  if(!sel) return;
  sel.innerHTML=pid?distVariantOptions(pid):'<option value="">Select size…</option>';
}
function openEditDistributorBatch(batchId){
  const b=(S.distributorBatches||[]).find(x=>x.id===batchId);
  if(!b) return;
  if(String(b.status||'').toLowerCase()==='completed'){
    toast('Completed batch cannot be edited','err');
    return;
  }
  const savedNames=getSavedDistributorNames();
  const existingName=String(b.distributorName||'').trim();
  const useCustom=existingName && !savedNames.some(n=>n===existingName);
  openModal(`
    <div class="modal-title">Edit Distributor Batch</div>
    <div style="font-size:12px;color:var(--text-3);margin-top:6px">Batch #${b.id}</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
      <div class="fg">
        <label>Distributor Name <span class="req">*</span></label>
        <select id="edit-dist-name" onchange="onEditDistNameSelectChange()">
          ${distributorOptionsHtml(useCustom?'__new__':existingName)}
        </select>
        <input id="edit-dist-name-custom" type="text" value="${useCustom?esc(existingName):''}" placeholder="e.g. Coorg Wholesale" style="display:${useCustom?'block':'none'};margin-top:8px">
      </div>
      <div class="fr">
        <div class="fg">
          <label>Product / Service <span class="req">*</span></label>
          <select id="edit-dist-prod" onchange="onEditDistProductChange()">${distProductOptions(b.prodId||'')}</select>
        </div>
        <div class="fg">
          <label>Pack Size <span class="req">*</span></label>
          <select id="edit-dist-variant">${distVariantOptions(b.prodId||'', b.variant||'')}</select>
        </div>
      </div>
      <div class="fr">
        <div class="fg">
          <label>Quantity (packs) <span class="req">*</span></label>
          <input id="edit-dist-qty" type="number" min="1" step="1" value="${parseInt(b.qty||0)||1}">
        </div>
        <div class="fg">
          <label>Commission (₹)</label>
          <div class="input-prefix"><span>₹</span><input id="edit-dist-commission" type="number" min="0" step="0.01" value="${(parseFloat(b.commission||0)||0).toFixed(2)}"></div>
        </div>
      </div>
      <div class="toggle-row" style="margin:0">
        <div>
          <div class="toggle-lbl">Commission Mode</div>
          <div class="toggle-sub">Enable for whole batch commission</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="edit-dist-comm-batch" ${b.commissionMode==='batch'?'checked':''}>
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="fg">
        <label>Notes</label>
        <textarea id="edit-dist-notes" rows="2" placeholder="Optional notes">${esc(b.notes||'')}</textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditDistributorBatch(${batchId})">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
}
function onEditDistNameSelectChange(){
  const sel=g('edit-dist-name');
  const custom=g('edit-dist-name-custom');
  if(!sel||!custom) return;
  const show=sel.value==='__new__';
  custom.style.display=show?'block':'none';
  if(show) setTimeout(()=>custom.focus(),0);
}
async function submitEditDistributorBatch(batchId){
  const distributorName=getDistNameValue('edit-dist');
  const prodId=(g('edit-dist-prod')?.value||'').trim();
  const variant=(g('edit-dist-variant')?.value||'').trim();
  const qty=parseInt(g('edit-dist-qty')?.value||0)||0;
  const commission=Math.max(0,parseFloat(g('edit-dist-commission')?.value||0)||0);
  const commissionMode=(g('edit-dist-comm-batch')?.checked)?'batch':'per_pcs';
  const notes=(g('edit-dist-notes')?.value||'').trim();
  if(!distributorName){ toast('Distributor name is required','err'); return; }
  if(!prodId||!variant){ toast('Select a product / service and variant','err'); return; }
  if(qty<=0){ toast('Quantity must be greater than 0','err'); return; }
  try{
    const updated=await api.put(`/api/distribution/batches/${batchId}`,{distributorName,prodId,variant,qty,commission,commissionMode,notes});
    S.distributorBatches=(S.distributorBatches||[]).map(b=>b.id===batchId?updated:b);
    rememberDistributorName(distributorName);
    closeModal();
    rDistribution();
    rAlerts();
    rDash();
    updBadge();
    toast('Distributor batch updated','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function openDeleteDistributorBatch(batchId){
  const b=(S.distributorBatches||[]).find(x=>x.id===batchId);
  if(!b) return;
  const linkedOrder=(parseInt(b.orderId||0)||0)>0;
  openModal(`
    <div class="modal-title">Delete Distributor Batch?</div>
    <div style="font-size:12.5px;color:var(--text-3);margin-top:6px">
      Batch #${b.id} · ${esc(b.distributorName||'Distributor')} · ${esc(b.prod||'')} · ${VL[b.variant]||b.variant} × ${parseInt(b.qty||0)||0}
    </div>
    ${linkedOrder?`<div style="margin-top:10px;padding:10px;border:1px solid var(--amber-bd);background:var(--amber-bg);color:var(--amber);border-radius:8px;font-size:12px">This completed batch is linked to Order #${b.orderId}. Deleting this batch will also delete that order.</div>`:''}
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-danger" style="flex:1" onclick="doDeleteDistributorBatch(${batchId})">Yes, Delete</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>
  `,'lg');
}
async function doDeleteDistributorBatch(batchId){
  let res = null;
  try{
    // Prefer proxy-safe POST endpoint; fallback to DELETE for older servers.
    try{
      res=await api.post(`/api/distribution/batches/${batchId}/delete`,{});
    }catch(primaryErr){
      const msg=String(primaryErr?.message||'');
      const isRouteMissing=msg.includes('"detail":"Not Found"')||msg.includes('404');
      const isAlreadyGone=msg.toLowerCase().includes('batch not found');
      if(isAlreadyGone){
        res={ok:true,removedOrderId:null};
      }else if(isRouteMissing){
        try{
          res=await api.del(`/api/distribution/batches/${batchId}`);
        }catch(legacyErr){
          const legacyMsg=String(legacyErr?.message||'');
          if(legacyMsg.includes('405')){
            throw new Error('Delete endpoint unavailable on server. Restart/redeploy CRM backend and try again.');
          }
          if(legacyMsg.toLowerCase().includes('batch not found')||legacyMsg.includes('404')){
            res={ok:true,removedOrderId:null};
          }else{
            throw legacyErr;
          }
        }
      }else{
        throw primaryErr;
      }
    }
    S.distributorBatches=(S.distributorBatches||[]).filter(b=>b.id!==batchId);
    if(res && res.removedOrderId){
      S.orders=(S.orders||[]).filter(o=>o.id!==res.removedOrderId);
    }
    closeModal();
    rDistribution();
    rOrders();
    rAlerts();
    rDash();
    updBadge();
    toast('Distributor batch deleted','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}
function distributionRow(b){
  const qty=parseInt(b.qty||0)||0;
  const tot=batchCommissionTotal(b);
  const created=fd(b.at||Date.now());
  const completed=b.completedAt?fd(b.completedAt):'—';
  const st=b.status==='completed'
    ? `<span class="status-badge st-completed">Completed</span>`
    : `<button class="status-badge st-confirmed status-clickable" onclick="openCompleteDistributorBatch(${b.id})">Active ▾</button>`;
  const action=`<button class="btn btn-g btn-xs dots-btn" onclick="openDistributionBatchMenu(${b.id},this)" title="More options">⋯</button>`;
  return `<tr>
    <td><span class="pill pn" style="font-size:10.5px;font-family:monospace">#${b.id}</span></td>
    <td><div style="font-weight:600">${esc(b.distributorName||'')}</div></td>
    <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.prod||'')}</td>
    <td><span class="pill pn">${VL[b.variant]||esc(b.variant||'')}</span></td>
    <td style="font-weight:600">${qty}</td>
    <td>
      <div>${commissionModeLabel(b.commissionMode)} · ₹${(parseFloat(b.commission||0)||0).toFixed(2)}</div>
      <div style="font-size:11px;color:var(--text-3)">Total: ₹${tot.toFixed(2)}</div>
    </td>
    <td>${st}</td>
    <td style="color:var(--text-3)">${created}${b.status==='completed'?`<br><span style="font-size:11px">Done: ${completed}</span>`:''}</td>
    <td style="text-align:center;vertical-align:middle">${action}</td>
  </tr>`;
}
function distributionMobileCard(b){
  const qty=parseInt(b.qty||0)||0;
  const tot=batchCommissionTotal(b);
  return `<div class="order-card">
    <div class="order-card-top">
      <div>
        <div class="order-card-name">${esc(b.distributorName||'')}</div>
        <div class="order-card-prod">${esc(b.prod||'')} · ${VL[b.variant]||b.variant} × ${qty}</div>
      </div>
      <div class="order-card-right">
        <div class="order-card-right-top">
          <span class="order-card-rev">₹${tot.toFixed(0)}</span>
          <button class="order-card-menu" onclick="openDistributionBatchMenu(${b.id},this)" title="More options">⋯</button>
        </div>
        <span style="font-size:11px;color:var(--text-3)">${fd(b.at||Date.now())}</span>
      </div>
    </div>
    <div class="order-card-meta">
      <span class="pill pn">${commissionModeLabel(b.commissionMode)}</span>
      <span class="pill pn">₹${(parseFloat(b.commission||0)||0).toFixed(2)}</span>
      ${b.status==='completed'
        ? `<span class="status-badge st-completed">Completed</span>`
        : `<button class="status-badge st-confirmed status-clickable" onclick="openCompleteDistributorBatch(${b.id})">Active ▾</button>`}
      ${b.orderId?`<span style="font-size:11px;color:var(--text-3)">Order #${b.orderId}</span>`:''}
    </div>
  </div>`;
}
function rDistribution(){
  const list=(S.distributorBatches||[]);
  renderDistributorSuggestions();
  const prodSel=g('dist-prod');
  if(prodSel){
    const cur=prodSel.value||'';
    prodSel.innerHTML=distProductOptions(cur);
    prodSel.value=cur;
    const variantSel=g('dist-variant');
    if(cur){
      const currentVar=variantSel?.value||'';
      if(variantSel) variantSel.innerHTML=distVariantOptions(cur,currentVar);
    }else if(variantSel && !variantSel.value){
      variantSel.innerHTML='<option value="">Select size…</option>';
    }
  }
  if(g('dist-qty') && !g('dist-qty').value) g('dist-qty').value='1';
  if(g('dist-date') && !g('dist-date').value) g('dist-date').value=todayISO();
  if(g('dist-commission') && !g('dist-commission').value) g('dist-commission').value='0';

  const active=list.filter(b=>b.status==='active');
  const done=list.filter(b=>b.status==='completed');
  const activeQty=active.reduce((s,b)=>s+(parseInt(b.qty||0)||0),0);
  const activeHoldWorth=active.reduce((s,b)=>{
    const qty=parseInt(b.qty||0)||0;
    const unitPrice=getSalePrice(b.prodId,b.variant,'retail');
    return s + (qty*unitPrice);
  },0);
  const doneQty=done.reduce((s,b)=>s+(parseInt(b.qty||0)||0),0);
  const activeDistCount=new Set(active.map(b=>String(b.distributorName||'').trim().toLowerCase()).filter(Boolean)).size;
  const completedCollected=done.reduce((s,b)=>s+(parseFloat(b.amountCollected||0)||0),0);
  if(g('dist-sub')){
    g('dist-sub').textContent=`${list.length} batches · ${active.length} active · ${done.length} completed`;
  }
  if(g('dist-total-active')) g('dist-total-active').textContent=String(active.length);
  if(g('dist-total-completed')) g('dist-total-completed').textContent=String(done.length);
  if(g('dist-total-qty')) g('dist-total-qty').textContent=String(activeQty);
  if(g('dist-hold-worth')) g('dist-hold-worth').textContent=fC(activeHoldWorth);
  if(g('dist-active-meta')) g('dist-active-meta').textContent=`${activeDistCount} distributors · ${activeQty} pcs on hold`;
  if(g('dist-completed-meta')) g('dist-completed-meta').textContent=`${fC(completedCollected)} collected · ${doneQty} pcs closed`;

  const host=g('dist-body');
  if(!host) return;
  if(!list.length){
    host.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">No distributor batches yet</div><div class="es">Create the first batch above and mark it completed once money is collected.</div></div>`;
    return;
  }
  const desktop=`<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Distributor</th><th>Product / Service</th><th>Size</th><th>Qty</th><th>Commission</th><th>Status</th><th>Date</th><th></th></tr></thead>
    <tbody>${list.map(distributionRow).join('')}</tbody>
  </table></div>`;
  const mobile=`<div class="order-card-list">${list.map(distributionMobileCard).join('')}</div>`;
  host.innerHTML=desktop+mobile;
}

function setOperationalExpenseDateDefault(){
  if(g('opx-date') && !g('opx-date').value) g('opx-date').value=todayISO();
}
const DEFAULT_EXPENSE_CATEGORIES=['Logistics','Rent','Utilities','Salary','Packaging','Travel','Maintenance','Marketing','Office','Miscellaneous'];
function operationalExpenseCategories(){
  const seen=new Set();
  const out=[];
  DEFAULT_EXPENSE_CATEGORIES.forEach((label)=>{
    const key=String(label||'').trim().toLowerCase();
    if(!key || seen.has(key)) return;
    seen.add(key);
    out.push(String(label).trim());
  });
  (S?.operationalExpenses||[]).forEach((exp)=>{
    const label=String(exp?.category||'').trim();
    const key=label.toLowerCase();
    if(!label || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  });
  return out.sort((a,b)=>a.localeCompare(b));
}
function renderOperationalExpenseCategoryOptions(selected=''){
  const sel=g('opx-category');
  if(!sel) return;
  const categories=operationalExpenseCategories();
  const current=String(selected||'').trim();
  const hasCurrent=current && categories.some((item)=>item.toLowerCase()===current.toLowerCase());
  const value=hasCurrent ? categories.find((item)=>item.toLowerCase()===current.toLowerCase()) : (current?'__new__':'');
  sel.innerHTML=`<option value="">Select category…</option>${categories.map((item)=>`<option value="${esc(item)}">${esc(item)}</option>`).join('')}<option value="__new__">+ Add new category…</option>`;
  sel.value=value||'';
  const custom=g('opx-category-custom');
  if(custom){
    custom.style.display=sel.value==='__new__'?'block':'none';
    if(sel.value==='__new__') custom.value=current||'';
    else custom.value='';
  }
}
function toggleOperationalExpenseCategoryInput(){
  const sel=g('opx-category');
  const custom=g('opx-category-custom');
  if(!sel||!custom) return;
  const show=sel.value==='__new__';
  custom.style.display=show?'block':'none';
  if(show) setTimeout(()=>custom.focus(),0);
  else custom.value='';
}
function operationalExpenseCategoryValue(){
  const sel=g('opx-category');
  const custom=g('opx-category-custom');
  if(!sel) return '';
  if(sel.value==='__new__') return String(custom?.value||'').trim();
  return String(sel.value||'').trim();
}
function operationalExpenseTimestamp(){
  const raw=g('opx-date')?.value||'';
  if(!raw) return Date.now();
  const [y,m,d]=raw.split('-').map(Number);
  const dt=new Date(y,(m||1)-1,d||1,12,0,0);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : Date.now();
}
function expenseCreatorLabel(exp){
  const by=exp?.createdBy||{};
  return String(by.displayName||by.username||'Local User');
}
function expenseCategoryBadge(category){
  const label=String(category||'').trim();
  return label?`<span class="pill pn">${esc(label)}</span>`:'';
}
function expenseMetaLine(exp){
  const expenseAt=exp.expenseAt||exp.createdAt||Date.now();
  const createdAt=exp.createdAt||expenseAt;
  const sameDay=fd(expenseAt)===fd(createdAt);
  const createdTime=new Date(createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  if(sameDay) return `${fd(expenseAt)} · logged ${createdTime} by ${esc(expenseCreatorLabel(exp))}`;
  return `Expense ${fd(expenseAt)} · logged ${fdt(createdAt)} by ${esc(expenseCreatorLabel(exp))}`;
}
function expenseMonthRange(offset=0){
  const now=new Date();
  const start=new Date(now.getFullYear(), now.getMonth()+offset, 1, 0, 0, 0, 0);
  const end=new Date(now.getFullYear(), now.getMonth()+offset+1, 1, 0, 0, 0, 0);
  return { s:start.getTime(), e:end.getTime() };
}
function rOperationalExpenses(){
  setOperationalExpenseDateDefault();
  renderOperationalExpenseCategoryOptions(operationalExpenseCategoryValue());
  const list=(S.operationalExpenses||[]).slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const canCreateExpense=hasActionAccess('expenses','create');
  const stats=g('opx-stats');
  const body=g('opx-body');
  ['opx-title','opx-category','opx-category-custom','opx-amount','opx-date','opx-notes'].forEach((id)=>{ const el=g(id); if(el) el.disabled=!canCreateExpense; });
  const saveBtn=g('opx-save-btn'); if(saveBtn){ saveBtn.disabled=!canCreateExpense; saveBtn.style.display=canCreateExpense?'':'none'; }
  const month=expenseMonthRange(0);
  const prevMonth=expenseMonthRange(-1);
  const monthTotal=list.filter(e=>(e.expenseAt||e.createdAt||0)>=month.s && (e.expenseAt||e.createdAt||0)<month.e).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const prevTotal=list.filter(e=>(e.expenseAt||e.createdAt||0)>=prevMonth.s && (e.expenseAt||e.createdAt||0)<prevMonth.e).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const topCategories={};
  list.forEach((e)=>{ const key=String(e.category||'Uncategorized').trim()||'Uncategorized'; topCategories[key]=(topCategories[key]||0)+(parseFloat(e.amount)||0); });
  const topCategory=Object.entries(topCategories).sort((a,b)=>b[1]-a[1])[0];
  if(g('opx-sub')) g('opx-sub').textContent=`${list.length} entries · ${fC(monthTotal)} this month`;
  if(stats){
    stats.innerHTML=`
      <div class="sbox accent-top"><div class="sbox-inner"><div class="sbox-half"><div class="sl">This Month</div><div class="sv">${fC(monthTotal)}</div><div class="sn">${list.filter(e=>(e.expenseAt||e.createdAt||0)>=month.s && (e.expenseAt||e.createdAt||0)<month.e).length} entries logged</div></div><div class="sbox-half"><div class="sl">Last Month</div><div class="sv">${fC(prevTotal)}</div><div class="sn">${prevTotal>0?`${(((monthTotal-prevTotal)/prevTotal)*100).toFixed(1)}% vs last month`:'No baseline yet'}</div></div></div></div>
      <div class="sbox"><div class="sbox-inner"><div class="sbox-half"><div class="sl">All Time</div><div class="sv">${fC(list.reduce((s,e)=>s+(parseFloat(e.amount)||0),0))}</div><div class="sn">${list.length} operational expense records</div></div><div class="sbox-half"><div class="sl">Top Category</div><div class="sv" style="font-size:22px">${esc((topCategory&&topCategory[0])||'—')}</div><div class="sn">${topCategory?fC(topCategory[1]):'No category data yet'}</div></div></div></div>
    `;
  }
  if(!body) return;
  if(!list.length){
    body.innerHTML=`<div class="empty"><div class="ei">₹</div><div class="et">No operational expenses yet</div><div class="es">Add the first rent, logistics, utility, or office expense from the form.</div></div>`;
    return;
  }
  body.innerHTML=list.map((exp)=>{
    const amount=parseFloat(exp.amount)||0;
    const notes=String(exp.notes||'').trim();
    return `<div style="padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div style="min-width:0;flex:1">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="font-weight:700">${esc(exp.title||'Expense')}</div>
            ${expenseCategoryBadge(exp.category)}
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">${expenseMetaLine(exp)}</div>
          ${notes?`<div style="font-size:12.5px;color:var(--text);margin-top:8px;line-height:1.45">${esc(notes)}</div>`:''}
        </div>
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:700;white-space:nowrap">₹${amount.toFixed(2)}</div>
      </div>
    </div>`;
  }).join('');
}
async function saveOperationalExpense(){
  if(!hasPageAccess('expenses')){ toast('Expenses access is restricted','err'); return; }
  if(!hasActionAccess('expenses','create')){ toast('Recording expenses is restricted','err'); return; }
  const title=(g('opx-title')?.value||'').trim();
  const category=operationalExpenseCategoryValue();
  const amount=parseFloat(g('opx-amount')?.value||0);
  const notes=(g('opx-notes')?.value||'').trim();
  if(!title){ toast('Enter an expense title','err'); return; }
  if(!Number.isFinite(amount) || amount<=0){ toast('Enter a valid expense amount','err'); return; }
  try{
    const record=await api.post('/api/operational-expenses',{title,category,amount,notes,expenseAt:operationalExpenseTimestamp()});
    S.operationalExpenses=Array.isArray(S.operationalExpenses)?S.operationalExpenses:[];
    S.operationalExpenses.unshift(record);
    S.exid=(parseInt(S.exid,10)||1)+1;
    if(g('opx-title')) g('opx-title').value='';
    if(g('opx-category')) g('opx-category').value='';
    if(g('opx-category-custom')) g('opx-category-custom').value='';
    if(g('opx-amount')) g('opx-amount').value='';
    if(g('opx-notes')) g('opx-notes').value='';
    if(g('opx-date')) g('opx-date').value=todayISO();
    rOperationalExpenses();
    toast('Operational expense recorded','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}

// ─── STOCK ALERTS (from Inventory app on port 8001) ──────────────────────────
let stockAlerts = [];   // populated by pollStockAlerts()
let inventorySnapshot = [];
let inventorySnapshotAt = null;
let inventoryConnected = false;

async function pollStockAlerts(){
  try{
    const data = await getJSONWithTimeout('/api/inventory/stock', 4000);
    inventorySnapshot = Array.isArray(data)?data:[];
    inventoryConnected = true;
    inventorySnapshotAt = Date.now();
    stockAlerts = inventorySnapshot.filter(p=>p.isLow);
    if(g('np-comp-rows')){
      const rows=getCompositionRows();
      renderCompositionRows(rows.length?rows:[{inventoryProductId:'',percentage:100}]);
    }
    updBadge(); // recount badge including stock alerts
  }catch(e){
    // Avoid false "offline" due to transient timeout/network hiccups.
    // Only mark offline if we have never connected successfully.
    if(!inventorySnapshotAt){
      inventoryConnected = false;
      stockAlerts = [];
      inventorySnapshot = [];
      inventorySnapshotAt = null;
    }
  }
}

// ─── ALERTS ──────────────────────────────────────────────────────────────────
function getAlerts(){
  const now=Date.now(),alerts=[],byC={};
  const closedSet=new Set((S.closedFollowUps||[]).map(r=>`${r.cid}:${r.orderId}`));
  S.orders.forEach(o=>(byC[o.cid]=byC[o.cid]||[]).push(o));
  Object.keys(byC).forEach(cid=>{
    const orders=byC[cid].sort((a,b)=>b.at-a.at),last=orders[0];
    const cust=S.customers.find(c=>c.id==cid);if(!cust)return;
    const n=orders.length;let ad,mode,avg=null;
    if(n>=5){const gaps=[];for(let i=0;i<Math.min(n-1,5);i++)gaps.push((orders[i].at-orders[i+1].at)/864e5);avg=Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);ad=Math.round(avg*.9);mode='smart';}
    else{ad=variantCycleDays(last.prodId,last.variant)*last.qty;mode='def';}
    const dl=ad-(now-last.at)/864e5;
    const key=`${cust.id}:${last.id}`;
    if(dl<=3 && !closedSet.has(key))alerts.push({cust,last,dl:Math.round(dl),mode,avg,n});
  });
  return alerts.sort((a,b)=>a.dl-b.dl);
}
function getDistributorAgingAlerts(minDays=15){
  const now=Date.now();
  const dayMs=86400000;
  return (S.distributorBatches||[])
    .filter(b=>String(b.status||'').toLowerCase()==='active')
    .map(b=>{
      const at=Number(b.at)||0;
      const ageDays=at>0?Math.floor((now-at)/dayMs):0;
      return {...b,ageDays};
    })
    .filter(b=>b.ageDays>minDays)
    .sort((a,b)=>b.ageDays-a.ageDays);
}
function rAlerts(){
  const alerts=getAlerts(), distAlerts=getDistributorAgingAlerts(15), body=g('al-body');
  const hasReorder = alerts.length > 0;
  const hasDist    = distAlerts.length > 0;
  const hasStock   = stockAlerts.length > 0;

  if(!hasReorder && !hasStock && !hasDist){
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
          <button class="btn btn-s btn-sm" onclick="nav('dashboard')">View Dashboard →</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── Distribution aging alerts section ──
  if(hasDist){
    html += `<div class="alert-section-header ${hasStock?'mt12':''}">
      <span class="alert-section-title">Distributor Pending</span>
      <span class="alert-section-count">${distAlerts.length}</span>
      <span class="alert-section-badge reorder">Distribution</span>
    </div>`;
    html += distAlerts.map(a=>{
      const started=fd(a.at||Date.now());
      return `<div class="ai sm">
        <div class="adot sm"></div>
        <div class="ab">
          <div class="an">${esc(a.distributorName||'Distributor')} <span style="font-size:12px;color:var(--text-3);font-weight:400">· ${a.ageDays} days pending</span></div>
          <div class="ad">${esc(a.prod||'Item')} · ${VL[a.variant]||a.variant} × ${a.qty||0} pcs · started ${started}</div>
          <div class="at2"><span class="pill pa">Over 15 days</span><span class="pill pn">Distribution aging</span></div>
        </div>
        <div class="aa"><button class="btn btn-s btn-sm" onclick="nav('distribution')">View Batch →</button></div>
      </div>`;
    }).join('');
  }

  // ── Reorder alerts section ──
  if(hasReorder){
    html += `<div class="alert-section-header ${(hasStock||hasDist)?'mt12':''}">
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
      const desc=a.mode==='smart'
        ? `Based on ${a.n} orders — avg every ${a.avg} days. Last: ${esc(a.last.prod)} (${esc(VL[a.last.variant]||a.last.variant)})`
        : `Last: ${esc(a.last.prod)} ${esc(VL[a.last.variant]||a.last.variant)} ×${a.last.qty} on ${fd(a.last.at)}`;
      return`<div class="ai ${cls}"><div class="adot ${cls}"></div><div class="ab"><div class="an">${esc(a.cust.name)} <span style="font-size:12px;color:var(--text-3);font-weight:400">· ${esc(a.cust.area)}</span></div><div class="ad">${desc}</div><div class="at2">${pills}</div></div><div class="aa" style="display:flex;gap:8px;flex-wrap:wrap"><a href="${wa}" target="_blank" class="btn btn-follow-up btn-sm">${WA_ICON} Follow Up</a><button class="btn btn-s btn-sm" onclick="openCloseAlertModal(${a.cust.id},${a.last.id})">Add Note & Close</button></div></div>`;
    }).join('');
  }

  body.innerHTML = html;
}

function openCloseAlertModal(cid,orderId){
  const cust=(S.customers||[]).find(c=>Number(c.id)===Number(cid));
  const custName=String(cust?.name||'Customer');
  openModal(`
    <div class="modal-title">Close Follow-up Alert</div>
    <div style="font-size:12.5px;color:var(--text-3);margin-top:6px">Customer: <strong>${esc(custName||'Customer')}</strong></div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
      <div class="fg">
        <label>Notes <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
        <textarea id="followup-close-note" rows="3" placeholder="e.g. Called customer, asked to follow up next week"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="submitCloseFollowUp(${cid},${orderId})">Save & Close Alert</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `,'lg');
}
async function submitCloseFollowUp(cid,orderId){
  const note=(g('followup-close-note')?.value||'').trim();
  try{
    const res=await api.post('/api/alerts/followups/close',{cid,orderId,note,at:Date.now()});
    S.closedFollowUps=S.closedFollowUps||[];
    S.closedFollowUps=S.closedFollowUps.filter(r=>!(Number(r.cid)===Number(cid)&&Number(r.orderId)===Number(orderId)));
    S.closedFollowUps.push({cid:res.cid,orderId:res.orderId,note:res.note||'',closedAt:res.closedAt||Date.now()});
    closeModal();
    rAlerts();
    rDash();
    updBadge();
    toast('Alert closed','ok');
  }catch(e){
    toast('Error: '+e.message,'err');
  }
}

function rInventory(){
  const body=g('inv-body'); if(!body) return;
  const stat=g('inv-stats');
  const sub=g('inv-sub');
  const updated=g('inv-updated');
  const items=inventorySnapshot||[];
  const low=items.filter(p=>p.isLow);
  const inv=calcInventoryUsageFromOrders();
  const completed=(S.orders||[]).filter(o=>o.status==='completed');
  const synced=completed.filter(o=>o.inventorySynced).length;
  const syncPct=completed.length?((synced/completed.length)*100):0;
  sub.textContent=inventoryConnected?`${items.length} products synced from inventory app`:'Inventory service not connected';
  if(updated) updated.textContent=inventorySnapshotAt?`Last sync: ${new Date(inventorySnapshotAt).toLocaleString('en-IN')}`:'Last sync: —';
  if(stat){
    stat.innerHTML=`
      <div class="sbox accent-top"><div class="sbox-inner"><div class="sbox-half"><div class="sl">Tracked</div><div class="sv">${items.length}</div><div class="sn">Inventory products</div></div><div class="sbox-half"><div class="sl">Low Stock</div><div class="sv ${low.length?'red':''}">${low.length}</div><div class="sn">${low.length?'Needs restock':'Healthy levels'}</div></div></div></div>
      <div class="sbox accent-top"><div class="sbox-inner"><div class="sbox-half"><div class="sl">Inventory Moved</div><div class="sv">${fGrams(inv.moved)}</div><div class="sn">${inv.connected?inventorySplitText(inv):'Inventory app offline'}</div></div><div class="sbox-half"><div class="sl">Completed Synced</div><div class="sv">${synced}/${completed.length}</div><div class="sn">${completed.length?`${syncPct.toFixed(0)}% synced to inventory`:'No completed orders yet'}</div></div></div></div>`;
  }
  if(!inventoryConnected){
    body.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">Inventory app is not reachable</div><div class="es">Run the inventory service to view stock inside CRM.</div></div>`;
    return;
  }
  if(!items.length){
    body.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">No inventory products found</div><div class="es">Inventory is connected. Add products in the Inventory app to track stock here.</div></div>`;
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
  const ids=['inv-sync-btn','dash-inv-sync-btn'];
  ids.forEach(id=>{
    const btn=g(id); if(!btn) return;
    if(on){
      btn.disabled=true;
      btn.classList.add('is-loading');
    }else{
      btn.disabled=false;
      btn.classList.remove('is-loading');
    }
  });
}
async function syncCompletedOrdersToInventory(){
  try{
    const res=await postJSONWithTimeout('/api/inventory/sync-completed-orders',{},45000);
    await fetchFullData();
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
    await fetchFullData();
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
  const n = getAlerts().length + getDistributorAgingAlerts(15).length + stockAlerts.length;
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
  const position=calcInventoryPosition();
  return { moved, left:position.total, inStock:position.inStock, onHold:position.onHold, connected:inventoryConnected };
}
function calcInventoryUsageFromOrdersForProduct(inventoryProductId){
  const targetPid=String(inventoryProductId||'').trim();
  if(!targetPid) return calcInventoryUsageFromOrders();
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
      if(String(c.inventoryProductId||'')!==targetPid) return;
      const pct=parseFloat(c.percentage||0)||0;
      if(pct>0) moved += total*(pct/100);
    });
  });
  const position=calcInventoryPosition(targetPid);
  return { moved, left:position.total, inStock:position.inStock, onHold:position.onHold, connected:inventoryConnected };
}
function activeDistributorBatches(){
  return (S.distributorBatches||[]).filter(b=>String(b.status||'').toLowerCase()==='active');
}
function inventoryMovementForBatch(batch, inventoryProductId=''){
  if(!batch) return 0;
  const prod=(S.products||[]).find(p=>p.id===batch.prodId);
  const comp=(prod&&Array.isArray(prod.composition))?prod.composition:[];
  if(!comp.length) return 0;
  const pack=variantToGrams(batch.variant);
  const qty=parseFloat(batch.qty||0)||0;
  if(pack<=0||qty<=0) return 0;
  const total=pack*qty;
  if(!inventoryProductId){
    return comp.reduce((sum,c)=>{
      const pct=parseFloat(c.percentage||0)||0;
      return pct>0 ? sum+(total*(pct/100)) : sum;
    },0);
  }
  const row=comp.find(c=>String(c.inventoryProductId||'')===String(inventoryProductId||''));
  if(!row) return 0;
  const pct=parseFloat(row.percentage||0)||0;
  return pct>0 ? total*(pct/100) : 0;
}
function calcInventoryPosition(inventoryProductId=''){
  const targetPid=String(inventoryProductId||'').trim();
  const visibleItems=visibleInventorySnapshot();
  let total=0;
  if(targetPid){
    const item=visibleItems.find(p=>String(p.id||'')===targetPid);
    total=parseFloat(item?.stockGrams||0)||0;
  }else{
    total=visibleItems.reduce((s,p)=>s+(parseFloat(p.stockGrams)||0),0);
  }
  const onHold=activeDistributorBatches().reduce((sum,b)=>sum+inventoryMovementForBatch(b,targetPid),0);
  const inStock=Math.max(0,total-onHold);
  return { total, inStock, onHold };
}
function inventorySplitText(position){
  return `In stock: ${fGrams(position.inStock)} · On hold: ${fGrams(position.onHold)}`;
}
function dashboardHalfByLabel(label){
  return Array.from(document.querySelectorAll('#sg .sbox-half, #sg2 .sbox-half')).find((el)=>el.querySelector('.sl')?.textContent?.trim()===label) || null;
}
function applyDashboardCardVisibility(){
  const map=[
    ['Revenue','revenue'],
    ['Profit','profit'],
    ['MoM Change','momChange'],
    ['Analytics','analytics'],
    ['Avg Order Value','avgOrderValue'],
    ['Inventory Moved','inventoryMoved'],
    ['Customers','customers'],
    ['Alerts','alerts'],
  ];
  map.forEach(([label,key])=>{
    const half=dashboardHalfByLabel(label);
    if(half) half.style.display=hasDashboardCard(key)?'':'none';
  });
  document.querySelectorAll('#sg .sbox, #sg2 .sbox').forEach((box)=>{
    const visibleHalves=Array.from(box.querySelectorAll('.sbox-half')).filter((half)=>half.style.display!=='none');
    box.style.display=visibleHalves.length?'':'none';
  });
}

const DASH_INV_ANALYTICS_KEY='kudagu_dash_inv_pid_v1';
let DASH_INV_ANALYTICS_PID='';
const DASH_INV_MOVED_KEY='kudagu_dash_moved_pid_v1';
let DASH_INV_MOVED_PID='';
let DASH_INV_MOVED_LOADED=false;
function loadDashInventoryPid(){
  try{
    DASH_INV_ANALYTICS_PID=String(localStorage.getItem(DASH_INV_ANALYTICS_KEY)||'').trim();
  }catch(_){ DASH_INV_ANALYTICS_PID=''; }
}
function saveDashInventoryPid(pid){
  DASH_INV_ANALYTICS_PID=String(pid||'').trim();
  try{ localStorage.setItem(DASH_INV_ANALYTICS_KEY,DASH_INV_ANALYTICS_PID); }catch(_){}
}
function defaultDashInventoryPid(){
  const items=visibleInventorySnapshot();
  if(!items.length) return '';
  if(DASH_INV_ANALYTICS_PID && items.some(p=>String(p.id)===String(DASH_INV_ANALYTICS_PID))) return DASH_INV_ANALYTICS_PID;
  const coffee=items.find(p=>/coffee/i.test(String(p.name||'')));
  return String((coffee||items[0]).id||'');
}
function loadDashInventoryMovedPid(){
  if(DASH_INV_MOVED_LOADED) return;
  DASH_INV_MOVED_LOADED=true;
  try{
    DASH_INV_MOVED_PID=String(localStorage.getItem(DASH_INV_MOVED_KEY)||'').trim();
  }catch(_){ DASH_INV_MOVED_PID=''; }
}
function saveDashInventoryMovedPid(pid){
  DASH_INV_MOVED_PID=String(pid||'').trim();
  try{ localStorage.setItem(DASH_INV_MOVED_KEY,DASH_INV_MOVED_PID); }catch(_){}
}
function defaultDashInventoryMovedPid(){
  const items=visibleInventorySnapshot();
  if(!items.length) return '';
  if(!DASH_INV_MOVED_PID) return '';
  if(items.some(p=>String(p.id)===String(DASH_INV_MOVED_PID))) return DASH_INV_MOVED_PID;
  return '';
}
function inventoryMovementForProduct(order, inventoryProductId){
  const prod=(S.products||[]).find(p=>p.id===order.prodId);
  const comp=(prod&&Array.isArray(prod.composition))?prod.composition:[];
  if(!comp.length) return 0;
  const row=comp.find(c=>String(c.inventoryProductId||'')===String(inventoryProductId||''));
  if(!row) return 0;
  const pct=parseFloat(row.percentage||0)||0;
  if(pct<=0) return 0;
  const pack=variantToGrams(order.variant);
  const qty=parseFloat(order.qty||0)||0;
  if(pack<=0||qty<=0) return 0;
  return pack*qty*(pct/100);
}
function calcInventoryAnalyticsForProduct(inventoryProductId){
  const pid=String(inventoryProductId||'').trim();
  const item=visibleInventorySnapshot().find(p=>String(p.id||'')===pid) || null;
  const stockGrams=Number(item?.stockGrams||0)||0;
  const now=Date.now();
  const dayMs=86400000;
  const completed=(S.orders||[]).filter(o=>String(o.status||'')==='completed');
  const dayBuckets=new Map();
  let used30=0, firstAt=0;
  completed.forEach(o=>{
    const grams=inventoryMovementForProduct(o,pid);
    if(grams<=0) return;
    const at=Number(o.at||0)||0;
    if(at<=0) return;
    if(!firstAt || at<firstAt) firstAt=at;
    const dayStart=new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()).getTime();
    dayBuckets.set(dayStart, (dayBuckets.get(dayStart)||0) + grams);
  });

  const todayStart=new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  for(let i=29;i>=0;i--){
    const day=todayStart-(i*dayMs);
    used30 += dayBuckets.get(day)||0;
  }

  const dailyAvg30=used30/30;
  const monthly=dailyAvg30*30;
  const activeDays30=Array.from(dayBuckets.entries()).filter(([day,total])=>day>=todayStart-(29*dayMs) && total>0).length;
  const historyDays=firstAt>0 ? Math.max(1, Math.floor((todayStart-firstAt)/dayMs)+1) : 0;
  const coverageDays=Math.min(30, historyDays||0);
  const basis=coverageDays>0 ? `30d moving avg (${coverageDays}/30 days history)` : '30d moving avg (no usage yet)';
  const daysLeft=(dailyAvg30>0 && stockGrams>0)?Math.floor(stockGrams/dailyAvg30):null;
  const runoutDate=daysLeft==null?null:new Date(now+daysLeft*86400000);
  let confidenceLabel='Low';
  let confidenceClass='pn';
  if(coverageDays>=30 && activeDays30>=8){
    confidenceLabel='High';
    confidenceClass='pg';
  }else if(coverageDays>=14 && activeDays30>=4){
    confidenceLabel='Medium';
    confidenceClass='pa';
  }else if(coverageDays===0 || used30<=0){
    confidenceLabel='Low';
    confidenceClass='pn';
  }
  return { item, stockGrams, monthly, dailyAvg30, used30, activeDays30, coverageDays, basis, daysLeft, runoutDate, confidenceLabel, confidenceClass };
}
function setDashInventoryProduct(pid){
  saveDashInventoryPid(pid);
  rDash();
}
function setDashInventoryMovedProduct(pid){
  saveDashInventoryMovedPid(pid);
  rDash();
}
function showInventoryAnalyticsInfo(){
  openModal(`
    <div class="modal-title">Analytics Card Logic</div>
    <div style="margin-top:10px;color:var(--text-2);font-size:13px;line-height:1.45">
      <div><strong>30d Moving Average</strong></div>
      <div style="margin-top:6px">Monthly usage = total usage in last 30 days (shown as kg/month).</div>
      <div style="margin-top:4px">Runout = current stock / average daily usage in those 30 days.</div>
      <div style="margin-top:10px"><strong>Confidence</strong></div>
      <div style="margin-top:6px">High: at least 30 days history and 8+ active usage days.</div>
      <div>Medium: at least 14 days history and 4+ active usage days.</div>
      <div>Low: insufficient recent history/usage.</div>
      <div style="margin-top:10px">Usage is computed from completed orders and product composition mapping.</div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-p" onclick="closeModal()">OK</button>
    </div>
  `);
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function rDash(){
  const alerts=getAlerts();
  const distAlerts=getDistributorAgingAlerts(15);
  const allOpsAlerts=alerts.length+distAlerts.length;
  const visibleInventory=visibleInventorySnapshot();
  g('dd').textContent=new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const f=calcFin();
  const inv=calcInventoryUsageFromOrders();
  if(!DASH_INV_ANALYTICS_PID) loadDashInventoryPid();
  loadDashInventoryMovedPid();
  const selectedPid=defaultDashInventoryPid();
  const selectedMovedPid=defaultDashInventoryMovedPid();
  if(selectedPid && selectedPid!==DASH_INV_ANALYTICS_PID) saveDashInventoryPid(selectedPid);
  if(selectedMovedPid!==DASH_INV_MOVED_PID) saveDashInventoryMovedPid(selectedMovedPid);
  const invAnalytics=calcInventoryAnalyticsForProduct(selectedPid);
  const invOpts=visibleInventory.map(p=>`<option value="${esc(p.id)}" ${String(p.id)===String(selectedPid)?'selected':''}>${esc(p.name||p.id)}</option>`).join('');
  const invMoved=calcInventoryUsageFromOrdersForProduct(selectedMovedPid);
  const invMovedOpts=[
    `<option value="" ${!selectedMovedPid?'selected':''}>Total</option>`,
    ...visibleInventory.map(p=>`<option value="${esc(p.id)}" ${String(p.id)===String(selectedMovedPid)?'selected':''}>${esc(p.name||p.id)}</option>`)
  ].join('');
  const monthlyTxt=invAnalytics.monthly>0?fGrams(invAnalytics.monthly)+'/month':'0 g/month';
  const basisShort = invAnalytics.coverageDays>0
    ? '30d MA'
    : '30d MA · no usage yet';
  const runoutTxt=invAnalytics.daysLeft==null
    ? 'Runout: n/a'
    : invAnalytics.daysLeft<=0
      ? 'Runout: now'
      : `Runout ~${invAnalytics.daysLeft}d · ${invAnalytics.runoutDate.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}`;
  const confidencePill=`<span class="pill ${invAnalytics.confidenceClass}" style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:600;padding:0 6px;height:20px;line-height:1;white-space:nowrap;margin-right:8px">${invAnalytics.confidenceLabel}<button class="btn btn-g btn-xs" type="button" onclick="showInventoryAnalyticsInfo()" title="How this works" style="min-width:12px;height:12px;padding:0 3px;border-radius:999px;line-height:1;font-size:9px">i</button></span>`;
  const hasBoot=!FULL_DATA_READY && !!DASH_BOOTSTRAP_METRICS;
  const hasData=hasBoot ? ((Number(f.revAll)||0)>0 || (Number(f.revM)||0)>0) : S.orders.some(o=>isCompleted(o)&&orderRevenue(o)>0);
  const completedOrders=S.orders.filter(isCompleted);
  const completedCount=hasBoot ? (Number(f.completedOrders)||0) : completedOrders.length;
  const totalCustomers=hasBoot ? (Number(f.totalCustomers)||0) : S.customers.length;
  const totalOrders=hasBoot ? (Number(f.totalOrders)||0) : S.orders.length;
  const ordersPerCustomer=hasBoot ? (Number(f.ordersPerCustomer)||0) : (totalCustomers>0?(totalOrders/totalCustomers):0);
  const orderCountByCid={};
  (S.orders||[]).forEach(o=>{
    if(!o||!o.cid||o.cid<=0) return;
    orderCountByCid[o.cid]=(orderCountByCid[o.cid]||0)+1;
  });
  const orderedCustomers=Object.keys(orderCountByCid).length;
  const repeatCustomers=Object.values(orderCountByCid).filter(n=>n>=2).length;
  const retentionPct=hasBoot ? f.retentionPct : (orderedCustomers>0?(repeatCustomers/orderedCustomers)*100:null);

  // Row 1: Revenue + Profit | MoM + Inventory analytics
  g('sg').innerHTML=`
    <div class="sbox ${!hasData?'accent-top':f.profAll>=0?'green-top':'red-top'}">
      <div class="sbox-inner">
        <div class="sbox-half">
          <div class="sl">Revenue</div>
          <div class="sv">${hasData?fC(f.revAll):'—'}</div>
          <div class="sn">${hasData?'This month: '+fC(f.revM):'Add pricing in Settings'}</div>
        </div>
        <div class="sbox-half">
          <div class="sl">Profit</div>
          <div class="sv ${!hasData?'':f.profAll>=0?'green':'red'}">${hasData?fC(f.profAll):'—'}</div>
          <div class="sn">${hasData?'This month: '+fC(f.profM):'—'}</div>
        </div>
      </div>
    </div>
    <div class="sbox ${f.mom==null?'accent-top':(f.mom<0)?'red-top':'green-top'}">
      <div class="sbox-inner">
        <div class="sbox-half" style="flex:0.7">
          <div class="sl">MoM Change</div>
          <div class="sv ${f.mom==null?'':f.mom>=0?'green':'red'}">${f.mom==null?'—':fPct(f.mom)+pArr(f.mom)}</div>
          <div class="sn ${pCls(f.mom)}">${f.mom==null?'Not enough data':'This month: '+fC(f.revM)}</div>
        </div>
        <div class="sbox-half" style="flex:1.3">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;flex:1 1 auto">
              <div class="sl">Analytics</div>
              ${confidencePill}
            </div>
            <select onchange="setDashInventoryProduct(this.value)" style="width:108px;max-width:108px;padding:4px 22px 4px 8px;font-size:12px;line-height:1.1;flex:0 0 auto">
              ${invOpts||'<option value="">No stock data</option>'}
            </select>
          </div>
          <div class="sv">${monthlyTxt}</div>
          <div class="sn" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2">${basisShort} · ${runoutTxt}</div>
        </div>
      </div>
    </div>`;

  // Row 2: Avg Order Value + Inventory Moved | Customers + Alerts
  g('sg2').innerHTML=`
    <div class="sbox accent-top">
      <div class="sbox-inner">
        <div class="sbox-half" style="flex:0.7;padding:16px 20px 12px">
          <div class="sl">Avg Order Value</div>
          <div class="sv">${hasData&&completedCount>0?fC(f.revAll/completedCount):'—'}</div>
          <div class="sn" style="font-size:13px;line-height:1.35">${hasData?'Per completed order':'—'}</div>
        </div>
        <div class="sbox-half" style="flex:1.3;padding:16px 20px 12px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto">
              <div class="sl" style="white-space:normal;line-height:1.1">Inventory Moved</div>
              <button class="btn btn-g btn-xs" id="dash-inv-sync-btn" onclick="syncAndRefreshInventory()" title="Sync & Refresh Inventory" aria-label="Sync and refresh inventory" style="width:24px;height:24px;min-height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;box-shadow:none;color:var(--text-3);font-size:16px;line-height:1;flex:0 0 auto;margin-top:-2px"><span>⟳</span></button>
            </div>
            <select onchange="setDashInventoryMovedProduct(this.value)" style="width:88px;max-width:88px;padding:4px 22px 4px 8px;font-size:12px;line-height:1.1;flex:0 0 auto">
              ${invMovedOpts||'<option value="">Total</option>'}
            </select>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px">
            <div class="sv" style="margin-top:0">${fGrams(invMoved.moved)}</div>
          </div>
          <div class="sn" style="font-size:13px;line-height:1.35">${invMoved.connected?inventorySplitText(invMoved):'Inventory app offline'}</div>
        </div>
      </div>
    </div>
    <div class="sbox ${allOpsAlerts?'red-top':'accent-top'}">
      <div class="sbox-inner">
        <div class="sbox-half" style="padding:16px 20px 12px">
          <div class="sl">Customers</div>
          <div class="sv">${totalCustomers}</div>
          <div class="sn" style="font-size:13px;line-height:1.35">
            ${totalCustomers>0?`${ordersPerCustomer.toFixed(2)} orders/customer`:'No customers yet'}
            ${retentionPct==null?'':' · '+retentionPct.toFixed(0)+'% retention'}
          </div>
        </div>
        <div class="sbox-half" style="padding:16px 20px 12px">
          <div class="sl">Alerts</div>
          <div class="sv ${allOpsAlerts?'red':''}">${allOpsAlerts}</div>
          <div class="sn" style="font-size:13px;line-height:1.35">${allOpsAlerts?'Need attention':'All on track'}</div>
        </div>
      </div>
    </div>`;

  // Recent orders — clean design-system rows
  const dO=g('d-orders');
  const recent=S.orders.slice(0,6);
  dO.innerHTML=recent.length?recent.map(o=>{
    const rev=orderRevenue(o),opts=statusOpts(o.channel||'retail');
    const nameLabel=isDistributorOrder(o)?'Distributor Channel':o.cname;
    const stCls=STATUS_CLS[o.status||'pending'];
    const stLbl=STATUS_LABEL[o.status]||o.status;
    const stSelect=`<select class="inline-status-sel ${stCls}" onchange="dashQuickStatus(${o.id},this)">${opts.map(s=>`<option value="${esc(s.id)}" ${o.status===s.id?'selected':''}>${esc(s.label)}</option>`).join('')}</select>`;
    return`<div class="dash-order-row">
      <div class="dash-order-info">
        <div class="dor-name">${esc(nameLabel)}</div>
        <div class="dor-prod">${esc(o.prod)} · ${esc(VL[o.variant]||o.variant)} · <span class="ch-badge ch-badge--${esc(o.channel||'retail')}" style="padding:1px 6px;font-size:10.5px">${esc(CHANNEL_MAP[o.channel||'retail']?.label||o.channel)}</span></div>
      </div>
      <div class="dash-order-meta">
        ${isCompleted(o)&&rev>0?`<span style="font-size:12px;font-weight:700;color:var(--green)">₹${rev.toFixed(0)}</span>`:`<span style="font-size:11.5px;color:var(--text-3)">${fd(o.at)}</span>`}
        ${stSelect}
      </div>
    </div>`;
  }).join(''):`<div class="empty" style="padding:28px 18px"><div class="ei">📋</div><div class="et">No orders yet</div></div>`;

  // Alerts panel
  const dA=g('d-al');
  const totalAlerts=alerts.length+stockAlerts.length+distAlerts.length;
  g('d-ab').innerHTML=totalAlerts?`<span class="pill pr" style="font-size:10px;padding:1px 7px">${totalAlerts}</span>`:'';
  const dashAlertRows=[];
  alerts.forEach(a=>dashAlertRows.push({type:'reorder',data:a}));
  stockAlerts.forEach(s=>dashAlertRows.push({type:'stock',data:s}));
  distAlerts.forEach(d=>dashAlertRows.push({type:'dist',data:d}));

  dA.innerHTML=dashAlertRows.length?dashAlertRows.slice(0,6).map(item=>{
    if(item.type==='reorder'){
      const a=item.data;
      const ov=a.dl<=0,wa=buildWaUrl(a);
      return`<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)"><div class="adot ${a.mode==='smart'?'sm':ov?'ov':'ds'}" style="flex-shrink:0"></div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${esc(a.cust.name)} <span class="pill pn" style="margin-left:6px">Re-order</span></div><div style="font-size:11.5px;color:var(--text-3)">${esc(a.last.prod)} · ${esc(VL[a.last.variant]||a.last.variant)}</div><div style="margin-top:5px">${ov?`<span class="pill pr">${Math.abs(a.dl)}d overdue</span>`:`<span class="pill pa">Due in ${a.dl}d</span>`}</div></div><a href="${wa}" target="_blank" class="btn btn-follow-up btn-xs" style="flex-shrink:0">${WA_ICON} Remind</a></div>`;
    }
    if(item.type==='stock'){
      const s=item.data;
      const isCrit=(Number(s.stockGrams)||0)<=Number(s.lowStockThreshold||0)*0.5;
      return`<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)"><div class="adot ${isCrit?'ov':'ds'}" style="flex-shrink:0"></div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${esc(s.name)} <span class="pill pn" style="margin-left:6px">Stock</span></div><div style="font-size:11.5px;color:var(--text-3)">${fGrams(Number(s.stockGrams)||0)} left · threshold ${fGrams(Number(s.lowStockThreshold)||0)}</div><div style="margin-top:5px">${isCrit?`<span class="pill pr">Critical stock</span>`:`<span class="pill pa">Low stock</span>`}</div></div><button class="btn btn-s btn-xs" style="flex-shrink:0" onclick="nav('dashboard')">View</button></div>`;
    }
    const d=item.data;
    return`<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)"><div class="adot sm" style="flex-shrink:0"></div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${esc(d.distributorName||'Distributor')} <span class="pill pn" style="margin-left:6px">Distribution</span></div><div style="font-size:11.5px;color:var(--text-3)">${esc(d.prod||'Item')} · ${VL[d.variant]||d.variant} · ${d.qty||0} pcs</div><div style="margin-top:5px"><span class="pill pa">${d.ageDays} days pending</span></div></div><button class="btn btn-s btn-xs" style="flex-shrink:0" onclick="nav('distribution')">View</button></div>`;
  }).join(''):`<div class="empty" style="padding:28px 18px"><div class="ei">✓</div><div class="et">All alerts clear</div></div>`;
  applyDashboardCardVisibility();
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
function ensureUserManagementUi(){
  const menu=document.querySelector('.settings-menu');
  if(menu && !document.querySelector('.smenu-item[data-panel="users"]')){
    const btn=document.createElement('button');
    btn.className='smenu-item';
    btn.dataset.panel='users';
    btn.textContent='Users';
    btn.setAttribute('onclick',"sPanel('users')");
    menu.appendChild(btn);
  }
  const panelHost=document.querySelector('#view-settings .settings-layout > div:last-child');
  if(panelHost && !g('sp-users')){
    const panel=document.createElement('div');
    panel.className='settings-panel';
    panel.id='sp-users';
    panel.innerHTML='<div class="card"><div class="ch"><div class="ct">User Management</div></div><div class="cb" id="users-settings-body"></div></div>';
    panelHost.appendChild(panel);
  }
}
async function rUsersSettings(){
  const body=g('users-settings-body');
  if(!body) return;
  if(!FEATURE_CONFIG.usernamePasswordAuthEnabled){
    body.innerHTML='<div style="font-size:12.5px;color:var(--text-3)">Enable username/password auth in <code>app_config.py</code> to use user management.</div>';
    return;
  }
  if(!hasActionAccess('users','manage')){
    body.innerHTML='<div style="font-size:12.5px;color:var(--text-3)">Only admins can manage users.</div>';
    return;
  }
  body.innerHTML='<div style="font-size:12.5px;color:var(--text-3)">Loading users…</div>';
  try{
    const res=await api.get('/api/users');
    const users=Array.isArray(res?.users)?res.users:[];
    const productOptions=(S?.products||[]).map((p)=>`<label class="user-check-item"><input type="checkbox" class="user-scope-product" value="${esc(p.id)}"><span>${esc(p.name)}</span></label>`).join('');
    body.innerHTML=`
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="fg">
          <label>Existing Users</label>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${users.length?users.map((u)=>`
              <div style="border:1px solid var(--border);border-radius:12px;padding:14px">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                  <div>
                    <div style="font-weight:700">${esc(u.displayName||u.username)} <span class="pill pn" style="margin-left:6px">${esc(u.role||'admin')}</span></div>
                    <div style="font-size:12px;color:var(--text-3);margin-top:3px">@${esc(u.username)}</div>
                    ${u.allowedProductIds?.length?`<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Products: ${u.allowedProductIds.map(pid=>esc((S.products.find(p=>p.id===pid)||{}).name||pid)).join(', ')}</div>`:'<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Product scope: all products</div>'}
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                    <button class="btn btn-s btn-xs" onclick="openEditUser(${u.id})">Edit</button>
                    <button class="btn btn-s btn-xs" onclick="openResetUserPassword(${u.id})">Password</button>
                    <button class="btn btn-danger btn-xs" onclick="deleteUserAccount(${u.id})">Delete</button>
                  </div>
                </div>
              </div>`).join(''):'<div style="font-size:12.5px;color:var(--text-3)">No users yet.</div>'}
          </div>
        </div>
        <div class="fg">
          <label>Create User</label>
          <div class="fr">
            <div class="fg"><label>Display Name</label><input id="new-user-display" type="text" placeholder="e.g. Partner One"></div>
            <div class="fg"><label>Username</label><input id="new-user-username" type="text" placeholder="e.g. partner1"></div>
          </div>
          <div class="fr">
            <div class="fg"><label>Password</label><input id="new-user-password" type="password" placeholder="Minimum 8 characters"></div>
            <div class="fg"><label>Role</label><select id="new-user-role" onchange="toggleNewUserScope()"><option value="admin">Admin</option><option value="partner">Partner</option><option value="employee">Employee</option></select></div>
          </div>
          <div id="new-user-scope" style="display:none;border:1px solid var(--border);border-radius:12px;padding:12px">
            <div style="font-size:12px;font-weight:700;margin-bottom:8px">Allowed Products</div>
            <div class="user-check-grid">${productOptions||'<div style="font-size:12px;color:var(--text-3)">No products configured yet.</div>'}</div>
          </div>
          <button class="btn btn-p" onclick="createUserAccount()">Create User</button>
        </div>
      </div>`;
    toggleNewUserScope();
  }catch(e){
    body.innerHTML=`<div style="font-size:12.5px;color:var(--red)">Could not load users: ${esc(e.message)}</div>`;
  }
}
const USER_PAGE_LABELS={dashboard:'Dashboard',sales:'Record Sale',orders:'Orders',alerts:'Alerts',marketing:'Marketing',distribution:'Distribution',expenses:'Expenses',customers:'Customers',settings:'Settings'};
const USER_CARD_LABELS={revenue:'Revenue',profit:'Profit',momChange:'MoM Change',analytics:'Analytics',avgOrderValue:'Avg Order Value',inventoryMoved:'Inventory Moved',customers:'Customers',alerts:'Alerts'};
const USER_ACTION_LABELS={
  customers:{create:'Create customers',edit:'Edit customers',delete:'Delete customers'},
  orders:{create:'Create orders',edit:'Edit orders',delete:'Delete orders'},
  distribution:{create:'Create batches',edit:'Edit batches',delete:'Delete batches',complete:'Complete batches'},
  expenses:{create:'Record expenses'},
  products:{create:'Create products',edit:'Edit products',delete:'Delete products'},
  settings:{view:'View settings',manage:'Manage settings'},
  marketing:{view:'View marketing',generate:'Generate AI marketing'},
  shipping:{labels:'Shipping labels'},
  inventory:{sync:'Inventory sync'},
  users:{manage:'Manage users'},
};
function normalizePermissionState(role, perms){
  if(role==='admin' || !roleModelEnabled()) return { pages:{}, dashboardCards:{}, actions:{} };
  return perms||{ pages:{}, dashboardCards:{}, actions:{} };
}
function productScopeCheckboxes(selected=[]){
  const picked=new Set(selected||[]);
  return (S.products||[]).map((p)=>`<label class="user-check-item"><input type="checkbox" class="user-scope-product" value="${esc(p.id)}" ${picked.has(p.id)?'checked':''}><span>${esc(p.name)}</span></label>`).join('');
}
function permissionCheckboxGrid(map, values, section, group){
  return `<div class="user-check-grid">${Object.entries(map).map(([key,label])=>`<label class="user-check-item"><input type="checkbox" data-perm-group="${group}" data-perm-section="${section||''}" value="${esc(key)}" ${values?.[key]?'checked':''}><span>${esc(label)}</span></label>`).join('')}</div>`;
}
function buildUserPermissionEditor(role, perms={}, products=[]){
  if(role==='admin' || !roleModelEnabled()){
    return '<div style="font-size:12px;color:var(--text-3)">Admins always have full access.</div>';
  }
  const state=normalizePermissionState(role, perms);
  return `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px">Allowed Products</div>
        <div class="user-check-grid">${productScopeCheckboxes(products)}</div>
      </div>
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px">Pages</div>
        ${permissionCheckboxGrid(USER_PAGE_LABELS,state.pages,'','pages')}
      </div>
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px">Dashboard Cards</div>
        ${permissionCheckboxGrid(USER_CARD_LABELS,state.dashboardCards,'','cards')}
      </div>
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px">Actions</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${Object.entries(USER_ACTION_LABELS).map(([section,map])=>`<div><div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">${esc(section)}</div>${permissionCheckboxGrid(map,state.actions?.[section],section,'actions')}</div>`).join('')}
        </div>
      </div>
    </div>`;
}
function collectPermissionPayload(role, root=document){
  if(role==='admin' || !roleModelEnabled()) return { allowedProductIds:[], permissions:{} };
  const allowedProductIds=Array.from(root.querySelectorAll('.user-scope-product:checked')).map((el)=>el.value);
  const pages={}, dashboardCards={}, actions={};
  root.querySelectorAll('[data-perm-group="pages"]').forEach((el)=>{ pages[el.value]=!!el.checked; });
  root.querySelectorAll('[data-perm-group="cards"]').forEach((el)=>{ dashboardCards[el.value]=!!el.checked; });
  root.querySelectorAll('[data-perm-group="actions"]').forEach((el)=>{
    const section=el.getAttribute('data-perm-section')||'';
    if(!actions[section]) actions[section]={};
    actions[section][el.value]=!!el.checked;
  });
  return { allowedProductIds, permissions:{ pages, dashboardCards, actions } };
}
function toggleNewUserScope(){
  const role=g('new-user-role')?.value||'admin';
  const wrap=g('new-user-scope');
  if(wrap) wrap.style.display=(role!=='admin' && roleModelEnabled())?'block':'none';
}
async function createUserAccount(){
  const role=g('new-user-role')?.value||'admin';
  const scopeRoot=g('users-settings-body')||document;
  const payload={
    displayName:g('new-user-display')?.value?.trim()||'',
    username:g('new-user-username')?.value?.trim()||'',
    password:g('new-user-password')?.value||'',
    role,
    ...collectPermissionPayload(role, scopeRoot),
  };
  try{
    await api.post('/api/users',payload);
    toast('User created','ok');
    rUsersSettings();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
async function openEditUser(userId){
  let user=null;
  try{
    const res=await api.get('/api/users');
    user=(res.users||[]).find((u)=>Number(u.id)===Number(userId));
  }catch(e){ toast('Error: '+e.message,'err'); return; }
  if(!user) return;
  openModal(`
    <div class="modal-title">Edit User</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:16px">
      <div class="fr">
        <div class="fg"><label>Display Name</label><input id="edit-user-display" type="text" value="${esc(user.displayName||'')}"></div>
        <div class="fg"><label>Username</label><input id="edit-user-username" type="text" value="${esc(user.username||'')}"></div>
      </div>
      <div class="fg"><label>Role</label><select id="edit-user-role" onchange="refreshEditUserPermissions()"><option value="admin" ${user.role==='admin'?'selected':''}>Admin</option><option value="partner" ${user.role==='partner'?'selected':''}>Partner</option><option value="employee" ${user.role==='employee'?'selected':''}>Employee</option></select></div>
      <div id="edit-user-perms"></div>
      <div style="display:flex;gap:8px"><button class="btn btn-p" style="flex:1" onclick="saveUserAccount(${user.id})">Save Changes</button><button class="btn btn-s" onclick="closeModal()">Cancel</button></div>
    </div>`,'lg');
  window.__editingUser=user;
  refreshEditUserPermissions();
}
function refreshEditUserPermissions(){
  const user=window.__editingUser;
  if(!user) return;
  const role=g('edit-user-role')?.value||user.role||'admin';
  const host=g('edit-user-perms');
  if(!host) return;
  host.innerHTML=buildUserPermissionEditor(role,user.permissions,user.allowedProductIds||[]);
}
async function saveUserAccount(userId){
  const role=g('edit-user-role')?.value||'admin';
  const scopeRoot=g('modal-box')||document;
  const payload={
    displayName:g('edit-user-display')?.value?.trim()||'',
    username:g('edit-user-username')?.value?.trim()||'',
    role,
    ...collectPermissionPayload(role, scopeRoot),
  };
  try{
    await api.put(`/api/users/${userId}`,payload);
    closeModal();
    toast('User updated','ok');
    rUsersSettings();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
function openResetUserPassword(userId){
  openModal(`
    <div class="modal-title">Change Password</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:16px">
      <div class="fg"><label>New Password</label><input id="reset-user-password" type="password" placeholder="Minimum 8 characters"></div>
      <div style="display:flex;gap:8px"><button class="btn btn-p" style="flex:1" onclick="saveUserPassword(${userId})">Update Password</button><button class="btn btn-s" onclick="closeModal()">Cancel</button></div>
    </div>`);
}
async function saveUserPassword(userId){
  try{
    await api.post(`/api/users/${userId}/password`,{password:g('reset-user-password')?.value||''});
    closeModal();
    toast('Password updated','ok');
  }catch(e){ toast('Error: '+e.message,'err'); }
}
async function deleteUserAccount(userId){
  if(!confirm('Delete this user account?')) return;
  try{
    await api.del(`/api/users/${userId}`);
    toast('User deleted','ok');
    rUsersSettings();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
function rSettings(){
  const c=g('prod-list-container');
  if(!S.products.length){c.innerHTML=`<div class="empty"><div class="ei">📦</div><div class="et">No products or services yet</div></div>`;return;}
  c.innerHTML=S.products.map(p=>buildProdCard(p)).join('');
}
function buildProdCard(p){
  const compRows=(p.composition&&p.composition.length)?p.composition:[{inventoryProductId:'',percentage:100}];
  const compEditorRows=buildExistingCompRows(p.id, compRows);
  const compTotal=(p.composition||[]).reduce((s,c)=>s+(parseFloat(c.percentage)||0),0);
  const compOk=(p.composition||[]).length>0 && Math.abs(compTotal-100)<=0.01;
  const st=p.sizes.map((sz,i)=>`<button class="size-tab ${i===0?'active':''}" onclick="switchSizeTab('${p.id}','${sz}')" id="tab-${p.id}-${variantIdToken(sz)}">${VL[sz]||sz}</button>`).join('');
  const sp=p.sizes.map((sz,i)=>buildSizePanel(p,sz,i===0)).join('');
  const comp=(p.composition||[]).map(c=>`${String(c.inventoryProductName||c.inventoryProductId||'')} ${Number(c.percentage||0).toFixed(0)}%`).join(' + ');
  const sub=[p.sizes.map(s=>VL[s]||s).join(' · '), comp?`Mix: ${comp}`:'Mix: Not configured'].join(' · ');
  return`<div class="prod-card" id="pcard-${esc(p.id)}"><div class="prod-card-header" onclick="toggleProdCard('${esc(p.id)}')"><div><div class="prod-card-title">${esc(p.name)}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(sub)}</div></div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:var(--text-3)" id="pcard-chevron-${esc(p.id)}">▼</span><button class="btn btn-danger btn-xs" onclick="event.stopPropagation();delProduct('${esc(p.id)}')">Delete</button></div></div><div class="prod-card-body" id="pcard-body-${esc(p.id)}"><div class="sl-label" style="margin-bottom:10px">Composition (Inventory Mapping)</div><div id="pc-comp-rows-${esc(p.id)}" style="display:flex;flex-direction:column;gap:8px">${compEditorRows}</div><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px"><button class="btn btn-s btn-sm" onclick="addExistingCompRow('${esc(p.id)}')">＋ Add Ingredient</button><div id="pc-comp-hint-${esc(p.id)}" style="font-size:12px;color:${compOk?'var(--green)':'var(--amber)'}">${(p.composition||[]).length?`Total: <strong>${compTotal.toFixed(2)}%</strong> ${compOk?'✓':'(must be 100%)'}`:'Set at least one ingredient. Total must be 100%.'}</div></div><div style="margin-top:10px"><button class="btn btn-p btn-sm" onclick="saveExistingComposition('${esc(p.id)}')">Save Composition</button></div><hr><div class="size-tab-row">${st}</div><div id="size-panels-${esc(p.id)}">${sp}</div></div></div>`;
}
function inventoryProductOptions(selected=''){
  const base='<option value="">Select inventory product…</option>';
  const list=inventorySnapshot.length
    ? inventorySnapshot.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')
    : '<option value="">Inventory app not connected</option>';
  return base+list;
}
function buildExistingCompRows(pid, rows){
  return rows.map((r,i)=>`<div class="pc-comp-row">
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
  const tk=variantIdToken(sz);
  const pr=(p.pricing&&p.pricing[sz])||{salePrices:{retail:0,website:0,whatsapp:0},expenses:[]};
  const sp=pr.salePrices||{retail:0,website:0,whatsapp:0};
  const reorderCycleDays=parseInt(pr.reorderCycleDays,10)>0?parseInt(pr.reorderCycleDays,10):defaultVariantCycleDays(sz);
  const exRows=(pr.expenses||[]).map((e,i)=>buildExpRow(p.id,sz,i,e.name,e.cost)).join('');
  const tc=(pr.expenses||[]).reduce((s,e)=>s+(parseFloat(e.cost)||0),0);
  const ci=CHANNELS.map(c=>`<div class="fg"><label>${c.label}</label><div class="input-prefix"><span>₹</span><input type="number" id="sp-${c.id}-${p.id}-${tk}" value="${sp[c.id]||0}" min="0" placeholder="0" oninput="calcMargin('${p.id}','${sz}')"></div></div>`).join('');
  return`<div class="size-panel ${isActive?'active':''}" id="sp-${p.id}-${tk}"><div class="sl-label" style="margin-bottom:10px">Sale Prices — ${VL[sz]||sz}</div><div class="fr3" style="margin-bottom:18px">${ci}</div><div class="fr" style="margin-bottom:18px"><div class="fg"><label>Reorder Alert Cycle</label><div class="input-prefix"><span>d</span><input type="number" id="rcd-${p.id}-${tk}" value="${reorderCycleDays}" min="1" placeholder="10"></div><div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Used for cycle hint and fallback reorder alerts for this variant.</div></div></div><div class="sl-label">Cost / Expenses per pack</div><div id="expenses-${p.id}-${tk}">${exRows}</div><button class="btn btn-s btn-sm mt8" onclick="addExpRow('${p.id}','${sz}')">＋ Add Expense</button><div class="margin-display mt12" id="margin-display-${p.id}-${tk}">${buildMarginHTML(p.id,sz,tc,sp)}</div><div style="margin-top:14px"><button class="btn btn-p btn-sm" onclick="saveSizePricing('${p.id}','${sz}')">Save ${VL[sz]||sz} Pricing</button></div></div>`;
}
function buildMarginHTML(pid,sz,tc,sp){
  const rows=CHANNELS.map(c=>{const price=parseFloat(sp[c.id])||0;if(!price)return'';const margin=price-tc,mpct=price>0?(margin/price*100):0;return`<div class="margin-row"><span class="margin-key">${c.label}</span><span class="margin-val ${margin>=0?'pos':'neg'}">₹${margin.toFixed(0)} <span style="font-size:11px">(${mpct.toFixed(1)}%)</span></span></div>`;}).filter(Boolean).join('');
  return`<div class="margin-row"><span class="margin-key">Total Cost / pack</span><span class="margin-val ${tc>0?'neg':''}">${tc>0?'₹'+tc.toFixed(0):'—'}</span></div>${rows||'<div style="font-size:12px;color:var(--text-3);padding:4px 0">Set sale prices above to see margins</div>'}`;
}
function buildExpRow(pid,sz,idx,name='',cost=''){ const tk=variantIdToken(sz); return`<div class="expense-row" id="er-${pid}-${tk}-${idx}"><input type="text" value="${esc(String(name))}" placeholder="Expense name" id="en-${pid}-${tk}-${idx}" oninput="calcMargin('${pid}','${sz}')"><div class="input-prefix"><span>₹</span><input type="number" value="${cost}" placeholder="0" min="0" id="ec-${pid}-${tk}-${idx}" oninput="calcMargin('${pid}','${sz}')"></div><button class="del-btn" onclick="removeExpRow('${pid}','${sz}',${idx})">✕</button></div>`; }
function toggleProdCard(pid){ const b=g('pcard-body-'+pid),c=g('pcard-chevron-'+pid);b.classList.toggle('collapsed');c.textContent=b.classList.contains('collapsed')?'▶':'▼'; }
function switchSizeTab(pid,sz){ const prod=S.products.find(p=>p.id===pid);(prod.sizes||DEFAULT_SIZES).forEach(s=>{const t=g(`tab-${pid}-${variantIdToken(s)}`),p=g(`sp-${pid}-${variantIdToken(s)}`);if(t)t.classList.remove('active');if(p)p.classList.remove('active');});const t=g(`tab-${pid}-${variantIdToken(sz)}`),p=g(`sp-${pid}-${variantIdToken(sz)}`);if(t)t.classList.add('active');if(p)p.classList.add('active'); }
function getExpRows(pid,sz){ const tk=variantIdToken(sz);const rows=[];let i=0;while(g(`er-${pid}-${tk}-${i}`)){const n=g(`en-${pid}-${tk}-${i}`).value.trim(),c=g(`ec-${pid}-${tk}-${i}`).value;if(n||c)rows.push({name:n,cost:parseFloat(c)||0});i++;}return rows; }
function calcMargin(pid,sz){ const tk=variantIdToken(sz);const disp=g(`margin-display-${pid}-${tk}`);if(!disp)return;const exp=getExpRows(pid,sz);const tc=exp.reduce((s,e)=>s+(parseFloat(e.cost)||0),0);const sp={};CHANNELS.forEach(c=>{sp[c.id]=parseFloat((g(`sp-${c.id}-${pid}-${tk}`)||{}).value||0)||0;});disp.innerHTML=buildMarginHTML(pid,sz,tc,sp); }
function addExpRow(pid,sz){ const tk=variantIdToken(sz);let i=0;while(g(`er-${pid}-${tk}-${i}`))i++;const c=g(`expenses-${pid}-${tk}`);const d=document.createElement('div');d.innerHTML=buildExpRow(pid,sz,i,'','');c.appendChild(d.firstChild);calcMargin(pid,sz); }
function removeExpRow(pid,sz,idx){ const tk=variantIdToken(sz);const el=g(`er-${pid}-${tk}-${idx}`);if(el){el.remove();calcMargin(pid,sz);} }
async function saveSizePricing(pid,sz){ const tk=variantIdToken(sz);const prod=S.products.find(p=>p.id===pid);if(!prod.pricing)prod.pricing={};const salePrices={};CHANNELS.forEach(c=>{salePrices[c.id]=parseFloat((g(`sp-${c.id}-${pid}-${tk}`)||{}).value||0)||0;});if(!Object.values(salePrices).some(v=>v>0)){toast('Set at least one sale price','err');return;}const reorderCycleDays=parseInt((g(`rcd-${pid}-${tk}`)||{}).value||0,10);if(!Number.isFinite(reorderCycleDays)||reorderCycleDays<=0){toast('Set a valid reorder alert cycle in days','err');return;}prod.pricing[sz]={salePrices,expenses:getExpRows(pid,sz),reorderCycleDays};try{const updated=await api.put(`/api/products/${pid}`,{pricing:prod.pricing});const idx=S.products.findIndex(p=>p.id===pid);if(idx>=0)S.products[idx]=updated;toast(`Saved ${updated.name} — ${VL[sz]||sz}`,'ok');calcMargin(pid,sz);}catch(e){toast('Error: '+e.message,'err');} }
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
  wrap.innerHTML=rows.map((r,i)=>`<div class="comp-row">
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
  const name=g('np-name').value.trim();if(!name){toast('Enter a product or service name','err');return;}
  const sizes=buildProductVariantsFromForm();
  if(!sizes.length){toast('Add at least one variant or plan','err');return;}
  const rawRows=getCompositionRows().filter(r=>r.inventoryProductId||r.percentage>0);
  if(!rawRows.length){toast('Add at least one composition row','err');return;}
  if(rawRows.some(r=>!r.inventoryProductId||r.percentage<=0)){toast('Each composition row needs product + percentage','err');return;}
  const totalPct=rawRows.reduce((s,r)=>s+r.percentage,0);
  if(Math.abs(totalPct-100)>0.01){toast('Composition total must be exactly 100%','err');return;}
  const composition=rawRows.map(r=>{const inv=inventorySnapshot.find(p=>p.id===r.inventoryProductId);return{inventoryProductId:r.inventoryProductId,inventoryProductName:inv?.name||r.inventoryProductId,percentage:r.percentage};});
  try{
    const product=await api.post('/api/products',{name,sizes,waTpl:'',pricing:{},composition});
    S.products.push(product);S.pid=parseInt(product.id.replace('p',''))+1;g('np-name').value='';
    if(g('np-variant-metric')) g('np-variant-metric').value='g';
    if(g('np-variant-values')) g('np-variant-values').value='100,250,500,1000';
    if(g('np-variant-custom')) g('np-variant-custom').value='';
    refreshVariantBuilderUI();
    resetCompositionBuilder();
    toast(name+' added','ok');sPanel('products');rSettings();populateProdSelect();
  }catch(e){toast('Error: '+e.message,'err');}
}
async function delProduct(pid){ if(!confirm('Delete this product or service?'))return;try{await api.del(`/api/products/${pid}`);S.products=S.products.filter(p=>p.id!==pid);rSettings();populateProdSelect();toast('Item deleted');}catch(e){toast('Error: '+e.message,'err');} }

// ─── WA TEMPLATES ────────────────────────────────────────────────────────────
function getWaTpl(pid){ const prod=S.products.find(p=>p.id===pid);if(prod&&prod.waTpl&&prod.waTpl.trim())return prod.waTpl;return(S.waDefaultTpl&&S.waDefaultTpl.trim())?S.waDefaultTpl:DEFAULT_WA_TPL; }
function applyWaTokens(tpl,d){ return tpl.replace(/\{\{customer_name\}\}/g,d.customer_name||'').replace(/\{\{last_order_date\}\}/g,d.last_order_date||'').replace(/\{\{product_name\}\}/g,d.product_name||'').replace(/\{\{variant\}\}/g,d.variant||'').replace(/\{\{qty\}\}/g,d.qty||''); }
function buildWaUrl(alert){ const tpl=getWaTpl(alert.last.prodId);const msg=applyWaTokens(tpl,{customer_name:alert.cust.name,last_order_date:fd(alert.last.at),product_name:alert.last.prod,variant:VL[alert.last.variant]||alert.last.variant,qty:String(alert.last.qty)});return`https://wa.me/91${alert.cust.phone}?text=${encodeURIComponent(msg)}`; }
function rWaMessages(){
  const de=g('wa-tpl-default');
  if(de) de.value=S.waDefaultTpl||DEFAULT_WA_TPL;
  previewWa('default');
  const c=g('wa-prod-cards');
  if(!c) return;
  c.innerHTML=S.products.map(p=>{
    const pid=String(p.id||'');
    const tpl=p.waTpl||'';
    const tokens=['{{customer_name}}','{{last_order_date}}','{{product_name}}','{{variant}}','{{qty}}'];
    const chips=tokens.map(t=>`<span class="token-chip" onclick="insertToken('wa-tpl-${esc(pid)}','${t}','${esc(pid)}')">${t}</span>`).join('');
    return `<div class="wa-card"><div class="wa-card-header"><div><div class="wa-card-title">${esc(p.name)}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${tpl?'Custom template set':'Using default template'}</div></div>${tpl?`<button class="btn btn-danger btn-xs" onclick="clearProdWaTpl('${esc(pid)}')">Reset</button>`:`<span class="pill pn" style="font-size:11px">Default</span>`}</div><div class="wa-card-body"><div class="fg"><label>Message <span style="color:var(--text-3);font-weight:400">(blank = use default)</span></label><textarea id="wa-tpl-${esc(pid)}" rows="3" oninput="previewWa('${esc(pid)}')" placeholder="Leave blank to use the default template…">${esc(tpl)}</textarea></div><div class="token-chips">${chips}</div><div style="font-size:11px;color:var(--text-3);margin-top:6px;font-style:italic">Preview:</div><div class="wa-preview" id="wa-prev-${esc(pid)}"></div><div style="margin-top:12px"><button class="btn btn-p btn-sm" onclick="saveWaTpl('${esc(pid)}')">Save for ${esc(p.name)}</button></div></div></div>`;
  }).join('');
  S.products.forEach(p=>previewWa(p.id));
}
function insertToken(taId,token,pk){ const el=g(taId);if(!el)return;const s=el.selectionStart,e=el.selectionEnd;el.value=el.value.slice(0,s)+token+el.value.slice(e);el.selectionStart=el.selectionEnd=s+token.length;el.focus();previewWa(pk); }
function insertShippingToken(token){
  const el=g('ship-wa-template');
  if(!el) return;
  const s=el.selectionStart;
  const e=el.selectionEnd;
  el.value=el.value.slice(0,s)+token+el.value.slice(e);
  el.selectionStart=el.selectionEnd=s+token.length;
  el.focus();
}
function previewWa(key){ const taId=key==='default'?'wa-tpl-default':`wa-tpl-${key}`;const prId=key==='default'?'wa-prev-default':`wa-prev-${key}`;const el=g(taId),pr=g(prId);if(!el||!pr)return;let tpl=el.value.trim();if(!tpl&&key!=='default')tpl=S.waDefaultTpl||DEFAULT_WA_TPL;if(!tpl)tpl=DEFAULT_WA_TPL;const merged=applyWaTokens(tpl,{customer_name:'Priya Shankar',last_order_date:'12 Jun 2025',product_name:key==='default'?'Coorg Filter Coffee':((S.products.find(p=>p.id===key)||{}).name||'Item'),variant:'250g',qty:'1'});pr.innerHTML=esc(merged).replace(/\n/g,'<br>'); }
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
  if(g('ship-wa-template')) g('ship-wa-template').value=p.shippedWaTemplate||DEFAULT_SHIPPED_WA_TPL;
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
  if(!hasActionAccess('settings','manage')){ toast('Settings access is restricted','err'); return; }
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
    shippedWaTemplate:(g('ship-wa-template')?.value||'').trim(),
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
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function dateToISO(ts){ const d=new Date(ts);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function openNativePicker(id){
  const el=g(id);
  if(!el || typeof el.showPicker!=='function') return;
  try{ el.showPicker(); }catch(_){ /* ignore */ }
}

// ─── BOOT ────────────────────────────────────────────────────────────────────
async function init(){
  ensureAuthUi();
  try{
    const status=await refreshAuthState();
    if(status?.enabled && (status.setupRequired || !status.authenticated)){
      enterAuthMode(status);
      return;
    }
  }catch(_){
    S=emptyState();
    enterAuthMode();
    return;
  }
  await loadApplicationData();
}
async function loadApplicationData(){
  let bootstrapError=null;
  try{
    const boot=await api.get('/api/bootstrap');
    S=boot?.state||emptyState();
    DASH_BOOTSTRAP_METRICS=boot?.dashboardMetrics||null;
    FEATURE_CONFIG=boot?.featureConfig||FEATURE_CONFIG;
    AUTH_STATE=S?.authContext||AUTH_STATE;
    FULL_DATA_READY=true;
    FULL_DATA_PROMISE=null;
  }catch(err){
    bootstrapError=err;
    FULL_DATA_READY=false;
    FULL_DATA_PROMISE=null;
  }
  if(!S){
    try{
      await fetchFullData();
    }catch(err){
      S=emptyState();
      const fallbackMsg=err?.message||bootstrapError?.message||'Unknown error';
      toast('Cannot reach server: '+fallbackMsg,'err');
      return;
    }
  }
  if(authEnabled() && !authContext().authenticated){
    enterAuthMode();
    return;
  }
  enterAppMode();
  applyTheme(S?.uiPreferences?.theme||'light');
  if(!Array.isArray(S.distributorBatches)) S.distributorBatches=[];
  if(!Array.isArray(S.distributionChannels)) S.distributionChannels=[];
  if(!Array.isArray(S.operationalExpenses)) S.operationalExpenses=[];
  setCustomerFiltersExpanded(false);
  ensureUserManagementUi();
  applyPermissionUI();
  updBadge(); rDash(); populateProdSelect(); setDefaultDate(); setOperationalExpenseDateDefault(); resetCompositionBuilder(); refreshVariantBuilderUI();
  pollStockAlerts().then(()=>{ rDash(); rAlerts(); updBadge(); }).catch(()=>{});
  if(!window.__inventoryPollStarted){
    window.__inventoryPollStarted=true;
    setInterval(pollStockAlerts, 5 * 60 * 1000);
  }
}
window.addEventListener('DOMContentLoaded',init);
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible') refreshThemePreference();
});
