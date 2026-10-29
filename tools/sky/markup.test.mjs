import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
test('viewer controls referenced at startup exist in the served HTML',async()=>{
  const root=new URL('../../',import.meta.url),html=await readFile(new URL('apps/sky/index.html',root),'utf8');
  const matches=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]), ids=new Set(matches);
  assert.equal(matches.length,ids.size,'Duplicate viewer control ID');
  for(const file of ['main.ts','gamepad-controller.ts']){
    const source=await readFile(new URL('apps/sky/src/'+file,root),'utf8');
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    function walk(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['el','get'].includes(node.expression.text)&&node.arguments.length&&ts.isStringLiteral(node.arguments[0]))assert(ids.has(node.arguments[0].text),`Missing viewer control #${node.arguments[0].text}`);ts.forEachChild(node,walk);}
    walk(ast);
  }
  for(const field of ['right','forward','turn','up','take','release','follow','pause','boost','pitch','level','brake'])assert(ids.has(`pad-${field}`),`Missing gamepad binding ${field}`);
});
