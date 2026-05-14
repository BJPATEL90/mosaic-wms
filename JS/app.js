'use strict';
/* ═══════════════════════════════════════════════
   LAYER 1 — UTILITIES
═══════════════════════════════════════════════ */


/* ── Toast ── */


/* ── Loader ── */


/* ── Inline result notice ── */


/* ── Days until expiry (handles dd-Mon-yyyy, dd/mm/yyyy, yyyy-mm-dd) ── */
function daysToExp(expStr){
  if(!expStr) return null;
  try{
    let d=new Date(expStr);
    if(isNaN(d)){
      const p=expStr.split(/[\/\-\s]/);
      if(p.length===3) d=new Date(`${p[1]} ${p[0]} ${p[2]}`);
    }
    if(isNaN(d)) return null;
    return Math.ceil((d.getTime()-Date.now())/(86400000));
  }catch(e){ return null; }
}

/* ── Reference number generator ── */
let _seq=ls('seq')||1000;
function nextRef(pfx='ADJ'){ const r=pfx+'-'+String(++_seq).padStart(5,'0'); lss('seq',_seq); return r; }

/* ── Severity classifier ── */
function severity(diff,sysQty){
  if(diff===0) return {lv:'MATCH',cls:'b-ok'};
  const pct=sysQty>0?Math.abs(diff)/sysQty*100:100;
  if(pct<5)  return {lv:'MINOR',cls:'b-info'};
  if(pct<20) return {lv:'MAJOR',cls:'b-warn'};
  return {lv:'CRITICAL',cls:'b-err'};
}

/* ═══════════════════════════════════════════════
   LAYER 2 — API / GAS COMMS
═══════════════════════════════════════════════ */
function gasUrl(){ return ls('gasUrl')||''; }

async function apiCall(action,payload,timeout=15){
  /* Always use fetch() POST to /exec URL.
     google.script.run is NOT used — it only works when HTML is served
     directly by Apps Script doGet(), and requires functions to be
     explicitly exposed. fetch() to /exec works from any context. */
  const url=gasUrl();
  if(!url) return {success:false,message:'GAS_URL_NOT_SET'};

  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),timeout*1000);

  try{
    const r=await fetch(url, {
      method:  'POST',
      headers: {'Content-Type':'text/plain;charset=utf-8'},
      body:    JSON.stringify({action, payload}),
      signal:  ctrl.signal,
      redirect:'follow',
    });
    clearTimeout(tid);
    const t=await r.text();
    try{ return JSON.parse(t); }
    catch(e){ return {success:false,message:'Non-JSON response: '+t.slice(0,120)}; }
  }catch(e){
    clearTimeout(tid);
    const msg=e.name==='AbortError'?'Request timed out ('+timeout+'s)':e.message;
    return {success:false,message:msg};
  }
}

/* syncSheet — single attempt, 12s timeout */
async function syncSheet(action,payload){
  if(!gasUrl()) return {success:false,message:'GAS_URL_NOT_SET'};
  const r=await apiCall(action,payload,12);
  if(r&&r.success) onSyncSuccess();
  return r;
}

/* Manual sync trigger — user can click sync dot to force push */


function openGasModal(){
  $('gas-url-input').value=gasUrl()||'';
  $('gas-status').innerText=gasUrl()?'✅ URL saved':'';
  openModal('modal-gas');
}
function saveGAS(){
  const url=$('gas-url-input').value.trim();
  if(!url){$('gas-status').innerText='⚠ Paste URL first';return;}
  if(!url.includes('script.google.com')){$('gas-status').innerText='⚠ Must be a script.google.com URL';return;}
  if(!url.endsWith('/exec')){$('gas-status').innerText='⚠ URL must end with /exec';return;}
  lss('gasUrl',url);
  $('gas-status').innerText='✅ Saved. Testing…';
  markGasOk(true);
  setTimeout(testGAS,350);
}
async function testGAS(){
  const url=$('gas-url-input').value.trim()||gasUrl();
  if(!url){$('gas-status').innerText='⚠ No URL';return;}
  $('gas-status').innerText='Testing…';
  try{
    // Test via POST (same path real data uses)
    const r=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action:'ping',payload:{}}),
      redirect:'follow',
      signal:AbortSignal.timeout(10000)
    });
    const t=await r.text();
    let ok=false;
    try{ const j=JSON.parse(t); ok=j&&(j.success||j.message==='pong'); }catch(e){ ok=r.ok; }
    $('gas-status').innerText=ok?'✅ Connected! Data will sync to Google Sheet.':'⚠ Reached but unexpected response. Check deployment settings.';
    markGasOk(ok);
    if(ok) lss('gasUrl',$('gas-url-input').value.trim()||gasUrl());
  }catch(e){
    $('gas-status').innerText='❌ '+e.message+'. Make sure Web App access is set to "Anyone".';
    markGasOk(false);
  }
}
function markGasOk(ok){
  const b=$('gasBtn');
  b.style.borderColor=ok?'var(--green)':'';
  b.style.color=ok?'var(--green)':'';
  b.innerText=ok?'✅ Sheet':'⚙ Sheet';
}

/* ═══════════════════════════════════════════════
   LAYER 3 — STATE & INDEX MAPS
═══════════════════════════════════════════════ */
let U={name:'',role:''};
let inventory  = (ls('inv') || []).map(r => ({
  ...r,
  stockType: str(r.stockType||'GOOD').toUpperCase(),
  qty: num(r.qty),
}));
let gatepasses = ls('gp')  || [];
let adjLog     = ls('adj') || [];
let grnLog     = ls('grn') || [];
let skuMaster  = ls('sku') || [];
let binMaster  = ls('bin') || [];
let ccLog      = [];
let ccLines    = [];
let iwRows     = [];

/* Fast index maps — O(1) bin/SKU lookups on 50k+ rows */
const IDX={byBin:{},bySKU:{}};
const GPIDX={byBin:{}};   /* GPIDX.byBin[bin][sku] = [gpRow…] */

function rebuildInvIdx(){
  IDX.byBin={}; IDX.bySKU={};
  inventory.forEach(r=>{
    if(r.bin){ if(!IDX.byBin[r.bin])IDX.byBin[r.bin]=[]; IDX.byBin[r.bin].push(r); }
    if(r.skuCode){ if(!IDX.bySKU[r.skuCode])IDX.bySKU[r.skuCode]=[]; IDX.bySKU[r.skuCode].push(r); }
  });
}
function rebuildGpIdx(){
  GPIDX.byBin={};
  gatepasses.forEach(g=>{
    const b=g.bin||'__ANY__';
    if(!GPIDX.byBin[b])GPIDX.byBin[b]={};
    if(!GPIDX.byBin[b][g.skuCode])GPIDX.byBin[b][g.skuCode]=[];
    GPIDX.byBin[b][g.skuCode].push(g);
  });
}

/* GP qty for a bin+sku+batch (bin-specific + unassigned fallback) */
function gpQtyFor(skuCode,batch,bin){
  let total=0;
  const check=rows=>rows&&rows.forEach(g=>{ if(!g.batch||g.batch===batch) total+=g.qty; });
  if(GPIDX.byBin[bin]) check(GPIDX.byBin[bin][skuCode]);
  if(GPIDX.byBin['__ANY__']) check(GPIDX.byBin['__ANY__'][skuCode]);
  return total;
}
/* GP rows for bottom display table (bin-specific + unassigned) */
function gpRowsFor(skuCode,bin){
  const rows=[];
  if(GPIDX.byBin[bin]&&GPIDX.byBin[bin][skuCode]) rows.push(...GPIDX.byBin[bin][skuCode]);
  if(GPIDX.byBin['__ANY__']&&GPIDX.byBin['__ANY__'][skuCode]) rows.push(...GPIDX.byBin['__ANY__'][skuCode]);
  return rows;
}

function persist(){ lss('inv',inventory); lss('gp',gatepasses); lss('adj',adjLog); }

/* ═══════════════════════════════════════════════
   LAYER 4 — AUTH
═══════════════════════════════════════════════ */
async function doLogin(){
  const uid=str($('lgU').value), pw=str($('lgP').value);
  const err=$('lgErr'), btn=$('lgBtn');
  if(!uid||!pw){ err.innerText='Enter User ID and Password'; return; }
  err.innerText=''; btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span> Signing in…';

  const r=await apiCall('login',{userId:uid,password:pw});
  btn.disabled=false; btn.innerHTML='Sign In';

  if(r&&r.success){ bootUser(r.name||uid,r.role||'OPERATOR'); return; }

  /* Offline fallback */
  const LOCAL=[
    {id:'admin',pw:'admin123',name:'Admin',role:'ADMIN'},
    {id:'wms1', pw:'wms123', name:'WMS 1', role:'OPERATOR'},
    {id:'wms2', pw:'wms123', name:'WMS 2', role:'OPERATOR'},
    {id:'manager',pw:'mgr123',name:'Manager',role:'MANAGER'},
  ];
  const lu=LOCAL.find(u=>u.id===uid&&u.pw===pw);
  if(lu){ bootUser(lu.name,lu.role); return; }
  err.innerText=(r&&r.message&&!r.message.includes('GAS_URL'))?r.message:'Wrong User ID or Password';
}

function bootUser(name,role){
  U={name,role};
  $('unEl').innerText=name;
  $('avEl').innerText=name.charAt(0).toUpperCase();
  $('roleEl').innerText=role;
  $('loginWrap').style.display='none';
  $('app').style.display='block';
  if(window.innerWidth<=768) $('sb-tog').style.display='block';
  rebuildInvIdx(); rebuildGpIdx();
  populateDatalists(); renderSideStats(); renderUploadSummary(); updateInvNav();
  if(adjLog.length){ renderAdjLog(); updateAdjStats(); }
  if(gasUrl()) markGasOk(true);
  startAutoSync();
}
function confirmExit(){
  if(confirm('Exit WMS? Unsaved session data may be lost.')) location.reload();
}

/* ═══════════════════════════════════════════════
   LAYER 5 — NAVIGATION
═══════════════════════════════════════════════ */
function navTo(id,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  const sec=$('s-'+id); if(sec) sec.classList.add('active');
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));
  if(el) el.classList.add('active');
  if(window.innerWidth<=768) $('sidebar').classList.remove('open');
}
function toggleSidebar(){ $('sidebar').classList.toggle('open'); }

/* ═══════════════════════════════════════════════
   LAYER 6 — UPLOAD & PARSING
═══════════════════════════════════════════════ */


function findCol(heads,als){ return heads.find(h=>als.includes(str(h).toLowerCase()))||null; }

const INV_COLS = {
  skuCode:  ['sku code','sku_code','material code','sku','item code'],
  skuName:  ['sku name','sku_name','material name','name','description'],
  batch:    ['batch','batch no','batch_no','lot'],
  bin:      ['bin','shelf','bin / shelf','location','bin/shelf'],
  qty:      ['qty','quantity','units','quantity ordered'],
  stockType:['stock type','type','classification','class'],
  ean:      ['ean','barcode','upc'],
  mfgDate:  ['mfg date','mfg_date','manufacture date','manufactured date'],
  expDate:  ['exp date','exp_date','expiry date','expiry','exp. date'],
  mrp:      ['mrp','price','rate'],
};

const GP_COLS = {
  gpNo:   ['gatepass no','gp no','gatepass number','gp number','gate pass no'],
  date:   ['date','gp date','gatepass date'],
  skuCode:['sku code','sku_code','material code','sku','item code'],
  skuName:['sku name','sku_name','material name','name','description'],
  batch:  ['batch','batch no','batch_no','lot'],
  bin:    ['bin','shelf','bin / shelf','location','bin/shelf'],
  qty:    ['qty','quantity','units'],
  status: ['status','gp status','gatepass status'],
};

function parseExcel(file,cb){
  const r=new FileReader();
  r.onload=e=>{
    try{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',cellDates:true});
      cb(null, XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:'',raw:false,dateNF:'dd-mmm-yyyy'}));
    }catch(err){ cb(err,[]); }
  };
  r.onerror=()=>cb(new Error('File read error'),[]);
  r.readAsArrayBuffer(file);
}

