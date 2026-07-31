/* 军火商 — 前端逻辑（支持 自建后端API同步 / 本地存储 两种模式，服务器地址可配置） */
'use strict';

const FACTOR = 1.156; // 回本系数
const LS_KEY = 'junhuoshang_data';
const LS_BASE = 'jh_api_base';
const COLLS = ['purchases', 'prices', 'sales'];

let API_BASE = (localStorage.getItem(LS_BASE) || '').replace(/\/+$/, '');
let MODE = 'local'; // 'api' | 'local'
const data = { purchases: [], prices: [], sales: [] };
const charts = {}; // canvasId -> Chart instance
const openRows = new Set(); // 当前展开的 row 名称
let pollTimer = null;
let lastSig = '';
let syncLost = false;   // api 模式下与后端失联标记
let failCount = 0;

/* ---------- 工具函数 ---------- */
const $ = sel => document.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
function fmtDate(d) { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function fmtTime(d) { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; }
function fmtDateTime(d) { return `${fmtDate(d)} ${fmtTime(d)}`; }
function money(n) {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n) { return Number(n) || 0; }
function isoToInput(iso) {
  const d = new Date(iso); const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}
function inputToIso(v) { return v ? new Date(v).toISOString() : new Date().toISOString(); }
function uniqueNames(arr) { return [...new Set(arr.map(x => x.name.trim()).filter(Boolean))]; }
function slug(s) { return String(s).replace(/[^\w一-龥]/g, '_'); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function apiUrl(p) { return API_BASE + p; }
function priceTabActive() { return document.getElementById('tab-price').classList.contains('active'); }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 1800);
}

/* ---------- 存储层（自建后端 API / 本地） ---------- */
async function probeApi(base, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/api/purchases', { signal: ctrl.signal });
    if (r.ok) { JSON.parse(await r.text()); return true; }
  } catch (e) {}
  finally { clearTimeout(timer); }
  return false;
}
async function detectMode() {
  // 带超时与重试，兼容免费主机冷启动（首次唤醒可能需 30~60s）
  for (let i = 0; i < 3; i++) {
    if (API_BASE && await probeApi(API_BASE)) return 'api';
    if (await probeApi('')) return 'api';
    if (i < 2) await new Promise(r => setTimeout(r, 2000));
  }
  return 'local';
}
// 本地模式下周期性重连：后端休眠后唤醒会自动切回同步（解决免费平台冷启动误判本地）
function startReconnectWatcher() {
  setInterval(async () => {
    if (MODE === 'api' || syncLost) return;
    if (await probeApi('', 6000) || (API_BASE && await probeApi(API_BASE, 6000))) {
      MODE = 'api'; applyMode(); await refresh(true); toast('已连接到服务器，开启同步');
    }
  }, 15000);
}

