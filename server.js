const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(cors());
app.use(express.json());

// ── IMAGE UPLOADS ──
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Serves uploaded images statically at http://localhost:3000/uploads/<filename>
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '-');
    cb(null, `${base}-${Date.now()}${ext}`); // unique name, avoids overwriting
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk  = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error('Only image files (jpg, png, gif, webp) are allowed'));
  }
});

// ── CONNECT TO MONGODB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const MenuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  price:       { type: Number, required: true },
  category:    { type: String, required: true },
  description: { type: String, default: '' },
  image:       { type: String, default: '' },

  // Variant groups for this item — e.g. Sauce, Spice Level, Extras.
  // Empty array = no picker shown, item adds to cart instantly.
  // 'single' groups are radio-style (exactly one choice, can be required);
  // 'multi' groups are checkbox-style (zero or more choices) and are how
  // priced add-ons like "Extra Fries +₱35" work.
  variantGroups: {
    type: [{
      name:     { type: String, required: true },       // "Sauce", "Spice Level", "Extras"
      type:     { type: String, enum: ['single', 'multi'], default: 'single' },
      required: { type: Boolean, default: false },
      options: [{
        label:      { type: String, required: true },
        priceDelta: { type: Number, default: 0 }         // added to unit price when selected
      }]
    }],
    default: []
  }
});
const MenuItem = mongoose.model('MenuItem', MenuItemSchema);

const StaffSchema = new mongoose.Schema({
  staffCode: { type: String, required: true, unique: true },
  name:      { type: String, required: true },
  branch:    { type: String, enum: ['Harrison Bazaar', 'Pines Arcade', 'Porta Vaga'], default: 'Harrison Bazaar' },
  password:  { type: String, required: true },
  contact:   { type: String, default: '' },
  status:    { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  dateAdded: { type: String, default: () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) }
});
const Staff = mongoose.model('Staff', StaffSchema);

// Orders are NEVER deleted on reset — only today's orders are cleared.
// All past orders stay in DB so Sales History can be computed anytime.
const OrderSchema = new mongoose.Schema({
  items: [
    {
      item: {
        _id:         mongoose.Schema.Types.ObjectId,
        name:        String,
        price:       Number,
        category:    String,
        description: String,
        image:       String
      },
      quantity: Number,

      // The chosen option(s) across all of this item's variant groups —
      // e.g. [{groupName:'Sauce',label:'Honey Butter',priceDelta:0},
      //       {groupName:'Extras',label:'Extra Fries',priceDelta:35}].
      // Empty array for items with no variant groups.
      selectedOptions: [{
        groupName:  String,
        label:      String,
        priceDelta: Number
      }]
    }
  ],
  total:           { type: Number, required: true },
  transactionMode: { type: String, default: '' },
  paymentMode:     { type: String, default: '' },
  timestamp:       { type: Date, default: Date.now },

  // ── Order status — cancelled orders are kept in DB for records but
  // excluded from all sales totals (dailysales, history, live views) ──
  status:          { type: String, enum: ['completed', 'cancelled'], default: 'completed' },

  // ── Branch / employee attribution ──
  branch:          { type: String, enum: ['Harrison Bazaar', 'Pines Arcade', 'Porta Vaga'], default: 'Harrison Bazaar' },
  staffName:       { type: String, default: 'Unknown' },
  staffId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', default: null },

  // ── Per-branch sequential order numbering (e.g. #HB001) ──
  branchOrderNumber: { type: Number },
  displayId:         { type: String }
});
const Order = mongoose.model('Order', OrderSchema);

const KioskSettingsSchema = new mongoose.Schema({
  kioskName:        { type: String, default: 'Chut Chut' },
  transactionModes: { type: [String], default: ['Dine In', 'Take Out', 'Grab'] },
  paymentModes:     { type: [String], default: ['Cash', 'Gcash/maya'] },
  managerPassword:  { type: String, default: 'manager@2026' }
});
const KioskSettings = mongoose.model('KioskSettings', KioskSettingsSchema);


