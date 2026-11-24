// Explicit dual deployment. Does not alter the historical start.mjs declaration.
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { modelCommand } from './start.mjs';

const digest=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
const save=async(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
export function deploymentCommands(c) {
  const phase1=c.schema==='rtl2llm.planner-deployment.v1';
  if(!['rtl2llm.dual-deployment.v1','rtl2llm.planner-deployment.v1'].includes(c.schema)||!path.isAbsolute(c.state_dir)||!path.isAbsolute(c.backend?.path)||!/^[a-f0-9]{64}$/.test(c.backend.sha256??''))throw new Error('Explicit deployment identity required');
  const ports=new Set();
  return ['main','aux'].map(role=>{
    const m=c[role];
    if(!m||!path.isAbsolute(m.path)||!m.revision||!/^[a-f0-9]{64}$/.test(m.sha256??'')||!Number.isSafeInteger(m.bytes)||m.bytes<1||!Number.isInteger(m.port)||m.port<1024||m.port>65535||ports.has(m.port))throw new Error('Invalid model identity/port: '+role);
    ports.add(m.port);
    if(phase1){
      const parallel=m.parallel??1;
      if(![1,2].includes(parallel)||(role==='aux'&&parallel!==1))throw new Error('Planner parallel must be 1 or main 2');
      if(!(role==='main'?(parallel===1?m.context===24576:[32768,40960].includes(m.context)):m.context===20480)||m.quantization!==(role==='main'?'Q6_K':'UD-Q4_K_M')||m.thinking!==true||m.reasoning_budget!==2048)throw new Error('Planner deployment requires 24K/Q6 author and 20K/Q4 planner, shared thinking budget 2048');
    }else{
      if(m.parallel!==undefined&&m.parallel!==1)throw new Error('Parallel author requires planner deployment');
      if(role==='main'&&(m.context!==32768||m.quantization!=='UD-Q4_K_M'||m.thinking!==true||m.reasoning_budget!==2048))throw new Error('Main deployment must preserve frozen Q4/32K/thinking settings');
      if(role==='aux'&&(m.quantization!=='Q6_K'||!Number.isInteger(m.context)||m.context<4096||m.context>32768||typeof m.thinking!=='boolean'))throw new Error('Invalid auxiliary deployment');
    }
    const declaration={serving:m.thinking?{reasoning_budget_tokens:m.reasoning_budget}:{}};
    const command=modelCommand({MODEL_NAME:m.id,MODEL_PATH:m.path,LLAMA_SERVER_BIN:c.backend.path,MAX_MODEL_LEN:String(m.context),LLAMA_THREADS:'16'},
      {chat_template_kwargs:{enable_thinking:m.thinking}},declaration);
    command.args[command.args.indexOf('--port')+1]=String(m.port);
    if(m.parallel===2){command.args[command.args.indexOf('--parallel')+1]='2';command.args.push('--kv-unified');}
    if(m.draft!==undefined){
      const d=m.draft;
      if(!phase1||role!=='aux'||!d||Object.keys(d).some(k=>!['path','sha256','n_max'].includes(k))||!path.isAbsolute(d.path??'')||!/^[a-f0-9]{64}$/.test(d.sha256??'')||d.n_max!==7)throw new Error('Invalid planner draft identity');
      command.args.push('--spec-type','draft-dspark','-md',d.path,'-ngld','999','--spec-draft-n-max',String(d.n_max));
    }
    return {role,...command};
  });
}
async function proc(pid) {
  try{const t=await readFile(`/proc/${pid}/stat`,'utf8'),f=t.slice(t.lastIndexOf(')')+2).split(' ');return {state:f[0],start:f[19],cmd:await readFile(`/proc/${pid}/cmdline`)};}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e;}
}
export async function modelProcessOwned(row,readProc=proc,pause=()=>new Promise(ok=>setTimeout(ok,20))) {
  // Linux may clear cmdline before publishing the zombie/dead stat state.
  // Wait briefly for that transition without ever signalling an unidentified PID.
  for(let attempt=0;attempt<6;attempt++) {
    const p=await readProc(row.pid);if(!p||['Z','X','x'].includes(p.state))return false;
    if(p.start===row.start&&p.cmd.toString().split('\0')[0]===row.bin)return true;
    if(p.start===row.start&&p.cmd.length===0&&attempt<5){await pause();continue;}
    throw new Error('PID identity changed; refusing signal');
  }
}
const owned=modelProcessOwned;
async function freePort(port) {
  const server=net.createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});await new Promise(ok=>server.close(ok));
}
export async function startModels(c,env=process.env,roles=['main','aux']) {
  if(process.platform!=='linux')throw new Error('Linux deployment required');
  const allCommands=deploymentCommands(c),commands=allCommands.filter(x=>roles.includes(x.role));await mkdir(c.state_dir,{recursive:true,mode:0o700});
  const lock=await open(path.join(c.state_dir,'startup.lock'),'wx',0o600),rows=[],started=[];
  try {
    const stateFile=path.join(c.state_dir,'models.json');
    try{const old=JSON.parse(await readFile(stateFile,'utf8'));for(const r of old)if(await owned(r)){
      const expected=allCommands.find(x=>x.role===r.role);
      if(!expected||JSON.stringify(expected.args)!==JSON.stringify(r.args)||expected.bin!==r.bin)throw new Error('Existing owned deployment differs');
      if(roles.includes(r.role))throw new Error('Owned model service already running: '+r.role);
      rows.push(r);
    }}catch(e){if(e.code!=='ENOENT')throw e;}
    if(await digest(c.backend.path)!==c.backend.sha256)throw new Error('Inference backend hash mismatch');
    for(const {role} of commands){const m=c[role];if((await stat(m.path)).size!==m.bytes||await digest(m.path)!==m.sha256)throw new Error('Weight size/hash mismatch: '+role);if(m.draft&&await digest(m.draft.path)!==m.draft.sha256)throw new Error('Draft hash mismatch');await freePort(m.port);}
    await save(path.join(c.state_dir,'launch-'+Date.now()+'.json'),{deployment:c,commands,started_at:new Date().toISOString()});
    for(const command of commands) {
      const file=await open(path.join(c.state_dir,command.role+'.log'),'a',0o600);
      let child;try{child=spawn(command.bin,command.args,{cwd:c.state_dir,env:{...env,CUDA_VISIBLE_DEVICES:'0',HIP_VISIBLE_DEVICES:'0',ROCR_VISIBLE_DEVICES:'0',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},detached:true,stdio:['ignore',file.fd,file.fd]});await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});child.unref();}finally{await file.close();}
      const p=await proc(child.pid);if(!p)throw new Error('Model exited at launch');
      const row={...command,pid:child.pid,start:p.start,port:c[command.role].port};rows.push(row);started.push(row);await save(stateFile,rows);
      const end=Date.now()+180000;let ready=false;
      while(Date.now()<end){if(!await owned(rows.at(-1)))throw new Error('Model exited; inspect '+command.role+'.log');try{const r=await fetch(`http://127.0.0.1:${c[command.role].port}/health`,{signal:AbortSignal.timeout(1500)});if(r.ok){ready=true;break;}}catch{}await new Promise(ok=>setTimeout(ok,500));}
      if(!ready)throw new Error('Model readiness timeout: '+command.role);
    }
    return rows;
  } catch(e){for(const row of started)if(await owned(row))process.kill(row.pid,'SIGTERM');throw e;}
  finally{await lock.close();await unlink(path.join(c.state_dir,'startup.lock'));}
}
export async function stopModels(c) {
  const rows=JSON.parse(await readFile(path.join(c.state_dir,'models.json'),'utf8'));
  for(const row of rows)if(await owned(row))process.kill(row.pid,'SIGTERM');
  const end=Date.now()+10000;
  for(const row of rows){while(await owned(row)&&Date.now()<end)await new Promise(ok=>setTimeout(ok,100));if(await owned(row))process.kill(row.pid,'SIGKILL');}
  const reapedBy=Date.now()+3000;
  for(const row of rows){while(await owned(row)&&Date.now()<reapedBy)await new Promise(ok=>setTimeout(ok,100));if(await owned(row))throw new Error('Owned model process cleanup unconfirmed');}
  await save(path.join(c.state_dir,'stopped.json'),{time:new Date().toISOString(),cleanup_confirmed:true,rows});return rows.map(r=>({role:r.role,pid:r.pid}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [action,file]=process.argv.slice(2);if(!['start','start-main','start-aux','stop','status'].includes(action)||!file)throw new Error('Usage: dual-models.mjs start|start-main|start-aux|stop|status <deployment.json>');
  const c=JSON.parse(await readFile(file,'utf8'));deploymentCommands(c);
  const value=action.startsWith('start')?await startModels(c,process.env,action==='start'?['main','aux']:[action.slice(6)]):action==='stop'?await stopModels(c):await Promise.all(JSON.parse(await readFile(path.join(c.state_dir,'models.json'),'utf8')).map(async r=>({role:r.role,pid:r.pid,running:await owned(r)})));
  console.log(JSON.stringify(value,null,2));
}
