const $ = id => document.getElementById(id);
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const num = v => { const n=Number(String(v||0).replace(/,/g,'')); return isNaN(n)?0:n; };
const str = v => String(v==null?'':v).trim();

function toast(msg,type='info',ms=3500){
  const c=$('toast-wrap'), d=document.createElement('div');
  d.className=`toast t-${type}`;
  const ico=type==='ok'?'✅':type==='err'?'❌':type==='warn'?'⚠️':'ℹ️';
  d.innerHTML=`<span>${ico}</span><span>${esc(msg)}</span>`;
  c.appendChild(d);
  setTimeout(()=>{ d.style.animation='tOut .3s ease forwards'; setTimeout(()=>{ if(c.contains(d))c.removeChild(d); },320); },ms);
}

/* ── Loader ── */
function showLoader(msg='Processing…'){ $('gloader-msg').innerText=msg; $('gloader').classList.add('on'); }
function hideLoader(){ $('gloader').classList.remove('on'); }

/* ── Inline result notice ── */
function showResult(elId,msg,type){
  const el=$(elId); if(!el)return;
  el.style.display='flex'; el.className='notice n-'+(type||'info');
  const icons={ok:'<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',err:'<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',warn:'<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'};
  const ico=icons[type]||'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
  el.innerHTML=`<svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;flex-shrink:0;margin-top:1px">${ico}</svg>${esc(msg)}`;
}
function openModal(id){ $(id).classList.add('open'); }
function closeModal(id){ $(id).classList.remove('open'); }
