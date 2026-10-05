import {defineConfig} from 'vite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
export default defineConfig({
 plugins:[{
  name:'offline-shell',apply:'build',enforce:'post',
  writeBundle(output,bundle){
   const directory=resolve(output.dir??'dist');
   const files=Object.keys(bundle).filter(name=>name!=='sw.js').sort();
   const hash=createHash('sha256');
   for(const name of files)hash.update(name).update(readFileSync(join(directory,name)));
   const assets=['./',...files.filter(name=>name!=='index.html').map(name=>'./'+name)];
   const worker=readFileSync('public/sw.js','utf8').replace('__SHELL_BUILD__',hash.digest('hex').slice(0,16)).replace('/* shell-assets */ []',JSON.stringify(assets));
   writeFileSync(join(directory,'sw.js'),worker);
  },
 }],
 server:{host:'127.0.0.1',port:5173},
 // Relative assets, so the same build runs from a subdirectory of a static host (GitHub Pages serves the project at
 // /<repo>/) and from disk: an absolute /assets/... would ask the host's root and 404. There is no history router, so
 // nothing else needs a base.
 build:{target:'es2022'},base:'./',
});
