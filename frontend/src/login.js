import { auth, googleProvider, signInWithPopup, onAuthStateChanged } from './firebase.js';
import { Renderer, Triangle, Program, Mesh } from 'ogl';

document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('google-login-btn');
  const errorMsg = document.getElementById('error-msg');
  const loginCard = document.querySelector('.login-container');
  const prismBgContainer = document.getElementById('prism-bg');

  // Initialize WebGL Prism Shader Background
  if (prismBgContainer) {
    try {
      initPrism(prismBgContainer);
    } catch (err) {
      console.error('Failed to initialize WebGL Prism background:', err);
    }
  }

  // Interactive 3D tilt effect following the mouse cursor
  if (loginCard) {
    document.addEventListener('mousemove', (e) => {
      const cardRect = loginCard.getBoundingClientRect();
      const cardCenterX = cardRect.left + cardRect.width / 2;
      const cardCenterY = cardRect.top + cardRect.height / 2;
      
      const xAxis = (cardCenterX - e.clientX) / 15;
      const yAxis = (e.clientY - cardCenterY) / 15;
      
      loginCard.style.transform = `rotateY(${xAxis}deg) rotateX(${yAxis}deg) translateZ(15px)`;
    });

    document.addEventListener('mouseleave', () => {
      loginCard.style.transform = `rotateX(10deg) rotateY(-5deg) translateZ(0px)`;
    });
  }

  // If already logged in, redirect to chat
  onAuthStateChanged(auth, (user) => {
    if (user) {
      window.location.href = '/chat/';
    }
  });

  loginBtn.addEventListener('click', async () => {
    try {
      loginBtn.disabled = true;
      loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
      errorMsg.textContent = '';
      
      await signInWithPopup(auth, googleProvider);
      // onAuthStateChanged will handle the redirect
    } catch (error) {
      console.error('Login error:', error);
      loginBtn.disabled = false;
      loginBtn.innerHTML = `
      <svg class="google-icon" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        <path fill="none" d="M1 1h22v22H1z"/>
      </svg>
      Sign in with Google`;
      
      // Handle common errors gracefully
      if (error.code === 'auth/popup-closed-by-user') {
        errorMsg.textContent = 'Sign-in popup was closed before completing.';
      } else {
        errorMsg.textContent = `Error: ${error.message}`;
      }
    }
  });
});

