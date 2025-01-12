import { SourceCache, ShaderLib } from './utilities/shaders.js';
import { DisplayConsole } from './utilities/Console.js';
import { EventTarget, bufferToImage, canvasToBlob, loadImage, clamp } from './utilities/util.js';
import { SequentialUboBuilder } from './utilities/gpu_utils/ubuffers.js';
import { closestHit_GlslMirror } from './utilities/gpu_utils/shader_mirrors.js';
import { SceneGraphNode, CameraNode } from './utilities/SceneGraphNode.js';
import { FrameGraph } from './utilities/RenderGraph.js';
import { decodeHydra } from './loading/hydra.js';
import { MeshBlas } from './utilities/primitives.js';
import { BinaryBVH } from './accel/BVHNode.js';
import { HdrLoader, computeHdrSamplingDistributions } from './loading/HdrLoader.js';
import { OrbitalCamera } from './utilities/OrbitCamera.js';
import { Matrix4 } from './math/Matrix4.js';
import { Vector3 } from './math/Vector3.js';
import { Quaternion } from './math/Quaternion.js';
import { ActiveNodeEditor } from './utilities/ActiveNodeEditor.js';
import { Ray } from './math/Ray.js';
import {
  CAMERA_VERTICES,
  CAMERA_INDICES,
  FOCAL_DIST_PLANE_VERTICES,
  FOCAL_DIST_OUTLINE_VERTICES,
  EDITOR_COLOR_SCHEME,
  TYPE_TO_SIZE,
} from './utilities/constants.js';

window.Quaternion = Quaternion;
window.Vector3 = Vector3;

// preview config
export const PREVIEW_DEFAULT_WIDTH = 512; // use aspect ratio to find height
const SSAA_LEVEL = Math.pow(2, 2);

// misc.
const SIZEOF_RGBA32F_TEXEL = 4 * Float32Array.BYTES_PER_ELEMENT;

export class HydraModel extends EventTarget {
  static [ActiveNodeEditor.editableProperties] = [
    {prop: 'debugIndex', displayName: 'Debug magic number', mutable: true, triggerUpdate: true},
    {prop: 'emissiveFactor', displayName: 'Emissive factor', mutable: true, triggerUpdate: true},
    {prop: 'editorCamera.camera.fov', displayName: 'Camera FOV', mutable: true, triggerUpdate: true, deg: true},
    {prop: 'editorCamera.camera.near', displayName: 'Camera near', mutable: true, triggerUpdate: true},
    {prop: 'editorCamera.focalDistance', mutable: true, triggerUpdate: true, displayName: 'Focal distance', triggerUpdate: true},
    {prop: 'editorCamera.lensRadius', mutable: true, triggerUpdate: true, displayName: 'Lens radius', triggerUpdate: true},
    {prop: 'preferEditorCam', displayName: 'Prefer editor camera', mutable: true, triggerUpdate: true},
  ];

  static REQUIRED_WEBGL_EXTENSIONS = [
    'WEBGL_debug_renderer_info',
    'OES_texture_float_linear',
    'EXT_color_buffer_float',
    'EXT_float_blend',
  ];
  
  // shader loading/compilation info
  static SHADER_PATH = './assets/shaders/';
  static SHADER_SRC = [
    'main.glsl',
    'sampleTex.glsl',
    'fullscreenTri.glsl',
    'random.glsl',
    'sample.glsl',
    'intersections.glsl',
    'phong.glsl',
    'copy.glsl',
    'closestHit.glsl',
    'anyHit.glsl',
    'gBufferVert.glsl',
    'gBufferFrag.glsl',
    'SSAA.glsl',
    'outline.glsl',
    'composite.glsl',
    'icons.glsl',
    'cameraFrag.glsl',
    'gradient.glsl',
    'tex.glsl',
    'axesVert.glsl',
    'axesFrag.glsl',
  ];
  
  static PROGRAM_INFO = {
    'bg': ['fullscreenTri.glsl', 'gradient.glsl'],
    'g-buffer': ['gBufferVert.glsl', 'gBufferFrag.glsl'],
    'outline': ['fullscreenTri.glsl', 'outline.glsl'],
    'composite': ['fullscreenTri.glsl', 'composite.glsl'],
    'ssaa': ['fullscreenTri.glsl', 'SSAA.glsl'],
    'camera': ['icons.glsl', 'cameraFrag.glsl'],
    'axes': ['axesVert.glsl', 'axesFrag.glsl'],
    'raytrace-main': ['fullscreenTri.glsl', 'main.glsl'],
    'raytrace-tonemap': ['fullscreenTri.glsl', 'sampleTex.glsl'],
    'copy': ['fullscreenTri.glsl', 'copy.glsl'],
  };
  
  // shader compilation
  sourceCache = new SourceCache({
    'glsl': this.constructor.SHADER_PATH,
    'wgsl': this.constructor.SHADER_PATH + 'gpu/',
  });
  shaderLib = new ShaderLib();
  
