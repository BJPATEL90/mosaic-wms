/* core.js — Load FIRST. localStorage helpers only. */
var ls = function(k){
  try{ return JSON.parse(localStorage.getItem('mwcc4_'+k)||'null'); }catch(e){ return null; }
};
var lss = function(k,v){
  try{ localStorage.setItem('mwcc4_'+k, JSON.stringify(v)); }catch(e){}
};