const Store = {
  async loadAll() {
    if (MODE === 'api') {
      const out = {};
      await Promise.all(COLLS.map(async c => { out[c] = await (await fetch(apiUrl('/api/' + c))).json(); }));
      return out;
    }
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { purchases: [], prices: [], sales: [] }; }
    catch { return { purchases: [], prices: [], sales: [] }; }
  },
  async add(coll, item) {
    if (MODE === 'api') return (await fetch(apiUrl('/api/' + coll), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) })).json();
    item.id = crypto.randomUUID(); item.createdAt = new Date().toISOString();
    if (!item.time) item.time = new Date().toISOString();
    data[coll].push(item); saveLocal(); return item;
  },
  async update(coll, id, patch) {
    if (MODE === 'api') return (await fetch(apiUrl(`/api/${coll}/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).json();
    const it = data[coll].find(x => x.id === id);
    if (it) { Object.assign(it, patch, { updatedAt: new Date().toISOString() }); saveLocal(); }
    return it;
  },
  async remove(coll, id) {
    if (MODE === 'api') { await fetch(apiUrl(`/api/${coll}/${id}`), { method: 'DELETE' }); return; }
    data[coll] = data[coll].filter(x => x.id !== id); saveLocal();
  }
};
function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(data)); }
function computeSig(d) {
  return COLLS.map(c => (d[c] || []).map(x => (x.id || '') + ':' + (x.updatedAt || x.createdAt || x.time || '')).join(',')).join('||');
}

/* ---------- 聚合计算 ---------- */
function costAvg(name) {
  const ps = data.purchases.filter(p => p.name.trim() === name);
  const qty = ps.reduce((s, p) => s + num(p.qty), 0);
  const cost = ps.reduce((s, p) => s + num(p.price) * num(p.qty), 0);
  return qty ? cost / qty : 0;
}
function breakEven(avgCost) { return avgCost * FACTOR; }
function unitProfit(sellPrice, name) { return num(sellPrice) - breakEven(costAvg(name)); }

/* ---------- 渲染：仓库 ---------- */
function renderWarehouse() {
  const names = uniqueNames(data.purchases).sort();
  $('#whCount').textContent = `${names.length} 款 · 共 ${data.purchases.length} 笔`;
  const box = $('#warehouseList');
  if (!names.length) { box.innerHTML = '<div class="empty">暂无采购记录，先在上方入库</div>'; return; }
  box.innerHTML = names.map(name => {
    const ps = data.purchases.filter(p => p.name.trim() === name);
    const qty = ps.reduce((s, p) => s + num(p.qty), 0);
    const avg = costAvg(name);
    const be = breakEven(avg);
    const hist = ps.slice().sort((a, b) => new Date(b.time) - new Date(a.time)).map(p => `
      <tr>
        <td>${fmtDateTime(p.time)}</td>
        <td>${num(p.qty)}</td>
        <td>${money(p.price)}</td>
        <td>${money(num(p.price) * FACTOR)}</td>
        <td>
          <button class="mini" data-act="edit" data-coll="purchases" data-id="${p.id}">改</button>
          <button class="mini del" data-act="del" data-coll="purchases" data-id="${p.id}">删</button>
        </td>
      </tr>`).join('');
    return `
    <div class="row" data-row="${esc(name)}">
      <div class="row-head">
        <div><div class="row-title">${esc(name)}</div><div class="row-sub">${ps.length} 笔历史</div></div>
        <div class="kpi"><b>${num(qty)}</b><span>总数量</span></div>
        <div class="kpi"><b>${money(avg)}</b><span>购买均价</span></div>
        <div class="chev">▶</div>
      </div>
      <div class="row-body">
        <div class="kpi" style="margin:10px 0"><b>${money(be)}</b><span>回本均价 (均价×1.156)</span></div>
        <table class="hist">
          <thead><tr><th>购买时间</th><th>数量</th><th>单价</th><th>回本价</th><th></th></tr></thead>
          <tbody>${hist}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 渲染：价格 ---------- */
function renderPrice() {
  const names = uniqueNames(data.prices).sort();
  $('#prCount').textContent = `${names.length} 款 · 共 ${data.prices.length} 笔`;
  const box = $('#priceList');
  if (!names.length) { box.innerHTML = '<div class="empty">暂无价格记录</div>'; return; }
  box.innerHTML = names.map(name => {
    const ps = data.prices.filter(p => p.name.trim() === name);
    const min = Math.min(...ps.map(p => num(p.price)));
    const minRec = ps.find(p => num(p.price) === min);
    const dates = ps.map(p => fmtDate(p.time)).sort();
    const startD = dates[0], endD = dates[dates.length - 1];
    const intradayD = fmtDate(minRec.time);
    const hist = ps.slice().sort((a, b) => new Date(b.time) - new Date(a.time)).map(p => `
      <tr>
        <td>${fmtDateTime(p.time)}</td>
        <td>${money(p.price)}</td>
        <td>
          <button class="mini" data-act="edit" data-coll="prices" data-id="${p.id}">改</button>
          <button class="mini del" data-act="del" data-coll="prices" data-id="${p.id}">删</button>
        </td>
      </tr>`).join('');
    return `
    <div class="row" data-row="${esc(name)}">
      <div class="row-head">
        <div><div class="row-title">${esc(name)}</div><div class="row-sub">${ps.length} 笔记录</div></div>
        <div class="kpi"><b class="pos">${money(min)}</b><span>历史最低价</span></div>
        <div class="kpi"><b>${fmtTime(minRec.time)}</b><span>最低价时间</span></div>
        <div class="chev">▶</div>
      </div>
      <div class="row-body">
        <div class="chart-tools">
          <label>起<input type="date" class="pr-start" value="${startD}"></label>
          <label>止<input type="date" class="pr-end" value="${endD}"></label>
          <label>日内日期<input type="date" class="pr-intra" value="${intradayD}"></label>
        </div>
        <div class="chart-box">
          <h4>每日均价趋势（区间内）</h4>
          <div class="chart-wrap"><canvas id="c-daily-${slug(name)}"></canvas></div>
        </div>
        <div class="chart-box">
          <h4>当日价格波动（${intradayD}）</h4>
          <div class="chart-wrap"><canvas id="c-intra-${slug(name)}"></canvas></div>
        </div>
        <table class="hist">
          <thead><tr><th>记录时间</th><th>价格</th><th></th></tr></thead>
          <tbody>${hist}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 渲染：销售 ---------- */
function renderSales() {
  const names = uniqueNames(data.sales).sort();
  $('#slCount').textContent = `${names.length} 款 · 共 ${data.sales.length} 笔`;
  const box = $('#salesList');
  if (!names.length) { box.innerHTML = '<div class="empty">暂无销售记录</div>'; return; }
  const cutoff = Date.now() - 7 * 86400000;
  box.innerHTML = names.map(name => {
    const ss = data.sales.filter(s => s.name.trim() === name);
    const last7 = ss.filter(s => new Date(s.time).getTime() >= cutoff);
    const qty7 = last7.reduce((s, x) => s + num(x.qty), 0);
    const rev7 = last7.reduce((s, x) => s + num(x.price) * num(x.qty), 0);
    const avgPrice7 = qty7 ? rev7 / qty7 : 0;
    const profit7 = last7.reduce((s, x) => s + unitProfit(x.price, name) * num(x.qty), 0);
    const unitProfit7 = qty7 ? profit7 / qty7 : 0;
    const margin7 = rev7 ? (profit7 / rev7) * 100 : 0;
    const hist = ss.slice().sort((a, b) => new Date(b.time) - new Date(a.time)).map(s => {
      const up = unitProfit(s.price, name);
      const mg = num(s.price) ? (up / num(s.price)) * 100 : 0;
      return `
      <tr>
        <td>${fmtDateTime(s.time)}</td>
        <td>${num(s.qty)}</td>
        <td>${money(s.price)}</td>
        <td class="${up >= 0 ? 'pos' : 'neg'}">${money(up)}</td>
        <td class="${mg >= 0 ? 'pos' : 'neg'}">${mg.toFixed(1)}%</td>
        <td>
          <button class="mini" data-act="edit" data-coll="sales" data-id="${s.id}">改</button>
          <button class="mini del" data-act="del" data-coll="sales" data-id="${s.id}">删</button>
        </td>
      </tr>`;
    }).join('');
    return `
    <div class="row" data-row="${esc(name)}">
      <div class="row-head">
        <div><div class="row-title">${esc(name)}</div><div class="row-sub">近7天 ${last7.length} 笔</div></div>
        <div class="kpi"><b>${money(avgPrice7)}</b><span>近7天均价</span></div>
        <div class="kpi"><b class="${profit7 >= 0 ? 'pos' : 'neg'}">${money(profit7)}</b><span>近7天总利润</span></div>
        <div class="chev">▶</div>
      </div>
      <div class="row-body">
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0">
          <div class="kpi"><b>${money(unitProfit7)}</b><span>近7天单颗利润</span></div>
          <div class="kpi"><b class="${margin7 >= 0 ? 'pos' : 'neg'}">${margin7.toFixed(1)}%</b><span>近7天利润率</span></div>
          <div class="kpi"><b>${money(breakEven(costAvg(name)))}</b><span>回本均价(成本×1.156)</span></div>
        </div>
        <table class="hist">
          <thead><tr><th>卖出时间</th><th>数量</th><th>单价</th><th>单颗利润</th><th>利润率</th><th></th></tr></thead>
          <tbody>${hist}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 图表 ---------- */
function redrawPriceRow(row, name) {
  const start = row.querySelector('.pr-start')?.value;
  const end = row.querySelector('.pr-end')?.value;
  const intra = row.querySelector('.pr-intra')?.value;
  if (start && end) drawDaily(name, start, end);
  if (intra) drawIntra(name, intra);
}
function drawDaily(name, start, end) {
  const id = 'c-daily-' + slug(name);
  const ps = data.prices.filter(p => p.name.trim() === name && fmtDate(p.time) >= start && fmtDate(p.time) <= end);
  const byDate = {};
  ps.forEach(p => { const d = fmtDate(p.time); (byDate[d] = byDate[d] || []).push(num(p.price)); });
  const dates = Object.keys(byDate).sort();
  const avgs = dates.map(d => byDate[d].reduce((a, b) => a + b, 0) / byDate[d].length);
  drawLine(id, dates, avgs, '每日均价', '#f5a623');
}
function drawIntra(name, date) {
  const id = 'c-intra-' + slug(name);
  const ps = data.prices.filter(p => p.name.trim() === name && fmtDate(p.time) === date)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const labels = ps.map(p => fmtTime(p.time));
  const vals = ps.map(p => num(p.price));
  drawLine(id, labels, vals, '日内价格', '#58a6ff');
}
function drawLine(id, labels, vals, label, color) {
  const cv = document.getElementById(id);
  if (!cv) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(cv, {
    type: 'line',
    data: { labels, datasets: [{ label, data: vals, borderColor: color, backgroundColor: color + '33', fill: true, tension: .25, pointRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e6edf3' } } },
      scales: {
        x: { ticks: { color: '#8b97a7', maxRotation: 45, minRotation: 0 }, grid: { color: '#2a3342' } },
        y: { ticks: { color: '#8b97a7' }, grid: { color: '#2a3342' } }
      }
    }
  });
}

/* ---------- 行展开 / 编辑 / 删除 事件 ---------- */
function bindRowEvents() {
  document.querySelectorAll('.row-head').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.closest('.mini')) return;
      const row = h.parentElement;
      const name = row.getAttribute('data-row');
      const willOpen = !row.classList.contains('open');
      row.classList.toggle('open');
      if (willOpen) { openRows.add(name); if (priceTabActive()) redrawPriceRow(row, name); }
      else openRows.delete(name);
    });
  });
  // 价格行日期输入联动（无论是否展开都绑定）
  document.querySelectorAll('#priceList .row').forEach(row => {
    const name = row.getAttribute('data-row');
    row.querySelectorAll('.pr-start,.pr-end,.pr-intra').forEach(inp => {
      inp.addEventListener('change', () => redrawPriceRow(row, name));
    });
  });
  // 改 / 删
  document.querySelectorAll('[data-act]').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const { act, coll, id } = b.dataset;
      if (act === 'del') {
        if (!confirm('确认删除该记录？')) return;
        await Store.remove(coll, id); toast('已删除'); refresh(true);
      } else if (act === 'edit') {
        openEdit(coll, id);
      }
    });
  });
}
function restoreOpen() {
  document.querySelectorAll('.row').forEach(row => {
    const name = row.getAttribute('data-row');
    if (openRows.has(name)) {
      row.classList.add('open');
      if (priceTabActive()) redrawPriceRow(row, name);
    }
  });
}

