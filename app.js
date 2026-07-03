const API_CONFIG = window.FIELD_REPORT_CONFIG || {};
const SCRIPT_URL = String(API_CONFIG.SCRIPT_URL || '').trim();
const ACTION_MAP = {
  getBootstrapData: 'bootstrap',
  getAdminReports: 'getAdminReports',
  createReport: 'createReport',
  login: 'login',
  updateReport: 'updateReport',
  saveSettings: 'saveSettings'
};
window.__INITIAL_PAGE__ = new URLSearchParams(window.location.search).get('page') || '';
const state = {
  token: sessionStorage.getItem('fieldReportToken') || '',
  user: null,
  settings: {},
  statuses: [],
  priorities: [],
  reports: [],
  adminReports: [],
  filters: { publicSearch: '', publicStatus: 'all', adminSearch: '', adminStatus: 'all' }
};

const pageTitles = {
  reportView: 'แจ้งเรื่องตรวจพื้นที่',
  trackView: 'ติดตามสถานะเรื่องแจ้ง',
  adminView: 'ผู้ดูแลระบบ'
};

document.addEventListener('DOMContentLoaded', function() {
  setupNavigation();
  setupForms();
  setDefaultDate();
  loadBootstrap();
  if (window.lucide) lucide.createIcons();
});

async function serverCall(name) {
  if (!SCRIPT_URL) {
    throw new Error('ยังไม่ได้ตั้งค่า SCRIPT_URL ในไฟล์ config.js');
  }
  const args = Array.prototype.slice.call(arguments, 1);
  const action = ACTION_MAP[name] || name;
  const payload = await normalizePayload(action, args[0]);
  if (action === 'bootstrap' || action === 'listReports' || action === 'login' || action === 'getAdminReports' || action === 'saveSettings') {
    return apiJsonp(action, payload);
  }
  if (action === 'createReport') {
    await apiPostNoCors(action, payload);
    await delay(4500);
    const fresh = await apiJsonp('bootstrap', {});
    return { ok: fresh && fresh.ok !== false, message: 'ส่งเรื่องเรียบร้อย', reports: fresh.reports || [], stats: fresh.stats || {} };
  }
  if (action === 'updateReport') {
    await apiPostNoCors(action, payload);
    await delay(4500);
    const admin = await apiJsonp('getAdminReports', { token: payload.token });
    const publicData = await apiJsonp('bootstrap', {});
    return {
      ok: admin && admin.ok !== false,
      message: 'บันทึกผลแก้ไขเรียบร้อย',
      reports: admin.reports || [],
      publicReports: publicData.reports || [],
      stats: admin.stats || {}
    };
  }
  await apiPostNoCors(action, payload);
  return { ok: true, message: 'ส่งข้อมูลเรียบร้อย' };
}

async function normalizePayload(action, data) {
  if (data instanceof HTMLFormElement) {
    return formToPayload(data);
  }
  return data == null ? {} : data;
}

