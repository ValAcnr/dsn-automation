'use strict';

(function () {
  if (!sessionStorage.getItem('dsn_app_session')) {
    window.location.href = '/app/';
    return;
  }

  const NAV = [
    { href: '/app/dashboard.html', label: 'Dashboard intérimaires', icon: '&#9783;' },
    { href: '/app/conges.html',    label: 'Congés',                  icon: '&#9788;' },
  ];

  const cur = window.location.pathname;

  const style = document.createElement('style');
  style.textContent = `
    #dsn-sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 220px;
      background: #1a2f5a; color: #fff;
      display: flex; flex-direction: column;
      z-index: 200; box-shadow: 2px 0 8px rgba(0,0,0,.18);
    }
    .sb-header {
      display: flex; align-items: center; gap: 10px;
      padding: 18px 16px; border-bottom: 1px solid rgba(255,255,255,.12);
      flex-shrink: 0;
    }
    .sb-mark {
      width: 36px; height: 36px; background: #fff; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 11px; color: #1a2f5a;
      letter-spacing: -.5px; flex-shrink: 0;
    }
    .sb-name { font-size: 13px; font-weight: 700; letter-spacing: .2px; line-height: 1.3; }
    .sb-sub  { font-size: 10px; opacity: .55; text-transform: uppercase; letter-spacing: .5px; margin-top: 1px; }
    .sb-nav  { flex: 1; padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
    .sb-link {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: 8px; color: rgba(255,255,255,.72);
      text-decoration: none; font-size: 13px; font-weight: 500;
      transition: background .15s, color .15s;
    }
    .sb-link:hover  { background: rgba(255,255,255,.1); color: #fff; }
    .sb-link.active { background: rgba(255,255,255,.18); color: #fff; font-weight: 600; }
    .sb-icon { font-size: 17px; flex-shrink: 0; }
    .sb-logout {
      margin: 10px 8px; padding: 9px 12px; border-radius: 8px;
      background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.13);
      color: rgba(255,255,255,.65); font-size: 12px; cursor: pointer;
      font-family: inherit; text-align: left; transition: all .15s;
    }
    .sb-logout:hover { background: rgba(255,255,255,.14); color: #fff; }
    body { padding-left: 220px !important; }
  `;
  document.head.appendChild(style);

  const sidebar = document.createElement('aside');
  sidebar.id = 'dsn-sidebar';
  sidebar.innerHTML = `
    <div class="sb-header">
      <div class="sb-mark">DSN</div>
      <div>
        <div class="sb-name">DSN Transports</div>
        <div class="sb-sub">Espace interne</div>
      </div>
    </div>
    <nav class="sb-nav">
      ${NAV.map(p => {
        const active = cur.endsWith(p.href.split('/').pop()) ? ' active' : '';
        return `<a href="${p.href}" class="sb-link${active}">
          <span class="sb-icon">${p.icon}</span>${p.label}
        </a>`;
      }).join('')}
    </nav>
    <button class="sb-logout" onclick="dsnLogout()">&#x2192; Déconnexion</button>
  `;
  document.body.insertBefore(sidebar, document.body.firstChild);

  window.dsnLogout = function () {
    sessionStorage.removeItem('dsn_app_session');
    window.location.href = '/app/';
  };
})();