  // misc.
  sampleCount = 0;
  #sampleOffset = 0;
  #startTime = 0;
  
  orbitalControls = new OrbitalCamera(.01, .95, 50, .002);
  editorCamera = new CameraNode({camera: {
    fov: Math.PI / 4,
    near: 0.01,
  }});

  focusedNode = null;
  focusedNodes = null;
  focusedAxis = -1;

  debugIndex = 0;
  emissiveFactor = 1;
  preferEditorCam = false;
  cachedTlas = null;

  get fps() {
    return 1000 * (this.sampleCount - this.#sampleOffset) / (performance.now() - this.#startTime);
  } 

  pick(u, v) {
    const ray = Ray.generate(u, v, this.editorCamera.projectionMatrix, this.editorCamera.viewMatrix);

    if (this._cachedBvhBuffer) {
      const [, mesh] = closestHit_GlslMirror(
        this._cachedBvhBuffer.pixels,
        this._cachedBvhBuffer.blasDescriptors,
        this._faceData,
        this._vertexData,
        ray,
      );
      
      return mesh;
    }
  }

  grab(u0, v0, u1, v1, axis, rotate = false) {
    const startRay = Ray.generate(u0, v0, this.editorCamera.projectionMatrix, this.editorCamera.viewMatrix);
    const endRay = Ray.generate(u1, v1, this.editorCamera.projectionMatrix, this.editorCamera.viewMatrix);
    const point = this.focusedNode.worldMatrix.columnVector(3);
    const normal = this.focusedNode.worldMatrix.columnVector(axis).normalize();

    const [, t0] = startRay.intersectsPlane(point, normal); 
    const [, t1] = endRay.intersectsPlane(point, normal);

    const x1 = endRay.at(t1);
    const x0 = startRay.at(t0);

    x1.subVectors(x1, point);
    x0.subVectors(x0, point);

    if (!rotate) {
      const diff = x1.clone();
      diff.subVectors(diff, x0);

      if (this.focusedNode.parent) {
        /*
        suppose we want pos_w + diff:

        pos_w' = pos_w + diff = W * pos_l + diff
                              = W * (pos_l + W^-1 * diff)
        
        thus we add W^-1 * diff, where W is the world matrix but we don't
        want to apply local transformations, nor translations or scales
        (hence parent quaternion inverse)
        */
        diff.applyQuaternion(this.focusedNode.parent.worldQuat.inverse, 0);
      }

      this.focusedNode.position.addVectors(this.focusedNode.position, diff);
    } else {
      const theta = x1.angleBetween(x0);
      const direction = x0.crossVectors(x0, x1).dot(normal);
      const quat = new Quaternion().setFromAxisAngle(Vector3.axis(axis), Math.sign(direction) * theta);
      
      this.focusedNode.quat.multiply(quat);
    }
  }

  constructor(gl) {
    super();
    
    this.gl = gl;
    
    // render pipeline
    this.fg = new FrameGraph(gl);
    
    // load WebGL extensions
    const [debugExt] = this.constructor.REQUIRED_WEBGL_EXTENSIONS.map(name => {
      const extension = this.gl.getExtension(name);
      if (extension !== null) {
        return extension;
      } else {
        throw new Error(`WebGL extension '${name}' is not supported`);
      }
    });
    
    // log renderer info
    DisplayConsole.getDefault().log(
`Vendor: ${this.gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL)}
Renderer: ${this.gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL)}`
    );
    /*DisplayConsole.getDefault().log(
`Optimizing WebGL2/WebGPU Performance (Windows):
 * WebGL2: Select OpenGL driver for ANGLE backend
 * WebGPU: Select Default/D3D driver for ANGLE backend`,
    'info');*/
  }

  triggerDebug() {
    this.debugIndex++;
  }

  updateSettings() {
    this.editorCamera.updateProjectionMatrix(this.dimensions[0] / this.dimensions[1]);
  }

  updateUniforms(prog) {
    prog.uniforms.set('u_emissiveFactor', this.emissiveFactor);
    prog.uniforms.set('u_lensRadius', 0);
    prog.uniforms.set('u_focalDistance', 1);

    let camera;
    const cameras = this.sceneGraph.nodes.filter(node => node.type === 'CameraNode');

    if (this.preferEditorCam || cameras.length === 0) {
      camera = this.editorCamera;
    } else {
      camera = cameras[this.debugIndex % cameras.length];
    }

    prog.uniforms.set('u_lensRadius', camera.lensRadius);
    prog.uniforms.set('u_focalDistance', camera.focalDistance);
    
    prog.uniforms.set('u_projectionMatrixInverse', camera.projectionMatrix.inverse);
    prog.uniforms.set('u_cameraMatrix', camera.worldMatrix);
  }
  
  async reloadShaders(logShaders = false) {
    // fetch/reload shader fragments
    await Promise.all(
      this.constructor.SHADER_SRC.map(file => this.sourceCache.registerModule(file)),
    );
    
    // dispose of preexisting shaders
    for (const pipeline of this.shaderLib.shaders.values()) {
      pipeline.dispose(this.gl);
    }
    
    // compile new shaders
    for (const name in this.constructor.PROGRAM_INFO) {
      const [vertexSource, fragmentSource] = this
        .constructor
        .PROGRAM_INFO[name]
        .map(file => this.sourceCache.fetchModule(file));
      
      this.shaderLib.addShader(name, this.gl, {
        vertexSource,
        fragmentSource,
      }, logShaders);
    }
  }
  
  // load necessary state from asset file and reload shaders
  async updateState({
    logShaders,
    file,
    environmentMap,
    renderConfig: {
      width,
      height,
      numTilesX,
      numTilesY,
      emissiveFactor,
      lensRadius,
    },
  }) {
    this.dimensions = [width, height];
    
    // update shaders
    await this.reloadShaders(logShaders);
    
    // initialize GPU resources
    const gl = this.gl;
    this.fg.clear();
    
    // parse asset
    const asset = this.asset = await decodeHydra(file);
    const [json, binary] = asset;
    
    // initialize scenegraph
    this.sceneGraph = SceneGraphNode.deserialize(json.tree);
    this.dispatchEvent('hydra_update_scene_graph', this.sceneGraph);
    
    // "calibrate" cameras with aspect ratio
    this
      .sceneGraph
      .nodes
      .filter(node => node.type === 'CameraNode')
      .forEach(camera => camera.updateProjectionMatrix(width / height));
    
    const cameras = this.sceneGraph.nodes.filter(node => node.type === 'CameraNode');
    [this.currentCamera] = cameras;

    this.orbitalControls.resetOrigin();

    this.editorCamera.updateProjectionMatrix(width / height);
    this.orbitalControls.linkCameraNode(this.editorCamera);
    
    // initialize uniform buffers
    this.#initializeUniformBuffers(asset);
    
    // iniitalize raytracing resources
    this.fg.createTexture('accumulation-buffer', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    
    this.fg.createTexture('present-buffer', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    
    // load image
    const atlas = await bufferToImage(
      asset.getBufferView(asset.json.atlas.bufferView),
    );
    
    this.fg.createTexture('texture-atlas', FrameGraph.Tex.TEXTURE_2D_ARRAY, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.SRGB8_ALPHA8,
        json.atlas.size.width,
        json.atlas.size.height,
        json.atlas.size.depth,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        atlas,
      );
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    
    this.fg.createTexture('bvh', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    
    const devImage = await loadImage('./assets/images/hydra_dev_placeholder.png');

    this.fg.createTexture('dev-image', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.SRGB8_ALPHA8,
        devImage.width,
        devImage.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        devImage,
      );
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    });

    await this.uploadTlas();
    await this.#initializeEnvMap(environmentMap);
    
    // data textures
    this.fg.createVertexArray('scene-geometry', async (gl, vertexArray) => {
      const dataTexBuffer = asset.getBufferView(asset.json.dataTextures.bufferView);
  
      this.fg.createBuffer('unpack-buffer', (gl, buf) => {
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buf);
        gl.bufferData(gl.PIXEL_UNPACK_BUFFER, dataTexBuffer, gl.STATIC_DRAW);
      });
  
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('scene-vertices'));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fg.createBuffer('scene-indices'));
      gl.bufferData(gl.ARRAY_BUFFER, dataTexBuffer, gl.STATIC_DRAW);
      
      const gBufferShader = this.shaderLib.getShader('g-buffer');
      json.dataTextures.descriptors.forEach(({name, internalFormat, width, height, format, type, offset, numComponents}, i) => {
        this.fg.createTexture(name, FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          
          /**
           * fix for apparent alignment issue (when offset % 8 != 0)
           * maybe abstain from using PIXEL_UNPACK_BUFFER
           */
          if (name !== 'TEXCOORD') {
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, offset);
          } else {
            const uvData = new Float32Array(
              dataTexBuffer.slice(offset, offset + numComponents * width * height * TYPE_TO_SIZE[type])
            );

            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, uvData);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, this.fg.getBuffer('unpack-buffer'));
          }
        });

