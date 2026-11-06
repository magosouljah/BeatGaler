/**
 * Damped harmonic oscillator. Uses the exact closed-form response to a target,
 * preserving both position and velocity when retargeted mid-flight.
 *
 * Apple's WWDC23 "Animate with springs" recommends duration + bounce rather
 * than a hand-drawn cubic Bézier; these are LAB-TUNED physical analogs, not
 * purported copies of the private SwiftUI interpolation coefficients.
 *
 * Period is the UNDAMPED oscillation period (seconds), not SwiftUI's
 * perceptual-duration parameter. Damping ratio of 1 is critical (no bounce).
 */
export type Spring = {x:number; v:number; target:number};
export type SpringConfig = Readonly<{period:number; dampingRatio:number}>;
export const makeSpring = (x:number):Spring=>({x,v:0,target:x});
export const moving = (s:Spring)=>Math.abs(s.x-s.target)>.0005||Math.abs(s.v)>.012;

// Rising is deliberate and smooth, held indefinitely at its maximum.
export const PRESS_GROW:SpringConfig = {period:.34,dampingRatio:1};
// Release bounces around the *normal* size, even following a long hold.
// Source: Apple WWDC23 small-bounce examples (~0.15–0.3), adapted to WebGL.
export const PRESS_RELEASE:SpringConfig = {period:.39,dampingRatio:.47};
// Width morphing is a separate, more highly damped spring.
export const MORPH_SPRING:SpringConfig = {period:.205,dampingRatio:.79};

export function advanceSpring(s:Spring, dt:number, config:SpringConfig):void{
  if(dt<=0)return;
  const omega=2*Math.PI/config.period;
  const z=config.dampingRatio;
  const displacement=s.x-s.target;
  const velocity=s.v;
  const decay=Math.exp(-z*omega*dt);
  if(z===1){
    const B=velocity+omega*displacement;
    s.x=s.target+(displacement+B*dt)*decay;
    s.v=(B-omega*(displacement+B*dt))*decay;
  }else if(z<1){
    const oscillation=omega*Math.sqrt(1-z*z);
    const B=(velocity+z*omega*displacement)/oscillation;
    const angle=oscillation*dt;
    const cos=Math.cos(angle),sin=Math.sin(angle);
    const position=displacement*cos+B*sin;
    s.x=s.target+decay*position;
    s.v=decay*(-z*omega*position+oscillation*(-displacement*sin+B*cos));
  }else{
    // Overdamped exact response (kept for future material tuning).
    const root=Math.sqrt(z*z-1);
    const a=-omega*(z-root),b=-omega*(z+root);
    const A=(velocity-b*displacement)/(a-b);
    const B=displacement-A;
    s.x=s.target+A*Math.exp(a*dt)+B*Math.exp(b*dt);
    s.v=a*A*Math.exp(a*dt)+b*B*Math.exp(b*dt);
  }
  if(Math.abs(s.x-s.target)<.00035&&Math.abs(s.v)<.009){
    s.x=s.target;s.v=0;
  }
}
