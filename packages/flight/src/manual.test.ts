import {test} from "node:test";
import assert from "node:assert/strict";
import {beginPilot, stepPilot, pilotInput, syncPilotInput, beginReturn, stepReturn, MANUAL_FLOOR_M, MANUAL_CEILING_M, MANUAL_PITCH_LIMIT, levelPilot, brakePilot, manualFloorM} from "./manual.ts";
import type {FlightPose, PilotInput} from "./manual.ts";
const pose: FlightPose = {position:[100,200,-300],quaternion:[0,0,0,1]};
const idle: PilotInput = {forward:0,right:0,up:0,turn:0,pitch:0,boost:false};
const near = (a:number,b:number,tolerance=1e-8) => assert(Math.abs(a-b)<tolerance,`${a} ≠ ${b}`);
test("manual handoff preserves identity/position/attitude without changing the route pose",()=>{
  const before=structuredClone(pose), state=beginPilot(42,pose);
  assert.equal(state.id,42);assert.deepEqual(state.position,pose.position);assert.deepEqual(state.quaternion,pose.quaternion);
  stepPilot(state,{...idle,forward:1},0.1);
  assert.deepEqual(pose,before);assert.deepEqual(state.position,pose.position);
  assert.throws(()=>beginPilot(-1,pose));assert.throws(()=>beginPilot(1,{...pose,quaternion:[0,0,0,0]}));
});
test("manual fixed-tick motion agrees across 30/60/120 Hz frames and uses local forward",()=>{
  const run=(hz:number)=>{let s=beginPilot(42,pose);for(let i=0;i<hz*2;i++)s=stepPilot(s,{...idle,forward:1},1/hz);return s;};
  const a=run(30),b=run(60),c=run(120);
  a.position.forEach((v,i)=>{near(v,b.position[i]);near(v,c.position[i]);});
  near(a.position[0],100);near(a.position[1],200);
  // Independent continuous ramp reference: v' = 5(12 + 5t - v), integrated for 2 s.
  const t=2, lag=(1-Math.exp(-5*t))/5;
  near(Math.abs(a.position[2]-pose.position[2]),12*(t-lag)+5*(t*t/2-t/5+lag/5),0.2);
  near(Math.hypot(...a.quaternion),1);
});
test("held controls keep gaining speed for seconds and settle at bounded normal/boost limits",()=>{
  const run=(input:PilotInput)=>{
    let s=beginPilot(42,pose);const speeds:number[]=[];
    for(let i=0;i<600;i++){
      s=stepPilot(s,input,1/60);
      assert(Math.hypot(...s.velocity)<=(input.boost?60:32)+1e-9);
      if([29,59,119,239,599].includes(i))speeds.push(Math.hypot(...s.velocity));
    }
    return {s,speeds};
  };
  for(const input of [{...idle,forward:1},{...idle,right:-1},{...idle,up:1},{...idle,forward:1,right:1,up:1},{...idle,forward:1,boost:true}]){
    const {speeds}=run(input);
    for(let i=1;i<speeds.length;i++)assert(speeds[i]>speeds[i-1],`speed must increase during a long hold: ${speeds}`);
  }
  near(run({...idle,forward:1}).speeds.at(-1)!,32,1e-8);
  near(run({...idle,forward:1,boost:true}).speeds.at(-1)!,60,1e-8);
  near(run({...idle,up:1}).speeds.at(-1)!,14,1e-8);
  near(run({...idle,up:1,boost:true}).speeds.at(-1)!,24,1e-8);
  const normal=run({...idle,forward:1}).s, before=structuredClone(normal);
  let stopped=normal;for(let i=0;i<180;i++)stopped=stepPilot(stopped,idle,1/60);
  assert(Math.hypot(...stopped.velocity)<0.0001);assert.deepEqual(normal,before);
});
test("release/reversal reset only their direction, including paused and between-tick input",()=>{
  let s=beginPilot(42,pose);
  for(let i=0;i<180;i++)s=stepPilot(s,{...idle,forward:1,up:1},1/60);
  const before=structuredClone(s);
  assert.equal(syncPilotInput(s,{...idle,forward:1,up:1}),s,"key repeats preserve acceleration");
  const released=syncPilotInput(s,{...idle,up:1});
  assert.equal(released.held.forward,0);assert.equal(released.held.up,s.held.up);
  assert.deepEqual(released.position,s.position);assert.deepEqual(released.velocity,s.velocity);
  assert.equal(stepPilot(released,idle,0),released,"pause never advances ramps or poses");
  const restarted=stepPilot(released,{...idle,forward:1},1/60);
  near(restarted.held.forward,1/60);
  const reversed=stepPilot(s,{...idle,forward:-1},1/60);
  near(reversed.held.forward,-1/60);
  assert.deepEqual(syncPilotInput(s,idle).held,{forward:0,right:0,up:0,turn:0,pitch:0});
  assert.deepEqual(s,before);
  assert.deepEqual(beginPilot(42,pose).held,{forward:0,right:0,up:0,turn:0,pitch:0});
});
test("turning accelerates to a bounded rate and mixed held inputs agree across frame rates",()=>{
  let s=beginPilot(42,pose), early=0, late=0;
  for(let i=0;i<600;i++){
    const next=stepPilot(s,{...idle,turn:1},1/60),rate=Math.abs(next.yaw-s.yaw)*60;
    assert(rate<=2.4+1e-10);if(i===29)early=rate;if(i===599)late=rate;s=next;
  }
  assert(late>early);near(late,2.4);assert.deepEqual(s.position,pose.position);
  const run=(hz:number)=>{
    let state=beginPilot(42,pose);
    for(const input of [{...idle,forward:1,turn:1},{...idle,forward:1,right:1,up:1,boost:true},{...idle,forward:-1},idle])
      for(let i=0;i<hz*2;i++)state=stepPilot(state,input,1/hz);
    return state;
  };
  const a=run(30),b=run(60),c=run(120);
  for(const key of ["position","velocity","quaternion"] as const)a[key].forEach((v,i)=>{near(v,b[key][i]);near(v,c[key][i]);});
  assert.deepEqual(a.held,b.held);assert.deepEqual(a.held,c.held);
});
test("turning, vertical control, braking, diagonal normalization and boost have observable bounds",()=>{
  const run=(input:PilotInput)=>{let s=beginPilot(42,pose);for(let i=0;i<120;i++)s=stepPilot(s,input,1/60);return s;};
  const forward=run({...idle,forward:1}),diagonal=run({...idle,forward:1,right:1}),boost=run({...idle,forward:1,boost:true});
  near(Math.hypot(diagonal.position[0]-100,diagonal.position[2]+300),Math.abs(forward.position[2]+300));
  assert(boost.position[2]<forward.position[2]-20);
  const turned=run({...idle,forward:1,turn:1});assert(turned.position[0]>110);near(Math.hypot(...turned.quaternion),1);
  const rising=run({...idle,up:1});assert(rising.position[1]>210);
  let braking=forward;for(let i=0;i<120;i++)braking=stepPilot(braking,idle,1/60);
  assert(Math.hypot(...braking.velocity)<0.001);
});
test("pause, floor/ceiling and invalid timestep failures do not cause jumps",()=>{
  const state=beginPilot(42,pose);assert.equal(stepPilot(state,{...idle,forward:1},0),state);
  for(const [height,up,expected]of [[0.38,-1,MANUAL_FLOOR_M],[1199.99,1,MANUAL_CEILING_M]]){
    let s=beginPilot(42,{...pose,position:[0,height,0]});for(let i=0;i<120;i++)s=stepPilot(s,{...idle,up},1/60);near(s.position[1],expected);near(s.velocity[1],0);
  }
  for(const dt of [-1,NaN,1])assert.throws(()=>stepPilot(state,idle,dt));
});
test("keyboard mapping supports opposing inputs and does not mutate held keys",()=>{
  const keys=new Set(["w","s","a","e","ArrowRight","Shift"]),before=[...keys];
  assert.deepEqual(pilotInput(keys),{forward:0,right:-1,up:1,turn:1,pitch:0,boost:true});assert.deepEqual([...keys],before);
  assert.equal(pilotInput(new Set([" "])).up,1);assert.equal(pilotInput(new Set(["c"])).up,-1);
});
test("return handoff is position-continuous and ends exactly on the moving route",()=>{
  const pilot=beginPilot(42,{position:[160,230,-250],quaternion:[0,1,0,0]}), returning=beginReturn(pilot,pose);
  const start=stepReturn(returning,pose,0);assert.deepEqual(start.pose.position,pilot.position);assert.deepEqual(start.pose.quaternion,pilot.quaternion);
  let state=returning,result=start;
  while(!result.done){const route={...pose,position:[100+state.elapsed,200,-300] as [number,number,number]};result=stepReturn(state,route,0.1);state=result.state;if(result.done){assert.deepEqual(result.pose.position,route.position);near(Math.abs(result.pose.quaternion[3]),1);}}
  assert.equal(state.id,42);assert.equal(returning.elapsed,0);assert.throws(()=>stepReturn(state,pose,-1));
});
test("return never follows a decaying negative height offset below the flat-ground floor",()=>{
  const pilot=beginPilot(42,{...pose,position:[100,20,-300]}), state=beginReturn(pilot,pose);
  const result=stepReturn(state,{...pose,position:[100,MANUAL_FLOOR_M,-300]},0.1);
  near(result.pose.position[1],MANUAL_FLOOR_M);assert(!result.done);
});