        switch (name) {
          case 'FACE':
            const data = dataTexBuffer.slice(offset)
            this._faceData = new Int32Array(data);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
            break;
          case 'MATERIAL':
            var location = gBufferShader.attribs.get('a_MATERIAL');
            gl.vertexAttribIPointer(location, numComponents, type, 0, offset);
            gl.enableVertexAttribArray(location);
            break;
          case 'VERTEX':
            this._vertexData = new Float32Array(
              dataTexBuffer.slice(offset, offset + numComponents * width * height * TYPE_TO_SIZE[type])
            );
          case 'NORMAL':
          case 'TEXCOORD':
            var location = gBufferShader.attribs.get(`a_${name}`);
            gl.vertexAttribPointer(location, numComponents, type, false, 0, offset);
            gl.enableVertexAttribArray(location);
            break;
        }
      });
      
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    });
    
    // initialize raster resources
    const aspectRatio = width / height;
    const previewWidth = PREVIEW_DEFAULT_WIDTH * SSAA_LEVEL;
    const previewHeight = Math.floor(PREVIEW_DEFAULT_WIDTH / aspectRatio) * SSAA_LEVEL;
    
    this.fg.createTexture('g-color0', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, previewWidth, previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    });
    
    this.fg.createTexture('g-normals', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, previewWidth, previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    });
    
    this.fg.createTexture('g-depth', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, previewWidth, previewHeight, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    });
    
    // Outline pass attachments
    this.fg.createTexture('outlines', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, previewWidth, previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    });
    
    this.fg.createTexture('outlines-fixed', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, previewWidth, previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    });
    
    // Composite surface
    this.fg.createTexture('composite', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, previewWidth, previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    });
    
    // SSAA target
    this.fg.createTexture('ssaa-target', FrameGraph.Tex.TEXTURE_2D, (gl, texture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PREVIEW_DEFAULT_WIDTH, PREVIEW_DEFAULT_WIDTH / aspectRatio, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    });
    
    this.fg.createVertexArray('camera-frustum', (gl, vertexArray) => {
      const cameraShader = this.shaderLib.getShader('camera');
      
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('camera-frustum-vertices'));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fg.createBuffer('camera-frustum-indices'));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(CAMERA_VERTICES), gl.STATIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(CAMERA_INDICES), gl.STATIC_DRAW);
      gl.vertexAttribPointer(cameraShader.attribs.get('a_position'), 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(cameraShader.attribs.get('a_position'));
    });
    
    this.fg.createVertexArray('camera-up-vector', (gl, vertexArray) => {
      const cameraShader = this.shaderLib.getShader('camera');
      
      const scale = 0.3;
      const offset = 0.15;
      const ndcMax = 1;
      const aspectRatio = width / height;
      
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('camera-up-vector-vertices'));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -scale, ndcMax + offset, ndcMax,
        +scale, ndcMax + offset, ndcMax,
        0, ndcMax + offset + (aspectRatio * scale * Math.sqrt(3)) / 2, ndcMax,
      ]), gl.STATIC_DRAW);
      
      gl.vertexAttribPointer(cameraShader.attribs.get('a_position'), 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(cameraShader.attribs.get('a_position'));
    });

    this.fg.createVertexArray('axes', (gl, vertexArray) => {
      const axesShader = this.shaderLib.getShader('axes');

      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('axes-vertices-color'));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 0, 0,
        0, 1, 0,
        0, 0, 0,
        0, 0, 1,

        1, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
      ]), gl.STATIC_DRAW);

      gl.vertexAttribPointer(axesShader.attribs.get('a_position'), 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribPointer(axesShader.attribs.get('a_color'), 3, gl.FLOAT, false, 0, 18 * Float32Array.BYTES_PER_ELEMENT);

      gl.enableVertexAttribArray(axesShader.attribs.get('a_position'));
      gl.enableVertexAttribArray(axesShader.attribs.get('a_color'));
    });
    
    this.fg.createVertexArray('camera-focal-plane', (gl, vertexArray) => {
      const cameraShader = this.shaderLib.getShader('camera');
      
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('camera-focal-plane-vertices'));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(FOCAL_DIST_PLANE_VERTICES), gl.STATIC_DRAW);
      gl.vertexAttribPointer(cameraShader.attribs.get('a_position'), 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(cameraShader.attribs.get('a_position'));
    });
    
    this.fg.createVertexArray('camera-focal-plane-outline', (gl, vertexArray) => {
      const cameraShader = this.shaderLib.getShader('camera');
      
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fg.createBuffer('camera-focal-plane-outline-vertices'));
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(FOCAL_DIST_OUTLINE_VERTICES), gl.STATIC_DRAW);
      gl.vertexAttribPointer(cameraShader.attribs.get('a_position'), 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(cameraShader.attribs.get('a_position'));
    });
    
    /**
     * Initialize G-buffer pass
     */
    this.fg.addFrame('preview-mode');
    
    const gBufferPass = this.fg.addPass('preview-mode', 'g-buffer-pass', (gl, vertexArrays, textureBindings) => {
      /**
       * Draw background
       */
      gl.viewport(0, 0, previewWidth, previewHeight);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      // set pipeline
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.disable(gl.DEPTH_TEST);
      
      this.shaderLib.getShader('bg').bind(gl);
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      
      /**
       * Populate G-buffer
       */
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.enable(gl.DEPTH_TEST);
      
      // draw scene geometry from interleaved buffer
      const gBufferShader = this.shaderLib.getShader('g-buffer');
      gl.bindVertexArray(vertexArrays.get('scene-geometry'));
      
      gBufferShader.uniforms.set('u_textureAtlas', textureBindings['texture-atlas']);
      gBufferShader.uniforms.set('u_atlasResolution', [json.atlas.size.width, json.atlas.size.height]);
    

      this.sceneGraph.nodes.filter(node => node.type === 'MeshNode').forEach(node => {
        const descriptor = json.meshDescriptors.find(d => d.meshIndex === node.mesh.index);
        const color = (this.focusedNode === node || this.focusedNodes?.includes(node)) ? EDITOR_COLOR_SCHEME.selection : EDITOR_COLOR_SCHEME.white;
        
        
        gBufferShader.uniforms.set('u_debugIndex', this.debugIndex);
        gBufferShader.uniforms.set('u_projectionMatrix', this.editorCamera.projectionMatrix);
        gBufferShader.uniforms.set('u_viewMatrix', this.editorCamera.viewMatrix);
        gBufferShader.uniforms.set('u_worldMatrix', node.worldMatrix);
        gBufferShader.uniforms.set('u_visColor', color);
        gBufferShader.bind(gl);
        
        gl.drawElements(gl.TRIANGLES, descriptor.count, gl.UNSIGNED_INT, descriptor.start * Uint32Array.BYTES_PER_ELEMENT);
      });
    });
    
    // specify pass outputs
    gBufferPass.addTextureInput('texture-atlas');
    gBufferPass.addColorOutput('g-color0');
    gBufferPass.addColorOutput('g-normals');
    gBufferPass.setDepthOutput('g-depth');
    
    /**
     * Initialize outline pass
     */
    const outlineShader = this.shaderLib.getShader('outline');
     
    // upload static uniforms
    outlineShader.uniforms.set('u_resolution', [previewWidth, previewHeight]);
    outlineShader.uniforms.set('u_zNear', .01);
    
    // create pass
    const outlinePass = this.fg.addPass('preview-mode', 'outline-pass', (gl, vertexArrays, textureBindings) => {
      // clear buffers
      gl.viewport(0, 0, previewWidth, previewHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      
      // dispatch outline kernel
      outlineShader.uniforms.set('u_normals', textureBindings['g-normals']);
      outlineShader.uniforms.set('u_depth', textureBindings['g-depth']);
      outlineShader.bind(gl);
      
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    
    // specify pass I/O
    outlinePass.addAttachmentInput('g-normals', gBufferPass);
    outlinePass.addAttachmentInput('g-depth', gBufferPass);
    outlinePass.addColorOutput('outlines');
    outlinePass.setDepthStencilOutput('outline-mask');
    
    /**
     * Fix outlines
     */
    const fixPass = this.fg.addPass('preview-mode', 'fix-pass', (gl, vertexArrays, textureBindings) => {
      const cameraShader = this.shaderLib.getShader('camera');
      
      const drawNth = n => {
        const a = new Array(2).fill(gl.NONE);
        a[n] = gl.COLOR_ATTACHMENT0 + n;
        return a;
      }

      // set pipeline state
      gl.viewport(0, 0, previewWidth, previewHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // use OpenGL backend?
      const [minWidth, maxWidth] = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
      gl.lineWidth(Math.max(minWidth, 5));

      if (this.focusedNode) {
        const axesShader = this.shaderLib.getShader('axes');
        axesShader.uniforms.set('u_projectionMatrix', this.editorCamera.projectionMatrix);
        axesShader.uniforms.set('u_viewMatrix', this.editorCamera.viewMatrix);
        axesShader.uniforms.set('u_worldMatrix', this.focusedNode.worldMatrix);
        axesShader.uniforms.set('u_axis', this.focusedAxis);
        axesShader.bind(gl);

        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.bindVertexArray(vertexArrays.get('axes'));
        gl.drawArrays(gl.LINES, 0, 6);
      }
      
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.depthFunc(gl.LEQUAL);

      const blendParams = [
        [0, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
        [1, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA],
      ];
      
      
      
      const cameras = this
        .sceneGraph
        .nodes
        .filter(node => node.type === 'CameraNode')
        // bubble selected camera to end of array
        .sort(c => c === this.focusedNode ? +1 : -1);
      
      cameras.forEach(node => {
        const focused = this.focusedNode === node || this.focusedNodes?.includes(node);
        
        const color = focused ? EDITOR_COLOR_SCHEME.selection : EDITOR_COLOR_SCHEME.camera;
        const proj = node.getProjectionMatrix(width / height);
        
        cameraShader.uniforms.set('u_projectionMatrix', this.editorCamera.projectionMatrix);
        cameraShader.uniforms.set('u_viewMatrix', this.editorCamera.viewMatrix);
        cameraShader.uniforms.set('u_worldMatrix', node.worldMatrix);
        cameraShader.uniforms.set('u_inverseProjectionMatrix', proj.inverse);
        cameraShader.uniforms.set('u_visColor', color);
        cameraShader.uniforms.set('u_alpha', focused ? 1 : 1);
        cameraShader.uniforms.set('u_ndcZ', proj._getNdcDepth(-node.focalDistance));
        cameraShader.uniforms.set('u_overrideZ', false);
        cameraShader.bind(gl);
        
        for (const [buffer, sFactor, dFactor] of blendParams) {
          gl.drawBuffers(drawNth(buffer));
          gl.blendFunc(sFactor, dFactor);
          
          gl.bindVertexArray(vertexArrays.get('camera-frustum'));
          gl.drawElements(gl.LINES, CAMERA_INDICES.length, gl.UNSIGNED_SHORT, 0);
          gl.bindVertexArray(vertexArrays.get('camera-up-vector'));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        
        cameraShader.uniforms.set('u_visColor', EDITOR_COLOR_SCHEME.focalPlane);
        if (this.focusedNode === node && node.displayFocalPlane) {
          for (const [buffer, sFactor, dFactor] of blendParams) {
            gl.drawBuffers(drawNth(buffer));
            gl.blendFunc(sFactor, dFactor);
            
            cameraShader.uniforms.set('u_overrideZ', true);
            cameraShader.uniforms.set('u_alpha', 1);
            cameraShader.bind(gl);
            
            gl.bindVertexArray(vertexArrays.get('camera-focal-plane-outline'));
            gl.drawArrays(gl.LINES, 0, FOCAL_DIST_OUTLINE_VERTICES.length / 3);
            gl.bindVertexArray(vertexArrays.get('camera-up-vector'));
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            
            cameraShader.uniforms.set('u_alpha', 0.3);
            cameraShader.bind(gl);
            
            gl.bindVertexArray(vertexArrays.get('camera-focal-plane'));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
        }
      });
      
      gl.disable(gl.BLEND);
    });
    
    fixPass.addTextureDependency('outlines', outlinePass);
    fixPass.addColorOutput('g-color0');
    fixPass.addColorOutput('outlines');
    fixPass.setDepthOutput('g-depth');
    
    /**
     * Initialize composite pass
     */
    // create pass
    const compositePass = this.fg.addPass('preview-mode', 'composite-pass', (gl, vertexArrays, textureBindings) => {
      const compositeShader = this.shaderLib.getShader('composite');
      
      // set pipeline state
      gl.viewport(0, 0, previewWidth, previewHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      
      // dispatch draw call
      compositeShader.uniforms.set('u_albedo', textureBindings['g-color0']);
      compositeShader.uniforms.set('u_normals', textureBindings['g-normals']);
      compositeShader.uniforms.set('u_outlineMask', textureBindings['outlines']);
      compositeShader.bind(gl);
      
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    
    // specify pass I/O
    compositePass.addAttachmentInput('g-color0', fixPass);
    compositePass.addAttachmentInput('g-normals', gBufferPass);
    compositePass.addAttachmentInput('outlines', outlinePass);
    compositePass.addColorOutput('composite');
    
    /**
     * Initialize SSAA pass
     */
    const ssaaShader = this.shaderLib.getShader('ssaa');
     
    // upload static uniforms
    ssaaShader.uniforms.set('u_resolution', [previewWidth, previewHeight]);
    ssaaShader.uniforms.set('u_ssaaLevel', SSAA_LEVEL);
    
    // create pass
    const ssaaPass = this.fg.addPass('preview-mode', 'ssaa-pass', (gl, vertexArrays, textureBindings) => {
      // set pipeline state
      gl.viewport(0, 0, PREVIEW_DEFAULT_WIDTH, PREVIEW_DEFAULT_WIDTH / aspectRatio);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      
      ssaaShader.uniforms.set('u_screenTexture', textureBindings['composite']);
      ssaaShader.bind(gl);
      
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    
    // specify pass inputs
    ssaaPass.addAttachmentInput('composite', compositePass);
    ssaaPass.addColorOutput('ssaa-target');
    
    // build frame graph
    this.fg.build('preview-mode');
    
    /**
     * Initialize RTX frame graph
     */
    this.fg.addFrame('rtx');
    
    const main = this.shaderLib.getShader('raytrace-main');
    
    main.uniforms.set('u_resolution', [width, height]);
    main.uniforms.set('u_atlasResolution', [json.atlas.size.width, json.atlas.size.height]);
    main.uniforms.set('u_emissiveFactor', this.emissiveFactor);
    main.uniforms.set('u_lensRadius', 0);
    main.uniforms.set('u_focalDistance', 1);

    // this.updateUniforms();
    
    const rtxPass = this.fg.addPass('rtx', 'rtx-pass', (gl, vertexArrays, textureBindings) => {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      
      main.uniforms.set('u_currentSample', this.sampleCount);
      main.uniforms.set('u_devImage', textureBindings['dev-image']);
      main.uniforms.set('u_textureAtlas', textureBindings['texture-atlas']);
      main.uniforms.set('u_envMap', textureBindings['hdr']);
      main.uniforms.set('u_marginalDistribution', textureBindings['hdr-marg-dist']);
      main.uniforms.set('u_conditionalDistribution', textureBindings['hdr-cond-dist']);
      main.uniforms.set('u_debugIndex', this.debugIndex);
      
      this.updateUniforms(main);

      json.dataTextures.descriptors.forEach(({name, width, height}) => {
        main.uniforms.set(`u_${name}.sampler`, textureBindings[name]);
        main.uniforms.set(`u_${name}.size`, [width, height]);
      });
      
      main.uniforms.set('u_accelStruct.sampler', textureBindings['bvh']);
      
      main.bind(gl);
      gl.bindVertexArray(null);
      
      for (let x = 0, tileWidth = Math.floor(width / numTilesX); x < width; x += tileWidth) {
        for (let y = 0, tileHeight = Math.floor(height / numTilesY); y < height; y += tileHeight) {
          gl.viewport(x, y, tileWidth, tileHeight);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }

      this.sampleCount++;
    });
    
    rtxPass.addTextureInput('dev-image');
    rtxPass.addTextureInput('texture-atlas');
    rtxPass.addTextureInput('bvh');
    rtxPass.addTextureInput('hdr');
    rtxPass.addTextureInput('hdr-marg-dist');
    rtxPass.addTextureInput('hdr-cond-dist');
    json.dataTextures.descriptors.forEach(({name}) => rtxPass.addTextureInput(name));
    rtxPass.addColorOutput('accumulation-buffer');
    
    const tonemapPass = this.fg.addPass('rtx', 'tonemap-pass', (gl, vertexArrays, textureBindings) => {
      const tonemapShader = this.shaderLib.getShader('raytrace-tonemap');
      
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, width, height);
      
      tonemapShader.uniforms.set('u_sampleCountInv', 1 / this.sampleCount);
      tonemapShader.uniforms.set('u_outputImage', textureBindings['accumulation-buffer']);
      tonemapShader.bind(gl);
      
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    
    tonemapPass.addAttachmentInput('accumulation-buffer', rtxPass);
    tonemapPass.addColorOutput('present-buffer');
    
    this.fg.build('rtx');
    
    // notify observers; application state is encapsulated in frames via closures
    this.dispatchEvent('hydra_rebuild_pipeline', {
      shaderLib: this.shaderLib,
      frameGraph: this.fg,
    });
  }
  
  async #initializeEnvMap(file) {
    const useEnvMap = file !== null && file !== undefined;
    const main = this.shaderLib.getShader('raytrace-main');
    
    let data = null;
    let width = 1;
    let height = 1;
    
    let marginalDistribution = null;
    let conditionalDistribution = null;
    
    if (useEnvMap) {
      const loader = new HdrLoader();
      const params = await loader.parse(file);
      
      data = params.data;
      width = params.width;
      height = params.height;
      
      const dist = computeHdrSamplingDistributions(width, height, data);
      
      marginalDistribution = dist.marginalDistribution;
      conditionalDistribution = dist.conditionalDistribution;
    }
    
    main.uniforms.set('u_useEnvMap', useEnvMap);
    main.uniforms.set('u_hdrRes', [width, height]);
    
    this.fg.createTexture('hdr', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, data);
    });
    
    this.fg.createTexture('hdr-marg-dist', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, height, 1 /* tex height */, 0, gl.RG, gl.FLOAT, marginalDistribution);
    });
    
    this.fg.createTexture('hdr-cond-dist', FrameGraph.Tex.TEXTURE_2D, (gl, tex) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, conditionalDistribution);
    });
  }
  
  #initializeUniformBuffers() {
    let currentBlockBinding = 0;
    
    for (const {name, bufferView, size} of [
      // static buffers
      ...this.asset.json.uniformBuffers,
      
      // dynamic buffers
      {name: 'BlasDescriptors', size: 16 * 9 * 32},
    ]) {
      this.fg.createBuffer(name, (gl, buf) => {
        gl.bindBuffer(gl.UNIFORM_BUFFER, buf);

        if (bufferView) {
          const data = this.asset.getBufferView(bufferView);
          gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
        } else {
          gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
        }
        
        gl.bindBufferBase(gl.UNIFORM_BUFFER, currentBlockBinding, buf);
        for (const shader of this.shaderLib.shaders.values()) {
          if (shader.buffers.has(name)) {
            gl.uniformBlockBinding(shader.program, shader.getBufferIndex(name), currentBlockBinding);
          }
        }
      });
      
      // increment the block binding
      currentBlockBinding += 1;
    }
  }
  
  async uploadTlas(trace = true) {
    const displayConsole = DisplayConsole.getDefault();
    const gl = this.gl;
    const [json, binary] = this.asset;
    
    // collect meshes
    const meshes = this.sceneGraph.nodes
      .filter(node => node.type === 'MeshNode')
      .filter(({mesh}) => mesh.renderable)
      // BlasDescriptors must be sorted according to index
      .sort(({mesh: a}, {mesh: b}) => a.index - b.index);
    
    // build top-level hierarchy
    const primitives = meshes.map((mesh, i) => new MeshBlas(mesh, i));

    if (trace) displayConsole.time();
    const tlas = new BinaryBVH(primitives, BinaryBVH.SplitMethod.SAH);
    if (trace) displayConsole.timeEnd('TLAS Build', 'cpu');

    this.cachedTlas = tlas;

    // array of BVH data (tlas always in 0th position)
    const texData = [tlas._serialize()];
    const builder = new SequentialUboBuilder(32 * 16 * 9);
    const blasDescriptors = [];
    
    /**
     * Build BlasDescriptors buffer
     */
    meshes.forEach(node => {
      const {worldMatrix} = node;
      const inverseWorldMatrix = worldMatrix.inverse;
      
      // world matrix
      builder.beginStruct();
      builder.pushFloats(...worldMatrix.column(0));
      builder.pushFloats(...worldMatrix.column(1));
      builder.pushFloats(...worldMatrix.column(2));
      builder.pushFloats(...worldMatrix.column(3));
      
      // inverse world matrix
      builder.pushFloats(...inverseWorldMatrix.column(0));
      builder.pushFloats(...inverseWorldMatrix.column(1));
      builder.pushFloats(...inverseWorldMatrix.column(2));
      builder.pushFloats(...inverseWorldMatrix.column(3));
      
      // texel offset
      const {mesh} = node;
      const {bufferView} = this
        .asset
        .json
        .objectAccelStructs
        .find(bvh => mesh.index === bvh.meshIndex);
      
      const byteOffset = texData.reduce((totalSize, buffer) => totalSize + buffer.byteLength, 0);
      const texelOffset = byteOffset / SIZEOF_RGBA32F_TEXEL;
      
      texData.push(this.asset.getBufferView(bufferView));
      builder.pushInts(texelOffset);

      blasDescriptors.push({
        reference: node,
        worldMatrix,
        inverseWorldMatrix,
        offset: byteOffset / Float32Array.BYTES_PER_ELEMENT,
      });
    });
    
    // update texture data
    const buffer = await new Blob(texData).arrayBuffer();
    
    if (trace) {
      const length = buffer.byteLength / SIZEOF_RGBA32F_TEXEL;
      const size = Math.ceil(Math.sqrt(length));
      const pixels = new Float32Array(size ** 2 * 4);
      
      pixels.set(new Float32Array(buffer));
      
      displayConsole.time();
      gl.bindTexture(gl.TEXTURE_2D, this.fg.getTexture('bvh'));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, pixels);
      gl.bindTexture(gl.TEXTURE_2D, null);
      displayConsole.timeEnd('TLAS Upload', 'gpu');
      
      // update BLAS descriptors to reflect changes in top-level hierarchy
      displayConsole.time();
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.fg.getBuffer('BlasDescriptors'));
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, builder.rawBuffer);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
      displayConsole.timeEnd('BlasDescriptors Upload', 'gpu');

      const main = this.shaderLib.getShader('raytrace-main');
      main.uniforms.set('u_accelStruct.size', [size, size]);
    }

    this._cachedBvhBuffer = {
      pixels: new Float32Array(buffer),
      blasDescriptors,
    };
  }

  resetStartTime() {
    this.#startTime = performance.now();
    this.#sampleOffset = this.sampleCount;
  }
  
  reset() {
    const gl = this.gl;
    
    // zero sample count
    this.sampleCount = 0;
    this.resetStartTime();
    
    // clear accumulation buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fg.getFramebuffer('rtx', 'rtx-pass'));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  async serialize(frame = 'rtx', pass = 'tonemap-pass', dimensions = this.dimensions) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const gl = this.gl;
    const [width, height] = dimensions;
    const data = new Uint8Array(width * height * 4);
    const imageData = ctx.createImageData(width, height);
    const sampleCount = this.sampleCount;
    
    // read pixels from copy-target
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fg.getFramebuffer(frame, pass));
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    // image must be flipped
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const dstOffset = 4 * (y * width + x);
        const srcOffset = 4 * ((height - y - 1) * width + x);
        
        for (let i = 0; i < 4; i++) {
          imageData.data[dstOffset + i] = data[srcOffset + i];
        }
      }
    }
    
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(imageData, 0, 0);
    
    const blob = await canvasToBlob(canvas);
    return [blob, sampleCount];
  }
}