/**
 * ==========================================================================
 * ShinyVisuals — Google Authenticator (2FA TOTP RFC 6238)
 * Чистая двухфакторная аутентификация без блокировок DevTools и ПКМ
 * ==========================================================================
 */

(function () {
  'use strict';

  const FIREBASE_DB_URL = 'https://shinyvisualss-default-rtdb.firebaseio.com';
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  // --------------------------------------------------------------------------
  // 1. Определение текущего пользователя и хранилище настроек
  // --------------------------------------------------------------------------
  function detectCurrentUsername() {
    try {
      const raw = localStorage.getItem('shiny_current_user');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.username && typeof parsed.username === 'string' && parsed.username.trim()) {
            return parsed.username.trim();
          }
        } catch (e) {
          if (typeof raw === 'string' && raw.trim() && !raw.startsWith('{')) return raw.trim();
        }
      }

      const u1 = localStorage.getItem('shiny_username');
      if (u1 && typeof u1 === 'string' && u1.trim()) return u1.trim();

      const u2 = localStorage.getItem('shiny_user');
      if (u2 && typeof u2 === 'string' && u2.trim()) return u2.trim();

      const u3 = localStorage.getItem('launcher_username');
      if (u3 && typeof u3 === 'string' && u3.trim()) return u3.trim();

      const u4 = localStorage.getItem('username');
      if (u4 && typeof u4 === 'string' && u4.trim()) return u4.trim();
    } catch (e) {}

    // Fallback к пользователю по умолчанию
    return 'deathproblem';
  }

  function get2FAConfig(userOverride) {
    const user = (userOverride || detectCurrentUsername() || '').trim().toLowerCase();
    if (!user) {
      return { enabled: false, secret: null, username: '', backupCodes: [] };
    }
    const userKey = 'shiny_2fa_' + user;
    try {
      const data = localStorage.getItem(userKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed && parsed.enabled && parsed.secret) {
          parsed.username = userOverride || detectCurrentUsername();
          return parsed;
        }
      }
    } catch (e) {}

    return {
      enabled: false,
      secret: null,
      username: userOverride || detectCurrentUsername(),
      activatedAt: null,
      backupCodes: []
    };
  }

  async function save2FAConfig(cfg) {
    const user = (cfg.username || detectCurrentUsername() || '').trim();
    if (!user) return;
    const userKey = 'shiny_2fa_' + user.toLowerCase();

    try {
      localStorage.setItem(userKey, JSON.stringify(cfg));
      window.dispatchEvent(new CustomEvent('shiny_2fa_changed', { detail: cfg }));
    } catch (e) {}

    // Синхронизация с облачной базой Firebase
    try {
      await fetch(`${FIREBASE_DB_URL}/twofactor/${encodeURIComponent(user.toLowerCase())}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !!cfg.enabled,
          secret: cfg.enabled ? cfg.secret : null,
          backupCodes: cfg.enabled ? cfg.backupCodes : [],
          updatedAt: Date.now()
        })
      });
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 2. Base32 & TOTP (RFC 6238) на базе Web Crypto API
  // --------------------------------------------------------------------------
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

    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );

    const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, timeBuffer);
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
    if (!userCode || !secret) return false;
    const clean = userCode.toString().trim();
    if (clean.length !== 6) return false;

    // Окно проверки: -30с, текущие 30с, +30с (компенсация неточного времени)
    for (const offset of [-1, 0, 1]) {
      try {
        const expected = await generateTOTP(secret, offset);
        if (expected === clean) return true;
      } catch (e) {}
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // 3. Управление модальными окнами
  // --------------------------------------------------------------------------
  function closeActiveModal() {
    const modal = document.getElementById('twofactorModal');
    if (modal) modal.remove();
  }

  function setupDigitBoxes(onComplete) {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    if (!boxes.length) return;

    boxes.forEach((box, idx) => {
      box.value = '';

      box.oninput = (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val ? val[val.length - 1] : '';

        if (e.target.value && idx < boxes.length - 1) {
          boxes[idx + 1].focus();
        }

        const fullCode = Array.from(boxes).map(b => b.value).join('');
        if (fullCode.length === 6 && onComplete) {
          onComplete(fullCode);
        }
      };

      box.onkeydown = (e) => {
        if (e.key === 'Backspace' && !box.value && idx > 0) {
          boxes[idx - 1].focus();
        }
      };

      box.onpaste = (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (!text) return;
        for (let i = 0; i < text.length; i++) {
          if (boxes[i]) boxes[i].value = text[i];
        }
        const lastIdx = Math.min(text.length, boxes.length - 1);
        boxes[lastIdx].focus();
        if (text.length === 6 && onComplete) {
          onComplete(text);
        }
      };
    });

    setTimeout(() => { if (boxes[0]) boxes[0].focus(); }, 150);
  }

  function getDigitBoxCode() {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    return Array.from(boxes).map(b => b.value).join('');
  }

  function shakeBoxes() {
    const container = document.querySelector('.twofactor-input-container');
    if (!container) return;
    container.style.animation = 'none';
    container.offsetHeight; // reflow
    container.style.animation = 'twofactorShake 0.4s ease';
  }

  // --------------------------------------------------------------------------
  // 4. Модальное окно подключения Google Authenticator
  // --------------------------------------------------------------------------
  let pendingSecret = null;

  function openGoogleAuthSetupModal(targetUsername) {
    closeActiveModal();

    const username = (targetUsername || detectCurrentUsername() || 'deathproblem').trim();

    const secret = generateSecret(16);
    pendingSecret = secret;

    const formattedSecret = secret.match(/.{1,4}/g).join(' ');
    const issuer = 'ShinyVisuals';
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUrl)}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:24px;">🛡️</span>
            <div>
              <h2>Google Authenticator 2FA</h2>
              <p style="margin:2px 0 0 0;font-size:12px;color:#c084fc;">Двухфакторная защита аккаунта ${username}</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">✕</button>
        </div>

        <div class="twofactor-step-card">
          <div class="twofactor-step-label">
            <span class="twofactor-step-num">1</span>
            Отсканируйте QR-код в приложении
          </div>
          <p style="font-size:12.5px;color:#d8b4fe;margin:0 0 10px 0;">
            Откройте Google Authenticator, Authy или Яндекс Ключ и наведите камеру на QR-код:
          </p>
          <div class="twofactor-qr-wrapper">
            <img src="${qrUrl}" alt="2FA QR Code" onerror="this.outerHTML='<div style=\\'padding:20px;text-align:center;color:#333;font-size:12px;\\'>Используйте секретный ключ ниже</div>'" />
          </div>
        </div>

        <div class="twofactor-step-card">
          <div class="twofactor-step-label">
            <span class="twofactor-step-num">2</span>
            Или введите ключ вручную
          </div>
          <div class="twofactor-secret-row">
            <span class="twofactor-secret-key" id="txtSecretKey">${formattedSecret}</span>
            <button class="twofactor-copy-btn" id="btnCopySecret">Копировать</button>
          </div>
        </div>

        <div class="twofactor-step-card">
          <div class="twofactor-step-label">
            <span class="twofactor-step-num">3</span>
            Подтвердите 6-значный код
          </div>
          <p style="font-size:12px;color:#d8b4fe;margin:0 0 8px 0;">
            Введите текущий код из приложения для подтверждения:
          </p>
          <div class="twofactor-input-container">
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" />
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="1" inputmode="numeric" />
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="2" inputmode="numeric" />
            <span class="twofactor-digit-divider">-</span>
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="3" inputmode="numeric" />
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="4" inputmode="numeric" />
            <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="5" inputmode="numeric" />
          </div>
          <div class="twofactor-error-msg" id="msg2faError">
            Неверный код. Проверьте код в приложении и попробуйте снова.
          </div>
          <button class="twofactor-submit-btn" id="btnVerifyAndEnable">
            Включить защиту 2FA
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btn2faClose').onclick = closeActiveModal;

    const copyBtn = document.getElementById('btnCopySecret');
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(secret).then(() => {
        copyBtn.textContent = 'Скопировано!';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 2000);
      });
    };

    setupDigitBoxes(() => {
      document.getElementById('btnVerifyAndEnable').click();
    });

    document.getElementById('btnVerifyAndEnable').onclick = async () => {
      const code = getDigitBoxCode();
      const isValid = await verifyTOTP(pendingSecret, code);

      if (isValid) {
        const backupCodes = generateBackupCodes(4);
        const config = {
          enabled: true,
          secret: pendingSecret,
          username: username,
          activatedAt: Date.now(),
          backupCodes: backupCodes
        };
        await save2FAConfig(config);
        showSuccessModal(backupCodes);
      } else {
        const errorMsg = document.getElementById('msg2faError');
        if (errorMsg) errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function showSuccessModal(backupCodes) {
    const modalBox = document.querySelector('.twofactor-modal-box');
    if (!modalBox) return;

    modalBox.innerHTML = `
      <div class="twofactor-modal-header">
        <div class="twofactor-header-title">
          <span style="font-size:28px;">✅</span>
          <div>
            <h2>2FA успешно включена!</h2>
            <p style="margin:2px 0 0 0;font-size:12px;color:#4ade80;">Google Authenticator активен</p>
          </div>
        </div>
        <button class="twofactor-close-btn" id="btn2faClose">✕</button>
      </div>

      <p style="font-size:13.5px;color:#e9d5ff;line-height:1.5;">
        Ваш аккаунт теперь надёжно защищён. При каждом входе потребуется одноразовый 6-значный код.
      </p>

      <div class="twofactor-step-card" style="margin-top:16px;">
        <div class="twofactor-step-label">
          🔑 Резервные коды для восстановления (сохраните их):
        </div>
        <div class="twofactor-backup-grid">
          ${backupCodes.map(c => `<div class="twofactor-backup-code">${c}</div>`).join('')}
        </div>
      </div>

      <button class="twofactor-submit-btn" id="btnFinishSuccess">
        Понятно, готово
      </button>
    `;

    document.getElementById('btn2faClose').onclick = closeActiveModal;
    document.getElementById('btnFinishSuccess').onclick = () => {
      closeActiveModal();
      refreshUI();
      setTimeout(() => {
        openAccountModal();
      }, 100);
    };
  }

  // --------------------------------------------------------------------------
  // 5. Модальное окно отключения 2FA
  // --------------------------------------------------------------------------
  function openDisable2FAModal(targetUsername) {
    closeActiveModal();
    const username = (targetUsername || detectCurrentUsername() || 'deathproblem').trim();
    if (!username) return;
    const cfg = get2FAConfig(username);

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:440px;">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:24px;">⚠️</span>
            <div>
              <h2>Отключение 2FA</h2>
              <p style="margin:2px 0 0 0;font-size:12px;color:#f87171;">Аккаунт: ${username}</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">✕</button>
        </div>

        <p style="font-size:13px;color:#e9d5ff;line-height:1.5;margin-bottom:14px;">
          Для отключения защиты введите текущий 6-значный код из Google Authenticator:
        </p>

        <div class="twofactor-input-container">
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" />
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

        <div style="display:flex;gap:10px;margin-top:16px;">
          <button class="twofactor-btn-danger" style="flex:1;" id="btnConfirmDisable">
            Отключить 2FA
          </button>
          <button class="twofactor-copy-btn" style="padding:10px 18px;" id="btnCancelDisable">
            Отмена
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btn2faClose').onclick = closeActiveModal;
    document.getElementById('btnCancelDisable').onclick = closeActiveModal;

    setupDigitBoxes(() => {
      document.getElementById('btnConfirmDisable').click();
    });

    document.getElementById('btnConfirmDisable').onclick = async () => {
      const code = getDigitBoxCode();
      const isValid = await verifyTOTP(cfg.secret, code);
      const isBackup = cfg.backupCodes && cfg.backupCodes.includes(code);

      if (isValid || isBackup) {
        await save2FAConfig({ enabled: false, secret: null, username: username, backupCodes: [] });
        closeActiveModal();
        refreshUI();
        setTimeout(() => {
          openAccountModal();
        }, 100);
      } else {
        const errorMsg = document.getElementById('msg2faError');
        if (errorMsg) errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  // --------------------------------------------------------------------------
  // 6. Проверка 2FA при входе (Login Interceptor)
  // --------------------------------------------------------------------------
  function promptLogin2FA(cfg, onSuccess) {
    closeActiveModal();
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

        <p style="font-size:13.5px;color:#e9d5ff;margin:0 0 16px 0;line-height:1.5;">
          Введите 6-значный код из Google Authenticator для входа в аккаунт <strong>${cfg.username}</strong>:
        </p>

        <div class="twofactor-input-container">
          <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" />
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
        closeActiveModal();
        if (onSuccess) onSuccess();
      } else {
        const errorMsg = document.getElementById('msg2faError');
        if (errorMsg) errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function hookLoginForm() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;

      // 0. Строгое игнорирование форм РЕГИСТРАЦИИ
      const formText = (form.innerText || '').toLowerCase();
      const submitBtn = form.querySelector('button[type="submit"]') || form.querySelector('button');
      const submitText = (submitBtn ? submitBtn.innerText : '').toLowerCase();

      const isRegistration = form.dataset.authType === 'register' ||
                             form.classList.contains('register-form') ||
                             form.querySelector('input[type="email"]') !== null ||
                             form.querySelectorAll('input[type="password"]').length > 1 ||
                             submitText.includes('регистрац') ||
                             submitText.includes('создать') ||
                             submitText.includes('register') ||
                             formText.includes('регистрац') ||
                             formText.includes('создать аккаунт');

      if (isRegistration) return;

      const userInp = form.querySelector('input[type="text"], input[name="username"], input[placeholder*="логин" i], input[placeholder*="ник" i], input[placeholder*="username" i]');
      const passInp = form.querySelector('input[type="password"]');
      if (!passInp) return;

      const username = userInp ? userInp.value.trim() : detectCurrentUsername();
      if (!username) return;

      const cfg = get2FAConfig(username);
      if (cfg && cfg.enabled && cfg.secret) {
        if (form.dataset.twofactorVerified === 'true') {
          form.dataset.twofactorVerified = '';
          return; // Разрешаем отправку после успешного ввода 2FA кода
        }

        e.preventDefault();
        e.stopPropagation();

        promptLogin2FA(cfg, () => {
          form.dataset.twofactorVerified = 'true';
          const btn = form.querySelector('button[type="submit"]') || form.querySelector('button');
          if (btn) btn.click();
          else form.submit();
        });
      }
    }, true);
  }

  // --------------------------------------------------------------------------
  // 7. Встраивание строки 2FA в профиль и плавающая кнопка
  // --------------------------------------------------------------------------
  function injectFloatingSecurityButton() {
    let btn = document.getElementById('shiny2faFloatingBtn');
    const username = detectCurrentUsername();

    // Если пользователь НЕ вошел в аккаунт — кнопка НЕ отображается!
    if (!username) {
      if (btn) btn.remove();
      return;
    }

    if (localStorage.getItem('shiny_dismiss_2fa_badge') === 'true') {
      if (btn) btn.remove();
      return;
    }

    const cfg = get2FAConfig(username);
    if (!btn) {
      btn = document.createElement('div');
      btn.className = 'twofactor-float-btn';
      btn.id = 'shiny2faFloatingBtn';
      document.body.appendChild(btn);
    }

    if (cfg.enabled) {
      btn.innerHTML = `
        <span style="font-size:16px;">🛡️</span>
        <span>2FA: <strong style="color:#4ade80;">Включено</strong></span>
        <span class="twofactor-float-close" title="Скрыть">&times;</span>
      `;
      btn.onclick = (e) => {
        if (e.target && e.target.classList.contains('twofactor-float-close')) {
          e.stopPropagation();
          btn.remove();
          localStorage.setItem('shiny_dismiss_2fa_badge', 'true');
          return;
        }
        openDisable2FAModal(username);
      };
    } else {
      btn.innerHTML = `
        <span style="font-size:16px;">🛡️</span>
        <span>2FA: <strong style="color:#c084fc;">Подключить</strong></span>
        <span class="twofactor-float-close" title="Скрыть">&times;</span>
      `;
      btn.onclick = (e) => {
        if (e.target && e.target.classList.contains('twofactor-float-close')) {
          e.stopPropagation();
          btn.remove();
          localStorage.setItem('shiny_dismiss_2fa_badge', 'true');
          return;
        }
        openGoogleAuthSetupModal(username);
      };
    }
  }

  function refreshUI() {
    injectFloatingSecurityButton();
    const existing = document.getElementById('shiny2faModalRow');
    if (existing) existing.remove();
  }

  // --------------------------------------------------------------------------
  // 8. Инициализация при загрузке страницы
  // --------------------------------------------------------------------------
  function init() {
    refreshUI();
    hookLoginForm();

    window.addEventListener('storage', refreshUI);

    let raf = null;
    const observer = new MutationObserver(() => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = null;
          refreshUI();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('shiny_2fa_changed', refreshUI);

  // --- Модальное окно профиля аккаунта (UID, HWID, 2FA) ---
  function openAccountModal() {
    closeActiveModal();
    if (localStorage.getItem('shiny_logged_out') === '1' && !localStorage.getItem('shiny_user')) {
      openLoginModal();
      return;
    }
    const storedUser = (localStorage.getItem('shiny_user') || detectCurrentUsername() || 'deathproblem').trim();
    const cfg = get2FAConfig(storedUser);
    const hwid = 'SHINY-6412-B285-28C5-EFED';

    const isOwner = storedUser.toLowerCase() === 'deathproblem' || storedUser.toLowerCase() === 'admin';
    const userUid = isOwner ? '#1' : '#' + (cfg.uid || '1850');
    const subBadge = isOwner
      ? `<span style="font-size:12px; font-weight:800; color:#fbbf24; background:rgba(251,191,36,0.15); padding:3px 10px; border-radius:6px; border:1px solid rgba(251,191,36,0.35); text-shadow:0 0 10px rgba(251,191,36,0.3);">👑 LIFETIME (OWNER)</span>`
      : `<span style="font-size:12px; font-weight:700; color:#10b981; background:rgba(16,185,129,0.1); padding:2px 8px; border-radius:6px; border:1px solid rgba(16,185,129,0.2);">FREE</span>`;

    const adminBtnHtml = isOwner ? `
      <div style="margin-top:10px;">
        <button id="btnOpenOwnerPanel" style="width:100%; padding:12px; border-radius:10px; background:linear-gradient(135deg, rgba(245,158,11,0.25), rgba(168,85,247,0.3)); border:1px solid rgba(245,158,11,0.5); color:#fef08a; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 0 20px rgba(245,158,11,0.25); transition:all 0.2s;">
          👑 Панель администратора (Owner Panel)
        </button>
      </div>
    ` : '';

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';
    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:480px;">
        <div class="twofactor-modal-header">
          <div class="twofactor-modal-title">
            <span style="font-size:18px;">👤</span>
            <span>Профиль игрока</span>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">&times;</button>
        </div>
        
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">UID</span>
            <span style="font-size:13px; font-family:monospace; font-weight:700; color:#fbbf24; text-shadow:0 0 10px rgba(251,191,36,0.3);">${userUid}</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">Никнейм</span>
            <span style="font-size:13px; font-weight:600; color:#ffffff;">${storedUser}</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">Подписка</span>
            ${subBadge}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">HWID ПК</span>
            <span style="font-size:11px; font-family:monospace; color:#cbd5e1;">${hwid}</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">Привязка HWID</span>
            <span style="font-size:12px; font-weight:600; color:#34d399;">✓ Активна на этом ПК</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px; background:rgba(147,51,234,0.05); border:1px solid rgba(147,51,234,0.2); border-radius:10px; margin-top:4px;">
            <div>
              <div style="font-size:13px; font-weight:600; color:#ffffff;">Google Authenticator (2FA)</div>
              <div style="font-size:11px; color:#94a3b8;">${cfg.enabled ? 'Двухфакторная защита активна' : 'Дополнительная защита аккаунта'}</div>
            </div>
            <button id="btnProfile2FA" style="padding:6px 12px; border-radius:8px; font-size:11px; font-weight:600; cursor:pointer; background:${cfg.enabled ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.2)'}; border:1px solid ${cfg.enabled ? 'rgba(239,68,68,0.3)' : 'rgba(168,85,247,0.4)'}; color:${cfg.enabled ? '#f87171' : '#d8b4fe'};">
              ${cfg.enabled ? 'Отключить' : 'Подключить'}
            </button>
          </div>
        </div>

        <div style="margin-top:16px;">
          <button id="btnCopyHwid" style="width:100%; padding:10px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color:#ffffff; font-size:13px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
            📋 Скопировать HWID
          </button>
        </div>
        ${adminBtnHtml}
        <div style="margin-top:10px;">
          <button id="btnProfileLogout" style="width:100%; padding:11px; border-radius:10px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); color:#fca5a5; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.22)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'">
            🚪 Выйти из аккаунта
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    backdrop.onclick = (e) => { if (e.target === backdrop) closeActiveModal(); };
    document.getElementById('btn2faClose').onclick = closeActiveModal;

    document.getElementById('btnCopyHwid').onclick = () => {
      navigator.clipboard.writeText(hwid).then(() => {
        if (window.showToast) window.showToast('HWID скопирован в буфер обмена', '📋');
        else alert('HWID скопирован: ' + hwid);
      }).catch(() => {});
    };

    document.getElementById('btnProfile2FA').onclick = () => {
      if (cfg.enabled) openDisable2FAModal(storedUser);
      else openGoogleAuthSetupModal(storedUser);
    };

    const btnAdmin = document.getElementById('btnOpenOwnerPanel');
    if (btnAdmin) {
      btnAdmin.onclick = () => {
        closeActiveModal();
        openAdminPanelModal();
      };
    }

    const btnLogout = document.getElementById('btnProfileLogout');
    if (btnLogout) {
      btnLogout.onclick = () => {
        localStorage.removeItem('shiny_user');
        localStorage.removeItem('shiny_username');
        localStorage.removeItem('shiny_auth_user');
        localStorage.removeItem('launcher_username');
        localStorage.removeItem('username');
        localStorage.setItem('shiny_logged_out', '1');
        closeActiveModal();
        if (window.showToast) window.showToast('🚪 Вы успешно вышли из аккаунта', '👋');
        else alert('Вы успешно вышли из аккаунта');
        setTimeout(() => {
          openLoginModal();
        }, 120);
      };
    }
  }

  // --- Модальное окно входа / смены аккаунта на сайте ---
  function openLoginModal() {
    closeActiveModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';
    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:420px; text-align:center;">
        <div class="twofactor-modal-header">
          <div class="twofactor-modal-title">
            <span style="font-size:18px;">🔑</span>
            <span>Вход в Личный кабинет</span>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">&times;</button>
        </div>
        
        <p style="font-size:13px; color:#94a3b8; margin:8px 0 16px 0; line-height:1.4;">
          Введите никнейм для входа в профиль ShinyVisuals
        </p>

        <div style="display:flex; flex-direction:column; gap:12px; text-align:left;">
          <div>
            <label style="font-size:12px; color:#cbd5e1; font-weight:600; display:block; margin-bottom:6px;">Никнейм</label>
            <input id="inputSiteLoginUser" type="text" placeholder="Введите никнейм (например, deathproblem)..." style="width:100%; box-sizing:border-box; padding:12px 14px; border-radius:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.12); color:#fff; font-size:14px; outline:none;" autocomplete="off" />
          </div>

          <div>
            <label style="font-size:12px; color:#cbd5e1; font-weight:600; display:block; margin-bottom:6px;">Пароль (опционально)</label>
            <input id="inputSiteLoginPass" type="password" placeholder="Пароль..." style="width:100%; box-sizing:border-box; padding:12px 14px; border-radius:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.12); color:#fff; font-size:14px; outline:none;" />
          </div>

          <div style="margin-top:6px;">
            <button id="btnSubmitSiteLogin" style="width:100%; padding:13px; border-radius:10px; background:linear-gradient(135deg, #a855f7, #6366f1); border:none; color:#ffffff; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 0 20px rgba(168,85,247,0.35); transition:all 0.2s;">
              Войти в профиль
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    backdrop.onclick = (e) => { if (e.target === backdrop) closeActiveModal(); };
    document.getElementById('btn2faClose').onclick = closeActiveModal;

    const input = document.getElementById('inputSiteLoginUser');
    if (input) input.focus();

    const doLogin = () => {
      const u = (input.value || '').trim();
      if (!u) {
        input.style.borderColor = '#ef4444';
        return;
      }
      localStorage.setItem('shiny_user', u);
      localStorage.setItem('shiny_username', u);
      localStorage.removeItem('shiny_logged_out');
      closeActiveModal();
      if (window.showToast) window.showToast(`✓ Вход выполнен под ником ${u}`, '✨');
      setTimeout(() => {
        openAccountModal();
      }, 100);
    };

    const btnSubmit = document.getElementById('btnSubmitSiteLogin');
    if (btnSubmit) btnSubmit.onclick = doLogin;
    if (input) input.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
    const passInput = document.getElementById('inputSiteLoginPass');
    if (passInput) passInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  }

  // --- 8. Полноценная панель управления владельца (Owner Admin Panel) ---
  async function openAdminPanelModal() {
    closeActiveModal();
    const storedUser = (localStorage.getItem('shiny_user') || detectCurrentUsername() || 'deathproblem').trim();

    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';
    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:920px; width:95%; max-height:88vh; padding:24px; border-color:rgba(245,158,11,0.5); box-shadow:0 0 50px rgba(245,158,11,0.25);">
        <div class="twofactor-modal-header" style="border-bottom:1px solid rgba(245,158,11,0.2); padding-bottom:14px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg, rgba(245,158,11,0.3), rgba(168,85,247,0.3)); border:1px solid rgba(245,158,11,0.5); display:flex; align-items:center; justify-content:center; font-size:22px;">
              👑
            </div>
            <div>
              <div style="display:flex; align-items:center; gap:8px;">
                <h3 style="font-size:18px; font-weight:800; color:#ffffff; margin:0;">Панель управления владельца</h3>
                <span style="font-size:10px; font-weight:800; color:#fbbf24; background:rgba(251,191,36,0.15); border:1px solid rgba(251,191,36,0.35); padding:2px 7px; border-radius:6px; text-transform:uppercase;">Owner Only</span>
              </div>
              <p style="font-size:12px; color:#94a3b8; margin:3px 0 0 0;">Управление базой данных игроков Firebase, сброс HWID и смена паролей в реальном времени</p>
            </div>
          </div>
          <button class="twofactor-close-btn" id="btnAdminClose" style="font-size:24px;">&times;</button>
        </div>

        <!-- Статистика -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:10px; margin-bottom:14px;">
          <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); padding:10px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; font-family:monospace;">Всего игроков в базе</div>
            <div id="admStatUsers" style="font-size:20px; font-weight:800; color:#ffffff; font-family:monospace; margin-top:2px;">...</div>
          </div>
          <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); padding:10px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; font-family:monospace;">Статус облачной базы</div>
            <div style="font-size:13px; font-weight:700; color:#4ade80; display:flex; align-items:center; gap:6px; margin-top:5px;">
              <span style="width:7px; height:7px; border-radius:50%; background:#4ade80; display:inline-block;"></span> Firebase RTDB Online
            </div>
          </div>
          <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); padding:10px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; font-family:monospace;">Владелец</div>
            <div style="font-size:14px; font-weight:700; color:#fef08a; margin-top:4px;">${storedUser} (#1)</div>
          </div>
        </div>

        <!-- Панель действий и поиск -->
        <div style="display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
          <input id="admSearch" type="text" placeholder="🔍 Поиск по никнейму, UID или email..." style="flex:1; min-width:220px; padding:9px 14px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); color:#fff; font-size:13px; outline:none;" />
          <button id="admBtnRefresh" style="padding:9px 14px; border-radius:8px; background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.3); color:#d8b4fe; font-size:12px; font-weight:600; cursor:pointer;">🔄 Обновить</button>
          <button id="admBtnAdd" style="padding:9px 14px; border-radius:8px; background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); color:#6ee7b7; font-size:12px; font-weight:600; cursor:pointer;">➕ Создать игрока</button>
        </div>

        <div id="admStatusMsg" style="display:none; padding:8px 12px; border-radius:8px; margin-bottom:10px; font-size:12px; font-weight:600;"></div>

        <!-- Таблица пользователей -->
        <div style="max-height:48vh; overflow-y:auto; border:1px solid rgba(255,255,255,0.07); border-radius:10px; background:rgba(0,0,0,0.25);">
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); color:#94a3b8; font-family:monospace; font-size:11px; text-transform:uppercase;">
                <th style="padding:10px 14px;">UID</th>
                <th style="padding:10px 14px;">Никнейм</th>
                <th style="padding:10px 14px;">Пароль</th>
                <th style="padding:10px 14px;">Роль</th>
                <th style="padding:10px 14px;">HWID ПК</th>
                <th style="padding:10px 14px; text-align:right;">Действия</th>
              </tr>
            </thead>
            <tbody id="admUsersList">
              <tr><td colspan="6" style="padding:28px; text-align:center; color:#94a3b8;">Загрузка пользователей из Firebase...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    backdrop.onclick = (e) => { if (e.target === backdrop) closeActiveModal(); };
    document.getElementById('btnAdminClose').onclick = closeActiveModal;

    let cachedUsers = [];

    function showStatus(text, isError = false) {
      const box = document.getElementById('admStatusMsg');
      if (!box) return;
      box.style.display = 'block';
      box.style.background = isError ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
      box.style.border = isError ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(16,185,129,0.3)';
      box.style.color = isError ? '#fca5a5' : '#86efac';
      box.textContent = text;
      setTimeout(() => { if (box) box.style.display = 'none'; }, 4000);
    }

    async function loadFirebaseData() {
      const tbody = document.getElementById('admUsersList');
      const statUsers = document.getElementById('admStatUsers');
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:28px; text-align:center; color:#94a3b8;">Загрузка пользователей из Firebase...</td></tr>`;

      try {
        const resp = await fetch(`${FIREBASE_DB_URL}/users.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        
        let users = [];
        if (Array.isArray(data)) {
          users = data.filter(Boolean);
        } else if (data && typeof data === 'object') {
          users = Object.entries(data).map(([k, v]) => ({ ...v, _firebaseKey: k }));
        }

        cachedUsers = users;
        if (statUsers) statUsers.textContent = users.length;
        renderUserTable(users);
      } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:28px; text-align:center; color:#f87171;">Ошибка загрузки базы данных: ${err.message}</td></tr>`;
      }
    }

    function renderUserTable(users) {
      const tbody = document.getElementById('admUsersList');
      if (!tbody) return;

      const q = (document.getElementById('admSearch')?.value || '').toLowerCase().trim();
      const filtered = users.filter(u => {
        if (!u) return false;
        const name = (u.username || '').toLowerCase();
        const mail = (u.email || '').toLowerCase();
        const uid = String(u.uuid || u.id || '');
        return !q || name.includes(q) || mail.includes(q) || uid.includes(q);
      });

      if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:24px; text-align:center; color:#94a3b8;">Пользователи не найдены</td></tr>`;
        return;
      }

      tbody.innerHTML = filtered.map(u => {
        const name = u.username || 'Unknown';
        const isUserOwner = name.toLowerCase() === 'deathproblem' || name.toLowerCase() === 'admin' || (u.role && u.role.toLowerCase() === 'owner');
        const uidStr = isUserOwner && name.toLowerCase() === 'deathproblem' ? '#1' : '#' + (u.uuid || u.id || '—');
        const roleBadge = isUserOwner 
          ? `<span style="font-size:10px; font-weight:800; color:#fbbf24; background:rgba(251,191,36,0.15); border:1px solid rgba(251,191,36,0.3); padding:2px 7px; border-radius:5px;">OWNER</span>`
          : `<span style="font-size:10px; font-weight:600; color:#94a3b8; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:2px 7px; border-radius:5px;">PLAYER</span>`;
        const hwidStr = u.hwid ? `<span style="font-family:monospace; color:#c084fc; font-size:11px;" title="${u.hwid}">${u.hwid.slice(0, 15)}...</span>` : `<span style="color:#64748b; font-size:11px;">Не привязан</span>`;
        const pwdStr = u.password || (u.passwordHash ? '••••••' : '—');
        const key = u._firebaseKey || u.id || u.uuid;

        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:10px 14px; font-family:monospace; font-weight:700; color:${isUserOwner ? '#fbbf24' : '#fff'};">${uidStr}</td>
            <td style="padding:10px 14px; font-weight:600; color:#fff;">${name}</td>
            <td style="padding:10px 14px; font-family:monospace; color:#cbd5e1;">${pwdStr}</td>
            <td style="padding:10px 14px;">${roleBadge}</td>
            <td style="padding:10px 14px;">${hwidStr}</td>
            <td style="padding:10px 14px; text-align:right;">
              <div style="display:inline-flex; gap:6px;">
                <button class="adm-btn-hwid" data-user="${name}" data-key="${key}" style="padding:4px 8px; border-radius:6px; background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.3); color:#d8b4fe; font-size:11px; cursor:pointer;" title="Сбросить привязку HWID">🔄 HWID</button>
                <button class="adm-btn-pwd" data-user="${name}" data-key="${key}" style="padding:4px 8px; border-radius:6px; background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.3); color:#93c5fd; font-size:11px; cursor:pointer;" title="Сменить пароль">🔑 Пароль</button>
                <button class="adm-btn-del" data-user="${name}" data-key="${key}" style="padding:4px 8px; border-radius:6px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; font-size:11px; cursor:pointer;" title="Удалить игрока">🗑️</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Обработчики кнопок таблицы
      tbody.querySelectorAll('.adm-btn-hwid').forEach(b => {
        b.onclick = async () => {
          const uName = b.getAttribute('data-user');
          const uKey = b.getAttribute('data-key');
          if (!confirm(`Сбросить HWID для игрока ${uName}? Игрок сможет войти с нового ПК.`)) return;
          try {
            await fetch(`${FIREBASE_DB_URL}/hwid/${encodeURIComponent(uName)}.json`, { method: 'DELETE' });
            if (uKey) await fetch(`${FIREBASE_DB_URL}/users/${uKey}/hwid.json`, { method: 'DELETE' });
            showStatus(`✓ HWID для ${uName} успешно сброшен!`);
            loadFirebaseData();
          } catch(e) {
            showStatus(`Ошибка сброса HWID: ${e.message}`, true);
          }
        };
      });

      tbody.querySelectorAll('.adm-btn-pwd').forEach(b => {
        b.onclick = async () => {
          const uName = b.getAttribute('data-user');
          const uKey = b.getAttribute('data-key');
          const newPass = prompt(`Введите новый пароль для игрока ${uName}:`);
          if (!newPass || newPass.trim().length < 3) return;
          try {
            await fetch(`${FIREBASE_DB_URL}/users/${uKey}/password.json`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(newPass.trim())
            });
            showStatus(`✓ Пароль для ${uName} изменён на «${newPass.trim()}»!`);
            loadFirebaseData();
          } catch(e) {
            showStatus(`Ошибка смены пароля: ${e.message}`, true);
          }
        };
      });

      tbody.querySelectorAll('.adm-btn-del').forEach(b => {
        b.onclick = async () => {
          const uName = b.getAttribute('data-user');
          const uKey = b.getAttribute('data-key');
          if (uName.toLowerCase() === 'deathproblem') {
            alert('Нельзя удалить аккаунт владельца deathproblem!');
            return;
          }
          if (!confirm(`Вы действительно хотите навсегда удалить аккаунт ${uName}?`)) return;
          try {
            await fetch(`${FIREBASE_DB_URL}/users/${uKey}.json`, { method: 'DELETE' });
            showStatus(`✓ Аккаунт ${uName} удалён!`);
            loadFirebaseData();
          } catch(e) {
            showStatus(`Ошибка удаления: ${e.message}`, true);
          }
        };
      });
    }

    document.getElementById('admSearch').oninput = () => renderUserTable(cachedUsers);
    document.getElementById('admBtnRefresh').onclick = loadFirebaseData;

    document.getElementById('admBtnAdd').onclick = async () => {
      const uName = prompt('Введите никнейм нового игрока:');
      if (!uName || uName.trim().length < 2) return;
      const uPass = prompt(`Введите пароль для ${uName.trim()}:`) || '1234';
      try {
        const newUuid = cachedUsers.reduce((m, u) => Math.max(m, u.uuid || u.id || 0), 0) + 1;
        const newUser = {
          id: String(newUuid),
          uuid: newUuid,
          username: uName.trim(),
          password: uPass.trim(),
          role: 'Player',
          createdAt: new Date().toISOString()
        };
        await fetch(`${FIREBASE_DB_URL}/users/${newUuid}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newUser)
        });
        showStatus(`✓ Игрок ${uName.trim()} успешно создан с UID #${newUuid}!`);
        loadFirebaseData();
      } catch(e) {
        showStatus(`Ошибка создания: ${e.message}`, true);
      }
    };

    loadFirebaseData();
  }

  // Закрытие модальных окон по Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeActiveModal();
    }
  });

  // Глобальный API
  window.Shiny2FA = {
    openSetup: openGoogleAuthSetupModal,
    openDisable: openDisable2FAModal,
    getConfig: get2FAConfig,
    verify: verifyTOTP,
    openAccount: openAccountModal,
    openLogin: openLoginModal,
    openAdmin: openAdminPanelModal
  };

  window.ShinySecurity = {
    open2FASetup: openGoogleAuthSetupModal,
    open2FADisable: openDisable2FAModal,
    get2FAConfig: get2FAConfig,
    openAccount: openAccountModal,
    openLogin: openLoginModal,
    openAdmin: openAdminPanelModal
  };
})();
