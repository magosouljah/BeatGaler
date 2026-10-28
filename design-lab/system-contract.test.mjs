import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const moduleFromTS = async source => {
  const result = ts.transpileModule(read(source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
  return import("data:text/javascript;charset=utf-8," + encodeURIComponent(result.outputText));
};
test("physics engine converges, retargets, and remains finite under interrupted motion", async () => {
  const {springStep,springSettled} = await moduleFromTS("./motion/physics.ts");
  let state = {value:0,velocity:0};
  for(let i=0;i<150;i++)state=springStep(state, i<30?80:140,1/60);
  assert.ok(Math.abs(state.value-140)<1);
  assert.ok(springSettled(state,140));
  assert.ok(Number.isFinite(state.velocity));
});
test("spatial fields respect radius and attraction/repulsion direction", async () => {
  const {vectorForce} = await moduleFromTS("./motion/physics.ts");
  const x={x:20,y:0},center={x:0,y:0};
  assert.ok(vectorForce(x,center,100,120,"repel").x>0);
  assert.ok(vectorForce(x,center,100,120,"attract").x<0);
  assert.deepEqual(vectorForce(x,center,10,120,"repel"),{x:0,y:0});
});
test("gravity collision respects floor, and inertial projection follows release direction", async () => {
  const {integrateGravity,inertialProjection} = await moduleFromTS("./motion/physics.ts");
  const next=integrateGravity({x:10,y:190},{x:100,y:200},.03,800,195,.6);
  assert.ok(next.position.y<=195);
  assert.ok(next.velocity.y<=0);
  assert.ok(inertialProjection(100,500)>100);
});
test("catalog covers the four areas with executable demos", async () => {
  const {CATALOG,AREAS} = await moduleFromTS("./system/catalog.ts");
  assert.ok(CATALOG.length>=55);
  assert.deepEqual(AREAS,["Foundations","Components","Motion & Physics","Patterns"]);
  const master=read("./system/MasterPage.tsx");
  for(const item of CATALOG)assert.ok(master.includes('case "'+item.id+'"') || (item.area==="Motion & Physics" && master.includes("MotionPlayground")),item.id);
});
test("studio TSX and motion sources have no parser errors", () => {
  for(const file of ["./system/MasterPage.tsx","./system/primitives.tsx","./motion/MotionPlayground.tsx","./motion/Orbit.tsx","./App.tsx"]) {
    const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    assert.deepEqual(source.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText," ")),[],file);
  }
});
