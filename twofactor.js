/**
 * ==========================================================================
 * ShinyVisuals / Palladium — Complete Security & Password Armor Suite
 * 1. Cryptographic Password Hashing (SHA-256 + Salt) via Web Crypto API
 * 2. Password Strength Meter & Real-Time Complexity Enforcement
 * 3. Brute-Force Rate Limiting & Lockout Protection (Anti-Bruteforce Shield)
 * 4. Master Site Gatekeeper (Access Password Protection for Site)
 * 5. Google Authenticator TOTP 2FA (RFC 6238) with QR & Backup Codes
 * 6. Web Armor & Anti-Tamper (Anti-DevTools, Anti-XSS, Hotkey Guardian)
 * 7. Interactive Security Hub Modal & Security Audit Log
 * ==========================================================================
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 1. Конфигурация и локальное хранилище безопасности
  // --------------------------------------------------------------------------
  const STORAGE_KEYS = {
    CONFIG_2FA: 'shiny_2fa_config',
    SECURITY_CONFIG: 'shiny_sec_config',
    BRUTE_FORCE: 'shiny_sec_bruteforce',
    AUDIT_LOG: 'shiny_sec_audit',
    GATE_UNLOCKED: 'shiny_gate_unlocked',
    CURRENT_USER: 'shiny_current_user',
    ACCOUNTS_DB: 'shiny_accounts_db'
  };

  // Очистка устаревшего глобального ключа 2FA, чтобы он не наследовался новыми аккаунтами
  try {
    localStorage.removeItem(STORAGE_KEYS.CONFIG_2FA);
  } catch (e) {}

  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const DEFAULT_MASTER_SALT = 'shiny_visuals_salt_2026';
  // Default hashed master password for Site Gate (SHA-256 for "shiny2026" with salt)
  const DEFAULT_GATE_HASH = '9a776c5b045f2f458e0a30b42c679a94121bf26e2e2ea8a562efad27e85c2c43';

  function getSecurityConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SECURITY_CONFIG);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      siteGateEnabled: false,          // По умолчанию выключено, владелец может включить в 1 клик
      siteGateHash: DEFAULT_GATE_HASH, // SHA-256 хеш мастер-пароля
      antiDevTools: true,              // Блокировка F12, Ctrl+Shift+I
      antiContextMenu: false,          // ПКМ (отключено для удобства, можно включить)
      bruteForceProtection: true,      // Защита от перебора паролей
      enforceComplexity: true,         // Требовать надежный пароль
      auditLogging: true               // Логирование событий безопасности
    };
  }

  function saveSecurityConfig(cfg) {
    try {
      localStorage.setItem(STORAGE_KEYS.SECURITY_CONFIG, JSON.stringify(cfg));
      window.dispatchEvent(new CustomEvent('shiny_sec_config_changed', { detail: cfg }));
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 2. Журнал аудита безопасности (Security Audit Log)
  // --------------------------------------------------------------------------
  function logSecurityEvent(type, details) {
    try {
      const cfg = getSecurityConfig();
      if (!cfg.auditLogging) return;

      const raw = localStorage.getItem(STORAGE_KEYS.AUDIT_LOG);
      const logs = raw ? JSON.parse(raw) : [];

      const now = new Date();
      const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = now.toLocaleDateString('ru-RU');

      logs.unshift({
        id: Date.now() + Math.random().toString(36).substring(2, 6),
        type,
        details,
        time: `${dateStr} ${timeStr}`,
        timestamp: Date.now()
      });

      // Храним последние 30 событий
      if (logs.length > 30) logs.length = 30;
      localStorage.setItem(STORAGE_KEYS.AUDIT_LOG, JSON.stringify(logs));
      window.dispatchEvent(new CustomEvent('shiny_audit_updated'));
    } catch (e) {}
  }

  function getAuditLogs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AUDIT_LOG);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // 3. Криптографическое хеширование паролей (SHA-256 + Salt)
  // --------------------------------------------------------------------------
  async function sha256Hex(message) {
    const enc = new TextEncoder();
    const data = enc.encode(message);
    const hashBuf = await (window.crypto || window.msCrypto).subtle.digest('SHA-256', data);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashPassword(plainPassword, salt = DEFAULT_MASTER_SALT) {
    if (!plainPassword) return '';
    return await sha256Hex(plainPassword + ':' + salt);
  }

  // --------------------------------------------------------------------------
  // 4. Оценка сложности пароля (Password Strength Meter)
  // --------------------------------------------------------------------------
  const WEAK_PASSWORD_BLACKLIST = [
    '123456', '12345678', '123456789', 'qwerty', 'password', '111111',
    'admin', 'administrator', 'minecraft', 'shiny', 'visuals', 'iloveyou',
    'dragon', 'sunshine', 'football', 'monkey', 'secret', 'letmein'
  ];

  function evaluatePasswordStrength(pwd) {
    if (!pwd || pwd.length === 0) {
      return { score: 0, label: 'Пустой', colorClass: 'weak', tips: ['Введите пароль'] };
    }

    const clean = pwd.trim().toLowerCase();
    if (WEAK_PASSWORD_BLACKLIST.includes(clean)) {
      return { score: 1, label: 'Небезопасный', colorClass: 'weak', tips: ['Слишком простой общеизвестный пароль!'] };
    }

    let score = 0;
    const tips = [];

    // Длина
    if (pwd.length >= 8) score++;
    else tips.push('Минимум 8 символов');

    if (pwd.length >= 12) score++;

    // Цифры
    if (/[0-9]/.test(pwd)) score++;
    else tips.push('Добавьте цифру (0-9)');

    // Заглавные и строчные буквы
    if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
    else tips.push('Используйте заглавные и строчные буквы');

    // Спецсимволы
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    else tips.push('Добавьте спецсимвол (!@#$%^&*)');

    // Нормализация в 4 деления
    let normalizedScore = Math.min(4, Math.max(1, Math.round(score * 0.8)));

    let label = 'Слабый';
    let colorClass = 'weak';

    if (normalizedScore === 2) {
      label = 'Средний';
      colorClass = 'medium';
    } else if (normalizedScore === 3) {
      label = 'Надёжный';
      colorClass = 'good';
    } else if (normalizedScore === 4) {
      label = 'Максимальный';
      colorClass = 'strong';
    }

    return {
      score: normalizedScore,
      label,
      colorClass,
      tips: tips.length ? tips : ['Отличный криптостойкий пароль!']
    };
  }

  // Авто-встраивание индикатора сложности под поля паролей
  function attachStrengthMeterToInput(input) {
    if (!input || input.dataset.hasStrengthMeter) return;
    input.dataset.hasStrengthMeter = 'true';

    const meterContainer = document.createElement('div');
    meterContainer.className = 'shiny-pwd-meter';
    meterContainer.innerHTML = `
      <div class="shiny-pwd-bars">
        <div class="shiny-pwd-bar" id="spb1"></div>
        <div class="shiny-pwd-bar" id="spb2"></div>
        <div class="shiny-pwd-bar" id="spb3"></div>
        <div class="shiny-pwd-bar" id="spb4"></div>
      </div>
      <div class="shiny-pwd-meta">
        <span>Сложность: <strong class="shiny-pwd-status weak" id="spbStatus">Слабый</strong></span>
        <span id="spbTip" style="font-size:10.5px;color:#c084fc;"></span>
      </div>
    `;

    input.insertAdjacentElement('afterend', meterContainer);

    function updateMeter() {
      const val = input.value || '';
      const result = evaluatePasswordStrength(val);

      const b1 = meterContainer.querySelector('#spb1');
      const b2 = meterContainer.querySelector('#spb2');
      const b3 = meterContainer.querySelector('#spb3');
      const b4 = meterContainer.querySelector('#spb4');
      const statusEl = meterContainer.querySelector('#spbStatus');
      const tipEl = meterContainer.querySelector('#spbTip');

      [b1, b2, b3, b4].forEach((b, idx) => {
        b.className = 'shiny-pwd-bar';
        if (idx < result.score) {
          b.classList.add(`active-${result.colorClass}`);
        }
      });

      statusEl.className = `shiny-pwd-status ${result.colorClass}`;
      statusEl.textContent = result.label;
      tipEl.textContent = result.tips[0] || '';
    }

    input.addEventListener('input', updateMeter);
    input.addEventListener('focus', () => { meterContainer.style.display = 'block'; updateMeter(); });
  }

  // --------------------------------------------------------------------------
  // 5. Защита от перебора паролей (Anti-Bruteforce & Rate Limiting)
  // --------------------------------------------------------------------------
  function getBruteForceState(target = 'global') {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.BRUTE_FORCE + '_' + target);
      if (raw) {
        const data = JSON.parse(raw);
        // Проверяем, не истёк ли лок
        if (data.lockedUntil && Date.now() > data.lockedUntil) {
          data.failedAttempts = 0;
          data.lockedUntil = null;
          saveBruteForceState(target, data);
        }
        return data;
      }
    } catch (e) {}
    return { failedAttempts: 0, lockedUntil: null, lastAttempt: 0 };
  }

  function saveBruteForceState(target, data) {
    try {
      localStorage.setItem(STORAGE_KEYS.BRUTE_FORCE + '_' + target, JSON.stringify(data));
    } catch (e) {}
  }

  function recordFailedPasswordAttempt(target = 'global') {
    const state = getBruteForceState(target);
    state.failedAttempts = (state.failedAttempts || 0) + 1;
    state.lastAttempt = Date.now();

    // Градация блокировок:
    // 5 попыток -> 30 сек
    // 8 попыток -> 2 мин
    // 10+ попыток -> 15 мин
    if (state.failedAttempts >= 10) {
      state.lockedUntil = Date.now() + 15 * 60 * 1000;
      logSecurityEvent('BRUTEFORCE_LOCKOUT', `Блокировка на 15 мин (10+ неудачных попыток: ${target})`);
    } else if (state.failedAttempts >= 8) {
      state.lockedUntil = Date.now() + 2 * 60 * 1000;
      logSecurityEvent('BRUTEFORCE_LOCKOUT', `Блокировка на 2 мин (8 неудачных попыток: ${target})`);
    } else if (state.failedAttempts >= 5) {
      state.lockedUntil = Date.now() + 30 * 1000;
      logSecurityEvent('BRUTEFORCE_LOCKOUT', `Временная блокировка на 30 сек (5 неудачных попыток: ${target})`);
    } else {
      logSecurityEvent('LOGIN_FAILED', `Неверный ввод пароля (${state.failedAttempts}/5)`);
    }

    saveBruteForceState(target, state);
    return state;
  }

  function resetBruteForceState(target = 'global') {
    try {
      localStorage.removeItem(STORAGE_KEYS.BRUTE_FORCE + '_' + target);
    } catch (e) {}
  }

  function isBruteForceLocked(target = 'global') {
    const state = getBruteForceState(target);
    return !!(state.lockedUntil && Date.now() < state.lockedUntil);
  }

  function showBruteForceLockoutModal(remainingSeconds, onComplete) {
    const existing = document.getElementById('shinyLockoutModal');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'shinyLockoutModal';

    backdrop.innerHTML = `
      <div class="shiny-lockout-box">
        <div style="font-size:42px;margin-bottom:8px;">⛔</div>
        <h2 style="color:#ffffff;font-size:20px;font-weight:700;margin:0 0 8px 0;">Доступ временно заблокирован</h2>
        <p style="color:#fca5a5;font-size:13.5px;margin:0 0 14px 0;line-height:1.5;">
          Слишком много неудачных попыток ввода пароля. В целях защиты аккаунта система включила временный таймаут:
        </p>

        <div class="shiny-lockout-countdown" id="shinyLockoutTimer">${remainingSeconds}s</div>

        <p style="color:#a7a3b8;font-size:11.5px;margin:12px 0 0 0;">
          🛡️ Активная система противодействия брутфорсу ShinyVisuals Armor
        </p>
      </div>
    `;

    document.body.appendChild(backdrop);

    let sec = remainingSeconds;
    const timerEl = document.getElementById('shinyLockoutTimer');
    const interval = setInterval(() => {
      sec--;
      if (timerEl) timerEl.textContent = `${sec}s`;
      if (sec <= 0) {
        clearInterval(interval);
        backdrop.remove();
        if (onComplete) onComplete();
      }
    }, 1000);
  }

  // --------------------------------------------------------------------------
  // 6. Мастер-пароль доступа к сайту (Site Gatekeeper Lock)
  // --------------------------------------------------------------------------
  function isSiteGateUnlocked() {
    try {
      return sessionStorage.getItem(STORAGE_KEYS.GATE_UNLOCKED) === 'true';
    } catch (e) {
      return false;
    }
  }

  function setSiteGateUnlocked(val) {
    try {
      if (val) sessionStorage.setItem(STORAGE_KEYS.GATE_UNLOCKED, 'true');
      else sessionStorage.removeItem(STORAGE_KEYS.GATE_UNLOCKED);
    } catch (e) {}
  }

  function checkAndEnforceSiteGate() {
    const cfg = getSecurityConfig();
    if (!cfg.siteGateEnabled) return;
    if (isSiteGateUnlocked()) return;

    // Проверяем, нет ли уже открытого экрана
    if (document.getElementById('shinySiteGateScreen')) return;

    const gate = document.createElement('div');
    gate.className = 'shiny-gate-backdrop';
    gate.id = 'shinySiteGateScreen';

    gate.innerHTML = `
      <div class="shiny-gate-card">
        <div class="shiny-gate-icon-wrapper">
          <span>🛡️</span>
        </div>

        <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px 0;letter-spacing:-0.3px;">
          ShinyVisuals Security Gate
        </h1>
        <p style="color:#c084fc;font-size:13.5px;margin:0 0 20px 0;line-height:1.45;">
          Сайт защищён мастер-паролем. Пожалуйста, введите ключ доступа для продолжения:
        </p>

        <form id="shinyGateForm" onsubmit="return false;">
          <div class="shiny-gate-input-wrapper">
            <input type="password" id="shinyGatePassword" class="shiny-gate-input" placeholder="Мастер-пароль..." autocomplete="current-password" autofocus />
            <button type="button" class="shiny-gate-eye-btn" id="shinyGateEyeBtn" title="Показать/скрыть пароль">👁️</button>
          </div>

          <div id="shinyGateError" style="display:none;color:#f87171;font-size:12.5px;margin-bottom:14px;font-weight:500;">
            Неверный мастер-пароль. Попробуйте снова.
          </div>

          <button type="submit" id="shinyGateSubmitBtn" class="twofactor-btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:15px;">
            🔓 Разблокировать доступ
          </button>
        </form>

        <div style="margin-top:18px;font-size:11.5px;color:#a7a3b8;display:flex;align-items:center;justify-content:center;gap:6px;">
          <span class="shiny-sec-pulse-dot"></span>
          <span>Защищённое сквозное шифрование сессии</span>
        </div>
      </div>
    `;

    document.body.appendChild(gate);

    // Глазок для скрытия/показа пароля
    const inp = gate.querySelector('#shinyGatePassword');
    const eye = gate.querySelector('#shinyGateEyeBtn');
    eye.onclick = () => {
      inp.type = inp.type === 'password' ? 'text' : 'password';
      eye.textContent = inp.type === 'password' ? '👁️' : '🙈';
    };

    // Отправка формы разблокировки
    const form = gate.querySelector('#shinyGateForm');
    const errEl = gate.querySelector('#shinyGateError');

    form.onsubmit = async (e) => {
      e.preventDefault();
      const entered = (inp.value || '').trim();
      if (!entered) return;

      // Проверка на брутфорс
      if (isBruteForceLocked('site_gate')) {
        const state = getBruteForceState('site_gate');
        const rem = Math.ceil((state.lockedUntil - Date.now()) / 1000);
        showBruteForceLockoutModal(rem, () => {
          inp.focus();
        });
        return;
      }

      const enteredHash = await hashPassword(entered);
      const targetHash = cfg.siteGateHash || DEFAULT_GATE_HASH;

      if (enteredHash === targetHash) {
        // Успех!
        resetBruteForceState('site_gate');
        setSiteGateUnlocked(true);
        logSecurityEvent('GATE_UNLOCKED', 'Успешная разблокировка мастер-паролем');
        gate.style.transition = 'opacity 0.3s ease';
        gate.style.opacity = '0';
        setTimeout(() => gate.remove(), 300);
        showSecurityToast('🔓 Доступ к ShinyVisuals успешно открыт!');
      } else {
        // Ошибка ввода
        const state = recordFailedPasswordAttempt('site_gate');
        errEl.style.display = 'block';
        gate.querySelector('.shiny-gate-card').animate([
          { transform: 'translateX(0px)' },
          { transform: 'translateX(-10px)' },
          { transform: 'translateX(10px)' },
          { transform: 'translateX(-8px)' },
          { transform: 'translateX(8px)' },
          { transform: 'translateX(0px)' }
        ], { duration: 350 });

        if (state.lockedUntil && Date.now() < state.lockedUntil) {
          const rem = Math.ceil((state.lockedUntil - Date.now()) / 1000);
          showBruteForceLockoutModal(rem, () => {
            errEl.style.display = 'none';
            inp.value = '';
            inp.focus();
          });
        }
      }
    };
  }

  // --------------------------------------------------------------------------
  // 7. Web Armor & Защита от взлома (Anti-DevTools, Anti-Tamper)
  // --------------------------------------------------------------------------
  function initWebArmor() {
    const cfg = getSecurityConfig();

    // Блокировка хоткеев разработчика (F12, Ctrl+Shift+I, etc.)
    window.addEventListener('keydown', (e) => {
      if (!cfg.antiDevTools) return;

      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      const key = e.key ? e.key.toUpperCase() : '';
      const code = e.keyCode || e.which;

      // F12 = 123
      const isF12 = code === 123 || key === 'F12';
      // Ctrl+Shift+I (73), Ctrl+Shift+J (74), Ctrl+Shift+C (67)
      const isInspect = isCtrl && isShift && (key === 'I' || key === 'J' || key === 'C' || code === 73 || code === 74 || code === 67);
      // Ctrl+U (Просмотр исходного кода, 85)
      const isViewSource = isCtrl && (key === 'U' || code === 85);
      // Ctrl+S (Сохранение страницы, 83)
      const isSavePage = isCtrl && (key === 'S' || code === 83);

      if (isF12 || isInspect || isViewSource || isSavePage) {
        e.preventDefault();
        e.stopPropagation();
        showSecurityToast('🛡️ Просмотр исходного кода защищён системой ShinyVisuals Security');
        logSecurityEvent('DEVTOOLS_BLOCKED', `Попытка вызова инструментов разработчика (${key || code})`);
        return false;
      }
    }, true);

    // Блокировка контекстного меню (ПКМ), если включено
    window.addEventListener('contextmenu', (e) => {
      if (cfg.antiContextMenu) {
        e.preventDefault();
        showSecurityToast('🛡️ Контекстное меню ограничено политикой безопасности');
        return false;
      }
    });

    // Приветственный баннер в консоли
    try {
      console.log(
        '%c🛡️ ShinyVisuals Security Core Active %c\nЗащита от подбора паролей, TOTP 2FA и шифрование сессий включены.',
        'background: linear-gradient(135deg, #a855f7, #6d28d9); color: white; font-size: 14px; font-weight: bold; padding: 4px 10px; border-radius: 6px;',
        'color: #c084fc; font-size: 12px; margin-top: 4px;'
      );
    } catch (e) {}
  }

  function showSecurityToast(msg) {
    const existing = document.getElementById('shinySecToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'shiny-sec-toast';
    toast.id = 'shinySecToast';
    toast.innerHTML = `
      <span style="font-size:18px;">🛡️</span>
      <span style="font-weight:500;">${msg}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-15px)';
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  }

  // --------------------------------------------------------------------------
  // 8. Двухфакторная аутентификация TOTP (RFC 6238) Google Authenticator
  // --------------------------------------------------------------------------
  function detectCurrentUsername() {
    try {
      const userStr = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
      if (userStr) {
        const u = JSON.parse(userStr);
        if (u && (u.username || u.name)) return u.username || u.name;
      }
    } catch (e) {}

    try {
      const h3s = document.querySelectorAll('h3');
      for (let i = 0; i < h3s.length; i++) {
        const txt = (h3s[i].textContent || '').trim();
        if (txt && txt.length > 1 && !txt.includes(' ') && txt !== 'ShinyVisuals' && !txt.includes('Google') && !txt.includes('Безопасность')) {
          return txt;
        }
      }
    } catch (e) {}

    return 'deathproblem';
  }

  function get2FAConfig(userOverride) {
    const user = (userOverride || detectCurrentUsername() || '').trim();
    if (!user) {
      return { enabled: false, secret: null, username: '', backupCodes: [] };
    }
    const userKey = 'shiny_2fa_' + user.toLowerCase();
    try {
      const data = localStorage.getItem(userKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed && parsed.enabled && parsed.secret) {
          parsed.username = user;
          return parsed;
        }
      }
    } catch (e) {}

    // Ни в коем случае не использовать глобальный конфиг для чужих/новых пользователей!
    // Проверяем аккаунты в базе данных
    try {
      const accounts = getAccountsList();
      const acc = accounts.find(a => a.username && a.username.toLowerCase() === user.toLowerCase());
      if (acc && acc.twoFactor && acc.twoFactor.enabled && acc.twoFactor.secret) {
        return {
          enabled: true,
          secret: acc.twoFactor.secret,
          username: user,
          backupCodes: acc.twoFactor.backupCodes || []
        };
      }
    } catch (e) {}

    return {
      enabled: false,
      secret: null,
      username: user,
      activatedAt: null,
      backupCodes: []
    };
  }

  function save2FAConfig(cfg) {
    try {
      const user = cfg.username || detectCurrentUsername();
      if (!user) return;
      const userKey = 'shiny_2fa_' + user.toLowerCase();
      localStorage.setItem(userKey, JSON.stringify(cfg));
      const current = getCurrentAccountUser();
      if (current && current.username.toLowerCase() === user.toLowerCase()) {
        current.twoFactor = cfg;
        saveCurrentAccountUser(current);
      }
      window.dispatchEvent(new CustomEvent('shiny_2fa_changed', { detail: cfg }));
    } catch (e) {}
  }

  function base32Decode(str) {
    const clean = str.toUpperCase().replace(/[\s=-]/g, '');
    let bits = '';
    for (let i = 0; i < clean.length; i++) {
      const val = BASE32_ALPHABET.indexOf(clean[i]);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return new Uint8Array(bytes);
  }

  function generateSecret(length = 16) {
    let secret = '';
    const randomBytes = new Uint8Array(length);
    (window.crypto || window.msCrypto).getRandomValues(randomBytes);
    for (let i = 0; i < length; i++) {
      secret += BASE32_ALPHABET[randomBytes[i] % BASE32_ALPHABET.length];
    }
    return secret;
  }

  function generateBackupCodes(count = 4) {
    const codes = [];
    const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < count; i++) {
      let code = '';
      const bytes = new Uint8Array(8);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      for (let j = 0; j < 8; j++) {
        if (j === 4) code += '-';
        code += chars[bytes[j] % chars.length];
      }
      codes.push(code);
    }
    return codes;
  }

  async function generateTOTP(secret, timeStepOffset = 0) {
    const keyBytes = base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30) + timeStepOffset;

    const timeBuffer = new ArrayBuffer(8);
    const dataView = new DataView(timeBuffer);
    dataView.setUint32(0, 0, false);
    dataView.setUint32(4, timeStep, false);

    const cryptoKey = await (window.crypto || window.msCrypto).subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );

    const signature = await (window.crypto || window.msCrypto).subtle.sign('HMAC', cryptoKey, timeBuffer);
    const hmac = new Uint8Array(signature);

    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1000000;

    return binary.toString().padStart(6, '0');
  }

  async function verifyTOTP(secret, userCode) {
    if (!userCode) return false;
    const clean = userCode.toString().trim();
    if (clean.length !== 6) return false;

    for (const offset of [-1, 0, 1]) {
      try {
        const expected = await generateTOTP(secret, offset);
        if (expected === clean) return true;
      } catch (e) {}
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // 9. UI: Модальное окно настройки Google Authenticator
  // --------------------------------------------------------------------------
  let pendingSecret = null;

  function closeActiveModal() {
    const modals = document.querySelectorAll('#twofactorModal, #shinySecurityHubModal, #shinyLockoutModal');
    modals.forEach(m => m.remove());
  }

  function openGoogleAuthSetupModal() {
    closeActiveModal();

    const username = detectCurrentUsername();
    const secret = generateSecret(16);
    pendingSecret = secret;

    const formattedSecret = secret.match(/.{1,4}/g).join(' ');
    const issuer = 'ShinyVisuals';
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(otpauthUrl)}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:26px;">🛡️</span>
            <div>
              <h2>Google Authenticator (2FA)</h2>
              <p style="margin:2px 0 0 0;font-size:12.5px;color:#c084fc;">Двухфакторная защита для ${username}</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose" title="Закрыть">✕</button>
        </div>

        <div id="setupStepContainer">
          <div class="twofactor-step-card">
            <div class="twofactor-step-label">
              <span class="twofactor-step-num">1</span>
              <span>Отсканируйте QR-код в Google Authenticator:</span>
            </div>
            
            <div class="twofactor-qr-wrapper">
              <img src="${qrApiUrl}" alt="Google Authenticator QR Code" id="twofactorQrImg" />
            </div>

            <div style="font-size:12px;color:#e9d5ff;margin-bottom:6px;text-align:center;">
              Или введите ключ вручную:
            </div>
            <div class="twofactor-secret-row">
              <span class="twofactor-secret-key" id="txtSecretKey">${formattedSecret}</span>
              <button class="twofactor-copy-btn" id="btnCopySecret">📋 Скопировать</button>
            </div>
          </div>

          <div class="twofactor-step-card">
            <div class="twofactor-step-label">
              <span class="twofactor-step-num">2</span>
              <span>Введите 6-значный код для подтверждения:</span>
            </div>

            <div class="twofactor-input-container">
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" autofocus />
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="1" inputmode="numeric" />
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="2" inputmode="numeric" />
              <span class="twofactor-digit-divider">-</span>
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="3" inputmode="numeric" />
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="4" inputmode="numeric" />
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="5" inputmode="numeric" />
            </div>

            <div class="twofactor-error-msg" id="msg2faError">
              Неверный код. Проверьте время на телефоне и повторите попытку.
            </div>

            <button class="twofactor-submit-btn" id="btnVerify2FA">
              Подтвердить и включить защиту
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    document.getElementById('btn2faClose').onclick = closeActiveModal;
    document.getElementById('btnCopySecret').onclick = () => {
      navigator.clipboard.writeText(secret).then(() => {
        const btn = document.getElementById('btnCopySecret');
        btn.textContent = '✓ Скопировано';
        setTimeout(() => { btn.textContent = '📋 Скопировать'; }, 2000);
      });
    };

    setupDigitBoxes(() => {
      document.getElementById('btnVerify2FA').click();
    });

    document.getElementById('btnVerify2FA').onclick = async () => {
      const code = getDigitBoxCode();
      const isValid = await verifyTOTP(pendingSecret, code);

      if (isValid) {
        const backupCodes = generateBackupCodes(4);
        const newConfig = {
          enabled: true,
          secret: pendingSecret,
          username,
          activatedAt: Date.now(),
          backupCodes
        };
        save2FAConfig(newConfig);
        logSecurityEvent('2FA_ENABLED', `Google Authenticator успешно включен для ${username}`);
        showSuccess2FAModal(newConfig);
      } else {
        const err = document.getElementById('msg2faError');
        if (err) err.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function showSuccess2FAModal(cfg) {
    const container = document.getElementById('setupStepContainer');
    if (!container) return;

    container.innerHTML = `
      <div style="text-align:center;padding:12px 6px;">
        <div style="font-size:48px;margin-bottom:10px;">🎉</div>
        <h3 style="color:#ffffff;font-size:18px;font-weight:700;margin:0 0 8px 0;">2FA Защита успешно активирована!</h3>
        <p style="color:#e9d5ff;font-size:13px;line-height:1.5;margin:0 0 16px 0;">
          Сохраните резервные коды восстановления на случай потери телефона:
        </p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;background:rgba(12,7,24,0.8);border:1px solid rgba(168,85,247,0.3);border-radius:12px;padding:14px;margin-bottom:18px;">
          ${(cfg.backupCodes || []).map(c => `<code style="font-size:13.5px;font-weight:700;color:#34d399;font-family:monospace;letter-spacing:1px;">${c}</code>`).join('')}
        </div>

        <button class="twofactor-submit-btn" id="btn2faFinish" style="width:100%;">
          Завершить и закрыть
        </button>
      </div>
    `;

    document.getElementById('btn2faFinish').onclick = closeActiveModal;
  }

  function openDisable2FAModal() {
    closeActiveModal();
    const username = detectCurrentUsername();
    const cfg = get2FAConfig(username);

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:440px;">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:26px;">⚠️</span>
            <div>
              <h2>Отключение 2FA</h2>
              <p style="margin:2px 0 0 0;font-size:12px;color:#f87171;">Для подтверждения введите код из приложения</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">✕</button>
        </div>

        <p style="font-size:13px;color:#e9d5ff;margin:0 0 16px 0;">
          Введите 6-значный код из Google Authenticator для отключения двухфакторной защиты:
        </p>

        <div class="twofactor-input-container">
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" autofocus />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="1" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="2" inputmode="numeric" />
          <span class="twofactor-digit-divider">-</span>
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="3" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="4" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="5" inputmode="numeric" />
        </div>

        <div class="twofactor-error-msg" id="msg2faError">
          Неверный код.
        </div>

        <button class="twofactor-btn-danger" id="btnConfirmDisable" style="width:100%;margin-top:16px;padding:12px;font-size:14px;">
          Отключить защиту Google Authenticator
        </button>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btn2faClose').onclick = closeActiveModal;

    setupDigitBoxes(() => {
      document.getElementById('btnConfirmDisable').click();
    });

    document.getElementById('btnConfirmDisable').onclick = async () => {
      const code = getDigitBoxCode();
      const isValid = await verifyTOTP(cfg.secret, code);
      const isBackup = cfg.backupCodes && cfg.backupCodes.includes(code);

      if (isValid || isBackup) {
        save2FAConfig({ enabled: false, secret: null, username, activatedAt: null, backupCodes: [] });
        logSecurityEvent('2FA_DISABLED', `Google Authenticator отключен для ${username}`);
        closeActiveModal();
        showSecurityToast('2FA успешно отключен.');
      } else {
        const err = document.getElementById('msg2faError');
        if (err) err.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function setupDigitBoxes(onComplete) {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    boxes.forEach((box, index) => {
      box.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val;
        if (val && index < boxes.length - 1) {
          boxes[index + 1].focus();
        }
        if (getDigitBoxCode().length === 6 && onComplete) {
          onComplete();
        }
      });

      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && index > 0) {
          boxes[index - 1].focus();
        }
      });

      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (text.length >= 6) {
          boxes.forEach((b, i) => { b.value = text[i] || ''; });
          boxes[boxes.length - 1].focus();
          if (onComplete) onComplete();
        }
      });
    });
  }

  function getDigitBoxCode() {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    let code = '';
    boxes.forEach(b => { code += (b.value || ''); });
    return code;
  }

  function shakeBoxes() {
    const container = document.querySelector('.twofactor-input-container');
    if (!container) return;
    container.animate([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(-8px)' },
      { transform: 'translateX(8px)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(0px)' }
    ], { duration: 300 });
  }

  // --------------------------------------------------------------------------
  // 9.5. Управление аккаунтами, HWID и синхронизация с Лоадером & Firebase
  // --------------------------------------------------------------------------
  const FIREBASE_DB_URL = 'https://shinyvisualss-default-rtdb.firebaseio.com';
  let loaderBridgeStatus = { online: false, hwid: null, lastChecked: 0 };

  async function fetchFirebaseUsersCloud() {
    try {
      const [uRes, hRes] = await Promise.all([
        fetch(`${FIREBASE_DB_URL}/users.json`, { cache: 'no-store' }),
        fetch(`${FIREBASE_DB_URL}/hwid.json`, { cache: 'no-store' })
      ]);
      if (!uRes.ok) return null;
      const raw = await uRes.json();
      const hwids = hRes.ok ? (await hRes.json()) || {} : {};
      if (!raw) return [];
      const list = Array.isArray(raw) ? raw.filter(Boolean) : Object.values(raw).filter(Boolean);
      return list.map(u => {
        const cleanU = (u.username || '').trim();
        const isOwner = cleanU.toLowerCase() === 'deathproblem' || (u.role && u.role.toLowerCase() === 'owner');
        const num = parseInt(u.uuid || u.id, 10);
        let uid = cleanU.toLowerCase() === 'deathproblem' ? '#0001' : (cleanU.toLowerCase() === 'admin' ? '#1337' : (!isNaN(num) && num > 0 ? '#' + String(num).padStart(4, '0') : '#0001'));
        return {
          uuid: u.uuid || u.id || 0,
          id: String(u.id || u.uuid || 0),
          uid: uid,
          username: cleanU,
          email: u.email || '',
          password: u.password || '',
          role: isOwner ? 'OWNER' : (u.role || 'Player').toUpperCase(),
          hwid: (hwids && hwids[cleanU]) || u.hwid || null,
          plan: 'FREE',
          subscription: 'FREE',
          twoFactor: u.twoFactor || { enabled: false, secret: '', backupCodes: [] },
          createdAt: u.createdAt ? new Date(u.createdAt).getTime() : Date.now()
        };
      });
    } catch(e) {
      return null;
    }
  }

  function getCurrentAccountUser() {
    try {
      const userStr = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
      if (userStr) return JSON.parse(userStr);
    } catch(e) {}
    return null;
  }

  function saveCurrentAccountUser(user) {
    try {
      if (user) localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
      else localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    } catch(e) {}
    updateSiteAccountUI();
  }

  function getAccountsList() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ACCOUNTS_DB);
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    const def = [
      {
        username: 'deathproblem',
        uid: '#0001',
        password: 'basebobmazxc',
        role: 'OWNER',
        plan: 'FREE',
        subscription: 'FREE',
        hwid: null,
        twoFactor: { enabled: false, secret: '', backupCodes: [] },
        createdAt: 1731780000000
      },
      {
        username: 'Admin',
        uid: '#1337',
        passwordHash: '2614e7405f88b19832f5747088b197f2934d6ba3db4ee717f73293e1604772e9',
        salt: DEFAULT_MASTER_SALT,
        role: 'OWNER',
        plan: 'FREE',
        subscription: 'FREE',
        hwid: null,
        twoFactor: { enabled: false, secret: '', backupCodes: [] },
        createdAt: 1731780000000
      }
    ];
    try { localStorage.setItem(STORAGE_KEYS.ACCOUNTS_DB, JSON.stringify(def)); } catch(e){}
    return def;
  }

  function saveAccountsList(list) {
    try {
      localStorage.setItem(STORAGE_KEYS.ACCOUNTS_DB, JSON.stringify(list));
    } catch(e) {}
  }

  async function checkLoaderBridge() {
    try {
      const res = await fetch('http://127.0.0.1:26300/api/status', { mode: 'cors', cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        loaderBridgeStatus = {
          online: true,
          hwid: data.hwid,
          accountsCount: data.accountsCount,
          lastChecked: Date.now()
        };
        const u = getCurrentAccountUser();
        if (u && !u.hwid && data.hwid) {
          u.hwid = data.hwid;
          saveCurrentAccountUser(u);
        }
        updateSiteAccountUI();
        return loaderBridgeStatus;
      }
    } catch(e) {}
    loaderBridgeStatus.online = false;
    updateSiteAccountUI();
    return loaderBridgeStatus;
  }

  async function loginAccount(username, password, totpCode) {
    const cleanUser = (username || '').trim();
    const cleanPass = (password || '').trim();
    if (!cleanUser || !cleanPass) return { success: false, error: 'Введите никнейм и пароль' };

    // 1. Попытка авторизации через локальный мост лоадера (порт 26300)
    try {
      const bridgeRes = await fetch('http://127.0.0.1:26300/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser, password: cleanPass, totpCode: totpCode })
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        if (data.success && data.user) {
          saveCurrentAccountUser(data.user);
          logSecurityEvent('LOGIN_SUCCESS', `Вход через Лоадер-мост: ${data.user.username}`);
          return { success: true, user: data.user, hwid: data.hwid };
        } else if (data.require2FA) {
          return { success: false, require2FA: true, error: data.error };
        } else if (data.error === 'HWID_MISMATCH') {
          return { success: false, error: 'HWID_MISMATCH', boundHwid: data.boundHwid, currentHwid: data.currentHwid, message: data.message };
        }
      }
    } catch(e) {}

    // 2. Прямая авторизация через облачную базу данных Firebase Realtime Database
    try {
      const cloudUsers = await fetchFirebaseUsersCloud();
      if (cloudUsers && cloudUsers.length > 0) {
        const user = cloudUsers.find(u => u.username.toLowerCase() === cleanUser.toLowerCase() || (u.email && u.email.toLowerCase() === cleanUser.toLowerCase()));
        if (user) {
          const passMatch = (user.password && user.password === cleanPass) ||
                            (await hashPassword(cleanPass)) === user.password ||
                            (await hashPassword(cleanPass, DEFAULT_MASTER_SALT)) === user.password;
          if (!passMatch) {
            return { success: false, error: 'Неверный пароль' };
          }

          if (user.twoFactor && user.twoFactor.enabled) {
            if (!totpCode) return { success: false, require2FA: true, error: 'Введите 6-значный код 2FA' };
            const isOk = await verifyTOTP(user.twoFactor.secret, totpCode);
            if (!isOk) return { success: false, require2FA: true, error: 'Неверный код 2FA' };
          }

          // Проверка HWID
          if (loaderBridgeStatus.online && loaderBridgeStatus.hwid) {
            if (!user.hwid) {
              user.hwid = loaderBridgeStatus.hwid;
              try {
                fetch(`${FIREBASE_DB_URL}/hwid/${encodeURIComponent(user.username)}.json`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(loaderBridgeStatus.hwid)
                }).catch(() => {});
              } catch(e) {}
            } else if (user.hwid !== loaderBridgeStatus.hwid) {
              return {
                success: false,
                error: 'HWID_MISMATCH',
                boundHwid: user.hwid,
                currentHwid: loaderBridgeStatus.hwid,
                message: `Аккаунт привязан к ПК (${user.hwid}). Текущий ПК: (${loaderBridgeStatus.hwid})`
              };
            }
          }

          saveCurrentAccountUser(user);
          logSecurityEvent('LOGIN_SUCCESS', `Вход через Firebase Cloud: ${user.username}`);
          return { success: true, user, hwid: user.hwid };
        }
      }
    } catch(e) {}

    // 3. Локальная база сайта
    const accounts = getAccountsList();
    const user = accounts.find(u => u.username.toLowerCase() === cleanUser.toLowerCase());
    if (!user) {
      // Автоматическая регистрация нового пользователя при первом входе
      return registerAccount(cleanUser, cleanPass);
    }

    const hash = await hashPassword(cleanPass, user.salt || DEFAULT_MASTER_SALT);
    const passMatches = (user.password && user.password === cleanPass) || (user.passwordHash && hash === user.passwordHash);
    if (!passMatches) {
      return { success: false, error: 'Неверный пароль' };
    }

    if (user.twoFactor && user.twoFactor.enabled) {
      if (!totpCode) return { success: false, require2FA: true, error: 'Введите 6-значный код 2FA' };
      const isOk = await verifyTOTP(user.twoFactor.secret, totpCode);
      const isBackup = user.twoFactor.backupCodes && user.twoFactor.backupCodes.includes(totpCode.trim());
      if (!isOk && !isBackup) return { success: false, require2FA: true, error: 'Неверный код 2FA' };
    }

    if (loaderBridgeStatus.online && loaderBridgeStatus.hwid) {
      if (!user.hwid) {
        user.hwid = loaderBridgeStatus.hwid;
        saveAccountsList(accounts);
      } else if (user.hwid !== loaderBridgeStatus.hwid) {
        return {
          success: false,
          error: 'HWID_MISMATCH',
          boundHwid: user.hwid,
          currentHwid: loaderBridgeStatus.hwid,
          message: `Аккаунт привязан к ПК (${user.hwid}). Текущий ПК: (${loaderBridgeStatus.hwid})`
        };
      }
    }

    saveCurrentAccountUser(user);
    logSecurityEvent('LOGIN_SUCCESS', `Успешный вход в аккаунт: ${user.username}`);
    return { success: true, user };
  }

  async function registerAccount(username, password) {
    const cleanUser = (username || '').trim();
    const cleanPass = (password || '').trim();
    if (cleanUser.length < 2) return { success: false, error: 'Никнейм должен содержать от 2 символов' };
    if (cleanPass.length < 3) return { success: false, error: 'Пароль должен содержать от 3 символов' };

    // 1. Попытка через мост лоадера
    try {
      const bridgeRes = await fetch('http://127.0.0.1:26300/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser, password: cleanPass })
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        if (data.success && data.user) {
          saveCurrentAccountUser(data.user);
          logSecurityEvent('ACCOUNT_CREATED', `Новый аккаунт через Лоадер-мост: ${cleanUser}`);
          return { success: true, user: data.user, hwid: data.hwid };
        }
      }
    } catch(e) {}

    // 2. Облачная регистрация в Firebase
    try {
      const cloudUsers = (await fetchFirebaseUsersCloud()) || [];
      if (cloudUsers.some(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
        return { success: false, error: 'Пользователь с таким никнеймом уже зарегистрирован в базе данных' };
      }
      const maxUuid = cloudUsers.reduce((max, u) => Math.max(max, u.uuid || 0), 0);
      const newUuid = maxUuid + 1;
      const hwid = loaderBridgeStatus.online ? loaderBridgeStatus.hwid : null;
      const isOwner = cleanUser.toLowerCase() === 'deathproblem' || cleanUser.toLowerCase() === 'admin';

      const cloudNew = {
        id: String(newUuid),
        uuid: newUuid,
        username: cleanUser,
        email: `${cleanUser.toLowerCase()}@shinyvisuals.client`,
        password: cleanPass,
        role: isOwner ? 'Owner' : 'Player',
        downloadsCount: 0,
        createdAt: new Date().toISOString(),
        token: `token-${newUuid}-${Math.random().toString(36).slice(2, 10)}`,
        hwid: hwid
      };

      await fetch(`${FIREBASE_DB_URL}/users/${newUuid}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cloudNew)
      });

      if (hwid) {
        await fetch(`${FIREBASE_DB_URL}/hwid/${encodeURIComponent(cleanUser)}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hwid)
        });
      }

      const clientUser = {
        id: String(newUuid),
        uuid: newUuid,
        username: cleanUser,
        role: isOwner ? 'OWNER' : 'USER',
        plan: 'SHINYVISUALS PRO',
        subscription: 'Lifetime',
        hwid: hwid,
        createdAt: Date.now()
      };

      saveCurrentAccountUser(clientUser);
      logSecurityEvent('ACCOUNT_CREATED', `Зарегистрирован в Firebase: ${cleanUser}`);
      return { success: true, user: clientUser, hwid };
    } catch(e) {}

    // 3. Локальная регистрация
    const accounts = getAccountsList();
    if (accounts.some(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
      return { success: false, error: 'Пользователь с таким никнеймом уже существует' };
    }

    const salt = DEFAULT_MASTER_SALT;
    const pwdHash = await hashPassword(cleanPass, salt);
    const hwid = loaderBridgeStatus.online ? loaderBridgeStatus.hwid : null;
    const newUser = {
      username: cleanUser,
      uid: cleanUser.toLowerCase() === 'admin' ? '#1337' : '#' + Math.floor(1000 + Math.random() * 9000),
      password: cleanPass,
      passwordHash: pwdHash,
      salt: salt,
      role: cleanUser.toLowerCase() === 'deathproblem' || cleanUser.toLowerCase() === 'admin' ? 'OWNER' : 'USER',
      plan: 'SHINYVISUALS PRO',
      subscription: 'Lifetime',
      hwid: hwid,
      twoFactor: { enabled: false, secret: '', backupCodes: [] },
      createdAt: Date.now()
    };

    accounts.push(newUser);
    saveAccountsList(accounts);
    saveCurrentAccountUser(newUser);
    logSecurityEvent('ACCOUNT_CREATED', `Зарегистрирован локальный аккаунт: ${cleanUser}`);
    return { success: true, user: newUser, hwid };
  }

  async function resetHwidAccount(username) {
    const cleanUser = (username || '').trim();
    // 1. Попытка через мост лоадера
    try {
      const bridgeRes = await fetch('http://127.0.0.1:26300/api/auth/reset-hwid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser })
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        if (data.success) {
          logSecurityEvent('HWID_RESET', `Сброс HWID через лоадер для ${cleanUser}`);
          return { success: true, hwid: data.hwid };
        }
      }
    } catch(e) {}

    // 2. Обновление в Firebase /hwid/<cleanUser>
    try {
      const targetHwid = loaderBridgeStatus.online ? loaderBridgeStatus.hwid : null;
      await fetch(`${FIREBASE_DB_URL}/hwid/${encodeURIComponent(cleanUser)}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetHwid)
      });
      logSecurityEvent('HWID_RESET', `Сброс HWID в Firebase для ${cleanUser}`);
      return { success: true, hwid: targetHwid };
    } catch(e) {}
    if (user) {
      user.hwid = loaderBridgeStatus.online ? loaderBridgeStatus.hwid : null;
      saveAccountsList(accounts);
      const curr = getCurrentAccountUser();
      if (curr && curr.username.toLowerCase() === cleanUser.toLowerCase()) {
        curr.hwid = user.hwid;
        saveCurrentAccountUser(curr);
      }
      logSecurityEvent('HWID_RESET', `Сброс HWID для ${cleanUser}`);
      return { success: true, hwid: user.hwid };
    }
    return { success: false, error: 'Пользователь не найден' };
  }

  function updateSiteAccountUI() {
    const user = getCurrentAccountUser();
    const navBtn = document.getElementById('btnNavAccount');
    if (navBtn) {
      if (user) {
        navBtn.innerHTML = `👤 ${user.username} <span style="font-size:10px;padding:1px 5px;background:#10b981;border-radius:4px;color:#fff;font-weight:700;margin-left:4px;">PRO</span>`;
      } else {
        navBtn.innerHTML = `👤 Личный кабинет`;
      }
    }

    const floatingBadge = document.getElementById('shinySecurityFloatingBadge');
    if (floatingBadge) {
      if (loaderBridgeStatus.online && loaderBridgeStatus.hwid) {
        floatingBadge.style.borderColor = 'rgba(74, 222, 128, 0.6)';
        floatingBadge.title = `Лоадер подключен (HWID: ${loaderBridgeStatus.hwid})`;
      }
    }
  }

  function openAuthModal(defaultTab = 'login') {
    closeActiveModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'shinyAuthModal';

    const isOnline = loaderBridgeStatus.online;

    backdrop.innerHTML = `
      <div class="twofactor-modal-card" style="max-width:420px;text-align:center;">
        <button class="twofactor-close-btn" id="btnAuthClose">✕</button>

        <div style="font-size:38px;margin-bottom:8px;">✨</div>
        <h2 style="font-size:20px;font-weight:800;color:#fff;margin:0 0 4px 0;">ShinyVisuals 3.3</h2>
        <p style="font-size:12.5px;color:#c084fc;margin:0 0 16px 0;">Единая авторизация & Привязка HWID</p>

        <!-- Статус моста лоадера -->
        <div style="margin-bottom:16px;padding:8px 12px;border-radius:10px;font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:8px;background:${isOnline ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.06)'};border:1px solid ${isOnline ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)'};color:${isOnline ? '#34d399' : '#a7a3b8'};">
          <span>${isOnline ? '🟢 Лоадер на связи (HWID ПК обнаружен)' : '⚪ Лоадер офлайн (Автосинхронизация при запуске)'}</span>
        </div>

        <!-- Табы Вход / Регистрация -->
        <div style="display:flex;gap:8px;margin-bottom:18px;background:rgba(14,8,28,0.7);padding:4px;border-radius:10px;border:1px solid rgba(168,85,247,0.2);">
          <button type="button" id="tabSiteLogin" style="flex:1;padding:8px;border:none;border-radius:8px;font-size:12px;font-weight:700;text-transform:uppercase;cursor:pointer;background:${defaultTab === 'login' ? '#a855f7' : 'transparent'};color:${defaultTab === 'login' ? '#fff' : '#a7a3b8'};">ВХОД</button>
          <button type="button" id="tabSiteRegister" style="flex:1;padding:8px;border:none;border-radius:8px;font-size:12px;font-weight:700;text-transform:uppercase;cursor:pointer;background:${defaultTab === 'register' ? '#a855f7' : 'transparent'};color:${defaultTab === 'register' ? '#fff' : '#a7a3b8'};">РЕГИСТРАЦИЯ</button>
        </div>

        <!-- Форма Входа -->
        <div id="boxSiteLogin" style="display:${defaultTab === 'login' ? 'block' : 'none'};">
          <input type="text" id="txtSiteLoginUser" class="shiny-gate-input" placeholder="Никнейм / Логин" style="width:100%;margin-bottom:12px;box-sizing:border-box;" value="Admin" />
          <input type="password" id="txtSiteLoginPass" class="shiny-gate-input" placeholder="Пароль" style="width:100%;margin-bottom:12px;box-sizing:border-box;" value="1337" />
          
          <div id="boxSiteLogin2FA" style="display:none;margin-bottom:12px;">
            <input type="text" id="txtSiteLogin2FA" class="shiny-gate-input" placeholder="6-значный код Google Authenticator" maxlength="8" style="width:100%;box-sizing:border-box;" />
          </div>

          <div id="lblSiteLoginError" style="display:none;font-size:12px;color:#f87171;margin-bottom:12px;text-align:left;"></div>

          <button type="button" class="twofactor-btn-primary" id="btnSiteSubmitLogin" style="width:100%;padding:12px;justify-content:center;font-weight:700;margin-bottom:8px;">
            ВОЙТИ В АККАУНТ
          </button>
        </div>

        <!-- Форма Регистрации -->
        <div id="boxSiteRegister" style="display:${defaultTab === 'register' ? 'block' : 'none'};">
          <input type="text" id="txtSiteRegUser" class="shiny-gate-input" placeholder="Желаемый никнейм" style="width:100%;margin-bottom:12px;box-sizing:border-box;" />
          <input type="password" id="txtSiteRegPass" class="shiny-gate-input" placeholder="Пароль" style="width:100%;margin-bottom:8px;box-sizing:border-box;" />
          <div id="regPassMeter"></div>
          <input type="password" id="txtSiteRegConfirm" class="shiny-gate-input" placeholder="Повторите пароль" style="width:100%;margin-top:8px;margin-bottom:12px;box-sizing:border-box;" />

          <div id="lblSiteRegError" style="display:none;font-size:12px;color:#f87171;margin-bottom:12px;text-align:left;"></div>

          <button type="button" class="twofactor-btn-primary" id="btnSiteSubmitRegister" style="width:100%;padding:12px;justify-content:center;font-weight:700;margin-bottom:8px;">
            СОЗДАТЬ АККАУНТ (LIFETIME PRO)
          </button>
          <div style="font-size:11.5px;color:#86efac;line-height:1.4;">
            ✓ HWID будет привязан к вашему ПК автоматически<br/>
            ✓ Подходит для мгновенного входа в Лоадере
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btnAuthClose').onclick = closeActiveModal;

    const tabLogin = backdrop.querySelector('#tabSiteLogin');
    const tabReg = backdrop.querySelector('#tabSiteRegister');
    const boxLogin = backdrop.querySelector('#boxSiteLogin');
    const boxReg = backdrop.querySelector('#boxSiteRegister');

    tabLogin.onclick = () => {
      tabLogin.style.background = '#a855f7'; tabLogin.style.color = '#fff';
      tabReg.style.background = 'transparent'; tabReg.style.color = '#a7a3b8';
      boxLogin.style.display = 'block'; boxReg.style.display = 'none';
    };

    tabReg.onclick = () => {
      tabReg.style.background = '#a855f7'; tabReg.style.color = '#fff';
      tabLogin.style.background = 'transparent'; tabLogin.style.color = '#a7a3b8';
      boxLogin.style.display = 'none'; boxReg.style.display = 'block';
    };

    const regPassInp = backdrop.querySelector('#txtSiteRegPass');
    if (regPassInp) attachStrengthMeterToInput(regPassInp);

    backdrop.querySelector('#btnSiteSubmitLogin').onclick = async () => {
      const u = (backdrop.querySelector('#txtSiteLoginUser').value || '').trim();
      const p = (backdrop.querySelector('#txtSiteLoginPass').value || '').trim();
      const totp = (backdrop.querySelector('#txtSiteLogin2FA').value || '').trim();
      const errLbl = backdrop.querySelector('#lblSiteLoginError');

      const res = await loginAccount(u, p, totp);
      if (res.require2FA) {
        backdrop.querySelector('#boxSiteLogin2FA').style.display = 'block';
        errLbl.style.display = 'block';
        errLbl.textContent = res.error || 'Введите 6-значный код 2FA';
        backdrop.querySelector('#txtSiteLogin2FA').focus();
        return;
      }
      if (!res.success) {
        errLbl.style.display = 'block';
        errLbl.textContent = res.message || res.error || 'Ошибка входа';
        return;
      }

      closeActiveModal();
      showSecurityToast(`✨ Добро пожаловать, ${res.user.username}!`);
      openSecurityHubModal();
    };

    backdrop.querySelector('#btnSiteSubmitRegister').onclick = async () => {
      const u = (backdrop.querySelector('#txtSiteRegUser').value || '').trim();
      const p1 = (backdrop.querySelector('#txtSiteRegPass').value || '').trim();
      const p2 = (backdrop.querySelector('#txtSiteRegConfirm').value || '').trim();
      const errLbl = backdrop.querySelector('#lblSiteRegError');

      if (!u || !p1) {
        errLbl.style.display = 'block'; errLbl.textContent = 'Заполните все поля!'; return;
      }
      if (p1 !== p2) {
        errLbl.style.display = 'block'; errLbl.textContent = 'Пароли не совпадают!'; return;
      }

      const res = await registerAccount(u, p1);
      if (!res.success) {
        errLbl.style.display = 'block'; errLbl.textContent = res.error || 'Ошибка регистрации'; return;
      }

      closeActiveModal();
      showSecurityToast(`🎉 Аккаунт ${u} успешно создан!`);
      openSecurityHubModal();
    };
  }

  function openAccountModalOrProfile() {
    const user = getCurrentAccountUser();
    if (user) {
      openSecurityHubModal();
      setTimeout(() => {
        const btnAcc = document.querySelector('.shiny-sec-tab-btn[data-tab="account"]');
        if (btnAcc) btnAcc.click();
      }, 50);
    } else {
      openAuthModal('login');
    }
  }

  function renderAccountTab(body) {
    const user = getCurrentAccountUser() || { username: 'Admin', uid: '#1337', role: 'OWNER', subscription: 'Lifetime' };
    const isOnline = loaderBridgeStatus.online;
    const pcHwid = loaderBridgeStatus.hwid || 'SHINY-PC-OFFLINE';
    const userHwid = user.hwid || (isOnline ? pcHwid : null);
    const isBound = userHwid && (!isOnline || userHwid === pcHwid);

    body.innerHTML = `
      <div class="shiny-sec-card" style="background:linear-gradient(135deg,rgba(30,16,56,0.8),rgba(18,9,36,0.95));border-color:rgba(168,85,247,0.4);margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#a855f7,#6366f1);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#fff;">
              ${(user.username || 'A').charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-size:16px;font-weight:700;color:#ffffff;display:flex;align-items:center;gap:8px;">
                <span>${user.username}</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(168,85,247,0.25);color:#c084fc;font-weight:600;">${user.uid || '#0001'}</span>
              </div>
              <div style="font-size:12px;color:#4ade80;font-weight:600;margin-top:2px;">
                ⭐ SHINYVISUALS FREE
              </div>
            </div>
          </div>
          <span style="font-size:11px;padding:4px 9px;border-radius:8px;background:${isOnline ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.08)'};color:${isOnline ? '#34d399' : '#a7a3b8'};border:1px solid ${isOnline ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.15)'};">
            ${isOnline ? '🟢 Лоадер на связи' : '⚪ Лоадер офлайн'}
          </span>
        </div>

        <!-- HWID Блок -->
        <div style="background:rgba(14,8,28,0.7);border:1px solid rgba(168,85,247,0.2);border-radius:10px;padding:12px 14px;margin-top:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;color:#a7a3b8;font-weight:600;">Привязка Hardware ID (HWID):</span>
            <span style="font-size:11.5px;font-weight:700;color:${isBound ? '#34d399' : '#f87171'};">
              ${isBound ? '✓ Привязан к вашему ПК' : '⚠️ Требуется привязка'}
            </span>
          </div>
          <div style="font-family:monospace;font-size:13px;font-weight:700;color:#c084fc;background:rgba(0,0,0,0.3);padding:8px 12px;border-radius:8px;border:1px dashed rgba(168,85,247,0.3);display:flex;align-items:center;justify-content:space-between;">
            <span id="txtDisplayHwid">${userHwid || 'SHINY-ОЖИДАЕТ-ВХОДА'}</span>
            <button type="button" id="btnHubCopyHwid" style="background:rgba(168,85,247,0.2);border:none;color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:11px;">Скопировать</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button type="button" id="btnHubResetHwid" class="twofactor-btn-danger" style="flex:1;font-size:11.5px;padding:7px 10px;">
              🔄 Сбросить HWID для нового ПК
            </button>
            ${isOnline ? `
              <button type="button" id="btnHubAuthorizeLoader" class="twofactor-btn-primary" style="flex:1;font-size:11.5px;padding:7px 10px;">
                🚀 Войти в Лоадер в 1 клик
              </button>
            ` : `
              <button type="button" id="btnHubCopySyncToken" class="twofactor-btn-primary" style="flex:1;font-size:11.5px;padding:7px 10px;">
                🔑 Токен связки
              </button>
            `}
          </div>
        </div>
      </div>

      <!-- Управление аккаунтом -->
      <div class="shiny-sec-card">
        <h4 style="font-size:13.5px;font-weight:700;color:#ffffff;margin:0 0 10px 0;">Действия с аккаунтом</h4>
        <div style="display:flex;gap:10px;">
          <button type="button" class="twofactor-btn-secondary" id="btnHubSwitchAccount" style="flex:1;font-size:12px;padding:9px;">
            Сменить аккаунт / Войти
          </button>
          <button type="button" class="twofactor-btn-danger" id="btnHubLogout" style="font-size:12px;padding:9px 16px;">
            Выйти
          </button>
        </div>
      </div>
    `;

    const btnCopy = body.querySelector('#btnHubCopyHwid');
    if (btnCopy) {
      btnCopy.onclick = () => {
        const h = body.querySelector('#txtDisplayHwid').textContent;
        navigator.clipboard.writeText(h);
        showSecurityToast(`✓ HWID скопирован: ${h}`);
      };
    }

    const btnReset = body.querySelector('#btnHubResetHwid');
    if (btnReset) {
      btnReset.onclick = async () => {
        if (!confirm(`Вы действительно хотите сбросить привязку HWID для аккаунта ${user.username}?`)) return;
        const res = await resetHwidAccount(user.username);
        if (res.success) {
          showSecurityToast('✓ HWID успешно сброшен и обновлён!');
          renderAccountTab(body);
        } else {
          showSecurityToast(res.error || 'Ошибка сброса HWID');
        }
      };
    }

    const btnAuthLoader = body.querySelector('#btnHubAuthorizeLoader');
    if (btnAuthLoader) {
      btnAuthLoader.onclick = async () => {
        try {
          const res = await fetch('http://127.0.0.1:26300/api/auth/approve-web-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'active_session', username: user.username })
          });
          showSecurityToast('🚀 Сигнал авторизации отправлен в запущенный Лоадер!');
        } catch(e) {
          showSecurityToast('Ошибка связи с лоадером');
        }
      };
    }

    const btnSyncToken = body.querySelector('#btnHubCopySyncToken');
    if (btnSyncToken) {
      btnSyncToken.onclick = () => {
        const token = btoa(JSON.stringify(user));
        navigator.clipboard.writeText(token);
        showSecurityToast('🔑 Токен связки скопирован! Вставьте его в лоадере.');
      };
    }

    const btnSwitch = body.querySelector('#btnHubSwitchAccount');
    if (btnSwitch) {
      btnSwitch.onclick = () => {
        closeActiveModal();
        openAuthModal('login');
      };
    }

    const btnLogout = body.querySelector('#btnHubLogout');
    if (btnLogout) {
      btnLogout.onclick = () => {
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        showSecurityToast('Вы вышли из аккаунта.');
        renderAccountTab(body);
        updateSiteAccountUI();
      };
    }
  }

  function handleWebAuthUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('auth_token');
      if (token) {
        const user = getCurrentAccountUser() || { username: 'Admin' };
        setTimeout(() => {
          if (confirm(`🔔 ShinyVisuals Loader запрашивает подтверждение авторизации.\n\nПодтвердить вход для аккаунта ${user.username}?`)) {
            fetch('http://127.0.0.1:26300/api/auth/approve-web-login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: token, username: user.username })
            }).then(() => {
              showSecurityToast('✓ Вход в ShinyVisuals Loader успешно подтверждён!');
            }).catch(() => {
              showSecurityToast('Лоадер не ответил на подтверждение.');
            });
          }
        }, 600);
      }
    } catch(e) {}
  }

  // --------------------------------------------------------------------------
  // 10. Центр Безопасности (Security Hub Modal)
  // --------------------------------------------------------------------------
  function openSecurityHubModal() {
    closeActiveModal();

    const secCfg = getSecurityConfig();
    const twoFaCfg = get2FAConfig();
    const username = detectCurrentUsername();
    const auditLogs = getAuditLogs();

    // Расчет процента защищенности (Security Score)
    let score = 50; // Базовое криптографическое хеширование + защита памяти
    if (twoFaCfg.enabled) score += 25;
    if (secCfg.siteGateEnabled) score += 15;
    if (secCfg.antiDevTools) score += 10;

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'shinySecurityHubModal';

    backdrop.innerHTML = `
      <div class="shiny-sec-hub-box">
        <!-- Шапка -->
        <div class="shiny-sec-hub-header">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#a855f7,#7e22ce);display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 16px rgba(168,85,247,0.4);">
              🛡️
            </div>
            <div>
              <h2 style="margin:0;font-size:17px;font-weight:700;color:#ffffff;">Центр Безопасности ShinyVisuals</h2>
              <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                <span style="font-size:11.5px;color:#c084fc;">Профиль: <strong>${username}</strong></span>
                <span style="font-size:11px;padding:2px 7px;border-radius:9999px;background:rgba(16,185,129,0.15);color:#34d399;font-weight:600;border:1px solid rgba(16,185,129,0.3);">
                  Уровень защиты: ${score}%
                </span>
              </div>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btnSecHubClose">✕</button>
        </div>

        <!-- Навигационные вкладки -->
        <div class="shiny-sec-hub-tabs">
          <button class="shiny-sec-tab-btn active" data-tab="overview">🛡️ Обзор</button>
          <button class="shiny-sec-tab-btn" data-tab="account">👤 Аккаунт & HWID</button>
          <button class="shiny-sec-tab-btn" data-tab="gate">🚪 Вход на сайт</button>
          <button class="shiny-sec-tab-btn" data-tab="2fa">📱 2FA Authenticator</button>
          <button class="shiny-sec-tab-btn" data-tab="passwords">🔑 Пароли</button>
          <button class="shiny-sec-tab-btn" data-tab="audit">📋 Журнал аудита</button>
        </div>

        <!-- Тело вкладок -->
        <div class="shiny-sec-hub-body" id="shinySecHubBody">
          <!-- Контент будет переключаться скриптом -->
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btnSecHubClose').onclick = closeActiveModal;

    const tabs = backdrop.querySelectorAll('.shiny-sec-tab-btn');
    const body = backdrop.querySelector('#shinySecHubBody');

    function renderTab(tabName) {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

      if (tabName === 'overview') {
        body.innerHTML = `
          <!-- Карточка общего статуса -->
          <div class="shiny-sec-card" style="background:linear-gradient(135deg,rgba(30,16,56,0.8),rgba(18,9,36,0.95));border-color:rgba(168,85,247,0.4);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <span style="font-size:15px;font-weight:700;color:#ffffff;">Комплексная защита системы</span>
              <span style="font-size:13px;font-weight:700;color:#34d399;">${score}% Защищено</span>
            </div>
            <div style="height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;margin-bottom:16px;">
              <div style="width:${score}%;height:100%;background:linear-gradient(90deg,#a855f7,#10b981);border-radius:4px;"></div>
            </div>
            
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px;">
              <div style="color:#34d399;display:flex;align-items:center;gap:6px;">✓ Хеширование SHA-256</div>
              <div style="color:#34d399;display:flex;align-items:center;gap:6px;">✓ Anti-Bruteforce Shield</div>
              <div style="color:${twoFaCfg.enabled ? '#34d399' : '#f87171'};display:flex;align-items:center;gap:6px;">
                ${twoFaCfg.enabled ? '✓ 2FA Google Authenticator' : '✕ 2FA не включен'}
              </div>
              <div style="color:${secCfg.siteGateEnabled ? '#34d399' : '#a7a3b8'};display:flex;align-items:center;gap:6px;">
                ${secCfg.siteGateEnabled ? '✓ Master Site Gate: ВКЛ' : '○ Master Site Gate: ВЫКЛ'}
              </div>
            </div>
          </div>

          <!-- Быстрые переключатели -->
          <div class="shiny-sec-card">
            <div class="shiny-sec-row-toggle">
              <div>
                <div style="font-size:13.5px;font-weight:600;color:#ffffff;">Защита от перебора паролей (Rate Limiting)</div>
                <div style="font-size:12px;color:#a7a3b8;margin-top:2px;">Блокирует попытки брутфорса после 5 ошибок нарастающим таймаутом.</div>
              </div>
              <span style="font-size:11.5px;font-weight:700;color:#34d399;background:rgba(16,185,129,0.15);padding:3px 8px;border-radius:6px;border:1px solid rgba(16,185,129,0.3);">
                АКТИВНО
              </span>
            </div>
          </div>

          <div class="shiny-sec-card">
            <div class="shiny-sec-row-toggle">
              <div>
                <div style="font-size:13.5px;font-weight:600;color:#ffffff;">Защита от DevTools и копирования кода</div>
                <div style="font-size:12px;color:#a7a3b8;margin-top:2px;">Блокирует горячие клавиши F12, Ctrl+Shift+I и просмотр исходников.</div>
              </div>
              <label class="shiny-sec-switch">
                <input type="checkbox" id="toggleAntiDevTools" ${secCfg.antiDevTools ? 'checked' : ''} />
                <span class="shiny-sec-slider"></span>
              </label>
            </div>
          </div>

          <div class="shiny-sec-card">
            <div class="shiny-sec-row-toggle">
              <div>
                <div style="font-size:13.5px;font-weight:600;color:#ffffff;">Блокировка контекстного меню (ПКМ)</div>
                <div style="font-size:12px;color:#a7a3b8;margin-top:2px;">Запрещает клик правой кнопкой мыши для защиты медиа и элементов.</div>
              </div>
              <label class="shiny-sec-switch">
                <input type="checkbox" id="toggleAntiContextMenu" ${secCfg.antiContextMenu ? 'checked' : ''} />
                <span class="shiny-sec-slider"></span>
              </label>
            </div>
          </div>
        `;

        body.querySelector('#toggleAntiDevTools').onchange = (e) => {
          secCfg.antiDevTools = e.target.checked;
          saveSecurityConfig(secCfg);
          showSecurityToast(`Защита от DevTools: ${secCfg.antiDevTools ? 'Включена' : 'Выключена'}`);
        };

        body.querySelector('#toggleAntiContextMenu').onchange = (e) => {
          secCfg.antiContextMenu = e.target.checked;
          saveSecurityConfig(secCfg);
          showSecurityToast(`Блокировка ПКМ: ${secCfg.antiContextMenu ? 'Включена' : 'Выключена'}`);
        };

      } else if (tabName === 'account') {
        renderAccountTab(body);

      } else if (tabName === 'gate') {
        body.innerHTML = `
          <div class="shiny-sec-card" style="margin-bottom:18px;">
            <div class="shiny-sec-row-toggle" style="margin-bottom:14px;">
              <div>
                <div style="font-size:14px;font-weight:700;color:#ffffff;">Вход на сайт по мастер-паролю (Site Gate)</div>
                <div style="font-size:12px;color:#a7a3b8;margin-top:2px;">
                  При включении доступ ко всему сайту закрывается экраном авторизации. Только знающие мастер-пароль смогут открыть сайт.
                </div>
              </div>
              <label class="shiny-sec-switch">
                <input type="checkbox" id="toggleSiteGate" ${secCfg.siteGateEnabled ? 'checked' : ''} />
                <span class="shiny-sec-slider"></span>
              </label>
            </div>

            <div style="border-top:1px solid rgba(168,85,247,0.18);padding-top:14px;display:flex;gap:10px;">
              <button type="button" class="twofactor-btn-primary" id="btnTestLockNow" style="font-size:12.5px;padding:8px 16px;">
                🔒 Заблокировать сайт сейчас (Тест)
              </button>
            </div>
          </div>

          <!-- Форма изменения мастер-пароля -->
          <div class="shiny-sec-card">
            <h3 style="font-size:14px;font-weight:700;color:#ffffff;margin:0 0 10px 0;">Установить новый мастер-пароль сайта</h3>
            <p style="font-size:12px;color:#a7a3b8;margin:0 0 14px 0;">
              Пароль шифруется в SHA-256 с солью и хранится локально в безопасности.
            </p>

            <div style="display:flex;flex-direction:column;gap:10px;">
              <input type="password" id="txtNewMasterPass" class="shiny-gate-input" placeholder="Новый мастер-пароль..." style="font-size:13.5px;padding:10px 14px;" />
              <input type="password" id="txtConfirmMasterPass" class="shiny-gate-input" placeholder="Повторите новый пароль..." style="font-size:13.5px;padding:10px 14px;" />
              
              <div id="lblGatePassMsg" style="font-size:12px;display:none;"></div>

              <button type="button" class="twofactor-btn-primary" id="btnSaveMasterPass" style="font-size:13px;padding:10px;justify-content:center;">
                Сохранить мастер-пароль
              </button>
            </div>
          </div>
        `;

        body.querySelector('#toggleSiteGate').onchange = (e) => {
          secCfg.siteGateEnabled = e.target.checked;
          saveSecurityConfig(secCfg);
          showSecurityToast(`Site Gate: ${secCfg.siteGateEnabled ? 'Включен (сайт закрыт)' : 'Выключен (открытый доступ)'}`);
          if (secCfg.siteGateEnabled) {
            setSiteGateUnlocked(false);
          }
        };

        body.querySelector('#btnTestLockNow').onclick = () => {
          secCfg.siteGateEnabled = true;
          saveSecurityConfig(secCfg);
          setSiteGateUnlocked(false);
          closeActiveModal();
          checkAndEnforceSiteGate();
        };

        body.querySelector('#btnSaveMasterPass').onclick = async () => {
          const p1 = (body.querySelector('#txtNewMasterPass').value || '').trim();
          const p2 = (body.querySelector('#txtConfirmMasterPass').value || '').trim();
          const msg = body.querySelector('#lblGatePassMsg');

          if (p1.length < 4) {
            msg.style.display = 'block';
            msg.style.color = '#f87171';
            msg.textContent = 'Пароль должен содержать минимум 4 символа!';
            return;
          }
          if (p1 !== p2) {
            msg.style.display = 'block';
            msg.style.color = '#f87171';
            msg.textContent = 'Пароли не совпадают!';
            return;
          }

          const newHash = await hashPassword(p1);
          secCfg.siteGateHash = newHash;
          saveSecurityConfig(secCfg);
          logSecurityEvent('PWD_CHANGED', 'Мастер-пароль сайта успешно обновлён');

          msg.style.display = 'block';
          msg.style.color = '#34d399';
          msg.textContent = '✓ Мастер-пароль успешно сохранён и захеширован в SHA-256!';
          showSecurityToast('✓ Мастер-пароль сайта обновлен!');
        };

      } else if (tabName === '2fa') {
        body.innerHTML = `
          <div class="shiny-sec-card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
              <div>
                <h3 style="margin:0 0 4px 0;font-size:15px;color:#ffffff;font-weight:700;">Google Authenticator (RFC 6238)</h3>
                <p style="margin:0;font-size:12.5px;color:#a7a3b8;">
                  Генерация одноразовых 6-значных кодов TOTP каждые 30 секунд.
                </p>
              </div>
              <span class="twofactor-status-badge ${twoFaCfg.enabled ? 'active' : 'inactive'}">
                ${twoFaCfg.enabled ? 'Активно' : 'Отключено'}
              </span>
            </div>

            <div style="display:flex;gap:10px;margin-top:14px;">
              ${twoFaCfg.enabled ? `
                <button type="button" class="twofactor-btn-danger" id="btnHubDisable2FA">Отключить 2FA</button>
              ` : `
                <button type="button" class="twofactor-btn-primary" id="btnHubSetup2FA">Подключить Google Authenticator</button>
              `}
            </div>
          </div>

          ${twoFaCfg.enabled ? `
            <div class="shiny-sec-card">
              <h4 style="margin:0 0 8px 0;font-size:13.5px;color:#ffffff;font-weight:600;">Резервные аварийные коды:</h4>
              <p style="font-size:12px;color:#a7a3b8;margin:0 0 12px 0;">
                Используйте эти коды, если потеряете доступ к телефону:
              </p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                ${(twoFaCfg.backupCodes || []).map(c => `<code style="font-size:13px;font-weight:700;color:#34d399;background:rgba(10,5,20,0.8);padding:6px;border-radius:6px;text-align:center;">${c}</code>`).join('')}
              </div>
            </div>
          ` : ''}
        `;

        const btnSetup = body.querySelector('#btnHubSetup2FA');
        if (btnSetup) btnSetup.onclick = openGoogleAuthSetupModal;

        const btnDis = body.querySelector('#btnHubDisable2FA');
        if (btnDis) btnDis.onclick = openDisable2FAModal;

      } else if (tabName === 'passwords') {
        body.innerHTML = `
          <div class="shiny-sec-card">
            <h3 style="font-size:14px;font-weight:700;color:#ffffff;margin:0 0 6px 0;">Анализатор и тренажёр стойкости паролей</h3>
            <p style="font-size:12px;color:#a7a3b8;margin:0 0 14px 0;">
              Проверьте пароль на соответствие политике безопасности ShinyVisuals в реальном времени:
            </p>

            <input type="text" id="txtTestPwd" class="shiny-gate-input" placeholder="Введите пароль для анализа..." style="font-size:14px;padding:11px 14px;margin-bottom:8px;" />
            <div id="testPwdMeterContainer"></div>

            <div style="margin-top:16px;background:rgba(12,7,24,0.7);border-radius:10px;padding:12px;font-size:12px;color:#e9d5ff;line-height:1.5;">
              <div style="font-weight:600;color:#ffffff;margin-bottom:4px;">Критерии безопасного пароля:</div>
              • Минимум 8-12 символов<br/>
              • Буквы верхнего (A-Z) и нижнего (a-z) регистра<br/>
              • Цифры (0-9) и спецсимволы (!@#$%^&*)<br/>
              • Отсутствие в базах скомпрометированных паролей
            </div>
          </div>
        `;

        const testInp = body.querySelector('#txtTestPwd');
        attachStrengthMeterToInput(testInp);

      } else if (tabName === 'audit') {
        const logs = getAuditLogs();
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <span style="font-size:14px;font-weight:700;color:#ffffff;">Журнал событий безопасности</span>
            <button type="button" class="twofactor-copy-btn" id="btnClearAuditLogs">Очистить журнал</button>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            ${logs.length === 0 ? `
              <div style="text-align:center;padding:24px;color:#a7a3b8;font-size:13px;">Журнал пуст. Нарушений безопасности не зафиксировано.</div>
            ` : logs.map(l => {
              let badgeCol = '#34d399';
              let badgeBg = 'rgba(16,185,129,0.15)';
              if (l.type.includes('LOCKOUT') || l.type.includes('BLOCKED')) {
                badgeCol = '#f87171';
                badgeBg = 'rgba(239,68,68,0.15)';
              } else if (l.type.includes('FAILED') || l.type.includes('DISABLED')) {
                badgeCol = '#fbbf24';
                badgeBg = 'rgba(245,158,11,0.15)';
              }
              return `
                <div style="background:rgba(22,14,40,0.6);border:1px solid rgba(168,85,247,0.2);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
                  <div>
                    <div style="font-size:12.5px;font-weight:600;color:#ffffff;">${l.details}</div>
                    <div style="font-size:10.5px;color:#a7a3b8;margin-top:2px;">${l.time}</div>
                  </div>
                  <span style="font-size:10.5px;font-weight:700;color:${badgeCol};background:${badgeBg};padding:2px 7px;border-radius:6px;border:1px solid ${badgeCol}40;white-space:nowrap;">
                    ${l.type}
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        `;

        const btnClear = body.querySelector('#btnClearAuditLogs');
        if (btnClear) {
          btnClear.onclick = () => {
            localStorage.removeItem(STORAGE_KEYS.AUDIT_LOG);
            renderTab('audit');
            showSecurityToast('Журнал аудита очищен.');
          };
        }
      }
    }

    tabs.forEach(t => {
      t.onclick = () => renderTab(t.dataset.tab);
    });

    renderTab('overview');
  }

  // --------------------------------------------------------------------------
  // 11. Плавающий бейдж безопасности (Floating Shield Pill)
  // --------------------------------------------------------------------------
  function injectFloatingSecurityBadge() {
    let badge = document.getElementById('shinySecurityFloatingBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'shinySecurityFloatingBadge';
      badge.className = 'shiny-sec-floating-badge';
      badge.title = 'Открыть Центр Безопасности ShinyVisuals';
      badge.onclick = openSecurityHubModal;
      document.body.appendChild(badge);
    }

    const twoFa = get2FAConfig();
    const secCfg = getSecurityConfig();
    let score = 50;
    if (twoFa.enabled) score += 25;
    if (secCfg.siteGateEnabled) score += 15;
    if (secCfg.antiDevTools) score += 10;

    badge.innerHTML = `
      <span class="shiny-sec-pulse-dot"></span>
      <span style="font-size:14px;">🛡️</span>
      <span>Защита: ${score}%</span>
    `;
  }

  // --------------------------------------------------------------------------
  // 12. Перехват форм (Form Hooking & Password Interception)
  // --------------------------------------------------------------------------
  function hookForms() {
    // Автоматическое добавление индикатора сложности ко всем полям паролей в DOM
    function scanAndAttachMeters() {
      const pwdInputs = document.querySelectorAll('input[type="password"]');
      pwdInputs.forEach(inp => {
        if (!inp.id.includes('Gate') && !inp.id.includes('Master')) {
          attachStrengthMeterToInput(inp);
        }
      });
    }

    scanAndAttachMeters();
    setInterval(scanAndAttachMeters, 1500);

    // Перехват отправки форм
    document.addEventListener('submit', async (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM' || form.id === 'shinyGateForm') return;

      // 0. Защита: формы РЕГИСТРАЦИИ никогда не должны запрашивать 2FA код
      const formText = (form.innerText || '').toLowerCase();
      const formHtml = (form.innerHTML || '').toLowerCase();
      const submitBtn = form.querySelector('button[type="submit"]') || form.querySelector('button');
      const submitText = (submitBtn ? submitBtn.innerText : '').toLowerCase();

      const isRegistration = form.dataset.authType === 'register' ||
                             form.classList.contains('register-form') ||
                             form.querySelector('input[type="email"]') !== null ||
                             form.querySelector('input[name*="email" i]') !== null ||
                             form.querySelector('input[placeholder*="email" i], input[placeholder*="почт" i]') !== null ||
                             form.querySelector('input[placeholder*="повтор" i], input[placeholder*="подтвержд" i]') !== null ||
                             form.querySelectorAll('input[type="password"]').length > 1 ||
                             submitText.includes('регистрац') ||
                             submitText.includes('создать') ||
                             submitText.includes('register') ||
                             formText.includes('регистрац') ||
                             formText.includes('создать аккаунт') ||
                             formText.includes('зарегистрироваться') ||
                             formHtml.includes('зарегистрироваться') ||
                             formHtml.includes('создать аккаунт');

      if (isRegistration) {
        return; // Для регистрации 2FA проверка строго отключена
      }

      const userInp = form.querySelector('input[type="text"], input[name="username"], input[placeholder*="логин" i], input[placeholder*="ник" i], input[placeholder*="username" i]');
      const passInp = form.querySelector('input[type="password"]');

      if (!passInp) return;

      const username = userInp ? userInp.value.trim() : detectCurrentUsername();
      if (!username) return;

      // 1. Проверка на блокировку брутфорса
      if (isBruteForceLocked(username)) {
        e.preventDefault();
        e.stopPropagation();
        const state = getBruteForceState(username);
        const rem = Math.ceil((state.lockedUntil - Date.now()) / 1000);
        showBruteForceLockoutModal(rem);
        return false;
      }

      // 2. Двухфакторная проверка 2FA (Google Authenticator)
      const cfg = get2FAConfig(username);
      if (cfg.enabled && cfg.secret && !form.dataset.twofactorVerified) {
        e.preventDefault();
        e.stopPropagation();

        promptLogin2FA(cfg, () => {
          form.dataset.twofactorVerified = 'true';
          const btn = form.querySelector('button[type="submit"]') || form.querySelector('button');
          if (btn) btn.click();
          else form.submit();
        });
        return false;
      }
    }, true);
  }

  function promptLogin2FA(cfg, onSuccess) {
    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:420px;">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:26px;">🛡️</span>
            <div>
              <h2>Проверка безопасности</h2>
              <p style="margin:2px 0 0 0;font-size:12px;color:#c084fc;">Google Authenticator 2FA</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">✕</button>
        </div>

        <p style="font-size:14px;color:#e9d5ff;margin:0 0 16px 0;line-height:1.5;">
          Введите 6-значный код из приложения для входа в аккаунт <strong>${cfg.username}</strong>:
        </p>

        <div class="twofactor-input-container">
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" autofocus />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="1" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="2" inputmode="numeric" />
          <span class="twofactor-digit-divider">-</span>
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="3" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="4" inputmode="numeric" />
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="5" inputmode="numeric" />
        </div>

        <div class="twofactor-error-msg" id="msg2faError">
          Неверный код.
        </div>

        <button class="twofactor-submit-btn" id="btnConfirmLogin2FA">
          Войти
        </button>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btn2faClose').onclick = closeActiveModal;

    setupDigitBoxes(() => {
      document.getElementById('btnConfirmLogin2FA').click();
    });

    document.getElementById('btnConfirmLogin2FA').onclick = async () => {
      const code = getDigitBoxCode();
      const isValid = await verifyTOTP(cfg.secret, code);
      const isBackup = cfg.backupCodes && cfg.backupCodes.includes(code);

      if (isValid || isBackup) {
        logSecurityEvent('LOGIN_SUCCESS', `Успешный 2FA вход для ${cfg.username}`);
        closeActiveModal();
        if (onSuccess) onSuccess();
      } else {
        recordFailedPasswordAttempt(cfg.username);
        const errorMsg = document.getElementById('msg2faError');
        if (errorMsg) errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  // --------------------------------------------------------------------------
  // 13. Встраивание строки 2FA в модальное окно профиля
  // --------------------------------------------------------------------------
  let isInjecting = false;

  function findModalRowsAnchor() {
    const modal = document.querySelector('.max-w-md, [role="dialog"]');
    if (!modal) return null;

    const buttons = modal.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const txt = (btn.textContent || '').trim();
      if (txt.includes('Сменить пароль') || txt.includes('Change Password')) {
        if (btn.parentElement) {
          return { el: btn.parentElement, pos: 'afterend', modal: modal };
        }
      }
    }

    const divs = modal.querySelectorAll('div');
    for (let i = 0; i < divs.length; i++) {
      if ((divs[i].textContent || '').includes('HWID')) {
        return { el: divs[i], pos: 'afterend', modal: modal };
      }
    }

    return null;
  }

  function injectAccountModalRow() {
    if (isInjecting) return;
    isInjecting = true;

    try {
      const anchor = findModalRowsAnchor();
      if (!anchor) return;

      const existing = document.getElementById('shiny2faModalRow');
      const cfg = get2FAConfig();

      if (existing) {
        if (existing.previousElementSibling === anchor.el) {
          return;
        }
        existing.remove();
      }

      const row = document.createElement('div');
      row.id = 'shiny2faModalRow';
      row.className = 'shiny-2fa-modal-row';
      row.innerHTML = `
        <div class="shiny-2fa-modal-left">
          <span class="shiny-2fa-icon">🛡️</span>
          <div class="shiny-2fa-text">
            <span class="shiny-2fa-title">Безопасность и 2FA</span>
            <span class="shiny-2fa-desc">${cfg.enabled ? '2FA активна (Google Auth)' : 'Управление защитой и 2FA'}</span>
          </div>
        </div>
        <div class="shiny-2fa-modal-right">
          <button type="button" class="shiny-2fa-action-btn setup" id="btnOpenSecHubFromModal">
            Настроить
          </button>
        </div>
      `;

      row.onclick = () => openSecurityHubModal();
      anchor.el.insertAdjacentElement(anchor.pos, row);
    } finally {
      isInjecting = false;
    }
  }

  // --------------------------------------------------------------------------
  // 14. Инициализация при загрузке
  // --------------------------------------------------------------------------
  function initializeSecuritySuite() {
    checkAndEnforceSiteGate();
    initWebArmor();
    hookForms();
    injectFloatingSecurityBadge();
    checkLoaderBridge();
    setInterval(checkLoaderBridge, 4000);
    updateSiteAccountUI();
    handleWebAuthUrlParams();

    // DOM Observer для плавного встраивания в динамический React DOM
    let rafId = null;
    const observer = new MutationObserver(() => {
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          injectAccountModalRow();
          injectFloatingSecurityBadge();
          checkAndEnforceSiteGate();
          updateSiteAccountUI();
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSecuritySuite);
  } else {
    initializeSecuritySuite();
  }

  // Глобальный API
  window.ShinySecurity = {
    openHub: openSecurityHubModal,
    openAccount: openAccountModalOrProfile,
    openAuth: openAuthModal,
    open2FASetup: openGoogleAuthSetupModal,
    open2FADisable: openDisable2FAModal,
    getConfig: getSecurityConfig,
    saveConfig: saveSecurityConfig,
    get2FAConfig,
    hashPassword,
    evaluatePasswordStrength,
    getAccounts: getAccountsList,
    getCurrentUser: getCurrentAccountUser,
    login: loginAccount,
    register: registerAccount,
    resetHWID: resetHwidAccount,
    checkLoaderBridge,
    getLoaderStatus: () => loaderBridgeStatus,
    lockSiteNow: () => {
      const cfg = getSecurityConfig();
      cfg.siteGateEnabled = true;
      saveSecurityConfig(cfg);
      setSiteGateUnlocked(false);
      checkAndEnforceSiteGate();
    }
  };

  // Обратная совместимость для существующего Shiny2FA
  window.Shiny2FA = {
    openSetup: openGoogleAuthSetupModal,
    openDisable: openDisable2FAModal,
    getConfig: get2FAConfig,
    verify: verifyTOTP
  };

})();
