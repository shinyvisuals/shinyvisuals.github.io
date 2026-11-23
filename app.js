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
  const downloadLinks = document.querySelectorAll('a[href*=".exe"], a[href*="download"]');
  downloadLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) return; // Smooth scroll link
      window.showToast('Началась загрузка ShinyVisuals Loader', '⚡');
    });
  });
});
