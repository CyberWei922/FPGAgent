import { sha256, invariant } from './snapshot.mjs';
export function checkerIdentity(checkers) {return sha256(JSON.stringify(checkers));}
export function comparable(e,hash,checkers) {
  invariant(e.candidate_sha256===hash&&e.checker_set_sha256===checkerIdentity(checkers),'STALE_SNAPSHOT','Evidence identity mismatch');
  invariant(Array.isArray(e.checks)&&e.checks.length===checkers.length&&new Set(e.checks.map(x=>x.id)).size===checkers.length&&checkers.every(x=>e.checks.some(y=>y.id===x.id)),'CHECKER_UNCERTAIN','Checker set incomplete');
  invariant(e.checks.every(x=>['pass','fail','unknown','error','timeout'].includes(x.status)),'CHECKER_UNCERTAIN');
  return e;
}
export function selectCandidate(incumbent,candidate,oldEvidence,newEvidence,targetIds=oldEvidence.checks.filter(c=>c.status==='fail').map(c=>c.id)) {
  if(oldEvidence.checker_set_sha256!==newEvidence.checker_set_sha256)return {accepted:false,reason:'checker_set_changed'};
  const old=new Map(oldEvidence.checks.map(x=>[x.id,x]));
  const next=new Map(newEvidence.checks.map(x=>[x.id,x]));
  if(old.size!==next.size||[...old.keys()].some(k=>!next.has(k)))return {accepted:false,reason:'incomparable_checks'};
  if(!['interface','compile'].every(k=>newEvidence.checks.some(c=>c.stage===k&&c.status==='pass')))return {accepted:false,reason:'interface_or_compile_not_passed'};
  for(const [k,v] of old)if(v.status==='pass'&&next.get(k).status!=='pass')return {accepted:false,reason:next.get(k).status==='fail'?'explicit_regression':'lost_pass_evidence'};
  if(targetIds.some(k=>old.get(k)?.status==='fail'&&next.get(k)?.status==='pass'))return {accepted:true,reason:'verified_improvement'};
  return {accepted:false,reason:'no_verified_improvement'};
}
