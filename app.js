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
window.__INITIAL_EDIT__ = new URLSearchParams(window.location.search).get('edit') || '';
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
  statsView: 'รายงานสถิติระบบ',
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
  // For createReport / updateReport: use reliable form POST to hidden iframe, then fetch fresh data via JSONP
  updateLoadingMessage('กำลังบันทึกข้อมูล...');
  await apiPostForm(action, payload);
  updateLoadingMessage('กำลังอัปเดตตารางข้อมูล...');
  if (action === 'createReport') {
    const fresh = await apiJsonp('bootstrap', {});
    return { ok: fresh && fresh.ok !== false, message: 'ส่งเรื่องเรียบร้อย', report: fresh && fresh.reports && fresh.reports[0] ? fresh.reports[0] : null, reports: fresh.reports || [], stats: fresh.stats || {} };
  }
  if (action === 'updateReport') {
    const [admin, publicData] = await Promise.all([
      apiJsonp('getAdminReports', { token: payload.token }),
      apiJsonp('bootstrap', {})
    ]);
    return {
      ok: admin && admin.ok !== false,
      message: 'บันทึกผลแก้ไขเรียบร้อย',
      report: admin && admin.reports ? admin.reports.find(function(r) { return r.id === payload.reportId; }) : null,
      reports: admin && admin.reports ? admin.reports : [],
      publicReports: publicData && publicData.reports ? publicData.reports : [],
      stats: admin && admin.stats ? admin.stats : {}
    };
  }
  return { ok: true, message: 'ส่งข้อมูลเรียบร้อย' };
}

async function normalizePayload(action, data) {
  if (data instanceof HTMLFormElement) {
    return formToPayload(data);
  }
  if (typeof data === 'string' && (action === 'getAdminReports' || action === 'listReports' || action === 'saveSettings')) {
    return { token: data };
  }
  return data == null ? {} : data;
}

