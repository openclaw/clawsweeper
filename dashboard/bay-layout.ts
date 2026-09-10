// Observer-only presentation; no fetching or mutation commands.
export const bayLayoutCss = String.raw`
/* Four logical groups, sized by content rather than a fixed header height. */
.hero{grid-template-columns:270px minmax(0,1fr);gap:18px;padding:8px 28px;min-height:116px}.hero h1{font-size:25px;white-space:normal}.hero-lede{font-size:12px;margin-top:4px}.hero-status{gap:5px;margin-top:5px}.live-chip{padding:0;border:0;background:transparent;line-height:1.4}.live-chip i{display:none}.notice{border-radius:4px;padding:2px 5px}.snapshot-line{font-size:12px;color:var(--ink-2);margin-top:3px;overflow-wrap:anywhere}
.hero-stat{display:grid;grid-template-columns:120px 244px minmax(0,1fr);gap:20px;width:auto;padding:0;border:0;background:transparent;box-shadow:none;align-items:center}.stat-label{font-size:11px;letter-spacing:.03em}.stat-value{font-size:30px}.stat-sub{font-size:12px;line-height:1.35;color:var(--ink-2)}.no-sample .stat-value{font-size:20px}
.inline-proof-comparison{display:block;padding:0;min-width:0}.inline-proof-comparison label{display:block;margin-bottom:3px}.inline-proof-comparison select{width:100%;min-height:44px;padding:8px;font-size:12px}.inline-proof-comparison #inline-proof-note{display:block;font-size:11px;line-height:1.35;color:var(--ink-2);margin-top:4px}.journey-chart-host{min-width:0;padding-left:16px;border-left:1px solid #cdded3}.journey-chart{margin:0}.journey-plot,.journey-y-axis{height:76px}.journey-chart-unit{margin-bottom:4px}.journey-chart-note{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%)}.chart-unavailable{min-height:100px;display:grid;place-items:center;color:var(--muted);border:1px dashed var(--line-2);padding:12px}.journey-x-axis{font-size:10px}
.shore-toolbar{padding:8px 28px;gap:10px;background:var(--paper)}.finder{flex:1 1 270px;min-width:0;flex-wrap:wrap}.finder input{width:100%;min-width:0;flex:1 1 140px;height:44px}.finder-status{flex-basis:100%;font-size:11px;white-space:normal;margin:0}.btn,.toggle,.repo-button{min-height:44px;height:auto}.btn{padding:8px 10px}.repo-bar{gap:4px;max-width:100%}.repo-button{max-width:100%;overflow-wrap:anywhere;white-space:normal;text-align:left}.repo-bar>span{display:none}.toolbar-right{gap:8px}#refresh-bay{min-width:44px;min-height:44px;font-size:18px}.view-options{display:block}.view-menu{position:relative}.view-menu>summary{display:flex;align-items:center;min-height:44px;padding:8px 12px;border:1px solid var(--line-2);border-radius:7px;cursor:pointer;background:var(--surface);list-style:none}.view-menu>summary::-webkit-details-marker{display:none}.view-panel{position:absolute;z-index:85;right:0;top:calc(100% + 6px);width:300px;max-width:calc(100vw - 24px);padding:16px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);box-shadow:var(--shadow-1)}.view-panel p{font-size:12px;line-height:1.5;margin-top:10px;color:var(--ink-2)}.view-panel label{display:flex;align-items:center;gap:8px;min-height:44px}.view-panel .tide{flex-wrap:wrap;margin-top:12px}.view-panel .segmented{height:auto;border-radius:7px;padding:0;flex-wrap:wrap}.segmented button{min-height:44px;height:auto}.view-panel .segmented>span{padding-left:8px}.review-path-select{display:flex;flex-direction:column;gap:3px;font-size:11px}.review-path-select select{min-height:44px;width:218px;max-width:100%;padding:8px;border:1px solid var(--line-2);border-radius:7px;background:var(--surface);font:inherit;font-size:12px;color:inherit}.view-panel input{width:18px;height:18px;accent-color:var(--sea)}

/* Stable slots retain full-sized sprites and readable two-line identities. */
.beach{min-height:815px;touch-action:pan-y;--master-rest-left:4%;--master-rest-top:20px}.beach .master.resting{transform-origin:top left}.beach-inner{min-height:815px;padding:155px 23% 56px 4%}.stage-grid{grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;height:565px}.stage h2,.pool h2{font-size:12px;line-height:1.3;white-space:normal;max-width:100%;text-align:center;letter-spacing:.02em;padding:7px;min-height:44px;width:max-content}.stage h2 span,.pool h2 span{display:block;margin:3px 0 0}.lane-help{display:none}.stage-body{inset:0 0 90px;display:flex;flex-direction:column;align-items:center;gap:18px}.beach .critter,.beach .pool .critter{position:relative;left:auto;top:auto;width:126px;max-width:100%;height:110px;min-height:110px;flex:none;padding:0;scale:1;--label-scale:1;transition:filter .2s;will-change:auto}.beach .critter:hover,.beach .critter:focus-visible,.beach .critter.located{scale:1;transform:none;outline:2px solid var(--sea);outline-offset:2px;border-radius:8px}.beach .critter .ref,.beach .pool .critter .ref{top:0;max-width:100%;width:122px;padding:5px 6px;line-height:1.3;font-size:12px;scale:1}.ref .repo-short,.ref strong{display:block;overflow:hidden;text-overflow:ellipsis;font:inherit;white-space:nowrap}.ref .repo-short{color:var(--ink-2)}.beach .critter .sprite,.beach .pool .critter .sprite{top:43px;width:78px;height:56px}.beach .active-duration,.beach .journey-duration{position:absolute;top:99px;left:0;right:0;margin:auto;max-width:100%;font-size:10px}.beach .ready-flag,.beach .confirming-flag{top:53px;right:0}.beach .critter.ready{top:auto!important}.overflow-note{min-height:44px;bottom:-18px;width:100%;white-space:normal;border-radius:7px;padding:6px;font-size:12px}.overflow-note small{display:block;font-size:11px;color:var(--muted)}.sample-count{position:absolute;top:-30px;left:0;right:0;font-size:11px;text-align:center;color:#574833;background:#fff9e9d9;border-radius:5px;padding:3px}.terminal-stack{top:155px;bottom:56px;width:20%;gap:16px}.terminal-stack .pool,.terminal-stack .pool.empty-pool{flex:0 0 360px!important;min-height:360px}.terminal-stack .pool.attention{flex-basis:220px!important;min-height:220px}.pool-body{inset:7px 8px 112px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;justify-items:center;gap:14px 2px}.pool .overflow-note{bottom:-60px}.pool .sample-count{top:-30px}.empty{top:20%;left:5%;right:5%;border-radius:8px;line-height:1.5;color:#65553d}.pool .empty{top:20%}.sample-note{left:4%;right:4%;bottom:10px;width:max-content;max-width:92%;border-radius:6px;font-size:11px}.focus-nav{display:none}.drawer-head h2,.drawer-stat strong{overflow-wrap:anywhere}.drawer-close{width:44px;height:44px}.drawer-links a{min-height:44px;display:inline-flex;align-items:center}.queue-sample-list button{min-height:44px;text-align:left;overflow-wrap:anywhere}.queue-sample-list li{align-items:center}.queue-sample-list span{flex:none}.drawer-body{max-height:calc(100dvh - 150px)}
@media(min-width:1200px){.hero-stat .summary-mean{display:block}.journey-chart-unit{font-size:11px}}
/* The focused scene keeps its existing item/control coordinates. The resting
   sweeper ends 10px below that scene; the in-flow note starts 24px below it,
   retaining a 14px gap regardless of how the count text wraps. */
@media(max-width:1199px){.hero{grid-template-columns:1fr;padding:10px 20px;gap:10px}.hero-copy{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px}.hero h1{grid-row:1/3}.hero-lede{display:none}.hero-status{margin:0}.snapshot-line{grid-column:2}.hero-stat{grid-template-columns:120px 244px minmax(0,1fr);gap:14px}.shore-toolbar{padding:8px 20px}.beach{--bay-scene-height:580px;--master-rest-left:16px;--master-rest-top:calc(var(--bay-scene-height) - 60px);min-height:var(--bay-scene-height);height:auto}.beach-inner{min-height:var(--bay-scene-height);height:var(--bay-scene-height)}.beach{overflow:hidden;background-size:auto 835px;background-position:40% bottom}.beach-inner{padding:0;min-width:0}.stage-grid,.stage-grid.portrait-stack{position:absolute;left:16px;right:16px;top:126px;bottom:64px;height:auto;display:block}.stage-grid .stage{display:none;min-height:0;height:100%;max-width:560px;margin:auto}.stage-grid .stage.focused{display:block}.stage-body{inset:0 0 90px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;justify-items:center;gap:18px 6px;max-width:380px;margin:auto}.stage-body>.critter:nth-of-type(3){grid-column:1/3}.stage:after,.lane-lines,.terminal-stack:before{display:none}.stage .sample-count,.pool .sample-count{display:none}.terminal-stack{position:absolute;left:16px;right:16px;top:126px;bottom:64px;width:auto;display:contents}.terminal-stack .pool,.terminal-stack .pool.empty-pool{display:none;position:absolute;left:16px;right:16px;top:126px;bottom:auto;width:auto;height:calc(var(--bay-scene-height) - 126px - 64px);min-height:0;max-width:560px;margin:auto}.terminal-stack .pool.focused{display:block}.stage h2,.pool h2{top:auto;bottom:7px}.pool-body{inset:0 8px 90px;max-width:380px;margin:auto;gap:18px 6px}.pool .overflow-note,.overflow-note{bottom:-18px;width:90%;max-width:300px}.focus-nav{display:grid;position:absolute;z-index:30;top:12px;left:12px;right:12px;grid-template-columns:44px minmax(0,1fr) 44px;gap:6px 8px;padding:10px;border:1px solid #b4a57e;border-radius:10px;background:#fff9e9f2;box-shadow:var(--shadow-1)}.focus-nav label{grid-column:1/4;font-size:11px;color:var(--ink-2)}.focus-nav select{grid-column:2;grid-row:2;min-width:0;min-height:44px;padding:4px 6px;border:1px solid #b4a57e;border-radius:6px;background:var(--surface);font:inherit;color:inherit}.focus-nav button{grid-row:2;min-width:44px;min-height:44px;padding:2px;font-size:11px}.focus-nav #previous-stage{grid-column:1}.focus-nav #next-stage{grid-column:3}.focus-count{grid-column:1/4;font-size:11px;color:var(--ink-2)}.beach .master{width:110px;height:70px;left:0!important;top:calc(var(--bay-scene-height) - 70px - 16px)!important;bottom:auto;transform:none!important}.beach .master.resting{left:var(--master-rest-left)!important;top:var(--master-rest-top)!important;bottom:auto}.beach .chat-overlay{display:none}.beach .sample-note{position:relative;margin:24px 16px 10px;left:auto;right:auto;bottom:auto;max-width:calc(100% - 32px);width:auto}.beach .find-arrow{display:none}}
@media(max-width:600px){.masthead{padding:0 16px;height:auto;min-height:52px;gap:12px;flex-wrap:nowrap}.nav{overflow-x:auto;flex:1;min-width:0;margin:0;padding:0}.brand{flex:none}.nav a{min-height:44px;display:flex;align-items:center;padding:6px 10px}.brand-text strong{font-size:18px}.brand-text small{font-size:8px}.hero{padding:8px 16px;gap:6px}.hero-copy{display:block}.hero h1{font-size:25px}.hero-status{margin-top:4px}.snapshot-line{font-size:11px}.hero-stat{grid-template-columns:minmax(0,1fr);gap:6px}.journey-summary{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.stat-label{font-size:10px}.stat-value,.no-sample .stat-value{font-size:23px;margin:0}.stat-sub{font-size:11px;margin:0}.inline-proof-comparison label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.inline-proof-comparison{display:grid;grid-template-columns:minmax(0,1fr);gap:2px}.inline-proof-comparison select{font-size:12px}.inline-proof-comparison #inline-proof-note{font-size:10px;margin:0}.journey-chart-host{border:0;padding:0}.journey-plot,.journey-y-axis{height:63px}.journey-chart-unit{font-size:10px}.journey-x-axis{font-size:9px}.shore-toolbar{padding:6px 16px;gap:6px;display:flex}.finder{flex-basis:100%;gap:5px}.finder input{font-size:12px}.finder-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.finder.not-found .finder-status{position:static;width:auto;height:auto;clip-path:none}.repo-bar{flex-wrap:nowrap;overflow-x:auto;width:100%;padding:2px 0}.repo-button{flex:none;font-size:11px;max-width:200px;min-height:44px}.toolbar-right{width:100%;justify-content:space-between;margin:0;align-items:flex-end}.review-path-select{flex:1;max-width:calc(100% - 158px)}.review-path-select select{width:100%;font-size:11px}.view-menu>summary{font-size:12px;padding:8px}.view-panel{right:0}.btn{font-size:12px}.queue-sample-list{padding-bottom:20px}}
body.reduce-motion *,body.reduce-motion *::before,body.reduce-motion *::after{animation:none!important;transition:none!important}.reduce-motion .critter{will-change:auto}
`;

