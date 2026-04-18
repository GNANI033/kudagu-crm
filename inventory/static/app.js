/* ═══════════════════════════════════════════════════════════════════════════
   Kudagu Kaapi — Inventory Manager  (inventory/static/app.js)
   Talks to the inventory FastAPI backend on the same origin (port 8001).
═══════════════════════════════════════════════════════════════════════════ */
'use strict';

let S = null; // full data state

// ─── API ─────────────────────────────────────────────────────────────────────
const api = {
  async get(p){ const r=await fetch(p); if(!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); },
  async post(p,b){ const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(!r.ok){const m=await r.text();throw new Error(m);} return r.json(); },
  async put(p,b){ const r=await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(!r.ok){const m=await r.text();throw new Error(m);} return r.json(); },
  async del(p){ const r=await fetch(p,{method:'DELETE'}); if(!r.ok) throw new Error(`DELETE ${p} → ${r.status}`); return r.json(); },
};
const THEME_OPTIONS = {
  light: 'Light',
  dark: 'Dark',
  nord: 'Nord',
  solarized: 'Solarized',
  dracula: 'Dracula',
};
function normalizeTheme(theme){
  const key=String(theme||'').trim().toLowerCase();
  return THEME_OPTIONS[key] ? key : 'light';
}
function applyTheme(theme){
  const next=normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', next);
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
  if(status) status.textContent=`Current theme: ${THEME_OPTIONS[current]}. This updates CRM and inventory together.`;
}
async function setTheme(theme){
  const previous=normalizeTheme(S?.uiPreferences?.theme);
  const next=normalizeTheme(theme);
  if(previous===next){
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
    const res=await api.get('/api/settings');
    applyTheme(res?.uiPreferences?.theme||'light');
  }catch(_){}
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────
function fd(ts){ return ts ? new Date(ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'; }
function fdt(ts){ return ts ? new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; }
function fGrams(g){ return g >= 1000 ? (g/1000).toFixed(2)+' kg' : g.toFixed(0)+' g'; }
function g(id){ return document.getElementById(id); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── TOAST ───────────────────────────────────────────────────────────────────
function toast(msg,type=''){ const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=msg; g('toasts').appendChild(el); setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},2800); }

// ─── MODAL ───────────────────────────────────────────────────────────────────
function openModal(html){ g('modal-box').innerHTML=html; g('modal').classList.add('open'); }
function closeModal(){ g('modal').classList.remove('open'); g('modal-box').innerHTML=''; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });

// ─── CONTEXT MENU ────────────────────────────────────────────────────────────
function openCtxMenu(html, btnEl){
  closeCtxMenu();
  const menu=document.createElement('div'); menu.className='ctx-menu'; menu.id='ctx-menu';
  menu.innerHTML=html; document.body.appendChild(menu);
  const r=btnEl.getBoundingClientRect();
  menu.style.top=(r.bottom+window.scrollY+4)+'px';
  menu.style.left=Math.max(8,(r.right+window.scrollX-(menu.offsetWidth||180)))+'px';
  setTimeout(()=>document.addEventListener('click',_closeCtxOutside,{once:true}),10);
}
function _closeCtxOutside(e){ if(!e.target.closest('#ctx-menu')) closeCtxMenu(); }
function closeCtxMenu(){ const m=g('ctx-menu'); if(m) m.remove(); }

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function nav(p){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  g('view-'+p).classList.add('active');
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
  const IDX={dashboard:0,stock:1,movements:2,products:3,finished:4,settings:5};
  if(IDX[p]!==undefined) document.querySelectorAll('.nb')[IDX[p]].classList.add('active');
  if(p==='dashboard')  rDash();
  if(p==='stock')      rStock();
  if(p==='movements')  rMovements();
  if(p==='products')   rProducts();
  if(p==='finished')   rFinishedProducts();
  if(p==='settings')   rThemeSettings();
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────
function allMovements(){
  return S.products.flatMap(p=>
    (p.movements||[]).map(m=>({...m, productName:p.name, productId:p.id}))
  ).sort((a,b)=>b.at-a.at);
}

function totalStockKg(){
  return S.products.reduce((s,p)=>s+(p.stock||0),0)/1000;
}

function finishedProducts(){
  return Array.isArray(S?.finishedProducts) ? S.finishedProducts : [];
}

function findFinishedProduct(id){
  return finishedProducts().find(p=>p.crmProductId===id);
}

function advertisedVariantCount(row){
  return Array.isArray(row?.advertisedVariants) ? row.advertisedVariants.length : 0;
}

function variantWebsitePrice(variant){
  return Number(variant?.pricing?.salePrices?.website||0);
}

function money(v){
  return `Rs ${Number(v||0).toFixed(0)}`;
}

function totalMovedThisMonth(type){
  const now=new Date(), mStart=new Date(now.getFullYear(),now.getMonth(),1).getTime();
  return S.products.reduce((s,p)=>
    s+(p.movements||[]).filter(m=>m.type===type&&m.at>=mStart).reduce((a,m)=>a+m.grams,0)
  ,0);
}

function lowStockProducts(){
  return S.products.filter(p=>(p.stock||0)<=p.lowStockThreshold);
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function rDash(){
  g('dash-date').textContent = new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const low=lowStockProducts();
  const totalKg =totalStockKg();
  const allMov=allMovements();
  const outMov=allMov.filter(m=>m.type==='out');
  const inMov =allMov.filter(m=>m.type==='in');
  const movedOutTotal=outMov.reduce((s,m)=>s+m.grams,0);
  const movedInTotal =inMov.reduce((s,m)=>s+m.grams,0);
  const avgOut=outMov.length>0?(outMov.reduce((s,m)=>s+m.grams,0)/outMov.length):0;

  g('dash-stats').innerHTML=`
    <div class="sbox accent-top">
      <div class="sl">Total Stock</div>
      <div class="sv">${totalKg.toFixed(1)} kg</div>
      <div class="sn">${S.products.length} product${S.products.length!==1?'s':''} tracked</div>
    </div>
    <div class="sbox ${low.length?'amber-top':'green-top'}">
      <div class="sl">Low Stock</div>
      <div class="sv ${low.length?'amber':''}">${low.length}</div>
      <div class="sn">${low.length?'Products below threshold':'All stocks healthy'}</div>
    </div>
    <div class="sbox accent-top">
      <div class="sl">Inventory Moved</div>
      <div class="sv">${fGrams(movedOutTotal)}</div>
      <div class="sn">Total moved out · In: ${fGrams(movedInTotal)} restocked</div>
    </div>
    <div class="sbox accent-top">
      <div class="sl">Avg Movement Size</div>
      <div class="sv">${avgOut>0?fGrams(avgOut):'—'}</div>
      <div class="sn">Per outbound entry</div>
    </div>`;

  // Low stock section
  const dlEl=g('dash-low-stock');
  if(!low.length){
    dlEl.innerHTML=`<div class="empty" style="padding:32px 18px"><div class="et">All stocks healthy</div><div class="es">No products below their threshold</div></div>`;
  } else {
    dlEl.innerHTML=low.map(p=>{
      const pct=Math.min(100,(p.stock/Math.max(p.lowStockThreshold*2,1))*100);
      const cls=p.stock<=p.lowStockThreshold*0.5?'crit':'warn';
      return`<div style="padding:13px 18px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div>
            <div style="font-weight:600;font-size:13px">${esc(p.name)}</div>
            <div style="font-size:11.5px;color:var(--text-3)">Threshold: ${fGrams(p.lowStockThreshold)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;color:${cls==='crit'?'var(--red)':'var(--amber)'}">${fGrams(p.stock)}</div>
            <span class="pill ${cls==='crit'?'pr':'pa'}" style="font-size:10.5px">${cls==='crit'?'Critical':'Low'}</span>
          </div>
        </div>
        <div class="stock-bar-wrap"><div class="stock-bar ${cls}" style="width:${pct}%"></div></div>
        <button class="btn btn-sm btn-p" style="margin-top:6px;width:100%;justify-content:center" onclick="openAddMovementModal('${p.id}','in')">+ Restock ${esc(p.name)}</button>
      </div>`;
    }).join('');
  }

  // Recent movements
  const rmEl=g('dash-recent-mov');
  const recent=allMovements().slice(0,8);
  if(!recent.length){
    rmEl.innerHTML=`<div class="empty" style="padding:32px 18px"><div class="et">No movements yet</div></div>`;
  } else {
    rmEl.innerHTML=`<div class="mov-list">${recent.map(m=>movRow(m)).join('')}</div>`;
  }
}

// ─── STOCK LEVELS ────────────────────────────────────────────────────────────
function rStock(){
  g('stock-sub').textContent=S.products.length+' product'+(S.products.length!==1?'s':'')+' · click a card to view movements';
  const grid=g('stock-grid');
  if(!S.products.length){
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="et">No products yet</div><div class="es">Add products first from the Products tab</div></div>`;
    return;
  }
  grid.innerHTML=S.products.map(p=>{
    const an=p.analytics||{};
    const maxStock=Math.max(p.stock,p.lowStockThreshold*2,1);
    const pct=Math.min(100,(p.stock/maxStock)*100);
    const st=p.stock<=p.lowStockThreshold*0.5?'critical':p.stock<=p.lowStockThreshold?'low-stock':'';
    const barCls=p.stock<=p.lowStockThreshold*0.5?'crit':p.stock<=p.lowStockThreshold?'warn':'ok';
    return`<div class="prod-card ${st}" onclick="openProductDetail('${p.id}')" style="cursor:pointer">
      <div class="pc-header">
        <div>
          <div class="pc-name">${esc(p.name)}</div>
          <div class="pc-threshold">Threshold: ${fGrams(p.lowStockThreshold)}</div>
        </div>
        <div class="pc-stock">
          <div class="pc-stock-val" style="color:${st==='critical'?'var(--red)':st==='low-stock'?'var(--amber)':'var(--text)'}">${fGrams(p.stock)}</div>
          <div class="pc-stock-lbl">in stock</div>
        </div>
      </div>
      <div class="stock-bar-wrap"><div class="stock-bar ${barCls}" style="width:${pct}%"></div></div>
      <div class="pc-meta">
        <div class="pc-meta-item">Out this month: <strong>${fGrams(monthlyOut(p))}</strong></div>
        <div class="pc-meta-item">Avg move: <strong>${an.avgOutSize?fGrams(an.avgOutSize):'—'}</strong></div>
      </div>
      <div class="pc-actions">
        <button class="btn btn-green btn-sm" onclick="event.stopPropagation();openAddMovementModal('${p.id}','in')">+ Restock</button>
        <button class="btn btn-s btn-sm" onclick="event.stopPropagation();openAddMovementModal('${p.id}','out')">- Dispatch</button>
        <button class="btn btn-g btn-xs" onclick="event.stopPropagation();openProductMenu('${p.id}',this)">⋯</button>
      </div>
    </div>`;
  }).join('');
}

function monthlyOut(p){
  const now=new Date(), mStart=new Date(now.getFullYear(),now.getMonth(),1).getTime();
  return (p.movements||[]).filter(m=>m.type==='out'&&m.at>=mStart).reduce((s,m)=>s+m.grams,0);
}

function openProductDetail(pid){
  const p=S.products.find(x=>x.id===pid); if(!p) return;
  const movs=(p.movements||[]).slice().reverse();
  const an=p.analytics||{};
  openModal(`
    <div class="modal-title">${esc(p.name)}</div>
    <div style="margin-top:4px;margin-bottom:18px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="pill pn">${fGrams(p.stock)} in stock</span>
      <span class="pill ${p.stock<=p.lowStockThreshold?'pa':'pg'}">Threshold: ${fGrams(p.lowStockThreshold)}</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:18px">
      <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:12px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700">${fGrams(an.totalOut||0)}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">Total Dispatched</div>
      </div>
      <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:12px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700">${fGrams(an.totalIn||0)}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">Total Restocked</div>
      </div>
      <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:12px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700">${an.avgOutSize?fGrams(an.avgOutSize):'—'}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">Avg Dispatch</div>
      </div>
    </div>
    <div class="sl-label">Movement History</div>
    ${movs.length?`<div class="mov-list" style="border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden">${movs.map(m=>movRow(m)).join('')}</div>`:`<div style="color:var(--text-3);font-size:13px;padding:16px 0">No movements recorded yet</div>`}
    <div style="display:flex;gap:8px;margin-top:18px">
      <button class="btn btn-green" style="flex:1" onclick="closeModal();openAddMovementModal('${pid}','in')">+ Restock</button>
      <button class="btn btn-p" style="flex:1" onclick="closeModal();openAddMovementModal('${pid}','out')">- Dispatch</button>
    </div>`);
}

// ─── MOVEMENTS ───────────────────────────────────────────────────────────────
function rMovements(){
  const movs=allMovements();
  g('mov-sub').textContent=movs.length+' total movement'+(movs.length!==1?'s':'');
  const el=g('mov-list');
  if(!movs.length){
    el.innerHTML=`<div class="empty"><div class="et">No movements yet</div><div class="es">Record stock-in, dispatch, or adjustments above</div></div>`;
    return;
  }
  el.innerHTML=`<div class="mov-list">${movs.map(m=>movRow(m,true)).join('')}</div>`;
}

function movRow(m, showDelete=false){
  const sign=m.type==='out'?'−':'+';
  const typeLabel={in:'Restock',out:'Dispatch',adjustment:'Adjustment'}[m.type]||m.type;
  const actions=showDelete?`
    ${m.type==='in'?`<button class="btn btn-g btn-xs" style="flex-shrink:0" onclick="openEditMovementModal('${m.productId}',${m.id})" title="Edit Restock">Edit</button>`:''}
    <button class="btn btn-g btn-xs" style="flex-shrink:0;color:var(--text-3)" onclick="deleteMovement('${m.productId}',${m.id})" title="Delete">✕</button>`:'';
  return`<div class="mov-item">
    <div class="mov-dot ${m.type}"></div>
    <div class="mov-body">
      <div class="mov-label">${esc(m.productName||'')} — ${typeLabel}</div>
      ${m.note?`<div class="mov-note">${esc(m.note)}</div>`:''}
    </div>
    <div class="mov-right">
      <div class="mov-grams ${m.type}">${sign}${fGrams(m.grams)}</div>
      <div class="mov-date">${fdt(m.at)}</div>
    </div>
    ${actions}
  </div>`;
}

async function deleteMovement(pid, mid){
  if(!confirm('Delete this movement? Stock will be recalculated.')) return;
  try{
    const res=await api.del(`/api/products/${pid}/movements/${mid}`);
    const p=S.products.find(x=>x.id===pid);
    if(p){ p.movements=p.movements.filter(m=>m.id!==mid); p.stock=res.newStock; }
    toast('Movement deleted'); rMovements(); rDash(); rStock();
  }catch(e){ toast('Error: '+e.message,'err'); }
}

function openEditMovementModal(pid, mid){
  const p=S.products.find(x=>x.id===pid); if(!p) return;
  const m=(p.movements||[]).find(x=>x.id===mid); if(!m) return;
  if(m.type!=='in'){ toast('Only restocks can be edited here','err'); return; }

  let dateVal='';
  if(m.at){
    const dt=new Date(m.at);
    if(!isNaN(dt.getTime())){
      dateVal=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    }
  }
  openModal(`
    <div class="modal-title">Edit Restock</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fg">
        <label>Product</label>
        <input value="${esc(p.name)}" disabled>
      </div>
      <div class="fr">
        <div class="fg">
          <label>Quantity (grams) <span class="req">*</span></label>
          <input type="number" id="em-grams" value="${m.grams}" min="1" inputmode="decimal">
        </div>
        <div class="fg">
          <label>Date</label>
          <input type="date" id="em-date" value="${dateVal}">
        </div>
      </div>
      <div class="fg">
        <label>Note <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
        <input type="text" id="em-note" value="${esc(m.note||'')}">
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditMovement('${pid}',${mid})">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
}

async function submitEditMovement(pid, mid){
  const grams=parseFloat(g('em-grams')?.value||0);
  if(!grams||grams<=0){toast('Enter a valid quantity','err');return;}
  const note=g('em-note')?.value||'';
  const dateInput=g('em-date')?.value;
  let at=Date.now();
  if(dateInput){
    const [y,mo,d]=dateInput.split('-').map(Number);
    const dt=new Date(y,mo-1,d,12,0,0);
    if(!isNaN(dt.getTime())) at=dt.getTime();
  }
  try{
    const res=await api.put(`/api/products/${pid}/movements/${mid}`,{grams,note,at});
    const p=S.products.find(x=>x.id===pid);
    if(p){
      const m=p.movements.find(x=>x.id===mid);
      if(m){ m.grams=grams; m.note=note; m.at=at; }
      p.stock=res.newStock;
    }
    closeModal(); toast('Restock updated','ok');
    rMovements(); rDash(); rStock();
  }catch(e){ toast('Error: '+e.message,'err'); }
}

// ─── ADD MOVEMENT MODAL ───────────────────────────────────────────────────────
let _movType='in';
function openAddMovementModal(preselectPid='', preType='in'){
  _movType=preType;
  const prodOptions=S.products.map(p=>`<option value="${p.id}" ${p.id===preselectPid?'selected':''}>${esc(p.name)}</option>`).join('');
  if(!S.products.length){ toast('Add a product first','err'); return; }
  const today=new Date(), iso=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  openModal(`
    <div class="modal-title">Record Stock Movement</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fg">
        <label>Movement Type</label>
        <div class="type-tabs">
          <button class="type-tab in ${_movType==='in'?'on':''}" onclick="setMovType('in',this)">
            Stock In <span class="type-tab-sub">Restock / receive</span>
          </button>
          <button class="type-tab out ${_movType==='out'?'on':''}" onclick="setMovType('out',this)">
            Stock Out <span class="type-tab-sub">Dispatch / used</span>
          </button>
          <button class="type-tab adj ${_movType==='adjustment'?'on':''}" onclick="setMovType('adjustment',this)">
            Adjust <span class="type-tab-sub">Correction</span>
          </button>
        </div>
      </div>
      <div class="fg">
        <label>Product <span class="req">*</span></label>
        <select id="mov-prod">${prodOptions}</select>
      </div>
      <div class="fr">
        <div class="fg">
          <label>Quantity (grams) <span class="req">*</span></label>
          <input type="number" id="mov-grams" placeholder="e.g. 500" min="1" inputmode="decimal">
        </div>
        <div class="fg">
          <label>Date</label>
          <input type="date" id="mov-date" value="${iso}">
        </div>
      </div>
      <div class="fg">
        <label>Note <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
        <input type="text" id="mov-note" placeholder="e.g. Supplier batch #12, used for 50 orders…">
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitMovement()">Save Movement</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
}

function setMovType(type, btn){
  _movType=type;
  document.querySelectorAll('.type-tab').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');
}

async function submitMovement(){
  const pid=g('mov-prod')?.value; if(!pid){toast('Select a product','err');return;}
  const grams=parseFloat(g('mov-grams')?.value||0);
  if(!grams||grams<=0){toast('Enter a valid quantity','err');return;}
  const dateVal=g('mov-date')?.value;
  let at=Date.now();
  if(dateVal){const[y,mo,d]=dateVal.split('-').map(Number);const dt=new Date(y,mo-1,d,12,0,0);if(!isNaN(dt.getTime()))at=dt.getTime();}
  try{
    const res=await api.post(`/api/products/${pid}/movements`,{type:_movType,grams,note:g('mov-note')?.value||'',at});
    const p=S.products.find(x=>x.id===pid);
    if(p){ p.movements.push({id:res.id,productId:pid,type:_movType,grams,note:g('mov-note')?.value||'',at}); p.stock=res.newStock; }
    closeModal(); toast('Movement recorded','ok');
    rDash(); rStock(); rMovements();
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── PRODUCTS CONFIG ──────────────────────────────────────────────────────────
function rProducts(){
  const el=g('prod-config-list');
  if(!S.products.length){
    el.innerHTML=`<div class="empty"><div class="et">No products yet</div><div class="es">Add your first product to start tracking inventory</div></div>`;
    return;
  }
  el.innerHTML=`<table style="width:100%;border-collapse:collapse">
    <thead><tr>
      <th style="text-align:left;padding:9px 18px;font-size:10.5px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border);background:var(--surface-2)">Product</th>
      <th style="text-align:right;padding:9px 18px;font-size:10.5px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border);background:var(--surface-2)">Current Stock</th>
      <th style="text-align:right;padding:9px 18px;font-size:10.5px;font-weight:600;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border);background:var(--surface-2)">Low-Stock Threshold</th>
      <th style="padding:9px 18px;border-bottom:1px solid var(--border);background:var(--surface-2)"></th>
    </tr></thead>
    <tbody>${S.products.map(p=>`<tr>
      <td style="padding:13px 18px;border-bottom:1px solid var(--border);font-weight:600">${esc(p.name)}</td>
      <td style="padding:13px 18px;border-bottom:1px solid var(--border);text-align:right;font-family:'Syne',sans-serif;font-weight:700;color:${p.stock<=p.lowStockThreshold?'var(--amber)':'var(--text)'}">${fGrams(p.stock)}</td>
      <td style="padding:13px 18px;border-bottom:1px solid var(--border);text-align:right;color:var(--text-2)">${fGrams(p.lowStockThreshold)}</td>
      <td style="padding:13px 18px;border-bottom:1px solid var(--border);text-align:right">
        <button class="btn btn-g btn-xs" onclick="openProductMenu('${p.id}',this)">⋯</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function openAddProductModal(){
  openModal(`
    <div class="modal-title">Add Product</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fg"><label>Product Name <span class="req">*</span></label><input id="np-name" placeholder="e.g. Coorg Filter Coffee Powder"></div>
      <div class="fr">
        <div class="fg">
          <label>Low Stock Threshold (g)</label>
          <input type="number" id="np-thresh" value="500" min="0" inputmode="decimal" placeholder="500">
          <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">Alert triggers below this amount</div>
        </div>
        <div class="fg">
          <label>Initial Stock (g) <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
          <input type="number" id="np-stock" value="0" min="0" inputmode="decimal" placeholder="0">
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitAddProduct()">Add Product</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
}

async function submitAddProduct(){
  const name=g('np-name')?.value.trim(); if(!name){toast('Product name required','err');return;}
  const thresh=parseFloat(g('np-thresh')?.value||500);
  const initStock=parseFloat(g('np-stock')?.value||0);
  try{
    const product=await api.post('/api/products',{name,lowStockThreshold:thresh,unit:'g'});
    S.products.push({...product,movements:[]});
    // If initial stock provided, record it as a movement
    if(initStock>0){
      const res=await api.post(`/api/products/${product.id}/movements`,{type:'in',grams:initStock,note:'Initial stock',at:Date.now()});
      const p=S.products.find(x=>x.id===product.id);
      if(p){ p.movements.push({id:res.id,productId:product.id,type:'in',grams:initStock,note:'Initial stock',at:Date.now()}); p.stock=res.newStock; }
    }
    closeModal(); toast(name+' added','ok'); rProducts(); rDash(); rStock();
  }catch(e){toast('Error: '+e.message,'err');}
}

function openProductMenu(pid, btn){
  closeCtxMenu();
  openCtxMenu(`
    <button class="ctx-item" onclick="closeCtxMenu();openEditProductModal('${pid}')">Edit Product</button>
    <hr class="ctx-divider">
    <button class="ctx-item ctx-danger" onclick="closeCtxMenu();confirmDeleteProduct('${pid}')">Delete Product</button>`,
  btn);
}

function openEditProductModal(pid){
  const p=S.products.find(x=>x.id===pid); if(!p) return;
  openModal(`
    <div class="modal-title">Edit Product</div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">
      <div class="fg"><label>Product Name <span class="req">*</span></label><input id="ep-name" value="${esc(p.name)}"></div>
      <div class="fg">
        <label>Low Stock Threshold (g)</label>
        <input type="number" id="ep-thresh" value="${p.lowStockThreshold}" min="0" inputmode="decimal">
        <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">Alert triggers below this amount</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-p" style="flex:1" onclick="submitEditProduct('${pid}')">Save Changes</button>
        <button class="btn btn-s" onclick="closeModal()">Cancel</button>
      </div>
      <hr style="margin:4px 0">
      <button class="btn btn-danger btn-full" onclick="closeModal();confirmDeleteProduct('${pid}')">Delete Product</button>
    </div>`);
}

async function submitEditProduct(pid){
  const name=g('ep-name')?.value.trim(); if(!name){toast('Name required','err');return;}
  const thresh=parseFloat(g('ep-thresh')?.value||500);
  try{
    const updated=await api.put(`/api/products/${pid}`,{name,lowStockThreshold:thresh});
    const idx=S.products.findIndex(x=>x.id===pid); if(idx>=0) Object.assign(S.products[idx],updated);
    closeModal(); toast(name+' updated','ok'); rProducts(); rStock(); rDash();
  }catch(e){toast('Error: '+e.message,'err');}
}

function confirmDeleteProduct(pid){
  const p=S.products.find(x=>x.id===pid); if(!p) return;
  openModal(`
    <div class="modal-title" style="color:var(--red)">Delete Product</div>
    <div style="margin-top:12px;font-size:13.5px;color:var(--text-2);line-height:1.7">
      Deleting <strong>${esc(p.name)}</strong> will permanently remove all its stock movements and history.
    </div>
    <div style="display:flex;gap:8px;margin-top:20px">
      <button class="btn btn-danger" style="flex:1" onclick="doDeleteProduct('${pid}')">Confirm Delete</button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`);
}

async function doDeleteProduct(pid){
  try{
    await api.del(`/api/products/${pid}`);
    S.products=S.products.filter(x=>x.id!==pid);
    closeModal(); toast('Product deleted'); rProducts(); rDash(); rStock();
  }catch(e){toast('Error: '+e.message,'err');}
}

// ─── FINISHED PRODUCTS ───────────────────────────────────────────────────────
let _finishedProductImageDataUrl='';

function rFinishedProducts(){
  const rows=finishedProducts();
  const el=g('finished-products-grid');
  const stat=g('finished-products-sub');
  if(stat){
    stat.textContent=`${rows.length} CRM product${rows.length!==1?'s':''} synced for website/admin use`;
  }
  if(!rows.length){
    el.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="et">No finished products yet</div><div class="es">Sync CRM products to start managing website-ready product details.</div></div>`;
    return;
  }
  el.innerHTML=rows.map(row=>{
    const variants=(row.variants||[]).map(v=>`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
        <div>
          <div style="font-weight:600">${esc(v.variant)}</div>
          <div style="font-size:11.5px;color:var(--text-3)">Website price ${money(variantWebsitePrice(v))} · Uses only 50% of ingredient stock</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700">${v.availableUnits}</div>
          <div style="font-size:11px;color:var(--text-3)">units possible</div>
        </div>
      </div>`).join('');
    return `
      <div class="prod-card" style="cursor:pointer" onclick="openFinishedProductModal('${row.crmProductId}')">
        ${row.imageDataUrl?`<div style="margin-bottom:12px"><img src="${row.imageDataUrl}" alt="${esc(row.imageAltText||row.name)}" style="width:100%;height:180px;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--border)"></div>`:''}
        <div class="pc-header">
          <div>
            <div class="pc-name">${esc(row.name)}</div>
            <div class="pc-threshold">${row.isPublished?'Visible to website API':'Hidden from website API'}</div>
          </div>
          <div class="pc-stock">
            <div class="pc-stock-val">${advertisedVariantCount(row)}</div>
            <div class="pc-stock-lbl">advertised variants</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <span class="pill ${row.isPublished?'pg':'pn'}">${row.isPublished?'Published':'Draft'}</span>
          <span class="pill pn">${(row.sizes||[]).length} variant${(row.sizes||[]).length!==1?'s':''}</span>
          <span class="pill pb">${advertisedVariantCount(row)} on website</span>
        </div>
        <div style="font-size:12.5px;color:var(--text-2);min-height:40px">${esc(row.description||'Add a website-ready description and usage notes for this product.')}</div>
        <div style="margin-top:12px">${variants}</div>
      </div>`;
  }).join('');
}

function openFinishedProductModal(id){
  const row=findFinishedProduct(id); if(!row) return;
  _finishedProductImageDataUrl=row.imageDataUrl||'';
  const advertised=new Set(Array.isArray(row.advertisedVariants)?row.advertisedVariants:[]);
  const variantSelectors=(row.variants||[]).map(v=>`
      <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2)">
        <span>
          <span style="font-weight:600;display:block">${esc(v.variant)}</span>
          <span style="font-size:11.5px;color:var(--text-3)">${v.availableUnits} units · Website price ${money(variantWebsitePrice(v))}</span>
        </span>
        <input type="checkbox" class="fp-variant-toggle" value="${esc(v.variant)}" ${advertised.has(v.variant)?'checked':''} style="width:16px;height:16px">
      </label>`).join('');
  const variants=(row.variants||[]).map(v=>{
    const ingredients=(v.ingredients||[]).map(item=>`
      <tr>
        <td style="padding:8px 10px;border-top:1px solid var(--border)">${esc(item.inventoryProductName||item.inventoryProductId)}</td>
        <td style="padding:8px 10px;border-top:1px solid var(--border);text-align:right">${fGrams(item.usableStockGrams)}</td>
        <td style="padding:8px 10px;border-top:1px solid var(--border);text-align:right">${fGrams(item.requiredPerUnitGrams)}</td>
        <td style="padding:8px 10px;border-top:1px solid var(--border);text-align:right">${item.possibleUnits}</td>
      </tr>`).join('');
    return `
      <div class="card" style="margin-top:12px">
        <div class="ch"><div class="ct">${esc(v.variant)} availability</div><div class="pill pb">${v.availableUnits} units</div></div>
        <div class="cb" style="padding-top:12px">
          <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">Calculated from 50% of current raw stock to keep safety reserve for other sales.</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr>
                <th style="text-align:left;padding:0 10px 8px 10px;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Ingredient</th>
                <th style="text-align:right;padding:0 10px 8px 10px;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Usable Stock</th>
                <th style="text-align:right;padding:0 10px 8px 10px;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Needed / Unit</th>
                <th style="text-align:right;padding:0 10px 8px 10px;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Units</th>
              </tr>
            </thead>
            <tbody>${ingredients||`<tr><td colspan="4" style="padding:8px 10px;color:var(--text-3)">No recipe linked in CRM.</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
  openModal(`
    <div class="modal-title">${esc(row.name)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;margin-bottom:16px">
      <span class="pill ${row.isPublished?'pg':'pn'}">${row.isPublished?'Published to website API':'Draft only'}</span>
      <span class="pill pn">${(row.variants||[]).length} variant${(row.variants||[]).length!==1?'s':''}</span>
      <span class="pill pb">${advertisedVariantCount(row)} advertised</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="fg">
        <label>Product Image</label>
        <div id="fp-image-preview-wrap" style="${row.imageDataUrl?'':'display:none;'}">
          <img id="fp-image-preview" src="${row.imageDataUrl||''}" alt="${esc(row.imageAltText||row.name)}" style="width:100%;height:220px;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--border);margin-bottom:8px">
        </div>
        <input type="file" id="fp-image-file" accept="image/*" onchange="handleFinishedProductImage(event)">
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-s btn-sm" type="button" onclick="clearFinishedProductImage()">Remove Image</button>
          <div style="font-size:11.5px;color:var(--text-3)">This image will be returned to the website API.</div>
        </div>
      </div>
      <div class="fg">
        <label>Image Alt Text</label>
        <input id="fp-image-alt" type="text" value="${esc(row.imageAltText||row.name)}" placeholder="Accessible text for the product image">
      </div>
      <div class="fg">
        <label>Product Description</label>
        <textarea id="fp-description" rows="4" placeholder="Describe the product for the website and admin team.">${esc(row.description||'')}</textarea>
      </div>
      <div class="fg">
        <label>How To Make / Use</label>
        <textarea id="fp-usage" rows="4" placeholder="Add brewing instructions, serving notes, or usage guidance.">${esc(row.usageInstructions||'')}</textarea>
      </div>
      <div class="fg">
        <label>Admin Notes</label>
        <textarea id="fp-prep" rows="3" placeholder="Optional internal notes about preparation, packing, or handling.">${esc(row.preparationNotes||'')}</textarea>
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text)">
        <input type="checkbox" id="fp-published" ${row.isPublished?'checked':''} style="width:16px;height:16px">
        Publish this product to the website-facing API
      </label>
      <div class="fg">
        <label>Variants To Advertise</label>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${variantSelectors||`<div style="font-size:12px;color:var(--text-3)">No CRM variants available.</div>`}
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Only selected variants will be returned by the website API with their stock levels.</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="saveFinishedProduct('${row.crmProductId}')">Save Details</button>
        <button class="btn btn-s" onclick="closeModal()">Close</button>
      </div>
    </div>
    ${variants}`);
}

function handleFinishedProductImage(event){
  const file=event?.target?.files?.[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    _finishedProductImageDataUrl=String(reader.result||'');
    const preview=g('fp-image-preview');
    const wrap=g('fp-image-preview-wrap');
    if(preview){
      preview.src=_finishedProductImageDataUrl;
      preview.alt=g('fp-image-alt')?.value||'Product image';
    }
    if(wrap) wrap.style.display='';
  };
  reader.readAsDataURL(file);
}

function clearFinishedProductImage(){
  _finishedProductImageDataUrl='';
  const preview=g('fp-image-preview');
  const wrap=g('fp-image-preview-wrap');
  const input=g('fp-image-file');
  if(preview) preview.src='';
  if(wrap) wrap.style.display='none';
  if(input) input.value='';
}

async function saveFinishedProduct(id){
  const description=g('fp-description')?.value||'';
  const usageInstructions=g('fp-usage')?.value||'';
  const preparationNotes=g('fp-prep')?.value||'';
  const isPublished=!!g('fp-published')?.checked;
  const advertisedVariants=[...document.querySelectorAll('.fp-variant-toggle:checked')].map(el=>el.value);
  const imageAltText=g('fp-image-alt')?.value||'';
  try{
    const updated=await api.put(`/api/finished-products/${id}`,{description,usageInstructions,preparationNotes,isPublished,advertisedVariants,imageDataUrl:_finishedProductImageDataUrl,imageAltText});
    const idx=finishedProducts().findIndex(row=>row.crmProductId===id);
    if(idx>=0) S.finishedProducts[idx]=updated;
    closeModal();
    toast('Finished product saved','ok');
    rFinishedProducts();
  }catch(e){ toast('Error: '+e.message,'err'); }
}

async function syncFinishedProducts(){
  try{
    await api.post('/api/finished-products/sync',{});
    S.finishedProducts=await api.get('/api/finished-products');
    toast('CRM products synced','ok');
    rFinishedProducts();
  }catch(e){ toast('Error: '+e.message,'err'); }
}

// ─── BOOT ────────────────────────────────────────────────────────────────────
async function init(){
  try{ S=await api.get('/api/data'); }
  catch(err){ g('toasts').innerHTML=`<div class="toast err">Cannot reach server: ${err.message}</div>`; return; }
  if(!Array.isArray(S.finishedProducts)) S.finishedProducts=[];
  applyTheme(S?.uiPreferences?.theme||'light');
  rDash();
}
window.addEventListener('DOMContentLoaded', init);
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible') refreshThemePreference();
});