test("pitch keys, inherited attitude and angular limits preserve finite normalized poses",()=>{
  assert.equal(pilotInput(new Set(["i"])).pitch,1);
  assert.equal(pilotInput(new Set(["k"])).pitch,-1);
  assert.equal(pilotInput(new Set(["i","k"])).pitch,0);
  const initial:FlightPose={...pose,quaternion:[Math.sin(Math.PI/12),0,0,Math.cos(Math.PI/12)]};
  const captured=beginPilot(42,initial);near(captured.pitch,Math.PI/6);captured.quaternion.forEach((v,i)=>near(v,initial.quaternion[i],1e-12));
  for(const direction of [-1,1]){
    let state=beginPilot(42,pose);
    for(let i=0;i<600;i++)state=stepPilot(state,{...idle,pitch:direction},1/60);
    near(state.pitch,direction*MANUAL_PITCH_LIMIT);near(Math.hypot(...state.quaternion),1);
    const q=state.quaternion,forwardY=2*(q[3]*q[0]-q[1]*q[2]);
    near(forwardY,direction*Math.SQRT1_2);assert.deepEqual(state.position,pose.position);
  }
  const paused=beginPilot(42,pose);assert.equal(stepPilot(paused,{...idle,pitch:1},0),paused);
});

test("forward follows pitched heading while strafe and independent climb retain their meanings",()=>{
  const pitched:FlightPose={...pose,quaternion:[Math.sin(Math.PI/12),0,0,Math.cos(Math.PI/12)]};
  const run=(start:FlightPose,input:PilotInput)=>{let state=beginPilot(42,start);for(let i=0;i<120;i++)state=stepPilot(state,input,1/60);return state;};
  const angled=run(pitched,{...idle,forward:1}),flat=run(pose,{...idle,forward:1});
  near((angled.position[1]-pose.position[1])/(pose.position[2]-angled.position[2]),Math.tan(Math.PI/6));
  near(Math.hypot(...angled.velocity),Math.hypot(...flat.velocity));
  const sideways=run(pitched,{...idle,right:1});near(sideways.position[1],pose.position[1]);
  assert(sideways.position[0]>pose.position[0]);near(sideways.position[2],pose.position[2]);
  const rising=run(pitched,{...idle,up:1});near(rising.position[0],pose.position[0]);near(rising.position[2],pose.position[2]);assert(rising.position[1]>pose.position[1]);
  const mixed=run(pitched,{...idle,forward:1,right:1,up:1,boost:true});assert(Math.hypot(...mixed.velocity)<=60);
});

