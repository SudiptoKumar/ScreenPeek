/* ScreenPeek Insight beacon. Fixed schema only; no form data or keystrokes. */
(()=>{var c=window.__spT||{};
if((c.consent==='basic'||c.consent==='strict')&&(navigator.globalPrivacyControl||navigator.doNotTrack==='1'))return;
if(c.consent==='strict'&&!/(?:^|;\s*)sp_consent=1(?:;|$)/.test(document.cookie))return;
if(c.sample<100&&Math.random()*100>=c.sample)return;
var t0=Date.now(),ck=function(n){var m=document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'));return m?m[1]:''},
p=location.pathname,pt='page',tid='',d=p.match(/^\/(movie|tv)\/([^/]+)\//);
if(p==='/')pt='home';else if(d){pt='detail';tid=d[1]+':'+d[2]}else if(/^\/watch\//.test(p))pt='watch';
else if(/^\/person\//.test(p))pt='person';else if(/^\/(movies|series|top-rated|top10|genres|upcoming)/.test(p))pt='list';
function hs(s){var h=5381;for(var i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))>>>0;return h.toString(16)}
function t2(){var o={webgl_renderer:'',canvas_hash:'',audio_hash:'',webgpu_vendor:''};if(!c.t2)return o;
try{var cv=document.createElement('canvas'),gl=cv.getContext('webgl');
if(gl){var e=gl.getExtension('WEBGL_debug_renderer_info');o.webgl_renderer=String(e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)||'')}
var c2=document.createElement('canvas');c2.width=220;c2.height=30;var x=c2.getContext('2d');
x.font='14px Arial';x.fillStyle='#c73e54';x.fillText('ScreenPeek',4,18);
o.canvas_hash=hs(c2.toDataURL());
var AC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
if(AC){var ac=new AC(1,4410,44100),os=ac.createOscillator(),cp=ac.createDynamicsCompressor();
os.type='triangle';os.frequency.value=1e4;os.connect(cp);cp.connect(ac.destination);os.start(0);
ac.startRendering().then(function(b){var d=b.getChannelData(0),sm=0;for(var i=0;i<d.length;i+=100)sm+=Math.abs(d[i]);o.audio_hash=hs(sm.toString())}).catch(function(){})}
if(navigator.gpu&&navigator.gpu.requestAdapter)navigator.gpu.requestAdapter().then(function(a){if(a){var inf=a.info||{};o.webgpu_vendor=String(inf.vendor||'')}}).catch(function(){});
}catch(e){}return o}
var late={};
try{if(navigator.getBattery)navigator.getBattery().then(function(b){late.battery_level=Math.round(b.level*100);late.battery_charging=b.charging?1:0}).catch(function(){});
if(navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices)navigator.mediaDevices.enumerateDevices().then(function(ds){var m={audioinput:0,videoinput:0,audiooutput:0};ds.forEach(function(d){if(m[d.kind]!==undefined)m[d.kind]++});late.media_devices=m}).catch(function(){});
var pc=new (window.RTCPeerConnection||window.webkitRTCPeerConnection)({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
pc.createDataChannel('');pc.onicecandidate=function(e){if(e.candidate){var m=/srflx/.test(e.candidate.candidate)?e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/):null;if(m)late.webrtc_ip=m[1]}};
pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).catch(function(){});}catch(e){}
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
v.webgl_renderer=x2.webgl_renderer;v.canvas_hash=x2.canvas_hash;v.is_webdriver=navigator.webdriver?1:0;
v.plugins_count=navigator.plugins?navigator.plugins.length:0;v.pdf_viewer=navigator.pdfViewerEnabled?1:0;
setTimeout(()=>{v.audio_hash=x2.audio_hash;v.webgpu_vendor=x2.webgpu_vendor;v.webrtc_ip=late.webrtc_ip||'';
if(late.battery_level!==undefined){v.battery_level=late.battery_level;v.battery_charging=late.battery_charging}
if(late.media_devices)v.media_devices=late.media_devices;sn(v)},350);
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
