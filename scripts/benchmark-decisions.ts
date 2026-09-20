/** Opt-in public synthetic qualification. Fixed fixtures/models; never reads user config. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { cpus, release, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { entrySchema, questionSchema, systemOneRequestSchema, type Answer, type Question, type SystemOneRequest, type SystemOneResponse } from '../src/protocol.ts';
import { decisionPrompt } from '../src/local/decide.ts';
import { validateResponseForRequest } from '../src/response.ts';
import { forwardToBackend, type RuntimeBackend } from '../src/backends.ts';
import { LocalRunner, defaultEngineFactory } from '../src/local/runner.ts';
import { MODEL_REGISTRY, findInstalled, modelFilePath, verifyModel } from '../src/local/store.ts';
import { probeNativeRuntime } from '../src/local/engine.ts';
import { sha256, runtimeSourceDigest, loadFixture, requestFor } from './benchmark-local.ts';

const ROOT = resolve(import.meta.dir, '..');
const WARMUP_FIXTURE = join(ROOT, 'benchmarks/forms-v1.json');
export const DECISIONS_FIXTURES = {
  'decisions-v2': { version: 2, sha256: '7e1b3e988c9c27eae96efd1782cb301d998204b94a09ed915bebe0ad3d97e69b' },
  'decisions-v3': { version: 3, sha256: '992d0078faff0f781d87be0755828b48689345e4a8a68d20b25f12b7a0fa87cc' },
} as const;
export type DecisionsFixtureId = keyof typeof DECISIONS_FIXTURES;
const MODELS = ['jev-1.13.0', 'qwen3-0.6b', 'qwen3-1.7b', 'qwen3.5-4b'] as const;
const REQUEST_MS = 60_000;
const RUN_MS = 20 * 60_000;
const REPEATS = 3;
const PRICE = 0.042;
const expectedSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('choice'),choice:z.string().min(1).max(96)}).strict(),
  z.object({type:z.literal('noul'),noul:z.boolean()}).strict(),
  z.object({type:z.literal('score'),level:z.number().int().min(0).max(9)}).strict(),
]);
export const decisionsFixtureSchema = z.object({
  version:z.union([z.literal(2),z.literal(3)]),id:z.enum(['decisions-v2','decisions-v3']),description:z.string().max(2048),
  families:z.array(z.object({id:z.string().min(1).max(64),question:questionSchema}).strict()).length(9),
  cases:z.array(z.object({id:z.string().min(1).max(64),family:z.string().min(1).max(64),state:entrySchema.refine(value => (typeof value === "string" ? value : JSON.stringify(value)).length <= 6000, "state exceeds local bound"),expected:expectedSchema,rationale:z.string().min(1).max(2048),option_order:z.array(z.string()).length(3).optional()}).strict()).length(72),
}).strict().refine(f => f.version === DECISIONS_FIXTURES[f.id].version, 'fixture id/version mismatch');
export type DecisionsFixture = z.infer<typeof decisionsFixtureSchema>;
type Case = DecisionsFixture['cases'][number];

export function decisionRequest(fixture: DecisionsFixture, item: Case, model: string, order?: string[]): SystemOneRequest {
  const family=fixture.families.find(f=>f.id===item.family);
  if(!family)throw Error('unknown family');
  let question:Question=family.question;
  if(question.type==='choice'){
    const keys=order??item.option_order;
    const criteria = question.criteria;
    if(!keys || keys.length!==Object.keys(criteria).length || new Set(keys).size!==keys.length || keys.some(k=>!Object.hasOwn(criteria,k)))throw Error('invalid order');
    question={...question,criteria:Object.fromEntries(keys.map(k=>[k,criteria[k]!]))};
  }
  return systemOneRequestSchema.parse({model,state:item.state,questions:{decision:question}});
}
export function loadDecisionsFixture(id: DecisionsFixtureId = 'decisions-v2'):DecisionsFixture {
  if (!Object.hasOwn(DECISIONS_FIXTURES, id)) throw Error('unknown fixture');
  const path = join(ROOT, 'benchmarks', `${id}.json`);
  if(lstatSync(path).size>128_000)throw Error('fixture too large');
  const fixtureBytes = readFileSync(path);
  if (sha256(fixtureBytes) !== DECISIONS_FIXTURES[id].sha256) throw Error('frozen fixture hash mismatch');
  const f=decisionsFixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
  if (f.id !== id) throw Error('unexpected fixture id');
  if(new Set(f.cases.map(c=>c.id)).size!==72 || new Set(f.families.map(c=>c.id)).size!==9)throw Error('duplicate ids');
  const counts={choice:0,noul:0,score:0};
  for(const item of f.cases){
    const q=decisionRequest(f,item,'fixture').questions.decision!;
    decisionPrompt(item.state, q);
    if(q.type!==item.expected.type)throw Error('type mismatch');
    if(q.type==='choice' && item.expected.type==='choice' && !Object.hasOwn(q.criteria,item.expected.choice))throw Error('unknown expected choice');
    if(q.type==='score' && item.expected.type==='score' && item.expected.level>=q.criteria.length)throw Error('unknown expected level');
    counts[q.type]++;
  }
  if(Object.values(counts).some(n=>n!==24))throw Error('unbalanced types');
  return f;
}
export function gradeDecision(expected: Case['expected'], answer: Answer | undefined): {
  correct: boolean;
  predicted: string | number | boolean | null;
  score_absolute_error: number | null;
  confidence: number | null;
  tie: boolean;
} {
  if (!answer || expected.type !== answer.type) {
    return { correct: false, predicted: null, score_absolute_error: null, confidence: null, tie: false };
  }
  if (expected.type === 'choice' && answer.type === 'choice') {
    const values = Object.values(answer.probabilities);
    const maximum = Math.max(...values);
    return {
      correct: answer.choice === expected.choice,
      predicted: answer.choice,
      score_absolute_error: null,
      confidence: answer.confidence,
      tie: values.filter(value => value === maximum).length > 1,
    };
  }
  if (expected.type === 'noul' && answer.type === 'noul') {
    const predicted = answer.noul === 0.5 ? null : answer.noul > 0.5;
    return {
      correct: predicted === expected.noul,
      predicted,
      score_absolute_error: null,
      confidence: Math.max(answer.noul, 1 - answer.noul),
      tie: predicted === null,
    };
  }
  if (expected.type === 'score' && answer.type === 'score') {
    const entries = Object.entries(answer.probabilities);
    const maximum = Math.max(...entries.map(entry => entry[1]));
    const winners = entries.filter(entry => entry[1] === maximum);
    const predicted = winners.length === 1 ? Number(winners[0]![0]) : null;
    return {
      correct: predicted === expected.level,
      predicted,
      score_absolute_error: Math.abs(answer.score - expected.level),
      confidence: answer.confidence,
      tie: winners.length > 1,
    };
  }
  throw Error('unreachable');
}
export function permutations(keys:string[]):string[][] {
  if(keys.length!==3 || new Set(keys).size!==3)throw Error('expected three distinct keys');
  return keys.flatMap(a=>keys.filter(b=>b!==a).flatMap(b=>keys.filter(c=>c!==a&&c!==b).map(c=>[a,b,c])));
}
export interface DecisionSample {
  phase:'initial'|'warmup'|'measured'|'permutation'; repetition:number; case_id:string; family:string; type:Question['type']; order:string[]|null;
  elapsed_ms:number; http_status:number|null; valid:boolean; error:'timeout'|'cancelled'|'transport_error'|'http_error'|'invalid_response'|'local_error'|null;
  response:SystemOneResponse|null; expected:Case['expected']; grade:ReturnType<typeof gradeDecision>;
}
const percentile=(values:number[],p:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1]!:null;
export function summarizeDecisions(samples: DecisionSample[], elapsed: number, hosted: boolean) {
  const measured = samples.filter(sample => sample.phase === 'measured');
  const first = measured.filter(sample => sample.repetition === 0);
  const valid = measured.filter(sample => sample.valid);
  const byType = Object.fromEntries((['choice', 'noul', 'score'] as const).map(type => {
    const observed = first.filter(sample => sample.type === type);
    return [type, {
      planned: 24,
      observed: observed.length,
      skipped: 24 - observed.length,
      correct: observed.filter(sample => sample.valid && sample.grade.correct).length,
      valid: observed.filter(sample => sample.valid).length,
      ties: observed.filter(sample => sample.valid && sample.grade.tie).length,
    }];
  }));
  const byFamily = Object.fromEntries([...new Set(first.map(sample => sample.family))].map(family => {
    const observed = first.filter(sample => sample.family === family);
    return [family, { observed: observed.length, correct: observed.filter(sample => sample.valid && sample.grade.correct).length }];
  }));
  const usage = (observed: DecisionSample[]) => {
    const known = observed.filter(sample => sample.valid && sample.response !== null);
    return {
      known_calls: known.length,
      unknown_calls: observed.length - known.length,
      input_tokens: known.length ? known.reduce((sum, sample) => sum + sample.response!.usage.input_tokens, 0) : null,
      output_tokens: known.length ? known.reduce((sum, sample) => sum + sample.response!.usage.output_tokens, 0) : null,
    };
  };
  const permutationSamples = samples.filter(sample => sample.phase === 'permutation');
  const ids = [...new Set(permutationSamples.map(sample => sample.case_id))];
  const complete = ids.filter(id => {
    const observed = permutationSamples.filter(sample => sample.case_id === id);
    return observed.length === 6 && new Set(observed.map(sample => JSON.stringify(sample.order))).size === 6;
  });
  const stable = complete.filter(id => {
    const observed = permutationSamples.filter(sample => sample.case_id === id);
    return observed.every(sample => sample.valid) && new Set(observed.map(sample => sample.grade.predicted)).size === 1;
  });
  const byPosition = [0, 1, 2].map(position => {
    const observed = permutationSamples.filter(sample => sample.expected.type === 'choice' && sample.order?.indexOf(sample.expected.choice) === position);
    return { position, observed: observed.length, valid: observed.filter(sample => sample.valid).length, correct: observed.filter(sample => sample.valid && sample.grade.correct).length };
  });
  const scoreErrors = first.flatMap(sample => !sample.valid || sample.grade.score_absolute_error === null ? [] : [sample.grade.score_absolute_error]);
  const allUsage = usage(samples);
  const measuredUsage = usage(measured);
  return {
    attempted_calls: samples.length,
    skipped_calls: 362 - samples.length,
    first_pass_planned: 72,
    first_pass_observed: first.length,
    first_pass_skipped: 72 - first.length,
    first_pass_correct: first.filter(sample => sample.valid && sample.grade.correct).length,
    by_type: byType,
    by_family: byFamily,
    measured_attempts: measured.length,
    measured_valid: valid.length,
    measured_failures: measured.length - valid.length,
    measured_correct: valid.filter(sample => sample.grade.correct).length,
    p50_ms: percentile(measured.map(sample => sample.elapsed_ms), 0.5),
    p95_ms: percentile(measured.map(sample => sample.elapsed_ms), 0.95),
    p50_valid_ms: percentile(valid.map(sample => sample.elapsed_ms), 0.5),
    p95_valid_ms: percentile(valid.map(sample => sample.elapsed_ms), 0.95),
    measured_elapsed_ms: elapsed,
    valid_decisions_per_second: elapsed > 0 ? valid.length * 1000 / elapsed : null,
    first_score_mae: scoreErrors.length ? scoreErrors.reduce((a, b) => a + b, 0) / scoreErrors.length : null,
    score_mae_observed: scoreErrors.length,
    permutations: {
      attempts: permutationSamples.length,
      valid: permutationSamples.filter(sample => sample.valid).length,
      correct: permutationSamples.filter(sample => sample.valid && sample.grade.correct).length,
      ties: permutationSamples.filter(sample => sample.valid && sample.grade.tie).length,
      complete_case_groups: complete.length,
      invariant_case_groups: stable.length,
      by_correct_option_position: byPosition,
    },
    measured_usage: measuredUsage,
    all_usage: allUsage,
    estimated_measured_input_cost_usd: hosted && measuredUsage.input_tokens !== null ? measuredUsage.input_tokens * PRICE / 1e6 : null,
    estimated_all_input_cost_usd: hosted && allUsage.input_tokens !== null ? allUsage.input_tokens * PRICE / 1e6 : null,
  };
}
function git(...args:string[]){const r=spawnSync('git',args,{cwd:ROOT,encoding:'utf8',timeout:5000,maxBuffer:65536});if(r.status!==0)throw Error('git provenance failed');return r.stdout.trim();}
export function parseDecisionOptions(args: string[]) {
  const values = new Map<string, string>();
  let validateOnly = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--validate-only') {
      if (validateOnly) throw Error('duplicate validation option');
      validateOnly = true;
      continue;
    }
    const value = args[++i];
    if (!['--model', '--home', '--output', '--fixture'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw Error('invalid options');
    values.set(key, value);
  }
  const fixture = values.get('--fixture') ?? 'decisions-v2';
  if (!Object.hasOwn(DECISIONS_FIXTURES, fixture)) throw Error('unknown fixture');
  if (validateOnly) {
    if ([...values.keys()].some(key => key !== '--fixture')) throw Error('validation must not include execution options');
    return { validateOnly: true as const, fixture: fixture as DecisionsFixtureId };
  }
  const model = values.get('--model'), output = values.get('--output'), home = values.get('--home');
  if (!MODELS.includes(model as typeof MODELS[number]) || !output) throw Error('explicit model and output required');
  if (model !== 'jev-1.13.0' && !home) throw Error('local requires explicit store');
  if (model === 'jev-1.13.0' && home) throw Error('hosted must not read store');
  return { validateOnly: false as const, fixture: fixture as DecisionsFixtureId, model: model as typeof MODELS[number], output: resolve(output), home: home ? resolve(home) : undefined };
}
async function main(){
  const opts=parseDecisionOptions(process.argv.slice(2));const fixture=loadDecisionsFixture(opts.fixture);const warmupFixture=loadFixture();
  const fixturePath=join(ROOT,'benchmarks',`${opts.fixture}.json`);
  if(opts.validateOnly){console.log(JSON.stringify({ok:true,fixture:fixture.id,cases:72,types:3,choice_permutations:144,planned_calls_per_model:362,fixture_sha256:sha256(readFileSync(fixturePath))}));return;}
  const hosted=opts.model==='jev-1.13.0';let runner:LocalRunner|undefined;let backend:RuntimeBackend|undefined;let weight:unknown=null;let native:unknown=null;
  if(hosted){const key=process.env.TYPESAFE_API_KEY;if(!key||!key.trim()||/[\r\n]/.test(key))throw Error('missing key');backend={name:'typesafe',kind:'hosted',available:true,models:[opts.model],size_b:null,cost_rank:0,base_url:'https://api.typesafe.ai',default_model:opts.model,headers:{authorization:`Bearer ${key}`}};}
  else{
    const model=findInstalled(opts.home!,opts.model),pin=MODEL_REGISTRY.find(m=>m.id===opts.model);
    if(!model||!pin||model.sha256!==pin.sha256||model.bytes!==pin.bytes||lstatSync(modelFilePath(opts.home!,model)).size!==pin.bytes)throw Error('model pin mismatch');
    const verified=await verifyModel(opts.home!,opts.model);if(!verified.ok||verified.actual!==pin.sha256)throw Error('model verification failed');
    native=await probeNativeRuntime();if(!(native as {ok:boolean}).ok)throw Error('native unavailable');
    weight={id:model.id,sha256:model.sha256,bytes:model.bytes};runner=new LocalRunner({home:opts.home!,maxLoadedModels:1,engineFactory:defaultEngineFactory(2048,REQUEST_MS)});
  }
  const report={version:2,benchmark:fixture.id,status:'running',started_at:new Date().toISOString(),finished_at:null as string|null,model:opts.model,source:{commit:git('rev-parse','HEAD'),relevant_worktree_modified:git('status','--porcelain','--untracked-files=normal','--','src','scripts/benchmark-decisions.ts','scripts/benchmark-local.ts',`benchmarks/${opts.fixture}.json`,'benchmarks/forms-v1.json','package.json','bun.lock').length>0,harness_sha256:sha256(readFileSync(import.meta.path)),shared_harness_sha256:sha256(readFileSync(join(ROOT,'scripts/benchmark-local.ts'))),fixture_id:fixture.id,fixture_sha256:sha256(readFileSync(fixturePath)),warmup_fixture_sha256:sha256(readFileSync(WARMUP_FIXTURE)),package_sha256:sha256(readFileSync(join(ROOT,'package.json'))),runtime_source_sha256:runtimeSourceDigest(),lockfile_sha256:sha256(readFileSync(join(ROOT,'bun.lock')))},environment:{platform:process.platform,arch:process.arch,os:release(),bun:Bun.version,cpu:cpus()[0]?.model??'unknown',memory_bytes:totalmem(),native,weight,client_region:'Not independently verified',provider:hosted?'Hardware, load and caching unknown; model version provider-asserted':null},methodology:{unique_cases:72,cases_per_type:24,initial_calls:1,warmups:1,measured_repetitions:REPEATS,measured_calls:216,permutation_calls:144,planned_calls:362,concurrency:1,context_tokens:hosted?null:2048,percentile_method:'nearest rank, ceil(p*n)-1 in sorted elapsed times',request_timeout_ms:REQUEST_MS,run_timeout_ms:RUN_MS,stop_rule:'Stop after three consecutive invalid/error responses; no retries.',latency_boundary:hosted?'HTTP dispatch through complete bounded body, including network/provider; excludes validation':'LocalRunner through complete decision, including model/IPC; excludes HTTP and response validation',throughput_boundary:'Measured loop wall time including validation, excluding report persistence and permutations.',grading:'Choice exact label. Noul >0.5 is true, <0.5 false, tie incorrect. Score unique maximum-probability level; ties incorrect; weighted-score absolute error reported separately. Failures count as incorrect.',quality_scope:'72 authored synthetic cases in nine low-risk workflow families. Fixture and labels frozen before model execution. Not a production benchmark, calibration study or independent third-party evaluation. Repeats/permutations are not independent cases.',permutations:'All six orders for each of 24 choice cases. Invariance requires six valid identical semantic choices; it does not mean correct.',initial_scope:'Initial and warmup use prior forms-v1 cases, not cases from the selected qualification fixture. One initial request, not an isolated cold-machine/server measurement. Weight verification primes filesystem caches.',usage:'Actual wrapped local prompt tokens or provider-reported counters. Missing usage fails validation. Local output zero means no generated answer text; not no computation.',input_usd_per_million:hosted?PRICE:null,output_usd_per_million:hosted?0:null,price_source:hosted?'https://docs.typesafe.ai/models':null,price_checked:'2026-09-20',cost_scope:'Known reported usage estimate, not invoice. All calls include warmups/permutations; unknown failed-call billing remains unknown.'},samples:[] as DecisionSample[],summary:null as ReturnType<typeof summarizeDecisions>|null};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),RUN_MS);const interrupt=()=>controller.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  let reserved=false;let measuredStart:number|null=null,measuredEnd:number|null=null;const save=()=>{const tmp=`${opts.output}.${randomUUID()}.tmp`;try{writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,opts.output);}finally{rmSync(tmp,{force:true});}};
  try{
    mkdirSync(dirname(opts.output),{recursive:true});writeFileSync(opts.output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});reserved=true;
    type Entry={item:Case,phase:DecisionSample['phase'],repetition:number,order?:string[]};
    const schedule:Entry[]=[{item:fixture.cases[0]!,phase:'initial',repetition:0},{item:fixture.cases[1]!,phase:'warmup',repetition:0},...Array.from({length:REPEATS},(_,repetition)=>fixture.cases.map(item=>({item,phase:'measured' as const,repetition}))).flat(),...fixture.cases.filter(c=>c.expected.type==='choice').flatMap(item=>permutations(item.option_order!).map((order,repetition)=>({item,phase:'permutation' as const,repetition,order})))];
    let errors=0;
    for(const entry of schedule){
      controller.signal.throwIfAborted();const request=entry.phase==='initial'||entry.phase==='warmup' ? (()=>{const r=requestFor(warmupFixture,warmupFixture.cases[entry.phase==='initial'?0:1]!,opts.model);return {...r,questions:{decision:r.questions.action!}};})() : decisionRequest(fixture,entry.item,opts.model,entry.order);const deadline=AbortSignal.timeout(REQUEST_MS);const signal=AbortSignal.any([controller.signal,deadline]);let response:SystemOneResponse|null=null;let error:DecisionSample['error']=null;let status:number|null=null;
      if(entry.phase==='measured')measuredStart??=performance.now();const started=performance.now();let elapsed:number;
      if(hosted){
        const result=await forwardToBackend(backend!,JSON.stringify(request),undefined,REQUEST_MS,fetch,signal);elapsed=performance.now()-started;
        if(result.kind==='transport')error='transport_error';else{status=result.status;if(status<200||status>=300)error='http_error';else try{response=validateResponseForRequest(request,JSON.parse(result.body));if(response.model!==opts.model){response=null;error='invalid_response';}}catch{error='invalid_response';}}
      }else{
        const result=await runner!.decide(request,opts.model,signal);elapsed=performance.now()-started;
        if(!result.ok||!result.response)error='local_error';else try{response=validateResponseForRequest(request,result.response);if(response.model!==opts.model){response=null;error='invalid_response';}}catch{error='invalid_response';}
      }
      if(signal.aborted){response=null;error=controller.signal.aborted?'cancelled':'timeout';}
      const expected: Case['expected'] = entry.phase==='initial'?{type:'choice',choice:'submit'}:entry.phase==='warmup'?{type:'choice',choice:'correct'}:entry.item.expected;
      const sample:DecisionSample={phase:entry.phase,repetition:entry.repetition,case_id:entry.phase==='initial'?'warmup-form-01':entry.phase==='warmup'?'warmup-form-02':entry.item.id,family:entry.phase==='initial'||entry.phase==='warmup'?'warmup-forms':entry.item.family,type:request.questions.decision!.type,order:request.questions.decision!.type === "choice" ? Object.keys(request.questions.decision!.criteria) : null,elapsed_ms:elapsed,http_status:status,valid:response!==null,error,response,expected,grade:gradeDecision(expected,response?.answers.decision)};
      report.samples.push(sample);if(entry.phase==='measured')measuredEnd=performance.now();errors=sample.valid?0:errors+1;
      if(entry.phase==='initial'||entry.phase==='warmup')save();
      controller.signal.throwIfAborted();
      if(errors>=3){report.status='stopped_after_errors';break;}
    }
    if(report.status==='running')report.status='complete';
  }catch{report.status=controller.signal.aborted?'interrupted':'failed';}
  finally{
    clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);await runner?.dispose();
    report.finished_at=new Date().toISOString();report.summary=summarizeDecisions(report.samples,measuredStart===null||measuredEnd===null?0:measuredEnd-measuredStart,hosted);if(reserved)save();
  }
  console.log(JSON.stringify({status:report.status,fixture:fixture.id,model:opts.model,summary:report.summary}));if(report.status!=='complete')process.exitCode=1;
}
if(import.meta.main)try{await main();}catch{console.error('Decision benchmark failed; verify explicit options, fixture, model store or environment key. No existing result is overwritten.');process.exitCode=1;}