test("leveling and return retain position and attitude continuity for pitched flight",()=>{
  let state=beginPilot(42,pose);for(let i=0;i<120;i++)state=stepPilot(state,{...idle,pitch:1},1/60);
  const before=structuredClone(state),leveled=levelPilot(state);
  assert.deepEqual(leveled.position,state.position);assert.deepEqual(leveled.quaternion,state.quaternion);assert.equal(leveled.pitch,0);assert.equal(leveled.held.pitch,0);
  let settling=leveled;for(let i=0;i<120;i++)settling=stepPilot(settling,idle,1/60);
  assert(Math.abs(settling.quaternion[0])<1e-6);assert.deepEqual(state,before);
  const returning=beginReturn(state,pose),start=stepReturn(returning,pose,0);
  assert.deepEqual(start.pose.position,state.position);assert.deepEqual(start.pose.quaternion,state.quaternion);
  let current=returning,result=start;
  while(!result.done){result=stepReturn(current,pose,0.1);current=result.state;assert(result.pose.position[1]>=manualFloorM(result.pose.quaternion));}
  assert.deepEqual(result.pose.position,pose.position);assert.deepEqual(result.pose.quaternion,pose.quaternion);
});

test("pitch mixed with movement/yaw agrees at 30/60/120 Hz and reversal resets its hold timer",()=>{
  const run=(hz:number)=>{
    let state=beginPilot(42,pose);
    for(const input of [{...idle,forward:1,pitch:1,turn:0.4},{...idle,pitch:-1,right:0.5,boost:true},{...idle,up:1},idle])
      for(let i=0;i<hz;i++)state=stepPilot(state,input,1/hz);
    return state;
  };
  const a=run(30),b=run(60),c=run(120);
  for(const key of ["position","velocity","quaternion"] as const)a[key].forEach((v,i)=>{near(v,b[key][i]);near(v,c[key][i]);});
  near(a.pitch,b.pitch);near(a.pitch,c.pitch);
  let state=beginPilot(42,pose);for(let i=0;i<60;i++)state=stepPilot(state,{...idle,pitch:1},1/60);
  const released=syncPilotInput(state,idle);assert.equal(released.held.pitch,0);assert.deepEqual(released.quaternion,state.quaternion);
  near(stepPilot(state,{...idle,pitch:-1},1/60).held.pitch,-1/60);
  let ground=beginPilot(42,{...pose,position:[0,MANUAL_FLOOR_M,0]});
  for(let i=0;i<120;i++){
    ground=stepPilot(ground,{...idle,pitch:1},1/60);
    assert(ground.position[1]>=manualFloorM(ground.quaternion));assert(ground.position[1]<1.048);
  }
  const groundRoute:FlightPose={position:[0,MANUAL_FLOOR_M,0],quaternion:[0,0,0,1]};
  let returning=beginReturn(ground,groundRoute),result=stepReturn(returning,groundRoute,0);
  assert.deepEqual(result.pose.position,ground.position);
  while(!result.done){result=stepReturn(returning,groundRoute,0.1);returning=result.state;assert(result.pose.position[1]>=manualFloorM(result.pose.quaternion));}
  assert.deepEqual(result.pose.position,groundRoute.position);
});


