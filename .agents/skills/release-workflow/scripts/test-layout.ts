import ts from 'typescript';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,relative} from 'node:path';
/** Shared development-only policy. No runtime or target project depends on it. */
export class TestLayout {
 private static readonly ignored=new Set(['.git','.agents','.codegraph','node_modules','dist','vendor']);
 private static readonly tier=/^tests\/(acceptance|regression|integration|unit)\//;
 inspect(root=process.cwd()):string[]{const errors:string[]=[],specifications:string[]=[],names:Array<string|null>=[];this.directory(root,root,errors,specifications,names);this.discovery(root,specifications,names,errors);return errors;}
 check(root=process.cwd()):void{const errors=this.inspect(root);if(errors.length)throw new Error(errors.join('\n'));}
 private discovery(root:string,specifications:string[],names:Array<string|null>,errors:string[]):void{
  const path=join(root,'package.json');if(!existsSync(path))return;
  const metadata=JSON.parse(readFileSync(path,'utf8')) as {name?:string;scripts?:Record<string,string>},scripts=metadata.scripts??{};
  if(metadata.name==='@treeseed-cordis/platform-verification'){
   let commands=Object.values(scripts).join('\n');const workflows=join(root,'.github/workflows');if(existsSync(workflows))for(const name of readdirSync(workflows))if(/\.ya?ml$/.test(name))commands+='\n'+readFileSync(join(workflows,name),'utf8');
   for(const file of specifications)if(!commands.includes(file))errors.push(file+': exact assembled test must be assigned to a script or CI closure');return;
  }
  if(!Object.keys(scripts).some(this.tierScript))return;
  for(const tier of ['acceptance','regression','integration','unit']){const command=scripts['test:'+tier],complete=new RegExp('^bun\\s+test\\s+(?:\\./)?tests/'+tier+'/?(?:\\s+(?:--timeout(?:=|\\s+)\\d+|--pass-with-no-tests))*\\s*$');if(!command||!complete.test(command.trim()))errors.push('test:'+tier+': command must directly discover the complete tier directory');}
  this.partitions(root,names,errors);
 }
 private partitions(root:string,names:Array<string|null>,errors:string[]):void{
  const directory=join(root,'.github/workflows');if(!existsSync(directory))return;
  for(const file of readdirSync(directory)){
   if(!/\.ya?ml$/.test(file))continue;const source=readFileSync(join(directory,file),'utf8');if(!source.includes('--test-name-pattern'))continue;
   try{
    if(!source.includes('matrix.pattern'))throw new Error('Name-filtered CI requires an explicit pattern matrix');
    const patterns:RegExp[]=[];for(const line of source.split('\n')){const entry=line.match(/^\s+(?:-\s+)?pattern:\s*(.+?)\s*$/);if(entry){const value:unknown=JSON.parse(entry[1]!);if(typeof value!=='string')throw new Error('Invalid matrix pattern');patterns.push(new RegExp(value));}}
    if(patterns.length===0||names.length===0||names.includes(null))throw new Error('Cannot prove static CI case inventory');
    const hits=patterns.map(this.zero);for(const name of names){let matches=0;for(let index=0;index<patterns.length;index++)if(patterns[index]!.test(name!)){hits[index]=hits[index]!+1;matches++;}if(matches!==1)throw new Error('Every case must match exactly one CI partition');}
    if(hits.includes(0))throw new Error('Empty CI partition');
   }catch{errors.push('.github/workflows/'+file+': name partitions must cover every static case exactly once with valid nonempty groups');}
  }
 }
 private zero():number{return 0;}
 private tierScript(name:string):boolean{return ['test:acceptance','test:regression','test:integration','test:unit'].includes(name);}
 private directory(root:string,directory:string,errors:string[],specifications:string[],names:Array<string|null>):void{
  for(const entry of readdirSync(directory,{withFileTypes:true})){
   if(TestLayout.ignored.has(entry.name))continue;
   const path=join(directory,entry.name),file=relative(root,path).replaceAll('\\','/');
   if(entry.isSymbolicLink()){if(file.startsWith('tests/'))errors.push(file+': test symlink forbidden');continue;}
   if(entry.isDirectory()){if(existsSync(join(path,'.git')))continue;this.directory(root,path,errors,specifications,names);continue;}
   if(!/\.[cm]?[jt]sx?$/.test(file))continue;
   const spec=/\.(test|spec)\.[cm]?[jt]sx?$/.test(file),tier=TestLayout.tier.test(file);
   if(spec)specifications.push(file);
   if(spec&&!tier)errors.push(file+': specifications require tests/{acceptance,regression,integration,unit}');
   if(spec&&/(?:^|[\/-])(?:task|phase)[-_]?\d/i.test(file))errors.push(file+': permanent specifications require capability names');
   const source=ts.createSourceFile(file,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),visitor=new TestRegistrationVisitor();visitor.inspect(source);
   if(spec&&tier)names.push(...visitor.names);
   if(visitor.registrations&&(!tier||!spec))errors.push(file+': test registrations require a discoverable tier specification');
   if(spec&&!visitor.registrations)errors.push(file+': specification has no discoverable test registrations');
  }
 }
}
class TestRegistrationVisitor {
 registrations=0;
 readonly names:Array<string|null>=[];
 private readonly bindings=new Set<string>();
 private readonly namespaces=new Set<string>();
 inspect(source:ts.SourceFile):void{
  for(const node of source.statements){if(!ts.isImportDeclaration(node)||!ts.isStringLiteral(node.moduleSpecifier)||!['bun:test','node:test'].includes(node.moduleSpecifier.text))continue;const clause=node.importClause;if(!clause)continue;if(clause.name)this.bindings.add(clause.name.text);const names=clause.namedBindings;if(names&&ts.isNamespaceImport(names))this.namespaces.add(names.name.text);if(names&&ts.isNamedImports(names))for(const item of names.elements)if(['test','it','describe'].includes((item.propertyName??item.name).text))this.bindings.add(item.name.text);}
  this.visit(source);
 }
 private visit(node:ts.Node):void{if(ts.isCallExpression(node)&&this.test(node.expression)){this.registrations++;const name=node.arguments[0];this.names.push(name&&ts.isStringLiteralLike(name)?name.text:null);}ts.forEachChild(node,this.visit.bind(this));}
 private test(expression:ts.Expression):boolean{if(ts.isIdentifier(expression))return this.bindings.has(expression.text);if(ts.isPropertyAccessExpression(expression)){if(ts.isIdentifier(expression.expression)&&this.namespaces.has(expression.expression.text))return ['test','it','describe'].includes(expression.name.text);return this.test(expression.expression);}if(ts.isCallExpression(expression))return this.test(expression.expression);return false;}
}
if(import.meta.main)new TestLayout().check();
