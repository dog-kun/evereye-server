/**
 * 管理后台页面（单文件内联 HTML，无构建步骤 / 无 CDN / 无新依赖）
 *
 * 刻意做成一个字符串常量而不是前端工程：这个后端的存在意义是「零维护、可弃」，
 * 为一个控制台引入打包链路不划算。页面只用原生 DOM + fetch，
 * 所有请求打自家 /api/console/*，配合 CSP（禁外链）在无 HTTPS 环境下把面减到最小。
 *
 * 注意：本文件是 TS 模板字符串，页面内的 JS 一律用字符串拼接，
 *       不要在里面写反引号或 ${}，否则会被 TS 当成插值。
 */
export const adminPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>恒易记账 · 控制台</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1e222b; --line: #2a2f3a;
    --text: #e6e8ee; --dim: #9aa3b2; --primary: #4c8dff; --danger: #ff5f56; --ok: #3ddc84;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  a { color: var(--primary); }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input, textarea, button, select {
    font: inherit; color: var(--text); background: var(--panel2);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--primary); }
  button { cursor: pointer; }
  button:hover { border-color: var(--primary); }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
  button.danger { color: var(--danger); border-color: #4a2b2b; }
  button.danger:hover { background: #2a1a1a; border-color: var(--danger); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .tabs button { background: transparent; border-color: transparent; color: var(--dim); }
  .tabs button.on { background: var(--panel); border-color: var(--line); color: var(--text); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .stat { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .stat b { display: block; font-size: 20px; font-weight: 700; }
  .stat span { color: var(--dim); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; white-space: nowrap; }
  td.mono, .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .muted { color: var(--dim); }
  .msg { padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; display: none; }
  .msg.err { display: block; background: #2a1a1a; border: 1px solid #4a2b2b; color: #ffb4b0; }
  .msg.ok { display: block; background: #14291d; border: 1px solid #24513a; color: #9be8bd; }
  .hide { display: none !important; }
  .warn { background: #2a2413; border: 1px solid #4a4020; color: #f0d79b; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
  .login { max-width: 380px; margin: 12vh auto 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); color: var(--dim); }
  .pill.on { color: var(--ok); border-color: #24513a; }
  .pill.off { color: var(--danger); border-color: #4a2b2b; }
  textarea { width: 100%; min-height: 120px; resize: vertical; }
</style>
</head>
<body>
<div class="wrap">

  <!-- 登录 -->
  <div id="loginView" class="login">
    <h1>恒易记账 · 控制台</h1>
    <p class="sub">站长后台。App 账号在这里登不进来。</p>
    <div id="loginMsg" class="msg"></div>
    <div id="disabledBox" class="warn hide">
      管理后台未启用。服务器需配置环境变量 <span class="mono">ADMIN_PASSWORD</span> 后重启容器。
    </div>
    <div id="loginBox" class="card">
      <div class="row">
        <input id="pw" type="password" placeholder="管理口令" style="flex:1" autocomplete="current-password" />
        <button class="primary" id="loginBtn">登录</button>
      </div>
      <p class="sub" style="margin:10px 0 0">
        当前部署无 HTTPS，口令在公网明文传输。建议配 <span class="mono">ADMIN_ALLOW_IPS</span> 白名单，
        或用 SSH 隧道访问 127.0.0.1。填白名单前先在「审计」页确认本机被记成哪个 IP，
        本机在 NAT 后，看到的可能不是你的真实地址。
      </p>
    </div>
  </div>

  <!-- 主体 -->
  <div id="mainView" class="hide">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h1>恒易记账 · 控制台</h1>
        <p class="sub" id="serverInfo">—</p>
      </div>
      <button id="logoutBtn">退出</button>
    </div>

    <div id="msg" class="msg"></div>

    <div class="tabs">
      <button data-tab="overview" class="on">概览</button>
      <button data-tab="users">用户</button>
      <button data-tab="delivery">分发</button>
      <button data-tab="maint">维护</button>
      <button data-tab="audit">审计</button>
    </div>

    <!-- 概览 -->
    <section id="tab-overview">
      <div class="card">
        <div class="grid" id="stats"></div>
      </div>
      <div class="card">
        <div class="row" style="gap:16px">
          <span>AI 通道 <span id="pillAi" class="pill">—</span></span>
          <span>CI 推送 <span id="pillPub" class="pill">—</span></span>
          <span class="muted mono" id="runtime">—</span>
        </div>
        <p class="sub" style="margin:12px 0 0">
          备份体积是<strong>密文</strong>体积。服务器没有数据密钥，看不到账目内容——有了后台也一样看不到。
        </p>
      </div>
    </section>

    <!-- 用户 -->
    <section id="tab-users" class="hide">
      <div class="card">
        <div class="row">
          <input id="q" placeholder="按邮箱搜索（留空=全部）" style="flex:1" />
          <button class="primary" id="searchBtn">搜索</button>
        </div>
      </div>
      <div class="card">
        <div class="muted" id="userCount">—</div>
        <table>
          <thead><tr>
            <th>邮箱</th><th>注册</th><th>设备</th><th>最近活跃</th><th>备份</th><th></th>
          </tr></thead>
          <tbody id="userRows"></tbody>
        </table>
        <div class="row" style="margin-top:12px">
          <button id="prevBtn">上一页</button>
          <button id="nextBtn">下一页</button>
          <span class="muted" id="pageInfo"></span>
        </div>
      </div>
      <div class="card hide" id="detailCard">
        <div class="row" style="justify-content:space-between">
          <strong id="detailEmail"></strong>
          <button id="closeDetail">关闭</button>
        </div>
        <table style="margin-top:10px">
          <thead><tr><th>设备</th><th>token</th><th>登录时间</th><th>最近活跃</th><th></th></tr></thead>
          <tbody id="sessionRows"></tbody>
        </table>
        <div class="row" style="margin-top:12px">
          <button class="danger" id="revokeAllBtn">踢全部设备下线</button>
          <button class="danger" id="deleteUserBtn">删除该账号（不可逆）</button>
        </div>
        <p class="sub" style="margin:10px 0 0">
          删号会连带删除其云备份与全部登录设备，且<strong>无法恢复</strong>；本机数据仍在用户手机上。
        </p>
      </div>
    </section>

    <!-- 分发 -->
    <section id="tab-delivery" class="hide">
      <div class="card">
        <div class="muted">当前更新清单（App 检查更新读它）</div>
        <pre class="mono" id="manifest" style="white-space:pre-wrap;margin:8px 0 0">—</pre>
        <div class="muted" id="apkInfo" style="margin-top:8px">—</div>
      </div>
      <div class="card">
        <div class="muted">更新说明（改完立即对所有客户端生效）</div>
        <textarea id="notes" placeholder="每行一条，App 更新弹窗按行展示"></textarea>
        <div class="row" style="margin-top:8px">
          <button class="primary" id="saveNotesBtn">保存说明</button>
          <span class="muted">安装包本身由 CI 推送，这里只改文案。</span>
        </div>
      </div>
    </section>

    <!-- 维护 -->
    <section id="tab-maint" class="hide">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <strong>清理过期数据</strong>
            <div class="muted">删除已过期的扫码配对码与管理票据。安全，随时可做。</div>
          </div>
          <button class="primary" id="cleanupBtn">执行</button>
        </div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <strong>收缩数据库</strong>
            <div class="muted">WAL 落盘 + VACUUM 重写库文件回收空间。会阻塞写入数秒到数十秒。</div>
          </div>
          <button class="danger" id="vacuumBtn">执行</button>
        </div>
      </div>
    </section>

    <!-- 审计 -->
    <section id="tab-audit" class="hide">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div class="muted">后台操作留痕（含登录失败）</div>
          <button id="reloadAuditBtn">刷新</button>
        </div>
        <table style="margin-top:10px">
          <thead><tr><th>时间</th><th>动作</th><th>目标</th><th>详情</th><th>来源 IP</th></tr></thead>
          <tbody id="auditRows"></tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<script>
(function () {
  'use strict';
  var API = '/api/console';
  var TOKEN_KEY = 'evereasy-admin-token';
  var token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }

  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  var bytes = function (n) {
    if (n == null) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  };
  var when = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  };
  var dur = function (ms) {
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d > 0 ? d + '天' : '') + (h > 0 ? h + '小时' : '') + m + '分';
  };
  var show = function (box, text, ok) {
    box.textContent = text;
    box.className = 'msg ' + (ok ? 'ok' : 'err');
    if (ok) setTimeout(function () { box.className = 'msg'; }, 4000);
  };

  /** 统一请求：自动带管理票据；401 视为登录过期，回登录页 */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== '/login') { logout(true); throw new Error('登录已过期，请重新登录'); }
        if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
        return data;
      });
    });
  }

  // ── 登录 ─────────────────────────────────────────────
  function logout(expired) {
    token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    el('mainView').classList.add('hide');
    el('loginView').classList.remove('hide');
    if (expired) show(el('loginMsg'), '登录已过期，请重新登录', false);
  }

  el('loginBtn').addEventListener('click', doLogin);
  el('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  function doLogin() {
    var pw = el('pw').value;
    if (!pw) return;
    el('loginBtn').disabled = true;
    api('/login', { method: 'POST', body: { password: pw } })
      .then(function (d) {
        token = d.token;
        try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        el('pw').value = '';
        el('loginMsg').className = 'msg';
        enterMain();
      })
      .catch(function (err) { show(el('loginMsg'), err.message, false); })
      .then(function () { el('loginBtn').disabled = false; });
  }

  el('logoutBtn').addEventListener('click', function () {
    api('/logout', { method: 'POST' }).catch(function () {}).then(function () { logout(false); });
  });

  function enterMain() {
    el('loginView').classList.add('hide');
    el('mainView').classList.remove('hide');
    loadOverview();
  }

  // ── 标签页 ───────────────────────────────────────────
  var loaders = {
    overview: loadOverview,
    users: function () { page = 0; loadUsers(); },
    delivery: loadDelivery,
    maint: function () {},
    audit: loadAudit
  };
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
        b.classList.toggle('on', b === btn);
      });
      ['overview', 'users', 'delivery', 'maint', 'audit'].forEach(function (name) {
        el('tab-' + name).classList.toggle('hide', name !== btn.dataset.tab);
      });
      loaders[btn.dataset.tab]();
    });
  });

  // ── 概览 ─────────────────────────────────────────────
  function loadOverview() {
    api('/overview').then(function (d) {
      var cards = [
        ['用户总数', d.users],
        ['近 7 天新增', d.newUsers7d],
        ['近 7 天活跃', d.activeUsers7d],
        ['登录设备', d.sessions],
        ['有云备份', d.backups],
        ['备份总量', bytes(d.backupBytes)],
        ['近 7 天同步', d.syncedThisWeek],
        ['待用配对码', d.pendingPairings],
        ['数据库体积', bytes(d.dbBytes)],
        ['进程内存', bytes(d.rssBytes)]
      ];
      el('stats').innerHTML = cards.map(function (c) {
        return '<div class="stat"><b>' + esc(c[1]) + '</b><span>' + esc(c[0]) + '</span></div>';
      }).join('');
      el('pillAi').className = 'pill ' + (d.aiConfigured ? 'on' : 'off');
      el('pillAi').textContent = d.aiConfigured ? '已配置' : '未配置';
      el('pillPub').className = 'pill ' + (d.publishConfigured ? 'on' : 'off');
      el('pillPub').textContent = d.publishConfigured ? '已配置' : '未配置';
      el('runtime').textContent = 'Node ' + d.nodeVersion + ' · 已运行 ' + dur(d.uptimeMs);
      el('serverInfo').textContent = '服务器时间 ' + when(d.serverTime);
    }).catch(function (err) { show(el('msg'), err.message, false); });
  }

  // ── 用户 ─────────────────────────────────────────────
  var page = 0, pageSize = 50, total = 0, currentUser = null;

  el('searchBtn').addEventListener('click', function () { page = 0; loadUsers(); });
  el('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { page = 0; loadUsers(); } });
  el('prevBtn').addEventListener('click', function () { if (page > 0) { page--; loadUsers(); } });
  el('nextBtn').addEventListener('click', function () {
    if ((page + 1) * pageSize < total) { page++; loadUsers(); }
  });
  el('closeDetail').addEventListener('click', function () {
    el('detailCard').classList.add('hide');
    currentUser = null;
  });

  function loadUsers() {
    var q = encodeURIComponent(el('q').value.trim());
    api('/users?q=' + q + '&limit=' + pageSize + '&offset=' + page * pageSize).then(function (d) {
      total = d.total;
      el('userCount').textContent = '共 ' + d.total + ' 个账号';
      el('pageInfo').textContent = '第 ' + (page + 1) + ' 页 / ' +
        Math.max(1, Math.ceil(d.total / pageSize)) + ' 页';
      el('prevBtn').disabled = page === 0;
      el('nextBtn').disabled = (page + 1) * pageSize >= d.total;
      if (d.users.length === 0) {
        el('userRows').innerHTML = '<tr><td colspan="6" class="muted">没有匹配的账号</td></tr>';
        return;
      }
      el('userRows').innerHTML = d.users.map(function (u) {
        var backup = u.backupVersion == null
          ? '<span class="muted">无</span>'
          : 'v' + u.backupVersion + ' · ' + bytes(u.backupBytes) + '<br><span class="muted">' + esc(when(u.backupAt)) + '</span>';
        return '<tr>' +
          '<td>' + esc(u.email) + '<br><span class="muted mono">' + esc(u.id) + '</span></td>' +
          '<td>' + esc(when(u.createdAt)) + '</td>' +
          '<td>' + u.devices + '</td>' +
          '<td>' + esc(when(u.lastSeen)) + '</td>' +
          '<td>' + backup + '</td>' +
          '<td><button data-uid="' + esc(u.id) + '" data-email="' + esc(u.email) + '">管理</button></td>' +
          '</tr>';
      }).join('');
      Array.prototype.forEach.call(el('userRows').querySelectorAll('button[data-uid]'), function (b) {
        b.addEventListener('click', function () { openUser(b.dataset.uid, b.dataset.email); });
      });
    }).catch(function (err) { show(el('msg'), err.message, false); });
  }

  function openUser(id, email) {
    currentUser = { id: id, email: email };
    el('detailEmail').textContent = email;
    el('detailCard').classList.remove('hide');
    loadSessions();
  }

  function loadSessions() {
    if (!currentUser) return;
    api('/users/' + encodeURIComponent(currentUser.id) + '/sessions').then(function (d) {
      if (d.sessions.length === 0) {
        el('sessionRows').innerHTML = '<tr><td colspan="5" class="muted">没有登录设备</td></tr>';
        return;
      }
      el('sessionRows').innerHTML = d.sessions.map(function (s) {
        return '<tr>' +
          '<td>' + esc(s.deviceName || '未命名设备') + '</td>' +
          '<td class="mono">' + esc(s.tokenPrefix) + '…</td>' +
          '<td>' + esc(when(s.createdAt)) + '</td>' +
          '<td>' + esc(when(s.lastSeen)) + '</td>' +
          '<td><button class="danger" data-prefix="' + esc(s.tokenPrefix) + '">踢下线</button></td>' +
          '</tr>';
      }).join('');
      Array.prototype.forEach.call(el('sessionRows').querySelectorAll('button[data-prefix]'), function (b) {
        b.addEventListener('click', function () {
          api('/users/' + encodeURIComponent(currentUser.id) + '/sessions/' + b.dataset.prefix,
            { method: 'DELETE' })
            .then(function () { show(el('msg'), '已踢下线', true); loadSessions(); loadUsers(); })
            .catch(function (err) { show(el('msg'), err.message, false); });
        });
      });
    }).catch(function (err) { show(el('msg'), err.message, false); });
  }

  el('revokeAllBtn').addEventListener('click', function () {
    if (!currentUser) return;
    if (!confirm('踢 ' + currentUser.email + ' 的全部设备下线？该用户需重新登录，本机数据不受影响。')) return;
    api('/users/' + encodeURIComponent(currentUser.id) + '/sessions', { method: 'DELETE' })
      .then(function (d) { show(el('msg'), '已踢下线 ' + d.revoked + ' 台设备', true); loadSessions(); loadUsers(); })
      .catch(function (err) { show(el('msg'), err.message, false); });
  });

  el('deleteUserBtn').addEventListener('click', function () {
    if (!currentUser) return;
    var typed = prompt('删除后云备份与登录设备一并消失，不可恢复。\\n请输入该账号邮箱确认：');
    if (typed == null) return;
    api('/users/' + encodeURIComponent(currentUser.id),
      { method: 'DELETE', body: { confirmEmail: typed.trim() } })
      .then(function () {
        show(el('msg'), '已删除账号 ' + currentUser.email, true);
        el('detailCard').classList.add('hide');
        currentUser = null;
        loadUsers();
      })
      .catch(function (err) { show(el('msg'), err.message, false); });
  });

  // ── 分发 ─────────────────────────────────────────────
  function loadDelivery() {
    api('/delivery').then(function (d) {
      el('manifest').textContent = d.manifest ? JSON.stringify(d.manifest, null, 2) : '暂无清单（等 CI 推送一次安装包）';
      el('apkInfo').textContent = d.apk
        ? '安装包 ' + bytes(d.apk.bytes) + ' · 更新于 ' + when(d.apk.mtime) + ' · 目录 ' + d.dir
        : '分发目录暂无安装包 · 目录 ' + d.dir;
      var notes = d.manifest && typeof d.manifest.notes === 'string' ? d.manifest.notes : '';
      el('notes').value = notes;
    }).catch(function (err) { show(el('msg'), err.message, false); });
  }

  el('saveNotesBtn').addEventListener('click', function () {
    api('/delivery/notes', { method: 'POST', body: { notes: el('notes').value } })
      .then(function () { show(el('msg'), '更新说明已保存', true); loadDelivery(); })
      .catch(function (err) { show(el('msg'), err.message, false); });
  });

  // ── 维护 ─────────────────────────────────────────────
  el('cleanupBtn').addEventListener('click', function () {
    api('/cleanup', { method: 'POST' })
      .then(function (d) {
        show(el('msg'), '已清理：配对码 ' + d.pairings + ' 条、过期票据 ' + d.adminSessions + ' 条', true);
      })
      .catch(function (err) { show(el('msg'), err.message, false); });
  });

  el('vacuumBtn').addEventListener('click', function () {
    if (!confirm('VACUUM 会重写整个数据库文件，期间写入被阻塞（大库可能数十秒）。继续？')) return;
    el('vacuumBtn').disabled = true;
    api('/vacuum', { method: 'POST' })
      .then(function () { show(el('msg'), '数据库已收缩', true); })
      .catch(function (err) { show(el('msg'), err.message, false); })
      .then(function () { el('vacuumBtn').disabled = false; });
  });

  // ── 审计 ─────────────────────────────────────────────
  el('reloadAuditBtn').addEventListener('click', loadAudit);

  function loadAudit() {
    api('/audit?limit=100').then(function (d) {
      if (d.entries.length === 0) {
        el('auditRows').innerHTML = '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
        return;
      }
      el('auditRows').innerHTML = d.entries.map(function (e) {
        return '<tr>' +
          '<td>' + esc(when(e.at)) + '</td>' +
          '<td class="mono">' + esc(e.action) + '</td>' +
          '<td class="mono">' + esc(e.target || '—') + '</td>' +
          '<td>' + esc(e.detail || '—') + '</td>' +
          '<td class="mono">' + esc(e.ip || '—') + '</td>' +
          '</tr>';
      }).join('');
    }).catch(function (err) { show(el('msg'), err.message, false); });
  }

  // ── 启动：先问后台是否启用，再决定显示什么 ─────────────
  fetch(API + '/status').then(function (r) { return r.json(); }).then(function (s) {
    if (!s.enabled) {
      el('disabledBox').classList.remove('hide');
      el('loginBox').classList.add('hide');
      return;
    }
    if (s.ipRestricted && !s.ipAllowed) {
      show(el('loginMsg'), '当前来源 IP 不在 ADMIN_ALLOW_IPS 白名单内，无法登录。', false);
      el('loginBox').classList.add('hide');
      return;
    }
    // 有票据先试着直接进（刷新页面不用重新输口令）
    if (token) {
      api('/overview').then(enterMain).catch(function () { logout(false); });
    }
  }).catch(function () {
    show(el('loginMsg'), '连不上服务器接口', false);
  });
})();
</script>
</body>
</html>
`;