function handleDrop(e,type){
  e.preventDefault(); e.currentTarget.classList.remove('drag');
  const f=e.dataTransfer.files[0]; if(!f)return;
  if(type==='inv') parseInvFile({target:{files:[f]}});
  else if(type==='gp') parseGpFile({target:{files:[f]}});
  else if(type==='iw') parseIwFile({target:{files:[f]}});
}

/* ── Inventory ── */


/* ── Gatepass ── */
function parseGpFile(ev){
  const f=ev.target.files[0]; if(!f)return;
  const msg=$('gp-msg'); msg.innerText='Reading…';
  parseExcel(f,(err,rows)=>{
    if(err){ msg.innerText='❌ '+err.message; toast(err.message,'err'); return; }
    if(!rows.length){ msg.innerText='No rows found'; return; }
    const heads=Object.keys(rows[0]);
    const cm={}; Object.keys(GP_COLS).forEach(k=>cm[k]=findCol(heads,GP_COLS[k]));
    if(!cm.skuCode){ msg.innerText='❌ SKU Code column not found'; return; }
    let added=0;
    rows.forEach(r=>{
      const sku=str(cm.skuCode?r[cm.skuCode]:'');
      const q=num(cm.qty?r[cm.qty]:0);
      if(!sku||q<=0)return;
      gatepasses.push({
        gpNo:   str(cm.gpNo  ?r[cm.gpNo]  :''),
        date:   str(cm.date  ?r[cm.date]  :''),
        skuCode:sku,
        skuName:str(cm.skuName?r[cm.skuName]:''),
        batch:  str(cm.batch ?r[cm.batch] :''),
        bin:    str(cm.bin   ?r[cm.bin]   :''),
        qty:q,
        status: str(cm.status?r[cm.status]:'HOLD'),
      });
      added++;
    });
    persistAndMark(); rebuildGpIdx(); renderSideStats(); renderUploadSummary();
    const noBin=gatepasses.filter(r=>!r.bin).length;
    msg.innerText=`✓ ${added} lines appended (total: ${gatepasses.length})`;
    $('gp-chips').innerHTML=`<span class="chip chip-t">${gatepasses.length} Lines</span><span class="chip chip-err">Blocked: ${gatepasses.reduce((s,r)=>s+r.qty,0).toLocaleString()} units</span>`+(noBin?`<span class="chip chip-warn">⚠ ${noBin} missing Bin</span>`:`<span class="chip chip-ok">✓ All rows have Bin</span>`);
    toast(`${added} GP lines added`,'ok');
    syncSheet('saveGatepasses',gatepasses);
  });
  ev.target.value='';
}


function clearGatepasses(){
  if(!confirm('Clear all gatepass data?'))return;
  gatepasses=[];persistAndMark();rebuildGpIdx();
  $('gp-chips').innerHTML='';$('gp-msg').innerText='Cleared.';
  renderSideStats();renderUploadSummary();
  toast('Gatepasses cleared','warn');
  syncSheet('clearGatepasses',{});
}


/* ── Templates ── */