// WebGL Prism shader implementation using OGL
function initPrism(container) {
  const height = 3.5;
  const baseWidth = 5.5;
  const animationType = 'rotate';
  const glow = 1;
  const offset = { x: 0, y: 0 };
  const noise = 0;
  const transparent = true;
  const scale = 3.6;
  const hueShift = 0;
  const colorFrequency = 1;
  const hoverStrength = 2;
  const inertia = 0.05;
  const bloom = 1;
  const suspendWhenOffscreen = false;
  const timeScale = 0.5;

  const H = Math.max(0.001, height);
  const BW = Math.max(0.001, baseWidth);
  const BASE_HALF = BW * 0.5;
  const GLOW = Math.max(0.0, glow);
  const NOISE = Math.max(0.0, noise);
  const offX = offset?.x ?? 0;
  const offY = offset?.y ?? 0;
  const SAT = transparent ? 1.5 : 1;
  const SCALE = Math.max(0.001, scale);
  const HUE = hueShift || 0;
  const CFREQ = Math.max(0.0, colorFrequency || 1);
  const BLOOM = Math.max(0.0, bloom || 1);
  const RSX = 1;
  const RSY = 1;
  const RSZ = 1;
  const TS = Math.max(0, timeScale || 1);
  const HOVSTR = Math.max(0, hoverStrength || 1);
  const INERT = Math.max(0, Math.min(1, inertia || 0.12));

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const renderer = new Renderer({
    dpr,
    alpha: transparent,
    antialias: false
  });
  const gl = renderer.gl;
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  Object.assign(gl.canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    zIndex: '0'
  });
  container.appendChild(gl.canvas);

  const vertex = /* glsl */ `
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const fragment = /* glsl */ `
    precision highp float;

    uniform vec2  iResolution;
    uniform float iTime;

    uniform float uHeight;
    uniform float uBaseHalf;
    uniform mat3  uRot;
    uniform int   uUseBaseWobble;
    uniform float uGlow;
    uniform vec2  uOffsetPx;
    uniform float uNoise;
    uniform float uSaturation;
    uniform float uScale;
    uniform float uHueShift;
    uniform float uColorFreq;
    uniform float uBloom;
    uniform float uCenterShift;
    uniform float uInvBaseHalf;
    uniform float uInvHeight;
    uniform float uMinAxis;
    uniform float uPxScale;
    uniform float uTimeScale;

    vec4 tanh4(vec4 x){
      vec4 e2x = exp(2.0*x);
      return (e2x - 1.0) / (e2x + 1.0);
    }

    float rand(vec2 co){
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float sdOctaAnisoInv(vec3 p){
      vec3 q = vec3(abs(p.x) * uInvBaseHalf, abs(p.y) * uInvHeight, abs(p.z) * uInvBaseHalf);
      float m = q.x + q.y + q.z - 1.0;
      return m * uMinAxis * 0.5773502691896258;
    }

    float sdPyramidUpInv(vec3 p){
      float oct = sdOctaAnisoInv(p);
      float halfSpace = -p.y;
      return max(oct, halfSpace);
    }

    mat3 hueRotation(float a){
      float c = cos(a), s = sin(a);
      mat3 W = mat3(
        0.299, 0.587, 0.114,
        0.299, 0.587, 0.114,
        0.299, 0.587, 0.114
      );
      mat3 U = mat3(
         0.701, -0.587, -0.114,
        -0.299,  0.413, -0.114,
        -0.300, -0.588,  0.886
      );
      mat3 V = mat3(
         0.168, -0.331,  0.500,
         0.328,  0.035, -0.500,
        -0.497,  0.296,  0.201
      );
      return W + U * c + V * s;
    }

    void main(){
      vec2 f = (gl_FragCoord.xy - 0.5 * iResolution.xy - uOffsetPx) * uPxScale;

      float z = 5.0;
      float d = 0.0;

      vec3 p;
      vec4 o = vec4(0.0);

      float centerShift = uCenterShift;
      float cf = uColorFreq;

      mat2 wob = mat2(1.0);
      if (uUseBaseWobble == 1) {
        float t = iTime * uTimeScale;
        float c0 = cos(t + 0.0);
        float c1 = cos(t + 33.0);
        float c2 = cos(t + 11.0);
        wob = mat2(c0, c1, c2, c0);
      }

      const int STEPS = 100;
      for (int i = 0; i < STEPS; i++) {
        p = vec3(f, z);
        p.xz = p.xz * wob;
        p = uRot * p;
        vec3 q = p;
        q.y += centerShift;
        d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));
        z -= d;
        o += (sin((p.y + z) * cf + vec4(0.0, 1.0, 2.0, 3.0)) + 1.0) / d;
      }

      o = tanh4(o * o * (uGlow * uBloom) / 1e5);

      vec3 col = o.rgb;
      float n = rand(gl_FragCoord.xy + vec2(iTime));
      col += (n - 0.5) * uNoise;
      col = clamp(col, 0.0, 1.0);

      float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);

      if(abs(uHueShift) > 0.0001){
        col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);
      }

      gl_FragColor = vec4(col, o.a);
    }
  `;

  const geometry = new Triangle(gl);
  const iResBuf = new Float32Array(2);
  const offsetPxBuf = new Float32Array(2);

  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms: {
      iResolution: { value: iResBuf },
      iTime: { value: 0 },
      uHeight: { value: H },
      uBaseHalf: { value: BASE_HALF },
      uUseBaseWobble: { value: 1 },
      uRot: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uGlow: { value: GLOW },
      uOffsetPx: { value: offsetPxBuf },
      uNoise: { value: NOISE },
      uSaturation: { value: SAT },
      uScale: { value: SCALE },
      uHueShift: { value: HUE },
      uColorFreq: { value: CFREQ },
      uBloom: { value: BLOOM },
      uCenterShift: { value: H * 0.25 },
      uInvBaseHalf: { value: 1 / BASE_HALF },
      uInvHeight: { value: 1 / H },
      uMinAxis: { value: Math.min(BASE_HALF, H) },
      uPxScale: {
        value: 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE)
      },
      uTimeScale: { value: TS }
    }
  });
  const mesh = new Mesh(gl, { geometry, program });

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h);
    iResBuf[0] = gl.drawingBufferWidth;
    iResBuf[1] = gl.drawingBufferHeight;
    offsetPxBuf[0] = offX * dpr;
    offsetPxBuf[1] = offY * dpr;
    program.uniforms.uPxScale.value = 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const rotBuf = new Float32Array(9);
  const setMat3FromEuler = (yawY, pitchX, rollZ, out) => {
    const cy = Math.cos(yawY), sy = Math.sin(yawY);
    const cx = Math.cos(pitchX), sx = Math.sin(pitchX);
    const cz = Math.cos(rollZ), sz = Math.sin(rollZ);
    const r00 = cy * cz + sy * sx * sz;
    const r01 = -cy * sz + sy * sx * cz;
    const r02 = sy * cx;

    const r10 = cx * sz;
    const r11 = cx * cz;
    const r12 = -sx;

    const r20 = -sy * cz + cy * sx * sz;
    const r21 = sy * sz + cy * sx * cz;
    const r22 = cy * cx;

    out[0] = r00; out[1] = r10; out[2] = r20;
    out[3] = r01; out[4] = r11; out[5] = r21;
    out[6] = r02; out[7] = r12; out[8] = r22;
    return out;
  };

  const NOISE_IS_ZERO = NOISE < 1e-6;
  let raf = 0;
  const t0 = performance.now();
  const startRAF = () => {
    if (raf) return;
    raf = requestAnimationFrame(render);
  };
  const stopRAF = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const rnd = () => Math.random();
  const wX = (0.3 + rnd() * 0.6) * RSX;
  const wY = (0.2 + rnd() * 0.7) * RSY;
  const wZ = (0.1 + rnd() * 0.5) * RSZ;
  const phX = rnd() * Math.PI * 2;
  const phZ = rnd() * Math.PI * 2;

  let yaw = 0, pitch = 0, roll = 0;
  let targetYaw = 0, targetPitch = 0;
  const lerp = (a, b, t) => a + (b - a) * t;

  const pointer = { x: 0, y: 0, inside: true };
  const onMove = e => {
    const ww = Math.max(1, window.innerWidth);
    const wh = Math.max(1, window.innerHeight);
    const cx = ww * 0.5;
    const cy = wh * 0.5;
    const nx = (e.clientX - cx) / (ww * 0.5);
    const ny = (e.clientY - cy) / (wh * 0.5);
    pointer.x = Math.max(-1, Math.min(1, nx));
    pointer.y = Math.max(-1, Math.min(1, ny));
    pointer.inside = true;
  };
  const onLeave = () => { pointer.inside = false; };
  const onBlur = () => { pointer.inside = false; };

  let onPointerMove = null;
  if (animationType === 'hover') {
    onPointerMove = e => {
      onMove(e);
      startRAF();
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onBlur);
    program.uniforms.uUseBaseWobble.value = 0;
  } else if (animationType === '3drotate') {
    program.uniforms.uUseBaseWobble.value = 0;
  } else {
    program.uniforms.uUseBaseWobble.value = 1;
  }

  const render = t => {
    const time = (t - t0) * 0.001;
    program.uniforms.iTime.value = time;

    let continueRAF = true;

    if (animationType === 'hover') {
      const maxPitch = 0.6 * HOVSTR;
      const maxYaw = 0.6 * HOVSTR;
      targetYaw = (pointer.inside ? -pointer.x : 0) * maxYaw;
      targetPitch = (pointer.inside ? pointer.y : 0) * maxPitch;
      const prevYaw = yaw;
      const prevPitch = pitch;
      const prevRoll = roll;
      yaw = lerp(prevYaw, targetYaw, INERT);
      pitch = lerp(prevPitch, targetPitch, INERT);
      roll = lerp(prevRoll, 0, 0.1);
      program.uniforms.uRot.value = setMat3FromEuler(yaw, pitch, roll, rotBuf);

      if (NOISE_IS_ZERO) {
        const settled = Math.abs(yaw - targetYaw) < 1e-4 && Math.abs(pitch - targetPitch) < 1e-4 && Math.abs(roll) < 1e-4;
        if (settled) continueRAF = false;
      }
    } else if (animationType === '3drotate') {
      const tScaled = time * TS;
      yaw = tScaled * wY;
      pitch = Math.sin(tScaled * wX + phX) * 0.6;
      roll = Math.sin(tScaled * wZ + phZ) * 0.5;
      program.uniforms.uRot.value = setMat3FromEuler(yaw, pitch, roll, rotBuf);
      if (TS < 1e-6) continueRAF = false;
    } else {
      // rotate mode (base wobble)
      rotBuf[0] = 1;
      rotBuf[1] = 0;
      rotBuf[2] = 0;
      rotBuf[3] = 0;
      rotBuf[4] = 1;
      rotBuf[5] = 0;
      rotBuf[6] = 0;
      rotBuf[7] = 0;
      rotBuf[8] = 1;
      program.uniforms.uRot.value = rotBuf;
      if (TS < 1e-6) continueRAF = false;
    }

    renderer.render({ scene: mesh });
    if (continueRAF) {
      raf = requestAnimationFrame(render);
    } else {
      raf = 0;
    }
  };

  if (suspendWhenOffscreen) {
    const io = new IntersectionObserver(entries => {
      const vis = entries.some(e => e.isIntersecting);
      if (vis) startRAF();
      else stopRAF();
    });
    io.observe(container);
    startRAF();
    container.__prismIO = io;
  } else {
    startRAF();
  }

  return () => {
    stopRAF();
    ro.disconnect();
    if (animationType === 'hover') {
      if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onBlur);
    }
    if (suspendWhenOffscreen) {
      const io = container.__prismIO;
      if (io) io.disconnect();
      delete container.__prismIO;
    }
    if (gl.canvas.parentElement === container) container.removeChild(gl.canvas);
  };
}
