/**
 * ============================================================================
 * ShinyVisuals — Interactive Water Surface & Ripple Shader
 * Реалистичный шейдер водной глади при движении пальца / мыши по экрану
 * Высокопроизводительный WebGL 1/2 с красивой каустикой, бликами и переливами
 * ============================================================================
 */

(function () {
  'use strict';

  if (window.__shinyWaterInit) return;
  window.__shinyWaterInit = true;

  const MAX_RIPPLES = 48;
  const ripples = [];
  let rippleId = 0;
  let isRunning = false;
  let animFrameId = null;
  let lastX = -1;
  let lastY = -1;
  let lastSpawnTime = 0;
  let isPointerDown = false;
  const startTime = performance.now();

  function getTimeSec() {
    return (performance.now() - startTime) / 1000.0;
  }

  // Создание холста
  const canvas = document.createElement('canvas');
  canvas.id = 'shiny-water-canvas';
  canvas.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 100vw',
    'height: 100vh',
    'pointer-events: none',
    'z-index: 9999',
    'display: block',
    'background: transparent'
  ].join(';');

  function mountCanvas() {
    if (!document.body.contains(canvas)) {
      document.body.appendChild(canvas);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountCanvas);
  } else {
    mountCanvas();
  }

  // Инициализация WebGL
  let gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false, depth: false }) ||
           canvas.getContext('experimental-webgl', { alpha: true, antialias: true, premultipliedAlpha: false, depth: false });

  if (!gl) {
    initCanvas2DFallback();
    return;
  }

  const vsSource = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const fsSource = `
    #ifdef GL_ES
    precision highp float;
    #endif

    varying vec2 v_uv;
    uniform float u_time;
    uniform float u_aspect;

    #define MAX_R 48
    uniform vec4 u_ripples[MAX_R]; // x, y (0..1), birthTime, strength
    uniform int u_count;

    void main() {
      vec2 uv = v_uv;
      uv.y = 1.0 - uv.y; // Y идет сверху вниз, как в координатах мыши

      float totalHeight = 0.0;
      vec2 totalSlope = vec2(0.0);

      const float waveSpeed = 0.34;    // Скорость расхождения волны
      const float waveFreq  = 44.0;    // Частота гребней
      const float maxAge    = 2.2;     // Время жизни волны

      for (int i = 0; i < MAX_R; i++) {
        float activeFlag = step(float(i) + 0.5, float(u_count));
        vec4 r = u_ripples[i];
        float age = u_time - r.z;

        if (age >= 0.0 && age <= maxAge) {
          vec2 diff = uv - r.xy;
          diff.x *= u_aspect;
          float dist = length(diff);

          float front = age * waveSpeed;
          float delta = dist - front;

          // Волновой пакет: 2-3 красивых концентрических кольца
          float env = exp(-(delta * delta) / (2.0 * 0.032 * 0.032));
          // Плавное затухание к концу жизни
          float timeDecay = pow(max(0.0, 1.0 - age / maxAge), 1.5);
          float geomDecay = 1.0 / sqrt(dist * 3.5 + 0.25);

          float amp = r.w * env * timeDecay * geomDecay * activeFlag * 0.35;

          // Синусоидальные гребни
          float phase = delta * waveFreq;
          float s = sin(phase);
          float c = cos(phase);

          totalHeight += amp * s;

          vec2 dir = (dist > 0.0001) ? (diff / dist) : vec2(0.0);
          float dH = amp * (waveFreq * c - (delta / 0.001) * s);
          totalSlope += dir * dH;
        }
      }

      // Мягкое ограничение высоты волн при наложении
      totalHeight = totalHeight / (1.0 + abs(totalHeight) * 0.5);
      float slopeMag = length(totalSlope);
      float hMag = abs(totalHeight);

      // Полная прозрачность спокойной воды
      if (slopeMag < 0.0003 && hMag < 0.0003) {
        discard;
      }

      // Реалистичная нормаль к поверхности воды
      vec3 normal = normalize(vec3(-totalSlope * 0.045, 1.0));
      vec3 viewDir = vec3(0.0, 0.0, 1.0);

      // Освещение (основной верхний свет для бликов)
      vec3 light1 = normalize(vec3(-0.35, 0.60, 0.70));
      vec3 half1 = normalize(light1 + viewDir);

      vec3 light2 = normalize(vec3(0.40, -0.40, 0.80));
      vec3 half2 = normalize(light2 + viewDir);

      // Острые бриллиантовые блики на гребнях воды (как на солнце)
      float NdotH1 = max(0.0, dot(normal, half1));
      float spec1  = pow(NdotH1, 40.0);
      float glint1 = pow(NdotH1, 140.0) * 2.5;

      float NdotH2 = max(0.0, dot(normal, half2));
      float spec2  = pow(NdotH2, 28.0) * 0.6;

      // Эффект Френеля (усиление отражений на изгибах волн)
      float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);

      // Каустические полосы света на гребне волны
      float crest = smoothstep(0.05, 0.75, totalHeight);
      float caustic = pow(crest, 2.2) * 1.8;

      // Палитра воды в стиле ShinyVisuals:
      vec3 colWhite  = vec3(1.0, 1.0, 1.0);         // Чистый белый блик
      vec3 colCyan   = vec3(0.22, 0.85, 1.0);       // Лазурный гребень волны (#38bdf8)
      vec3 colViolet = vec3(0.70, 0.38, 1.0);       // Неоново-фиолетовый перелив (#a855f7)

      vec3 shimmer = mix(colViolet, colCyan, normal.x * 0.5 + 0.5);

      vec3 finalCol = vec3(0.0);
      finalCol += colWhite * glint1;
      finalCol += shimmer * (spec1 * 1.3 + spec2);
      finalCol += colCyan * caustic;
      finalCol += colViolet * (fresnel * 0.6 + slopeMag * 0.12);

      // Прозрачность: вода прозрачна, видны только четкие кольца и блики волн
      float alpha = clamp(
        glint1 * 1.0 +
        spec1 * 0.80 +
        spec2 * 0.40 +
        caustic * 0.70 +
        fresnel * 0.45 +
        slopeMag * 0.15,
        0.0,
        0.90
      );

      float edgeMask = smoothstep(0.0003, 0.002, slopeMag + hMag);
      alpha *= edgeMask;
      finalCol *= edgeMask;

      gl_FragColor = vec4(finalCol, alpha);
    }
  `;

  function createShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[ShinyVisuals Water] Shader error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  const vs = createShader(gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) {
    initCanvas2DFallback();
    return;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[ShinyVisuals Water] Link error:', gl.getProgramInfoLog(program));
    initCanvas2DFallback();
    return;
  }

  gl.useProgram(program);

  // VBO для полноэкранного прямоугольника
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]), gl.STATIC_DRAW);

  const aPosLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

  const uTimeLoc       = gl.getUniformLocation(program, 'u_time');
  const uAspectLoc     = gl.getUniformLocation(program, 'u_aspect');
  // gl.getUniformLocation с [0] для 100% совместимости
  const uRipplesLoc    = gl.getUniformLocation(program, 'u_ripples[0]') || gl.getUniformLocation(program, 'u_ripples');
  const uCountLoc      = gl.getUniformLocation(program, 'u_count');

  const rippleData = new Float32Array(MAX_RIPPLES * 4);

  function addRipple(normX, normY, strength) {
    const t = getTimeSec();
    ripples.push({
      id: ++rippleId,
      x: Math.max(0.0, Math.min(1.0, normX)),
      y: Math.max(0.0, Math.min(1.0, normY)),
      time: t,
      strength: strength || 0.55
    });

    if (ripples.length > MAX_RIPPLES) {
      ripples.shift();
    }

    wakeUp();
  }

  // Обновление размеров холста
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    wakeUp();
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  function handleInputMove(clientX, clientY, isDown) {
    const now = performance.now();
    const nx = clientX / window.innerWidth;
    const ny = clientY / window.innerHeight;

    if (lastX >= 0 && lastY >= 0) {
      const dx = (nx - lastX) * (window.innerWidth / window.innerHeight);
      const dy = ny - lastY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = now - lastSpawnTime;

      // Ограничение частоты создания волн (не чаще ~18 в сек при движении)
      const minInterval = 50; // мс
      const minDist = 0.022;

      if ((dist >= minDist && dt >= 35) || (dt >= minInterval && dist >= 0.012)) {
        const speed = Math.min(dist / (Math.max(1, dt) / 1000), 4.0);
        const baseStrength = isDown ? 0.80 : 0.55;
        const strength = Math.min(baseStrength * (0.85 + speed * 0.25), 0.98);

        // При быстром взмахе добавляем промежуточную точку, чтобы не было разрывов
        if (dist > 0.06) {
          const midX = (lastX + nx) * 0.5;
          const midY = (lastY + ny) * 0.5;
          addRipple(midX, midY, strength * 0.85);
        }

        addRipple(nx, ny, strength);
        lastX = nx;
        lastY = ny;
        lastSpawnTime = now;
      }
    } else {
      addRipple(nx, ny, isDown ? 0.85 : 0.55);
      lastX = nx;
      lastY = ny;
      lastSpawnTime = now;
    }
  }

  // Pointer Events (мышь + сенсорный экран)
  window.addEventListener('pointerdown', (e) => {
    isPointerDown = true;
    const nx = e.clientX / window.innerWidth;
    const ny = e.clientY / window.innerHeight;
    lastX = nx;
    lastY = ny;
    lastSpawnTime = performance.now();
    addRipple(nx, ny, 0.90);
    setTimeout(() => addRipple(nx, ny, 0.60), 60);
  }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    handleInputMove(e.clientX, e.clientY, isPointerDown || e.buttons > 0);
  }, { passive: true });

  window.addEventListener('pointerup', () => {
    isPointerDown = false;
    lastX = -1;
    lastY = -1;
  }, { passive: true });

  window.addEventListener('pointercancel', () => {
    isPointerDown = false;
    lastX = -1;
    lastY = -1;
  }, { passive: true });

  // Touch Events (для максимальной совместимости с мобильными браузерами)
  window.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      const nx = t.clientX / window.innerWidth;
      const ny = t.clientY / window.innerHeight;
      lastX = nx;
      lastY = ny;
      lastSpawnTime = performance.now();
      addRipple(nx, ny, 0.90);
      setTimeout(() => addRipple(nx, ny, 0.60), 60);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      handleInputMove(t.clientX, t.clientY, true);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    lastX = -1;
    lastY = -1;
  }, { passive: true });

  function wakeUp() {
    if (!isRunning) {
      isRunning = true;
      animFrameId = requestAnimationFrame(tick);
    }
  }

  function tick() {
    const curTime = getTimeSec();

    // Очищаем устаревшие волны (> 2.6 сек)
    while (ripples.length > 0 && curTime - ripples[0].time > 2.6) {
      ripples.shift();
    }

    if (ripples.length === 0) {
      isRunning = false;
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const count = Math.min(ripples.length, MAX_RIPPLES);
    for (let i = 0; i < count; i++) {
      const rip = ripples[i];
      rippleData[i * 4 + 0] = rip.x;
      rippleData[i * 4 + 1] = rip.y;
      rippleData[i * 4 + 2] = rip.time;
      rippleData[i * 4 + 3] = rip.strength;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(uTimeLoc, curTime);
    gl.uniform1f(uAspectLoc, window.innerWidth / window.innerHeight);
    gl.uniform1i(uCountLoc, count);
    gl.uniform4fv(uRipplesLoc, rippleData);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    animFrameId = requestAnimationFrame(tick);
  }

  // Приветственный мягкий всплеск по центру при загрузке страницы
  setTimeout(() => {
    addRipple(0.5, 0.45, 0.80);
    setTimeout(() => addRipple(0.5, 0.45, 0.50), 120);
  }, 250);

  // Резервный рендерер 2D Canvas на случай отсутствия WebGL
  function initCanvas2DFallback() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const circles = [];

    function addCircle(x, y, str) {
      circles.push({
        x: x * window.innerWidth,
        y: y * window.innerHeight,
        born: performance.now(),
        str: str || 0.55
      });
      if (circles.length > 35) circles.shift();
      if (!isRunning) {
        isRunning = true;
        requestAnimationFrame(tick2D);
      }
    }

    function resize2D() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize2D, { passive: true });
    resize2D();

    window.addEventListener('pointermove', (e) => {
      addCircle(e.clientX / window.innerWidth, e.clientY / window.innerHeight, 0.5);
    }, { passive: true });

    window.addEventListener('pointerdown', (e) => {
      addCircle(e.clientX / window.innerWidth, e.clientY / window.innerHeight, 0.85);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        addCircle(e.touches[0].clientX / window.innerWidth, e.touches[0].clientY / window.innerHeight, 0.6);
      }
    }, { passive: true });

    function tick2D() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const now = performance.now();

      while (circles.length > 0 && now - circles[0].born > 2400) {
        circles.shift();
      }

      if (circles.length === 0) {
        isRunning = false;
        return;
      }

      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        const age = (now - c.born) / 1000;
        const radius = age * 190;
        const alpha = Math.max(0, (1 - age / 2.4) * c.str);

        ctx.save();
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.85})`;
        ctx.lineWidth = 3.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(0, radius - 15), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(168, 85, 247, ${alpha * 0.65})`;
        ctx.lineWidth = 2.0;
        ctx.stroke();
        ctx.restore();
      }

      requestAnimationFrame(tick2D);
    }

    addCircle(0.5, 0.45, 0.8);
  }
})();
