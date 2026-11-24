import { invariant } from './snapshot.mjs';
import {relocateLocations} from '../harness/code-references.mjs';

// Logical issue packages live in ordinary memory/on disk, never in independent
// GPU KV slots. Never carry a source range across a candidate version.
export function selectIssueGroup(review,index,failedEvidenceIds=[],{firstOnly=false}={}) {
  const issues=review.payload.issues.filter(i=>i.category!=='checker');
  if(!issues.length)return [];
  // Diagnosis v2 preserves encounter order; one author session handles exactly
  // one finding, even when compilation prevents a reliable local unit index.
  if(firstOnly)return [issues[0]];
  const priority={blocking:0,major:1,minor:2};
  const ranked=[...issues].sort((a,b)=>Number(!a.evidence_ids.some(x=>failedEvidenceIds.includes(x)))-Number(!b.evidence_ids.some(x=>failedEvidenceIds.includes(x)))||priority[a.severity]-priority[b.severity]);
  if(!index.ok||issues.some(i=>['global','unknown'].includes(i.scope)))return issues;
  const group=[ranked[0]],units=new Set(group[0].unit_ids);
  const related=u=>index.units.find(x=>x.unit_id===u)?.identifiers??[];
  let changed=true;
  while(changed) {
    changed=false;
    const names=new Set([...units].flatMap(related));
    for(const issue of issues)if(!group.includes(issue)&&issue.unit_ids.some(u=>units.has(u)||related(u).some(n=>names.has(n)))) {
      group.push(issue);issue.unit_ids.forEach(u=>units.add(u));changed=true;
    }
  }
  return group;
}

export function recordReview(ledger,base,review) {
  invariant(review.payload.candidate_sha256===base.sha256,'STALE_SNAPSHOT');
  for(const entry of ledger)if(entry.status==='open')entry.status='stale_requires_recheck';
  for(const issue of review.payload.issues){
    const ancestor=ledger.findLast(e=>e.issue.id===issue.id&&e.assessed_on===base.sha256&&e.status==='stale_requires_recheck');
    const key=`${base.sha256}:${issue.id}`;
    ledger.push({key,candidate_sha256:base.sha256,issue:structuredClone(issue),status:'open',
      origin_key:ancestor?.origin_key??key,origin_candidate_sha256:ancestor?.origin_candidate_sha256??base.sha256,origin_issue:structuredClone(ancestor?.origin_issue??issue)});
  }
  return ledger;
}

export function repairReviewContext(previousReview,previousCandidate,targetIds,currentCandidate=null) {
  invariant(previousReview.payload.candidate_sha256===previousCandidate.sha256,'STALE_SNAPSHOT');
  const issues=previousReview.payload.issues;
  const {id,sha256,rtl}=previousCandidate;
  return {previous_candidate:{id,sha256,rtl},previous_issues:structuredClone(issues),target_issue_ids:targetIds,
    pending_issue_ids:issues.filter(i=>!targetIds.includes(i.id)).map(i=>i.id),
    ...(currentCandidate?{location_updates:issues.map(i=>({issue_id:i.id,...relocateLocations(rtl,currentCandidate.rtl,i.code_locations)}))}:{})};
}
