import {invariant} from '../dual/snapshot.mjs';

const check=(ok,message)=>invariant(ok,'NUMERIC_CONTRACT_INVALID',message);
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const integer=s=>{check(typeof s==='string'&&s.length<=1240&&/^-?(?:0|[1-9]\d*|0x[0-9a-fA-F]+|0b[01]+)$/.test(s),'Use exact integer strings');return s.startsWith('-')?-BigInt(s.slice(1)):BigInt(s);};

export const NUMERIC_GUIDANCE=`Deterministic arithmetic, bit tests, masks, XOR indices, counts and packed values MUST use calculate_batch, not mental arithmetic. Choose the source meaning/operands first, submit a bounded batch, then use the returned facts. Each calculation ID is unique within this stage; source_refs must be nonempty known source/evidence IDs. Failed calculations are NOT facts. For any result used, add calculation_checks:[{calc:"c1",equals:"1"}] to the final stage JSON, or use {"calc":"c1"} for a test expectation. equals may be an exact integer string or equal/less/greater for compare. These are checked by the program and removed before stage validation. A false predicate requires a changed stimulus/interpretation, NOT an invented result. When a selected input must satisfy a source bit/mask predicate, calculate and check that predicate before relying on it. Batch independent checks together. No need to calculate direct literals or purely behavioral decisions. A calculator verifies numbers, NOT whether you chose the right signal, operation or cycle.`;

export const TEST_NUMERIC_GUIDANCE=`Test numeric contract overrides the plain expect strings above: every expect value is either {"calc":"successful calculation ID"} for a derived value, or {"literal":"integer string","source":"S1"} for a directly specified constant/one-bit behavioral output. The harness fills calc values exactly. A multibit literal must occur numerically in its cited source (zero may be grounded by an explicit zero/clear/reset-to-zero rule); arbitrary copied input patterns should use normalize, and concatenated bytes use concat. drive values remain integer strings chosen by you; cycles remains an integer. Include calculation_checks:[] in a ready test result, adding checks for any computed input preconditions. Unsupported results keep the original unsupported schema. Do not evade computation by removing useful datapath checks; select a small valid asymmetric example and use the calculator.`;

// This checks declared provenance and numeric equality, not natural-language
// semantics. In particular a citation cannot prove the chosen cycle is right.
export function resolveNumericContract(raw,{stage,ledger,context,expected}) {
  const value=structuredClone(raw),used=new Set();
  const receipt=id=>{const r=ledger.get(id);check(r?.status==='ok','Unknown or failed calculation ID: '+id);used.add(id);return r.result;};
  const checks=value.calculation_checks;
  if(stage==='plan_test'&&value.status==='ready')check(Array.isArray(checks),'Ready test requires calculation_checks');
  if(checks!==undefined){
    check(Array.isArray(checks)&&checks.length<=16,'At most 16 calculation checks');
    for(const c of checks){
      check(exact(c,['calc','equals']),'Invalid calculation check');const r=receipt(c.calc);
      check(r.comparison?c.equals===r.comparison:integer(c.equals)===BigInt(r.unsigned_decimal)||integer(c.equals)===BigInt(r.signed_decimal),'Calculation check failed: '+c.calc+'; use the actual result, revise the stimulus or abstain');
    }
    delete value.calculation_checks;
  }
  if(stage==='plan_test'&&value.status==='ready'){
    check(Array.isArray(value.scenarios)&&value.scenarios.length<=3,'Invalid numeric test scenarios');
    const ports=new Map((expected?.ports??[]).map(p=>[p.name,p]));
    for(const scenario of value.scenarios){
      check(Array.isArray(scenario.steps)&&scenario.steps.length<=24,'Invalid numeric test steps');
      for(const step of scenario.steps){
        check(step.expect&&typeof step.expect==='object'&&!Array.isArray(step.expect),'Missing numeric expectations');
        for(const [name,v] of Object.entries(step.expect)){
          if(exact(v,['calc'])){const r=receipt(v.calc);check(typeof r.hex==='string','Comparison result is not an output bit pattern');step.expect[name]=r.hex;continue;}
          check(exact(v,['literal','source']),'Expected typed literal/source or calc result for '+name);
          const source=context[v.source];check(/^S[1-9]\d*$/.test(v.source)&&source,'Unknown literal source');
          const n=integer(v.literal),quote=String(source.quote??source);
          const tokens=quote.match(/(?<![\w])(?:0x[\da-fA-F]+|0b[01]+|-?\d+)(?![\w])/g)??[];
          const explicit=tokens.some(s=>{try{return BigInt(s)===n;}catch{return false;}});
          const boolean=ports.get(name)?.width===1&&(n===0n||n===1n);
          const zero=n===0n&&/\bzero\b|\bclear(?:s|ed)?\b/i.test(quote);
          check(explicit||boolean||zero,'Derived multibit expectation needs calculate_batch: '+name);
          step.expect[name]=v.literal;
        }
      }
    }
  }
  if([...ledger.values()].some(r=>r.status==='ok'))check(used.size>0,'Successful calculations must be referenced in the final stage result');
  return {value,used:[...used]};
}
