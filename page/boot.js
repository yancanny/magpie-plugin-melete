(async()=>{
  const retry=document.querySelector('#retry');retry.onclick=()=>location.reload();
  try{
    let theme=await window.magpie?.ready;theme=window.magpie?.theme||theme||{};
    const session=globalThis.MeleteSession;if(!session?.key)throw new Error('starting');
    const url=new URL(`http://127.0.0.1:${session.port}/open`);url.searchParams.set('key',session.key);url.searchParams.set('theme',theme.dark?'dark':'light');url.searchParams.set('lang',String(theme.lang||'zh').startsWith('en')?'en':'zh');
    // The bootstrap is sandboxed with connect-src none: navigate, never fetch.
    location.replace(url.href);
    setTimeout(()=>{document.querySelector('#status').textContent='服务还在启动，请重新连接。';retry.hidden=false;},8000);
  }catch{document.querySelector('#status').textContent='请稍候，或关闭再启用 Melete 后重试。';retry.hidden=false;}
})();