async function formToPayload(form) {
  const payload = {};
  const entries = Array.from(new FormData(form).entries());
  for (const [key, value] of entries) {
    if (value instanceof File) {
      if (value.size > 0) {
        payload[key] = await fileToPayload(value);
      }
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

function fileToPayload(file) {
  if (file.size > 10 * 1024 * 1024) {
    return Promise.reject(new Error('ขนาดรูปภาพต้องไม่เกิน 10 MB'));
  }
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() {
      resolve({ name: file.name, type: file.type, size: file.size, data: reader.result });
    };
    reader.onerror = function() { reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ')); };
    reader.readAsDataURL(file);
  });
}

function apiJsonp(action, payload) {
  return new Promise(function(resolve, reject) {
    const callbackName = '__fieldReportJsonp_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    const params = new URLSearchParams({ action: action, callback: callbackName });
    if (payload && typeof payload === 'object') {
      Object.keys(payload).forEach(function(key) {
        const value = payload[key];
        if (value == null) return;
        params.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
      });
    }
    const cleanup = function() {
      delete window[callbackName];
      script.remove();
      clearTimeout(timer);
    };
    const timer = setTimeout(function() {
      cleanup();
      reject(new Error('เชื่อมต่อ Google Apps Script ไม่สำเร็จ'));
    }, 30000);
    window[callbackName] = function(result) {
      cleanup();
      resolve(result);
    };
    script.onerror = function() {
      cleanup();
      reject(new Error('โหลด API ไม่สำเร็จ ตรวจสอบ SCRIPT_URL ใน config.js'));
    };
    script.src = SCRIPT_URL + (SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?') + params.toString();
    document.head.appendChild(script);
  });
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function apiPostNoCors(action, payload) {
  const body = new URLSearchParams();
  body.set('payload', JSON.stringify(payload == null ? {} : payload));
  return fetch(SCRIPT_URL + (SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?') + new URLSearchParams({ action: action }).toString(), {
    method: 'POST',
    mode: 'no-cors',
    body: body.toString()
  });
}
function loadBootstrap() {
  setBusy(document.getElementById('refreshButton'), true);
  serverCall('getBootstrapData')
    .then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'โหลดข้อมูลไม่สำเร็จ');
      state.settings = result.settings || {};
      state.statuses = result.statuses || [];
      state.priorities = result.priorities || [];
      state.reports = result.reports || [];
      applySettings();
      populateStatusFilters();
      renderAll(result.stats || {});
      if (state.token) restoreAdminSession();
      const initial = String(window.__INITIAL_PAGE__ || '').toLowerCase();
      if (initial === 'login' || initial === 'adminpage' || initial === 'admin') showView('adminView');
      if (initial === 'table' || initial === 'track') showView('trackView');
    })
    .catch(showError)
    .finally(function() { setBusy(document.getElementById('refreshButton'), false); });
}

function setupNavigation() {
  document.querySelectorAll('[data-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      showView(button.dataset.view);
      document.querySelector('.sidebar').classList.remove('open');
    });
  });
  document.getElementById('mobileMenuButton').addEventListener('click', function() {
    document.querySelector('.sidebar').classList.toggle('open');
  });
  document.getElementById('refreshButton').addEventListener('click', loadBootstrap);
  document.getElementById('mapButton').addEventListener('click', function() {
    if (state.settings.mapUrl) window.open(state.settings.mapUrl, '_blank');
    else toast('ยังไม่ได้ตั้งค่าลิงก์แผนที่', true);
  });
}

function setupForms() {
  document.getElementById('reportForm').addEventListener('submit', submitReport);
  document.getElementById('loginForm').addEventListener('submit', submitLogin);
  document.getElementById('editForm').addEventListener('submit', submitEdit);
  document.getElementById('settingsForm').addEventListener('submit', submitSettings);
  document.getElementById('geoButton').addEventListener('click', captureLocation);
  document.getElementById('logoutButton').addEventListener('click', logoutAdmin);
  document.getElementById('settingsButton').addEventListener('click', openSettings);
  document.querySelectorAll('[data-close-modal]').forEach(function(button) { button.addEventListener('click', closeEditModal); });
  document.querySelectorAll('[data-close-settings]').forEach(function(button) { button.addEventListener('click', closeSettings); });
  document.getElementById('searchInput').addEventListener('input', function(e) { state.filters.publicSearch = e.target.value; renderPublicReports(); });
  document.getElementById('statusFilter').addEventListener('change', function(e) { state.filters.publicStatus = e.target.value; renderPublicReports(); });
  document.getElementById('adminSearchInput').addEventListener('input', function(e) { state.filters.adminSearch = e.target.value; renderAdminTable(); });
  document.getElementById('adminStatusFilter').addEventListener('change', function(e) { state.filters.adminStatus = e.target.value; renderAdminTable(); });
}

function setDefaultDate() {
  const input = document.querySelector('[name="reportDate"]');
  input.value = toLocalDatetimeValue(new Date());
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(function(view) { view.classList.toggle('active', view.id === viewId); });
  document.querySelectorAll('.nav-item').forEach(function(button) { button.classList.toggle('active', button.dataset.view === viewId); });
  document.getElementById('pageTitle').textContent = pageTitles[viewId] || pageTitles.reportView;
}

function applySettings() {
  const title = state.settings.appTitle || 'ระบบรับเรื่องตรวจพื้นที่';
  document.title = title;
  document.getElementById('appTitleSide').textContent = title;
  document.getElementById('organizationName').textContent = state.settings.organizationName || 'หน่วยงานของคุณ';
  document.getElementById('mapButton').disabled = !state.settings.mapUrl;
}