/* ---------- 编辑弹窗 ---------- */
const FIELDS = {
  purchases: [
    { k: 'name', t: '子弹名称', type: 'text' },
    { k: 'qty', t: '数量', type: 'number' },
    { k: 'price', t: '单价', type: 'number' },
    { k: 'time', t: '购买时间', type: 'datetime' }
  ],
  prices: [
    { k: 'name', t: '子弹名称', type: 'text' },
    { k: 'price', t: '价格', type: 'number' },
    { k: 'time', t: '记录时间', type: 'datetime' }
  ],
  sales: [
    { k: 'name', t: '子弹名称', type: 'text' },
    { k: 'qty', t: '数量', type: 'number' },
    { k: 'price', t: '卖出单价', type: 'number' },
    { k: 'time', t: '卖出时间', type: 'datetime' }
  ]
};
let editCtx = null;
function openEdit(coll, id) {
  const item = data[coll].find(x => x.id === id);
  if (!item) return;
  editCtx = { coll, id };
  $('#modalTitle').textContent = '编辑' + ({ purchases: '采购', prices: '价格', sales: '销售' }[coll]);
  const form = $('#modalForm');
  form.innerHTML = FIELDS[coll].map(f => {
    let val = item[f.k] ?? '';
    if (f.type === 'datetime') val = isoToInput(item[f.k]);
    return `<label>${f.t}<input name="${f.k}" type="${f.type === 'datetime' ? 'datetime-local' : f.type}" value="${esc(val)}" step="any"></label>`;
  }).join('');
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }
$('#modalCancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('#modalSave').addEventListener('click', async () => {
  if (!editCtx) return;
  const patch = {};
  FIELDS[editCtx.coll].forEach(f => {
    const el = $('#modalForm').querySelector(`[name="${f.k}"]`);
    let v = el.value;
    if (f.type === 'number') v = num(v);
    if (f.type === 'datetime') v = inputToIso(v);
    patch[f.k] = v;
  });
  await Store.update(editCtx.coll, editCtx.id, patch);
  closeModal(); toast('已保存'); refresh(true);
});
$('#modalDelete').addEventListener('click', async () => {
  if (!editCtx) return;
  if (!confirm('确认删除该记录？')) return;
  await Store.remove(editCtx.coll, editCtx.id);
  closeModal(); toast('已删除'); refresh(true);
});

