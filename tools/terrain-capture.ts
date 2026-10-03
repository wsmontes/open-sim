import {spawnSync} from 'node:child_process';
// Capture tooling dependency is separate from the browser bundle. Pass a Python with rasterio/pyproj/numpy.
const python=process.argv[2];if(!python)throw new Error('Usage: node --import tsx tools/terrain-capture.ts /path/to/geospatial/python [--reuse]');
const result=spawnSync(python,['tools/terrain-capture.py','--scratch','.superpowers/sdd/2026-10-02-vancouver-data-and-mobility','--output','public/terrain/vancouver',...(process.argv.includes('--reuse')?['--reuse']:[])],{stdio:'inherit'});
if(result.status!==0)throw new Error('Terrain capture failed');
