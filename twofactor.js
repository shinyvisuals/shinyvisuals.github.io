// ShinyVisuals - Clean Minimal Shim (Security Hub & devtools/right-click blockers removed)
(function () {
  'use strict';

  // Очистка устаревших элементов и настроек
  try {
    const ids = ['shinySecurityHubModal', 'twofactorModal', 'shinySecurityFloatingBadge', 'shiny2faModalRow', 'shinyGateModal'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    localStorage.removeItem('shiny_sec_config');
    localStorage.removeItem('shiny_2fa_config');
    localStorage.removeItem('shiny_gate_unlocked');
  } catch (e) {}

  window.ShinySecurity = {
    openHub: () => {},
    openAccount: () => {},
    openAuth: () => {},
    open2FASetup: () => {},
    open2FADisable: () => {},
    getConfig: () => ({ antiDevTools: false, antiContextMenu: false, siteGateEnabled: false }),
    saveConfig: () => {},
    get2FAConfig: () => ({ enabled: false, secret: null, username: '', backupCodes: [] }),
    hashPassword: () => '',
    evaluatePasswordStrength: () => ({ score: 4, label: 'Сильный' })
  };

  window.Shiny2FA = {
    openSetup: () => {},
    openDisable: () => {},
    getConfig: () => ({ enabled: false }),
    verify: () => true
  };
})();
