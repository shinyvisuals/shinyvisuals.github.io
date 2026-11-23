// ==========================================================================
// ShinyVisuals — Clean Interactive Client Logic
// Follows Hallmark & Impeccable standards: Accessible, smooth, zero slop.
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // 1. Toast Notification Utility
  let toastContainer = document.getElementById('svToastContainer');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'svToastContainer';
    document.body.appendChild(toastContainer);
  }

  window.showToast = function (message, icon = '✨') {
    const toast = document.createElement('div');
    toast.className = 'sv-toast';
    toast.innerHTML = `<span style="font-size:16px;">${icon}</span><span>${message}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.25s, transform 0.25s';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 250);
    }, 3800);
  };

  // 2. Interactive Before / After Comparison Slider
  const container = document.getElementById('svCompareContainer');
  const sideAfter = document.getElementById('svSideAfter');
  const handle = document.getElementById('svSliderHandle');

  if (container && sideAfter && handle) {
    let isDragging = false;
    let sliderPercent = 50;

    function setPosition(percent) {
      sliderPercent = Math.max(0, Math.min(100, percent));
      // Clip sideAfter from the left: it shows only starting from sliderPercent
      sideAfter.style.clipPath = `polygon(${sliderPercent}% 0, 100% 0, 100% 100%, ${sliderPercent}% 100%)`;
      handle.style.left = `${sliderPercent}%`;
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      const rect = container.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const offsetX = clientX - rect.left;
      const percent = (offsetX / rect.width) * 100;
      setPosition(percent);
    }

    container.addEventListener('mousedown', (e) => {
      isDragging = true;
      onPointerMove(e);
    });

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', () => isDragging = false);

    // Touch support
    container.addEventListener('touchstart', (e) => {
      isDragging = true;
      onPointerMove(e);
    }, { passive: true });

    window.addEventListener('touchmove', onPointerMove, { passive: true });
    window.addEventListener('touchend', () => isDragging = false);

    // Initial 50% split
    setPosition(50);
  }

  // Global helper for user-provided real screenshots
  window.setComparisonImages = function (beforeUrl, afterUrl) {
    const imgBefore = document.getElementById('svImgBefore');
    const imgAfter = document.getElementById('svImgAfter');
    const fbBefore = document.getElementById('svFallbackBefore');
    const fbAfter = document.getElementById('svFallbackAfter');

    if (imgBefore && beforeUrl) {
      imgBefore.src = beforeUrl;
      imgBefore.classList.remove('hidden');
      if (fbBefore) fbBefore.classList.add('hidden');
    }

    if (imgAfter && afterUrl) {
      imgAfter.src = afterUrl;
      imgAfter.classList.remove('hidden');
      if (fbAfter) fbAfter.classList.add('hidden');
    }
  };

  // 3. Module Explorer Tabs
  const tabButtons = document.querySelectorAll('.sv-tab-btn');
  const tabPanes = document.querySelectorAll('.sv-tab-pane');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.add('hidden'));

      btn.classList.add('active');
      const activePane = document.getElementById(`tabContent-${targetTab}`);
      if (activePane) {
        activePane.classList.remove('hidden');
      }
    });
  });

  // 4. Download Feedback Hooks
  const downloadLinks = document.querySelectorAll('a[href*=".exe"], a[href*=".jar"], a[href*="download"]');
  downloadLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) return; // Smooth scroll link
      const fileName = href.split('/').pop() || 'ShinyVisuals';
      if (window.showToast) window.showToast(`Загрузка ${fileName}...`, '⚡');
    });
  });

  // 5. Mobile Navigation Menu Toggle
  const btnMobileMenu = document.getElementById('btnMobileMenu');
  const mobileMenu = document.getElementById('mobileMenu');
  if (btnMobileMenu && mobileMenu) {
    btnMobileMenu.addEventListener('click', () => {
      mobileMenu.classList.toggle('hidden');
    });

    mobileMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        mobileMenu.classList.add('hidden');
      });
    });
  }

  // 6. One-Click Web Auth from Loader (?auth_token=...)
  function checkUrlWebAuth() {
    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('auth_token');
      if (!token) return;

      const storedUser = (localStorage.getItem('shiny_user') || (window.ShinySecurity && window.ShinySecurity.get2FAConfig ? window.ShinySecurity.get2FAConfig().username : null) || 'deathproblem').trim();

      const overlay = document.createElement('div');
      overlay.className = 'twofactor-modal-backdrop';
      overlay.id = 'webAuthModal';
      overlay.innerHTML = `
        <div class="twofactor-modal-box" style="max-width: 440px; text-align: center; border-color: rgba(168,85,247,0.5); box-shadow: 0 0 35px rgba(168,85,247,0.3);">
          <div style="font-size: 38px; margin-bottom: 6px;">🔐</div>
          <h2 style="font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 6px;">Вход в ShinyVisuals Loader</h2>
          <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 16px; line-height: 1.5;">
            Лаунчер запрашивает подтверждение авторизации для аккаунта <strong style="color: #c084fc;">${storedUser}</strong>.
          </p>
          <div style="display: flex; gap: 10px;">
            <button id="btnApproveWebLogin" class="sv-btn-primary" style="flex: 1; justify-content: center; padding: 12px; font-weight: 700;">Подтвердить вход</button>
            <button id="btnRejectWebLogin" class="sv-btn-secondary" style="padding: 12px 18px;">Отмена</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      document.getElementById('btnRejectWebLogin').onclick = () => {
        overlay.remove();
        window.history.replaceState({}, document.title, window.location.pathname);
      };

      document.getElementById('btnApproveWebLogin').onclick = async () => {
        const btn = document.getElementById('btnApproveWebLogin');
        btn.disabled = true;
        btn.textContent = 'Подтверждение...';

        try {
          const resp = await fetch('http://localhost:26300/api/auth/approve-web-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, username: storedUser })
          });
          const data = await resp.json();
          if (data.success) {
            overlay.remove();
            window.history.replaceState({}, document.title, window.location.pathname);
            if (window.showToast) window.showToast(`✓ Вход в лаунчер подтверждён под аккаунтом ${storedUser}!`, '✨');
          } else {
            alert(data.error || 'Ошибка подтверждения входа');
            btn.disabled = false;
            btn.textContent = 'Подтвердить вход';
          }
        } catch (err) {
          alert('Не удалось связаться с лаунчером на порту 26300. Убедитесь, что ShinyVisuals Loader запущен на этом ПК.');
          btn.disabled = false;
          btn.textContent = 'Подтвердить вход';
        }
      };
    } catch(e) {}
  }
  checkUrlWebAuth();

  // 7. Проверка и запуск локального лоадера
  window.openOrLaunchLoader = async function () {
    try {
      const r = await fetch('http://localhost:26300/api/status', { method: 'GET' });
      const d = await r.json();
      if (d.online) {
        if (window.showToast) window.showToast(`🚀 Лоадер активен! Аккаунтов в базе: ${d.accountsCount || 1854}`, '⚡');
        return;
      }
    } catch (e) {}
    if (window.showToast) window.showToast('ℹ️ Запустите ярлык «ShinyVisuals Loader» на Рабочем столе для входа', '💻');
  };
});
