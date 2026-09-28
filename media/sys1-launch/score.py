"""Original, deterministic instrumental score. No samples or third-party music."""
from pathlib import Path
import math, wave
import numpy as np
SR=48000
DURATION=52
n=SR*DURATION
audio=np.zeros((n,2),dtype=np.float64)

def note(start,duration,freq,amp=.035,pan=0,timbre='bell'):
    begin=int(start*SR);length=min(int(duration*SR),n-begin)
    if length<=0:return
    t=np.arange(length)/SR
    if timbre=='pad':
        env=(1-np.exp(-t*2))*np.minimum(1,(duration-t)/1.3)
        s=(np.sin(2*math.pi*freq*t)+.18*np.sin(2*math.pi*freq*2*t))*env
    elif timbre=='pulse':
        env=np.exp(-t*13)*(1-np.exp(-t*180))
        s=np.sin(2*math.pi*(freq*t+8*(1-np.exp(-t*20))))*env
    else:
        env=np.exp(-t*2.4)*(1-np.exp(-t*110))*np.minimum(1,(duration-t)/.12)
        s=(np.sin(2*math.pi*freq*t)+.22*np.sin(2*math.pi*freq*2*t)+.08*np.sin(2*math.pi*freq*3*t))*env
    for ch,gain in enumerate([math.sqrt((1-pan)/2),math.sqrt((1+pan)/2)]):
        audio[begin:begin+length,ch]+=amp*gain*s
        # A quiet fixed-delay reflection widens the original oscillator without samples.
        delay=int((.19 if ch==0 else .27)*SR)
        count=min(length,n-begin-delay)
        if count>0:audio[begin+delay:begin+delay+count,ch]+=.18*amp*gain*s[:count]

# D major add9 / B minor / G major / A suspended, with no copied melody.
chords=[(146.832,220,277.183,329.628),(123.471,184.997,246.942,293.665),(97.999,146.832,195.998,246.942),(110,164.814,220,293.665)]
for i,start in enumerate(range(0,48,6)):
    for j,freq in enumerate(chords[i%4]):note(start,7.5,freq,.025,(-.6+j*.4),'pad')
    for j in range(8):note(start+.25+j*.625,1.8,chords[i%4][j%4]*2,.039,(-1 if j%2 else 1)*.35)
    for j in range(9):note(start+j*.625,.5,65,.018,0,'pulse')
# A final D-major chord leaves the last wordmark still and resolves before black.
for j,freq in enumerate([146.832,220,277.183,329.628]):note(46,5.8,freq,.035,-.45+j*.3,'pad')
for j,freq in enumerate([587.33,440,293.665]):note(46.25+j*.625,3,freq,.05,0)
fade=np.minimum(1,np.arange(n)/(.2*SR))*np.minimum(1,(n-np.arange(n))/(2*SR))
audio*=fade[:,None]
peak=float(np.max(np.abs(audio))); audio*=.68/max(peak,1e-9)
with wave.open(str(Path(__file__).with_name('score.wav')),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR);f.writeframes((audio*32767).astype('<i2').tobytes())
print(f'Generated {DURATION}s original stereo score; peak before normalization {peak:.4f}.')