function populateStatusFilters() {
  const publicSelect = document.getElementById('statusFilter');
  const adminSelect = document.getElementById('adminStatusFilter');
  publicSelect.innerHTML = '<option value="all">ทุกสถานะ</option>' + state.statuses.map(function(s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
  adminSelect.innerHTML = publicSelect.innerHTML;
  const editStatus = document.querySelector('#editForm [name="status"]');
  const editPriority = document.querySelector('#editForm [name="priority"]');
  editStatus.innerHTML = state.statuses.map(function(s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
  editPriority.innerHTML = state.priorities.map(function(p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
}

function renderAll(stats) {
  renderStats(stats || buildLocalStats(state.reports));
  renderLatest();
  renderPublicReports();
  if (state.user) renderAdmin();
  if (window.lucide) lucide.createIcons();
}

function renderStats(stats) {
  setText('statTotal', stats.total || 0);
  setText('statProgress', stats.inProgress || 0);
  setText('statDone', stats.completed || 0);
  setText('statUrgent', stats.urgent || 0);
  setText('adminTotal', stats.total || 0);
  setText('adminReceived', stats.received || 0);
  setText('adminProgress', stats.inProgress || 0);
  setText('adminCompleted', stats.completed || 0);
}

function renderLatest() {
  const box = document.getElementById('latestList');
  const latest = state.reports.slice(0, 4);
  if (!latest.length) {
    box.innerHTML = '<div class="latest-item"><strong>ยังไม่มีเรื่องแจ้ง</strong><p>รายการล่าสุดจะแสดงที่นี่หลังมีผู้ส่งเรื่อง</p></div>';
    return;
  }
  box.innerHTML = latest.map(function(report) {
    return '<div class="latest-item"><strong>' + esc(report.locationName) + '</strong><p>' + esc(report.category) + ' · ' + esc(report.status) + '</p></div>';
  }).join('');
}

function renderPublicReports() {
  const box = document.getElementById('publicReports');
  const empty = document.getElementById('emptyPublic');
  const reports = filterReports(state.reports, state.filters.publicSearch, state.filters.publicStatus);
  empty.classList.toggle('hidden', reports.length > 0);
  box.innerHTML = reports.map(renderReportCard).join('');
  if (window.lucide) lucide.createIcons();
}

function renderReportCard(report) {
  return '<article class="report-card">' +
    '<div class="report-image-pair">' + imageSlot('ก่อน', report.beforeImageUrl) + imageSlot('หลัง', report.afterImageUrl) + '</div>' +
    '<div class="report-card-body">' +
      '<div class="card-meta"><span class="status-pill ' + statusClass(report.status) + '">' + esc(report.status) + '</span><span class="status-pill ' + priorityClass(report.priority) + '">' + esc(report.priority) + '</span></div>' +
      '<h4>' + esc(report.locationName) + '</h4>' +
      '<p>' + esc(report.problem) + '</p>' +
      '<p><strong>' + esc(report.id) + '</strong> · ' + esc(report.category) + '</p>' +
      (report.adminNote ? '<p>ผลดำเนินการ: ' + esc(report.adminNote) + '</p>' : '') +
    '</div></article>';
}

function imageSlot(label, url) {
  if (url) return '<div class="image-slot"><b>' + esc(label) + '</b><img src="' + escAttr(url) + '" alt="ภาพ' + escAttr(label) + '"></div>';
  return '<div class="image-slot"><b>' + esc(label) + '</b><span>ยังไม่มีภาพ</span></div>';
}

function submitReport(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  serverCall('createReport', form)
    .then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'ส่งเรื่องไม่สำเร็จ');
      state.reports = result.reports || state.reports;
      renderAll(result.stats || buildLocalStats(state.reports));
      form.reset();
      setDefaultDate();
      toast(result.report && result.report.id ? 'ส่งเรื่องเรียบร้อย เลขรับเรื่อง ' + result.report.id : 'ส่งเรื่องเรียบร้อย ระบบกำลังอัปเดตรายการ');
      showView('trackView');
    })
    .catch(showError)
    .finally(function() { setBusy(button, false); });
}

function captureLocation() {
  const button = document.getElementById('geoButton');
  if (!navigator.geolocation) {
    toast('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง', true);
    return;
  }
  setBusy(button, true);
  navigator.geolocation.getCurrentPosition(function(pos) {
    const coords = pos.coords.latitude.toFixed(6) + ',' + pos.coords.longitude.toFixed(6);
    const form = document.getElementById('reportForm');
    form.geoStamp.value = new Date().toISOString();
    form.geoCode.value = coords;
    form.geoAddress.value = 'https://www.google.com/maps?q=' + coords;
    toast('บันทึกพิกัดปัจจุบันแล้ว');
    setBusy(button, false);
  }, function(error) {
    toast(error.message || 'ไม่สามารถดึงตำแหน่งได้', true);
    setBusy(button, false);
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

function submitLogin(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  serverCall('login', Object.fromEntries(new FormData(form).entries()))
    .then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'เข้าสู่ระบบไม่สำเร็จ');
      state.token = result.token;
      state.user = result.user;
      state.adminReports = result.reports || [];
      state.settings = result.settings || state.settings;
      sessionStorage.setItem('fieldReportToken', state.token);
      applySettings();
      renderAdmin(result.stats);
      toast('เข้าสู่ระบบสำเร็จ');
      form.reset();
    })
    .catch(showError)
    .finally(function() { setBusy(button, false); });
}

function restoreAdminSession() {
  serverCall('getAdminReports', state.token)
    .then(function(result) {
      if (!result || !result.ok) throw new Error('session หมดอายุ');
      state.user = { displayName: 'ผู้ดูแลระบบ' };
      state.adminReports = result.reports || [];
      state.settings = result.settings || state.settings;
      applySettings();
      renderAdmin(result.stats);
    })
    .catch(function() { logoutAdmin(false); });
}

function renderAdmin(stats) {
  document.getElementById('loginPanel').classList.add('hidden');
  document.getElementById('adminPanel').classList.remove('hidden');
  document.getElementById('adminUserLabel').textContent = state.user && state.user.displayName ? 'เข้าสู่ระบบ: ' + state.user.displayName : '';
  renderStats(stats || buildLocalStats(state.adminReports));
  renderAdminTable();
}

function renderAdminTable() {
  const body = document.getElementById('adminTableBody');
  const rows = filterReports(state.adminReports, state.filters.adminSearch, state.filters.adminStatus);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">ไม่พบรายการ</td></tr>';
    return;
  }
  body.innerHTML = rows.map(function(report) {
    return '<tr>' +
      '<td><strong>' + esc(report.id) + '</strong><div class="row-sub">' + esc(report.createdAt || report.reportDate) + '</div></td>' +
      '<td><span class="status-pill ' + statusClass(report.status) + '">' + esc(report.status) + '</span></td>' +
      '<td>' + esc(report.category) + '</td>' +
      '<td><div class="row-title">' + esc(report.locationName) + '</div><div class="row-sub">' + esc(report.problem) + '</div></td>' +
      '<td><span class="status-pill ' + priorityClass(report.priority) + '">' + esc(report.priority) + '</span></td>' +
      '<td>' + esc(report.assignedTo || '-') + '</td>' +
      '<td class="action-cell"><button class="secondary-button" type="button" onclick="openEdit(\'' + escJs(report.id) + '\')"><i data-lucide="pencil"></i><span>แก้ไข</span></button></td>' +
    '</tr>';
  }).join('');
  if (window.lucide) lucide.createIcons();
}

function openEdit(id) {
  const report = state.adminReports.find(function(item) { return item.id === id; });
  if (!report) return;
  const modal = document.getElementById('editModal');
  const form = document.getElementById('editForm');
  form.token.value = state.token;
  form.reportId.value = report.id;
  form.status.value = report.status;
  form.priority.value = report.priority || 'ปกติ';
  form.assignedTo.value = report.assignedTo || '';
  form.adminNote.value = report.adminNote || '';
  form.afterImage.value = '';
  document.getElementById('editTitle').textContent = report.id + ' · ' + report.locationName;
  document.getElementById('editPreview').innerHTML = '<div class="preview-box">' + (report.beforeImageUrl ? '<img src="' + escAttr(report.beforeImageUrl) + '" alt="ภาพก่อนแก้ไข">' : '') + '<p>ก่อนแก้ไข</p></div>' +
    '<div class="preview-box">' + (report.afterImageUrl ? '<img src="' + escAttr(report.afterImageUrl) + '" alt="ภาพหลังแก้ไข">' : '') + '<p>หลังแก้ไข</p></div>';
  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}
window.openEdit = openEdit;

function submitEdit(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  serverCall('updateReport', form)
    .then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'บันทึกไม่สำเร็จ');
      state.adminReports = result.reports || state.adminReports;
      state.reports = result.publicReports || state.reports;
      renderAll(result.stats || buildLocalStats(state.adminReports));
      closeEditModal();
      toast(result.message || 'บันทึกเรียบร้อย');
    })
    .catch(showError)
    .finally(function() { setBusy(button, false); });
}

