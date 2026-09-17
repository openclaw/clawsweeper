import {
  reviewFailureExplanation,
  PUBLIC_REVIEW_FAILURE_STAGES,
  PUBLIC_REVIEW_FAILURE_REASONS,
} from "../src/review-failure-explanation.ts";

// Only fixed copy from the shared mapper is embedded. No snapshot or diagnostic
// strings are interpolated into executable browser code.
const stages = PUBLIC_REVIEW_FAILURE_STAGES;
const reasons = PUBLIC_REVIEW_FAILURE_REASONS;
const explanations = Object.fromEntries(
  stages.map((stage) => [
    stage,
    Object.fromEntries(
      reasons.flatMap((reason) => {
        const explanation = reviewFailureExplanation({ stage, reason });
        return explanation ? [[reason, explanation]] : [];
      }),
    ),
  ]),
);

export const bayReviewStatusScript = String.raw`
  var BAY_REVIEW_FAILURE_EXPLANATIONS=${JSON.stringify(explanations).replaceAll("<", "\\u003c")};
  function strictBayReviewFailure(value){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==2||!Object.prototype.hasOwnProperty.call(value,"stage")||!Object.prototype.hasOwnProperty.call(value,"reason")||typeof value.stage!=="string"||typeof value.reason!=="string"||!Object.prototype.hasOwnProperty.call(BAY_REVIEW_FAILURE_EXPLANATIONS,value.stage))return null;var reasons=BAY_REVIEW_FAILURE_EXPLANATIONS[value.stage];return Object.prototype.hasOwnProperty.call(reasons,value.reason)?{stage:value.stage,reason:value.reason}:null;}
  function bayReviewStatus(item){if(!item||item.outcome)return null;if(item.source==="live"){var action=strictBayAction(item.action),status=action&&action.status;return {type:item.activity_kind==="repair"?"Code repair":item.activity_kind==="review"?"Review workflow":"Live workflow",status:status==="in_progress"?"Running":status==="queued"?"Workflow queued":status==="completed"?"Workflow completed · awaiting refresh":"Live activity reported",short:status==="in_progress"?(item.activity_kind==="repair"?"Repair running":"Running"):status==="queued"?"Run queued":"Live workflow",explanation:null};}if(item.source!=="queue")return null;var disposition=item.queue_disposition,stoppedReview=disposition==="parked_exhausted",stopped=stoppedReview||disposition==="parked",scheduled=disposition==="retry_scheduled",failure=strictBayReviewFailure(item.review_failure),explanation=failure?BAY_REVIEW_FAILURE_EXPLANATIONS[failure.stage][failure.reason]:null;return {type:stoppedReview?"Stopped review":stopped?"Stopped queue work":scheduled?"Queued retry":item.stage==="repairing"?"Queue attention":"Queued work",status:disposition==="parked_exhausted"?"Retries exhausted · operator attention":stopped?"Parked · operator attention":scheduled?"Retry scheduled":item.stage==="repairing"?"Queued · not an active repair":"Queued",short:stoppedReview?"Review stopped":stopped?"Work stopped":scheduled?"Retry scheduled":"Work queued",explanation:explanation?"Last recorded review failure: "+explanation:stoppedReview?"Detailed historical reason unavailable. This stopped review record does not establish a specific failure cause.":stopped?"Detailed failure reason unavailable for this queue record.":null};}
`;