test("takeover preserves current velocity and complete attitude while coasting until commanded",()=>{
  const velocity:[number,number,number]=[17,3,-24];
  const initial:FlightPose={...pose,quaternion:[Math.sin(Math.PI/3),0,0,Math.cos(Math.PI/3)]};
  const state=beginPilot(42,initial,velocity),before=structuredClone(state);
  assert.deepEqual(state.velocity,velocity);assert(state.coasting);assert(state.attitudeHeld);
  velocity[0]=999;assert.equal(state.velocity[0],17);
  let coast=state;for(let i=0;i<120;i++)coast=stepPilot(coast,idle,1/60);
  coast.position.forEach((v,i)=>near(v,state.position[i]+state.velocity[i]*2));
  assert.deepEqual(coast.velocity,state.velocity);assert.deepEqual(coast.quaternion,state.quaternion);
  near(coast.pitch,Math.PI/3);assert.deepEqual(state,before);
  const command=stepPilot(coast,{...idle,forward:1},1/60);
  assert(!command.coasting);assert(Math.hypot(...command.velocity)>0);
  assert.throws(()=>beginPilot(42,pose,[0,NaN,0]));
});

test("explicit brake ends inherited motion smoothly and coasting remains frame-rate independent",()=>{
  const initial=beginPilot(42,pose,[12,2,-8]);
  const braked=brakePilot(initial);
  assert(!braked.coasting);assert.deepEqual(braked.velocity,initial.velocity);assert.deepEqual(braked.position,initial.position);assert.deepEqual(braked.quaternion,initial.quaternion);
  let stopped=braked;for(let i=0;i<180;i++)stopped=stepPilot(stopped,idle,1/60);
  assert(Math.hypot(...stopped.velocity)<0.0001);assert(stopped.position[0]>pose.position[0]);
  const run=(hz:number)=>{let state=initial;for(let i=0;i<hz*2;i++)state=stepPilot(state,idle,1/hz);return state;};
  const a=run(30),b=run(60),c=run(120);
  a.position.forEach((v,i)=>{near(v,b.position[i]);near(v,c.position[i]);});
  const leveled=levelPilot(initial);assert(leveled.coasting);assert.deepEqual(leveled.velocity,initial.velocity);
});