/* ---------- 表单提交 ---------- */
$('#formPurchase').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const t = f.time.value; // "HH:mm"，留空则用当前时刻
  let timeIso;
  if (t) {
    const n = new Date();
    const [hh, mm] = t.split(':').map(Number);
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh || 0, mm || 0, 0, 0);
    timeIso = d.toISOString();
  } else {
    timeIso = new Date().toISOString();
  }
  const item = {
    name: f.name.value.trim(), qty: num(f.qty.value), price: num(f.price.value),
    time: timeIso
  };
  if (!item.name) return;
  await Store.add('purchases', item); f.reset(); toast('已入库'); refresh(true);
});
$('#formPrice').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const item = { name: f.name.value.trim(), price: num(f.price.value), time: new Date().toISOString() };
  if (!item.name) return;
  await Store.add('prices', item); f.reset(); toast('已记录价格'); refresh(true);
});
$('#formSale').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const item = {
    name: f.name.value.trim(), qty: num(f.qty.value), price: num(f.price.value),
    time: f.time.value ? inputToIso(f.time.value) : new Date().toISOString()
  };
  if (!item.name) return;
  await Store.add('sales', item); f.reset(); toast('已售出'); refresh(true);
});

/* ---------- 导入/导出 ---------- */
$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'junhuoshang-' + fmtDate(new Date()) + '.json';
  a.click(); toast('已导出');
});
$('#btnImport').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (MODE === 'api') {
      for (const c of COLLS) {
        for (const it of (obj[c] || [])) {
          await fetch(apiUrl('/api/' + c), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(it) });
        }
      }
      toast('已导入到服务器'); await refresh(true);
    } else {
      COLLS.forEach(c => { if (!Array.isArray(obj[c])) obj[c] = []; data[c] = obj[c]; }); saveLocal();
      toast('已导入'); await refresh(true);
    }
  } catch (err) { alert('导入失败：文件格式不正确'); }
  e.target.value = '';
});
$('#btnRefresh').addEventListener('click', async () => { await refresh(true); toast('已刷新'); });

