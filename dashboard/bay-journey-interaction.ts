// One plot-wide navigation surface; intervals are visual marks, not tiny controls.
export const bayJourneyInteractionCss = String.raw`
.journey-plot{touch-action:pan-y;cursor:crosshair;outline:none}
.journey-plot:focus-visible{outline:2px solid var(--sea);outline-offset:3px}
.journey-bucket{pointer-events:none}
.journey-bucket.selected{background-color:rgba(43,123,128,.12);outline:2px solid var(--sea);outline-offset:-2px}
.journey-tooltip{position:fixed;z-index:80;width:max-content;max-width:min(280px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:9px 11px;border:1px solid var(--sea);border-radius:8px;background:var(--surface);box-shadow:var(--shadow-1);color:var(--ink);font-size:12px;line-height:1.45;font-variant-numeric:tabular-nums;pointer-events:auto;user-select:text;overflow-wrap:anywhere}
.journey-tooltip[hidden]{display:none}
.journey-scrub-help{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;
export const bayJourneyInteractionScript = String.raw`
  var journeyInspection={key:null,open:false,mode:null,pointerId:null,plot:null,hideTimer:null,suppressHover:false};
  function journeyBuckets(plot){return Array.from(plot?plot.querySelectorAll(".journey-bucket"):[]);}
  function journeyTooltip(){return document.getElementById("journey-tooltip");}
  function positionJourneyTooltip(plot,bucket){
    var tooltip=journeyTooltip();if(!tooltip||tooltip.hidden||!plot||!bucket)return;
    var r=plot.getBoundingClientRect(),b=bucket.getBoundingClientRect(),width=document.documentElement.clientWidth,height=window.innerHeight;
    if(r.bottom<0||r.top>height||r.right<0||r.left>width){hideJourneyTooltip();return;}
    var tw=tooltip.offsetWidth,th=tooltip.offsetHeight,x=Math.max(8,Math.min(b.left+b.width/2-tw/2,width-tw-8)),y=r.top-th;
    if(y<8)y=r.bottom;
    tooltip.style.left=x+"px";tooltip.style.top=Math.max(8,Math.min(y,height-th-8))+"px";
  }
  function hideJourneyTooltip(){
    clearTimeout(journeyInspection.hideTimer);journeyInspection.open=false;
    var tooltip=journeyTooltip();if(tooltip)tooltip.hidden=true;
    document.querySelectorAll(".journey-bucket.selected").forEach(function(bucket){bucket.classList.remove("selected");});
  }
  function cancelJourneyPointer(){
    var plot=journeyInspection.plot,id=journeyInspection.pointerId;journeyInspection.pointerId=null;journeyInspection.plot=null;
    if(plot&&id!==null&&plot.hasPointerCapture(id))plot.releasePointerCapture(id);
  }
  function selectJourneyBucket(bucket,mode,show){
    var node=document.getElementById("overall-average"),plot=bucket&&bucket.closest(".journey-plot"),tooltip=journeyTooltip();
    if(!node||!plot||!tooltip||!node.contains(plot))return;
    var buckets=journeyBuckets(plot),index=buckets.indexOf(bucket),description=bucket.dataset.journeyDescription;
    if(index<0||!description)return;
    journeyInspection.key=bucket.dataset.journeyBucket;node.dataset.journeySelected=journeyInspection.key;
    if(mode)journeyInspection.mode=mode;
    plot.dataset.journeyBucket=journeyInspection.key;plot.setAttribute("aria-valuenow",String(index));plot.setAttribute("aria-valuetext",description);
    journeyInspection.open=show!==false;tooltip.textContent=description;tooltip.hidden=!journeyInspection.open;
    buckets.forEach(function(candidate){candidate.classList.toggle("selected",journeyInspection.open&&candidate===bucket);});
    if(journeyInspection.open)positionJourneyTooltip(plot,bucket);
  }
  function restoreJourneyBucket(node,focusedKey){
    var plot=node.querySelector(".journey-plot"),buckets=journeyBuckets(plot),key=focusedKey||journeyInspection.key||node.dataset.journeySelected;
    if(!buckets.length)return;
    var selected=buckets.find(function(bucket){return bucket.dataset.journeyBucket===key;});
    if(!selected&&key){var numeric=Number(key);selected=buckets.reduce(function(best,bucket){return Math.abs(Number(bucket.dataset.journeyBucket)-numeric)<Math.abs(Number(best.dataset.journeyBucket)-numeric)?bucket:best;},buckets[0]);}
    selectJourneyBucket(selected||buckets[buckets.length-1],null,journeyInspection.open);
  }
  function renderJourneyChart(host,html){
    var next=document.createElement("div");next.innerHTML=html;
    var current=host.querySelector(".journey-chart"),replacement=next.querySelector(".journey-chart"),plot=current&&current.querySelector(".journey-plot"),nextPlot=replacement&&replacement.querySelector(".journey-plot");
    if(!current||!replacement||!plot||!nextPlot){
      var hadFocus=plot===document.activeElement;
      cancelJourneyPointer();hideJourneyTooltip();host.innerHTML=html;
      if(hadFocus){var summary=document.getElementById("overall-average");summary.setAttribute("tabindex","-1");summary.focus({preventScroll:true});}
      return;
    }
    // Update in place: the plot keeps keyboard focus and active pointer capture.
    current.dataset.windowStart=replacement.dataset.windowStart;current.dataset.windowEnd=replacement.dataset.windowEnd;
    [".journey-chart-unit",".journey-y-axis",".journey-x-axis",".journey-chart-note"].forEach(function(selector){current.querySelector(selector).innerHTML=replacement.querySelector(selector).innerHTML;});
    plot.innerHTML=nextPlot.innerHTML;plot.setAttribute("aria-valuemax",nextPlot.getAttribute("aria-valuemax"));
  }
  function journeyBucketAt(plot,x){
    var buckets=journeyBuckets(plot),r=plot.getBoundingClientRect();if(!buckets.length||r.width<=0)return null;
    var chart=plot.closest(".journey-chart"),start=Date.parse(chart.dataset.windowStart),end=Date.parse(chart.dataset.windowEnd),at=start+Math.max(0,Math.min(1,(x-r.left)/r.width))*(end-start);
    return buckets.find(function(bucket){return at<Number(bucket.dataset.journeyEnd);})||buckets[buckets.length-1];
  }
  function bindJourneyInspection(){
    var host=document.getElementById("overall-average");
    function plotFor(event){return event.target instanceof Element?event.target.closest(".journey-plot"):null;}
    function inSurface(target){return target instanceof Element&&target.closest(".journey-plot,.journey-tooltip");}
    host.addEventListener("pointerdown",function(event){
      var plot=plotFor(event);if(!plot||event.isPrimary===false||event.button!==0)return;
      clearTimeout(journeyInspection.hideTimer);journeyInspection.suppressHover=false;
      journeyInspection.pointerId=event.pointerId;journeyInspection.plot=plot;
      selectJourneyBucket(journeyBucketAt(plot,event.clientX),event.pointerType==="touch"?"touch":"hover",true);
      plot.focus({preventScroll:true});plot.setPointerCapture(event.pointerId);
    });
    host.addEventListener("pointermove",function(event){
      var plot=plotFor(event);if(!plot||event.isPrimary===false)return;
      if(journeyInspection.pointerId===event.pointerId)selectJourneyBucket(journeyBucketAt(plot,event.clientX),event.pointerType==="touch"?"touch":"hover",true);
      else if(event.pointerType!=="touch"&&!journeyInspection.suppressHover)selectJourneyBucket(journeyBucketAt(plot,event.clientX),"hover",true);
    });
    ["pointerup","pointercancel","lostpointercapture"].forEach(function(type){host.addEventListener(type,function(event){if(event.pointerId!==journeyInspection.pointerId)return;cancelJourneyPointer();if(type==="pointercancel")hideJourneyTooltip();});});
    host.addEventListener("pointerover",function(event){if(!inSurface(event.target))return;clearTimeout(journeyInspection.hideTimer);if(!inSurface(event.relatedTarget))journeyInspection.suppressHover=false;});
    host.addEventListener("pointerout",function(event){
      if(!inSurface(event.target)||inSurface(event.relatedTarget)||journeyInspection.pointerId!==null)return;
      journeyInspection.suppressHover=false;
      if(journeyInspection.mode==="hover"||document.activeElement!==host.querySelector(".journey-plot"))journeyInspection.hideTimer=setTimeout(function(){var tooltip=journeyTooltip(),plot=host.querySelector(".journey-plot");if(!(tooltip&&tooltip.matches(":hover"))&&!(plot&&plot.matches(":hover")))hideJourneyTooltip();},180);
    });
    host.addEventListener("focusin",function(event){var plot=plotFor(event);if(plot&&event.target===plot&&journeyInspection.pointerId===null){clearTimeout(journeyInspection.hideTimer);journeyInspection.suppressHover=false;restoreJourneyBucket(host,plot.dataset.journeyBucket);selectJourneyBucket(journeyBuckets(plot).find(function(bucket){return bucket.dataset.journeyBucket===journeyInspection.key;}),"keyboard",true);}});
    host.addEventListener("focusout",function(event){if(plotFor(event))queueMicrotask(function(){var tooltip=journeyTooltip();if(!plotFor({target:document.activeElement})&&!(tooltip&&tooltip.matches(":hover")))hideJourneyTooltip();});});
    host.addEventListener("keydown",function(event){
      var plot=plotFor(event);if(!plot||event.target!==plot||event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.isComposing)return;
      var buckets=journeyBuckets(plot),index=Number(plot.getAttribute("aria-valuenow")),next=index;
      if(event.key==="Home")next=0;else if(event.key==="End")next=buckets.length-1;
      else if(event.key==="ArrowRight"||event.key==="ArrowUp")next++;else if(event.key==="ArrowLeft"||event.key==="ArrowDown")next--;
      else if(event.key!=="Enter"&&event.key!==" ")return;
      event.preventDefault();clearTimeout(journeyInspection.hideTimer);journeyInspection.suppressHover=false;selectJourneyBucket(buckets[Math.max(0,Math.min(buckets.length-1,next))],"keyboard",true);
    });
    document.addEventListener("keydown",function(event){if(event.key==="Escape"&&journeyInspection.open){journeyInspection.suppressHover=true;hideJourneyTooltip();cancelJourneyPointer();if(plotFor(event))event.preventDefault();}});
    document.addEventListener("pointerdown",function(event){if(event.isPrimary!==false&&!inSurface(event.target)){hideJourneyTooltip();cancelJourneyPointer();}});
    function reposition(){if(!journeyInspection.open)return;var plot=host.querySelector(".journey-plot"),bucket=journeyBuckets(plot).find(function(item){return item.dataset.journeyBucket===journeyInspection.key;});positionJourneyTooltip(plot,bucket);}
    window.addEventListener("resize",reposition);document.addEventListener("scroll",reposition,{capture:true,passive:true});
  }
`;
