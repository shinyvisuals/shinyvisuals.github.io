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

  function injectAccountModalRow() {
    const existing = document.getElementById('shiny2faModalRow');
    const username = detectCurrentUsername();
    if (!username) {
      if (existing) existing.remove();
      return;
    }

    const modal = document.querySelector('.max-w-md, [role="dialog"]');
    if (!modal) return;

    // Не внедряем в окно входа или регистрации
    const modalText = (modal.innerText || '').toLowerCase();
    if (modalText.includes('вход в аккаунт') || modalText.includes('регистрация') || modal.querySelector('form')) {
      if (existing) existing.remove();
      return;
    }

    const cfg = get2FAConfig(username);

    if (existing) {
      const desc = existing.querySelector('.shiny-2fa-desc');
      if (desc) desc.textContent = cfg.enabled ? '✓ Защита активна (Google Authenticator)' : 'Нажмите для подключения Google Authenticator';
      const actionBtn = existing.querySelector('.shiny-2fa-action-btn');
      if (actionBtn) actionBtn.textContent = cfg.enabled ? 'Отключить' : 'Подключить';
      return;
    }

    // Ищем подходящее место в модалке (перед кнопкой выхода или после полей)
    const buttons = modal.querySelectorAll('button');
    let target = null;
    for (let btn of buttons) {
      const txt = (btn.textContent || '').trim().toLowerCase();
      if (txt.includes('выйти') || txt.includes('сменить') || txt.includes('hwid') || txt.includes('скачать')) {
        target = btn.parentElement || btn;
        break;
      }
    }

    const row = document.createElement('div');
    row.id = 'shiny2faModalRow';
    row.className = 'shiny-2fa-modal-row';
    row.innerHTML = `
      <div class="shiny-2fa-modal-left">
        <span class="shiny-2fa-icon">🛡️</span>
        <div class="shiny-2fa-text">
          <span class="shiny-2fa-title">Google Authenticator (2FA)</span>
          <span class="shiny-2fa-desc">${cfg.enabled ? '✓ Защита активна' : 'Нажмите для подключения защиты'}</span>
        </div>
      </div>
      <button type="button" class="shiny-2fa-action-btn">
        ${cfg.enabled ? 'Отключить' : 'Подключить'}
      </button>
    `;

    row.onclick = () => {
      if (cfg.enabled) openDisable2FAModal(username);
      else openGoogleAuthSetupModal(username);
    };

    if (target && target.parentElement) {
      target.parentElement.insertBefore(row, target);
    } else {
      modal.appendChild(row);
    }
  }

  function refreshUI() {
    injectFloatingSecurityButton();
    injectAccountModalRow();
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
    const storedUser = (localStorage.getItem('shiny_user') || detectCurrentUsername() || 'deathproblem').trim();
    const cfg = get2FAConfig(storedUser);
    const hwid = 'SHINY-6412-B285-28C5-EFED';

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
            <span style="font-size:13px; font-family:monospace; font-weight:700; color:#ffffff;">#7777</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">Никнейм</span>
            <span style="font-size:13px; font-weight:600; color:#ffffff;">${storedUser}</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:10px;">
            <span style="font-size:13px; color:#94a3b8;">Подписка</span>
            <span style="font-size:12px; font-weight:700; color:#10b981; background:rgba(16,185,129,0.1); padding:2px 8px; border-radius:6px; border:1px solid rgba(16,185,129,0.2);">FREE</span>
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
          <button id="btnCopyHwid" style="width:100%; padding:10px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color:#ffffff; font-size:13px; font-weight:600; cursor:pointer; display:flex; items-center; justify-content:center; gap:6px;">
            📋 Скопировать HWID
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
    openAccount: openAccountModal
  };

  window.ShinySecurity = {
    open2FASetup: openGoogleAuthSetupModal,
    open2FADisable: openDisable2FAModal,
    get2FAConfig: get2FAConfig,
    openAccount: openAccountModal
  };
})();
