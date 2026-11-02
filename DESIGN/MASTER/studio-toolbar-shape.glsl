// Four independent SDF lenses, compositor for Studio shaders.
// Original 44px optical preset remains untouched.
// Units of lens/wave uniforms: CSS pixels; p is gl_FragCoord (device pixels).
uniform vec4 u_lenses[4];      // center X/Y (Y bottom-up), width, height
uniform vec2 u_waves[4];       // dynamic shear in CSS pixels
uniform float u_presses[4];   // continuous, underdamped spring

float lensSDF(vec2 pixel, int i) {
  vec4 lens=u_lenses[i];
  vec2 q=pixel-lens.xy;
  float halfW=max(1.0,lens.z*0.5);
  float halfH=max(1.0,lens.w*0.5);
  float nx=clamp(q.x/halfW,-1.0,1.0);
  float ny=clamp(q.y/halfH,-1.0,1.0);
  // SDF shear applies ONLY to Search/Select morphing; press is uniform scale.
  q.y-=u_waves[i].x*sin(nx*3.14159265)*max(0.0,1.0-nx*nx);
  q.x-=u_waves[i].y*sin(ny*3.14159265)*max(0.0,1.0-ny*ny);
  float grow=1.0+clamp(u_presses[i],-0.18,1.15)*0.115;
  vec2 halfSize=vec2(halfW,halfH)*grow;
  float radius=min(halfSize.x,halfSize.y);
  vec2 d=abs(q)-halfSize+vec2(radius);
  return length(max(d,0.0))+min(max(d.x,d.y),0.0)-radius;
}
float nearestPress(vec2 point) {
  float distance=1.0e10;
  float pressure=0.0;
  for(int i=0;i<4;++i){
    float d=lensSDF(point,i);
    if(d<distance){distance=d;pressure=u_presses[i];}
  }
  return clamp(pressure,0.0,1.0);
}
float mainSDF(vec2 p1,vec2 p2,vec2 p) {
  float d=1.0e10;
  vec2 px=p/u_dpr;
  for(int i=0;i<4;++i){d=min(d,lensSDF(px,i));}
  return d/max(1.0,u_resolution.y/u_dpr);
}
