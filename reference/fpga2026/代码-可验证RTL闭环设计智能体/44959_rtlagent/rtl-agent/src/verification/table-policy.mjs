import {invariant} from '../dual/snapshot.mjs';

export const HANDWRITTEN_TABLE_METHODS=Object.freeze(['moore_table','bounded_moore','mealy_table','fsm']);
// Selected on the SAME 85 frozen development references (77 pass, 3 wrong,
// 5 unavailable): >=7 removes 2 wrong and 0 passing checkers. This can overfit;
// independent held-out acceptance is still required. Count semantic rows, NOT
// encoding bits, reached rows or tested transitions.
export const TABLE_REVIEW_MIN_STATES=7;
export const tableGuardEnabled=()=>process.env.AGENT_VERIFICATION_TABLE_GUARD!=='0';

// CPU-only provenance. Non-table methods are exact no-ops, including key order.
export function attachTableMetadata(value,raw){
  if(HANDWRITTEN_TABLE_METHODS.includes(raw.method))value.handwritten_table={method:raw.method,states:(raw.params.rows??raw.params.states).length};
  return value;
}

export function tableSafetyDecision(table,assurance,{enabled=tableGuardEnabled()}={}){
  if(!table)return null;
  invariant(table&&typeof table==='object'&&!Array.isArray(table)&&Object.keys(table).length===2&&HANDWRITTEN_TABLE_METHODS.includes(table.method)&&Number.isSafeInteger(table.states)&&table.states>=1&&table.states<=64,'TEST_PLAN_INVALID','Invalid handwritten table state metadata');
  const reviewStatus=assurance?.method===table.method?assurance.review_verdict??'not_accepted':assurance?'method_mismatch':'not_reviewed';
  const accepted=assurance?.version===1&&assurance.method===table.method&&assurance.semantic_correctness==='reviewed_not_proven'&&reviewStatus==='accept';
  const advisory=enabled&&table.states>=TABLE_REVIEW_MIN_STATES&&!accepted;
  return {method:table.method,states:table.states,min_states:TABLE_REVIEW_MIN_STATES,enabled,review_status:reviewStatus,semantic_review_accepted:accepted,decision:advisory?'advisory_only':'automatic',
    reason:advisory?`Handwritten ${table.method}: ${table.states} semantic states >= ${TABLE_REVIEW_MIN_STATES}; semantic review ${reviewStatus}, not explicitly accepted. Reference only: not attached to automatic verification; cannot reject drafts, drive repair or participate in candidate selection.`:!enabled?'State-table safety guard explicitly disabled for comparison.':accepted?'Semantic review explicitly accepted this method; correctness is still not proven.':'Semantic state count below the empirically selected review threshold.'};
}

export function applyTableSafety(plan,raw){
  const policy=tableSafetyDecision(raw.handwritten_table,raw.assurance);
  if(!policy)return plan;
  plan.handwritten_table=structuredClone(raw.handwritten_table);
  plan.coverage.table_safety=policy;
  if(policy.decision==='advisory_only'){
    plan.status='advisory_only';
    plan.coverage.uncovered.push(policy.reason);
  }
  return plan;
}
