"""Bounded official COG extraction. Requires rasterio, pyproj and numpy; never reads a national raster in full."""
import argparse, pathlib, json, struct, datetime, hashlib
import numpy as np
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from pyproj import Transformer
parser=argparse.ArgumentParser();parser.add_argument('--scratch',required=True);parser.add_argument('--output',required=True);parser.add_argument('--reuse',action='store_true');args=parser.parse_args()
p=pathlib.Path(args.scratch);p.mkdir(parents=True,exist_ok=True);out=pathlib.Path(args.output);out.mkdir(parents=True,exist_ok=True)
urls={'city':'https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/VILLE_VANCOUVER-VILLE_VANCOUVER-1m-dtm.tif','regional':'https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif'}
if not args.reuse:
 for name,url in urls.items():
  with rasterio.open(url,**({'overview_level':3} if name=='city' else {})) as s:
   if name=='city':data=s.read(1);transform=s.transform
   else:
    b=transform_bounds('EPSG:4326',s.crs,-123.31,49.17,-122.99,49.51,densify_pts=21);win=from_bounds(*b,s.transform).round_offsets().round_lengths();data=s.read(1,window=win);transform=s.window_transform(win)
   np.save(p/(name+'-terrain-original.npy'),data);(p/(name+'-terrain-raster.json')).write_text(json.dumps({'url':url,'transform':list(transform),'crs':str(s.crs),'nodata':s.nodata,'resolution':s.res,'overview':16 if name=='city' else 1,'gdal':rasterio.__gdal_version__,'rasterio':rasterio.__version__}))
manifest={'version':1,'tiles':[],'sources':[]};audits=[];now=datetime.datetime.now(datetime.timezone.utc).isoformat()
for name in urls:
 data=np.load(p/(name+'-terrain-original.npy'));meta=json.loads((p/(name+'-terrain-raster.json')).read_text());tr=Transformer.from_crs('EPSG:4326',meta['crs'],always_xy=True);a,b,c,d,e,f,*_=meta['transform'];
 def samples(lons,lats):
  xs,ys=tr.transform(lons,lats);cols=np.floor((xs-c)/a).astype(int);rows=np.floor((ys-f)/e).astype(int);inside=(cols>=0)&(rows>=0)&(cols<data.shape[1])&(rows<data.shape[0]);values=np.full(lons.shape,np.nan,dtype=np.float32);values[inside]=data[rows[inside],cols[inside]];valid=np.isfinite(values)&(values!=meta['nodata']);values[~valid]=np.nan;return values,valid,rows,cols
 source={'id':name,'url':meta['url'],'retrievedAt':now,'license':'Open Government Licence – Canada; © Natural Resources Canada'+('; Contains modified Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.' if name=='regional' else ''),'kind':'dtm','horizontalCrs':'EPSG:4326','verticalDatum':'CGVD2013','resolutionM':max(meta['resolution'])};manifest['sources'].append(source)
 audit={'sourceId':name,**meta,'sourceSliceSha256':hashlib.sha256(data.tobytes()).hexdigest(),'extraction':'Nearest source sample in WGS84 grid; no vertical transformation; source overview explicitly recorded','points':[],'profiles':[]};
 for iy in range(16):
  for ix in range(12):
   bounds={'west':round(-123.3+ix*.025,9),'east':round(-123.3+(ix+1)*.025,9),'south':round(49.18+iy*.02,9),'north':round(49.18+(iy+1)*.02,9)}
   lons,lats=np.meshgrid(np.round(np.linspace(bounds['west'],bounds['east'],65),9),np.round(np.linspace(bounds['north'],bounds['south'],65),9));values,valid,rows,cols=samples(lons,lats)
   if not valid.any():continue
   tileid=f'{name}-{ix}-{iy}';spacing=34.8
   header={'id':tileid,'bounds':bounds,'size':65,'spacingM':spacing,'kind':'dtm','verticalDatum':'CGVD2013','sourceId':name};raw=json.dumps(header,separators=(',',':')).encode();blob=b'OST1'+struct.pack('<I',len(raw))+raw+values.astype('<f4').tobytes()+valid.astype('uint8').tobytes();assert len(blob)<=32768
   (out/(tileid+'.bin')).write_bytes(blob);manifest['tiles'].append({'id':tileid,'url':f'./terrain/vancouver/{tileid}.bin','bytes':len(blob),'bounds':bounds,'spacingM':spacing})
   if len(audit['points'])<10:
    y,x=np.argwhere(valid)[len(np.argwhere(valid))//2];reference=float(data[rows[y,x],cols[y,x]]);difference=abs(float(values[y,x])-reference);assert difference<=.1;audit['points'].append({'tile':tileid,'index':int(y*65+x),'lon':float(lons[y,x]),'lat':float(lats[y,x]),'referenceM':reference,'captureM':float(values[y,x]),'errorM':difference})
   if (ix,iy) in ([(7,2),(7,3),(7,4)] if name=='city' else [(7,10),(7,12),(7,14)]) and valid[32].all():
    reference=data[rows[32],cols[32]];error=float(np.max(np.abs(values[32]-reference)));assert error<=.1;audit['profiles'].append({'tile':tileid,'row':32,'samples':65,'latitude':bounds['north']-.01,'longitudeWest':bounds['west'],'maxErrorM':error,'heightsM':values[32].tolist()})
 assert len(audit['points'])==10 and len(audit['profiles'])==3
 audits.append(audit)
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(p/'terrain-capture-audit.json').write_text(json.dumps({'capturedAt':now,'bytes':sum(t['bytes'] for t in manifest['tiles']),'sources':audits},indent=2)+'\n');print(len(manifest['tiles']),sum(t['bytes'] for t in manifest['tiles']))
