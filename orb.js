// Voice orb: a WebGL sphere whose outline and interior follow the live audio level.
// app.js calls frame() once per animation frame with the current level (0..1) and
// mood; without WebGL the CSS fallback in index.html scales with --level instead.

const VERTEX = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 uResolution;
uniform float uFlow;      // integrated interior phase
uniform float uWobble;    // integrated outline phase
uniform float uBreath;    // integrated breathing phase
uniform float uLevel;     // fast envelope: syllables
uniform float uSwell;     // slow envelope: phrases
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLight;
uniform float uDark;      // 1 on a dark page, 0 on a light one

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.02 + vec3(1.7, 9.2, 4.3);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution - 0.5) * 2.0;
  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  // Outline: a circle at rest; the phrase envelope inflates it and the syllable
  // envelope ripples it with low-order noise around the rim.
  vec2 rim = vec2(cos(angle), sin(angle));
  float ripple = noise(vec3(rim * 1.6, uWobble)) - 0.5;
  ripple += 0.5 * (noise(vec3(rim * 3.1, uWobble * 1.3 + 7.0)) - 0.5);
  float edge = 0.70 + 0.012 * sin(uBreath) + 0.07 * uSwell + (0.012 + 0.12 * uLevel) * ripple;

  // Halo outside the sphere, stronger while there is sound.
  float halo = exp(-max(r - edge, 0.0) * 9.0) * (0.10 + 0.45 * uSwell) * (0.6 + 0.4 * uDark);
  if (r > edge) {
    gl_FragColor = vec4(mix(uMid, uLight, 0.3), halo * (1.0 - smoothstep(0.75, 1.0, r)));
    return;
  }

  // Treat the disc as a sphere so the interior shades like a volume.
  float q = r / edge;
  float z = sqrt(max(1.0 - q * q, 0.0));
  vec3 p = vec3(uv / edge, z);

  // Domain-warped fbm: the flow speeds up and churns harder with the level.
  vec3 flow = vec3(p.xy * 1.35, uFlow);
  vec3 warp = vec3(fbm(flow + vec3(0.0, 0.0, 3.1)), fbm(flow + vec3(5.2, 1.3, 0.0)), 0.0);
  float cloud = fbm(flow + (1.2 + 1.3 * uLevel) * warp);
  float bands = smoothstep(0.30, 0.78, cloud + 0.18 * p.y);

  vec3 color = mix(uDeep, uMid, bands);
  float bright = smoothstep(0.60, 0.98, cloud + 0.2 * uLevel);
  color = mix(color, uLight, bright * (0.25 + 0.45 * uLevel));

  // Lighting: soft key from the upper left, fresnel rim, specular glint.
  float key = clamp(dot(normalize(p), normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  color *= 0.72 + 0.38 * key;
  float fresnel = pow(1.0 - z, 2.4);
  color = mix(color, uLight, fresnel * (0.45 + 0.35 * uSwell));
  float glint = pow(clamp(dot(normalize(p), normalize(vec3(-0.35, 0.45, 0.82))), 0.0, 1.0), 38.0);
  color += glint * 0.35;

  float alpha = 1.0 - smoothstep(edge - 0.012, edge, r);
  gl_FragColor = vec4(mix(color, mix(uMid, uLight, 0.3), 1.0 - alpha), max(alpha, halo));
}
`;

// Colors per mood, [deep, mid, light]; the renderer eases between them.
export const PALETTES = {
  dark: {
    idle: [[0.13, 0.16, 0.24], [0.33, 0.38, 0.50], [0.72, 0.76, 0.85]],
    listening: [[0.06, 0.16, 0.45], [0.18, 0.52, 0.92], [0.78, 0.92, 1.00]],
    user: [[0.05, 0.20, 0.60], [0.15, 0.68, 0.98], [0.88, 0.97, 1.00]],
    speaking: [[0.20, 0.10, 0.52], [0.18, 0.72, 0.72], [0.93, 0.90, 1.00]],
    error: [[0.35, 0.08, 0.12], [0.80, 0.33, 0.40], [1.00, 0.84, 0.86]],
  },
  light: {
    idle: [[0.55, 0.60, 0.70], [0.76, 0.80, 0.87], [0.96, 0.97, 0.99]],
    listening: [[0.16, 0.36, 0.82], [0.42, 0.70, 0.98], [0.93, 0.97, 1.00]],
    user: [[0.10, 0.34, 0.90], [0.30, 0.76, 1.00], [0.96, 0.99, 1.00]],
    speaking: [[0.38, 0.26, 0.82], [0.26, 0.76, 0.76], [0.98, 0.96, 1.00]],
    error: [[0.65, 0.20, 0.26], [0.93, 0.55, 0.60], [1.00, 0.93, 0.94]],
  },
};

// Animation speed per mood, relative to idle.
const SPEED = { idle: 0.6, listening: 1.0, user: 1.5, speaking: 1.8, error: 0.4 };

const TAU = Math.PI * 2;
function wrap(phase, period = TAU) {
  return phase - Math.floor(phase / period) * period;
}

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false, powerPreference: "low-power" });
    this.ready = false;
    this.last = 0;
    this.level = 0;
    this.swell = 0;
    this.speed = SPEED.idle;
    this.flow = 0;
    this.wobble = 0;
    this.breath = 0;
    this.colors = PALETTES.dark.idle.map((color) => color.slice());
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    if (!this.gl) return;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.ready = false;
      canvas.parentElement.classList.remove("has-gl");
    });
    canvas.addEventListener("webglcontextrestored", () => this.init());
    this.init();
  }

  init() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      console.warn("orb shader:", gl.getShaderInfoLog(shader));
      return null;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const names = ["uResolution", "uFlow", "uWobble", "uBreath", "uLevel", "uSwell", "uDeep", "uMid", "uLight", "uDark"];
    this.uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
    this.ready = true;
    this.canvas.parentElement.classList.add("has-gl");
  }

  // level: 0..1 audio level; mood: a key of PALETTES; dark: page theme.
  frame(now, level, mood, dark) {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    const target = Math.max(0, Math.min(1, level));
    // Fast attack, slower release, so syllables pop and pauses settle.
    this.level += (target - this.level) * (1 - Math.exp(-dt * (target > this.level ? 28 : 9)));
    this.swell += (target - this.swell) * (1 - Math.exp(-dt * (target > this.swell ? 5 : 2.2)));
    const motion = this.reduced.matches ? 0.25 : 1;
    this.speed += ((SPEED[mood] || 1) - this.speed) * (1 - Math.exp(-dt * 2));
    // Phases are integrated, not time * speed, so a speed change never jumps them.
    this.flow = wrap(this.flow + dt * motion * (0.10 + 0.08 * this.speed + 0.35 * this.level), 1000);
    this.wobble = wrap(this.wobble + dt * motion * (0.25 + 0.2 * this.speed + 1.2 * this.level), 1000);
    this.breath = wrap(this.breath + dt * motion * 1.3);
    const palette = (dark ? PALETTES.dark : PALETTES.light)[mood] || PALETTES.dark.idle;
    const ease = 1 - Math.exp(-dt * 3.5);
    for (let i = 0; i < 3; i += 1) for (let c = 0; c < 3; c += 1) this.colors[i][c] += (palette[i][c] - this.colors[i][c]) * ease;
    this.canvas.parentElement.style.setProperty("--level", this.swell.toFixed(3));
    if (!this.ready || document.hidden) return;
    this.draw(dark);
  }

  draw(dark) {
    const gl = this.gl;
    const canvas = this.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.round(canvas.clientWidth * ratio);
    if (size && canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.uniforms;
    gl.uniform2f(u.uResolution, canvas.width, canvas.height);
    gl.uniform1f(u.uFlow, this.flow);
    gl.uniform1f(u.uWobble, this.wobble);
    gl.uniform1f(u.uBreath, this.breath);
    gl.uniform1f(u.uLevel, this.level);
    gl.uniform1f(u.uSwell, this.swell);
    gl.uniform3fv(u.uDeep, this.colors[0]);
    gl.uniform3fv(u.uMid, this.colors[1]);
    gl.uniform3fv(u.uLight, this.colors[2]);
    gl.uniform1f(u.uDark, dark ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
