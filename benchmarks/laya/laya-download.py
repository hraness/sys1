"""Fetch only the public, pinned candidate; verify size plus SHA256 or Git blob ID."""
import argparse,hashlib,json,pathlib,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('destination');p.add_argument('manifest');a=p.parse_args()
repo='aac6fef/laya-typed-decisions-mlx';rev='28416e78cb26a239a4eabaa2e084904ec5e6cacb';weight_sha='804ef8802b4cac7a67913b0cfb8448659e934a50284aaa867b98d7d9a6e7d1e0'
meta=json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/revision/{rev}?blobs=true',timeout=30))
assert meta['sha']==rev and not meta['private']
files=[f for f in meta['siblings'] if f['rfilename']!='.gitattributes'];assert sum(f['size'] for f in files)<1024**3
manifest=[];start=time.monotonic();root=pathlib.Path(a.destination)
for f in files:
 name=f['rfilename'];assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
 path=root/name;path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix(path.suffix+'.part');h=hashlib.sha256();blob=hashlib.sha1(b'blob '+str(f['size']).encode()+b'\0');n=0
 if path.exists():raise FileExistsError(name)
 try:
  with urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{rev}/{name}',timeout=30) as r,tmp.open('xb') as w:
   while True:
    if time.monotonic()-start>240:raise TimeoutError('bounded download')
    chunk=r.read(4*1024*1024)
    if not chunk:break
    n+=len(chunk)
    if n>f['size']:raise ValueError('size bound')
    h.update(chunk);blob.update(chunk);w.write(chunk)
  assert n==f['size']
  if 'lfs' in f:assert h.hexdigest()==f['lfs']['sha256']==weight_sha
  else:assert blob.hexdigest()==f['blobId']
  tmp.rename(path);manifest.append({'file':name,'bytes':n,'sha256':h.hexdigest()})
 finally:
  if tmp.exists():tmp.unlink()
pathlib.Path(a.manifest).write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'files':len(manifest),'total_bytes':sum(x['bytes'] for x in manifest),'model_revision':rev}))
