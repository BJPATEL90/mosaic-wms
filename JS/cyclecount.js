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