"""One owned MLX process. JSONL input/output; no generation or reasoning traces."""
import argparse,gc,importlib.metadata,json,pathlib,platform,sys,time
p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--model',required=True);a=p.parse_args()
sys.path.insert(0,str(pathlib.Path(a.source).resolve()))
import mlx.core as mx
from laya_mlx import Agent
agent=None
try:
 start=time.perf_counter();agent=Agent(pathlib.Path(a.model),device='gpu',dtype='float16',batch_size=1,compile=False,cache_prompts=False)
 print(json.dumps({'event':'ready','load_ms':(time.perf_counter()-start)*1000,'environment':{'python':platform.python_version(),'platform':platform.platform(),'arch':platform.machine(),'mlx':importlib.metadata.version('mlx'),'numpy':importlib.metadata.version('numpy'),'tokenizers':importlib.metadata.version('tokenizers'),'device':'gpu','dtype':'float16','batch_size':1,'compile':False,'cache_prompts':False,'max_len':agent.cfg['max_len'],'head_max_len':agent.cfg['head_max_len']}}),flush=True)
 for line in sys.stdin:
  req=json.loads(line)
  if req.get('command')=='stop':break
  start=time.perf_counter()
  try:
   raw=agent.predict(req['state'],req['questions']);elapsed=(time.perf_counter()-start)*1000
   print(json.dumps({'event':'result','elapsed_ms':elapsed,'raw_response':raw},allow_nan=False),flush=True)
  except Exception as e:print(json.dumps({'event':'result','elapsed_ms':(time.perf_counter()-start)*1000,'error':type(e).__name__}),flush=True)
finally:
 agent=None;gc.collect();mx.synchronize();mx.clear_cache()
 print(json.dumps({'event':'disposed','active_memory_bytes':mx.get_active_memory(),'cache_memory_bytes':mx.get_cache_memory()}),flush=True)
