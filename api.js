// shared by every page: sends the access key with each call and asks for it (once per browser) when the worker says 'unauthorized'
function apiToken(){try{return localStorage.getItem('api_token')||'';}catch(e){return '';}}
function apiAsk(){
  const t=(window.prompt('Access key for the Smoobu tools (asked once per browser):')||'').trim();
  try{if(t)localStorage.setItem('api_token',t);}catch(e){}
  return t;
}
function apiPost(url,payload){
  const send=t=>fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(Object.assign({token:t},payload))})
    .then(r=>r.text()).then(x=>{try{return JSON.parse(x);}catch(e){throw new Error('Non-JSON: '+x.slice(0,200));}});
  const first=apiToken();
  return send(first).then(j=>{
    if(!(j&&j.error==='unauthorized'))return j;
    let t=apiToken();
    if(!t||t===first)t=apiAsk();
    return t?send(t):j;
  });
}
