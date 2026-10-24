(function() {
    const sidebar = document.getElementById('accordionSidebar');
    if (!sidebar || sidebar.querySelector('.sidebar-account-nav')) return;

    const accountItem = document.createElement('li');
    accountItem.className = 'nav-item dropdown sidebar-account-nav';
    accountItem.innerHTML = `
        <a class="nav-link dropdown-toggle sidebar-account-trigger" href="#" id="sidebarAccountDropdown" role="button" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
            <i class="fas fa-user-circle fa-fw"></i>
            <span class="sidebar-account-name">Admin</span>
        </a>
        <div class="dropdown-menu shadow" aria-labelledby="sidebarAccountDropdown">
            <span class="dropdown-item-text small text-muted" id="sidebar-account-label">admin</span>
            <div class="dropdown-divider"></div>
            <a class="dropdown-item" href="#" id="sidebar-account-logout">
                <i class="fas fa-sign-out-alt fa-sm fa-fw mr-2 text-gray-400"></i>Đăng xuất
            </a>
        </div>`;
    sidebar.appendChild(accountItem);

    const mobileSidebarToggle = document.getElementById('sidebarToggleTop');
    function syncMobileSidebar() {
        if (window.innerWidth < 768) {
            sidebar.style.transform = sidebar.classList.contains('toggled') ? 'translateX(0)' : 'translateX(-105%)';
        } else {
            sidebar.style.removeProperty('transform');
        }
    }

    syncMobileSidebar();
    window.addEventListener('resize', syncMobileSidebar);

    if (mobileSidebarToggle) {
        mobileSidebarToggle.addEventListener('click', event => {
            if (window.innerWidth >= 768) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            document.body.classList.toggle('sidebar-toggled');
            sidebar.classList.toggle('toggled');
            syncMobileSidebar();
        }, true);
    }

    fetch('/api/auth/session')
        .then(response => response.ok ? response.json() : Promise.reject(new Error('Phiên đăng nhập đã hết hạn.')))
        .then(session => {
            accountItem.querySelector('.sidebar-account-name').textContent = session.username;
            accountItem.querySelector('#sidebar-account-label').textContent = session.username;
        })
        .catch(() => window.location.replace('/login.html'));

    accountItem.querySelector('#sidebar-account-logout').addEventListener('click', async event => {
        event.preventDefault();
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.replace('/login.html');
    });
})();
