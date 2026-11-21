// AZURE BAY — renderer, camera, lights, sky and the frame loop.
// Owns the WebGLRenderer and the requestAnimationFrame loop; gameplay code
// only supplies an update(dt) function and reads scene / camera / clock.
//
// GOLDEN HOUR (Lane A revisi): a low western sun with long soft shadows,
// a gradient sky dome with a real sun disc + glow, warm distance haze,
// slow-drifting clouds, and animated water with a sun glint. Everything
// is cheap on purpose — one sky shader, a handful of sprites, and a small
// fragment patch on the water — no post-processing, so 60 fps holds.

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Tiny deterministic RNG (mulberry32) so the clouds sit in the same
// places on every load instead of reshuffling.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft cloud-puff texture drawn once on a canvas: a cluster of radial
// blobs, no image asset needed, warm white so the sun tints it.
function makeCloudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261120);
  const blobs = [
    [128, 78, 62], [82, 84, 42], [176, 84, 46],
    [104, 62, 36], [154, 60, 34], [60, 92, 26], [198, 92, 28],
  ];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.38)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  // A couple of faint strays so no two clouds read as the same stamp.
  for (let i = 0; i < 3; i++) {
    const x = 30 + rand() * 196;
    const y = 30 + rand() * 60;
    const r = 14 + rand() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createEngine() {
  const container = document.getElementById('game');
  if (!container) throw new Error('createEngine: #game container not found');

  const P = CONFIG.palette;
  const L = CONFIG.lighting;

  // The sun direction, shared by the light and the sky shader's disc, so
  // the disc in the sky is exactly where the light comes from.
  const sunDir = new THREE.Vector3(...L.sunPosition).normalize();

  // ---- renderer ------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = L.exposure;
  container.appendChild(renderer.domElement);

  // ---- scene, sky and fog ----------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(P.sky);
  // Warm golden haze: near enough that the far shore and the open water
  // melt into the horizon, far enough that the streets stay crisp.
  scene.fog = new THREE.Fog(P.fog, L.fogNear, L.fogFar);

  // Gradient sky dome: deep blue zenith fading to a golden horizon band,
  // a warm halo around the sun and a hard-edged sun disc. One draw call,
  // no texture. tonemapping/colorspace chunks keep it in step with the
  // rest of the ACES pipeline.
  const skyUniforms = {
    uTop: { value: new THREE.Color(P.skyTop) },
    uHorizon: { value: new THREE.Color(P.skyDome) },
    uBelow: { value: new THREE.Color(P.skyBelow) },
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color(P.sun) },
    uDiscColor: { value: new THREE.Color(P.sunDisc) },
  };
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(1100, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uBelow;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uDiscColor;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          vec3 col;
          if (h >= 0.0) {
            col = mix(uHorizon, uTop, pow(h, 0.55));
          } else {
            col = mix(uHorizon, uBelow, pow(-h, 0.45));
          }
          float s = max(dot(dir, uSunDir), 0.0);
          // Warm halo hugging the horizon around the sun. Kept tight on
          // purpose: the old wide halo (0.18/0.30/0.45) washed the whole
          // sun side of the sky pale and, with the water glint under it,
          // blew the top-left of the frame out to white.
          col += uSunColor * (pow(s, 3.0) * 0.10 + pow(s, 8.0) * 0.16 + pow(s, 32.0) * 0.22);
          // Hard-edged disc, about 1.5 degrees across. (Lane D2: shrunk
          // from ~2 deg — the old disc's lower edge peeked into the top
          // of the city shot; the smaller disc plus the pitched-down
          // city camera keep it fully above the frame.)
          float disc = smoothstep(0.99955, 0.99980, s);
          col = mix(col, uDiscColor, disc);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  skyDome.renderOrder = -1;
  scene.add(skyDome);

  // ---- clouds ----------------------------------------------------------------
  // A few big soft sprites, warm-lit, drifting slowly east. Sprites always
  // face the camera, so they read as clouds from any angle for 9 draw calls.
  const cloudTexture = makeCloudTexture();
  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTexture,
    color: P.cloud,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    fog: true,
  });
  const clouds = [];
  {
    const rand = mulberry32(CONFIG.seed + 77);
    const C = L.clouds;
    for (let i = 0; i < C.count; i++) {
      const sprite = new THREE.Sprite(cloudMat);
      const scale = C.minScale + rand() * (C.maxScale - C.minScale);
      sprite.scale.set(scale, scale * 0.45, 1);
      // Keep the sun's side of the sky clearer: bias clouds away from the
      // sun azimuth so the disc and its halo stay unobstructed.
      const angle = rand() * Math.PI * 2;
      const radius = 320 + rand() * 480;
      sprite.position.set(
        Math.cos(angle) * radius,
        C.minY + rand() * (C.maxY - C.minY),
        Math.sin(angle) * radius,
      );
      sprite.userData.drift = C.drift * (0.7 + rand() * 0.6);
      scene.add(sprite);
      clouds.push(sprite);
    }
  }

  // ---- camera ----------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    2500,
  );
  // High three-quarter view over the north island until gameplay takes over.
  camera.position.set(60, 55, -40);
  camera.lookAt(0, 0, -100);

  // ---- lights ------------------------------------------------------------------
  // Warm hemisphere bounce so shadowed faces read warm brown, never black.
  const hemi = new THREE.HemisphereLight(P.skyLight, P.groundLight, L.hemiIntensity);
  scene.add(hemi);

  // Low golden sun: elevation ~15 deg, so shadows stretch ~3.7x the height
  // of whatever casts them. Shadow frustum covers both islands + bridge.
  const sun = new THREE.DirectionalLight(P.sun, L.sunIntensity);
  sun.position.set(...L.sunPosition);
  sun.castShadow = true;
  sun.shadow.mapSize.set(L.shadowSize, L.shadowSize);
  sun.shadow.camera.left = -L.shadowBounds;
  sun.shadow.camera.right = L.shadowBounds;
  sun.shadow.camera.top = L.shadowBounds;
  sun.shadow.camera.bottom = -L.shadowBounds;
  sun.shadow.camera.near = L.shadowNear;
  sun.shadow.camera.far = L.shadowFar;
  sun.shadow.bias = L.shadowBias;
  sun.shadow.normalBias = L.shadowNormalBias;
  scene.add(sun);
  scene.add(sun.target);

  // Cool sky fill from the east (opposite the sun), no shadows: lifts the
  // shadow sides of buildings just enough to keep detail in them.
  const fill = new THREE.DirectionalLight(P.fillLight, L.fillIntensity);
  fill.position.set(420, 220, 160);
  scene.add(fill);

  // ---- water shimmer + sun glint ---------------------------------------------
  // The water mesh lives in city.js (not this lane's file), so the engine
  // finds it lazily on the first frames and patches its standard material
  // with a small fragment injection: three travelling sine waves perturb
  // the normal, and a Blinn half-vector term adds a warm sun glint that
  // sparkles as the waves move. No extra geometry, no extra draw call.
  let waterShader = null;
  let waterPatched = false;
  let waterSearchFrames = 0;

  function patchWater(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uSunDir = { value: sunDir };
      shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
      shader.fragmentShader = (
        'varying vec3 vWPos;\nuniform float uTime;\nuniform vec3 uSunDir;\n'
        + shader.fragmentShader
      ).replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          // Travelling waves: perturb the normal in world space, then
          // carry it into view space (three.js lights in view space).
          float t = uTime * 0.9;
          vec2 p = vWPos.xz;
          float w1 = sin(p.x * 0.11 + t * 1.1) * cos(p.y * 0.13 - t * 0.9);
          float w2 = sin((p.x + p.y) * 0.071 - t * 0.7) * cos(p.x * 0.05 + t * 0.5);
          float w3 = sin(p.y * 0.19 + t * 1.7);
          vec3 waveN = normalize(vec3(
            w1 * 0.14 + w2 * 0.10,
            1.0,
            w2 * 0.10 + w3 * 0.08
          ));
          vec3 waveNView = normalize((viewMatrix * vec4(waveN, 0.0)).xyz);
          normal = normalize(mix(normal, waveNView, ${L.water.waveStrength}));
        }`,
      ).replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Warm sun glint: Blinn half-vector against the perturbed
          // normal, so the sparkle travels with the waves.
          vec3 V = normalize(vViewPosition);
          vec3 sunDirView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 H = normalize(sunDirView + V);
          float glint = pow(max(dot(normal, H), 0.0), ${L.water.glintPower.toFixed(1)});
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * glint * ${L.water.glintStrength.toFixed(2)};
        }`,
      );
      waterShader = shader;
    };
    // Keep this patched program out of the shared program cache.
    material.customProgramCacheKey = () => 'azure-bay-water-golden';
    material.needsUpdate = true;
  }

  function findAndPatchWater() {
    if (waterPatched || waterSearchFrames > 300) return;
    waterSearchFrames += 1;
    scene.traverse((obj) => {
      if (waterPatched || !obj.isMesh) return;
      const geo = obj.geometry;
      if (
        geo && geo.parameters
        && geo.parameters.width === CONFIG.waterSize
        && geo.parameters.height === CONFIG.waterSize
        && Math.abs(obj.position.y - CONFIG.waterY) < 0.01
      ) {
        patchWater(obj.material);
        waterPatched = true;
      }
    });
  }

  const clock = new THREE.Clock();

  // ---- frame loop --------------------------------------------------------------
  let rafId = 0;
  let running = false;

  function startLoop(updateFn) {
    if (running) return;
    running = true;
    clock.start();
    const tick = () => {
      if (!running) return;
      rafId = requestAnimationFrame(tick);
      // Clamp a stalled frame (hidden tab) so physics never jumps a full second.
      const dt = Math.min(clock.getDelta(), 0.05);
      updateFn(dt);

      // ---- Lane A per-frame atmosphere (cheap, no allocations) ----
      findAndPatchWater();
      if (waterShader) waterShader.uniforms.uTime.value = clock.getElapsedTime();
      for (const cloud of clouds) {
        cloud.position.x += cloud.userData.drift * dt;
        if (cloud.position.x > 950) cloud.position.x = -950;
      }

      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ---- resize ------------------------------------------------------------------
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  return { scene, camera, renderer, clock, startLoop, stopLoop };
}
