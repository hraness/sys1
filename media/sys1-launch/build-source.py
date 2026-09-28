"""Build the self-contained Slopcamera scene from checked-in font assets."""
from pathlib import Path
import base64, json
root = Path(__file__).resolve().parents[2]
film = Path(__file__).resolve().parent
source = (film / 'scene.template.html').read_text()
for token, name in [('__NEBULA_BOOK__', 'NebulaSans-Book.woff2'), ('__NEBULA_SEMIBOLD__', 'NebulaSans-Semibold.woff2')]:
    source = source.replace(token, base64.b64encode((root / 'site/vendor/nebula-sans' / name).read_bytes()).decode())
(film / 'scene.html').write_text(source)
common = {'kind':'slopcamera.html-scene','schemaVersion':1,'name':'Introducing Sys1','document':{'path':'scene.html'},'libraries':[],'seed':1,'parameters':{},'resources':[]}
for name,w,h,duration,fps,params in [('master',3840,2160,52000000,24,{}),('preview',1920,1080,8000000,1,{'reviewTimes':[3,10,17,25,33,40,45,50]})]:
    value = dict(common, canvas={'width':w,'height':h,'deviceScaleFactor':1},timing={'durationUs':duration,'fps':fps},parameters=params)
    if name=='master': value['audio']={'path':'score.wav'}
    (film / f'{name}.json').write_text(json.dumps(value,indent=2)+'\n')