/* ---------- Tab 切换 ---------- */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  restoreOpen();
}));

/* ---------- 刷新 ---------- */
async function refresh(force) {
  try {
    const d = await Store.loadAll();
    failCount = 0;
    if (syncLost) { syncLost = false; toast('同步已恢复'); }
    const sig = computeSig(d);
    if (!force && sig === lastSig) { updateSync(); return; } // 数据未变，跳过渲染（避免轮询时折叠已展开的行）
    lastSig = sig;
    COLLS.forEach(c => (data[c] = d[c] || []));
    renderWarehouse(); renderPrice(); renderSales(); bindRowEvents(); restoreOpen();
    updateSync();
  } catch (e) {
    failCount++;
    if (MODE === 'api' && failCount >= 3 && !syncLost) {
      syncLost = true;
      toast('同步中断：无法连接服务器');
    }
    updateSync();
  }
}

/* ---------- 模式应用（同步状态圆点 + 轮询） ---------- */
function updateSync() {
  const dot = $('#syncDot');
  if (MODE === 'api') {
    if (syncLost) { dot.className = 'sync-dot lost'; dot.title = '同步中断：无法连接服务器'; }
    else { dot.className = 'sync-dot'; dot.title = '已连接服务器，三端实时同步'; }
  } else {
    dot.className = 'sync-dot local'; dot.title = '本地存储（未连接服务器）';
  }
}
function applyMode() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (MODE === 'api') pollTimer = setInterval(() => refresh(false), 6000);
  updateSync();
}

/* ---------- 启动 ---------- */
(async function init() {
  MODE = await detectMode();
  applyMode();
  await refresh(true);
  startReconnectWatcher();
})();
