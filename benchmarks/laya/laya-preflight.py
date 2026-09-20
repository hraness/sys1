"""Exact prompt preservation check; does not load model weights or run inference."""
import argparse,json,pathlib,sys,hashlib
p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--model',required=True);p.add_argument('--schedule',required=True);p.add_argument('--output',required=True);a=p.parse_args()
sys.path.insert(0,str(pathlib.Path(a.source).resolve()))
from laya_mlx.agent import Agent
from laya_mlx.tokenizer import Tokenizer
from laya_mlx.common import serialize_state,render_options,QTYPES
cfg=json.loads((pathlib.Path(a.model)/'rl_agent_config.json').read_text());tok=Tokenizer(pathlib.Path(a.model)/'tokenizer')
tokens=lambda text:tok(text,add_special_tokens=False)['input_ids']
agent=Agent.__new__(Agent);agent.cfg=cfg;agent.tok=tok;agent._prefix_cache=None
schedule=json.loads(pathlib.Path(a.schedule).read_text());results=[]
for n,row in enumerate(schedule['schedule']):
 req=row['request'];state=serialize_state(req['state']);items,internal=agent.prepare(req['state'],req['questions']);issues=[]
 for q,item in zip(internal,items):
  opts=render_options(q)
  if any(tok.mask_token in text for text in [state,q['ins'],*opts]):issues.append('literal mask token would be replaced')
  ids=[tok.cls_token_id]+tokens(f"{q['t']} question: {q['ins']}")+[tok.sep_token_id];markers=[]
  for opt in opts:markers.append(len(ids));ids += [tok.mask_token_id]+tokens(' '+opt)
  ids += [tok.sep_token_id]+tokens(state)+[tok.sep_token_id]
  if ids!=item['ids']:issues.append('token sequence differs from untruncated input')
  if markers!=item['markers']:issues.append('markers differ from untruncated input')
  if item['qtype']!=QTYPES[q['t']]:issues.append('type mismatch')
  results.append({'index':n,'case_id':row['case_id'],'phase':row['phase'],'tokens_expected':len(ids),'tokens_actual':len(item['ids']),'marker_count':len(markers),'max_option_tokens':max(map(lambda x:len(tokens(' '+x)),opts)),'issues':issues})
report={'ok':all(not r['issues'] for r in results),'model_loaded':False,'inference_calls':0,'schedule_sha256':hashlib.sha256(pathlib.Path(a.schedule).read_bytes()).hexdigest(),'max_len':cfg['max_len'],'head_max_len':cfg['head_max_len'],'checked':len(results),'failures':[r for r in results if r['issues']],'max_untruncated_tokens':max(r['tokens_expected'] for r in results),'max_option_tokens':max(r['max_option_tokens'] for r in results),'all_results':results}
pathlib.Path(a.output).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['all_results','failures']}));print(json.dumps({'failures':report['failures'][:6],'failure_count':len(report['failures'])}));sys.exit(0 if report['ok'] else 2)
