"""Unify globe boundary layers without editing the source datasets.

Requires Shapely (pip install --target .test-env/map-geometry shapely).
DataV is the application's Chinese boundary source, NOT an official map approval.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.test-env/map-geometry'))
from shapely import make_valid
from shapely.geometry import shape, mapping, Point
from shapely.ops import unary_union

MAPS = ROOT / 'public/maps'
def read(name):
    return json.loads((MAPS / name).read_text(encoding='utf-8'))

def feature(geometry, properties):
    return {'type': 'Feature', 'properties': properties, 'geometry': mapping(geometry)}

def polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry]
    if hasattr(geometry, 'geoms'):
        return [p for part in geometry.geoms for p in polygons(part)]
    return []

provinces = read('china-provinces.geojson')['features']
# Keep the source's offshore features as well as all 34 named regions.
china = unary_union([make_valid(shape(f['geometry'])) for f in provinces])
assert china.is_valid
for point in [(93.62, 27.1), (95, 28), (79.5, 35.2), (121, 24), (114.17, 22.3)]:
    assert china.covers(Point(*point)), f'Chinese source coverage missing: {point}'

world = []
changed = []
for f in read('countries.geojson')['features']:
    if f['properties'].get('ADM0_A3') in ('CHN', 'TWN'):
        continue
    original = make_valid(shape(f['geometry']))
    clipped = unary_union(polygons(original.difference(china)))
    assert clipped.is_valid
    assert clipped.intersection(china).area < 1e-8
    if original.intersection(china).area > 1e-8:
        changed.append(f['properties']['ADMIN'])
    if not clipped.is_empty:
        world.append(feature(clipped, {'name': f['properties']['ADMIN'], 'source': 'Natural Earth / DataV edge reconciliation'}))
world.append(feature(china, {'name': '中国', 'source': 'DataV.GeoAtlas'}))
output = {'type': 'FeatureCollection', 'features': world}
(MAPS / 'earth-boundaries.geojson').write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'Unified globe: {len(world)} features; adjusted neighboring geometry: {", ".join(changed)}')