function dlGpTpl(){
  const ws=XLSX.utils.aoa_to_sheet([
    ['Gatepass No','Date','SKU Code','SKU Name','Batch No','Bin / Shelf','Qty','Status'],
    ['GP-2024-001','15-Jan-2024','MWLJNTP.0003.B0_N','LJ NutriMix 2+ 350gm Chocolate Jar','BATCH001','R14-C1-001',50,'HOLD'],
    ['GP-2024-001','15-Jan-2024','MWBWSKP.00648.B0_N','BB 10% Urea Lotion 200ml','BATCH002','R4-C1-001',30,'HOLD'],
    ['GP-2024-002','16-Jan-2024','MWLJNTP.0003.B0_N','LJ NutriMix 2+ 350gm Chocolate Jar','BATCH001','R14-C2-001',20,'RELEASED'],
  ]);
  ws['!cols']=[{wch:14},{wch:12},{wch:28},{wch:34},{wch:12},{wch:14},{wch:8},{wch:10}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Gatepass Template');XLSX.writeFile(wb,'Gatepass_Template.xlsx');
}

/* ═══════════════════════════════════════════════
   LAYER 7 — CURRENT INVENTORY SECTION
═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   LAYER 8 — CYCLE COUNT
═══════════════════════════════════════════════ */
let _dbt=null;
function onBinInput(){ clearTimeout(_dbt); _dbt=setTimeout(ccByBin,280); }
function onSkuInput(){ clearTimeout(_dbt); _dbt=setTimeout(ccBySKU,280); }

function initCC(){
  populateDatalists();
  $('cc-msg').innerText=inventory.length?'':'⚠ Upload inventory dump first (Upload Data section).';
  updateCcStats(); renderCcLog();
}

function ccByBin(){
  const bin=str($('cc-bin').value); if(!bin)return;
  const rows=IDX.byBin[bin]||[];
  $('cc-msg').innerText='';
  $('cc-add-card').style.display='none';
  $('cc-others-card').style.display='none';
  if(!rows.length){
    $('cc-msg').innerText='📭 No inventory on this shelf.';
    $('cc-lines-card').style.display='none';
    ccLines=[];
    showAddForm(bin,false);
    return;
  }
  const skus=[...new Set(rows.map(r=>r.skuCode))];
  if(skus.length===1) $('cc-sku').value=skus[0];
  loadCcLines(rows,bin);
  showAddForm(bin,true);
}

function ccBySKU(){
  const q=str($('cc-sku').value); if(!q)return;
  const ql=q.toLowerCase();
  const rows=inventory.filter(r=>r.skuCode===q||r.skuCode.toLowerCase().includes(ql)||(r.skuName||'').toLowerCase().includes(ql));
  if(!rows.length){$('cc-msg').innerText='No inventory for: '+q;hideCcLines();return;}
  const bins=[...new Set(rows.map(r=>r.bin))];
  if(bins.length===1) $('cc-bin').value=bins[0];
  $('cc-msg').innerText='';
  loadCcLines(rows,str($('cc-bin').value)||null);
}

function loadCcLines(rows,binFilter){
  const filtered=binFilter?rows.filter(r=>r.bin===binFilter):rows;
  ccLines=filtered.map(r=>({
    bin:r.bin, skuCode:r.skuCode, skuName:r.skuName||'', ean:r.ean||'',
    batch:r.batch||'', mfgDate:r.mfgDate||'', expDate:r.expDate||'',
    stockType:r.stockType||'GOOD',
    systemQty:r.qty,
    gpQty:gpQtyFor(r.skuCode,r.batch,r.bin),
    countedQty:r.qty,
    remarks:''
  }));
  $('cc-lines-card').style.display='block';
  $('cc-bin-lbl').innerText=binFilter||(ccLines.length+' rows');
  renderCcLines();
  renderOthersAndGP();
}
function hideCcLines(){
  $('cc-lines-card').style.display='none';
  $('cc-others-card').style.display='none';
  ccLines=[];
}

function renderCcLines(){
  const body=$('cc-lines-body');
  if(!ccLines.length){body.innerHTML='<tr class="er"><td colspan="14">No inventory on this shelf</td></tr>';return;}
  body.innerHTML=ccLines.map((l,i)=>{
    const net=l.systemQty-l.gpQty;
    const diff=l.countedQty-l.systemQty;
    const sev=severity(diff,l.systemQty);
    const ds=diff<0?'color:var(--red);font-weight:700':diff>0?'color:var(--green);font-weight:700':'color:var(--slate4)';
    const mfgEl=l.mfgDate?`<span class="mono" style="font-size:11px">${esc(l.mfgDate)}</span>`:`<span style="font-size:11px;color:var(--amber);font-weight:600">— missing</span>`;
    const expEl=l.expDate?`<span class="mono" style="font-size:11px">${esc(l.expDate)}</span>`:`<span style="font-size:11px;color:var(--amber);font-weight:600">— missing</span>`;
    return`<tr style="${diff!==0?'background:#fff9f9':''}">
      <td><span class="sku-b" title="${esc(l.skuCode)}">${esc(l.skuCode)}</span></td>
      <td style="font-size:11.5px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.skuName)}">${esc(l.skuName||'—')}</td>
      <td style="font-size:11px;color:var(--slate4)">${esc(l.ean||'—')}</td>
      <td class="mono" style="font-size:11px;font-weight:600">${esc(l.batch||'—')}</td>
      <td>${mfgEl}</td><td>${expEl}</td>
      <td><span class="badge ${l.stockType==='DAMAGE'?'b-err':l.stockType==='BLOCKED'?'b-warn':'b-ok'}" style="font-size:9px">${esc(l.stockType)}</span></td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--indigo)">${l.systemQty.toLocaleString()}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:${l.gpQty>0?'var(--red)':'var(--slate5)'}">
        ${l.gpQty>0?l.gpQty.toLocaleString():'—'}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--teal)">${net.toLocaleString()}</td>
      <td style="text-align:right">
        <input type="number" value="${l.countedQty}" min="0" class="tbl-qty"
          onchange="ccLines[${i}].countedQty=Math.max(0,Number(this.value));renderDiff(${i})">
      </td>
      <td style="text-align:right;font-family:ui-monospace,monospace;min-width:45px" id="d${i}">
        <span style="${ds}">${diff>0?'+':''}${diff}</span></td>
      <td><span class="badge ${sev.cls}" style="font-size:9px">${sev.lv}</span></td>
      <td><input class="ti" placeholder="Remarks…" onchange="ccLines[${i}].remarks=this.value"
        style="width:100px;border:1px solid var(--border);border-radius:4px;font-size:11px;padding:2px 5px"></td>
    </tr>`;
  }).join('');
}

function renderDiff(i){
  if(i<0||i>=ccLines.length)return;
  const diff=ccLines[i].countedQty-ccLines[i].systemQty;
  const sev=severity(diff,ccLines[i].systemQty);
  const ds=diff<0?'color:var(--red);font-weight:700':diff>0?'color:var(--green);font-weight:700':'color:var(--slate4)';
  const c=$('d'+i); if(c) c.innerHTML=`<span style="${ds}">${diff>0?'+':''}${diff}</span>`;
}

/* ── Other shelves + GP table ── */
function renderOthersAndGP(){
  const curBin=str($('cc-bin').value);
  const card=$('cc-others-card'),body=$('cc-others-body');
  const pairs=[...new Set(ccLines.map(l=>`${l.skuCode}|${l.batch}`))];
  let html='';

  pairs.forEach(pair=>{
    const [sku,bat]=pair.split('|');
    const others=inventory.filter(r=>r.skuCode===sku&&r.batch===bat&&r.bin!==curBin);
    const done=new Set(adjLog.filter(a=>a.action==='REMOVE'&&a.skuCode===sku&&a.batch===bat).map(a=>a.bin));
    const gpRows=gpRowsFor(sku,curBin);
    if(!others.length&&!gpRows.length)return;

    html+=`<div>
      <div style="padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="sku-b">${esc(sku)}</span>
        <span style="font-size:11.5px;font-weight:600;color:var(--slate3)">Batch: <b>${esc(bat||'—')}</b></span>
        <span style="font-size:11px;color:var(--teal)">→ Current shelf: <b class="mono">${esc(curBin||'?')}</b></span>
      </div>`;

    if(others.length){
      html+=`<div class="sec-hdr">Similar Batch on Other Shelves — Click "Move" to transfer</div>
      <div class="tw"><table style="font-size:12px">
        <thead><tr style="background:var(--bg)">
          <th style="padding:6px 10px">From Shelf</th><th style="padding:6px 10px">MFG</th>
          <th style="padding:6px 10px">EXP</th>
          <th style="padding:6px 10px;text-align:right">Avail Qty</th>
          <th style="padding:6px 10px">Type</th>
          <th style="padding:6px 10px">Transfer to Current</th>
          <th style="padding:6px 10px">Status</th>
        </tr></thead><tbody>
        ${others.map(r=>{
          const sid=(r.bin+'_'+sku+'_'+(bat||'')).replace(/[^a-z0-9]/gi,'_');
          const moved=done.has(r.bin);
          const removed=adjLog.filter(a=>a.action==='REMOVE'&&a.skuCode===sku&&a.batch===bat&&a.bin===r.bin).reduce((s,a)=>s+Math.abs(a.qty),0);
          const live=Math.max(0,r.qty-removed);
          return`<tr style="${moved?'opacity:.55;background:var(--green-l)':''}">
            <td style="padding:6px 10px"><span class="bin-b">${esc(r.bin)}</span></td>
            <td style="padding:6px 10px;font-size:11px;color:var(--slate4)">${esc(r.mfgDate||'—')}</td>
            <td style="padding:6px 10px;font-size:11px;color:var(--slate4)">${esc(r.expDate||'—')}</td>
            <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--indigo)">${live.toLocaleString()}</td>
            <td style="padding:6px 10px"><span class="badge ${r.stockType==='DAMAGE'?'b-err':'b-ok'}" style="font-size:9px">${esc(r.stockType)}</span></td>
            <td style="padding:6px 10px">
              ${moved?`<span style="color:var(--green);font-weight:600;font-size:11px">✅ Transferred this session</span>`
                :live<=0?`<span style="color:var(--red);font-size:11px">No qty remaining</span>`
                :`<div style="display:flex;align-items:center;gap:6px">
                    <input type="number" id="tq_${sid}" value="${live}" min="1" max="${live}" class="tbl-move">
                    <button class="btn btn-p btn-xs" onclick="doTransfer('${esc(r.bin)}','${esc(curBin)}','${esc(sku)}','${esc(bat||'')}','${esc(r.stockType||'GOOD')}',${live},'${sid}','${esc(r.mfgDate||'')}','${esc(r.expDate||'')}')">Move →</button>
                  </div>`
              }
            </td>
            <td style="padding:6px 10px;font-size:11px;color:var(--slate4)">${moved?'DONE':live<=0?'EMPTY':'AVAILABLE'}</td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`;
    }

    if(gpRows.length){
      const gpTot=gpRows.reduce((s,g)=>s+g.qty,0);
      html+=`<div class="sec-hdr" style="color:var(--amber)">
        Gatepass Details — Bin: <b>${esc(curBin)}</b> &nbsp;|&nbsp; SKU: <b>${esc(sku)}</b>
        <span style="background:var(--red-l);color:var(--red);font-size:10px;padding:1px 8px;border-radius:10px;font-weight:700;margin-left:6px">Total GP Blocked: ${gpTot.toLocaleString()} units</span>
      </div>
      <div class="tw"><table style="font-size:12px">
        <thead><tr style="background:var(--amber-l)">
          <th style="padding:6px 10px">SKU Code</th><th style="padding:6px 10px">SKU Name</th>
          <th style="padding:6px 10px">Batch</th><th style="padding:6px 10px">Gatepass No</th>
          <th style="padding:6px 10px">Date</th>
          <th style="padding:6px 10px;text-align:right">GP Qty</th>
          <th style="padding:6px 10px">Status</th>
        </tr></thead><tbody>
        ${gpRows.map(g=>`<tr class="gp-row">
          <td style="padding:5px 10px"><span class="sku-b" style="font-size:9px">${esc(g.skuCode)}</span></td>
          <td style="padding:5px 10px;font-size:11.5px">${esc(g.skuName||'—')}</td>
          <td style="padding:5px 10px;font-family:ui-monospace,monospace;font-size:11px">${esc(g.batch||'—')}</td>
          <td style="padding:5px 10px;font-family:ui-monospace,monospace;font-size:11px;font-weight:600;color:var(--amber)">${esc(g.gpNo||'—')}</td>
          <td style="padding:5px 10px;font-size:11px">${esc(g.date||'—')}</td>
          <td style="padding:5px 10px;text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--red)">${g.qty.toLocaleString()}</td>
          <td style="padding:5px 10px"><span class="badge b-warn" style="font-size:9px">${esc(g.status||'HOLD')}</span></td>
        </tr>`).join('')}
        </tbody></table></div>`;
    }
    html+=`</div><hr style="border:none;border-top:1px solid var(--border)">`;
  });

  if(html){card.style.display='block';body.innerHTML=html;}
  else card.style.display='none';
}

/* ── Add Stock Form ── */
function showAddForm(bin,isPartial){
  const card=$('cc-add-card');
  card.style.display='block';
  $('cc-add-lbl').innerText=bin;
  const notice=$('cc-add-notice');
  if(isPartial){
    notice.className='notice n-info';
    notice.innerHTML=`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Add additional stock to this shelf (new batch or different SKU).`;
  } else {
    notice.className='notice n-ok';
    notice.innerHTML=`<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>No stock on this shelf — enter details to add new stock.`;
  }
  ['ns-ean','ns-sku','ns-name','ns-batch','ns-qty'].forEach(id=>{const el=$(id);if(el)el.value='';});
  $('ns-mfg').value=''; $('ns-exp').value=''; $('ns-type').value='GOOD';
  ['ns-name-h','ns-mfg-h','ns-exp-h','ns-msg'].forEach(id=>{const el=$(id);if(el)el.innerText='';});
}

function nsEAN(){
  const ean=str($('ns-ean').value); if(!ean)return;
  const r=inventory.find(x=>x.ean===ean);
  if(r){
    $('ns-sku').value=r.skuCode; $('ns-name').value=r.skuName||''; $('ns-name-h').innerText='(from inventory)';
    if(r.mfgDate){$('ns-mfg').value=r.mfgDate;$('ns-mfg-h').innerText='(auto)';}
    if(r.expDate){$('ns-exp').value=r.expDate;$('ns-exp-h').innerText='(auto)';}
  }
}
function nsSKU(){
  const code=str($('ns-sku').value); if(!code)return;
  const r=inventory.find(x=>x.skuCode===code&&(x.mfgDate||x.expDate));
  if(r){
    if(!$('ns-name').value){$('ns-name').value=r.skuName||'';$('ns-name-h').innerText='(from inventory)';}
    if(r.mfgDate){$('ns-mfg').value=r.mfgDate;$('ns-mfg-h').innerText='(auto)';}
    if(r.expDate){$('ns-exp').value=r.expDate;$('ns-exp-h').innerText='(auto)';}
  }
}

async function saveNewStock(){
  const bin=str($('cc-bin').value);
  const skuCode=str($('ns-sku').value);
  const skuName=str($('ns-name').value);
  const batch=str($('ns-batch').value);
  const mfgDate=str($('ns-mfg').value);
  const expDate=str($('ns-exp').value);
  const qty=num($('ns-qty').value);
  const stockType=str($('ns-type').value)||'GOOD';
  const ean=str($('ns-ean').value);
  const msgEl=$('ns-msg');

  if(!bin)    {msgEl.innerText='Search a shelf first';return;}
  if(!skuCode){msgEl.innerText='SKU Code required';return;}
  if(!batch)  {msgEl.innerText='Batch No required';return;}
  if(qty<=0)  {msgEl.innerText='Qty must be > 0';return;}
  msgEl.innerText='';

  const ex=inventory.find(r=>r.bin===bin&&r.skuCode===skuCode&&r.batch===batch&&r.stockType===stockType);
  if(ex){ex.qty+=qty;}else{inventory.push({bin,skuCode,skuName,batch,mfgDate,expDate,stockType,qty,ean});}
  persistAndMark(); rebuildInvIdx();

  const refNo=nextRef('ADD');
  const now=new Date().toISOString();
  adjLog.push({refNo,time:now,bin,skuCode,skuName,batch,mfgDate,expDate,stockType,qty:+qty,action:'ADD',ref:'New stock — Cycle Count',by:U.name});
  persistAndMark(); renderAdjLog(); updateAdjStats(); renderSideStats(); updateInvNav();

  showResult('cc-result',`✅ Added ${qty} units of ${skuCode} (${batch}) to ${bin} — Ref: ${refNo}`,'ok');
  toast(`Added ${qty} units to ${bin}`,'ok');
  $('ns-qty').value='';

  // Rebuild index first so ccByBin() sees the new stock immediately
  rebuildInvIdx(); rebuildGpIdx();
  ccByBin();

  // Sheet sync fire-and-forget
  if(gasUrl()){
    Promise.all([
      syncSheet('uploadInventoryDump', inventory),
      syncSheet('saveAdjustment', adjLog)
    ]).then(([r1,r2])=>{
      if(r1&&r1.success&&r2&&r2.success){ onSyncSuccess(); toast('✅ New stock synced to Sheet','ok',2000); }
      else toast('⚠ Sheet sync failed — will retry on next auto-save','warn');
    });
  }
}

/* ── Transfer between shelves ── */
async function doTransfer(fromBin,toBin,sku,batch,stockType,maxQty,sid,mfgDate,expDate){
  if(!toBin){toast('Set destination shelf first','warn');return;}
  const qEl=$('tq_'+sid);
  const moveQty=qEl?Math.min(Math.max(0,num(qEl.value)),maxQty):maxQty;
  if(moveQty<=0){toast('Enter qty > 0','warn');return;}
  if(moveQty>maxQty){toast('Cannot move more than '+maxQty,'warn');return;}
  if(fromBin===toBin){toast('Same shelf','warn');return;}
  if(!confirm(`Move ${moveQty} units\nSKU: ${sku}\nBatch: ${batch}\nFrom: ${fromBin}\nTo:   ${toBin}\n\nConfirm?`))return;

  const now=new Date().toISOString();
  const refNo=nextRef('TRF');

  let rem=moveQty;
  inventory.forEach(r=>{
    if(r.bin===fromBin&&r.skuCode===sku&&r.batch===batch&&r.stockType===stockType&&rem>0){
      const cut=Math.min(rem,r.qty); r.qty-=cut; rem-=cut;
    }
  });
  inventory=inventory.filter(r=>r.qty>0);

  const ex=inventory.find(r=>r.bin===toBin&&r.skuCode===sku&&r.batch===batch&&r.stockType===stockType);
  if(ex){ex.qty+=moveQty;}
  else{
    const src=inventory.find(r=>r.skuCode===sku&&r.batch===batch)||{};
    inventory.push({bin:toBin,skuCode:sku,skuName:src.skuName||sku,batch,stockType,qty:moveQty,
      mfgDate:mfgDate||src.mfgDate||'',expDate:expDate||src.expDate||'',ean:src.ean||''});
  }
  persistAndMark(); rebuildInvIdx(); rebuildGpIdx();

  const skuName=inventory.find(r=>r.skuCode===sku)?.skuName||sku;
  adjLog.push({refNo,time:now,bin:fromBin,skuCode:sku,skuName,batch,mfgDate,expDate,stockType,qty:-moveQty,action:'REMOVE',ref:`Transfer to ${toBin} [${refNo}]`,by:U.name});
  adjLog.push({refNo,time:now,bin:toBin,  skuCode:sku,skuName,batch,mfgDate,expDate,stockType,qty:+moveQty,action:'ADD',   ref:`Transfer from ${fromBin} [${refNo}]`,by:U.name});
  persistAndMark(); renderAdjLog(); updateAdjStats(); renderSideStats(); updateInvNav();

  showResult('cc-result',`✅ Moved ${moveQty} units: ${fromBin} → ${toBin} [Ref: ${refNo}]`,'ok');
  toast(`Moved ${moveQty} units from ${fromBin} → ${toBin}`,'ok');

  // Refresh shelf view AFTER index is rebuilt — so qty shows correctly
  ccByBin();

  // Sheet sync fire-and-forget — never blocks the UI
  if(gasUrl()){
    Promise.all([
      syncSheet('uploadInventoryDump', inventory),
      syncSheet('saveAdjustment', adjLog)
    ]).then(([r1,r2])=>{
      if(r1&&r1.success&&r2&&r2.success){ onSyncSuccess(); toast('✅ Transfer synced to Sheet','ok',2000); }
      else toast('⚠ Sheet sync partial — will retry on next auto-save','warn');
    });
  }
}

/* ── Save Count ── */
async function saveCountLines(){
  if(!ccLines.length){toast('No count lines to save','warn');return;}
  const now=new Date().toISOString();
  const entries=ccLines.map(l=>{
    const diff=l.countedQty-l.systemQty;
    const sev=severity(diff,l.systemQty);
    return{_id:Date.now()+Math.random(),time:now,bin:l.bin,skuCode:l.skuCode,skuName:l.skuName||'',batch:l.batch,
      systemQty:l.systemQty,countedQty:l.countedQty,diff,
      mfgDate:l.mfgDate,expDate:l.expDate,stockType:l.stockType||'GOOD',
      gpQty:l.gpQty||0,remarks:l.remarks||'',by:U.name,severity:sev.lv};
  });
  entries.forEach(e=>ccLog.push(e));
  updateCcStats(); renderCcLog();
  const diffs=entries.filter(e=>e.diff!==0).length;
  showResult('cc-result',`Count saved — ${entries.length} line(s), ${diffs} difference(s).`,diffs?'warn':'ok');
  toast(`Count saved: ${diffs} diff(s)`,diffs?'warn':'ok');
  // Sheet sync is fire-and-forget — never blocks the UI
  if(gasUrl()){
    syncSheet('saveCycleCount',entries).then(r=>{
      if(r&&r.success){ onSyncSuccess(); toast('✅ Count synced to Sheet','ok',2000); }
      else if(r&&r.message&&!r.message.includes('GAS_URL')) toast('⚠ Sheet sync: '+r.message,'warn');
    });
  }
}

function updateCcStats(){
  $('cc-saved').innerText=ccLog.length;
  $('cc-match').innerText=ccLog.filter(l=>l.diff===0).length;
  $('cc-diffs').innerText=ccLog.filter(l=>l.diff!==0).length;
}

function renderCcLog(){
  const body=$('cc-log-body');
  if(!ccLog.length){body.innerHTML='<tr class="er"><td colspan="16">No count entries yet</td></tr>';return;}
  body.innerHTML=[...ccLog].reverse().map(l=>{
    const dt=new Date(l.time);
    const diff=Number(l.diff||0);
    const ds=diff<0?'color:var(--red);font-weight:700':diff>0?'color:var(--green);font-weight:700':'';
    const lv=l.severity||severity(diff,l.systemQty).lv;
    const lc={MATCH:'b-ok',MINOR:'b-info',MAJOR:'b-warn',CRITICAL:'b-err'}[lv]||'b-info';
    // Use _id for safe lookup — immune to array reordering
    const safeId=String(l._id||'').replace(/[^a-z0-9]/gi,'');
    return`<tr>
      <td style="font-size:11px;white-space:nowrap">${dt.toLocaleDateString('en-IN')}</td>
      <td style="font-size:11px;white-space:nowrap">${dt.toLocaleTimeString('en-IN')}</td>
      <td><span class="bin-b" style="font-size:10px">${esc(l.bin)}</span></td>
      <td><span class="sku-b" style="font-size:9px">${esc(l.skuCode)}</span></td>
      <td class="mono" style="font-size:11px">${esc(l.batch||'—')}</td>
      <td style="font-size:11px">${esc(l.mfgDate||'—')}</td>
      <td style="font-size:11px">${esc(l.expDate||'—')}</td>
      <td><span class="badge b-ok" style="font-size:9px">${esc(l.stockType||'GOOD')}</span></td>
      <td style="text-align:right;font-family:ui-monospace,monospace">${l.systemQty}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;color:var(--amber)">${l.gpQty||0}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700">${l.countedQty}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace"><span style="${ds}">${diff>0?'+':''}${diff}</span></td>
      <td><span class="badge ${lc}" style="font-size:9px">${lv}</span></td>
      <td style="font-size:11px;color:var(--slate4)">${esc(l.remarks||'—')}</td>
      <td style="font-size:11px">${esc(l.by||'—')}</td>
      <td>
        <button class="btn btn-g btn-xs" onclick="openCcEditById('${safeId}')" title="Edit this entry"
          style="padding:2px 7px;font-size:10px">✏</button>
      </td>
    </tr>`;
  }).join('');
}

function clearCcSession(){
  if(!confirm('Clear count log for this session?'))return;
  ccLog=[];updateCcStats();renderCcLog();toast('Count session cleared','warn');
}

/* ── Count Log Edit ── */
let _editIdx = -1;  // index into ccLog being edited

function openCcEditById(id){
  // Find entry by _id string — safe regardless of sort order
  const idx = ccLog.findIndex(l=>String(l._id||'').replace(/[^a-z0-9]/gi,'')===id);
  if(idx<0){ toast('Entry not found — may have been deleted','warn'); return; }
  openCcEdit(idx);
}

function openCcEdit(idx){
  if(idx<0||idx>=ccLog.length)return;
  _editIdx = idx;
  const l = ccLog[idx];
  $('ec-bin').innerText   = l.bin      || '—';
  $('ec-sku').innerText   = l.skuCode  || '—';
  $('ec-batch').innerText = l.batch    || '—';
  $('ec-sysqty').innerText= l.systemQty;
  $('ec-counted').value   = l.countedQty;
  $('ec-remarks').value   = l.remarks  || '';
  // Show diff preview on load
  updateEditPreview();
  // Update preview live as user types
  $('ec-counted').oninput = updateEditPreview;
  openModal('modal-cc-edit');
}

function updateEditPreview(){
  if(_editIdx<0)return;
  const sysQty = ccLog[_editIdx].systemQty;
  const counted = Number($('ec-counted').value)||0;
  const diff    = counted - sysQty;
  const sev     = severity(diff, sysQty);
  const ds      = diff<0?'color:var(--red)':diff>0?'color:var(--green)':'color:var(--slate4)';
  const sevCls  = {MATCH:'b-ok',MINOR:'b-info',MAJOR:'b-warn',CRITICAL:'b-err'}[sev.lv]||'b-info';
  $('ec-preview').style.display = 'block';
  $('ec-diff-preview').innerHTML = `<span style="${ds}">${diff>0?'+':''}${diff}</span>`;
  $('ec-sev-preview').innerHTML  = `<span class="badge ${sevCls}" style="font-size:9px">${sev.lv}</span>`;
}

async function saveCcEdit(){
  if(_editIdx<0||_editIdx>=ccLog.length)return;
  const newCounted = Number($('ec-counted').value);
  if(isNaN(newCounted)||newCounted<0){ toast('Enter a valid counted qty','warn'); return; }

  const l       = ccLog[_editIdx];
  const oldQty  = l.countedQty;
  const newDiff = newCounted - l.systemQty;
  const newSev  = severity(newDiff, l.systemQty);

  // Ensure _id exists for future lookups
  if(!l._id) l._id = Date.now()+Math.random();
  // Apply edit
  l.countedQty  = newCounted;
  l.diff        = newDiff;
  l.severity    = newSev.lv;
  l.remarks     = str($('ec-remarks').value);
  l.editedAt    = new Date().toISOString();
  l.editedBy    = U.name;

  closeModal('modal-cc-edit');
  updateCcStats();
  renderCcLog();
  toast(`Entry updated — Counted: ${oldQty} → ${newCounted}, Diff: ${newDiff>0?'+':''}${newDiff}`,'ok');

  // Push updated log to sheet
  if(gasUrl()){
    syncSheet('saveCycleCount', ccLog).then(r=>{
      if(r&&r.success) toast('✅ Updated log synced to Sheet','ok',2000);
    });
  }
}

async function deleteCcEntry(){
  if(_editIdx<0||_editIdx>=ccLog.length)return;
  const l = ccLog[_editIdx];
  if(!confirm(`Delete this count entry?

Bin: ${l.bin}
SKU: ${l.skuCode}
Batch: ${l.batch}
Counted: ${l.countedQty}

This cannot be undone.`))return;

  ccLog.splice(_editIdx, 1);
  _editIdx = -1;
  closeModal('modal-cc-edit');
  updateCcStats();
  renderCcLog();
  toast('Entry deleted','warn');

  // Sync updated log
  if(gasUrl()){
    syncSheet('saveCycleCount', ccLog).then(r=>{
      if(r&&r.success) toast('✅ Deletion synced to Sheet','ok',2000);
    });
  }
}

function exportCcXLSX(){
  if(!ccLog.length){toast('No count log to export','warn');return;}
  const ws=XLSX.utils.json_to_sheet(ccLog.map(l=>({
    'Date':new Date(l.time).toLocaleDateString('en-IN'),'Time':new Date(l.time).toLocaleTimeString('en-IN'),
    'Bin/Shelf':l.bin,'SKU Code':l.skuCode,'SKU Name':l.skuName||'','Batch No':l.batch,
    'MFG Date':l.mfgDate||'','EXP Date':l.expDate||'','Stock Type':l.stockType||'GOOD',
    'System Qty':l.systemQty,'GP Qty':l.gpQty||0,'Counted Qty':l.countedQty,
    'Difference':l.diff,'Severity':l.severity||'','Remarks':l.remarks||'','By':l.by
  })));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Cycle Count');XLSX.writeFile(wb,'Cycle_Count_Log.xlsx');
  toast('Count log exported','ok');
}

/* ═══════════════════════════════════════════════
   LAYER 9 — ADJUSTMENT LOG
═══════════════════════════════════════════════ */
function renderAdjLog(){
  const body=$('adj-body');
  const q=str(($('adj-q')&&$('adj-q').value)||'').toLowerCase();
  const af=str(($('adj-act')&&$('adj-act').value)||'');
  const filtered=adjLog.filter(l=>{
    if(af&&l.action!==af)return false;
    if(q&&!`${l.bin||''} ${l.skuCode||''} ${l.batch||''} ${l.ref||''}`.toLowerCase().includes(q))return false;
    return true;
  });
  if(!filtered.length){body.innerHTML='<tr class="er"><td colspan="14">No adjustments'+(q||af?' match filter':'yet')+'</td></tr>';return;}
  body.innerHTML=[...filtered].reverse().map(l=>{
    const dt=new Date(l.time);
    const isRem=l.action==='REMOVE';
    return`<tr style="${isRem?'background:var(--red-l)':'background:var(--green-l)'}">
      <td class="mono" style="font-size:10px;color:var(--slate4)">${esc(l.refNo||'—')}</td>
      <td style="font-size:11px;white-space:nowrap">${dt.toLocaleDateString('en-IN')}</td>
      <td style="font-size:11px;white-space:nowrap">${dt.toLocaleTimeString('en-IN')}</td>
      <td><span class="bin-b" style="font-size:10px">${esc(l.bin)}</span></td>
      <td><span class="sku-b" style="font-size:9px">${esc(l.skuCode)}</span></td>
      <td style="font-size:11px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.skuName||'—')}</td>
      <td class="mono" style="font-size:11px">${esc(l.batch||'—')}</td>
      <td style="font-size:11px">${esc(l.mfgDate||'—')}</td>
      <td style="font-size:11px">${esc(l.expDate||'—')}</td>
      <td><span class="badge ${l.stockType==='DAMAGE'?'b-err':'b-ok'}" style="font-size:9px">${esc(l.stockType)}</span></td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:${isRem?'var(--red)':'var(--green)'}">
        ${isRem?'':'+'} ${Math.abs(Number(l.qty||0)).toLocaleString()}</td>
      <td><span class="badge ${isRem?'b-err':'b-ok'}" style="font-size:10px">${esc(l.action)}</span></td>
      <td style="font-size:11px;color:var(--slate4);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.ref||'—')}</td>
      <td style="font-size:11px">${esc(l.by||'—')}</td>
    </tr>`;
  }).join('');
}

function updateAdjStats(){
  const rm=adjLog.filter(l=>l.action==='REMOVE').length;
  const ad=adjLog.filter(l=>l.action==='ADD').length;
  $('adj-total').innerText=adjLog.length;
  $('adj-rem').innerText=rm;
  $('adj-add').innerText=ad;
  $('adj-skus').innerText=new Set(adjLog.map(l=>l.skuCode)).size;
  $('side-adj').innerText=adjLog.length.toLocaleString();
  $('nav-adj-ct').innerText=adjLog.length||'';
}

function exportAdjXLSX(){
  if(!adjLog.length){toast('No adjustment log','warn');return;}
  const ws=XLSX.utils.json_to_sheet(adjLog.map(l=>({
    'Ref No':l.refNo||'','Date':new Date(l.time).toLocaleDateString('en-IN'),
    'Time':new Date(l.time).toLocaleTimeString('en-IN'),
    'Bin/Shelf':l.bin,'SKU Code':l.skuCode,'SKU Name':l.skuName||'','Batch No':l.batch,
    'MFG Date':l.mfgDate||'','EXP Date':l.expDate||'','Stock Type':l.stockType,
    'Qty Moved':l.qty,'Action':l.action,'Reference':l.ref||'','By':l.by
  })));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Adjustment Log');XLSX.writeFile(wb,'Adjustment_Log.xlsx');
  toast('Adjustment log exported','ok');
}

async function clearAdj(){
  if(!confirm('Clear all adjustment log entries? This cannot be undone.'))return;
  adjLog=[];persistAndMark();renderAdjLog();updateAdjStats();renderSideStats();
  toast('Adjustment log cleared','warn');
  await syncSheet('saveAdjustment',[]);
}

/* ═══════════════════════════════════════════════
   LAYER 10 — INWIRE CHECK
═══════════════════════════════════════════════ */
function parseIwFile(ev){
  const f=ev.target.files[0]; if(!f)return;
  const msg=$('iw-msg'); msg.innerText='Reading…';
  parseExcel(f,(err,rows)=>{
    if(err){msg.innerText='❌ '+err.message;toast(err.message,'err');return;}
    if(!rows.length){msg.innerText='No rows found';return;}
    const heads=Object.keys(rows[0]);
    const cm={}; Object.keys(INV_COLS).forEach(k=>cm[k]=findCol(heads,INV_COLS[k]));
    if(!cm.skuCode||!cm.qty){msg.innerText='❌ SKU Code and Qty columns required';return;}

    /* Build upload map */
    const uMap={};
    rows.forEach(r=>{
      const sku=str(cm.skuCode?r[cm.skuCode]:'');
      const q=num(cm.qty?r[cm.qty]:0);
      if(!sku||q<=0)return;
      const bin=str(cm.bin?r[cm.bin]:'');
      const batch=str(cm.batch?r[cm.batch]:'');
      const type=str(cm.stockType?r[cm.stockType]:'GOOD').toUpperCase()||'GOOD';
      const key=`${bin}|${sku}|${batch}|${type}`;
      if(!uMap[key])uMap[key]={bin,skuCode:sku,skuName:str(cm.skuName?r[cm.skuName]:''),batch,stockType:type,mfgDate:str(cm.mfgDate?r[cm.mfgDate]:''),expDate:str(cm.expDate?r[cm.expDate]:''),qty:0};
      uMap[key].qty+=q;
    });

    /* Build working map */
    const wMap={};
    inventory.forEach(r=>{
      const key=`${r.bin}|${r.skuCode}|${r.batch}|${r.stockType}`;
      if(!wMap[key])wMap[key]={...r,qty:0};
      wMap[key].qty+=r.qty;
    });

    /* Compare */
    const allKeys=new Set([...Object.keys(wMap),...Object.keys(uMap)]);
    iwRows=[];
    allKeys.forEach(key=>{
      const w=wMap[key],u=uMap[key];
      const wQ=w?w.qty:0,uQ=u?u.qty:0,gap=wQ-uQ;
      const [bin,skuCode,batch,stockType]=key.split('|');
      const skuName=(w||u).skuName||'';
      const mfgDate=(w||u).mfgDate||'';
      const expDate=(w||u).expDate||'';
      let gapType,cause,rowClass;
      if(wQ<0)             {gapType='NEGATIVE';cause='Over-removed — working qty below zero';rowClass='diff-neg';}
      else if(wQ>0&&uQ===0){gapType='REMOVE';  cause='In working but not in upload — transferred out, depleted or error';rowClass='diff-rem';}
      else if(wQ===0&&uQ>0){gapType='ADD';      cause='In upload but not in working — new batch, not reflected in session';rowClass='diff-add';}
      else if(gap!==0)     {gapType='DIFF';     cause=gap>0?`Working has ${gap} MORE — CC addition or over-count`:`Working has ${Math.abs(gap)} LESS — transferred away or short count`;rowClass='diff-add';}
      else                 {gapType='MATCH';    cause='Exact match';rowClass='';}
      iwRows.push({bin,skuCode,skuName,batch,mfgDate,expDate,stockType,wQty:wQ,uQty:uQ,gap,gapType,cause,rowClass});
    });

    iwRows.sort((a,b)=>{
      const o={NEGATIVE:0,REMOVE:1,ADD:2,DIFF:3,MATCH:4};
      return (o[a.gapType]||99)-(o[b.gapType]||99)||(a.bin||'').localeCompare(b.bin||'')||(a.skuCode||'').localeCompare(b.skuCode||'');
    });

    const adds=iwRows.filter(r=>r.gapType==='ADD').length;
    const rems=iwRows.filter(r=>r.gapType==='REMOVE').length;
    const diffs=iwRows.filter(r=>r.gapType==='DIFF').length;
    const negs=iwRows.filter(r=>r.gapType==='NEGATIVE').length;
    const matches=iwRows.filter(r=>r.gapType==='MATCH').length;

    $('iw-add').innerText=adds;$('iw-rem').innerText=rems;
    $('iw-diff').innerText=diffs;$('iw-neg').innerText=negs;$('iw-match').innerText=matches;
    $('iw-stats-wrap').style.display='block';
    msg.innerText=`✓ Compared ${allKeys.size} combinations from ${f.name}. ${adds+rems+diffs+negs} gaps found.`;
    showResult('iw-result',`${adds} ADD | ${rems} REMOVE | ${diffs} DIFF | ${negs} NEGATIVE | ${matches} MATCH`,'info');
    renderIwTable();
    toast(`${adds+rems+diffs+negs} gaps found`,adds+rems+diffs+negs>0?'warn':'ok');
  });
  ev.target.value='';
}

function renderIwTable(){
  const body=$('iw-body');
  const hideMatch=$('iw-hide-match')&&$('iw-hide-match').checked;
  const tf=str(($('iw-ftype')&&$('iw-ftype').value)||'');
  let rows=iwRows;
  if(hideMatch)rows=rows.filter(r=>r.gapType!=='MATCH');
  if(tf)rows=rows.filter(r=>r.gapType===tf);
  if(!rows.length){body.innerHTML='<tr class="er"><td colspan="12">'+(hideMatch?'No gaps — all exact match!':'Upload a file to see gaps')+'</td></tr>';return;}
  const gc={ADD:'b-ok',REMOVE:'b-err',DIFF:'b-warn',NEGATIVE:'b-err',MATCH:'b-info'};
  body.innerHTML=rows.map(r=>{
    const gs=r.gap>0?'+'+r.gap:String(r.gap);
    return`<tr class="${r.rowClass||''}">
      <td><span class="bin-b" style="font-size:10px">${esc(r.bin||'—')}</span></td>
      <td><span class="sku-b" style="font-size:9px">${esc(r.skuCode)}</span></td>
      <td style="font-size:11.5px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.skuName)}">${esc(r.skuName||'—')}</td>
      <td class="mono" style="font-size:11px">${esc(r.batch||'—')}</td>
      <td style="font-size:11px">${esc(r.mfgDate||'—')}</td>
      <td style="font-size:11px">${esc(r.expDate||'—')}</td>
      <td><span class="badge ${r.stockType==='DAMAGE'?'b-err':'b-ok'}" style="font-size:9px">${esc(r.stockType)}</span></td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--indigo)">${r.wQty.toLocaleString()}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--teal)">${r.uQty.toLocaleString()}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:${r.gap<0?'var(--green)':r.gap>0?'var(--red)':'var(--slate4)'}">
        ${r.gapType==='MATCH'?'—':gs}</td>
      <td><span class="badge ${gc[r.gapType]||''}" style="font-size:9px">${r.gapType}</span></td>
      <td style="font-size:11px;color:var(--slate4);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.cause)}">${esc(r.cause)}</td>
    </tr>`;
  }).join('');
}

function exportIwXLSX(){
  if(!iwRows.length){toast('No inwire data — upload file first','warn');return;}
  const ws=XLSX.utils.json_to_sheet(iwRows.map(r=>({
    'Bin/Shelf':r.bin,'SKU Code':r.skuCode,'SKU Name':r.skuName,'Batch No':r.batch,
    'MFG Date':r.mfgDate,'EXP Date':r.expDate,'Stock Type':r.stockType,
    'Working Qty':r.wQty,'Upload Qty':r.uQty,'Gap':r.gap,'Gap Type':r.gapType,'Likely Cause':r.cause
  })));
  ws['!cols']=[{wch:14},{wch:28},{wch:34},{wch:14},{wch:12},{wch:12},{wch:10},{wch:12},{wch:12},{wch:8},{wch:10},{wch:45}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Inwire Check');XLSX.writeFile(wb,'Inwire_Check_Gaps.xlsx');
  toast('Inwire check exported','ok');
}


/* ═══════════════════════════════════════════════
   SYNC STATUS BAR + AUTO-SYNC + EXIT WARNING
═══════════════════════════════════════════════ */
let _dirty      = false;
let _lastSync   = null;
let _syncTimer  = null;
let _snapTimer  = null;
let _tickTimer  = null;

/* Called after every persist() — mark as dirty */

function persistAndMark(){
  lss('inv',inventory); lss('gp',gatepasses); lss('adj',adjLog);
  _dirty = true;
  updateSyncBar();
}

function updateSyncBar(){
  const bar=$('sync-bar'), dot=$('sync-dot'), txt=$('sync-txt');
  if(!bar) return;
  bar.style.display='flex';
  if(!gasUrl()){
    dot.style.background='#94a3b8'; // grey — no URL
    txt.innerText='No Sheet connected';
    bar.style.borderColor='transparent';
    return;
  }
  if(_dirty){
    dot.style.background='#f59e0b'; // amber — unsynced
    txt.innerText='Unsaved changes';
    bar.style.borderColor='rgba(245,158,11,.3)';
  } else if(_lastSync){
    dot.style.background='#22c55e'; // green — synced
    txt.innerText='Synced '+timeSince(_lastSync);
    bar.style.borderColor='rgba(34,197,94,.3)';
  } else {
    dot.style.background='#94a3b8'; // grey — not yet synced
    txt.innerText='Not synced yet';
    bar.style.borderColor='transparent';
  }
}

function timeSince(date){
  const s=Math.floor((Date.now()-date)/1000);
  if(s<10)  return 'just now';
  if(s<60)  return s+'s ago';
  if(s<3600)return Math.floor(s/60)+'min ago';
  return Math.floor(s/3600)+'h ago';
}

function onSyncSuccess(){
  _dirty=false;
  _lastSync=new Date();
  updateSyncBar();
}

async function manualSync(){
  if(!gasUrl()){ toast('Set GAS URL first — click ⚙ Sheet','warn'); return; }
  if(!_dirty && _lastSync){ toast('Already in sync ✅','ok',2000); return; }
  toast('Pushing to Google Sheet…','info',2000);
  const jobs=[];
  if(inventory.length)  jobs.push(syncSheet('uploadInventoryDump',inventory));
  if(adjLog.length)     jobs.push(syncSheet('saveAdjustment',adjLog));
  if(gatepasses.length) jobs.push(syncSheet('saveGatepasses',gatepasses));
  if(!jobs.length){ toast('Nothing to sync','info',2000); return; }
  const results=await Promise.all(jobs);
  const allOk=results.every(r=>r&&r.success);
  if(allOk){ onSyncSuccess(); toast('✅ All data synced to Google Sheet','ok'); }
  else toast('⚠ Some syncs failed — check Sheet connection','warn');
}

/* Auto-save adj log every 5 min */
async function autoSaveAdj(){
  if(!adjLog.length||!gasUrl()||!_dirty) return;
  const r=await syncSheet('saveAdjustment',adjLog);
  if(r&&r.success){ onSyncSuccess(); toast('Auto-saved ✅','ok',2000); }
}

/* Auto-snapshot inventory every 10 min */
async function autoSnapInv(){
  if(!inventory.length||!gasUrl()||!_dirty) return;
  const r=await syncSheet('uploadInventoryDump',inventory);
  if(r&&r.success){ onSyncSuccess(); toast('Auto-snapshot ✅','ok',2000); }
}

function startAutoSync(){
  clearInterval(_syncTimer); _syncTimer=setInterval(autoSaveAdj,5*60*1000);
  clearInterval(_snapTimer); _snapTimer=setInterval(autoSnapInv,10*60*1000);
  clearInterval(_tickTimer); _tickTimer=setInterval(updateSyncBar,30*1000);
  updateSyncBar();
}

/* Warn before closing tab if unsynced */
window.addEventListener('beforeunload',function(e){
  if(!_dirty) return;
  const m='You have unsynced changes. Leave?';
  e.preventDefault(); e.returnValue=m; return m;
});

/* ═══════════════════════════════════════════════════════
   WMS MODULE — DASHBOARD
═══════════════════════════════════════════════════════ */
function loadDashboard(){
  // Normalize any legacy inventory rows
  inventory = inventory.map(r => ({
    ...r,
    stockType: str(r.stockType||'GOOD').toUpperCase(),
    qty: num(r.qty),
  }));

  // Stats from local state
  const totalQty  = inventory.reduce((s,r)=>s+r.qty,0);
  const goodQty   = inventory.filter(r=>{ const t = str(r.stockType||'GOOD').toUpperCase(); return t==='GOOD'; }).reduce((s,r)=>s+r.qty,0);
  const dmgQty    = inventory.filter(r=>{ const t = str(r.stockType||'GOOD').toUpperCase(); return t==='DAMAGE' || t==='DAMAGED'; }).reduce((s,r)=>s+r.qty,0);
  const blkQty    = inventory.filter(r=>{ const t = str(r.stockType||'GOOD').toUpperCase(); return t==='BLOCKED'; }).reduce((s,r)=>s+r.qty,0);
  const gpBlocked = gatepasses.reduce((s,r)=>s+r.qty,0);
  const skus      = new Set(inventory.map(r=>r.skuCode)).size;
  const bins      = new Set(inventory.map(r=>r.bin).filter(Boolean)).size;
  const todayStr  = new Date().toLocaleDateString('en-IN');
  const todayAdj  = adjLog.filter(l=>new Date(l.time).toLocaleDateString('en-IN')===todayStr).length;

  $('db-inv').innerText     = inventory.length.toLocaleString();
  $('db-skus').innerText    = skus;
  $('db-bins-occ').innerText= bins;
  $('db-gp').innerText      = gpBlocked.toLocaleString();
  $('db-adj').innerText     = todayAdj;
  $('db-grn').innerText     = grnLog.length;
  $('db-good').innerText    = goodQty.toLocaleString();
  $('db-dmg').innerText     = dmgQty.toLocaleString();
  $('db-blk').innerText     = blkQty.toLocaleString();

  // Inventory summary by SKU
  const skuMap={};
  inventory.forEach(r=>{
    if(!skuMap[r.skuCode]) skuMap[r.skuCode]={name:r.skuName||'',bins:new Set(),qty:0,gp:0};
    skuMap[r.skuCode].qty+=r.qty;
    skuMap[r.skuCode].bins.add(r.bin);
    skuMap[r.skuCode].gp+=gpQtyFor(r.skuCode,r.batch,r.bin);
  });
  const skuRows=Object.entries(skuMap).sort((a,b)=>b[1].qty-a[1].qty).slice(0,20);
  const body=$('db-inv-body');
  if(!skuRows.length){body.innerHTML='<tr class="er"><td colspan="5">Upload inventory to view</td></tr>';return;}
  body.innerHTML=skuRows.map(([code,d])=>`<tr>
    <td><span class="sku-b" title="${esc(code)}">${esc(code)}</span></td>
    <td style="font-size:11.5px">${esc(d.name||'—')}</td>
    <td style="text-align:center;font-size:11px">${d.bins.size}</td>
    <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--teal)">${d.qty.toLocaleString()}</td>
    <td style="text-align:right;font-family:ui-monospace,monospace;color:${d.gp>0?'var(--red)':'var(--slate5)'};">${d.gp>0?d.gp.toLocaleString():'—'}</td>
  </tr>`).join('');

  // Near expiry
  const nearExp=inventory.filter(r=>{const d=daysToExp(r.expDate);return d!==null&&d<=90;})
    .sort((a,b)=>(daysToExp(a.expDate)||999)-(daysToExp(b.expDate)||999)).slice(0,15);
  const expBody=$('db-expiry-body');
  if(!nearExp.length){expBody.innerHTML='<tr class="er"><td colspan="6">No near-expiry stock</td></tr>';}
  else{
    expBody.innerHTML=nearExp.map(r=>{
      const d=daysToExp(r.expDate);
      const cls=d<=0?'b-err':d<=30?'b-warn':'b-info';
      return`<tr class="row-expiry"><td><span class="sku-b" style="font-size:9px">${esc(r.skuCode)}</span></td>
        <td class="mono" style="font-size:11px">${esc(r.batch||'—')}</td>
        <td><span class="bin-b" style="font-size:10px">${esc(r.bin||'—')}</span></td>
        <td style="font-size:11px">${esc(r.expDate||'—')}</td>
        <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700">${r.qty.toLocaleString()}</td>
        <td><span class="badge ${cls}" style="font-size:9px">${d<=0?'EXPIRED':d+'d'}</span></td>
      </tr>`;
    }).join('');
  }

  // Recent adjustments
  const adjBody=$('db-adj-body');
  const recentAdj=[...adjLog].reverse().slice(0,10);
  if(!recentAdj.length){adjBody.innerHTML='<tr class="er"><td colspan="5">No adjustments yet</td></tr>';}
  else{
    adjBody.innerHTML=recentAdj.map(l=>{
      const isRem=l.action==='REMOVE';
      return`<tr>
        <td style="font-size:11px">${new Date(l.time).toLocaleTimeString('en-IN')}</td>
        <td><span class="bin-b" style="font-size:9px">${esc(l.bin)}</span></td>
        <td><span class="sku-b" style="font-size:9px">${esc(l.skuCode)}</span></td>
        <td><span class="badge ${isRem?'b-err':'b-ok'}" style="font-size:9px">${l.action}</span></td>
        <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:${isRem?'var(--red)':'var(--green)'}">
          ${isRem?'':'+'}${Math.abs(Number(l.qty||0)).toLocaleString()}</td>
      </tr>`;
    }).join('');
  }
}

/* ═══════════════════════════════════════════════════════
   WMS MODULE — GRN
═══════════════════════════════════════════════════════ */
let grnLines=[];
let _grnUpRows=[];

const GRN_COLS={
  sku:   ['sku code','sku_code','material code','sku','item code'],
  name:  ['sku name','sku_name','material name','name','description'],
  batch: ['batch','batch no','batch_no','lot'],
  mfg:   ['mfg date','mfg_date','manufacture date','mfg. date'],
  exp:   ['exp date','exp_date','expiry date','expiry','exp. date'],
  qty:   ['qty','quantity','units'],
  case:  ['case pack','case pack (units/box)','casePack','units/box'],
  cls:   ['classification','class','fsn class','cls','classification (a/b/c)'],
};

function initGRN(){
  initGRNNo();
  const today=new Date().toISOString().split('T')[0];
  if($('grn-date'))$('grn-date').value=today;
  if($('grn-up-date'))$('grn-up-date').value=today;
  setGRNMode('manual',document.getElementById('grn-tab-manual'));
}

function initGRNNo(){
  const seq=ls('grnSeq')||0;
  const no='GRN-'+String(seq+1).padStart(5,'0');
  if($('grn-no'))$('grn-no').value=no;
  if($('grn-up-no'))$('grn-up-no').value=no;
}

function setGRNMode(mode,el){
  document.querySelectorAll('.mode-tab').forEach(t=>t.classList.remove('active'));
  if(el)el.classList.add('active');
  $('grn-manual').style.display=mode==='manual'?'block':'none';
  $('grn-upload').style.display=mode==='upload'?'block':'none';
}

function addGRNLine(){
  grnLines.push({sku:'',name:'',batch:'',mfg:'',exp:'',qty:0,casePack:'',cls:'B'});
  renderGRNLines();
  $('grn-clear-btn').style.display='inline-flex';
}

function removeGRNLine(i){
  grnLines.splice(i,1);
  renderGRNLines();
  if(!grnLines.length)$('grn-clear-btn').style.display='none';
}

function renderGRNLines(){
  const body=$('grn-lines-body');
  if(!grnLines.length){
    body.innerHTML='<tr class="er"><td colspan="10">Click "+ Add Line" to begin</td></tr>';
    $('grn-line-count').innerText='0 lines';
    $('grn-total-qty').innerText='0';
    return;
  }
  const skuOpts=skuMaster.map(s=>`<option value="${esc(s.code)}">`).join('');
  body.innerHTML=grnLines.map((l,i)=>`<tr>
    <td style="font-size:11px;color:var(--slate4)">${i+1}</td>
    <td><input class="ti" value="${esc(l.sku)}" list="grn-sku-dl" placeholder="SKU code"
      onchange="grnLines[${i}].sku=this.value;grnAutoFill(${i})" style="width:160px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11.5px"></td>
    <td><input class="ti" value="${esc(l.name)}" placeholder="Product name"
      onchange="grnLines[${i}].name=this.value" style="width:160px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11.5px"></td>
    <td><input class="ti" value="${esc(l.batch)}" placeholder="Batch No"
      onchange="grnLines[${i}].batch=this.value" style="width:90px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;font-family:ui-monospace,monospace"></td>
    <td><input type="date" value="${l.mfg||''}" onchange="grnLines[${i}].mfg=this.value"
      style="border:1px solid var(--border);border-radius:4px;padding:3px 5px;font-size:11px;width:130px"></td>
    <td><input type="date" value="${l.exp||''}" onchange="grnLines[${i}].exp=this.value"
      style="border:1px solid var(--border);border-radius:4px;padding:3px 5px;font-size:11px;width:130px"></td>
    <td><input type="number" value="${l.qty||''}" min="0" onchange="grnLines[${i}].qty=Number(this.value);updateGRNTotals()"
      class="tbl-qty" style="width:75px"></td>
    <td><input type="number" value="${l.casePack||''}" min="0" placeholder="—"
      onchange="grnLines[${i}].casePack=this.value" style="border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;width:70px;text-align:right"></td>
    <td><select onchange="grnLines[${i}].cls=this.value" style="border:1px solid var(--border);border-radius:4px;padding:3px 5px;font-size:11px">
      <option ${l.cls==='A'?'selected':''}>A</option>
      <option ${l.cls==='B'||!l.cls?'selected':''}>B</option>
      <option ${l.cls==='C'?'selected':''}>C</option>
    </select></td>
    <td><button class="btn btn-d btn-xs" onclick="removeGRNLine(${i})">✕</button></td>
  </tr>`).join('');
  // SKU datalist for GRN
  if(!$('grn-sku-dl')){
    const dl=document.createElement('datalist');dl.id='grn-sku-dl';document.body.appendChild(dl);
  }
  $('grn-sku-dl').innerHTML=skuOpts;
  updateGRNTotals();
}

function updateGRNTotals(){
  const total=grnLines.reduce((s,l)=>s+Number(l.qty||0),0);
  $('grn-line-count').innerText=grnLines.length+' line'+(grnLines.length!==1?'s':'');
  $('grn-total-qty').innerText=total.toLocaleString();
}

function grnAutoFill(i){
  const sku=grnLines[i].sku;
  const master=skuMaster.find(s=>s.code===sku);
  if(master){
    grnLines[i].name=master.name||'';
    grnLines[i].casePack=master.casePack||'';
    grnLines[i].cls=master.cls||'B';
    renderGRNLines();
  }
}

async function saveGRN(){
  const no=$('grn-no').value;
  const date=$('grn-date').value;
  const supplier=$('grn-supplier').value.trim();
  const vehicle=$('grn-vehicle').value.trim();
  const validLines=grnLines.filter(l=>l.sku&&Number(l.qty)>0);
  if(!validLines.length){toast('Add at least one line with SKU and Qty','warn');return;}
  const grn={grnNo:no,date,supplier,vehicle,savedBy:U.name,savedAt:new Date().toISOString(),lines:validLines};
  grnLog.push(grn);
  persistAndMark();
  renderSideStats();
  $('nav-grn-ct').innerText=grnLog.length||'';
  toast(`GRN ${no} saved — ${validLines.length} line(s)`,'ok');
  // Advance sequence
  const seq=ls('grnSeq')||0;lss('grnSeq',seq+1);
  grnLines=[];renderGRNLines();initGRNNo();
  clearGRNFields();
  // Sync to sheet
  if(gasUrl()){
    syncSheet('saveGRNToSheet',grn).then(r=>{
      if(r&&r.success) toast('✅ GRN synced to Sheet','ok',2000);
    });
  }
}

function clearGRN(){ if(!confirm('Clear GRN?'))return; grnLines=[];renderGRNLines();clearGRNFields();}
function clearGRNLines(){ if(!confirm('Clear all lines?'))return;grnLines=[];renderGRNLines();$('grn-clear-btn').style.display='none';}
function clearGRNFields(){ ['grn-supplier','grn-vehicle'].forEach(id=>{if($(id))$(id).value=''});}

function dlGRNTemplate(){
  const ws=XLSX.utils.aoa_to_sheet([
    ['SKU Code','SKU Name','Batch No','MFG Date','EXP Date','Qty','Case Pack (Units/Box)','Classification (A/B/C)'],
    ['MWLJNTP.0003.B0_N','LJ NutriMix 2+ 350gm','BATCH001','01-Jan-2024','31-Dec-2025',100,24,'A'],
    ['MWBWSKP.00648.B0_N','BB 10% Urea Lotion 200ml','BATCH002','15-Feb-2024','28-Feb-2026',200,40,'B'],
  ]);
  ws['!cols']=[{wch:28},{wch:34},{wch:12},{wch:12},{wch:12},{wch:8},{wch:18},{wch:20}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'GRN Template');XLSX.writeFile(wb,'GRN_Template.xlsx');
}

function parseGRNFile(ev){
  const f=ev.target.files[0];if(!f)return;
  const msg=$('grn-up-msg');msg.innerText='Reading…';
  parseExcel(f,(err,rows)=>{
    if(err){msg.innerText='❌ '+err.message;return;}
    if(!rows.length){msg.innerText='No rows found';return;}
    const heads=Object.keys(rows[0]);
    const cm={};Object.keys(GRN_COLS).forEach(k=>cm[k]=findCol(heads,GRN_COLS[k]));
    if(!cm.sku){msg.innerText='❌ SKU Code column required';return;}
    _grnUpRows=rows.filter(r=>{
      const sku=str(cm.sku?r[cm.sku]:'');
      const qty=num(cm.qty?r[cm.qty]:0);
      return sku&&qty>0;
    }).map(r=>({
      sku:  str(cm.sku  ?r[cm.sku]  :''),
      name: str(cm.name ?r[cm.name] :''),
      batch:str(cm.batch?r[cm.batch]:''),
      mfg:  str(cm.mfg  ?r[cm.mfg]  :''),
      exp:  str(cm.exp  ?r[cm.exp]  :''),
      qty:  num(cm.qty  ?r[cm.qty]  :0),
      casePack:str(cm.case?r[cm.case]:''),
      cls:  str(cm.cls  ?r[cm.cls]  :'B')||'B',
    }));
    msg.innerText=`✓ ${_grnUpRows.length} lines ready to save`;
    $('grn-up-preview').style.display='block';
    $('grn-up-body').innerHTML=_grnUpRows.map((r,i)=>`<tr>
      <td style="font-size:11px">${i+1}</td>
      <td><span class="sku-b" style="font-size:9px">${esc(r.sku)}</span></td>
      <td style="font-size:11.5px">${esc(r.name||'—')}</td>
      <td class="mono" style="font-size:11px">${esc(r.batch||'—')}</td>
      <td style="font-size:11px">${esc(r.mfg||'—')}</td>
      <td style="font-size:11px">${esc(r.exp||'—')}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700">${r.qty.toLocaleString()}</td>
      <td style="font-size:11px">${esc(r.casePack||'—')}</td>
      <td><span class="badge b-info" style="font-size:9px">${esc(r.cls)}</span></td>
    </tr>`).join('');
  });
  ev.target.value='';
}

async function saveGRNFromUpload(){
  if(!_grnUpRows.length){toast('No rows to save','warn');return;}
  const no=$('grn-up-no').value;
  const date=$('grn-up-date').value;
  const supplier=$('grn-up-supplier').value.trim();
  const vehicle=$('grn-up-vehicle').value.trim();
  const grn={grnNo:no,date,supplier,vehicle,savedBy:U.name,savedAt:new Date().toISOString(),lines:_grnUpRows};
  grnLog.push(grn);
  persistAndMark();renderSideStats();
  $('nav-grn-ct').innerText=grnLog.length||'';
  toast(`GRN ${no} saved — ${_grnUpRows.length} line(s)`,'ok');
  const seq=ls('grnSeq')||0;lss('grnSeq',seq+1);
  $('grn-up-preview').style.display='none';_grnUpRows=[];initGRNNo();
  if(gasUrl()){
    syncSheet('saveGRNToSheet',grn).then(r=>{
      if(r&&r.success) toast('✅ GRN synced to Sheet','ok',2000);
    });
  }
}

function renderGRNHistory(){
  const body=$('grn-hist-body');
  const q=str($('grn-hist-q')&&$('grn-hist-q').value||'').toLowerCase();
  // Flatten grnLog
  const rows=[];
  grnLog.forEach(g=>{
    (g.lines||[]).forEach(l=>{
      if(q&&!`${g.grnNo} ${g.supplier||''} ${l.sku} ${l.batch}`.toLowerCase().includes(q))return;
      rows.push({...g,...l});
    });
  });
  if(!rows.length){body.innerHTML='<tr class="er"><td colspan="13">No GRN records'+(q?' match filter':'yet')+'</td></tr>';return;}
  body.innerHTML=rows.map(r=>`<tr>
    <td class="mono" style="font-size:10px;font-weight:700;color:var(--purple)">${esc(r.grnNo||'—')}</td>
    <td style="font-size:11px">${esc(r.date||'—')}</td>
    <td style="font-size:11.5px">${esc(r.supplier||'—')}</td>
    <td style="font-size:11px">${esc(r.vehicle||'—')}</td>
    <td><span class="sku-b" style="font-size:9px">${esc(r.sku||r.skuCode||'—')}</span></td>
    <td style="font-size:11.5px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name||r.skuName||'—')}</td>
    <td class="mono" style="font-size:11px">${esc(r.batch||'—')}</td>
    <td style="font-size:11px">${esc(r.mfg||r.mfgDate||'—')}</td>
    <td style="font-size:11px">${esc(r.exp||r.expDate||'—')}</td>
    <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--teal)">${Number(r.qty||0).toLocaleString()}</td>
    <td style="font-size:11px">${esc(r.casePack||'—')}</td>
    <td><span class="badge b-info" style="font-size:9px">${esc(r.cls||'B')}</span></td>
    <td style="font-size:11px">${esc(r.savedBy||'—')}</td>
  </tr>`).join('');
}

function exportGRNXLSX(){
  if(!grnLog.length){toast('No GRN records','warn');return;}
  const rows=[];
  grnLog.forEach(g=>(g.lines||[]).forEach(l=>rows.push({
    'GRN No':g.grnNo,'Date':g.date,'Supplier':g.supplier||'','Vehicle':g.vehicle||'',
    'SKU Code':l.sku||l.skuCode||'','SKU Name':l.name||l.skuName||'','Batch No':l.batch||'',
    'MFG Date':l.mfg||l.mfgDate||'','EXP Date':l.exp||l.expDate||'',
    'Qty':Number(l.qty||0),'Case Pack':l.casePack||'','Classification':l.cls||'B',
    'Saved By':g.savedBy||''
  })));
  const ws=XLSX.utils.json_to_sheet(rows);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'GRN History');XLSX.writeFile(wb,'GRN_History.xlsx');
  toast('GRN history exported','ok');
}

/* ═══════════════════════════════════════════════════════
   WMS MODULE — BIN MASTER
═══════════════════════════════════════════════════════ */
const BIN_COLS={
  id:    ['bin id','bin no','bin','id'],
  zone:  ['zone','area','section'],
  fsn:   ['fsn class','classification','class','fsn class (a/b/c)'],
  cap:   ['capacity (boxes)','capacity','boxes'],
  status:['status'],
  sku:   ['sku in bin','sku','material'],
};
let _binFiltered=[], _binPage=1;
const BIN_PAGE=150;

function parseBinFile(ev){
  const f=ev.target.files[0];if(!f)return;
  parseExcel(f,(err,rows)=>{
    if(err){toast(err.message,'err');return;}
    if(!rows.length){toast('No rows found','warn');return;}
    const heads=Object.keys(rows[0]);
    const cm={};Object.keys(BIN_COLS).forEach(k=>cm[k]=findCol(heads,BIN_COLS[k]));
    if(!cm.id){toast('Bin ID column required','err');return;}
    binMaster=rows.map(r=>({
      id:   str(cm.id    ?r[cm.id]    :''),
      zone: str(cm.zone  ?r[cm.zone]  :''),
      fsn:  str(cm.fsn   ?r[cm.fsn]   :'B'),
      cap:  num(cm.cap   ?r[cm.cap]   :0),
      status:str(cm.status?r[cm.status]:'EMPTY').toUpperCase(),
      sku:  str(cm.sku   ?r[cm.sku]   :''),
    })).filter(r=>r.id);
    persistAndMark();
    renderBinTable();
    toast(`${binMaster.length} bins loaded`,'ok');
    if(gasUrl()) syncSheet('bulkSaveBinMaster',binMaster).then(r=>{ if(r&&r.success) toast('✅ Bins synced to Sheet','ok',2000); });
  });
  ev.target.value='';
}

function renderBinTable(){
  const q=str($('bin-q')&&$('bin-q').value||'').toLowerCase();
  const sf=str($('bin-status-f')&&$('bin-status-f').value||'');

  // Merge occupancy from inventory
  const occBins=new Set(inventory.map(r=>r.bin).filter(Boolean));
  const displayBins=binMaster.length?binMaster:
    [...occBins].map(b=>({id:b,zone:'',fsn:'',cap:'',status:'OCCUPIED',sku:''}));

  _binFiltered=displayBins.filter(r=>{
    if(q&&!(r.id.toLowerCase().includes(q)||(r.zone||'').toLowerCase().includes(q)))return false;
    if(sf&&r.status.toUpperCase()!==sf)return false;
    return true;
  });

  // Stats
  const total=displayBins.length;
  const empty=displayBins.filter(r=>r.status.toUpperCase()==='EMPTY').length;
  const occ  =displayBins.filter(r=>r.status.toUpperCase()==='OCCUPIED').length;
  const blk  =displayBins.filter(r=>r.status.toUpperCase()==='BLOCKED').length;
  $('bin-total').innerText=total;$('bin-empty').innerText=empty;
  $('bin-occ').innerText=occ;$('bin-blk').innerText=blk;

  _binPage=1;renderBinPage();
}

function renderBinPage(){
  const body=$('bin-body');
  const start=(_binPage-1)*BIN_PAGE;
  const slice=_binFiltered.slice(start,start+BIN_PAGE);
  if(!slice.length){body.innerHTML='<tr class="er"><td colspan="6">No bins match filter</td></tr>';renderBinPgn();return;}
  const occBins=new Set(inventory.map(r=>r.bin).filter(Boolean));
  body.innerHTML=slice.map(r=>{
    const liveOcc=occBins.has(r.id);
    const effStatus=liveOcc?'OCCUPIED':(r.status||'EMPTY');
    const cls=effStatus==='OCCUPIED'?'b-ok':effStatus==='BLOCKED'?'b-err':'b-info';
    // SKU from live inventory
    const invRows=(IDX.byBin[r.id]||[]);
    const skuStr=invRows.length?[...new Set(invRows.map(x=>x.skuCode))].slice(0,2).join(', ')+(invRows.length>2?'…':''):(r.sku||'—');
    return`<tr>
      <td><span class="bin-b">${esc(r.id)}</span></td>
      <td style="font-size:11.5px">${esc(r.zone||'—')}</td>
      <td><span class="badge b-info" style="font-size:9px">${esc(r.fsn||'B')}</span></td>
      <td style="text-align:center;font-size:11.5px">${r.cap||'—'}</td>
      <td><span class="badge ${cls}" style="font-size:9px">${effStatus}</span></td>
      <td style="font-size:11px;color:var(--slate4);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(skuStr)}</td>
    </tr>`;
  }).join('');
  renderBinPgn();
}

function renderBinPgn(){
  const total=Math.ceil(_binFiltered.length/BIN_PAGE);
  const p=$('bin-pgn');
  if(total<=1){p.innerHTML='';return;}
  p.innerHTML=`<button onclick="_binPage=1;renderBinPage()" ${_binPage===1?'disabled':''}>«</button>
    <button onclick="_binPage--;renderBinPage()" ${_binPage===1?'disabled':''}>‹</button>
    <span>Page ${_binPage} of ${total} (${_binFiltered.length} bins)</span>
    <button onclick="_binPage++;renderBinPage()" ${_binPage===total?'disabled':''}>›</button>
    <button onclick="_binPage=${total};renderBinPage()" ${_binPage===total?'disabled':''}>»</button>`;
}

function dlBinTpl(){
  const ws=XLSX.utils.aoa_to_sheet([
    ['Bin ID','Zone','FSN Class (A/B/C)','Capacity (Boxes)','Status'],
    ['R1-C1-001','OWN','A',24,'EMPTY'],['R4-C1-001','BeBodywise','B',40,'OCCUPIED'],
  ]);
  ws['!cols']=[{wch:14},{wch:14},{wch:18},{wch:16},{wch:12}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Bin Master');XLSX.writeFile(wb,'Bin_Master_Template.xlsx');
}

function exportBinXLSX(){
  const rows=_binFiltered.map(r=>({'Bin ID':r.id,'Zone':r.zone,'FSN Class':r.fsn,'Capacity':r.cap,'Status':r.status,'SKU in Bin':r.sku}));
  if(!rows.length){toast('No bins to export','warn');return;}
  const ws=XLSX.utils.json_to_sheet(rows);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Bin Master');XLSX.writeFile(wb,'Bin_Master.xlsx');
  toast('Bin master exported','ok');
}

/* ═══════════════════════════════════════════════════════
   WMS MODULE — SKU MASTER
═══════════════════════════════════════════════════════ */
const SKU_COLS={
  code:  ['sku code','sku_code','material code','sku','item code'],
  name:  ['sku name','sku_name','material name','name','description'],
  case:  ['case pack (units/box)','case pack','casePack','units/box'],
  box:   ['box/pallet (boxes/shelf)','box/pallet','boxPallet','boxes/shelf'],
  cls:   ['classification (a/b/c)','classification','class','fsn class'],
  mrp:   ['mrp','mrp (rs)','price'],
  status:['sku status','status'],
};
let _skuFiltered=[], _skuPage=1;
const SKU_PAGE=100;

function parseSKUFile(ev){
  const f=ev.target.files[0];if(!f)return;
  parseExcel(f,(err,rows)=>{
    if(err){toast(err.message,'err');return;}
    if(!rows.length){toast('No rows found','warn');return;}
    const heads=Object.keys(rows[0]);
    const cm={};Object.keys(SKU_COLS).forEach(k=>cm[k]=findCol(heads,SKU_COLS[k]));
    if(!cm.code){toast('SKU Code column required','err');return;}
    skuMaster=rows.map(r=>({
      code:  str(cm.code  ?r[cm.code]  :''),
      name:  str(cm.name  ?r[cm.name]  :''),
      casePack:num(cm.case?r[cm.case]  :0)||null,
      boxPallet:num(cm.box?r[cm.box]   :0)||null,
      cls:   str(cm.cls   ?r[cm.cls]   :'B'),
      mrp:   str(cm.mrp   ?r[cm.mrp]   :''),
      status:str(cm.status?r[cm.status]:'ACTIVE').toUpperCase(),
    })).filter(r=>r.code);
    persistAndMark();renderSKUTable();
    toast(`${skuMaster.length} SKUs loaded`,'ok');
    if(gasUrl()) syncSheet('bulkSaveSKUMaster',skuMaster).then(r=>{ if(r&&r.success) toast('✅ SKU Master synced to Sheet','ok',2000); });
  });
  ev.target.value='';
}

function renderSKUTable(){
  const q=str($('sku-q')&&$('sku-q').value||'').toLowerCase();
  _skuFiltered=skuMaster.filter(r=>!q||(r.code.toLowerCase().includes(q)||(r.name||'').toLowerCase().includes(q)));
  _skuPage=1;renderSKUPage();
}

function renderSKUPage(){
  const body=$('sku-body');
  const start=(_skuPage-1)*SKU_PAGE;
  const slice=_skuFiltered.slice(start,start+SKU_PAGE);
  if(!slice.length){body.innerHTML='<tr class="er"><td colspan="7">No SKUs'+(skuMaster.length?'match filter':'— upload SKU Master')+'</td></tr>';renderSKUPgn();return;}
  body.innerHTML=slice.map(r=>`<tr>
    <td><span class="sku-b" title="${esc(r.code)}">${esc(r.code)}</span></td>
    <td style="font-size:11.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name||'—')}</td>
    <td style="text-align:center;font-size:12px">${r.casePack||'—'}</td>
    <td style="text-align:center;font-size:12px">${r.boxPallet||'—'}</td>
    <td><span class="badge b-info" style="font-size:9px">${esc(r.cls||'B')}</span></td>
    <td style="font-size:12px">${esc(r.mrp||'—')}</td>
    <td><span class="badge ${r.status==='ACTIVE'?'b-ok':'b-err'}" style="font-size:9px">${esc(r.status||'ACTIVE')}</span></td>
  </tr>`).join('');
  renderSKUPgn();
}

function renderSKUPgn(){
  const total=Math.ceil(_skuFiltered.length/SKU_PAGE);
  const p=$('sku-pgn');
  if(total<=1){p.innerHTML='';return;}
  p.innerHTML=`<button onclick="_skuPage=1;renderSKUPage()" ${_skuPage===1?'disabled':''}>«</button>
    <button onclick="_skuPage--;renderSKUPage()" ${_skuPage===1?'disabled':''}>‹</button>
    <span>Page ${_skuPage} of ${total} (${_skuFiltered.length} SKUs)</span>
    <button onclick="_skuPage++;renderSKUPage()" ${_skuPage===total?'disabled':''}>›</button>
    <button onclick="_skuPage=${total};renderSKUPage()" ${_skuPage===total?'disabled':''}>»</button>`;
}

function dlSKUTpl(){
  const ws=XLSX.utils.aoa_to_sheet([
    ['SKU Code','SKU Name','Case Pack (Units/Box)','Box/Pallet (Boxes/Shelf)','Classification (A/B/C)','MRP','SKU Status'],
    ['MWLJNTP.0003.B0_N','LJ NutriMix 2+ 350gm Chocolate Jar',32,6,'A','399','ACTIVE'],
    ['MWBWSKP.00648.B0_N','BB 10% Urea Lotion 200ml',40,10,'B','449','ACTIVE'],
  ]);
  ws['!cols']=[{wch:28},{wch:34},{wch:18},{wch:22},{wch:20},{wch:8},{wch:12}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'SKU Master');XLSX.writeFile(wb,'SKU_Master_Template.xlsx');
}

function exportSKUXLSX(){
  if(!skuMaster.length){toast('No SKU data','warn');return;}
  const ws=XLSX.utils.json_to_sheet(skuMaster.map(r=>({'SKU Code':r.code,'SKU Name':r.name,'Case Pack':r.casePack||'','Box/Pallet':r.boxPallet||'','Classification':r.cls,'MRP':r.mrp,'Status':r.status})));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'SKU Master');XLSX.writeFile(wb,'SKU_Master.xlsx');
  toast('SKU master exported','ok');
}

/* ═══════════════════════════════════════════════════════
   WMS MODULE — REFRESH FROM SHEET
   Loads all data from Google Sheet on demand
═══════════════════════════════════════════════════════ */
async function loadFromSheet(){
  if(!gasUrl()) return;
  const r=await apiCall('refreshAllData',{},20);
  if(!r||!r.success) return;
  if(r.inventory&&r.inventory.length){
    inventory=r.inventory;
    persistAndMark();rebuildInvIdx();populateDatalists();renderSideStats();renderUploadSummary();updateInvNav();
  }
  if(r.gatepasses&&r.gatepasses.length){
    gatepasses=r.gatepasses;
    persistAndMark();rebuildGpIdx();
  }
  if(r.skuMaster&&r.skuMaster.length){
    skuMaster=r.skuMaster.map(s=>({code:s.code,name:s.name,casePack:s.casePack,boxPallet:s.boxPallet,cls:s.cls,mrp:s.mrp,status:s.skuStatus||'ACTIVE'}));
    lss('sku',skuMaster);renderSKUTable();
  }
  if(r.binMaster&&r.binMaster.length){
    binMaster=r.binMaster.map(b=>({id:b.id,zone:b.zone,fsn:b.fsn,cap:b.capacity,status:b.status,sku:b.skuFromDump||''}));
    lss('bin',binMaster);renderBinTable();
  }
  if(r.inventory||r.gatepasses) loadDashboard();
  if(r.refreshedAt) toast(`✅ Data refreshed from Sheet (${r.refreshedAt})`,'ok');
}

async function refreshFromSheet(){
  if(!gasUrl()){toast('Connect to Google Sheet first (⚙ Sheet button)','warn');return;}
  $('refreshBtn').disabled=true;$('refreshBtn').innerText='↻ Loading…';
  await loadFromSheet();
  $('refreshBtn').disabled=false;$('refreshBtn').innerText='↻ Refresh';
}

/* ═══════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════ */
;

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
window.onload=function(){
  /* Wire login buttons */
  var lgU=$('lgU'), lgP=$('lgP'), lgBtn=$('lgBtn');
  if(lgU)  lgU.addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
  if(lgP)  lgP.addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
  if(lgBtn)lgBtn.addEventListener('click',  function()  { doLogin(); });
  rebuildInvIdx();rebuildGpIdx();
  renderSideStats();renderUploadSummary();updateInvNav();
  if(adjLog.length){renderAdjLog();updateAdjStats();}
  if(gasUrl()) markGasOk(true);
  if(window.innerWidth<=768) $('sb-tog').style.display='block';
};


/* ── Global window exports (for any remaining inline handlers) ── */
window.doLogin        = doLogin;
window.confirmExit    = confirmExit;
window.navTo          = navTo;
window.toggleSidebar  = toggleSidebar;
window.openGasModal   = openGasModal;
window.saveGAS        = saveGAS;
window.testGAS        = testGAS;
window.manualSync     = manualSync;
window.refreshFromSheet = refreshFromSheet;
window.closeModal     = closeModal;
window.initCC         = initCC;
window.loadDashboard  = loadDashboard;
window.initGRN        = initGRN;
window.renderGRNHistory = renderGRNHistory;
window.renderInventorySection = renderInventorySection;
window.renderBinTable = renderBinTable;
window.renderSKUTable = renderSKUTable;