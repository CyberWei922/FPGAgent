import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {runProcess} from './vivado.mjs';

const HELPER=fileURLToPath(new URL('./rtl-lint.py',import.meta.url));
export const RTL_LINT_VERSION='rtl-lint.v1';
export const RTL_LINT_RULES=Object.freeze(['-Wstatic-init-value','-Wunassigned-variable','-Wundriven-port','-Wunsigned-arith-shift','-Wmultiple-always-assigns','-Wmixed-var-assigns']);
const HINTS=Object.freeze({
  '-Wstatic-init-value':'a variable declaration initializer runs once at time 0. Declare the signal and drive it with `assign` (or an always_comb block).',
  '-Wunassigned-variable':'This variable is read but never assigned; drive it or remove the read.',
  '-Wundriven-port':'This output port has no driver; assign it according to the specification.',
  '-Wunsigned-arith-shift':'>>> on an unsigned value shifts in zeros. If sign extension is required, apply $signed(); otherwise use >>.',
  '-Wmultiple-always-assigns':'Drive each variable from exactly one process or one continuous assignment.',
  '-Wmixed-var-assigns':'Drive each variable from exactly one process or one continuous assignment.',
});

export function normalizeRtlLint(raw){
  if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw Error('agent.rtlLint must be an object');
  const value={mode:'off',python:'python3',timeoutMs:5000,maxFindings:8,...raw};
  if(!['off','slang'].includes(value.mode))throw Error('agent.rtlLint.mode must be off or slang');
  if(typeof value.python!=='string'||!value.python.trim()||/[\r\n\0]/.test(value.python))throw Error('agent.rtlLint.python must name an executable');
  for(const [name,min,max] of [['timeoutMs',500,15000],['maxFindings',1,16]]){
    if(!Number.isSafeInteger(value[name])||value[name]<min||value[name]>max)throw Error(`Invalid agent.rtlLint.${name}`);
  }
  return value;
}

export async function runRtlLint({rtl,top,workDir,options,signal,executor=runProcess}){
  const config=normalizeRtlLint(options),started=Date.now();
  const digest=typeof rtl==='string'?createHash('sha256').update(rtl).digest('hex'):null;
  const result=(status,reason,fields={})=>({status,reason,findings:[],otherCodes:{},sourceSha256:digest,durationMs:Date.now()-started,...fields});
  if(config.mode==='off')return result('off','disabled',{durationMs:0});
  let directory,output;
  try{
    signal?.throwIfAborted();
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(top))output=result('unknown','invalid_top');
    else if(typeof rtl!=='string'||Buffer.byteLength(rtl)>131072)output=result('unknown','source_boundary');
    else{
      await mkdir(workDir,{recursive:true});directory=await mkdtemp(path.join(workDir,'rtl-lint-'));
      const source=path.join(directory,'dut.sv');await writeFile(source,rtl,{flag:'wx',mode:0o600});
      const run=await executor(config.python,['-B',HELPER,'--source',source,'--top',top,'--max-findings',String(config.maxFindings)],{cwd:directory,timeoutMs:config.timeoutMs,signal});
      signal?.throwIfAborted();
      if(run.timedOut)output=result('unknown','helper_timeout');
      else if(run.cancelled||run.exitCode!==0||run.spawnError||typeof run.text!=='string'||run.text.length>65536)output=result('unknown','helper_process_error');
      else{
        let raw;try{raw=JSON.parse(run.text);}catch{}
        const rows=raw?.findings,other=raw?.other_codes;
        const valid=raw?.schema_version===1&&raw.tool==='pyslang'&&raw.version==='12.0.0'&&raw.rules_version===RTL_LINT_VERSION
          &&['pass','fail','unavailable'].includes(raw.status)&&typeof raw.reason==='string'&&raw.reason.length<=200
          &&raw.source_sha256===digest&&Array.isArray(rows)&&rows.length<=config.maxFindings
          &&rows.every(r=>RTL_LINT_RULES.includes(r.code)&&['warning','error','fatal error'].includes(r.severity)
            &&Number.isSafeInteger(r.line)&&r.line>0&&Number.isSafeInteger(r.column)&&r.column>0
            &&typeof r.message==='string'&&r.message.length<=300&&typeof r.source_line==='string'&&r.source_line.length<=200)
          &&other&&typeof other==='object'&&!Array.isArray(other)&&Object.entries(other).every(([k,v])=>/^-W[\w-]+$/.test(k)&&!RTL_LINT_RULES.includes(k)&&Number.isSafeInteger(v)&&v>=0)
          &&(raw.status==='unavailable'||(raw.status==='fail')===(rows.length>0));
        if(!valid)output=result('unknown','helper_protocol_error');
        else output=result(raw.status==='unavailable'?'unknown':raw.status,raw.reason,{findings:rows,otherCodes:other});
      }
    }
  }catch(error){
    if(signal?.aborted)signal.throwIfAborted();
    output=result('unknown','helper_unavailable');
  }finally{
    if(directory)await rm(directory,{recursive:true,force:true});
  }
  await mkdir(workDir,{recursive:true});
  await writeFile(path.join(workDir,'rtl-lint.json'),JSON.stringify(output,null,2)+'\n');
  return output;
}

export function rtlLintFeedback(result,maxChars=2400){
  if(result.status!=='fail')return null;
  return ('STATIC_LINT (pyslang 12.0.0, rtl-lint.v1): the RTL compiles, but these constructs do not behave as continuous hardware.\n'
    +'Fix ONLY these findings. Keep every other line, port and behavior unchanged.\n'
    +result.findings.map(f=>`- line ${f.line} [${f.code}] \`${f.source_line}\` : ${f.message}\n  Hint: ${HINTS[f.code]}`).join('\n')).slice(0,Math.max(0,maxChars));
}
