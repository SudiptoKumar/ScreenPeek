/* ScreenPeek Insight beacon. Fixed schema only; no form data or keystrokes. */
(()=>{var c=window.__spT||{};
if((c.consent==='basic'||c.consent==='strict')&&(navigator.globalPrivacyControl||navigator.doNotTrack==='1'))return;
if(c.consent==='strict'&&!/(?:^|;\s*)sp_consent=1(?:;|$)/.test(document.cookie))return;
if(c.sample<100&&Math.random()*100>=c.sample)return;
var t0=Date.now(),ck=function(n){var m=document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'));return m?m[1]:''},
p=location.pathname,pt='page',tid='',d=p.match(/^\/(movie|tv)\/([^/]+)\//);
if(p==='/')pt='home';else if(d){pt='detail';tid=d[1]+':'+d[2]}else if(/^\/watch\//.test(p))pt='watch';
else if(/^\/person\//.test(p))pt='person';else if(/^\/(movies|series|top-rated|top10|genres|upcoming)/.test(p))pt='list';
var oi=/(?:^|;\s*)sp_consent=1(?:;|$)/.test(document.cookie);
function t2(){var o={webgl_renderer:'',canvas_hash:'',audio_hash:'',webgpu_vendor:''};if(!c.t2||!oi)return o;
try{var cv=document.createElement('canvas'),gl=cv.getContext('webgl');
if(gl){var e=gl.getExtension('WEBGL_debug_renderer_info');o.webgl_renderer=String(e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)||'')}
var c2=document.createElement('canvas');c2.width=220;c2.height=30;var x=c2.getContext('2d');
x.font='14px Arial';x.fillStyle='#c73e54';x.fillText('ScreenPeek',4,18);
var s=c2.toDataURL(),h=5381;for(var i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))>>>0;o.canvas_hash=h.toString(16)}catch(e){}return o}
function bs(t){return{type:t,session_id:ck('sp_sid'),visitor_id:ck('sp_vid'),page_url:p,page_type:pt,title_id:tid,referrer:document.referrer||''}}
function sn(o){var b=JSON.stringify(o);if(navigator.sendBeacon&&navigator.sendBeacon('/api/beacon',b))return;
fetch('/api/beacon',{method:'POST',body:b,keepalive:true,headers:{'Content-Type':'application/json'}}).catch(()=>{})}
var cn=navigator.connection||{},v=bs('pageview'),x2=t2();
v.screen_w=screen.width;v.screen_h=screen.height;v.avail_w=screen.availWidth;v.avail_h=screen.availHeight;
v.viewport_w=innerWidth;v.viewport_h=innerHeight;v.dpr=devicePixelRatio||1;v.color_depth=screen.colorDepth||null;
v.orientation=screen.orientation?screen.orientation.type:'';
try{v.browser_timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){v.browser_timezone=''}
v.languages=(navigator.languages||[navigator.language||'']).join(',');v.cpu_cores=navigator.hardwareConcurrency||null;
v.ram_bucket_gb=navigator.deviceMemory||null;v.touch_points=navigator.maxTouchPoints||0;
v.connection_type=cn.effectiveType||'';v.downlink_mbps=cn.downlink||null;v.rtt_ms=cn.rtt||null;v.save_data=cn.saveData?1:0;
v.dark_mode=matchMedia('(prefers-color-scheme: dark)').matches?1:0;v.reduced_motion=matchMedia('(prefers-reduced-motion: reduce)').matches?1:0;
v.webgl_renderer=x2.webgl_renderer;v.canvas_hash=x2.canvas_hash;v.audio_hash=x2.audio_hash;v.webgpu_vendor=x2.webgpu_vendor;v.webrtc_ip='';
setTimeout(()=>sn(v),350);
var ms=0,sm=0;
addEventListener('scroll',()=>{var de=document.documentElement,mx=de.scrollHeight-innerHeight,
pc=mx>0?Math.min(100,Math.round(scrollY/mx*100)):100;if(pc>ms)ms=pc;
var ml=pc>=100?100:pc>=75?75:pc>=50?50:pc>=25?25:0;
if(ml>sm){sm=ml;var e=bs('scroll');e.scroll_pct=ml;sn(e)}},{passive:true});
document.addEventListener('click',e=>{var el=e.target,t=el&&el.closest?el.closest('[data-sp-track]'):null;
if(t){var o=bs('cta');o.cta=t.getAttribute('data-sp-track')||'';sn(o)}
var a=el&&el.closest?el.closest('a[href*="/go/"]'):null;
if(a&&!/[?&]sp_page=/.test(a.href))a.href+=(a.href.indexOf('?')>=0?'&':'?')+'sp_page='+encodeURIComponent(p)+'&sp_title='+encodeURIComponent(tid)},true);
addEventListener('pagehide',()=>{var e=bs('exit');e.duration_s=Math.round((Date.now()-t0)/1000);e.max_scroll_pct=ms;sn(e)});
})();