function openSettings() {
  const form = document.getElementById('settingsForm');
  form.APP_TITLE.value = state.settings.appTitle || '';
  form.ORGANIZATION_NAME.value = state.settings.organizationName || '';
  form.TELEGRAM_BOT_TOKEN.value = state.settings.telegramBotToken || '';
  form.TELEGRAM_CHAT_ID.value = state.settings.telegramChatId || '';
  form.MAP_URL.value = state.settings.mapUrl || '';
  form.DRIVE_FOLDER_ID.value = state.settings.driveFolderId || '';
  form.PUBLIC_LIST_ENABLED.value = state.settings.publicListEnabled === false ? 'FALSE' : 'TRUE';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function submitSettings(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  serverCall('saveSettings', { token: state.token, settings: data })
    .then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'บันทึกตั้งค่าไม่สำเร็จ');
      state.settings = result.settings || state.settings;
      applySettings();
      closeSettings();
      toast(result.message || 'บันทึกการตั้งค่าเรียบร้อย');
    })
    .catch(showError)
    .finally(function() { setBusy(button, false); });
}

function logoutAdmin(showMessage) {
  state.token = '';
  state.user = null;
  state.adminReports = [];
  sessionStorage.removeItem('fieldReportToken');
  document.getElementById('loginPanel').classList.remove('hidden');
  document.getElementById('adminPanel').classList.add('hidden');
  if (showMessage !== false) toast('ออกจากระบบแล้ว');
}