async function formToPayload(form) {
  const payload = {};
  const entries = Array.from(new FormData(form).entries());
  for (const [key, value] of entries) {
    if (value instanceof File) {
      if (value.size > 0) {
        updateLoadingMessage('กำลังบีบอัดรูปภาพ...');
        payload[key] = await fileToPayload(value);
      }
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

function compressImage(file, maxWidth, quality) {
  maxWidth = maxWidth || 800;
  quality = quality || 0.6;
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function() { reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ')); };
    reader.onload = function() {
      var img = new Image();
      img.onerror = function() { reject(new Error('ไม่สามารถอ่านรูปภาพได้')); };
      img.onload = function() {
        var w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({
          name: file.name.replace(/\.[^.]+$/, '.jpg'),
          type: 'image/jpeg',
          size: Math.round(dataUrl.length * 0.75),
          data: dataUrl
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function fileToPayload(file) {
  if (file.size > 10 * 1024 * 1024) {
    return Promise.reject(new Error('ขนาดรูปภาพต้องไม่เกิน 10 MB'));
  }
  if (file.type && file.type.indexOf('image/') === 0) {
    return compressImage(file, 800, 0.6);
  }
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
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

function apiPostForm(action, payload) {
  return new Promise(function(resolve) {
    var callbackId = 'cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.name = 'postFrame_' + callbackId;
    var resolved = false;
    var timer = setTimeout(function() {
      if (!resolved) { resolved = true; cleanup(); resolve(null); }
    }, 3500);
    function onMessage(event) {
      if (resolved) return;
      var data = event.data;
      if (data && data.source === 'field-report-api' && data.callbackId === callbackId) {
        resolved = true;
        cleanup();
        resolve(data.payload || null);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      setTimeout(function() { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 200);
    }
    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = SCRIPT_URL;
    form.target = iframe.name;
    function addField(name, value) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    addField('action', action);
    addField('callbackId', callbackId);
    addField('payload', JSON.stringify(payload == null ? {} : payload));
    document.body.appendChild(form);
    form.submit();
    form.remove();
  });
}

function loadBootstrap(isManual) {
  const manual = isManual === true || (isManual && isManual.type === 'click');
  setBusy(document.getElementById('refreshButton'), true);
  if (manual) showLoading('กำลังโหลดข้อมูลล่าสุด...');
  serverCall('getBootstrapData')
    .then(function(result) {
      if (manual) hideLoading();
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
      const initialEdit = String(window.__INITIAL_EDIT__ || '');
      const savedView = sessionStorage.getItem('activeViewId');
      if (initialEdit || initial === 'login' || initial === 'adminpage' || initial === 'admin') {
        showView('adminView');
      } else if (initial === 'table' || initial === 'track') {
        showView('trackView');
      } else if (initial === 'stats' || initial === 'report' || initial === 'analytics' || initial === 'statsview') {
        showView('statsView');
      } else if (savedView && !manual) {
        showView(savedView);
      }
      var urlParams = new URLSearchParams(window.location.search);
      if (initial === 'map' || urlParams.get('view') === 'map') {
        openCombinedMapModal();
        if (urlParams.get('fullscreen') === '1') {
          setTimeout(function() { toggleMapFullscreen(true); }, 200);
        }
      }
      if (manual) showSuccessPopup('โหลดข้อมูลล่าสุดเรียบร้อยแล้ว');
    })
    .catch(function(err) {
      if (manual) hideLoading();
      showError(err);
    })
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
    openCombinedMapModal();
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
  document.querySelectorAll('[data-close-map]').forEach(function(button) { button.addEventListener('click', closeCombinedMapModal); });
  var mapStatusFilterEl = document.getElementById('mapStatusFilter');
  if (mapStatusFilterEl) mapStatusFilterEl.addEventListener('change', renderCombinedMapMarkers);
  var mapCategoryFilterEl = document.getElementById('mapCategoryFilter');
  if (mapCategoryFilterEl) mapCategoryFilterEl.addEventListener('change', renderCombinedMapMarkers);
  var externalMapBtn = document.getElementById('openExternalMapButton');
  if (externalMapBtn) {
    externalMapBtn.addEventListener('click', function() {
      if (state.settings && state.settings.mapUrl) window.open(state.settings.mapUrl, '_blank');
      else toast('ยังไม่ได้ตั้งค่าลิงก์แผนที่ภายนอก', true);
    });
  }
  var fsBtn = document.getElementById('toggleFullscreenMapBtn');
  if (fsBtn) fsBtn.addEventListener('click', function() { toggleMapFullscreen(); });
  var fsHeaderBtn = document.getElementById('toggleFullscreenMapHeaderBtn');
  if (fsHeaderBtn) fsHeaderBtn.addEventListener('click', function() { toggleMapFullscreen(); });
  var newTabBtn = document.getElementById('openNewTabMapBtn');
  if (newTabBtn) newTabBtn.addEventListener('click', function() { openMapInNewWindow(); });
  var topMenuBtn1 = document.getElementById('toggleMapHeaderBtn');
  if (topMenuBtn1) topMenuBtn1.addEventListener('click', function() { toggleMapHeader(); });
  var topMenuBtn2 = document.getElementById('toggleMapHeaderBtnFilter');
  if (topMenuBtn2) topMenuBtn2.addEventListener('click', function() { toggleMapHeader(); });
  var topMenuBtn3 = document.getElementById('toggleMapHeaderBtnFooter');
  if (topMenuBtn3) topMenuBtn3.addEventListener('click', function() { toggleMapHeader(); });
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
  if (viewId) sessionStorage.setItem('activeViewId', viewId);
  document.querySelectorAll('.view').forEach(function(view) { view.classList.toggle('active', view.id === viewId); });
  document.querySelectorAll('.nav-item').forEach(function(button) { button.classList.toggle('active', button.dataset.view === viewId); });
  document.getElementById('pageTitle').textContent = pageTitles[viewId] || pageTitles.reportView;
  if (viewId === 'statsView') renderStatsView();
}

function applySettings() {
  const title = state.settings.appTitle || 'ระบบรับเรื่องตรวจพื้นที่';
  document.title = title;
  document.getElementById('appTitleSide').textContent = title;
  document.getElementById('organizationName').textContent = state.settings.organizationName || 'หน่วยงานของคุณ';
  document.getElementById('mapButton').disabled = false;
}

function populateStatusFilters() {
  const publicSelect = document.getElementById('statusFilter');
  const adminSelect = document.getElementById('adminStatusFilter');
  publicSelect.innerHTML = '<option value="all">ทุกสถานะ</option>' + state.statuses.map(function(s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
  adminSelect.innerHTML = publicSelect.innerHTML;
  const mapStatusSelect = document.getElementById('mapStatusFilter');
  if (mapStatusSelect) mapStatusSelect.innerHTML = publicSelect.innerHTML;
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
  renderStatsView();
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
  return '<article class="report-card" onclick="openReportDetail(\'' + escJs(report.id) + '\')" style="cursor:pointer">' +
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
  if (url) return '<div class="image-slot"><b>' + esc(label) + '</b><img src="' + escAttr(url) + '" alt="ภาพ' + escAttr(label) + '" onclick="openLightbox(\'' + escAttr(url) + '\', event)"></div>';
  return '<div class="image-slot"><b>' + esc(label) + '</b><span>ยังไม่มีภาพ</span></div>';
}

function openReportDetail(id) {
  var report = state.reports.find(function(r) { return r.id === id; });
  if (!report && state.adminReports.length) report = state.adminReports.find(function(r) { return r.id === id; });
  if (!report) return;
  var modal = document.getElementById('detailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'detailModal';
    modal.className = 'modal hidden';
    modal.style.zIndex = '45';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = '<div class="modal-card detail-modal-card">' +
      '<div class="modal-heading"><div><p class="eyebrow">รายละเอียดเรื่องแจ้ง</p><h3 id="detailTitle"></h3></div>' +
      '<button class="icon-button" type="button" aria-label="ปิด" onclick="closeDetailModal()"><i data-lucide="x"></i></button></div>' +
      '<div id="detailImages" class="detail-images"></div>' +
      '<div id="detailBody" class="detail-body"></div>' +
      '</div>';
    document.body.appendChild(modal);
  }
  document.getElementById('detailTitle').textContent = report.id + ' · ' + report.locationName;
  var imgHtml = '<div class="detail-image-pair">';
  imgHtml += detailImageBox('ภาพก่อนแก้ไข', report.beforeImageUrl);
  imgHtml += detailImageBox('ภาพหลังแก้ไข', report.afterImageUrl);
  imgHtml += '</div>';
  document.getElementById('detailImages').innerHTML = imgHtml;
  var fields = [
    ['รหัสเรื่อง', report.id],
    ['สถานะ', '<span class="status-pill ' + statusClass(report.status) + '">' + esc(report.status) + '</span>'],
    ['ความเร่งด่วน', '<span class="status-pill ' + priorityClass(report.priority) + '">' + esc(report.priority) + '</span>'],
    ['ประเภท', report.category],
    ['สถานที่', report.locationName],
    ['รายละเอียดปัญหา', report.problem],
    ['วันที่แจ้ง', report.reportDate || report.createdAt],
    ['ผู้รับผิดชอบ', report.assignedTo],
    ['ฝ่ายรับผิดชอบแก้ไข', report.respDepartment],
    ['ผลดำเนินการ/หมายเหตุ', report.adminNote],
    ['วันที่แก้ไขเสร็จ', report.completedAt]
  ];
  if (report.geoAddress) fields.push(['พิกัด/แผนที่', '<a href="' + escAttr(report.geoAddress) + '" target="_blank" rel="noopener">เปิดแผนที่</a>']);
  var bodyHtml = '<dl class="detail-fields">';
  fields.forEach(function(f) {
    var val = f[1];
    if (!val && val !== 0) val = '-';
    var isHtml = String(val).indexOf('<') >= 0;
    bodyHtml += '<div class="detail-field"><dt>' + esc(f[0]) + '</dt><dd>' + (isHtml ? val : esc(val)) + '</dd></div>';
  });
  bodyHtml += '</dl>';
  document.getElementById('detailBody').innerHTML = bodyHtml;
  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}
window.openReportDetail = openReportDetail;

function detailImageBox(label, url) {
  if (url) return '<div class="detail-image-box"><p>' + esc(label) + '</p><img src="' + escAttr(url) + '" alt="' + escAttr(label) + '" onclick="openLightbox(\'' + escAttr(url) + '\', event)"></div>';
  return '<div class="detail-image-box empty"><p>' + esc(label) + '</p><span>ยังไม่มีภาพ</span></div>';
}

function closeDetailModal() {
  var modal = document.getElementById('detailModal');
  if (modal) modal.classList.add('hidden');
}
window.closeDetailModal = closeDetailModal;

function openLightbox(url, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  if (!url) return;
  var lb = document.getElementById('imageLightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'imageLightbox';
    lb.className = 'lightbox hidden';
    lb.innerHTML = '<div class="lightbox-backdrop" onclick="closeLightbox()"></div>' +
      '<div class="lightbox-content">' +
      '<button class="lightbox-close" onclick="closeLightbox()" aria-label="ปิด">&times;</button>' +
      '<img id="lightboxImg" src="" alt="ภาพขยาย">' +
      '</div>';
    document.body.appendChild(lb);
  }
  document.getElementById('lightboxImg').src = url;
  lb.classList.remove('hidden');
  requestAnimationFrame(function() { lb.classList.add('show'); });
}
window.openLightbox = openLightbox;

function closeLightbox() {
  var lb = document.getElementById('imageLightbox');
  if (lb) {
    lb.classList.remove('show');
    setTimeout(function() { lb.classList.add('hidden'); }, 250);
  }
}
window.closeLightbox = closeLightbox;

var combinedMapInstance = null;
var mapMarkerGroup = null;

function extractReportCoords(report) {
  if (!report) return null;
  var regex = /(-?\d{1,2}\.\d{2,8})\s*,\s*(-?\d{1,3}\.\d{2,8})/;
  var sources = [report.geoCode, report.geoAddress, report.locationName, report.problem];
  for (var i = 0; i < sources.length; i++) {
    if (sources[i]) {
      var match = String(sources[i]).match(regex);
      if (match) {
        var lat = parseFloat(match[1]);
        var lng = parseFloat(match[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0)) {
          return { lat: lat, lng: lng };
        }
      }
    }
  }
  return null;
}

function getMarkerIcon(status) {
  let color = '#ef4444';
  let innerSvg = '<path d="M16 11v5M16 19.5h.01" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>';
  if (status === 'กำลังดำเนินการ') {
    color = '#f59e0b';
    innerSvg = '<path d="M16 11.5v4.5l2.5 1.5" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (status === 'แก้ไขเสร็จสิ้น') {
    color = '#10b981';
    innerSvg = '<path d="M11.5 16l3 3 6-6" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') {
    color = '#8b5cf6';
    innerSvg = '<path d="M12 16h8m-3-3l3 3-3 3" stroke="#8b5cf6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (status === 'ยกเลิก') {
    color = '#64748b';
    innerSvg = '<path d="M12 12l8 8M20 12l-8 8" stroke="#64748b" stroke-width="2.2" stroke-linecap="round"/>';
  }

  const html = '<div class="pin-marker-inner" style="filter: drop-shadow(0px 4px 6px rgba(0,0,0,0.4)); cursor: pointer; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);">' +
    '<svg width="32" height="44" viewBox="0 0 32 44" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<ellipse cx="16" cy="41" rx="8" ry="2" fill="rgba(0, 0, 0, 0.28)"/>' +
      '<path d="M16 1C7.72 1 1 7.72 1 16c0 11.5 15 24 15 24s15-12.5 15-24C31 7.72 24.28 1 16 1z" fill="' + color + '" stroke="#ffffff" stroke-width="2.2"/>' +
      '<circle cx="16" cy="16" r="8.5" fill="#ffffff"/>' +
      innerSvg +
    '</svg>' +
  '</div>';
  
  if (typeof L !== 'undefined' && L.divIcon) {
    return L.divIcon({
      className: 'custom-map-marker-pin',
      html: html,
      iconSize: [32, 44],
      iconAnchor: [16, 40],
      popupAnchor: [0, -36]
    });
  }
  return null;
}

function createPopupContent(report) {
  let statusClass = 'received';
  if (report.status === 'กำลังดำเนินการ') statusClass = 'progress';
  if (report.status === 'แก้ไขเสร็จสิ้น') statusClass = 'completed';
  if (report.status === 'ส่งต่อ/ประสานหน่วยงานอื่น') statusClass = 'forwarded';
  if (report.status === 'ยกเลิก') statusClass = 'canceled';

  let imgHtml = '';
  if (report.beforeImageUrl) {
    imgHtml = '<div style="margin: 8px 0;"><img src="' + escAttr(report.beforeImageUrl) + '" style="width: 100%; max-height: 120px; object-fit: cover; border-radius: 6px; border: 1px solid #e2e8f0; display: block;" alt="รูปก่อนแก้ไข" onerror="this.style.display=\'none\'"></div>';
  }

  let html = '<div style="font-family: \'Sarabun\', sans-serif; min-width: 210px; max-width: 260px;">' +
    '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; gap: 8px;">' +
      '<span style="font-size: 11px; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; display: inline-block;">' + esc(report.category || 'ทั่วไป') + '</span>' +
      '<span class="status-pill ' + statusClass + '" style="font-size: 11px; padding: 2px 8px;">' + esc(report.status || 'รับเรื่องแล้ว') + '</span>' +
    '</div>' +
    '<h4 style="margin: 0 0 6px 0; font-size: 15px; color: #0f172a; line-height: 1.3;">' + esc(report.problem || '-') + '</h4>' +
    '<p style="margin: 0 0 4px 0; font-size: 13px; color: #334155;">📍 <strong>สถานที่:</strong> ' + esc(report.locationName || '-') + '</p>' +
    '<p style="margin: 0 0 6px 0; font-size: 12px; color: #64748b;">📅 <strong>วันที่:</strong> ' + esc(report.reportDate || report.createdAt || '-') + '</p>' +
    imgHtml +
    '<div style="display: flex; gap: 6px; margin-top: 10px;">' +
      '<button type="button" class="primary-button" style="padding: 6px 10px; font-size: 12px; flex: 1; justify-content: center;" onclick="window.openReportDetail(\'' + report.id + '\');">ดูรายละเอียด</button>';
      
  if (report.geoAddress) {
    html += '<a href="' + escAttr(report.geoAddress) + '" target="_blank" rel="noopener" class="secondary-button" style="padding: 6px 10px; font-size: 12px; text-decoration: none; display: flex; align-items: center; justify-content: center;">นำทาง</a>';
  }
  
  html += '</div></div>';
  return html;
}

function renderCombinedMapMarkers() {
  if (!combinedMapInstance || !mapMarkerGroup || typeof L === 'undefined') return;
  mapMarkerGroup.clearLayers();
  
  var statusVal = document.getElementById('mapStatusFilter') ? document.getElementById('mapStatusFilter').value : 'all';
  var categoryVal = document.getElementById('mapCategoryFilter') ? document.getElementById('mapCategoryFilter').value : 'all';
  
  var reports = (state.reports && state.reports.length) ? state.reports : (state.adminReports || []);
  
  var bounds = [];
  var count = 0;
  var totalWithCoords = 0;
  
  reports.forEach(function(r) {
    var coords = extractReportCoords(r);
    if (!coords) return;
    totalWithCoords++;
    
    if (statusVal !== 'all' && r.status !== statusVal) return;
    if (categoryVal !== 'all' && r.category !== categoryVal) return;
    
    count++;
    bounds.push([coords.lat, coords.lng]);
    
    var icon = getMarkerIcon(r.status);
    var marker = icon ? L.marker([coords.lat, coords.lng], { icon: icon }) : L.marker([coords.lat, coords.lng]);
    marker.bindPopup(createPopupContent(r), { maxWidth: 280, className: 'custom-map-popup' });
    mapMarkerGroup.addLayer(marker);
  });
  
  var statsEl = document.getElementById('mapStatsText');
  if (statsEl) {
    if (totalWithCoords === 0) {
      statsEl.textContent = 'ยังไม่มีเรื่องแจ้งที่มีพิกัด GPS ในระบบ (' + reports.length + ' เรื่องทั้งหมด)';
    } else {
      statsEl.textContent = 'แสดงจุดแจ้งเรื่อง ' + count + ' จาก ' + totalWithCoords + ' จุดที่มีพิกัด (รวมทั้งหมด ' + reports.length + ' รายการ)';
    }
  }
  
  if (bounds.length > 0) {
    if (bounds.length === 1) {
      combinedMapInstance.setView(bounds[0], 16);
    } else {
      combinedMapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  } else {
    combinedMapInstance.setView([13.70, 100.50], 12);
  }
}

function populateMapFilters() {
  const statusSelect = document.getElementById('mapStatusFilter');
  const categorySelect = document.getElementById('mapCategoryFilter');
  if (statusSelect && state.statuses) {
    const curStatus = statusSelect.value || 'all';
    statusSelect.innerHTML = '<option value="all">ทุกสถานะ</option>' + state.statuses.map(function(s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
    statusSelect.value = curStatus;
  }
  if (categorySelect) {
    const curCat = categorySelect.value || 'all';
    const defaultCats = ['ความสะอาด', 'ถนน/ทางเท้า', 'ไฟฟ้า/แสงสว่าง', 'น้ำท่วม/ระบายน้ำ', 'สิ่งกีดขวาง', 'ความปลอดภัย', 'อื่นๆ'];
    const catsSet = new Set(defaultCats);
    const reports = (state.reports && state.reports.length) ? state.reports : (state.adminReports || []);
    reports.forEach(function(r) { if (r && r.category) catsSet.add(r.category); });
    categorySelect.innerHTML = '<option value="all">ทุกประเภท</option>' + Array.from(catsSet).map(function(c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    categorySelect.value = curCat;
  }
}

function openCombinedMapModal() {
  if (typeof L === 'undefined') {
    toast('ไม่สามารถโหลดแผนที่ได้ (กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต)', true);
    if (state.settings && state.settings.mapUrl) window.open(state.settings.mapUrl, '_blank');
    return;
  }
  
  var modal = document.getElementById('mapModal');
  if (!modal) return;
  
  populateMapFilters();
  
  var extBtn = document.getElementById('openExternalMapButton');
  if (extBtn) {
    if (state.settings && state.settings.mapUrl) extBtn.classList.remove('hidden');
    else extBtn.classList.add('hidden');
  }
  
  modal.classList.remove('hidden');
  
  setTimeout(function() {
    if (!combinedMapInstance) {
      var container = document.getElementById('combinedMapContainer');
      if (container) {
        combinedMapInstance = L.map('combinedMapContainer', { zoomControl: false }).setView([13.70, 100.50], 12);
        L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=th&x={x}&y={y}&z={z}', {
          maxZoom: 20,
          subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
          attribution: '&copy; Google Maps'
        }).addTo(combinedMapInstance);
        
        var locateControl = L.control({ position: 'bottomright' });
        locateControl.onAdd = function() {
          var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
          container.style.backgroundColor = '#fff';
          container.style.cursor = 'pointer';
          container.style.width = '32px';
          container.style.height = '32px';
          container.style.display = 'flex';
          container.style.alignItems = 'center';
          container.style.justifyContent = 'center';
          container.style.marginBottom = '8px';
          container.title = 'แสดงตำแหน่งของคุณ / รวมทุกหมุด';
          container.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/></svg>';
          container.onclick = function(e) {
            L.DomEvent.stopPropagation(e);
            if (navigator.geolocation) {
              navigator.geolocation.getCurrentPosition(function(pos) {
                combinedMapInstance.setView([pos.coords.latitude, pos.coords.longitude], 16);
              }, function() {
                renderCombinedMapMarkers();
              });
            } else {
              renderCombinedMapMarkers();
            }
          };
          return container;
        };
        locateControl.addTo(combinedMapInstance);
        L.control.zoom({ position: 'bottomright' }).addTo(combinedMapInstance);
        mapMarkerGroup = L.layerGroup().addTo(combinedMapInstance);
      }
    }
    if (combinedMapInstance) {
      combinedMapInstance.invalidateSize();
      renderCombinedMapMarkers();
    }
    if (window.lucide) lucide.createIcons();
  }, 150);
}
window.openCombinedMapModal = openCombinedMapModal;

function closeCombinedMapModal() {
  var modal = document.getElementById('mapModal');
  if (modal) {
    modal.classList.add('hidden');
    if (modal.classList.contains('is-fullscreen')) {
      toggleMapFullscreen(false);
    }
    var card = modal.querySelector('.map-modal-card');
    if (card && card.classList.contains('is-collapsed-header')) {
      toggleMapHeader(false);
    }
  }
  var params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'map' || params.get('fullscreen') === '1') {
    var url = window.location.href.split('?')[0];
    if (history.replaceState) history.replaceState(null, '', url);
  }
}
window.closeCombinedMapModal = closeCombinedMapModal;

function toggleMapFullscreen(forceState) {
  var modal = document.getElementById('mapModal');
  if (!modal) return;
  var isFull = typeof forceState === 'boolean' ? forceState : !modal.classList.contains('is-fullscreen');
  modal.classList.toggle('is-fullscreen', isFull);
  
  var btnText = document.getElementById('toggleFullscreenMapText');
  var btnIcon = document.getElementById('toggleFullscreenMapIcon');
  var headerIcon = document.getElementById('toggleFullscreenMapHeaderIcon');
  var headerBtn = document.getElementById('toggleFullscreenMapHeaderBtn');
  
  if (btnText) btnText.textContent = isFull ? 'ย่อหน้าต่าง' : 'เต็มจอ';
  if (btnIcon) btnIcon.setAttribute('data-lucide', isFull ? 'minimize' : 'maximize');
  if (headerIcon) headerIcon.setAttribute('data-lucide', isFull ? 'minimize' : 'maximize');
  if (headerBtn) headerBtn.setAttribute('title', isFull ? 'ย่อหน้าต่าง' : 'ขยายเต็มจอ');
  
  if (window.lucide) lucide.createIcons();
  
  if (combinedMapInstance) {
    setTimeout(function() {
      combinedMapInstance.invalidateSize();
      if (isFull) {
        renderCombinedMapMarkers();
      }
    }, 150);
  }
}
window.toggleMapFullscreen = toggleMapFullscreen;

function openMapInNewWindow() {
  var url = window.location.href.split('?')[0] + '?view=map&fullscreen=1';
  window.open(url, '_blank');
}
window.openMapInNewWindow = openMapInNewWindow;

function toggleMapHeader(forceState) {
  var card = document.querySelector('.map-modal-card');
  if (!card) return;
  var isCol = typeof forceState === 'boolean' ? forceState : !card.classList.contains('is-collapsed-header');
  card.classList.toggle('is-collapsed-header', isCol);
  
  var headerIcon = document.getElementById('toggleMapHeaderIcon');
  var headerBtn = document.getElementById('toggleMapHeaderBtn');
  var filterBtnText = document.getElementById('toggleMapHeaderBtnFilterText');
  var filterBtnIcon = document.getElementById('toggleMapHeaderBtnFilterIcon');
  var footerBtnText = document.getElementById('toggleMapHeaderBtnFooterText');
  var footerBtnIcon = document.getElementById('toggleMapHeaderBtnFooterIcon');
  
  if (headerIcon) headerIcon.setAttribute('data-lucide', isCol ? 'chevrons-down' : 'chevrons-up');
  if (headerBtn) headerBtn.setAttribute('title', isCol ? 'แสดงเมนูด้านบน' : 'ซ่อนเมนูด้านบน');
  
  if (filterBtnText) filterBtnText.textContent = isCol ? 'แสดงเมนู' : 'ซ่อนเมนู';
  if (filterBtnIcon) filterBtnIcon.setAttribute('data-lucide', isCol ? 'chevrons-down' : 'chevrons-up');
  
  if (footerBtnText) footerBtnText.textContent = isCol ? 'แสดงเมนูบน' : 'ซ่อนเมนูบน';
  if (footerBtnIcon) footerBtnIcon.setAttribute('data-lucide', isCol ? 'chevrons-down' : 'chevrons-up');
  
  if (window.lucide) lucide.createIcons();
  
  if (combinedMapInstance) {
    setTimeout(function() {
      combinedMapInstance.invalidateSize();
    }, 150);
  }
}
window.toggleMapHeader = toggleMapHeader;



function submitReport(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  showLoading('กำลังเตรียมข้อมูล...');
  serverCall('createReport', form)
    .then(function(result) {
      hideLoading();
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'ส่งเรื่องไม่สำเร็จ');
      state.reports = result.reports || state.reports;
      renderAll(result.stats || buildLocalStats(state.reports));
      form.reset();
      setDefaultDate();
      showSuccessPopup(result.report && result.report.id ? 'ส่งเรื่องเรียบร้อย\nเลขรับเรื่อง ' + result.report.id : 'ส่งเรื่องเรียบร้อย');
      showView('trackView');
    })
    .catch(function(err) { hideLoading(); showError(err); })
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
  showLoading('กำลังตรวจสอบข้อมูลผู้ใช้...');
  serverCall('login', Object.fromEntries(new FormData(form).entries()))
    .then(function(result) {
      hideLoading();
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'เข้าสู่ระบบไม่สำเร็จ');
      state.token = result.token;
      state.user = result.user;
      state.adminReports = result.reports || [];
      state.settings = result.settings || state.settings;
      sessionStorage.setItem('fieldReportToken', state.token);
      const expireTime = Date.now() + 3600000;
      sessionStorage.setItem('fieldReportTokenExpire', expireTime.toString());
      applySettings();
      renderAdmin(result.stats);
      startSessionTimer();
      toast('เข้าสู่ระบบสำเร็จ');
      form.reset();
      const editId = window.__INITIAL_EDIT__;
      if (editId) {
        window.__INITIAL_EDIT__ = '';
        if (window.history && window.history.replaceState) {
          const url = new URL(window.location.href);
          if (url.searchParams.has('edit')) {
            url.searchParams.delete('edit');
            window.history.replaceState({}, document.title, url.toString());
          }
        }
        showView('adminView');
        setTimeout(function() { openEdit(editId); }, 200);
      }
    })
    .catch(function(err) { hideLoading(); showError(err); })
    .finally(function() { setBusy(button, false); });
}

function restoreAdminSession() {
  if (!checkSessionExpiration()) return;
  serverCall('getAdminReports', { token: state.token })
    .then(function(result) {
      if (!result || !result.ok) throw new Error('session หมดอายุ');
      state.user = { displayName: 'ผู้ดูแลระบบ' };
      state.adminReports = result.reports || [];
      state.settings = result.settings || state.settings;
      applySettings();
      renderAdmin(result.stats);
      startSessionTimer();
      const savedView = sessionStorage.getItem('activeViewId');
      if (savedView === 'adminView') showView('adminView');
      const editId = window.__INITIAL_EDIT__;
      if (editId) {
        window.__INITIAL_EDIT__ = '';
        if (window.history && window.history.replaceState) {
          const url = new URL(window.location.href);
          if (url.searchParams.has('edit')) {
            url.searchParams.delete('edit');
            window.history.replaceState({}, document.title, url.toString());
          }
        }
        showView('adminView');
        setTimeout(function() { openEdit(editId); }, 200);
      }
    })
    .catch(function() { logoutAdmin(false); });
}

function renderAdmin(stats) {
  document.getElementById('loginPanel').classList.add('hidden');
  document.getElementById('adminPanel').classList.remove('hidden');
  document.getElementById('adminUserLabel').textContent = state.user && state.user.displayName ? 'เข้าสู่ระบบ: ' + state.user.displayName : '';
  renderStats(stats || buildLocalStats(state.adminReports));
  renderAdminTable();
  renderStatsView();
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
      '<td><strong style="color:var(--ink);">' + esc(report.assignedTo || '-') + '</strong>' + (report.respDepartment ? '<div class="row-sub" style="color:#7c3aed;">' + esc(report.respDepartment) + '</div>' : '') + '</td>' +
      '<td class="action-cell"><button class="secondary-button" type="button" onclick="openReportDetail(\'' + escJs(report.id) + '\')"><i data-lucide="eye"></i><span>ดู</span></button><button class="secondary-button" type="button" onclick="openEdit(\'' + escJs(report.id) + '\')"><i data-lucide="pencil"></i><span>แก้ไข</span></button></td>' +
    '</tr>';
  }).join('');
  if (window.lucide) lucide.createIcons();
}

function openEdit(id) {
  if (!checkSessionExpiration()) return;
  const report = state.adminReports.find(function(item) { return item.id === id; });
  if (!report) {
    toast('ไม่พบข้อมูลเรื่องแจ้งรหัส ' + id);
    return;
  }
  if (window.history && window.history.replaceState) {
    const url = new URL(window.location.href);
    if (url.searchParams.has('edit')) {
      url.searchParams.delete('edit');
      window.history.replaceState({}, document.title, url.toString());
    }
  }
  const modal = document.getElementById('editModal');
  const form = document.getElementById('editForm');
  form.token.value = state.token;
  form.reportId.value = report.id;
  form.status.value = report.status;
  form.priority.value = report.priority || 'ปกติ';
  form.assignedTo.value = report.assignedTo || '';
  if (form.respDepartment) {
    // Select or fallback to empty (— ไม่ระบุ —)
    form.respDepartment.value = report.respDepartment || '';
  }
  form.adminNote.value = report.adminNote || '';
  form.afterImage.value = '';
  document.getElementById('editTitle').textContent = report.id + ' · ' + report.locationName;
  var problemEl = document.getElementById('editProblem');
  if (problemEl) problemEl.textContent = 'ปัญหา: ' + (report.problem || '-');
  document.getElementById('editPreview').innerHTML = '<div class="preview-box">' + (report.beforeImageUrl ? '<img src="' + escAttr(report.beforeImageUrl) + '" alt="ภาพก่อนแก้ไข" style="cursor:pointer" onclick="openLightbox(\'' + escAttr(report.beforeImageUrl) + '\', event)">' : '') + '<p>ก่อนแก้ไข</p></div>' +
    '<div class="preview-box">' + (report.afterImageUrl ? '<img src="' + escAttr(report.afterImageUrl) + '" alt="ภาพหลังแก้ไข" style="cursor:pointer" onclick="openLightbox(\'' + escAttr(report.afterImageUrl) + '\', event)">' : '') + '<p>หลังแก้ไข</p></div>';
  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}
window.openEdit = openEdit;

function submitEdit(event) {
  event.preventDefault();
  if (!checkSessionExpiration()) return;
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  showLoading('กำลังเตรียมข้อมูล...');
  serverCall('updateReport', form)
    .then(function(result) {
      hideLoading();
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'บันทึกไม่สำเร็จ');
      state.adminReports = result.reports || state.adminReports;
      state.reports = result.publicReports || state.reports;
      renderAll(result.stats || buildLocalStats(state.adminReports));
      closeEditModal();
      showSuccessPopup(result.message || 'บันทึกเรียบร้อย');
    })
    .catch(function(err) { hideLoading(); showError(err); })
    .finally(function() { setBusy(button, false); });
}

function openSettings() {
  if (!checkSessionExpiration()) return;
  const form = document.getElementById('settingsForm');
  form.APP_TITLE.value = state.settings.appTitle || '';
  form.ORGANIZATION_NAME.value = state.settings.organizationName || '';
  form.TELEGRAM_BOT_TOKEN.value = state.settings.telegramBotToken || '';
  form.TELEGRAM_CHAT_ID.value = state.settings.telegramChatId || '';
  form.MAP_URL.value = state.settings.mapUrl || '';
  form.DRIVE_FOLDER_ID.value = state.settings.driveFolderId || '';
  if (form.WEB_APP_URL) form.WEB_APP_URL.value = state.settings.webAppUrl || '';
  form.PUBLIC_LIST_ENABLED.value = state.settings.publicListEnabled === false ? 'FALSE' : 'TRUE';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function submitSettings(event) {
  event.preventDefault();
  if (!checkSessionExpiration()) return;
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true);
  showLoading('กำลังบันทึกการตั้งค่า...');
  serverCall('saveSettings', { token: state.token, settings: data })
    .then(function(result) {
      hideLoading();
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'บันทึกตั้งค่าไม่สำเร็จ');
      state.settings = result.settings || state.settings;
      applySettings();
      closeSettings();
      showSuccessPopup(result.message || 'บันทึกการตั้งค่าเรียบร้อย');
    })
    .catch(function(err) { hideLoading(); showError(err); })
    .finally(function() { setBusy(button, false); });
}

function logoutAdmin(showMessage) {
  clearTimeout(sessionTimerId);
  state.token = '';
  state.user = null;
  state.adminReports = [];
  sessionStorage.removeItem('fieldReportToken');
  sessionStorage.removeItem('fieldReportTokenExpire');
  if (sessionStorage.getItem('activeViewId') === 'adminView') {
    sessionStorage.setItem('activeViewId', 'reportView');
  }
  document.getElementById('loginPanel').classList.remove('hidden');
  document.getElementById('adminPanel').classList.add('hidden');
  if (showMessage !== false) toast('ออกจากระบบแล้ว');
}

let sessionTimerId = null;

function startSessionTimer() {
  clearTimeout(sessionTimerId);
  if (!state.token) return;
  let expire = Number(sessionStorage.getItem('fieldReportTokenExpire') || 0);
  if (!expire) {
    expire = Date.now() + 3600000;
    sessionStorage.setItem('fieldReportTokenExpire', expire.toString());
  }
  const remaining = expire - Date.now();
  if (remaining <= 0) {
    handleSessionExpired();
  } else {
    sessionTimerId = setTimeout(handleSessionExpired, Math.min(remaining, 2147483647));
  }
}

function checkSessionExpiration() {
  const expire = Number(sessionStorage.getItem('fieldReportTokenExpire') || 0);
  if (state.token && expire && Date.now() >= expire) {
    handleSessionExpired();
    return false;
  }
  return true;
}

function handleSessionExpired() {
  logoutAdmin(false);
  showSuccessPopup('เซสชันการใช้งานหมดอายุ (ครบ 1 ชั่วโมง)\nกรุณาเข้าสู่ระบบใหม่อีกครั้ง');
  showView('adminView');
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
    if (report.status === 'ส่งต่อ/ประสานหน่วยงานอื่น') stats.forwarded += 1;
    if (report.status === 'ยกเลิก') stats.canceled += 1;
    if (report.priority === 'เร่งด่วน' || report.priority === 'วิกฤต') stats.urgent += 1;
    return stats;
  }, { total: 0, received: 0, inProgress: 0, completed: 0, forwarded: 0, canceled: 0, urgent: 0 });
}

function statusClass(status) {
  if (status === 'แก้ไขเสร็จสิ้น') return 'done';
  if (status === 'กำลังดำเนินการ') return 'progress';
  if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') return 'forwarded';
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
  toast.timer = setTimeout(function() { box.classList.remove('show'); }, isError ? 5000 : 3600);
}

function showError(error) {
  toast(error && error.message ? error.message : String(error || 'เกิดข้อผิดพลาด'), true);
}

// --- Loading Overlay ---
function showLoading(message) {
  var overlay = document.getElementById('loadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="loading-card">' +
      '<div class="loading-spinner"></div>' +
      '<p class="loading-message">กำลังดำเนินการ...</p>' +
      '<p class="loading-hint">กรุณารอสักครู่ อย่าปิดหน้านี้</p>' +
      '</div>';
    document.body.appendChild(overlay);
  }
  overlay.querySelector('.loading-message').textContent = message || 'กำลังดำเนินการ...';
  overlay.classList.add('show');
  overlay.classList.remove('hidden');
  showLoading._startTime = Date.now();
  clearInterval(showLoading._timer);
  var elapsed = overlay.querySelector('.loading-elapsed');
  if (!elapsed) {
    elapsed = document.createElement('p');
    elapsed.className = 'loading-elapsed';
    overlay.querySelector('.loading-card').appendChild(elapsed);
  }
  elapsed.textContent = 'ผ่านไป 0 วินาที';
  showLoading._timer = setInterval(function() {
    var secs = Math.floor((Date.now() - showLoading._startTime) / 1000);
    elapsed.textContent = 'ผ่านไป ' + secs + ' วินาที';
  }, 1000);
}

function updateLoadingMessage(message) {
  var overlay = document.getElementById('loadingOverlay');
  if (overlay && overlay.classList.contains('show')) {
    overlay.querySelector('.loading-message').textContent = message;
  }
}

function hideLoading() {
  clearInterval(showLoading._timer);
  var overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(function() { overlay.classList.add('hidden'); }, 300);
  }
}

function showSuccessPopup(message) {
  var overlay = document.getElementById('successOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'successOverlay';
    overlay.className = 'success-overlay hidden';
    overlay.innerHTML = '<div class="success-card">' +
      '<div class="success-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>' +
      '<p class="success-message">สำเร็จ</p>' +
      '</div>';
    overlay.addEventListener('click', function() { overlay.classList.add('hidden'); overlay.classList.remove('show'); });
    document.body.appendChild(overlay);
  }
  overlay.querySelector('.success-message').textContent = message.replace(/\n/g, ' ');
  overlay.classList.remove('hidden');
  requestAnimationFrame(function() { overlay.classList.add('show'); });
  clearTimeout(showSuccessPopup._timer);
  showSuccessPopup._timer = setTimeout(function() {
    overlay.classList.remove('show');
    setTimeout(function() { overlay.classList.add('hidden'); }, 300);
  }, 2800);
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

function getReportMonthKey(r) {
  // ใช้ reportDate (วันที่รับเรื่อง) เป็นหลัก ถ้าไม่มีใช้ createdAt
  const raw = r.reportDate || r.createdAt || '';
  if (!raw) return null;
  let d = new Date(raw);
  if (isNaN(d.getTime())) {
    // Try DD/MM/YYYY or DD/M/YYYY (Google Sheets display format)
    const parts = raw.split(/[\/\-\s]/);
    if (parts.length >= 3) {
      const day = parseInt(parts[0], 10);
      const mon = parseInt(parts[1], 10);
      const yr  = parseInt(parts[2], 10);
      if (!isNaN(day) && !isNaN(mon) && !isNaN(yr)) {
        d = new Date(yr < 100 ? 2000 + yr : yr, mon - 1, day);
      }
    }
  }
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return y + '-' + String(m).padStart(2, '0');
}

const THAI_MONTHS = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function monthKeyToLabel(key) {
  if (!key || key === 'all') return 'ทุกช่วงเวลา';
  const parts = key.split('-');
  const yr = parseInt(parts[0], 10);
  const mon = parseInt(parts[1], 10);
  return THAI_MONTHS[mon] + ' ' + (yr + 543);
}

function populateStatsMonthDropdown(reports) {
  const sel = document.getElementById('statsMonthSelect');
  if (!sel) return;
  const keysSet = {};
  reports.forEach(function(r) {
    const k = getReportMonthKey(r);
    if (k) keysSet[k] = true;
  });
  const keys = Object.keys(keysSet).sort().reverse();
  const currentVal = sel.value;
  sel.innerHTML = '<option value="all">ทุกช่วงเวลา</option>' +
    keys.map(function(k) {
      return '<option value="' + k + '">' + monthKeyToLabel(k) + '</option>';
    }).join('');
  // Restore selection if still valid
  if (currentVal && currentVal !== 'all' && keysSet[currentVal]) {
    sel.value = currentVal;
  } else {
    sel.value = 'all';
  }
}

function applyStatsFilter() {
  renderStatsView();
}

function clearStatsFilter() {
  const sel = document.getElementById('statsMonthSelect');
  if (sel) sel.value = 'all';
  renderStatsView();
}
window.applyStatsFilter = applyStatsFilter;
window.clearStatsFilter = clearStatsFilter;

function renderStatsView() {
  const allReports = state.adminReports.length ? state.adminReports : (state.reports.length ? state.reports : []);

  // Populate dropdown (always from full dataset)
  populateStatsMonthDropdown(allReports);

  // Determine filter
  const sel = document.getElementById('statsMonthSelect');
  const filterKey = sel ? sel.value : 'all';

  // Filter reports
  const reports = filterKey === 'all'
    ? allReports
    : allReports.filter(function(r) { return getReportMonthKey(r) === filterKey; });

  // Update filter UI
  const labelEl = document.getElementById('statsFilterLabel');
  const clearBtn = document.getElementById('statsClearFilterBtn');
  if (labelEl) {
    labelEl.textContent = filterKey === 'all'
      ? 'แสดงข้อมูลทั้งหมด ' + allReports.length + ' รายการ'
      : 'กรองเดือน: ' + monthKeyToLabel(filterKey) + ' (' + reports.length + ' รายการ)';
  }
  if (clearBtn) {
    clearBtn.style.display = filterKey === 'all' ? 'none' : '';
  }

  const total = reports.length;
  let pending = 0;
  let completed = 0;
  let forwarded = 0;
  
  const byDept = {};
  const byRespDept = {};
  const byResp = {};
  const byCat = {};
  
  reports.forEach(function(r) {
    const status = r.status || 'รับเรื่องแล้ว';
    const dept = r.department || 'ไม่ระบุฝ่าย/หน่วยงาน';
    const respDept = r.respDepartment || 'ยังไม่ระบุฝ่ายรับผิดชอบแก้ไข';
    const resp = r.assignedTo || 'ยังไม่ระบุผู้รับผิดชอบ';
    const cat = r.category || 'ทั่วไป';
    
    if (status === 'รับเรื่องแล้ว' || status === 'กำลังดำเนินการ') pending++;
    if (status === 'แก้ไขเสร็จสิ้น') completed++;
    if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') forwarded++;
    
    if (!byDept[dept]) byDept[dept] = { total: 0, pending: 0, completed: 0, forwarded: 0 };
    byDept[dept].total++;
    if (status === 'รับเรื่องแล้ว' || status === 'กำลังดำเนินการ') byDept[dept].pending++;
    if (status === 'แก้ไขเสร็จสิ้น') byDept[dept].completed++;
    if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') byDept[dept].forwarded++;
    
    if (!byRespDept[respDept]) byRespDept[respDept] = { total: 0, pending: 0, completed: 0, forwarded: 0 };
    byRespDept[respDept].total++;
    if (status === 'รับเรื่องแล้ว' || status === 'กำลังดำเนินการ') byRespDept[respDept].pending++;
    if (status === 'แก้ไขเสร็จสิ้น') byRespDept[respDept].completed++;
    if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') byRespDept[respDept].forwarded++;
    
    if (!byResp[resp]) byResp[resp] = { total: 0, inProgress: 0, completed: 0, forwarded: 0 };
    byResp[resp].total++;
    if (status === 'รับเรื่องแล้ว' || status === 'กำลังดำเนินการ') byResp[resp].inProgress++;
    if (status === 'แก้ไขเสร็จสิ้น') byResp[resp].completed++;
    if (status === 'ส่งต่อ/ประสานหน่วยงานอื่น') byResp[resp].forwarded++;
    
    byCat[cat] = (byCat[cat] || 0) + 1;
  });
  
  setText('statsTotalCount', total);
  setText('statsPendingCount', pending);
  setText('statsCompletedCount', completed);
  setText('statsForwardedCount', forwarded);

  function renderRateTable(bodyId, map, labelKey) {
    const el = document.getElementById(bodyId);
    if (!el) return;
    const keys = Object.keys(map).sort(function(a, b) { return map[b].total - map[a].total; });
    if (keys.length === 0) {
      el.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--muted);">ยังไม่มีข้อมูลสถิติ' + (filterKey !== 'all' ? 'ในเดือนที่เลือก' : '') + '</td></tr>';
      return;
    }
    el.innerHTML = keys.map(function(k) {
      const d = map[k];
      const pVal = d.pending !== undefined ? d.pending : d.inProgress;
      const rate = d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
      let rateColor = '#059669';
      if (rate < 50) rateColor = '#d97706';
      if (rate === 0 && d.total > 0) rateColor = '#ef4444';
      return '<tr>' +
        '<td class="row-title" style="color: var(--ink);">' + esc(k) + '</td>' +
        '<td style="text-align: center; font-weight: 700;">' + d.total + '</td>' +
        '<td style="text-align: center; font-weight: 600; color: #d97706;">' + pVal + '</td>' +
        '<td style="text-align: center; font-weight: 600; color: #059669;">' + d.completed + '</td>' +
        '<td style="text-align: center; font-weight: 600; color: #7c3aed;">' + d.forwarded + '</td>' +
        '<td style="text-align: center;"><span style="font-weight:700; color:' + rateColor + '; background:' + (rate === 100 ? '#dcfce7' : '#f1f5f9') + '; padding: 2px 8px; border-radius: 999px; font-size: 12px;">' + rate + '%</span></td>' +
        '</tr>';
    }).join('');
  }

  renderRateTable('statsByDepartmentBody', byDept);
  renderRateTable('statsByRespDeptBody', byRespDept);
  
  const respBody = document.getElementById('statsByResponsibleBody');
  if (respBody) {
    const respKeys = Object.keys(byResp).sort(function(a, b) { return byResp[b].total - byResp[a].total; });
    if (respKeys.length === 0) {
      respBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--muted);">ยังไม่มีข้อมูลสถิติ' + (filterKey !== 'all' ? 'ในเดือนที่เลือก' : '') + '</td></tr>';
    } else {
      respBody.innerHTML = respKeys.map(function(k) {
        const r = byResp[k];
        let statusBadge = '<span class="status-pill received" style="font-size:11px;">รับเรื่อง/รอดำเนินการ</span>';
        if (r.completed === r.total && r.total > 0) statusBadge = '<span class="status-pill done" style="font-size:11px;">เสร็จสิ้นทั้งหมด</span>';
        else if (r.inProgress > 0) statusBadge = '<span class="status-pill progress" style="font-size:11px;">กำลังดำเนินการ</span>';
        else if (r.forwarded > 0) statusBadge = '<span class="status-pill forwarded" style="font-size:11px;">ประสานงานต่อ</span>';
        
        return '<tr>' +
          '<td class="row-title" style="color: var(--ink);">' + esc(k) + '</td>' +
          '<td style="text-align: center; font-weight: 700;">' + r.total + '</td>' +
          '<td style="text-align: center; font-weight: 600; color: #d97706;">' + r.inProgress + '</td>' +
          '<td style="text-align: center; font-weight: 600; color: #059669;">' + r.completed + '</td>' +
          '<td style="text-align: center; font-weight: 600; color: #7c3aed;">' + r.forwarded + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '</tr>';
      }).join('');
    }
  }
  
  const catContainer = document.getElementById('statsByCategoryContainer');
  if (catContainer) {
    const catKeys = Object.keys(byCat).sort(function(a, b) { return byCat[b] - byCat[a]; });
    if (catKeys.length === 0) {
      catContainer.innerHTML = '<p style="text-align:center; padding: 20px; color: var(--muted); margin:0;">ยังไม่มีข้อมูลสถิติ' + (filterKey !== 'all' ? 'ในเดือนที่เลือก' : '') + '</p>';
    } else {
      catContainer.innerHTML = catKeys.map(function(k) {
        const count = byCat[k];
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return '<div style="background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--line);">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
            '<span style="font-weight: 700; color: var(--ink); font-size: 14px;">' + esc(k) + '</span>' +
            '<span style="font-weight: 700; color: #3b82f6; font-size: 14px;">' + count + ' เรื่อง (' + pct + '%)</span>' +
          '</div>' +
          '<div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 999px; overflow: hidden;">' +
            '<div style="width: ' + pct + '%; height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 999px; transition: width 0.5s ease;"></div>' +
          '</div>' +
          '</div>';
      }).join('');
    }
  }
  
  if (window.lucide) lucide.createIcons();
}
window.renderStatsView = renderStatsView;





