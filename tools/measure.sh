#!/bin/bash
# measure YouTube decode/render health in the kiosk for ~15s while a stream viewer is attached
cd /opt/teslatv
URL=${1:-https://www.youtube.com/watch?v=aqz-KE-bpKQ}
node tools/cdp-eval.js "location.href='$URL'" >/dev/null
sleep 10
Q='(()=>{const v=document.querySelector("video");if(!v)return null;const q=v.getVideoPlaybackQuality();return [v.currentTime,q.totalVideoFrames,q.droppedVideoFrames,v.videoHeight]})()'
A=$(node tools/cdp-eval.js "$Q"); sleep 15; B=$(node tools/cdp-eval.js "$Q")
python3 -c "
import json;a=json.loads('$A');b=json.loads('$B')
dt=b[0]-a[0];tot=b[1]-a[1];dr=b[2]-a[2]
print(f'played {dt:.1f}s, {tot} frames, dropped {dr} ({100*dr/max(tot,1):.0f}%), rendered fps {(tot-dr)/max(dt,0.1):.1f}, height {b[3]}')"
top -bn1 | sed -n '3p'
