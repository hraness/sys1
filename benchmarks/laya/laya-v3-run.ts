/** Direct upstream evidence only. All inputs/paths are explicit; no user config/provider credentials. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {cpus,totalmem,release} from 'node:os';
const [sys1Arg,sourceArg,modelArg,pythonArg,scheduleArg,preflightArg,outputArg]=process.argv.slice(2);
if(!outputArg)throw Error('Usage: bun laya-v3-run.ts SYS1 SOURCE MODEL PYTHON SCHEDULE PREFLIGHT OUTPUT');
const [sys1,source,model,python,scheduleFile,preflightFile,output]=[sys1Arg,sourceArg,modelArg,pythonArg,scheduleArg,preflightArg,outputArg].map(x=>resolve(x!));
const {gradeDecision,summarizeDecisions}=await import(resolve(sys1,'scripts/benchmark-decisions.ts'));
const {validateResponseForRequest}=await import(resolve(sys1,'src/response.ts'));
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const schedule=JSON.parse(readFileSync(scheduleFile,'utf8')),preflight=JSON.parse(readFileSync(preflightFile,'utf8'));
if(!preflight.ok||preflight.checked!==362||preflight.schedule_sha256!==sha(scheduleFile))throw Error('exact prompt preflight failed');
if(sha(resolve(model,'model.safetensors'))!=='804ef8802b4cac7a67913b0cfb8448659e934a50284aaa867b98d7d9a6e7d1e0')throw Error('weight hash mismatch');
const artifacts=JSON.parse(readFileSync(resolve(dirname(model),'laya-artifacts.json'),'utf8'));
for(const f of artifacts)if(sha(resolve(model,f.file))!==f.sha256)throw Error('artifact changed');
const upstream=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
if(upstream!=='fc1df62828a3fedf4d8229fdac1cbd85f1cdf337'||execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim())throw Error('upstream source changed');
for(const [key,path] of [['grader_sha256','scripts/benchmark-decisions.ts'],['response_validator_sha256','src/response.ts'],['protocol_sha256','src/protocol.ts']])if(sha(resolve(sys1,path!))!==schedule.source[key!])throw Error('grading source changed');
const samples:any[]=[];
const report:any={version:1,benchmark:'decisions-v3',status:'running',started_at:new Date().toISOString(),finished_at:null,model:schedule.identity,upstream_response_model:'laya-rl-agent',qualification_scope:'Direct pinned Laya MLX upstream candidate; not Sys1 runtime integration or default qualification.',source:{...schedule.source,laya_commit:upstream,model_repository:'aac6fef/laya-typed-decisions-mlx',model_revision:'28416e78cb26a239a4eabaa2e084904ec5e6cacb',schedule_sha256:sha(scheduleFile),preflight_sha256:sha(preflightFile),harness_sha256:sha(import.meta.path),worker_sha256:sha(resolve(import.meta.dir,'laya-native-worker.py')),exporter_sha256:sha(resolve(import.meta.dir,'laya-export-schedule.ts')),requirements_sha256:sha(resolve(import.meta.dir,'laya-runtime-requirements.txt')),artifacts},environment:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch,os:release(),memory_bytes:totalmem(),bun:Bun.version},methodology:{planned_calls:362,initial_calls:1,warmups:1,unique_cases:72,cases_per_type:24,measured_repetitions:3,measured_calls:216,permutation_calls:144,concurrency:1,request_timeout_ms:60000,run_timeout_ms:480000,stop_rule:'Stop after three consecutive invalid/error responses; no retries. Stop immediately on request timeout and collect owned process.',latency_boundary:'Python Agent.predict through complete evaluated response; excludes process IPC, Sys1 normalization/validation, model load and HTTP.',throughput_boundary:'Measured loop wall time including process IPC and normalization/validation; excludes model load, report persistence and permutations.',usage:'Upstream retained unpadded sequence tokens summed across rows, including special tokens and repeated state; exact full-input equality preflight excludes truncation. Output zero: classifier returns probabilities without generated answer text.',normalization:'Preserve raw_response including original model, action fields, and noul confidence. Explicit normalized projection uses pinned checkpoint identity, drops action and noul confidence, preserves all probabilities and other SystemOne fields without modification.',grading:'Sys1 frozen decisions-v3 gradeDecision and validateResponseForRequest. Choice exact label; noul threshold0.5 and ties incorrect; score unique probability argmax and ties incorrect; score MAE separately.',quality_scope:'Exploratory direct-upstream evidence on72 authored synthetic cases across9families; frozen before execution. Not a production benchmark, calibration study or independent third-party evaluation. Repeats/permutations are not independent cases.',invariance:'Six valid identical semantic choices across every permutation; does not imply correctness.',confidence:'Laya choice/score entropy confidence; noul maximum probability. Different semantics from Sys1 Qwen readout; not calibrated by this benchmark.',preflight:{checked:preflight.checked,max_len:preflight.max_len,head_max_len:preflight.head_max_len,max_untruncated_tokens:preflight.max_untruncated_tokens,max_option_tokens:preflight.max_option_tokens,all_exact:true}},samples,summary:null,cleanup:null};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const child=spawn(python,[resolve(import.meta.dir,'laya-native-worker.py'),'--source',source,'--model',model],{env:{PATH:process.env.PATH!,TMPDIR:process.env.TMPDIR??'/tmp',LANG:'en_US.UTF-8',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1',PYTHONNOUSERSITE:'1',TOKENIZERS_PARALLELISM:'false'},stdio:['pipe','pipe','pipe']});
const queue:any[]=[];let waiting:((x:any)=>void)|null=null;let rejectWaiting:((e:Error)=>void)|null=null;let stderrBytes=0;let interrupted:string|null=null;let cleaning=false;
const interrupt=(reason:string)=>{interrupted??=reason;if(rejectWaiting){const f=rejectWaiting;rejectWaiting=null;waiting=null;f(Error(reason));}};
const sigint=()=>interrupt('interrupted SIGINT'),sigterm=()=>interrupt('interrupted SIGTERM');process.on('SIGINT',sigint);process.on('SIGTERM',sigterm);
const rl=createInterface({input:child.stdout!});rl.on('line',line=>{let value;try{value=JSON.parse(line);}catch{value={event:'malformed_worker_output'};}if(waiting){const f=waiting;waiting=null;f(value);}else queue.push(value);});
child.stderr!.on('data',chunk=>{stderrBytes+=chunk.length;});
let exited=false;const exit=new Promise<{code:number|null,signal:string|null}>(done=>{child.on('exit',(code,signal)=>{exited=true;done({code,signal});if(waiting){const f=waiting;waiting=null;f({event:'exited'});}});child.on('error',()=>{exited=true;done({code:null,signal:'spawn_error'});interrupt('worker spawn error');});});
child.stdin!.on('error',()=>{if(!cleaning)interrupt('worker stdin error');});
const next=(ms:number,cleanup=false)=>new Promise<any>((done,reject)=>{if(!cleanup&&interrupted)return reject(Error(interrupted));if(queue.length)return done(queue.shift());if(exited)return reject(Error('worker exited'));const t=setTimeout(()=>{waiting=null;rejectWaiting=null;reject(Error('request timeout'));},ms);rejectWaiting=e=>{clearTimeout(t);reject(e);};waiting=x=>{clearTimeout(t);rejectWaiting=null;done(x);};});
let measuredStart:number|null=null,measuredEnd:number|null=null;const runStart=performance.now();
const boundedNext=(ms:number)=>{const remaining=480000-(performance.now()-runStart);if(remaining<=0)return Promise.reject(Error('run timeout'));return next(Math.min(ms,remaining)).catch(e=>{if(performance.now()-runStart>=480000)throw Error('run timeout');throw e;});};
try{
 const ready=await boundedNext(120000);if(ready.event!=='ready')throw Error('worker load failed');report.environment.native=ready.environment;report.model_load_ms=ready.load_ms;
 let errors=0;
 for(const row of schedule.schedule){
  if(interrupted)throw Error(interrupted);if(performance.now()-runStart>480000)throw Error('run timeout');
  if(row.phase==='measured')measuredStart??=performance.now();
  const dispatch=performance.now();child.stdin!.write(JSON.stringify(row.request)+'\n');let value;
  try{value=await boundedNext(60000);if(value.event!=='result')throw Error('unexpected worker event');}catch(e){const {request,...meta}=row;samples.push({...meta,elapsed_ms:performance.now()-dispatch,elapsed_boundary:'Supervisor dispatch through timeout/interruption/worker failure; native completion unavailable.',http_status:null,valid:false,error:interrupted?'cancelled':(e as Error).message.includes('timeout')?'timeout':'local_error',response:null,raw_response:null,worker_error:null,grade:gradeDecision(row.expected,undefined)});if(row.phase==='measured')measuredEnd=performance.now();throw e;}
  let response=null,error=value.error?'local_error':null;
  if(!error)try{
   const raw=value.raw_response;if(raw.model!=='laya-rl-agent')throw Error('model identity');
   const answers=Object.fromEntries(Object.entries(raw.answers).map(([key,a]:[string,any])=>[key,a.type==='noul'?{type:a.type,noul:a.noul}:a.type==='choice'?{type:a.type,choice:a.choice,confidence:a.confidence,probabilities:a.probabilities}:{type:a.type,score:a.score,confidence:a.confidence,legend:a.legend,probabilities:a.probabilities}]));
   response=validateResponseForRequest(row.request,{model:schedule.identity,answers,usage:raw.usage});
   const guard=preflight.all_results[samples.length];if(raw.usage.input_tokens!==guard.tokens_expected||raw.usage.output_tokens!==0)throw Error('usage preservation');
  }catch{error='invalid_response';response=null;}
  const {request,...meta}=row;samples.push({...meta,elapsed_ms:value.elapsed_ms,http_status:null,valid:response!==null,error,response,raw_response:value.raw_response??null,worker_error:value.error??null,grade:gradeDecision(row.expected,response?.answers.decision)});
  if(row.phase==='measured')measuredEnd=performance.now();errors=response?0:errors+1;
  if(samples.length%72===0)console.log(JSON.stringify({completed:samples.length,valid:samples.filter(x=>x.valid).length}));
  if(errors>=3){report.status='stopped_after_errors';break;}
 }
 if(report.status==='running')report.status='complete';
}catch(e){report.status='failed';report.failure=(e as Error).message;}
finally{
 cleaning=true;if(!exited){if(!child.stdin!.destroyed){child.stdin!.write(JSON.stringify({command:'stop'})+'\n');child.stdin!.end();}try{const disposed=await next(5000,true);if(disposed.event==='disposed')report.cleanup=disposed;}catch{}}
 if(!exited){child.kill('SIGTERM');await Promise.race([exit,new Promise(r=>setTimeout(r,2000))]);}
 if(!exited)child.kill('SIGKILL');report.worker_exit=await exit;rl.close();process.off('SIGINT',sigint);process.off('SIGTERM',sigterm);report.worker_stderr_bytes=stderrBytes;
 report.finished_at=new Date().toISOString();report.summary=summarizeDecisions(samples,measuredStart===null||measuredEnd===null?0:measuredEnd-measuredStart,false);writeFileSync(output,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,summary:report.summary,cleanup:report.cleanup,worker_exit:report.worker_exit}));if(report.status!=='complete')process.exitCode=1;
