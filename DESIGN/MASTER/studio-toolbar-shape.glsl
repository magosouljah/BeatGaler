// Multi-instance Studio geometry: four buttons + one active V2-size popover.
// Uses upstream roundedRectSDF/superellipseCornerSDF without optical changes.
uniform vec4 u_lenses[4]; // centers in bottom-up canvas coordinates, dimensions in px
uniform float u_presses[4]; // independent spring values
uniform vec4 u_menuLens; // active menu center.xy, width, height (real DOM bounds)
uniform float u_menuVisible;
float mainSDF(vec2 p1, vec2 p2, vec2 p) {
  float distanceToShape=1.0e10;
  float baseRadiusRatio=u_shapeRadius/max(0.001,min(u_shapeWidth,u_shapeHeight)*0.5);
  for(int i=0;i<4;++i){
    vec4 item=u_lenses[i];
    float factor=1.0+clamp(u_presses[i],-0.20,1.10)*0.115;
    float width=item.z*factor;
    float height=item.w*factor;
    // The WHOLE expanded Search pill grows about the center of its 44px
    // search trigger: anchor = rightEdge - 22px. Never attach a separate
    // expanding circle, never scale about the middle of the entire pill.
    vec2 pivotOffset=(i==0)?vec2((item.z-item.w)*0.5,0.0):vec2(0.0);
    vec2 center=item.xy-pivotOffset*(factor-1.0);
    float radius=min(width,height)*0.5*baseRadiusRatio;
    float distance=roundedRectSDF(
      (p-center)/u_resolution.y,vec2(0.0),
      width/u_resolution.y,height/u_resolution.y,
      radius/u_resolution.y,u_shapeRoundness
    );
    distanceToShape=min(distanceToShape,distance);
  }
  // Sorting and Profile popovers keep Toolbar V2 layout and size; optical
  // background is rendered by the very same Studio fragment shader as buttons.
  // Border radius 23px is the V2 popover radius, not a new optical material.
  if(u_menuVisible>0.5){
    float menuRadius=min(23.0,min(u_menuLens.z,u_menuLens.w)*0.5);
    float menuDistance=roundedRectSDF(
      (p-u_menuLens.xy)/u_resolution.y,vec2(0.0),
      u_menuLens.z/u_resolution.y,u_menuLens.w/u_resolution.y,
      menuRadius/u_resolution.y,u_shapeRoundness
    );
    distanceToShape=min(distanceToShape,menuDistance);
  }
  return distanceToShape;
}
