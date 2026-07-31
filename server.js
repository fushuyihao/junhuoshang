// 军火商 — 后端服务 (零依赖 Node http + JSON 文件存储)
// 运行: node server.js  (可选 PORT 环境变量)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 3000;

// 回本系数
const BREAK_EVEN_FACTOR = 1.156;
const COLLECTIONS = ['purchases', 'prices', 'sales'];

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const init = {};
    COLLECTIONS.forEach(c => (init[c] = []));
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
}
function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    const init = {};
    COLLECTIONS.forEach(c => (init[c] = []));
    return init;
  }
}
function writeDb(db) {
  ensureDb();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e7) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function nowIso() {
  return new Date().toISOString();
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', collection, id?]
  if (parts[0] !== 'api') return false;
  const coll = parts[1];
  const id = parts[2];
  if (!COLLECTIONS.includes(coll)) {
    sendJson(res, 404, { error: 'unknown collection' });
    return true;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return true;
  }

  // 汇总端点: /api/summary
  if (coll === 'summary' && req.method === 'GET') {
    const db = readDb();
    sendJson(res, 200, db);
    return true;
  }

  if (req.method === 'GET' && !id) {
    const db = readDb();
    sendJson(res, 200, db[coll]);
    return true;
  }
  if (req.method === 'GET' && id) {
    const db = readDb();
    const item = db[coll].find(x => x.id === id);
    if (!item) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    sendJson(res, 200, item);
    return true;
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    const item = { id: crypto.randomUUID(), createdAt: nowIso(), ...body };
    if (!item.time) item.time = nowIso();
    const db = readDb();
    db[coll].push(item);
    writeDb(db);
    sendJson(res, 201, item);
    return true;
  }
  if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
    const body = await readBody(req);
    const db = readDb();
    const idx = db[coll].findIndex(x => x.id === id);
    if (idx < 0) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    db[coll][idx] = { ...db[coll][idx], ...body, id, updatedAt: nowIso() };
    writeDb(db);
    sendJson(res, 200, db[coll][idx]);
    return true;
  }
  if (req.method === 'DELETE' && id) {
    const db = readDb();
    const before = db[coll].length;
    db[coll] = db[coll].filter(x => x.id !== id);
    writeDb(db);
    sendJson(res, 200, { ok: true, removed: before - db[coll].length });
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
    }
    // 静态资源
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, content) => {
      if (err) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, c2) => {
          if (e2) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(c2);
        });
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    });
  } catch (e) {
    sendJson(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`军火商 running on http://localhost:${PORT}`);
  console.log(`回本系数 = ${BREAK_EVEN_FACTOR}`);
});
