/**
 * ============================================================================
 * ShinyVisuals — Interactive Water Surface & Fluid Ripple Shader
 * Реалистичная 2D симуляция волн на поверхности воды при движении пальца / мыши
 * Высокопроизводительный WebGL шейдер с физикой волнового уравнения и бликами
 * ============================================================================
 */

(function () {
  'use strict';

  if (window.__shinyWaterRippleInit) return;
  window.__shinyWaterRippleInit = true;

  const CONFIG = {
    // Разрешение сетки симуляции (256x256 дает 60-120fps даже на смартфонах)
    simRes: 256,
    // Затухание волн (0.988 — плавное распространение кругов и реалистичная вода)
    damping: 0.988,
    // Радиус следа от пальца/мыши (в долях высоты экрана)
    baseRadius: 0.024,
    // Сила возмущения воды при движении
    dragStrength: 0.38,
    // Сила всплеска при клике / тапе
    clickStrength: 0.75,
    // Крутизна нормалей для оптических бликов
    normalScale: 2.6,
    // Спящий режим: через 2.5 сек спокойствия останавливаем цикл для 0% CPU
    sleepDelayMs: 2500
  };

  function initWaterRipple() {
    const canvas = document.createElement('canvas');
    canvas.id = 'shiny-water-canvas';
    canvas.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100vw',
      'height: 100vh',
      'pointer-events: none',
      'z-index: 99999',
      'opacity: 1'
    ].join(';');

    document.body.appendChild(canvas);

    let gl = canvas.getContext('webgl2', { alpha: true, depth: false, antialias: false, premultipliedAlpha: false });
    const isWebGL2 = !!gl;
    if (!gl) {
      gl = canvas.getContext('webgl', { alpha: true, depth: false, antialias: false, premultipliedAlpha: false }) ||
           canvas.getContext('experimental-webgl', { alpha: true, depth: false, antialias: false, premultipliedAlpha: false });
    }

    if (!gl) {
      console.warn('[ShinyVisuals] WebGL not supported, water ripple shader disabled.');
      return;
    }

    // Проверка поддержки float/half-float FBO
    let textureType = gl.UNSIGNED_BYTE;
    let internalFormat = gl.RGBA;
    let format = gl.RGBA;
    let useBytePacking = false;

    function checkFBO(intFmt, fmt, type) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, intFmt, 4, 4, 0, fmt, type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return status === gl.FRAMEBUFFER_COMPLETE;
    }

    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      if (checkFBO(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)) {
        internalFormat = gl.RGBA16F;
        format = gl.RGBA;
        textureType = gl.HALF_FLOAT;
      } else if (checkFBO(gl.RGBA, gl.RGBA, gl.FLOAT)) {
        internalFormat = gl.RGBA;
        format = gl.RGBA;
        textureType = gl.FLOAT;
      } else {
        useBytePacking = true;
      }
    } else {
      const halfFloatExt = gl.getExtension('OES_texture_half_float');
      const floatExt = gl.getExtension('OES_texture_float');
      gl.getExtension('OES_texture_half_float_linear');
      gl.getExtension('OES_texture_float_linear');

      if (halfFloatExt && checkFBO(gl.RGBA, gl.RGBA, halfFloatExt.HALF_FLOAT_OES)) {
        textureType = halfFloatExt.HALF_FLOAT_OES;
      } else if (floatExt && checkFBO(gl.RGBA, gl.RGBA, gl.FLOAT)) {
        textureType = gl.FLOAT;
      } else {
        useBytePacking = true;
      }
    }

    const header = useBytePacking
      ? '#define USE_BYTE_PACKING 1\n'
      : '#define USE_FLOAT 1\n';

    function createShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, header + source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    function createProgram(vertSrc, fragSrc) {
      const vs = createShader(gl.VERTEX_SHADER, vertSrc);
      const fs = createShader(gl.FRAGMENT_SHADER, fragSrc);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(prog));
        return null;
      }
      return prog;
    }

    const vertShaderSrc = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    // 1. Симуляция 2D волнового уравнения
    const simShaderSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      uniform vec2 u_texel;
      uniform float u_damping;

      #ifdef USE_BYTE_PACKING
        float dec(float v) { return (v - 0.5) * 2.0; }
        float enc(float v) { return clamp(v * 0.5 + 0.5, 0.0, 1.0); }
      #else
        float dec(float v) { return v; }
        float enc(float v) { return v; }
      #endif

      void main() {
        float left   = dec(texture2D(u_texture, v_uv - vec2(u_texel.x, 0.0)).r);
        float right  = dec(texture2D(u_texture, v_uv + vec2(u_texel.x, 0.0)).r);
        float up     = dec(texture2D(u_texture, v_uv - vec2(0.0, u_texel.y)).r);
        float down   = dec(texture2D(u_texture, v_uv + vec2(0.0, u_texel.y)).r);

        float current = dec(texture2D(u_texture, v_uv).r);
        float prev    = dec(texture2D(u_texture, v_uv).g);

        // Волновое уравнение: лапласиан сетки
        float next = ((left + right + up + down) * 0.5 - prev) * u_damping;

        gl_FragColor = vec4(enc(next), enc(current), 0.0, 1.0);
      }
    `;

    // 2. Добавление следа пальца/мыши в симуляцию
    const dropShaderSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      uniform vec2 u_center;
      uniform float u_radius;
      uniform float u_strength;
      uniform float u_aspect;

      #ifdef USE_BYTE_PACKING
        float dec(float v) { return (v - 0.5) * 2.0; }
        float enc(float v) { return clamp(v * 0.5 + 0.5, 0.0, 1.0); }
      #else
        float dec(float v) { return v; }
        float enc(float v) { return v; }
      #endif

      void main() {
        vec4 data = texture2D(u_texture, v_uv);
        float h = dec(data.r);

        vec2 diff = v_uv - u_center;
        diff.x *= u_aspect;
        float dist = length(diff);

        if (dist < u_radius) {
          float factor = 1.0 - dist / u_radius;
          factor = factor * factor * (3.0 - 2.0 * factor);
          h += factor * u_strength;
        }

        gl_FragColor = vec4(enc(h), data.g, 0.0, 1.0);
      }
    `;

    // 3. Рендеринг поверхности воды с оптическими бликами и переливами
    const renderShaderSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      uniform vec2 u_texel;
      uniform float u_normalScale;
      uniform float u_aspect;

      #ifdef USE_BYTE_PACKING
        float dec(float v) { return (v - 0.5) * 2.0; }
      #else
        float dec(float v) { return v; }
      #endif

      void main() {
        float left   = dec(texture2D(u_texture, v_uv - vec2(u_texel.x, 0.0)).r);
        float right  = dec(texture2D(u_texture, v_uv + vec2(u_texel.x, 0.0)).r);
        float up     = dec(texture2D(u_texture, v_uv - vec2(0.0, u_texel.y)).r);
        float down   = dec(texture2D(u_texture, v_uv + vec2(0.0, u_texel.y)).r);

        float dX = (right - left) * u_normalScale;
        float dY = (down - up) * u_normalScale;
        float slope = length(vec2(dX, dY));

        if (slope < 0.0008) {
          discard;
        }

        // Мягкая маска затухания к краям волны (без жестких границ)
        float waveMask = smoothstep(0.0008, 0.007, slope);

        // Нормаль к искривленной поверхности воды
        vec3 normal = normalize(vec3(-dX, -dY, 0.15));

        // Направления света (яркий верхне-боковой источник и мягкий контровой)
        vec3 light1 = normalize(vec3(-0.35, 0.65, 0.65));
        vec3 light2 = normalize(vec3(0.55, -0.30, 0.75));
        vec3 viewDir = vec3(0.0, 0.0, 1.0);

        // Specular отражение на гребне волны
        vec3 half1 = normalize(light1 + viewDir);
        float spec1 = pow(max(0.0, dot(normal, half1)), 34.0);
        float glint1 = pow(max(0.0, dot(normal, half1)), 140.0);

        vec3 half2 = normalize(light2 + viewDir);
        float spec2 = pow(max(0.0, dot(normal, half2)), 22.0);

        // Эффект Френеля (отражение под скользящим углом)
        float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);

        // Фирменная палитра ShinyVisuals: неон фиолетовый + лазурный перелив
        vec3 neonViolet  = vec3(0.70, 0.42, 1.0);
        vec3 waterCyan    = vec3(0.30, 0.88, 1.0);
        vec3 brightWhite  = vec3(1.0, 1.0, 1.0);

        vec3 liquidShimmer = mix(neonViolet, waterCyan, normal.x * 0.5 + 0.5);

        vec3 color = vec3(0.0);
        color += brightWhite * (glint1 * 1.55);
        color += liquidShimmer * (spec1 * 1.1 + spec2 * 0.45);
        color += neonViolet * (fresnel * 0.35 + slope * 0.9);
        color *= waveMask;

        float alpha = clamp(glint1 * 1.0 + spec1 * 0.85 + spec2 * 0.35 + fresnel * 0.3 + slope * 1.0, 0.0, 0.9) * waveMask;

        gl_FragColor = vec4(color, alpha);
      }
    `;

    const simProgram = createProgram(vertShaderSrc, simShaderSrc);
    const dropProgram = createProgram(vertShaderSrc, dropShaderSrc);
    const renderProgram = createProgram(vertShaderSrc, renderShaderSrc);

    if (!simProgram || !dropProgram || !renderProgram) {
      console.error('[ShinyVisuals] Failed to build water programs.');
      return;
    }

    const quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]), gl.STATIC_DRAW);

    function setupQuadAttr(prog) {
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    let simWidth = CONFIG.simRes;
    let simHeight = Math.round(CONFIG.simRes * (window.innerHeight / window.innerWidth));
    if (simHeight < 128) simHeight = 128;
    if (simHeight > 512) simHeight = 512;

    function createFBO() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, simWidth, simHeight, 0, format, textureType, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      return { fbo, tex };
    }

    let fboA = createFBO();
    let fboB = createFBO();

    const clearVal = useBytePacking ? 0.5 : 0.0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
    gl.clearColor(clearVal, clearVal, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
    gl.clearColor(clearVal, clearVal, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    function addDrop(x, y, radius, strength) {
      gl.useProgram(dropProgram);
      setupQuadAttr(dropProgram);

      gl.uniform1i(gl.getUniformLocation(dropProgram, 'u_texture'), 0);
      gl.uniform2f(gl.getUniformLocation(dropProgram, 'u_center'), x, y);
      gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_radius'), radius);
      gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_strength'), strength);
      gl.uniform1f(gl.getUniformLocation(dropProgram, 'u_aspect'), window.innerWidth / window.innerHeight);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
      gl.viewport(0, 0, simWidth, simHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const temp = fboA;
      fboA = fboB;
      fboB = temp;

      wakeUp();
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      wakeUp();
    }
    window.addEventListener('resize', resize, { passive: true });
    resize();

    let lastX = -1;
    let lastY = -1;
    let lastTime = 0;
    let isInteracting = false;
    let lastActivityTime = performance.now();
    let isRunning = true;
    let animFrameId = null;

    function handlePointerMove(clientX, clientY, isDown) {
      const now = performance.now();
      lastActivityTime = now;

      const normX = clientX / window.innerWidth;
      const normY = 1.0 - (clientY / window.innerHeight);

      if (lastX >= 0 && lastY >= 0) {
        const dx = normX - lastX;
        const dy = normY - lastY;
        const aspect = window.innerWidth / window.innerHeight;
        const dist = Math.sqrt((dx * aspect) * (dx * aspect) + dy * dy);

        const dt = Math.max(1, now - lastTime);
        const speed = Math.min(dist / dt * 1000, 3.5);

        if (dist > 0.002) {
          // Интерполяция для непрерывного плавного следа воды при быстрых движениях
          const steps = Math.min(Math.max(Math.ceil(dist / (CONFIG.baseRadius * 0.4)), 1), 8);
          const strength = (isDown ? CONFIG.dragStrength * 1.6 : CONFIG.dragStrength) * (0.8 + speed * 0.35);

          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ix = lastX + dx * t;
            const iy = lastY + dy * t;
            addDrop(ix, iy, CONFIG.baseRadius * (0.95 + speed * 0.2), strength / steps);
          }
        }
      } else {
        addDrop(normX, normY, CONFIG.baseRadius, CONFIG.dragStrength);
      }

      lastX = normX;
      lastY = normY;
      lastTime = now;
    }

    // Слушатели указателя (курсор мыши + сенсорный экран смартфона)
    window.addEventListener('pointerdown', (e) => {
      isInteracting = true;
      const normX = e.clientX / window.innerWidth;
      const normY = 1.0 - (e.clientY / window.innerHeight);
      lastX = normX;
      lastY = normY;
      lastTime = performance.now();
      addDrop(normX, normY, CONFIG.baseRadius * 1.8, CONFIG.clickStrength);
    }, { passive: true });

    window.addEventListener('pointermove', (e) => {
      handlePointerMove(e.clientX, e.clientY, isInteracting || e.buttons > 0);
    }, { passive: true });

    window.addEventListener('pointerup', () => {
      isInteracting = false;
      lastX = -1;
      lastY = -1;
    }, { passive: true });

    window.addEventListener('pointercancel', () => {
      isInteracting = false;
      lastX = -1;
      lastY = -1;
    }, { passive: true });

    // Touch events для мобильных браузеров
    window.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        handlePointerMove(touch.clientX, touch.clientY, true);
      }
    }, { passive: true });

    window.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        const normX = touch.clientX / window.innerWidth;
        const normY = 1.0 - (touch.clientY / window.innerHeight);
        lastX = normX;
        lastY = normY;
        lastTime = performance.now();
        addDrop(normX, normY, CONFIG.baseRadius * 1.9, CONFIG.clickStrength);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      lastX = -1;
      lastY = -1;
    }, { passive: true });

    function wakeUp() {
      lastActivityTime = performance.now();
      if (!isRunning) {
        isRunning = true;
        canvas.style.display = 'block';
        tick();
      }
    }

    function tick() {
      const now = performance.now();

      // 1. Шаг симуляции волн
      gl.useProgram(simProgram);
      setupQuadAttr(simProgram);

      gl.uniform1i(gl.getUniformLocation(simProgram, 'u_texture'), 0);
      gl.uniform2f(gl.getUniformLocation(simProgram, 'u_texel'), 1.0 / simWidth, 1.0 / simHeight);
      gl.uniform1f(gl.getUniformLocation(simProgram, 'u_damping'), CONFIG.damping);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
      gl.viewport(0, 0, simWidth, simHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const temp = fboA;
      fboA = fboB;
      fboB = temp;

      // 2. Рендеринг бликов воды на экран
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(renderProgram);
      setupQuadAttr(renderProgram);

      gl.uniform1i(gl.getUniformLocation(renderProgram, 'u_texture'), 0);
      gl.uniform2f(gl.getUniformLocation(renderProgram, 'u_texel'), 1.0 / simWidth, 1.0 / simHeight);
      gl.uniform1f(gl.getUniformLocation(renderProgram, 'u_normalScale'), CONFIG.normalScale);
      gl.uniform1f(gl.getUniformLocation(renderProgram, 'u_aspect'), window.innerWidth / window.innerHeight);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Спящий режим: если волны улеглись и нет активности > 2.5 сек, экономим ресурсы
      if (now - lastActivityTime > CONFIG.sleepDelayMs) {
        isRunning = false;
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      animFrameId = requestAnimationFrame(tick);
    }

    // Мягкий приветственный всплеск в центре при открытии сайта
    setTimeout(() => {
      addDrop(0.5, 0.5, CONFIG.baseRadius * 2.2, 0.55);
    }, 350);

    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWaterRipple);
  } else {
    initWaterRipple();
  }
})();
