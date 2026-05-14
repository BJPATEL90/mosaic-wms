/* utils.js — DOM helpers, toast, loader. Load after core.js */
var $ = function(id){ return document.getElementById(id); };
var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
var num = function(v){ var n=Number(String(v||0).replace(/,/g,'')); return isNaN(n)?0:n; };
var str = function(v){ return String(v==null?'':v).trim(); };

function toast(msg, type, ms){
  type = type||'info'; ms = ms||3500;
  var c=$(('toast-wrap')), d=document.createElement('div');
  d.className='toast t-'+type;
  var ico = type==='ok'?'✅':type==='err'?'❌':type==='warn'?'⚠️':'ℹ️';
  d.innerHTML='<span>'+ico+'</span><span>'+esc(msg)+'</span>';
  c.appendChild(d);
  setTimeout(function(){
    d.style.animation='tOut .3s ease forwards';
    setTimeout(function(){ if(c.contains(d)) c.removeChild(d); }, 320);
  }, ms);
}

function showLoader(msg){
  $('gloader-msg').innerText = msg||'Processing…';
  $('gloader').classList.add('on');
}
function hideLoader(){ $('gloader').classList.remove('on'); }

function showResult(elId, msg, type){
  var el=$(elId); if(!el) return;
  el.style.display='flex';
  el.className='notice n-'+(type||'info');
  el.innerHTML=esc(msg);
}
function openModal(id){ $(id).classList.add('open'); }
function closeModal(id){ $(id).classList.remove('open'); }