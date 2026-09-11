"""Download optional public boundary data locally. No key or private data needed.
Requires Python 3 and Shapely: python -m pip install shapely
Downloaded DataV files are intentionally excluded from Git.
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
maps=root/'public/maps'
maps.mkdir(parents=True,exist_ok=True)
def download(url):
    request=urllib.request.Request(url,headers={'User-Agent':'StellarMemories-OpenSource/1.0'})
    with urllib.request.urlopen(request,timeout=40) as response:
        result=json.load(response)
    if result.get('type')!='FeatureCollection': raise ValueError('Unexpected map response')
    return result
def save(name,data):
    target=maps/name
    target.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')

world=download('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson')
save('countries.geojson',world)
provinces=download('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json')
save('china-provinces.geojson',provinces)
cities=[]
for feature in provinces['features']:
    name=feature['properties'].get('name');code=feature['properties'].get('adcode')
    if not name or not code: continue
    print('Downloading regional boundaries:',name)
    try:
        parts=download(f'https://geo.datav.aliyun.com/areas_v3/bound/{code}_full.json')['features']
    except Exception as error:
        print('Detailed boundary unavailable; keeping province fallback:',type(error).__name__)
        parts=[feature]
    for item in parts:
        item['properties']['parentProvince']=name
        cities.append(item)
save('china-cities.geojson',{'type':'FeatureCollection','features':cities})
subprocess.run([sys.executable,str(root/'scripts/build-consistent-earth-boundaries.py')],check=True)
print('Map assets ready. Observe upstream terms; this is not an approved standard-map product.')
