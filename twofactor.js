/**
 * ==========================================================================
 * ShinyVisuals / Palladium — Google Authenticator (2FA) Engine
 * Полноценная двухфакторная аутентификация TOTP (RFC 6238)
 * Поддержка встраивания в модальное окно аккаунта и формы входа
 * ==========================================================================
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'shiny_2fa_config';
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  // --------------------------------------------------------------------------
  // 1. Определение текущего пользователя и хранилище настроек 2FA
  // --------------------------------------------------------------------------
  function detectCurrentUsername() {
    // 1. Проверяем localStorage пользователя
    try {
      const userStr = localStorage.getItem('shiny_current_user');
      if (userStr) {
        const u = JSON.parse(userStr);
        if (u && (u.username || u.name)) return u.username || u.name;
      }
    } catch (e) {}

    // 2. Проверяем открытое модальное окно профиля
    try {
      const h3s = document.querySelectorAll('h3');
      for (let i = 0; i < h3s.length; i++) {
        const txt = (h3s[i].textContent || '').trim();
        if (txt && txt.length > 1 && !txt.includes(' ') && txt !== 'ShinyVisuals' && !txt.includes('Google')) {
          return txt;
        }
      }
    } catch (e) {}

    return 'deathproblem';
  }

  function get2FAConfig(userOverride) {
    const user = userOverride || detectCurrentUsername();
    const userKey = 'shiny_2fa_' + (user ? user.toLowerCase() : 'default');
    try {
      const data = localStorage.getItem(userKey) || localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        parsed.username = user;
        return parsed;
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
      const userKey = 'shiny_2fa_' + (user ? user.toLowerCase() : 'default');
      localStorage.setItem(userKey, JSON.stringify(cfg));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      // Dispatch custom event to notify all components
      window.dispatchEvent(new CustomEvent('shiny_2fa_changed', { detail: cfg }));
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 2. Base32 & TOTP (RFC 6238) алгоритм на базе Web Crypto API
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
    if (!userCode) return false;
    const clean = userCode.toString().trim();
    if (clean.length !== 6) return false;

    // Check time window: previous 30s, current 30s, next 30s (compensates for clock drift)
    for (const offset of [-1, 0, 1]) {
      try {
        const expected = await generateTOTP(secret, offset);
        if (expected === clean) return true;
      } catch (e) {}
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // 3. UI: Модальное окно Google Authenticator
  // --------------------------------------------------------------------------
  let pendingSecret = null;

  function openGoogleAuthSetupModal() {
    closeActiveModal();

    const username = detectCurrentUsername();
    const cfg = get2FAConfig(username);
    const secret = generateSecret(16);
    pendingSecret = secret;

    // Format secret for readability: "ABCD EFGH IJKL MNOP"
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
          <!-- Шаг 1 -->
          <div class="twofactor-step-card">
            <div class="twofactor-step-label">
              <span class="twofactor-step-num">1</span>
              <span>Отсканируйте QR-код в приложении:</span>
            </div>
            
            <div class="twofactor-qr-wrapper">
              <img src="${qrApiUrl}" alt="Google Authenticator QR Code" id="twofactorQrImg" />
            </div>

            <div style="font-size:12px;color:#e9d5ff;margin-bottom:6px;text-align:center;">
              Или введите ключ вручную в Google Authenticator:
            </div>
            <div class="twofactor-secret-row">
              <span class="twofactor-secret-key" id="txtSecretKey">${formattedSecret}</span>
              <button class="twofactor-copy-btn" id="btnCopySecret">📋 Скопировать</button>
            </div>
          </div>

          <!-- Шаг 2 -->
          <div class="twofactor-step-card">
            <div class="twofactor-step-label">
              <span class="twofactor-step-num">2</span>
              <span>Введите 6-значный код из Google Authenticator:</span>
            </div>

            <div class="twofactor-input-container">
              <input type="text" maxlength="1" class="twofactor-digit-box" data-idx="0" inputmode="numeric" autocomplete="one-time-code" autofocus />
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

    // Event Listeners
    document.getElementById('btn2faClose').onclick = closeActiveModal;
    backdrop.onclick = (e) => { if (e.target === backdrop) closeActiveModal(); };

    // Copy Secret
    const btnCopy = document.getElementById('btnCopySecret');
    btnCopy.onclick = () => {
      navigator.clipboard.writeText(secret).then(() => {
        btnCopy.textContent = '✓ Скопировано!';
        btnCopy.style.background = 'rgba(34, 197, 94, 0.4)';
        setTimeout(() => {
          btnCopy.textContent = '📋 Скопировать';
          btnCopy.style.background = '';
        }, 2000);
      });
    };

    // 6-digit PIN boxes behavior
    setupDigitBoxes(() => {
      document.getElementById('btnVerify2FA').click();
    });

    // Verification button
    document.getElementById('btnVerify2FA').onclick = async () => {
      const code = getDigitBoxCode();
      const errorMsg = document.getElementById('msg2faError');
      errorMsg.style.display = 'none';

      if (code.length !== 6) {
        errorMsg.textContent = 'Введите все 6 цифр кода.';
        errorMsg.style.display = 'block';
        return;
      }

      const isValid = await verifyTOTP(pendingSecret, code);
      if (isValid) {
        // Success! Enable 2FA
        const backupCodes = generateBackupCodes(4);
        cfg.enabled = true;
        cfg.secret = pendingSecret;
        cfg.username = username;
        cfg.activatedAt = Date.now();
        cfg.backupCodes = backupCodes;
        save2FAConfig(cfg);

        showSuccessScreen(backupCodes);
      } else {
        errorMsg.textContent = 'Неверный код Google Authenticator. Убедитесь, что время на смартфоне синхронизировано.';
        errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function showSuccessScreen(backupCodes) {
    const container = document.getElementById('setupStepContainer');
    if (!container) return;

    container.innerHTML = `
      <div class="twofactor-success-box">
        <div class="twofactor-success-icon">✓</div>
        <h3 style="font-size:20px;font-weight:700;margin:0 0 8px 0;color:#ffffff;">Двухфакторная защита активна!</h3>
        <p style="font-size:13.5px;color:#e9d5ff;margin:0 0 16px 0;opacity:0.9;">
          Ваш аккаунт надёжно защищён с помощью Google Authenticator.
        </p>

        <div style="text-align:left;background:rgba(255,255,255,0.03);border:1px solid rgba(168,85,247,0.3);border-radius:12px;padding:16px;">
          <div style="font-size:13px;font-weight:600;color:#c084fc;margin-bottom:6px;">
            ⚠️ Сохраните резервные коды восстановления:
          </div>
          <p style="font-size:12px;color:#e9d5ff;margin:0 0 10px 0;opacity:0.8;">
            Используйте их для входа, если потеряете доступ к телефону:
          </p>
          <div class="twofactor-backup-grid">
            ${backupCodes.map(c => `<div class="twofactor-backup-code">${c}</div>`).join('')}
          </div>
        </div>

        <button class="twofactor-submit-btn" style="margin-top:20px;" id="btnDone2FA">
          Готово
        </button>
      </div>
    `;

    document.getElementById('btnDone2FA').onclick = () => {
      closeActiveModal();
      refreshUI();
    };
  }

  function openDisable2FAModal() {
    closeActiveModal();

    const username = detectCurrentUsername();
    const cfg = get2FAConfig(username);
    const backdrop = document.createElement('div');
    backdrop.className = 'twofactor-modal-backdrop';
    backdrop.id = 'twofactorModal';

    backdrop.innerHTML = `
      <div class="twofactor-modal-box" style="max-width:420px;">
        <div class="twofactor-modal-header">
          <div class="twofactor-header-title">
            <span style="font-size:24px;">⚠️</span>
            <h2>Отключение 2FA</h2>
          </div>
          <button class="twofactor-close-btn" id="btn2faClose">✕</button>
        </div>

        <p style="font-size:14px;color:#e9d5ff;margin:0 0 16px 0;line-height:1.5;">
          Для подтверждения отключения двухфакторной защиты введите текущий 6-значный код из Google Authenticator:
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
          Неверный код подтверждения.
        </div>

        <button class="twofactor-submit-btn" id="btnConfirmDisable" style="background:rgba(239,68,68,0.8);border-color:rgba(239,68,68,0.5);">
          Подтвердить отключение
        </button>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.getElementById('btn2faClose').onclick = closeActiveModal;
    backdrop.onclick = (e) => { if (e.target === backdrop) closeActiveModal(); };

    setupDigitBoxes(() => {
      document.getElementById('btnConfirmDisable').click();
    });

    document.getElementById('btnConfirmDisable').onclick = async () => {
      const code = getDigitBoxCode();
      const isOtpValid = await verifyTOTP(cfg.secret, code);
      const isBackupValid = cfg.backupCodes && cfg.backupCodes.includes(code);

      if (isOtpValid || isBackupValid) {
        cfg.enabled = false;
        cfg.secret = null;
        cfg.activatedAt = null;
        cfg.backupCodes = [];
        save2FAConfig(cfg);
        closeActiveModal();
        refreshUI();
      } else {
        const errorMsg = document.getElementById('msg2faError');
        errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function closeActiveModal() {
    const modal = document.getElementById('twofactorModal');
    if (modal) modal.remove();
  }

  // --------------------------------------------------------------------------
  // 4. Вспомогательные функции для 6-значного ввода
  // --------------------------------------------------------------------------
  function setupDigitBoxes(onComplete) {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const val = box.value.replace(/\D/g, '');
        box.value = val ? val[0] : '';
        if (box.value && i < boxes.length - 1) {
          boxes[i + 1].focus();
        }
        if (i === boxes.length - 1 && getDigitBoxCode().length === 6 && onComplete) {
          onComplete();
        }
      });

      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].focus();
        }
      });

      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (pasted.length >= 6) {
          for (let j = 0; j < 6; j++) {
            boxes[j].value = pasted[j];
          }
          boxes[5].focus();
          if (onComplete) onComplete();
        }
      });
    });

    if (boxes.length > 0) boxes[0].focus();
  }

  function getDigitBoxCode() {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    let code = '';
    boxes.forEach(b => { code += b.value.trim(); });
    return code;
  }

  function shakeBoxes() {
    const boxes = document.querySelectorAll('.twofactor-digit-box');
    boxes.forEach(b => {
      b.style.borderColor = '#ef4444';
      b.style.transform = 'translateX(-4px)';
    });
    setTimeout(() => {
      boxes.forEach(b => { b.style.transform = 'translateX(4px)'; });
    }, 80);
    setTimeout(() => {
      boxes.forEach(b => { b.style.transform = ''; });
    }, 160);
  }

  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // 5. Встраивание 2FA прямо в модальное окно профиля (Account Modal)
  // --------------------------------------------------------------------------
  let isInjecting = false;

  function findModalRowsAnchor() {
    // 1. Быстрая проверка: если модального окна нет в DOM, выходим моментально (0 мс)
    const modal = document.querySelector('.max-w-md, [role="dialog"]');
    if (!modal) return null;

    // 2. Ищем кнопку "Сменить пароль" только внутри самого модального окна
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

    // 3. Резервный поиск по HWID
    const divs = modal.querySelectorAll('div');
    for (let i = 0; i < divs.length; i++) {
      if ((divs[i].textContent || '').includes('HWID')) {
        return { el: divs[i], pos: 'afterend', modal: modal };
      }
    }

    return null;
  }

  function updateAccountModalRowContent(row, cfg) {
    const rightSide = row.querySelector('#shiny2faModalRight');
    const desc = row.querySelector('.shiny-2fa-desc');
    if (!rightSide) return;

    const stateKey = cfg.enabled ? 'active' : 'inactive';
    // Защита от бесконечного цикла мутаций: если состояние уже установлено, ничего не перерисовываем
    if (row.dataset.state === stateKey) {
      return;
    }
    row.dataset.state = stateKey;

    if (cfg.enabled) {
      if (desc) desc.textContent = 'Двухфакторная защита активна';
      rightSide.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="shiny-2fa-badge-active">
            <span class="shiny-2fa-dot-active"></span>
            Активно
          </span>
          <button type="button" class="shiny-2fa-action-btn disable" id="btnRow2FADisable">Отключить</button>
        </div>
      `;
      const btnDis = rightSide.querySelector('#btnRow2FADisable');
      if (btnDis) {
        btnDis.onclick = (e) => {
          e.stopPropagation();
          openDisable2FAModal();
        };
      }
      row.onclick = () => openDisable2FAModal();
    } else {
      if (desc) desc.textContent = 'Дополнительная защита аккаунта';
      rightSide.innerHTML = `
        <button type="button" class="shiny-2fa-action-btn setup" id="btnRow2FASetup">Подключить</button>
      `;
      const btnSet = rightSide.querySelector('#btnRow2FASetup');
      if (btnSet) {
        btnSet.onclick = (e) => {
          e.stopPropagation();
          openGoogleAuthSetupModal();
        };
      }
      row.onclick = () => openGoogleAuthSetupModal();
    }
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
          updateAccountModalRowContent(existing, cfg);
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
            <span class="shiny-2fa-title">Google Authenticator (2FA)</span>
            <span class="shiny-2fa-desc">Дополнительная защита аккаунта</span>
          </div>
        </div>
        <div class="shiny-2fa-modal-right" id="shiny2faModalRight"></div>
      `;

      updateAccountModalRowContent(row, cfg);
      anchor.el.insertAdjacentElement(anchor.pos, row);
    } finally {
      isInjecting = false;
    }
  }

  // --------------------------------------------------------------------------
  // 6. Плавающая кнопка быстрого доступа (в углу)
  // --------------------------------------------------------------------------
  function injectFloatingSecurityButton() {
    let btn = document.getElementById('shiny2faFloatingBtn');
    if (btn) btn.remove();

    const cfg = get2FAConfig();
    btn = document.createElement('div');
    btn.className = 'twofactor-float-btn';
    btn.id = 'shiny2faFloatingBtn';

    if (cfg.enabled) {
      btn.innerHTML = `
        <span style="font-size:16px;">🛡️</span>
        <span>2FA: <strong style="color:#4ade80;">Включено</strong></span>
      `;
      btn.onclick = openDisable2FAModal;
    } else {
      btn.innerHTML = `
        <span style="font-size:16px;">🛡️</span>
        <span>Защита: <strong style="color:#c084fc;">Подключить 2FA</strong></span>
      `;
      btn.onclick = openGoogleAuthSetupModal;
    }

    document.body.appendChild(btn);
  }

  // --------------------------------------------------------------------------
  // 7. Перехват формы авторизации (Login Protection)
  // --------------------------------------------------------------------------
  function hookLoginForm() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;

      const userInp = form.querySelector('input[type="text"], input[name="username"], input[placeholder*="логин" i], input[placeholder*="ник" i], input[placeholder*="username" i]');
      const passInp = form.querySelector('input[type="password"]');

      if (userInp && passInp && !form.dataset.twofactorVerified) {
        const username = userInp.value.trim();
        const cfg = get2FAConfig(username);

        if (cfg.enabled && cfg.secret) {
          e.preventDefault();
          e.stopPropagation();

          promptLogin2FA(cfg, () => {
            form.dataset.twofactorVerified = 'true';
            const submitBtn = form.querySelector('button[type="submit"]') || form.querySelector('button');
            if (submitBtn) submitBtn.click();
            else form.submit();
          });
        }
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
          Введите 6-значный код из Google Authenticator для входа в аккаунт <strong>${cfg.username}</strong>:
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
        closeActiveModal();
        if (onSuccess) onSuccess();
      } else {
        const errorMsg = document.getElementById('msg2faError');
        errorMsg.style.display = 'block';
        shakeBoxes();
      }
    };
  }

  function refreshUI() {
    injectAccountModalRow();
    injectFloatingSecurityButton();
  }

  // --------------------------------------------------------------------------
  // 8. Инициализация и легковесный наблюдатель за DOM
  // --------------------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    refreshUI();
    hookLoginForm();

    // Защищённый от зацикливания и троттлированный наблюдатель через requestAnimationFrame
    let rafId = null;
    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (let i = 0; i < mutations.length; i++) {
        const t = mutations[i].target;
        if (t && t.id !== 'shiny2faModalRow' && t.id !== 'shiny2faModalRight') {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          injectAccountModalRow();
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Проверка только если модальное окно открыто
    setInterval(() => {
      if (document.querySelector('.max-w-md, [role="dialog"]')) {
        injectAccountModalRow();
      }
    }, 1000);
  });

  window.addEventListener('shiny_2fa_changed', refreshUI);

  // Global API
  window.Shiny2FA = {
    openSetup: openGoogleAuthSetupModal,
    openDisable: openDisable2FAModal,
    getConfig: get2FAConfig,
    verify: verifyTOTP
  };
})();
