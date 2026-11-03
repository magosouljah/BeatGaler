// Multi-instance wrapper around upstream Studio's EXACT shape primitives.
// roundedRectSDF, superellipseCornerSDF, sdCircle, smin are unchanged.
// There is no jelly, shear, custom glare or stretched glass texture.
uniform vec4 u_lenses[4];    // center.xy, width, height; CSS/GL pixels (DPR=1)
uniform float u_presses[4]; // underdamped press spring: 0 at rest, 1 while held
float mainSDF(vec2 p1, vec2 p2, vec2 p) {
  float distanceToShape=1.0e10;
  float baseRadiusRatio=u_shapeRadius/max(0.001,min(u_shapeWidth,u_shapeHeight)*0.5);
  for(int i=0;i<4;++i){
    vec4 item=u_lenses[i];
    float pressedSize=1.0+clamp(u_presses[i],-0.20,1.10)*0.115;
    // Search, when expanded, presses its 44px trigger, NOT the 278px pill.
    // The right cap is a native Studio circle that exactly fits the pill at
    // rest. Its radius grows only during the press, while the pill stays put.
    // smoothstep avoids a discontinuity when the opening morph begins.
    float searchOpen=i==0?smoothstep(44.0,60.0,item.z):0.0;
    float bodyFactor=mix(pressedSize,1.0,searchOpen);
    float width=item.z*bodyFactor;
    float height=item.w*bodyFactor;
    float cornerRadius=0.5*min(width,height)*baseRadiusRatio;
    vec2 pLocal=(p-item.xy)/u_resolution.y;
    float nativeRect=roundedRectSDF(
      pLocal,vec2(0.0),
      width/u_resolution.y,height/u_resolution.y,
      cornerRadius/u_resolution.y,u_shapeRoundness
    );
    if(i==0){
      vec2 rightCapCenter=item.xy+vec2(item.z*0.5-item.w*0.5,0.0);
      float nativeCap=sdCircle((p-rightCapCenter)/u_resolution.y,
        (item.w*0.5*mix(1.0,pressedSize,searchOpen))/u_resolution.y);
      nativeRect=min(nativeRect,nativeCap);
    }
    distanceToShape=min(distanceToShape,nativeRect);
  }
  return distanceToShape;
}