//  DAILY SALES — persisted per-day summary
const DailySalesSchema = new mongoose.Schema({
  date:         { type: String, required: true, unique: true }, // "YYYY-MM-DD" (Asia/Manila)
  totalSales:   { type: Number, default: 0 },
  totalOrders:  { type: Number, default: 0 },
  transactions: {
    dineIn:  { type: Number, default: 0 },
    takeOut: { type: Number, default: 0 },
    grab:    { type: Number, default: 0 }
  },
  payments: {
    cash:   { type: Number, default: 0 },
    online: { type: Number, default: 0 },
    grab:   { type: Number, default: 0 }
  },
  topItems: [
    {
      name:  String,
      qty:   Number,
      total: Number
    }
  ],
  updatedAt: { type: Date, default: Date.now }
});
const DailySales = mongoose.model('DailySales', DailySalesSchema);

// ── Per-branch order number counter (atomic increments) ──
const CounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // branch name
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', CounterSchema);

const branchCodes = {
  'Harrison Bazaar': 'HB',
  'Pines Arcade':    'PA',
  'Porta Vaga':      'PV'
};

async function getNextBranchOrderNumber(branch) {
  const counter = await Counter.findOneAndUpdate(
    { key: branch },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return counter.seq;
}

function formatDisplayId(branch, seq) {
  const code = branchCodes[branch] || 'XX';
  return `#${code}${String(seq).padStart(3, '0')}`;
}

// Returns the UTC start/end instants that correspond to midnight-to-midnight
function getManilaDayBounds(refDate = new Date()) {
  const dateStr = refDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // "YYYY-MM-DD"
  const start = new Date(`${dateStr}T00:00:00+08:00`);
  const end   = new Date(`${dateStr}T23:59:59.999+08:00`);
  return { dateStr, start, end };
}

// Recomputes one day's summary straight from the Orders collection.
// Cancelled orders are excluded from every total below.
async function upsertDailySales(refDate = new Date()) {
  const { dateStr, start, end } = getManilaDayBounds(refDate);
  const allOrders = await Order.find({ timestamp: { $gte: start, $lte: end } });
  const orders = allOrders.filter(o => o.status !== 'cancelled'); // NEW — exclude cancelled

  const summary = {
    date:         dateStr,
    totalSales:   0,
    totalOrders:  orders.length,
    transactions: { dineIn: 0, takeOut: 0, grab: 0 },
    payments:     { cash: 0, online: 0, grab: 0 },
    topItems:     [],
    updatedAt:    new Date()
  };

  const itemMap = new Map();

  orders.forEach(order => {
    summary.totalSales += order.total;

    if (order.transactionMode === 'Dine In')  summary.transactions.dineIn++;
    if (order.transactionMode === 'Take Out') summary.transactions.takeOut++;
    if (order.transactionMode === 'Grab')     summary.transactions.grab++;

    if (order.paymentMode === 'Cash')           summary.payments.cash++;
    if (order.paymentMode === 'Online Payment') summary.payments.online++;
    if (order.paymentMode === 'Grab')           summary.payments.grab++;

    order.items.forEach(entry => {
      const key = entry.item.name;
      if (itemMap.has(key)) {
        itemMap.get(key).qty   += entry.quantity;
        itemMap.get(key).total += entry.item.price * entry.quantity;
      } else {
        itemMap.set(key, {
          name:  key,
          qty:   entry.quantity,
          total: entry.item.price * entry.quantity
        });
      }
    });
  });

  summary.topItems = Array.from(itemMap.values())
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  return DailySales.findOneAndUpdate(
    { date: dateStr },
    summary,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Groups raw orders by Manila date. Cancelled orders are still pushed into
// day.orders (so the frontend can list/display them), but are excluded from
// every sum: totalSales, totalOrders, transactions, payments, topItems.
function groupOrdersByDate(orders) {
  const map = new Map();

  orders.forEach(order => {
    const date = new Date(order.timestamp)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); 

    if (!map.has(date)) {
      map.set(date, {
        date,
        totalSales:   0,
        totalOrders:  0,
        transactions: { dineIn: 0, takeOut: 0, grab: 0 },
        payments:     { cash: 0, online: 0, grab: 0 },
        itemMap:      new Map(),
        orders:       []
      });
    }

    const day = map.get(date);
    day.orders.push(order); // always keep the order visible in the day's list

    if (order.status === 'cancelled') return; // NEW — skip all sums for cancelled orders

    day.totalSales  += order.total;
    day.totalOrders += 1;

    if (order.transactionMode === 'Dine In')  day.transactions.dineIn++;
    if (order.transactionMode === 'Take Out') day.transactions.takeOut++;
    if (order.transactionMode === 'Grab')     day.transactions.grab++;

    if (order.paymentMode === 'Cash')           day.payments.cash++;
    if (order.paymentMode === 'Online Payment') day.payments.online++;
    if (order.paymentMode === 'Grab')           day.payments.grab++;

    order.items.forEach(entry => {
      const key = entry.item.name;
      if (day.itemMap.has(key)) {
        day.itemMap.get(key).qty   += entry.quantity;
        day.itemMap.get(key).total += entry.item.price * entry.quantity;
      } else {
        day.itemMap.set(key, {
          name:  key,
          qty:   entry.quantity,
          total: entry.item.price * entry.quantity
        });
      }
    });
  });

  return Array.from(map.values())
    .map(day => ({
      date:         day.date,
      totalSales:   day.totalSales,
      totalOrders:  day.totalOrders,
      transactions: day.transactions,
      payments:     day.payments,
      topItems:     Array.from(day.itemMap.values())
                        .sort((a, b) => b.qty - a.qty)
                        .slice(0, 10),
      orders:       day.orders
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function getMergedDailyHistory(orders) {
  const liveHistory = groupOrdersByDate(orders);
  const liveDates   = new Set(liveHistory.map(d => d.date));

  const archivedDays = await DailySales.find({ date: { $nin: [...liveDates] } });
  const archivedHistory = archivedDays.map(day => ({
    date:         day.date,
    totalSales:   day.totalSales,
    totalOrders:  day.totalOrders,
    transactions: day.transactions,
    payments:     day.payments,
    topItems:     day.topItems,
    orders:       [] // raw orders were cleared by a reset — only the summary survives
  }));

  return [...liveHistory, ...archivedHistory].sort((a, b) => b.date.localeCompare(a.date));
}


//  LOGIN ENDPOINTS
app.post('/api/login/manager', async (req, res) => {
  const { password } = req.body;
  let settings = await KioskSettings.findOne();
  if (!settings) { settings = new KioskSettings(); await settings.save(); }
  if (password === settings.managerPassword) {
    return res.send({ success: true, role: 'Manager' });
  }
  res.status(401).send({ success: false, message: 'Incorrect manager password' });
});

app.post('/api/login/staff', async (req, res) => {
  const { staffCode, password } = req.body;
  const staff = await Staff.findOne({ staffCode });
  if (!staff) return res.status(401).send({ success: false, message: 'Staff code not found' });
  if (staff.status === 'Inactive') return res.status(403).send({ success: false, message: 'This account is inactive' });
  if (staff.password !== password) return res.status(401).send({ success: false, message: 'Incorrect password' });
  res.send({ success: true, role: 'Employee', staff });
});


//  MENU ITEM ENDPOINTS
app.get('/api/menu', async (req, res) => {
  res.send(await MenuItem.find());
});

app.post('/api/menu', async (req, res) => {
  const item = new MenuItem(req.body);
  await item.save();
  console.log('Added menu item:', item.name);
  res.status(201).send(item);
});

app.put('/api/menu/:id', async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!item) return res.status(404).send({ error: 'Item not found' });
  res.send(item);
});

app.delete('/api/menu/:id', async (req, res) => {
  const item = await MenuItem.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).send({ error: 'Item not found' });
  res.send({ message: 'Item deleted' });
});


//  STAFF ENDPOINTS
app.get('/api/staff', async (req, res) => {
  res.send(await Staff.find());
});

app.post('/api/staff', async (req, res) => {
  const member = new Staff(req.body);
  await member.save();
  console.log('Added staff:', member.name);
  res.status(201).send(member);
});

app.put('/api/staff/:id', async (req, res) => {
  const member = await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!member) return res.status(404).send({ error: 'Staff not found' });
  res.send(member);
});

app.delete('/api/staff/:id', async (req, res) => {
  const member = await Staff.findByIdAndDelete(req.params.id);
  if (!member) return res.status(404).send({ error: 'Staff not found' });
  res.send({ message: 'Staff deleted' });
});

// ══════════════════════════════════════════
//  ORDER ENDPOINTS
// ══════════════════════════════════════════

// GET today's orders — used by both dashboard and manager live view.
// Optional ?branch= filter, used by the Employee Dashboard so staff
// only ever see their own assigned branch's orders.
app.get('/api/orders/today', async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const filter = { timestamp: { $gte: startOfDay } };
  if (req.query.branch) filter.branch = req.query.branch;
  const orders = await Order.find(filter).sort({ timestamp: -1 });
  res.send(orders);
});

// GET all orders grouped by date — used by Sales History tab
// Returns one entry per day with totals, breakdowns, top items, and raw orders.
// Days whose orders were wiped by a reset are filled in from `dailysales`.
app.get('/api/orders/history', async (req, res) => {
  const orders = await Order.find().sort({ timestamp: 1 });
  res.send(await getMergedDailyHistory(orders));
});

// POST a new order — assigns a per-branch sequential display ID
// (e.g. #HB001, #PA001, #PV001) in addition to the Mongo _id.
app.post('/api/orders', async (req, res) => {
  const branch = req.body.branch || 'Harrison Bazaar';
  const seq = await getNextBranchOrderNumber(branch);

  const order = new Order({
    ...req.body,
    branchOrderNumber: seq,
    displayId: formatDisplayId(branch, seq)
  });
  await order.save();
  console.log(`New order ${order.displayId} — ₱${order.total}`);

  // Keep today's row in `dailysales` in sync with the new order
  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales:', err);
  }

  res.status(201).send(order);
});

