// Only the FOUR-LENS COMPOSITOR replaces upstream mainSDF().
// The original Studio lib/sdf.glsl provides roundedRectSDF(),
// superellipseCornerSDF() and all normal-distance helpers unchanged.
//
// One set of pixels -> 4 independent native Studio rounded rectangles.
// No slicing, texture stretching, shear, waves, or additional glare.
uniform vec4 u_lenses[4];    // center.xy in CSS/GL pixels (bottom-up); width/height in CSS pixels
uniform float u_presses[4]; // smooth press spring: 0 resting, 1 held
float mainSDF(vec2 p1, vec2 p2, vec2 p) {
  float distanceToShape=1.0e10;
  float baseRadiusRatio=u_shapeRadius/max(0.001,min(u_shapeWidth,u_shapeHeight)*0.5);
  for(int i=0;i<4;++i){
    vec4 item=u_lenses[i];
    // Same geometry as Studio, with a single UNIFORM size factor.
    float factor=1.0+clamp(u_presses[i],-0.20,1.10)*0.115;
    float width=item.z*factor;
    float height=item.w*factor;
    float cornerRadius=0.5*min(width,height)*baseRadiusRatio;
    // The original SDF normalizes ALL positions and dimensions by the
    // canvas height; preserve this exact coordinate space and radius.
    vec2 pLocal=(p-item.xy)/u_resolution.y;
    float studioDistance=roundedRectSDF(
      pLocal,vec2(0.0),
      width/u_resolution.y,height/u_resolution.y,
      cornerRadius/u_resolution.y,u_shapeRoundness
    );
    distanceToShape=min(distanceToShape,studioDistance);
  }
  return distanceToShape;
}
