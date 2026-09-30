import {expect,test} from 'vitest';
import {execFileSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {builtinModules} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// TypeScript 7 is the native compiler: `typescript` resolves to lib/version.cjs and no parser is exposed to
// JavaScript (unstable/ast/factory.createSourceFile builds nodes rather than parsing, and unstable/ast/scanner never
// advances), so the graph is extracted with a small tokenizer and every specifier is then resolved for real: by path
// for relative imports, by Node's own resolution for packages. The platform ban is also proved by the compiler itself
// in the last test. Known limit: a regular expression literal is tokenized as code, so `/Date/` would be reported.
type Token={kind:'code'|'string'|'comment';text:string;line:number};
function tokenize(text:string):Token[]{
 const tokens:Token[]=[];let i=0,line=1;
 const push=(kind:Token['kind'],start:number,end:number)=>{tokens.push({kind,text:text.slice(start,end),line});line+=count(text.slice(start,end),'\n');};
 while(i<text.length){
  const start=i,char=text[i];
  if(char==='/'&&text[i+1]==='/'){i=text.indexOf('\n',i);if(i<0)i=text.length;push('comment',start,i);continue;}
  if(char==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);i=end<0?text.length:end+2;push('comment',start,i);continue;}
  if(char==="'"||char==='"'||char==='`'){i++;while(i<text.length&&text[i]!==char){if(text[i]==='\\')i++;i++;}i++;push('string',start,i);continue;}
  if(/[A-Za-z_$]/.test(char)){while(i<text.length&&/[A-Za-z0-9_$]/.test(text[i]))i++;}
  else if(/[0-9]/.test(char)){while(i<text.length&&/[0-9A-Za-z_.]/.test(text[i]))i++;}
  else i++;
  push('code',start,i);
 }
 return tokens;
}
const count=(text:string,char:string)=>text.split(char).length-1;
type Dependency={file:string;specifier:string;line:number};
const quoted=(token:Token)=>token.text.slice(1,-1);
function dependencies(file:string):Dependency[]{
 const tokens=tokenize(readFileSync(file,'utf8')).filter(token=>token.kind!=='comment');
 const found:Dependency[]=[];
 for(let i=0;i<tokens.length;i++){
  if(tokens[i].kind!=='string')continue;
  const previous=tokens[i-1]?.text, before=tokens[i-2]?.text;
  const isSpecifier=previous==='from'||previous==='import'||(previous==='('&&before==='import');
  if(isSpecifier)found.push({file,specifier:quoted(tokens[i]),line:tokens[i].line});
 }
 return found;
}
function filesIn(dir:string):string[]{
 return readdirSync(dir).sort().flatMap(name=>{const path=join(dir,name);return statSync(path).isDirectory()?filesIn(path):path.endsWith('.ts')?[path]:[];});
}
const layerOf=(file:string)=>(['core','world','session','adapters','presentation','profiles','browser'] as const).find(name=>file.startsWith(join(root,'src',name)))??'other';
// The portable world contract may only lean on the core; everything else may lean on it, never the other way.
const ALLOWED:Record<string,readonly string[]>={core:['core'],world:['core','world'],session:['core','world','session'],adapters:['core','world','session','adapters','profiles'],presentation:['core','world','session','presentation','profiles'],profiles:['core','world','profiles'],browser:['core','world','session','adapters','presentation','profiles','browser'],other:['core','world','session','adapters','presentation','profiles','browser']};
// Only the pure layers are package-free by construction; an adapter is exactly the place where a platform API or an
// SDK is allowed to live (the map decoders, and later the storage, crypto, network and social adapters).
const ALLOWED_PACKAGES:Record<string,readonly string[]|null>={core:[],world:[],session:[],profiles:[],presentation:[],browser:[],adapters:null,other:null};
function resolved(from:string,specifier:string):string|'package'{
 if(!specifier.startsWith('.'))return 'package';
 const base=resolve(dirname(from),specifier);
 const candidates=[`${base}.ts`,join(base,'index.ts')];
 return candidates.find(existsSync)??base;
}
test('every relative import resolves to a file and the modules never look the wrong way',()=>{
 const files=filesIn(join(root,'src'));
 const layers=new Set(files.map(layerOf));
 // A directory that is not a declared layer must fail here, which is the point of this check: the layers above are
 // an allowlist, and adding one is a deliberate act. Declared layers that are still empty are not an error (a
 // layer may be registered before its first file, e.g. `profiles` while the explorer profile is being built).
 expect([...layers].filter(name => !(name in ALLOWED))).toEqual([]);
 expect(['core','world','session']).toEqual(expect.arrayContaining([...layers].filter(name => ['core','world','session'].includes(name))));
 const problems:string[]=[];
 for(const file of files){
  const owner=layerOf(file);
  for(const {specifier,line} of dependencies(file)){
   const target=resolved(file,specifier);
   if(target==='package'){
    const allowed=ALLOWED_PACKAGES[owner];
    if(allowed!==null&&!allowed.includes(specifier))problems.push(`${file}:${line} imports package ${specifier}`);
    continue;
   }
   if(!existsSync(target)){problems.push(`${file}:${line} imports ${specifier}, which does not resolve to a file`);continue;}
   if(!ALLOWED[owner].includes(layerOf(target)))problems.push(`${file}:${line} imports the ${layerOf(target)} layer (${specifier})`);
  }
 }
 expect(problems).toEqual([]);
});
test('only an adapter may reach for a platform, a Nostr client or a UI framework',()=>{
 const platform=new Set([...builtinModules,'electron','tauri','nostr']);
 const problems=filesIn(join(root,'src')).flatMap(file=>{
  if(layerOf(file)==='adapters')return [];
  return dependencies(file).flatMap(({specifier,line})=>{
   const name=specifier.replace(/^node:/,'').split('/')[0]!;
   return platform.has(name)||/^nostr|^matrix|^@matrix/i.test(name)?[`${file}:${line} imports ${specifier}`]:[];
  });
 });
 expect(problems).toEqual([]);
});
test('the core never reads the clock or the global random generator',()=>{
 const problems:string[]=[];
 for(const file of filesIn(join(root,'src/core'))){
  const tokens=tokenize(readFileSync(file,'utf8')).filter(token=>token.kind==='code');
  for(let i=0;i<tokens.length;i++){
   const name=tokens[i].text,qualified=tokens[i-1]?.text!=='.'&&tokens[i-1]?.text!=='?:';
   if(name==='Date'&&qualified)problems.push(`${file}:${tokens[i].line} uses Date`);
   if(name==='random'&&tokens[i-1]?.text==='.'&&tokens[i-2]?.text==='Math')problems.push(`${file}:${tokens[i].line} uses Math.random`);
  }
 }
 expect(problems).toEqual([]);
});
test('the core and the world contract compile with no DOM and no Node types at all',()=>{
 const tsc=join(root,'node_modules','typescript','bin','tsc');
 const run=(project:string)=>()=>execFileSync(process.execPath,[tsc,'-p',project],{cwd:root,encoding:'utf8',stdio:'pipe'});
 expect(run('tsconfig.core.json')).not.toThrow();
 expect(run('tsconfig.world.json')).not.toThrow();
 expect(filesIn(join(root,'src/core')).length).toBeGreaterThan(5);
 expect(filesIn(join(root,'src/world')).length).toBeGreaterThanOrEqual(3);
});
