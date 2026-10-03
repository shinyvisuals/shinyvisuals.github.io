/**
 * ============================================================================
 * ShinyVisuals — Interactive Water Surface & Ripple Shader
 * Реалистичный шейдер водной глади при движении пальца / мыши по экрану
 * Поддержка WebGL 1/2 с красивой каустикой, бликами и переливами
 * ============================================================================
 */

(function () {
  'use strict';

  if (window.__shinyWaterInit) return;
  window.__shinyWaterInit = true;

  const MAX_RIPPLES = 48;
  const ripples = [];
  let rippleId = 0;

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

  // Попытка инициализации WebGL
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
    uniform vec2 u_resolution;

    #define MAX_R 48
    uniform vec4 u_ripples[MAX_R]; // x, y (0..1), birthTime, strength
    uniform int u_count;

    void main() {
      vec2 uv = v_uv;
      uv.y = 1.0 - uv.y; // ориентация сверху вниз

      float totalHeight = 0.0;
      vec2 totalSlope = vec2(0.0);

      const float waveSpeed = 0.44;    // Скорость расхождения кругов по воде
      const float waveFreq  = 54.0;    // Частота волн (крутизна гребней)
      const float waveWidth = 0.024;   // Ширина волнового пакета
      const float decayRate = 1.25;    // Затухание энергии со временем
      const float maxAge    = 2.4;     // Время жизни волны в секундах

      for (int i = 0; i < MAX_R; i++) {
        if (i >= u_count) break;

        vec4 r = u_ripples[i];
        float age = u_time - r.z;
        if (age < 0.0 || age > maxAge) continue;

        vec2 diff = uv - r.xy;
        diff.x *= u_aspect;
        float dist = length(diff);

        float front = age * waveSpeed;
        float delta = dist - front;

        // Волновой пакет Гаусса вокруг фронта волны
        float envelope = exp(-(delta * delta) / (2.0 * waveWidth * waveWidth));
        // Затухание волны со временем и с расстоянием (закон сохранения энергии волн на воде 1/sqrt(r))
        float timeDecay = exp(-age * decayRate);
        float geomDecay = 1.0 / sqrt(dist * 6.0 + 0.12);

        float amp = r.w * envelope * timeDecay * geomDecay;

        // Колебание волны (синусоида)
        float phase = delta * waveFreq;
        float s = sin(phase);
        float c = cos(phase);

        totalHeight += amp * s;

        // Радиальный градиент уклона поверхности
        vec2 dir = (dist > 0.0001) ? (diff / dist) : vec2(0.0);
        float dH = amp * (waveFreq * c - (delta / (waveWidth * waveWidth)) * s);
        totalSlope += dir * dH;
      }

      float slopeMag = length(totalSlope);
      float hMag = abs(totalHeight);

      // Если в данной точке вода спокойна — отсекаем пиксель
      if (slopeMag < 0.0004 && hMag < 0.0004) {
        discard;
      }

      // Нормаль к искривленной водной поверхности
      float normalStrength = 2.4;
      vec3 normal = normalize(vec3(-totalSlope.x * normalStrength, -totalSlope.y * normalStrength, 0.4));

      // Источники освещения
      // Основной верхне-левый свет (создает яркие солнечные блики)
      vec3 light1 = normalize(vec3(-0.35, 0.65, 0.70));
      vec3 viewDir = vec3(0.0, 0.0, 1.0);
      vec3 half1 = normalize(light1 + viewDir);

      // Вторичный контровой свет (подсвечивает противоположный край волны)
      vec3 light2 = normalize(vec3(0.45, -0.40, 0.65));
      vec3 half2 = normalize(light2 + viewDir);

      // Блики (Specular & Diamond Glint)
      float NdotH1 = max(0.0, dot(normal, half1));
      float spec1  = pow(NdotH1, 32.0);
      float glint1 = pow(NdotH1, 110.0) * 2.2;

      float NdotH2 = max(0.0, dot(normal, half2));
      float spec2  = pow(NdotH2, 18.0);

      // Эффект Френеля (повышенное отражение под скользящим углом)
      float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 2.8);

      // Каустические полосы на гребнях волн
      float crest = clamp(totalHeight * 5.0, 0.0, 1.0);
      float caustic = pow(crest, 2.0) * 1.6;

      // Палитра воды в фирменном стиле ShinyVisuals:
      // Белоснежный бриллиантовый блик солнца
      vec3 colWhite  = vec3(1.0, 1.0, 1.0);
      // Яркий лазурно-бирюзовый гребень воды (#38bdf8)
      vec3 colCyan   = vec3(0.24, 0.82, 1.0);
      // Насыщенный неоново-фиолетовый перелив (#a855f7)
      vec3 colViolet = vec3(0.68, 0.36, 1.0);
      // Глубокий оттенок воды (#1e1035)
      vec3 colDeep   = vec3(0.32, 0.16, 0.58);

      // Перелив цвета в зависимости от направления нормали
      vec3 shimmer = mix(colViolet, colCyan, normal.x * 0.5 + 0.5);

      vec3 finalCol = vec3(0.0);
      finalCol += colWhite * glint1;
      finalCol += shimmer * (spec1 * 1.25 + spec2 * 0.45);
      finalCol += colCyan * caustic;
      finalCol += colViolet * (slopeMag * 1.8 + fresnel * 0.5);
      finalCol += colDeep * clamp(-totalHeight * 2.5, 0.0, 0.5);

      // Прозрачность: яркие волны четко видны, спокойная вода прозрачна
      float alpha = clamp(
        glint1 * 1.0 +
        spec1 * 0.9 +
        spec2 * 0.4 +
        caustic * 0.8 +
        slopeMag * 2.5 +
        fresnel * 0.4,
        0.0,
        0.96
      );

      // Мягкое сглаживание по краям
      float edgeMask = smoothstep(0.0004, 0.0035, slopeMag + hMag);
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
  const uResolutionLoc = gl.getUniformLocation(program, 'u_resolution');
  const uRipplesLoc    = gl.getUniformLocation(program, 'u_ripples');
  const uCountLoc      = gl.getUniformLocation(program, 'u_count');

  const rippleData = new Float32Array(MAX_RIPPLES * 4);
  const startTime = performance.now();

  function getTimeSec() {
    return (performance.now() - startTime) / 1000.0;
  }

  function addRipple(normX, normY, strength) {
    const t = getTimeSec();
    ripples.push({
      id: ++rippleId,
      x: Math.max(0.0, Math.min(1.0, normX)),
      y: Math.max(0.0, Math.min(1.0, normY)),
      time: t,
      strength: strength || 0.45
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

  let isRunning = false;
  let lastX = -1;
  let lastY = -1;
  let lastSpawnTime = 0;
  let isPointerDown = false;

  function handleInputMove(clientX, clientY, isDown) {
    const now = performance.now();
    const nx = clientX / window.innerWidth;
    const ny = clientY / window.innerHeight;

    if (lastX >= 0 && lastY >= 0) {
      const dx = (nx - lastX) * (window.innerWidth / window.innerHeight);
      const dy = ny - lastY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = Math.max(1, now - lastSpawnTime);
      const speed = Math.min(dist / (dt / 1000), 4.0);

      // Если мышь или палец сдвинулись хотя бы на пару миллиметров
      if (dist > 0.008 || (dist > 0.003 && now - lastSpawnTime > 30)) {
        const steps = Math.min(Math.max(Math.floor(dist / 0.016), 1), 4);
        const baseStrength = isDown ? 0.65 : 0.42;
        const strength = Math.min(baseStrength * (0.8 + speed * 0.35), 0.95);

        for (let i = 1; i <= steps; i++) {
          const ratio = i / steps;
          const ix = lastX + (nx - lastX) * ratio;
          const iy = lastY + (ny - lastY) * ratio;
          addRipple(ix, iy, strength);
        }

        lastX = nx;
        lastY = ny;
        lastSpawnTime = now;
      }
    } else {
      addRipple(nx, ny, isDown ? 0.75 : 0.45);
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
    // Яркий всплеск с несколькими кольцами волн при клике/тапе
    addRipple(nx, ny, 0.85);
    setTimeout(() => addRipple(nx, ny, 0.55), 70);
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

  // Touch Events (надежная поддержка для всех смартфонов и планшетов)
  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      handleInputMove(t.clientX, t.clientY, true);
    }
  }, { passive: true });

  window.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      const nx = t.clientX / window.innerWidth;
      const ny = t.clientY / window.innerHeight;
      lastX = nx;
      lastY = ny;
      lastSpawnTime = performance.now();
      addRipple(nx, ny, 0.85);
      setTimeout(() => addRipple(nx, ny, 0.55), 70);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    lastX = -1;
    lastY = -1;
  }, { passive: true });

  function wakeUp() {
    if (!isRunning) {
      isRunning = true;
      requestAnimationFrame(tick);
    }
  }

  function tick() {
    const curTime = getTimeSec();

    // Очищаем устаревшие волны (> 2.4 сек)
    while (ripples.length > 0 && curTime - ripples[0].time > 2.4) {
      ripples.shift();
    }

    if (ripples.length === 0) {
      isRunning = false;
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // Заполняем массив данных для передачи в шейдер
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
    gl.uniform2f(uResolutionLoc, canvas.width, canvas.height);
    gl.uniform1i(uCountLoc, count);
    gl.uniform4fv(uRipplesLoc, rippleData);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(tick);
  }

  // Приветственные мягкие волны в центре при открытии сайта
  setTimeout(() => {
    addRipple(0.5, 0.45, 0.7);
    setTimeout(() => addRipple(0.5, 0.45, 0.45), 180);
  }, 350);

  wakeUp();

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
        str: str || 0.5
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
    window.addEventListener('resize', resize2D);
    resize2D();

    window.addEventListener('pointermove', (e) => {
      addCircle(e.clientX / window.innerWidth, e.clientY / window.innerHeight, 0.4);
    }, { passive: true });

    window.addEventListener('pointerdown', (e) => {
      addCircle(e.clientX / window.innerWidth, e.clientY / window.innerHeight, 0.8);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        addCircle(e.touches[0].clientX / window.innerWidth, e.touches[0].clientY / window.innerHeight, 0.5);
      }
    }, { passive: true });

    function tick2D() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const now = performance.now();

      while (circles.length > 0 && now - circles[0].born > 2200) {
        circles.shift();
      }

      if (circles.length === 0) {
        isRunning = false;
        return;
      }

      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        const age = (now - c.born) / 1000;
        const radius = age * 180;
        const alpha = Math.max(0, (1 - age / 2.2) * c.str);

        ctx.save();
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.75})`;
        ctx.lineWidth = 3.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(0, radius - 14), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(168, 85, 247, ${alpha * 0.55})`;
        ctx.lineWidth = 2.0;
        ctx.stroke();
        ctx.restore();
      }

      requestAnimationFrame(tick2D);
    }

    addCircle(0.5, 0.45, 0.7);
  }
})();
