const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'warehouse_site',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

// تنظيف المدخلات (Sanitization)
const clean = (s, n = 150) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const isInt = (v, min) => v !== '' && v != null && Number.isInteger(Number(v)) && Number(v) >= min;
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); });
const bad = (res, msg) => res.status(400).json({ error: msg });

// ---------- المستودع ----------
app.get('/api/items', wrap(async (req, res) => {
  const [rows] = await pool.execute(`SELECT i.id, c.name AS cat, i.name, i.quantity AS qty, i.min_quantity AS min
    FROM items i JOIN categories c ON c.id = i.category_id ORDER BY i.id`);
  res.json(rows);
}));

app.post('/api/items', wrap(async (req, res) => {
  const cat = clean(req.body.cat, 100), name = clean(req.body.name, 150);
  if (!cat || !name || !isInt(req.body.qty, 0) || !isInt(req.body.min, 0)) return bad(res, 'تأكد من البيانات');
  await pool.execute('INSERT IGNORE INTO categories (name) VALUES (?)', [cat]);
  const [[c]] = await pool.execute('SELECT id FROM categories WHERE name = ?', [cat]);
  await pool.execute('INSERT INTO items (category_id, name, quantity, min_quantity) VALUES (?,?,?,?)',
    [c.id, name, Number(req.body.qty), Number(req.body.min)]);
  res.json({ ok: true });
}));

app.delete('/api/items/:id', wrap(async (req, res) => {
  await pool.execute('DELETE FROM items WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.post('/api/issue', wrap(async (req, res) => {
  const by = clean(req.body.by, 100), rcv = clean(req.body.rcv, 100);
  if (!isInt(req.body.item_id, 1) || !by || !rcv) return bad(res, 'عبّ كل الحقول');
  if (!isInt(req.body.qty, 1)) return bad(res, 'العدد لازم رقم صحيح أكبر من صفر');
  const q = Number(req.body.qty);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[it]] = await conn.execute('SELECT id, name, quantity, min_quantity FROM items WHERE id = ? FOR UPDATE', [Number(req.body.item_id)]);
    if (!it) { await conn.rollback(); return bad(res, 'الصنف غير موجود'); }
    if (q > it.quantity) { await conn.rollback(); return bad(res, `الكمية المطلوبة أكبر من المتوفر (${it.quantity})`); }
    const left = it.quantity - q;
    await conn.execute('UPDATE items SET quantity = ? WHERE id = ?', [left, it.id]);
    await conn.execute('INSERT INTO issue_requests (item_id, requester_name, quantity, receiver_name) VALUES (?,?,?,?)', [it.id, by, q, rcv]);
    let alert = null;
    if (left <= it.min_quantity) {
      alert = `⚠️ الصنف «${it.name}» وصل للحد الحرج: المتبقي ${left}`;
      await conn.execute('INSERT INTO alerts (item_id, message) VALUES (?,?)', [it.id, alert]);
    }
    await conn.commit();
    res.json({ ok: true, alert });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.get('/api/requests', wrap(async (req, res) => {
  const [rows] = await pool.execute(`SELECT DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i') AS at, i.name AS item,
    r.requester_name AS \`by\`, r.quantity AS qty, r.receiver_name AS rcv
    FROM issue_requests r JOIN items i ON i.id = r.item_id ORDER BY r.id DESC LIMIT 200`);
  res.json(rows);
}));

app.get('/api/alerts', wrap(async (req, res) => {
  const [rows] = await pool.execute(`SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS at, message AS msg
    FROM alerts ORDER BY id DESC LIMIT 200`);
  res.json(rows);
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  bad(res, 'طلب غير صحيح');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