// PATCH — cancel an order (soft-cancel, order stays in DB for records
// but is excluded from every sales total from this point on)
app.patch('/api/orders/:id/cancel', async (req, res) => {
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status: 'cancelled' },
    { new: true }
  );
  if (!order) return res.status(404).send({ error: 'Order not found' });

  // Recompute today's dailysales row so totals reflect the cancellation
  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales after cancel:', err);
  }

  console.log(`Order ${order.displayId || order._id} cancelled`);
  res.send(order);
});

// PATCH — restore a cancelled order back to completed
app.patch('/api/orders/:id/uncancel', async (req, res) => {
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status: 'completed' },
    { new: true }
  );
  if (!order) return res.status(404).send({ error: 'Order not found' });

  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales after uncancel:', err);
  }

  console.log(`Order ${order.displayId || order._id} restored`);
  res.send(order);
});

// DELETE reset — clears TODAY's orders only.
// Past days are kept in DB so history is never lost.
app.delete('/api/orders/reset', async (req, res) => {
  // Finalize today's numbers into dailysales BEFORE wiping the orders,
  // so the archived summary survives the reset.
  try {
    await upsertDailySales();
  } catch (err) {
    console.error('Failed to finalize dailysales before reset:', err);
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const result = await Order.deleteMany({ timestamp: { $gte: startOfDay } });
  console.log(`Reset: cleared ${result.deletedCount} orders from today`);
  res.send({ message: `Cleared ${result.deletedCount} orders from today` });
});

// ══════════════════════════════════════════
//  ONE-TIME MIGRATION — backfill displayId for existing orders
//  that were created before branch order numbering existed.
//  Run once (e.g. via curl/Postman: POST /api/migrate/branch-order-numbers),
//  confirm the response, then remove this route.
// ══════════════════════════════════════════
app.post('/api/migrate/branch-order-numbers', async (req, res) => {
  const branches = Object.keys(branchCodes);
  let updatedCount = 0;

  for (const branch of branches) {
    const orders = await Order.find({ branch, displayId: { $exists: false } }).sort({ timestamp: 1 });
    for (const order of orders) {
      const seq = await getNextBranchOrderNumber(branch);
      order.branchOrderNumber = seq;
      order.displayId = formatDisplayId(branch, seq);
      await order.save();
      updatedCount++;
    }
  }

  res.send({ message: `Backfilled ${updatedCount} orders with branch order numbers.` });
});

// ══════════════════════════════════════════
//  ONE-TIME MIGRATION — applies full variant groups (Sauce/Flavor, Spice
//  Level, Extras) to every menu category, and consolidates the 3 separate
//  Giant Twirl items into one item with a Flavor group.
//  This supersedes the old /api/migrate/add-variants (single flavor list)
//  route — that field is no longer used by the schema.
//  Run once (POST /api/migrate/add-variant-groups), confirm the response,
//  then remove this route. Defaults below are a starting point — adjust
//  any item's groups afterward from the Manager Panel Menu tab.
// ══════════════════════════════════════════
app.post('/api/migrate/add-variant-groups', async (req, res) => {
  const opt = (label, priceDelta = 0) => ({ label, priceDelta });

  // Chicken items — Wings & Rice/Fries/Gravy/Drinks, Combos
  const chickenGroups = [
    {
      name: 'Sauce', type: 'single', required: true,
      options: [opt('Honey Butter'), opt('Lemon Glaze'), opt('Yamyeong'), opt('Cheese')]
    },
    {
      name: 'Spice Level', type: 'single', required: true,
      options: [opt('Mild'), opt('Medium'), opt('Hot')]
    },
    {
      name: 'Extras', type: 'multi', required: false,
      options: [opt('Extra Rice', 25), opt('Extra Fries', 35), opt('Extra Sauce', 15)]
    }
  ];
  const chickenCategories = ['Wings & Rice', 'Wings & Fries', 'Wings & Gravy', 'Wings & Drinks', 'Combos'];

  // Fries
  const friesGroups = [
    {
      name: 'Flavor', type: 'single', required: true,
      options: [opt('Cheese'), opt('Sour Cream'), opt('BBQ')]
    },
    {
      name: 'Extras', type: 'multi', required: false,
      options: [opt('Extra Dip', 15)]
    }
  ];

  // Corndog
  const corndogGroups = [
    {
      name: 'Extras', type: 'multi', required: false,
      options: [opt('Extra Cheese Dip', 15)]
    }
  ];

  // Chillers (sundaes/floats/macchiatos are already flavor-specific by
  // name, so they just get a lightweight Extras group; Giant Twirl gets
  // its own dedicated Flavor group, set separately below)
  const chillersGroups = [
    {
      name: 'Extras', type: 'multi', required: false,
      options: [opt('Extra Toppings', 10)]
    }
  ];

  const chickenResult  = await MenuItem.updateMany({ category: { $in: chickenCategories } }, { $set: { variantGroups: chickenGroups } });
  const friesResult    = await MenuItem.updateMany({ category: 'Fries' },    { $set: { variantGroups: friesGroups } });
  const corndogResult  = await MenuItem.updateMany({ category: 'Corndog' },  { $set: { variantGroups: corndogGroups } });
  const chillersResult = await MenuItem.updateMany(
    { category: 'Chillers', name: { $not: { $regex: '^Giant Twirl' } } },
    { $set: { variantGroups: chillersGroups } }
  );

  // Consolidate the 3 Giant Twirl items into one item with a Flavor group
  const giantTwirls = await MenuItem.find({ name: { $regex: '^Giant Twirl' } }).sort({ name: 1 });
  let giantTwirlResult = 'No Giant Twirl items found';
  if (giantTwirls.length > 0) {
    const keeper = giantTwirls[0];
    keeper.name = 'Giant Twirl';
    keeper.description = 'Soft serve cone — Chocolate, Vanilla, or Mix';
    keeper.variantGroups = [
      { name: 'Flavor', type: 'single', required: true, options: [opt('Chocolate'), opt('Vanilla'), opt('Mix')] }
    ];
    await keeper.save();

    const toRemove = giantTwirls.slice(1).map(d => d._id);
    if (toRemove.length > 0) {
      await MenuItem.deleteMany({ _id: { $in: toRemove } });
    }
    giantTwirlResult = `Consolidated ${giantTwirls.length} Giant Twirl item(s) into one`;
  }

  res.send({
    message: 'Variant group migration complete',
    chickenItemsUpdated:  chickenResult.modifiedCount,
    friesItemsUpdated:    friesResult.modifiedCount,
    corndogItemsUpdated:  corndogResult.modifiedCount,
    chillersItemsUpdated: chillersResult.modifiedCount,
    giantTwirl: giantTwirlResult
  });
});

// ══════════════════════════════════════════
//  DAILY SALES ENDPOINTS
// ══════════════════════════════════════════

// GET all persisted daily summaries, newest first
app.get('/api/dailysales', async (req, res) => {
  const rows = await DailySales.find().sort({ date: -1 });
  res.send(rows);
});

// GET a single day's persisted summary
app.get('/api/dailysales/:date', async (req, res) => {
  const row = await DailySales.findOne({ date: req.params.date });
  if (!row) return res.status(404).send({ error: 'No summary for that date' });
  res.send(row);
});

// ══════════════════════════════════════════
//  KIOSK SETTINGS ENDPOINTS
// ══════════════════════════════════════════

app.get('/api/settings', async (req, res) => {
  let settings = await KioskSettings.findOne();
  if (!settings) { settings = new KioskSettings(); await settings.save(); }
  res.send(settings);
});

app.put('/api/settings', async (req, res) => {
  let settings = await KioskSettings.findOne();
  if (!settings) {
    settings = new KioskSettings(req.body);
  } else {
    Object.assign(settings, req.body);
  }
  await settings.save();
  console.log('Settings updated');
  res.send(settings);
});

// ══════════════════════════════════════════
//  BACKUP EXPORT ENDPOINT
// ══════════════════════════════════════════

// GET /api/backup
// Returns ALL system data in one payload.
// Angular uses SheetJS to convert this into a multi-sheet Excel file client-side.
// Sheets: Orders (flat rows), Daily Summary, Menu Items, Staff

app.get('/api/backup', async (req, res) => {
  const [orders, menu, staff] = await Promise.all([
    Order.find().sort({ timestamp: 1 }),
    MenuItem.find(),
    Staff.find()
  ]);

  // Sheet 1 — Orders: one row per item line within each order
  // (only covers whatever orders currently still exist — reset days
  // have no raw order rows left, same as in Sales History)
  const orderRows = [];
  orders.forEach(order => {
    const date = new Date(order.timestamp)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const time = new Date(order.timestamp)
      .toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
    order.items.forEach(entry => {
      orderRows.push({
        'Date':             date,
        'Time':             time,
        'Order ID':         order.displayId || order._id.toString(),
        'Branch':           order.branch,
        'Employee':         order.staffName,
        'Item Name':        entry.item.name,
        'Options':          (entry.selectedOptions || []).map(o => `${o.groupName}: ${o.label}${o.priceDelta ? ' (+₱' + o.priceDelta + ')' : ''}`).join(', '),
        'Category':         entry.item.category,
        'Unit Price':       entry.item.price,
        'Quantity':         entry.quantity,
        'Subtotal':         entry.item.price * entry.quantity,
        'Order Total':      order.total,
        'Transaction Mode': order.transactionMode,
        'Payment Mode':     order.paymentMode,
        'Status':           order.status || 'completed'
      });
    });
  });

  // Sheet 2 — Daily Summary: one row per day (now includes reset days too)
  const dailySummaryRows = (await getMergedDailyHistory(orders)).map(day => ({
    'Date':           day.date,
    'Total Sales':    day.totalSales,
    'Total Orders':   day.totalOrders,
    'Dine In':        day.transactions.dineIn,
    'Take Out':       day.transactions.takeOut,
    'Grab':           day.transactions.grab,
    'Cash':           day.payments.cash,
    'Online/GCash':   day.payments.online,
  }));

  // Sheet 3 — Menu Items
  const menuRows = menu.map(item => ({
    'Name':        item.name,
    'Category':    item.category,
    'Price':       item.price,
    'Description': item.description,
    'Image':       item.image
  }));

  // Sheet 4 — Staff (password excluded from export)
  const staffRows = staff.map(s => ({
    'Staff Code': s.staffCode,
    'Name':       s.name,
    'branch':     s.branch,
  }));

  res.send({ orderRows, dailySummaryRows, menuRows, staffRows });
  console.log('Full backup exported');
});


const opt = (label, priceDelta = 0) => ({ label, priceDelta });

const chickenVariantGroups = [
  { name: 'Sauce', type: 'single', required: true, options: [opt('Honey Butter'), opt('Lemon Glaze'), opt('Yamyeong'), opt('Cheese')] },
  { name: 'Spice Level', type: 'single', required: true, options: [opt('Mild'), opt('Medium'), opt('Hot')] },
  { name: 'Extras', type: 'multi', required: false, options: [opt('Extra Rice', 25), opt('Extra Fries', 35), opt('Extra Sauce', 15)] }
];

const friesVariantGroups = [
  { name: 'Flavor', type: 'single', required: true, options: [opt('Cheese'), opt('Sour Cream'), opt('BBQ')] },
  { name: 'Extras', type: 'multi', required: false, options: [opt('Extra Dip', 15)] }
];

const corndogVariantGroups = [
  { name: 'Extras', type: 'multi', required: false, options: [opt('Extra Cheese Dip', 15)] }
];

const chillersVariantGroups = [
  { name: 'Extras', type: 'multi', required: false, options: [opt('Extra Toppings', 10)] }
];

const menuSeedData = [
  { name: 'Wings & Rice 2pcs', price: 90, category: 'Wings & Rice', description: '2 pcs chicken wings with steamed rice', image: 'wings-rice.jpg', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice 3pcs', price: 110, category: 'Wings & Rice', description: '3 pcs chicken wings with steamed rice', image: 'wings-rice.jpg', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 2pcs', price: 100, category: 'Wings & Fries', description: '2 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 3pcs', price: 120, category: 'Wings & Fries', description: '3 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 4pcs', price: 125, category: 'Wings & Fries', description: '4 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 5pcs', price: 140, category: 'Wings & Fries', description: '5 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Gravy 2pcs', price: 80, category: 'Wings & Gravy', description: '2 pcs chicken wings with rice and gravy', image: 'wings-gravy.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Gravy 3pcs', price: 90, category: 'Wings & Gravy', description: '3 pcs chicken wings with rice and gravy', image: 'wings-gravy2.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Drinks', price: 175, category: 'Wings & Drinks', description: 'Chicken wings with plain rice and drinks', image: 'wings-rice-drinks.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 1', price: 180, category: 'Combos', description: '6 pcs chicken only (2 flavor of choice)', image: 'combo1.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 2', price: 240, category: 'Combos', description: '8 pcs chicken only (flavor of choice)', image: 'combo2.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 3', price: 154, category: 'Combos', description: '2 pcs chicken with cheese hotdog', image: 'combo2.png', variantGroups: chickenVariantGroups },
  { name: 'Fries Small', price: 50, category: 'Fries', description: 'Small fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Fries Medium', price: 60, category: 'Fries', description: 'Medium fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Fries Large', price: 80, category: 'Fries', description: 'Large fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Mozzarella Corndog', price: 100, category: 'Corndog', description: 'Chut Chut style mozzarella corndog', image: 'corndog.jpg', variantGroups: corndogVariantGroups },
  { name: 'Cheese Hotdog Corndog', price: 85, category: 'Corndog', description: 'Chut Chut style cheese hotdog corndog', image: 'corndog.jpg', variantGroups: corndogVariantGroups },
  { name: 'Cone Twirl Vanilla', price: 25, category: 'Chillers', description: 'Soft serve vanilla cone twirl', image: 'vanilla.jpg', variantGroups: chillersVariantGroups },
  { name: 'Cone Twirl Chocolate', price: 25, category: 'Chillers', description: 'Soft serve chocolate cone twirl', image: 'chocolate.jpg', variantGroups: chillersVariantGroups },
  { name: 'Cone Twirl Mix', price: 25, category: 'Chillers', description: 'Soft serve vanilla & chocolate mix', image: 'mix.jpg', variantGroups: chillersVariantGroups },
  { name: 'Strawberry Sundae', price: 40, category: 'Chillers', description: 'Creamy strawberry sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Blueberry Sundae', price: 40, category: 'Chillers', description: 'Creamy blueberry sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Caramel Sundae', price: 40, category: 'Chillers', description: 'Rich caramel sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Crimson Sundae', price: 40, category: 'Chillers', description: 'Crimson flavor sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Lemon Sundae', price: 40, category: 'Chillers', description: 'Refreshing lemon sundae twist', image: 'lemonsundae.png', variantGroups: chillersVariantGroups },
  { name: 'Giant Twirl', price: 35, category: 'Chillers', description: 'Soft serve cone — Chocolate, Vanilla, or Mix', image: 'giantwirl.png', variantGroups: [{ name: 'Flavor', type: 'single', required: true, options: [opt('Chocolate'), opt('Vanilla'), opt('Mix')] }] },
  { name: 'Soda Float 7UP', price: 50, category: 'Chillers', description: '7UP soda float with soft serve', image: '7up.jpg', variantGroups: chillersVariantGroups },
  { name: 'Soda Float Coke', price: 50, category: 'Chillers', description: 'Coke soda float with soft serve', image: 'coke.jpg', variantGroups: chillersVariantGroups },
  { name: 'Soda Float Royal', price: 50, category: 'Chillers', description: 'Royal soda float with soft serve', image: 'royal.jpg', variantGroups: chillersVariantGroups },
  { name: 'Chocolate Macchiato', price: 55, category: 'Chillers', description: 'Chut Chut premium chocolate macchiato', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: 'Caramel Macchiato', price: 55, category: 'Chillers', description: 'Iced caramel macchiato', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: 'French Vanilla', price: 55, category: 'Chillers', description: 'Chilled iced french vanilla', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Choco Crunkies", price: 50, category: 'Chillers', description: 'Sundae overload with toppings', image: 'choco.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Caramel Nut Crunch", price: 50, category: 'Chillers', description: 'Rocky road sundae with toppings', image: 'caramel.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Strawberry Crunch", price: 50, category: 'Chillers', description: 'Graham pampig sundae with toppings', image: 'strawberry.png', variantGroups: chillersVariantGroups },
];
app.post('/api/menu', async (req, res) => {
  const item = new MenuItem(req.body);
  await item.save();
  res.status(201).send(item);
});

// ══════════════════════════════════════════
//  IMAGE UPLOAD ENDPOINT
// ══════════════════════════════════════════

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'No file uploaded' });
  console.log('Image uploaded:', req.file.filename);
  res.status(201).send({
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`
  });
});

// Handles multer errors (bad file type, too large) with a clean JSON response
// instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('image files')) {
    return res.status(400).send({ error: err.message });
  }
  next(err);
});

app.post('/api/seed', async (req, res) => {
  const existingMenu  = await MenuItem.countDocuments();
  const existingStaff = await Staff.countDocuments();
  if (existingMenu > 0 || existingStaff > 0) {
    return res.status(400).send({ message: 'Seed skipped — DB already has data.' });
  }
  const insertedMenu  = await MenuItem.insertMany(menuSeedData);
  const insertedStaff = await Staff.insertMany(staffSeedData);
  let settings = await KioskSettings.findOne();
  if (!settings) settings = await KioskSettings.create({});
  console.log(`Seeded ${insertedMenu.length} menu items, ${insertedStaff.length} staff.`);
  res.status(201).send({
    message: `Seeded ${insertedMenu.length} menu items and ${insertedStaff.length} staff.`,
    managerPassword: settings.managerPassword
  });
});

// ── START SERVER ──
app.listen(3000, () => {
  console.log('Chut Chut server is running on port 3000');
});
