import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [rootArg,output]=process.argv.slice(2);
if(!rootArg||!output)throw Error('Usage: bun laya-export-schedule.ts SYS1_ROOT OUTPUT');
const root=resolve(rootArg);
const {loadDecisionsFixture,decisionRequest,permutations}=await import(resolve(root,'scripts/benchmark-decisions.ts'));
const {loadFixture,requestFor}=await import(resolve(root,'scripts/benchmark-local.ts'));
const fixture=loadDecisionsFixture('decisions-v3'),warm=loadFixture();
const identity='aac6fef/laya-typed-decisions-mlx@28416e78cb26a239a4eabaa2e084904ec5e6cacb';
const schedule:any[]=[];
for(let i=0;i<2;i++){
 const req=requestFor(warm,warm.cases[i],identity);
 req.questions={decision:req.questions.action};
 schedule.push({phase:i===0?'initial':'warmup',repetition:0,case_id:`warmup-form-0${i+1}`,family:'warmup-forms',type:'choice',order:Object.keys(req.questions.decision.criteria),expected:{type:'choice',choice:i===0?'submit':'correct'},request:req});
}
for(let repetition=0;repetition<3;repetition++)for(const item of fixture.cases){const req=decisionRequest(fixture,item,identity);schedule.push({phase:'measured',repetition,case_id:item.id,family:item.family,type:item.expected.type,order:item.expected.type==='choice'?Object.keys(req.questions.decision.criteria):null,expected:item.expected,request:req});}
for(const item of fixture.cases.filter((x:any)=>x.expected.type==='choice'))for(const [repetition,order] of permutations(item.option_order).entries()){schedule.push({phase:'permutation',repetition,case_id:item.id,family:item.family,type:'choice',order,expected:item.expected,request:decisionRequest(fixture,item,identity,order)});}
if(schedule.length!==362)throw Error('schedule size');
const hash=(p:string)=>createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex');
writeFileSync(output,JSON.stringify({identity,fixture:'decisions-v3',source:{sys1_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fixture_sha256:hash('benchmarks/decisions-v3.json'),warmup_fixture_sha256:hash('benchmarks/forms-v1.json'),grader_sha256:hash('scripts/benchmark-decisions.ts'),shared_harness_sha256:hash('scripts/benchmark-local.ts'),response_validator_sha256:hash('src/response.ts'),protocol_sha256:hash('src/protocol.ts')},schedule},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({scheduled:schedule.length,fixture:'decisions-v3'}));