export const bayFocusNavigation = String.raw`<nav class="focus-nav" aria-label="Shoreline areas"><label for="focused-stage">Explore the shoreline</label><button class="btn" id="previous-stage" type="button" aria-label="Previous area">←<br>Prev</button><select id="focused-stage" aria-describedby="focus-count"></select><button class="btn" id="next-stage" type="button" aria-label="Next area">→<br>Next</button><span class="focus-count" id="focus-count" role="status"></span></nav>`;

export const bayLayoutScript = String.raw`
  var focusedStage="arriving",focusInitialized=false,resizeTimer=null;
  var bayDialogStack=[],bayNavigationFocus=null;
  var BAY_AREAS=STAGES.concat(["completed","attention"]);
  function areaLabel(area){return area==="attention"?"Failed / cancelled":LABELS[area];}
  function areaForItem(item){return item.stage==="failed"||item.stage==="cancelled"?"attention":item.stage;}
  function areaRows(area){return visible(state.items).filter(function(item){return areaForItem(item)===area;}).sort(function(a,b){return a.key<b.key?-1:a.key>b.key?1:0;});}
  function drawnLimit(area){return area==="completed"?4:area==="attention"?2:3;}
  function areaCounts(area){var rows=areaRows(area),aggregate=STAGES.includes(area)?queueStageSummary(area,rows).label:null;return {sampled:rows.length,drawn:Math.min(rows.length,drawnLimit(area)),aggregate:aggregate};}
  function areaCountCopy(area){var counts=areaCounts(area);return (counts.aggregate!==null?(state.filter==="all"?"Aggregate ":"Filtered sample ")+counts.aggregate+" · ":"")+counts.sampled+" sampled · "+counts.drawn+" drawn";}
  function sampleControl(area){var count=areaRows(area).length,hidden=Math.max(0,count-drawnLimit(area));return '<span class="sample-count">'+esc(areaCountCopy(area))+'</span>'+(count?'<button class="overflow-note" type="button" data-overflow-stage="'+esc(area)+'" data-overflow-terminal="'+(!STAGES.includes(area))+'">'+(hidden?'+'+hidden+' sampled items':'View sampled items')+'<small>View list · '+count+' available</small></button>':'');}
  function renderAreaNavigation(){
    if(!focusInitialized&&state.items.length){focusedStage=BAY_AREAS.find(function(area){return areaRows(area).length;})||"arriving";focusInitialized=true;}
    var select=document.getElementById("focused-stage");
    var options=BAY_AREAS.map(function(area){return '<option value="'+area+'">'+esc(areaLabel(area))+'</option>';}).join("");
    if(select.innerHTML!==options)select.innerHTML=options;
    select.value=focusedStage;
    var index=BAY_AREAS.indexOf(focusedStage);
    document.getElementById("previous-stage").disabled=index===0;
    document.getElementById("next-stage").disabled=index===BAY_AREAS.length-1;
    document.getElementById("focus-count").textContent=areaCountCopy(focusedStage);
    document.querySelectorAll(".stage,.pool").forEach(function(section){var area=section.classList.contains("attention")?"attention":section.dataset.stage;section.classList.toggle("focused",area===focusedStage);});
  }
  function flushPendingForNavigation(){if(!state.pendingItems)return;state.masterPending=false;parkMaster(true);applyPendingItems();if(!masterReduced())afterMasterRests(state.masterSequence);}
  function selectArea(area){if(!BAY_AREAS.includes(area))return;focusedStage=area;focusInitialized=true;clearLaneChat();flushPendingForNavigation();renderAreaNavigation();}
  function updateSnapshotLine(){var data=state.data||{},at=Date.parse(data.freshness&&data.freshness.generated_at||""),fresh=data.freshness||{};document.getElementById("snapshot-line").textContent=Number.isFinite(at)?"Snapshot · "+new Date(at).toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC")+(fresh.state==="stale"?" · stale":""):"Snapshot time unavailable";}
  function topBayDialog(){
    // DOM order is not top-layer order: the item dialog precedes the sample
    // dialog in the document, but opens above it. Track our showModal order.
    bayDialogStack=bayDialogStack.filter(function(dialog){return dialog.isConnected&&dialog.open;});
    return bayDialogStack.length?bayDialogStack[bayDialogStack.length-1]:null;
  }
  function bayFocusAvailable(node){
    if(!node||!node.isConnected||!node.getClientRects().length||node.matches(':disabled,input[type="hidden"]')||node.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]'))return false;
    var style=window.getComputedStyle(node);
    if(style.visibility==="hidden"||style.visibility==="collapse")return false;
    for(var ancestor=node;ancestor;ancestor=ancestor.parentElement){var ancestorStyle=window.getComputedStyle(ancestor);if(ancestorStyle.display==="none"||ancestorStyle.opacity==="0"||ancestorStyle.contentVisibility==="hidden")return false;}
    return true;
  }
  function bayDialogTabbables(dialog){
    var nodes=Array.from(dialog.querySelectorAll('button,a[href],area[href],input,select,textarea,summary,[tabindex],[contenteditable]')).filter(function(node){return node.tabIndex>=0&&node.closest("dialog")===dialog&&bayFocusAvailable(node);});
    nodes=nodes.filter(function(node){if(!node.matches('input[type="radio"]')||!node.name)return true;var group=nodes.filter(function(other){return other.matches('input[type="radio"]')&&other.name===node.name&&other.form===node.form;});return node===(group.find(function(other){return other.checked;})||group[0]);});
    return nodes.map(function(node,index){return {node:node,index:index};}).sort(function(a,b){var first=a.node.tabIndex>0?a.node.tabIndex:Infinity,second=b.node.tabIndex>0?b.node.tabIndex:Infinity;return first===second?a.index-b.index:first-second;}).map(function(entry){return entry.node;});
  }
  function containBayDialogTab(event){
    if(event.key!=="Tab"||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
    var dialog=topBayDialog();if(!dialog)return;
    var nodes=bayDialogTabbables(dialog),first=nodes[0],last=nodes[nodes.length-1],active=document.activeElement;
    if(!nodes.length){event.preventDefault();dialog.focus({preventScroll:true});return;}
    if(nodes.indexOf(active)<0||event.shiftKey&&active===first||!event.shiftKey&&active===last){event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});}
    // Interior Tab navigation stays native. Modified/browser shortcuts and
    // child widgets that already consumed the event are never intercepted.
  }
  function rememberDialogFocus(dialog){
    var node=document.activeElement;
    dialog.bayOpener=node?{id:node.id,key:node.dataset&&node.dataset.key,area:node.dataset&&node.dataset.overflowStage,reference:node.dataset&&node.dataset.overflowReference}:null;
    bayDialogStack=bayDialogStack.filter(function(opened){return opened!==dialog&&opened.isConnected&&opened.open;});
    // Called immediately before showModal, including its synchronous focus step.
    bayDialogStack.push(dialog);
  }
  function restoreDialogFocus(dialog){
    bayDialogStack=bayDialogStack.filter(function(opened){return opened!==dialog;});
    var top=topBayDialog(),opener=dialog.bayOpener,root=top||document;
    // Native close events are queued; preserve newer valid focus in the current modal scope.
    var active=document.activeElement;
    if(active&&active!==document.body&&active!==document.documentElement&&active!==top&&!dialog.contains(active)&&(!top||top.contains(active))&&bayFocusAvailable(active))return;
    var node=opener&&Array.from(root.querySelectorAll("button,a,select,input,textarea,summary,[tabindex]")).find(function(candidate){return opener.id?candidate.id===opener.id:opener.key?candidate.dataset.key===opener.key:opener.area?candidate.dataset.overflowStage===opener.area:opener.reference?candidate.dataset.overflowReference===opener.reference:false;});
    if(!bayFocusAvailable(node))node=top?(bayDialogTabbables(top)[0]||top):(portraitLayout()?document.getElementById("focused-stage"):document.getElementById("finder-input"));
    // Never return focus to an opener in an inert underlying dialog or beach.
    if(node&&(top?node===top||top.contains(node):bayFocusAvailable(node)))node.focus({preventScroll:true});
  }
  function restoreBayItemFocus(key,area){
    if(!key&&!area)return;
    var replacement=Array.from(document.querySelectorAll(".critter,.overflow-note")).find(function(node){return key?node.dataset.key===key:node.dataset.overflowStage===area;});
    var target=bayFocusAvailable(replacement)?replacement:document.getElementById(portraitLayout()?"focused-stage":"finder-input");
    if(bayFocusAvailable(target))target.focus({preventScroll:true});
  }
  function applyBayMotion(reduced){
    var wasReduced=masterReduced();
    document.body.classList.toggle("reduce-motion",reduced);
    if(masterReduced()){clearLaneChat();parkMaster(true);applyPendingItems();if(document.getAnimations)document.getAnimations().forEach(function(animation){animation.cancel();});}
    else{scheduleLaneChat();if(wasReduced&&state.brush==="patrol")beginMasterSweep("patrol");}
  }
  function rememberBayNavigationFocus(event){
    var node=event.target;
    if(event.type==="focusin")bayNavigationFocus=node&&["focused-stage","previous-stage","next-stage"].includes(node.id)?node:null;
    else if(node===bayNavigationFocus&&bayFocusAvailable(node))bayNavigationFocus=null;
  }
  function restoreBayNavigationFocus(){
    var node=bayNavigationFocus,active=document.activeElement;
    if(!node||bayFocusAvailable(node)||topBayDialog())return;
    bayNavigationFocus=null;
    if(active!==node&&active!==document.body&&active!==document.documentElement)return;
    var fallback=document.getElementById("finder-input");
    if(bayFocusAvailable(fallback))fallback.focus({preventScroll:true});
  }
  function bindBayMotionControl(motion,preference){
    var manualReduced=false;
    function syncMotion(){
      motion.checked=manualReduced||preference.matches;
      motion.disabled=preference.matches;
      motion.title=preference.matches?"Reduced motion is enabled by your system preference.":"";
      applyBayMotion(motion.checked);
    }
    motion.addEventListener("change",function(){manualReduced=motion.checked;syncMotion();});
    preference.addEventListener("change",syncMotion);
    syncMotion();
  }
  function bindBayLayout(){
    document.addEventListener("focusin",rememberBayNavigationFocus);
    document.addEventListener("focusout",rememberBayNavigationFocus);
    document.getElementById("focused-stage").addEventListener("change",function(event){selectArea(event.target.value);});
    document.getElementById("previous-stage").addEventListener("click",function(){selectArea(BAY_AREAS[BAY_AREAS.indexOf(focusedStage)-1]);});
    document.getElementById("next-stage").addEventListener("click",function(){selectArea(BAY_AREAS[BAY_AREAS.indexOf(focusedStage)+1]);});
    document.getElementById("refresh-bay").addEventListener("click",function(){void load();void loadDurableLifecycle();});
    var motion=document.getElementById("reduce-motion"),preference=window.matchMedia("(prefers-reduced-motion: reduce)");
    bindBayMotionControl(motion,preference);
    document.addEventListener("keydown",containBayDialogTab);
    document.addEventListener("keydown",function(event){if(event.key!=="Escape"||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||topBayDialog())return;var menu=document.querySelector(".view-menu[open]");if(menu){menu.open=false;menu.querySelector("summary").focus();}});
  }
`;
