const INV_COLS={
  skuCode:  ['sku code','sku_code','material code','sku','item code'],
  skuName:  ['sku name','sku_name','material name','name','description'],
  batch:    ['batch','batch no','batch_no','batchno','lot','lot no'],
  bin:      ['bin','shelf','bin / shelf','bin no','bin id','location'],
  qty:      ['qty','quantity','balance','stock qty','balance qty'],
  stockType:['stock type','stock_type','type'],
  ean:      ['ean','barcode','ean code'],
  mfgDate:  ['mfg date','mfg_date','manufacture date','mfd','mfg. date'],
  expDate:  ['exp date','exp_date','expiry date','expiry','exp. date','best before'],
  mrp:      ['mrp','mrp (rs)','price'],
};
function parseInvFile(ev){
  const f=ev.target.files[0]; if(!f)return;
  const msg=$('inv-msg'); msg.innerText='Reading…';
  parseExcel(f,(err,rows)=>{
    if(err){ msg.innerText='❌ '+err.message; toast(err.message,'err'); return; }
    if(!rows.length){ msg.innerText='No rows found'; return; }
    const heads=Object.keys(rows[0]);
    const cm={}; Object.keys(INV_COLS).forEach(k=>cm[k]=findCol(heads,INV_COLS[k]));
    if(!cm.skuCode||!cm.qty){ msg.innerText='❌ SKU Code or Qty column not found'; toast('Required columns missing','err'); return; }
    const skipped={blankSku:0,zeroQty:0,other:0};
    inventory=rows.map((r,i)=>{
      const sku=str(cm.skuCode?r[cm.skuCode]:'');
      const q=num(cm.qty?r[cm.qty]:0);
      if(!sku){ skipped.blankSku++; return null; }
      if(q<=0){ skipped.zeroQty++; return null; }
      return{
        skuCode:sku,
        skuName:str(cm.skuName?r[cm.skuName]:''),
        batch:  str(cm.batch  ?r[cm.batch]  :''),
        bin:    str(cm.bin    ?r[cm.bin]     :''),
        qty:q,
        stockType:str(cm.stockType?r[cm.stockType]:'GOOD').toUpperCase()||'GOOD',
        ean:    str(cm.ean    ?r[cm.ean]     :''),
        mfgDate:str(cm.mfgDate?r[cm.mfgDate]:''),
        expDate:str(cm.expDate?r[cm.expDate] :''),
        mrp:    str(cm.mrp    ?r[cm.mrp]     :''),
      };
    }).filter(Boolean);
    persistAndMark(); rebuildInvIdx(); populateDatalists(); renderSideStats(); renderUploadSummary(); updateInvNav();
    const totalSkipped=skipped.blankSku+skipped.zeroQty+skipped.other;
    let skipDetail='';
    if(skipped.blankSku>0) skipDetail+=skipped.blankSku+' blank SKU, ';
    if(skipped.zeroQty>0)  skipDetail+=skipped.zeroQty+' zero/negative qty (normal if dump has 0-stock rows), ';
    if(skipped.other>0)    skipDetail+=skipped.other+' other, ';
    skipDetail=skipDetail.replace(/, $/,'');
    msg.innerText=`✓ ${inventory.length} rows loaded from ${f.name}.`+(totalSkipped?` ⚠ ${totalSkipped} skipped (${skipDetail}).`:'');
    $('inv-chips').innerHTML=
      `<span class="chip chip-t">${inventory.length} Lines</span>`+
      `<span class="chip chip-ok">${new Set(inventory.map(r=>r.skuCode)).size} SKUs</span>`+
      `<span class="chip chip-ok">${new Set(inventory.map(r=>r.bin).filter(Boolean)).size} Bins</span>`+
      (totalSkipped?`<span class="chip chip-warn" title="${skipDetail}">⚠ ${totalSkipped} skipped</span>`:'');
    toast(`${inventory.length} rows loaded`,'ok');
    if(gasUrl()){
      syncSheet('uploadInventoryDump',inventory).then(r=>{
        if(r&&r.success){ onSyncSuccess(); msg.innerText+=` ✅ Synced to Sheet.`; }
        else if(r&&r.message&&!r.message.includes('GAS_URL')) toast('⚠ Sheet sync: '+r.message,'warn');
      });
    }
  });
  ev.target.value='';
}
function clearInventory(){
  if(!confirm('Clear all inventory?'))return;
  inventory=[];persistAndMark();rebuildInvIdx();
  $('inv-chips').innerHTML='';$('inv-msg').innerText='Cleared.';
  populateDatalists();renderSideStats();renderUploadSummary();updateInvNav();
  toast('Inventory cleared','warn');
}
function renderUploadSummary(){
  const w=$('upload-summary');
  if(!inventory.length&&!gatepasses.length){w.style.display='none';return;}
  w.style.display='block';
  $('su-inv').innerText=inventory.length;
  $('su-skus').innerText=new Set(inventory.map(r=>r.skuCode)).size;
  $('su-bins').innerText=new Set(inventory.map(r=>r.bin).filter(Boolean)).size;
  $('su-gp').innerText=gatepasses.length;
  $('su-gpqty').innerText=gatepasses.reduce((s,r)=>s+r.qty,0).toLocaleString();
}
function populateDatalists(){
  const bins=[...new Set(inventory.map(r=>r.bin).filter(Boolean))].sort();
  const skus=[...new Set(inventory.map(r=>r.skuCode).filter(Boolean))].sort();
  $('cc-bins-dl').innerHTML=bins.map(b=>`<option value="${esc(b)}">`).join('');
  $('cc-skus-dl').innerHTML=skus.map(s=>`<option value="${esc(s)}">`).join('');
}
function renderSideStats(){
  $('side-inv').innerText=inventory.length.toLocaleString();
  $('side-gp').innerText=gatepasses.length.toLocaleString();
  $('side-adj').innerText=adjLog.length.toLocaleString();
  $('side-grn').innerText=grnLog.length.toLocaleString();
}
function updateInvNav(){ $('nav-inv-ct').innerText=inventory.length||''; }
function dlInvTpl(){
  const ws=XLSX.utils.aoa_to_sheet([
    ['SKU Code','SKU Name','Batch No','MFG Date','EXP Date','MRP','Bin / Shelf','Stock Type','Qty','EAN'],
    ['MWLJNTP.0003.B0_N','LJ NutriMix 2+ 350gm Chocolate Jar','BATCH001','01-Jan-2024','31-Dec-2025','399','R14-C1-001','GOOD',100,''],
    ['MWBWSKP.00648.B0_N','BB 10% Urea Lotion 200ml','BATCH002','15-Feb-2024','28-Feb-2026','449','R4-C1-001','GOOD',200,''],
  ]);
  ws['!cols']=[{wch:28},{wch:34},{wch:12},{wch:12},{wch:12},{wch:8},{wch:14},{wch:10},{wch:8},{wch:14}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Inventory Dump');XLSX.writeFile(wb,'Inventory_Dump_Template.xlsx');
}
const PAGE=100;
let invFiltered=[], invPage=1;

function renderInventorySection(){ updateInvNav(); applyInvFilters(); }

function applyInvFilters(){
  const qSku=str($('fi-sku').value).toLowerCase();
  const qBin=str($('fi-bin').value).toLowerCase();
  const qBat=str($('fi-batch').value).toLowerCase();
  const qType=str($('fi-type').value).toUpperCase();
  const qExp=str($('fi-exp').value);
  const qFlag=str($('fi-flag').value);

  invFiltered=inventory.filter(r=>{
    if(qSku&&!((r.skuCode||'').toLowerCase().includes(qSku)||(r.skuName||'').toLowerCase().includes(qSku)))return false;
    if(qBin&&!(r.bin||'').toLowerCase().includes(qBin))return false;
    if(qBat&&!(r.batch||'').toLowerCase().includes(qBat))return false;
    if(qType&&r.stockType!==qType)return false;
    if(qExp){
      const d=daysToExp(r.expDate);
      if(qExp==='expired'){ if(d===null||d>0)return false; }
      else{ if(d===null||d>Number(qExp))return false; }
    }
    if(qFlag==='near_expiry'){ const d=daysToExp(r.expDate); if(d===null||d>90)return false; }
    if(qFlag==='negative'&&r.qty>=0)return false;
    return true;
  });

  // FEFO sort: earliest expiry first
  invFiltered.sort((a,b)=>{
    const da=daysToExp(a.expDate),db=daysToExp(b.expDate);
    if(da===null&&db===null)return 0;
    if(da===null)return 1; if(db===null)return -1;
    return da-db||(a.bin||'').localeCompare(b.bin||'');
  });

  invPage=1;
  const totalQty=invFiltered.reduce((s,r)=>s+r.qty,0);
  const gpBlocked=invFiltered.reduce((s,r)=>s+gpQtyFor(r.skuCode,r.batch,r.bin),0);
  const dmg=invFiltered.filter(r=>r.stockType==='DAMAGE').reduce((s,r)=>s+r.qty,0);
  $('ci-total').innerText=invFiltered.length.toLocaleString();
  $('ci-qty').innerText=totalQty.toLocaleString();
  $('ci-skus').innerText=new Set(invFiltered.map(r=>r.skuCode)).size;
  $('ci-gp').innerText=gpBlocked.toLocaleString();
  $('ci-dmg').innerText=dmg.toLocaleString();
  $('fi-ct').innerText=`${invFiltered.length} of ${inventory.length}`;
  renderInvPage();
}

function renderInvPage(){
  const body=$('ci-body');
  const start=(invPage-1)*PAGE;
  const slice=invFiltered.slice(start,start+PAGE);
  if(!slice.length){ body.innerHTML='<tr class="er"><td colspan="12">No rows match filters</td></tr>'; renderPgn(); return; }
  body.innerHTML=slice.map((r,i)=>{
    const gpQ=gpQtyFor(r.skuCode,r.batch,r.bin);
    const net=r.qty-gpQ;
    const days=daysToExp(r.expDate);
    let rowCls='', flags=[];
    if(r.qty<0){rowCls='row-negative';flags.push('<span class="badge b-err" style="font-size:8px">NEGATIVE</span>');}
    else if(days!==null&&days<=0){rowCls='row-expiry';flags.push('<span class="badge b-err" style="font-size:8px">EXPIRED</span>');}
    else if(days!==null&&days<=30){rowCls='row-expiry';flags.push('<span class="badge b-warn" style="font-size:8px">≤30D</span>');}
    else if(days!==null&&days<=90){flags.push('<span class="badge b-info" style="font-size:8px">≤90D</span>');}
    return`<tr class="${rowCls}">
      <td style="color:var(--slate5);font-size:10px">${start+i+1}</td>
      <td><span class="bin-b" style="font-size:10px">${esc(r.bin||'—')}</span></td>
      <td><span class="sku-b" title="${esc(r.skuCode)}">${esc(r.skuCode)}</span></td>
      <td style="font-size:11.5px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.skuName)}">${esc(r.skuName||'—')}</td>
      <td class="mono" style="font-size:11px">${esc(r.batch||'—')}</td>
      <td style="font-size:11px">${esc(r.mfgDate||'—')}</td>
      <td style="font-size:11px;color:${days!==null&&days<=30?'var(--red)':''}">
        ${esc(r.expDate||'—')}${days!==null?` <span style="font-size:9px;color:var(--slate4)">(${days}d)</span>`:''}
      </td>
      <td><span class="badge ${r.stockType==='DAMAGE'?'b-err':r.stockType==='BLOCKED'?'b-warn':'b-ok'}" style="font-size:9px">${esc(r.stockType)}</span></td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:var(--indigo)">${r.qty.toLocaleString()}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:${gpQ>0?'700':'400'};color:${gpQ>0?'var(--red)':'var(--slate5)'}">
        ${gpQ>0?gpQ.toLocaleString():'—'}</td>
      <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700;color:${net<0?'var(--red)':'var(--teal)'}">${net.toLocaleString()}</td>
      <td>${flags.join(' ')}</td>
    </tr>`;
  }).join('');
  renderPgn();
}

function renderPgn(){
  const total=Math.ceil(invFiltered.length/PAGE);
  const p=$('ci-pgn');
  if(total<=1){p.innerHTML='';return;}
  p.innerHTML=`<button onclick="invPage=${1};renderInvPage()" ${invPage===1?'disabled':''}>«</button>
    <button onclick="invPage--;renderInvPage()" ${invPage===1?'disabled':''}>‹</button>
    <span>Page ${invPage} of ${total} &nbsp;(${invFiltered.length.toLocaleString()} rows)</span>
    <button onclick="invPage++;renderInvPage()" ${invPage===total?'disabled':''}>›</button>
    <button onclick="invPage=${total};renderInvPage()" ${invPage===total?'disabled':''}>»</button>`;
}

function resetInvFilters(){
  ['fi-sku','fi-bin','fi-batch'].forEach(id=>$(id).value='');
  $('fi-type').value='';$('fi-exp').value='';$('fi-flag').value='';
  applyInvFilters();
}
function exportInvXLSX(){
  if(!inventory.length){toast('No inventory data','warn');return;}
  const rows=inventory.map(r=>({
    'Bin/Shelf':r.bin,'SKU Code':r.skuCode,'SKU Name':r.skuName,'Batch No':r.batch,
    'MFG Date':r.mfgDate,'EXP Date':r.expDate,'MRP':r.mrp,'Stock Type':r.stockType,'Qty':r.qty,
    'GP Qty':gpQtyFor(r.skuCode,r.batch,r.bin),
    'Net Available':r.qty-gpQtyFor(r.skuCode,r.batch,r.bin),
    'EAN':r.ean,'Days to Expiry':daysToExp(r.expDate)
  }));
  const ws=XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:14},{wch:28},{wch:34},{wch:12},{wch:12},{wch:12},{wch:8},{wch:10},{wch:10},{wch:8},{wch:12},{wch:14},{wch:12}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Current Inventory');XLSX.writeFile(wb,'Current_Inventory.xlsx');
  toast('Inventory exported','ok');
}