function closeEditModal() { document.getElementById('editModal').classList.add('hidden'); }
function closeSettings() { document.getElementById('settingsModal').classList.add('hidden'); }

function filterReports(reports, query, status) {
  const q = String(query || '').toLowerCase().trim();
  return reports.filter(function(report) {
    const statusOk = !status || status === 'all' || report.status === status;
    if (!q) return statusOk;
    const text = [report.id, report.category, report.locationName, report.problem, report.assignedTo, report.adminNote].join(' ').toLowerCase();
    return statusOk && text.indexOf(q) >= 0;
  });
}

function buildLocalStats(reports) {
  return reports.reduce(function(stats, report) {
    stats.total += 1;
    if (report.status === 'รับเรื่องแล้ว') stats.received += 1;
    if (report.status === 'กำลังดำเนินการ') stats.inProgress += 1;
    if (report.status === 'แก้ไขเสร็จสิ้น') stats.completed += 1;
    if (report.status === 'ยกเลิก') stats.canceled += 1;
    if (report.priority === 'เร่งด่วน' || report.priority === 'วิกฤต') stats.urgent += 1;
    return stats;
  }, { total: 0, received: 0, inProgress: 0, completed: 0, canceled: 0, urgent: 0 });
}

function statusClass(status) {
  if (status === 'แก้ไขเสร็จสิ้น') return 'done';
  if (status === 'กำลังดำเนินการ') return 'progress';
  if (status === 'ยกเลิก') return 'cancel';
  return 'received';
}

function priorityClass(priority) {
  if (priority === 'วิกฤต') return 'priority-pill critical';
  if (priority === 'เร่งด่วน') return 'priority-pill';
  return 'priority-pill normal';
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.innerHTML = '<i data-lucide="loader-2"></i><span>กำลังดำเนินการ</span>';
  } else if (button.dataset.originalText) {
    button.innerHTML = button.dataset.originalText;
  }
  if (window.lucide) lucide.createIcons();
}

function toast(message, isError) {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.classList.toggle('error', !!isError);
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function() { box.classList.remove('show'); }, 3600);
}

function showError(error) {
  toast(error && error.message ? error.message : String(error || 'เกิดข้อผิดพลาด'), true);
}

function setText(id, value) { document.getElementById(id).textContent = value; }

function toLocalDatetimeValue(date) {
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, function(char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char];
  });
}

function escAttr(value) { return esc(value).replace(/'/g, '&#39;'); }
function escJs(value) { return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }




