'use strict';
/* Máy chủ online: phục vụ trang game + WebSocket (cơ sở dữ liệu tài liệu + phòng thời gian thực). */
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VOID_HASH = 'c9235b1368d68ae5a2656e902d6a9812e1c8e22ed27e821a2364424b7113b910';   // băm PBKDF2 của tài khoản chủ Void
const EPHEMERAL = /^(presence|online|queue|rooms)(\/|$)/;                                // không lưu xuống đĩa
const MAX_DOC = 24000, MAX_MSG = 70000, KEEP_CHAT = 400;

/* ---------------- kho dữ liệu ---------------- */
const store = new Map();                       // path -> object
try{ fs.mkdirSync(DATA_DIR, {recursive:true}); const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); for(const k in j) store.set(k, j[k]); console.log('Đã nạp', store.size, 'tài liệu'); }catch(e){}
let dirty = false;
setInterval(() => { if(!dirty) return; dirty = false; const o = {}; store.forEach((v, k) => { if(!EPHEMERAL.test(k)) o[k] = v; }); fs.writeFile(DB_FILE + '.tmp', JSON.stringify(o), err => { if(!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); }); }, 3000);

const parent = p => p.slice(0, p.lastIndexOf('/'));
const lastSeg = p => p.slice(p.lastIndexOf('/') + 1);
const validPath = p => typeof p === 'string' && p.length < 200 && /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/.test(p);
const listCol = col => { const pre = col + '/', out = []; for(const [k, v] of store) if(k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push({id:k.slice(pre.length), data:v}); return out; };
function runQuery(docs, q){
  q = q || {};
  for(const [f, op, val] of (q.where || [])){
    docs = docs.filter(d => { const x = d.data[f]; switch(op){ case '==': return x === val; case '!=': return x !== val; case '<': return x < val; case '<=': return x <= val; case '>': return x > val; case '>=': return x >= val; case 'in': return Array.isArray(val) && val.includes(x); default: return false; } });
  }
  if(q.order){ const [f, dir] = q.order, m = dir === 'desc' ? -1 : 1; docs = docs.slice().sort((a, b) => (a.data[f] > b.data[f] ? 1 : a.data[f] < b.data[f] ? -1 : 0) * m); }
  if(q.limit > 0) docs = docs.slice(0, Math.min(q.limit, 500));
  return docs;
}

/* ---------------- quyền truy cập ---------------- */
const pairHas = (id, s) => id.split('__').includes(s);
function rule(path, isDoc, c){
  const s = c.sid, adm = c.admin, parts = path.split('/'), top = parts[0], id = parts[1];
  const authed = !!s;
  const R = {read:false, write:false, readFilter:null};
  switch(top){
    case 'accounts': R.read = isDoc || adm; R.write = adm; break;                    // tạo mới xử lý riêng ở checkWrite
    case 'bans': R.read = true; R.write = adm; break;
    case 'mods': R.read = authed; R.write = adm; break;                                // quyền quản trị: chỉ Void cấp / thu hồi
    case 'tasks': case 'warns': R.read = authed; R.readFilter = d => adm || d.to === s || d.from === s; R.write = authed; break;
    case 'reports': R.read = adm; R.write = authed && (adm || store.has('mods/' + s)); break;     // quản trị viên gửi báo cáo, chỉ Void đọc
    case 'inventory': R.read = authed && (isDoc ? (id === s || adm) : adm); R.write = adm; break;
    case 'wallet': case 'wins': R.read = authed && (isDoc ? (id === s || adm) : adm); R.write = authed && (id === s || adm); break;     // ví xu + đồ trúng thưởng: mỗi người chỉ đọc / ghi của mình
    case 'profiles': R.read = authed; R.write = authed && (id === s || adm); break;
    case 'ranks': R.read = authed; R.write = authed && (id === s || adm); break;
    case 'online': case 'presence': case 'queue': R.read = authed; R.write = authed; break;
    case 'links': R.read = authed; R.write = authed && (adm || (isDoc && parts.length === 2 && pairHas(id, s))); break;
    case 'notifs': R.read = authed; R.write = authed; R.readFilter = d => adm || d.to === s || d.from === s; break;
    case 'chat': R.read = authed; R.write = authed; break;
    case 'dms': R.read = authed && (adm || pairHas(id, s)); R.write = R.read; break;
    case 'rooms': R.read = authed; R.write = authed; break;
  }
  return R;
}
function checkWrite(op, path, data, c, existing){
  const parts = path.split('/'), top = parts[0], R = rule(path, true, c);
  if(top === 'accounts' && !c.admin){
    if(op !== 'set' || existing) throw 'Không được sửa tài khoản';
    if(parts.length !== 2 || !data || typeof data.name !== 'string' || typeof data.salt !== 'string' || typeof data.hash !== 'string') throw 'Dữ liệu tài khoản sai';
    if(path !== 'accounts/' + sidOf(data.name)) throw 'Tên tài khoản không khớp';
    if(data.name.trim().toLowerCase() === 'void' || data.admin) throw 'Tên này được giữ riêng';
    if(data.name.length > 20 || data.hash.length > 100 || data.salt.length > 100) throw 'Dữ liệu quá dài';
    return;
  }
  if(!R.write) throw 'Không có quyền ghi';
  if(top === 'chat' || (top === 'rooms' && parts[2] === 'chat') || top === 'dms'){
    if(!c.admin){ const cur = existing; if(op === 'delete'){ if(!cur || cur.from !== c.sid) throw 'Chỉ xoá tin của mình'; } else{ if(existing) throw 'Không sửa tin nhắn'; if(!data || data.from !== c.sid) throw 'Sai người gửi'; } }
  }
  if(top === 'notifs' && !c.admin){
    if(op === 'delete'){ if(!existing || existing.to !== c.sid && existing.from !== c.sid) throw 'Không xoá được'; }
    else if(!data || data.from !== c.sid) throw 'Sai người gửi';
  }
  if((top === 'tasks' || top === 'warns') && !c.admin){
    const lvl = id => { const m = store.get('mods/' + id); return m ? (m.level === 'high' ? 'high' : 'mod') : ''; };
    if(op === 'delete'){ if(!existing || existing.from !== c.sid) throw 'Chỉ xoá mục của mình'; }
    else if(existing){                                                     // người nhận chỉ được đánh dấu xong / đã xem
      if(existing.to !== c.sid) throw 'Không có quyền sửa';
      const ok = {done:1, doneAt:1, seen:1, seenAt:1};
      for(const k of new Set(Object.keys(data).concat(Object.keys(existing)))) if(!ok[k] && JSON.stringify(data[k]) !== JSON.stringify(existing[k])) throw 'Chỉ được đánh dấu hoàn thành';
    }else{
      if(lvl(c.sid) !== 'high' || !data || data.from !== c.sid) throw 'Chỉ quản trị viên cấp cao mới được giao việc / cảnh cáo';
      if(typeof data.to !== 'string' || data.to === sidOf('void') || lvl(data.to) === 'high') throw 'Không áp dụng được cho người này';
      if(top === 'tasks' && !lvl(data.to)) throw 'Chỉ giao nhiệm vụ cho The Chosen';
    }
  }
  if(top === 'reports' && !c.admin){ if(op === 'delete' || !data || data.from !== c.sid) throw 'Chỉ gửi báo cáo của chính mình'; }
  if(top === 'ranks' && !c.admin && data){ const p = data.points; if(typeof p === 'number' && (p < 0 || p > 20000)) throw 'Điểm không hợp lệ'; }
}
const top0 = p => p.split('/')[0];
const utf8hex = s => Buffer.from(s, 'utf8').toString('hex');
const sidOf = n => 'u_' + utf8hex(String(n).trim().toLowerCase());

/* ---------------- kết nối ---------------- */
let CID = 0;
const conns = new Set(), subs = new Map();        // watchedPath -> Set(sub)
const rooms = new Map();                          // name -> Map(conn -> presence)

function send(c, o){ if(c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function snapFor(sub){
  const c = sub.conn;
  if(sub.isDoc){ const R = rule(sub.path, true, c); if(!R.read) return null; const d = store.get(sub.path); return d === undefined ? [] : [{id:lastSeg(sub.path), data:d}]; }
  const R = rule(sub.path, false, c); if(!R.read) return null;
  let docs = listCol(sub.path); if(R.readFilter) docs = docs.filter(x => R.readFilter(x.data));
  return runQuery(docs, sub.q);
}
function pushSub(sub, force){
  const docs = snapFor(sub); if(docs === null){ if(force) send(sub.conn, {t:'snap', id:sub.id, err:'Không có quyền đọc'}); return; }
  const j = JSON.stringify(docs); if(!force && j === sub.last) return; sub.last = j;
  send(sub.conn, {t:'snap', id:sub.id, docs});
}
const pending = new Set(); let tick = false;
function touch(p){
  [p, parent(p)].forEach(w => { const s = subs.get(w); if(s) s.forEach(x => pending.add(x)); });
  if(!tick){ tick = true; setTimeout(() => { tick = false; const l = [...pending]; pending.clear(); l.forEach(x => { if(x.conn.alive) pushSub(x); }); }, 40); }
}
function resubAll(c){ c.subs.forEach(x => pushSub(x, true)); }

function doWrite(c, op, path, data){
  const existing = store.get(path);
  if(op === 'delete'){ checkWrite(op, path, null, c, existing); if(existing !== undefined){ store.delete(path); dirty = true; touch(path); } return; }
  if(data === null || typeof data !== 'object' || Array.isArray(data)) throw 'Dữ liệu phải là object';
  if(JSON.stringify(data).length > MAX_DOC) throw 'Dữ liệu quá lớn';
  if(op === 'update'){ if(existing === undefined) throw 'Tài liệu không tồn tại'; const merged = Object.assign({}, existing, data); checkWrite(op, path, merged, c, existing); store.set(path, merged); }
  else{ checkWrite(op, path, data, c, existing); store.set(path, data); }
  dirty = true; touch(path);
  if(top0(path) === 'bans') conns.forEach(x => { if(x.sid && x.sid === lastSeg(path) && !x.admin){ x.sid = null; send(x, {t:'authed', ok:false}); resubAll(x); } });
  if(/^(chat\/[^/]+\/m|rooms\/[^/]+\/chat|dms\/[^/]+\/m)\//.test(path) === false && /\/(m|chat)\/[^/]+$/.test(path)){ /* bỏ qua */ }
  const par = parent(path); if(/^(chat\/[^/]+\/m|rooms\/[^/]+\/chat|dms\/[^/]+\/m)$/.test(par) && existing === undefined){
    const l = listCol(par); if(l.length > KEEP_CHAT){ l.sort((a, b) => (a.data.ts || 0) - (b.data.ts || 0)).slice(0, l.length - KEEP_CHAT).forEach(x => { store.delete(par + '/' + x.id); touch(par + '/' + x.id); }); }
  }
}

function auth(c, name, hash){
  c.sid = null; c.admin = false; c.name = null;
  if(typeof name === 'string' && typeof hash === 'string' && name){
    const sid = sidOf(name);
    if(name.trim().toLowerCase() === 'void'){ if(hash === VOID_HASH){ c.sid = sid; c.admin = true; c.name = 'Void'; } }
    else{ const a = store.get('accounts/' + sid); if(a && a.hash === hash){ const b = store.get('bans/' + sid); if(!b){ c.sid = sid; c.name = a.name; } } }
  }
  send(c, {t:'authed', ok:!!c.sid, admin:c.admin});
  resubAll(c);
}

function roomPeers(name){
  const r = rooms.get(name); if(!r) return;
  r.forEach((pres, c) => {
    const peers = []; r.forEach((p2, c2) => peers.push({id:'c' + c2.id, isMe:c2 === c, presence:p2, guest:false}));
    send(c, {t:'rpeers', room:name, peers});
  });
}
function leaveRoom(c, name){
  const r = rooms.get(name); if(!r || !r.has(c)) return; r.delete(c); c.rooms.delete(name);
  if(!r.size) rooms.delete(name); else roomPeers(name);
}

function handle(c, m){
  switch(m.t){
    case 'auth': return auth(c, m.name, m.hash);
    case 'op': {
      const reply = (ok, data) => send(c, {t:'res', id:m.id, ok, data, err:ok ? undefined : data});
      try{
        if(!validPath(m.path)) throw 'Đường dẫn sai';
        const isDoc = m.path.split('/').length % 2 === 0;
        if(m.op === 'get'){ const R = rule(m.path, true, c); if(!R.read) throw 'Không có quyền đọc'; const d = store.get(m.path); if(d !== undefined && R.readFilter && !R.readFilter(d)) return reply(true, {exists:false}); return reply(true, d === undefined ? {exists:false} : {exists:true, data:d}); }
        if(m.op === 'list'){ if(isDoc) throw 'Không phải tập hợp'; const R = rule(m.path, false, c); if(!R.read) throw 'Không có quyền đọc'; let docs = listCol(m.path); if(R.readFilter) docs = docs.filter(x => R.readFilter(x.data)); return reply(true, runQuery(docs, m.q)); }
        if(!isDoc) throw 'Chỉ ghi vào tài liệu';
        if(m.op === 'set' || m.op === 'update' || m.op === 'delete'){ doWrite(c, m.op, m.path, m.data); return reply(true, null); }
        throw 'Lệnh không hợp lệ';
      }catch(e){ reply(false, typeof e === 'string' ? e : 'Lỗi máy chủ'); }
      return;
    }
    case 'sub': {
      if(!validPath(m.path) || c.subs.size > 60) return;
      const sub = {id:m.id, conn:c, path:m.path, isDoc:m.path.split('/').length % 2 === 0, q:m.q, last:null};
      c.subs.set(m.id, sub); if(!subs.has(m.path)) subs.set(m.path, new Set()); subs.get(m.path).add(sub); pushSub(sub, true); return;
    }
    case 'unsub': { const sub = c.subs.get(m.id); if(sub){ c.subs.delete(m.id); const s = subs.get(sub.path); if(s){ s.delete(sub); if(!s.size) subs.delete(sub.path); } } return; }
    case 'rjoin': {
      if(typeof m.room !== 'string' || m.room.length > 80 || !c.sid || c.rooms.size > 4) return;
      if(!rooms.has(m.room)) rooms.set(m.room, new Map()); const r = rooms.get(m.room);
      if(!r.has(c)){ r.set(c, {}); c.rooms.add(m.room); } roomPeers(m.room); return;
    }
    case 'rleave': return leaveRoom(c, m.room);
    case 'rpres': { const r = rooms.get(m.room); if(!r || !r.has(c)) return; r.set(c, Object.assign(r.get(c), m.patch || {})); roomPeers(m.room); return; }
    case 'remit': {
      const r = rooms.get(m.room); if(!r || !r.has(c) || typeof m.topic !== 'string' || m.topic.length > 30) return;
      r.forEach((_, c2) => send(c2, {t:'rmsg', room:m.room, topic:m.topic, data:m.data, from:'c' + c.id, isMe:c2 === c}));
      return;
    }
    case 'ping': return send(c, {t:'pong'});
  }
}

function cleanup(c){
  c.alive = false; conns.delete(c);
  c.subs.forEach(sub => { const s = subs.get(sub.path); if(s){ s.delete(sub); if(!s.size) subs.delete(sub.path); } });
  [...c.rooms].forEach(n => leaveRoom(c, n));
  if(c.sid){ ['presence', 'online', 'queue'].forEach(t => { if(store.delete(t + '/' + c.sid)) touch(t + '/' + c.sid); }); }
}

/* ---------------- HTTP ---------------- */
const PUB = path.join(__dirname, 'public');
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon', '.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if(u === '/healthz'){ res.writeHead(200); return res.end('ok'); }
  if(u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if(!f.startsWith(PUB)){ res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if(err){ res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control':'no-cache'}); res.end(buf);
  });
});
const wss = new WebSocketServer({server, path:'/ws', maxPayload:MAX_MSG});
wss.on('connection', ws => {
  const c = {id:++CID, ws, sid:null, admin:false, name:null, subs:new Map(), rooms:new Set(), alive:true, tokens:300, last:Date.now()};
  conns.add(c); ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', buf => {
    const now = Date.now(); c.tokens = Math.min(300, c.tokens + (now - c.last) * 0.15); c.last = now;   // ~150 lệnh/giây
    if(--c.tokens < 0) return;
    let m; try{ m = JSON.parse(buf.toString()); }catch(e){ return; }
    if(m && typeof m === 'object') try{ handle(c, m); }catch(e){ console.error(e); }
  });
  ws.on('close', () => cleanup(c)); ws.on('error', () => {});
  send(c, {t:'hello', n:conns.size});
});
setInterval(() => wss.clients.forEach(ws => { if(!ws.isAlive) return ws.terminate(); ws.isAlive = false; try{ ws.ping(); }catch(e){} }), 20000);
process.on('SIGTERM', () => { dirty = true; setTimeout(() => process.exit(0), 3500); });
server.listen(PORT, () => console.log('Game chạy tại cổng', PORT));
