import type {Camera,Viewport} from '../../presentation/camera';
import {cameraReprojection} from './navigation-renderer';
export function createGpuPresenter(canvas:HTMLCanvasElement,onLost:()=>void,lowPower=false){
 let gl:WebGL2RenderingContext|null;
 try{gl=canvas.getContext('webgl2',{alpha:false,depth:false,antialias:false,failIfMajorPerformanceCaveat:true,preserveDrawingBuffer:false,powerPreference:lowPower?'low-power':'high-performance'});}catch{return;}
 if(!gl)return;
 let alive=true,freed=false,width=1,height=1;
 const shaders:WebGLShader[]=[],program=gl.createProgram(),buffer=gl.createBuffer(),texture=gl.createTexture();
 const dispose=()=>{if(freed)return;freed=true;alive=false;for(const s of shaders)gl!.deleteShader(s);shaders.length=0;if(texture)gl!.deleteTexture(texture);if(buffer)gl!.deleteBuffer(buffer);if(program)gl!.deleteProgram(program);canvas.removeEventListener('webglcontextlost',lost);};
 const lost=(event:Event)=>{event.preventDefault();alive=false;onLost();};
 if(!program||!buffer||!texture){dispose();return;}
 try{
  const compile=(type:number,source:string)=>{const shader=gl!.createShader(type);if(!shader)throw new Error('GPU shader unavailable');shaders.push(shader);gl!.shaderSource(shader,source);gl!.compileShader(shader);if(!gl!.getShaderParameter(shader,gl!.COMPILE_STATUS))throw new Error('GPU shader compilation failed');gl!.attachShader(program,shader);};
  compile(gl.VERTEX_SHADER,'#version 300 es\nin vec2 position;uniform mat3 transform;uniform vec2 size;uniform vec2 viewport;out vec2 uv;void main(){uv=position;vec3 p=transform*vec3(position*size,1.);gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);}');
  compile(gl.FRAGMENT_SHADER,'#version 300 es\nprecision mediump float;uniform sampler2D scene;in vec2 uv;out vec4 colour;void main(){colour=texture(scene,uv);}');
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('GPU program linking failed');gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.uniform1i(gl.getUniformLocation(program,'scene'),0);
  const transform=gl.getUniformLocation(program,'transform'),size=gl.getUniformLocation(program,'size'),viewportUniform=gl.getUniformLocation(program,'viewport');
  canvas.addEventListener('webglcontextlost',lost);
  return {
   available:()=>alive,
   upload(bitmap:ImageBitmap){if(!alive)return;const max=gl!.getParameter(gl!.MAX_TEXTURE_SIZE) as number;if(bitmap.width>max||bitmap.height>max)throw new Error('Scene exceeds GPU texture size');width=bitmap.width;height=bitmap.height;gl!.bindTexture(gl!.TEXTURE_2D,texture);gl!.texImage2D(gl!.TEXTURE_2D,0,gl!.RGBA,gl!.RGBA,gl!.UNSIGNED_BYTE,bitmap);},
   draw(source:Camera,target:Camera,viewport:Viewport){if(!alive)return;const [a,b,c,d,e,f]=cameraReprojection(source,target);if(canvas.width!==viewport.width)canvas.width=viewport.width;if(canvas.height!==viewport.height)canvas.height=viewport.height;gl!.viewport(0,0,viewport.width,viewport.height);gl!.clearColor(.714,.741,.588,1);gl!.clear(gl!.COLOR_BUFFER_BIT);gl!.useProgram(program);gl!.uniform2f(size,width,height);gl!.uniform2f(viewportUniform,viewport.width,viewport.height);gl!.uniformMatrix3fv(transform,false,new Float32Array([a,b,0,c,d,0,e,f,1]));gl!.drawArrays(gl!.TRIANGLE_STRIP,0,4);},
   bytes:()=>width*height*4,
   dispose,
  };
 }catch{dispose();return;}
}
