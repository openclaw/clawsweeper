// View-only integration kept separate from the duration-chart renderer.
export const bayInlineProofControls = String.raw`<div class="inline-proof-comparison" role="region" aria-label="Inline proof timing comparison">
<label for="inline-proof-filter">Review timing</label>
<select id="inline-proof-filter" aria-describedby="inline-proof-note inline-proof-scope">
<option value="all">All reviews</option>
<option value="requested">Inline proof requested</option>
<option value="not_requested">No inline proof requested (known)</option>
<option value="unknown">Inline proof unknown</option>
</select>
<span id="inline-proof-note" role="status">Full request → final duration, including inline proof time. Request does not mean execution.</span>
<span id="inline-proof-scope" class="sr-only">Request does not mean execution. Repository filters affect only the beach. Review paths selects both beach and timing populations; this inline-proof control selects timing only.</span>
</div>`;
export const bayInlineProofScript = String.raw`
  var inlineProofFilter="all";
  function strictInlineProofCohorts(value,total){
    if(!value||typeof value!=="object")return null;
    var result={},samples=0;
    for(var key of ["requested","not_requested","unknown"]){
      var set=strictBayTimingSet(value[key]);
      if(!set)return null;
      samples+=set.overall.samples;result[key]=set;
    }
    return samples===total?result:null;
  }
  function inlineProofTimingSelection(set){
    var cohorts=set&&set.inline_proof,note=document.getElementById("inline-proof-note");
    var names={all:"All reviews",requested:"Inline proof requested",not_requested:"No inline proof requested (known)",unknown:"Inline proof unknown"};
    if(note){note.textContent="Full request → final, including inline proof. Request ≠ execution. "+(cohorts?cohorts.unknown.overall.samples+" unknown.":"Participation unknown.");note.title=names[inlineProofFilter]+". Request does not mean execution. Waiting and inline proof time are included. Repository filters affect only the beach.";}
    if(inlineProofFilter==="all")return set;
    // Missing cohort telemetry never becomes a false no-proof population.
    if(!cohorts)return {inline_proof_unavailable:true,overall:{samples:0,average_ms:null,median_ms:null},history:{bucket_minutes:5,points:[]}};
    return cohorts[inlineProofFilter];
  }
  function bindInlineProofFilter(){document.getElementById("inline-proof-filter").addEventListener("change",function(event){
    var next=event.target.value;
    inlineProofFilter=["requested","not_requested","unknown"].includes(next)?next:"all";
    updateTimingSummary();
  });}
`;
