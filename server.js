const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── TRUST RENDER'S PROXY ──
app.set('trust proxy', 1);

// ── SECURITY HEADERS ──
app.use(helmet());

// ── CORS — locked down to known frontend origins only ──
const allowedOrigins = [
  'http://localhost:4200',
  'https://chutchut-project-hazel.vercel.app',
  'https://chutchut-project.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn('Blocked by CORS:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// ── STRIP MONGO OPERATORS FROM USER INPUT ──
function sanitizeInPlace(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
      continue;
    }
    if (obj[key] && typeof obj[key] === 'object') sanitizeInPlace(obj[key]);
  }
  return obj;
}

app.use((req, res, next) => {
  sanitizeInPlace(req.body);
  sanitizeInPlace(req.params);
  sanitizeInPlace(req.query);
  next();
});

// ── RATE LIMITING ──
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

// ── ADMIN GATE FOR ONE-OFF MIGRATION / SEED ROUTES ──
function requireAdminKey(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).send({ error: 'Forbidden — missing or invalid admin key.' });
  }
  next();
}

// ── IMAGE UPLOADS ──
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '-');
    cb(null, `${base}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
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

// ══════════════════════════════════════════
//  PRICE HELPER — mirrors priceForBranch() in the Angular app's
//  cart-services.ts. Menu items and order line snapshots now store
//  branchPricing (an array of {branch, price}) instead of a single
//  flat `price` field, so anywhere the old code read `item.price`
//  or `entry.item.price` needs to go through this instead.
// ══════════════════════════════════════════
function priceForBranch(item, branch) {
  if (!item || !Array.isArray(item.branchPricing)) return 0;
  const match = item.branchPricing.find(bp => bp.branch === branch);
  return match ? match.price : 0;
}

const MenuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true },

  // Per-branch pricing — replaces the old single `price: Number` field.
  branchPricing: {
    type: [{
      branch: { type: String, required: true },
      price:  { type: Number, required: true, default: 0 }
    }],
    default: []
  },

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
      name:     { type: String, required: true },
      type:     { type: String, enum: ['single', 'multi'], default: 'single' },
      required: { type: Boolean, default: false },
      options: [{
        label:      { type: String, required: true },
        priceDelta: { type: Number, default: 0 }
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
        // Snapshot of the item's branch pricing at order time —
        // replaces the old flat `price: Number` field.
        branchPricing: [{ branch: String, price: Number }],
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
  managerPassword:  { type: String, default: 'manager@2026' },

  // Marks the moment the Manager last clicked "Reset Today's Sales".
  // Orders placed BEFORE this instant stop showing up in the live
  // Dashboard views (Manager Dashboard tab + every Employee Dashboard),
  // but the Order documents themselves are never touched — Transactions
  // and Sales History read straight from the Order collection and are
  // completely unaffected by this marker. See GET /api/orders/today.
  lastDashboardResetAt: { type: Date, default: null }
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
  key: { type: String, required: true, unique: true },
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

function getManilaDayBounds(refDate = new Date()) {
  const dateStr = refDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const start = new Date(`${dateStr}T00:00:00+08:00`);
  const end   = new Date(`${dateStr}T23:59:59.999+08:00`);
  return { dateStr, start, end };
}

// Recomputes one day's summary straight from the Orders collection.
// Cancelled orders are excluded from every total below.
async function upsertDailySales(refDate = new Date()) {
  const { dateStr, start, end } = getManilaDayBounds(refDate);
  const allOrders = await Order.find({ timestamp: { $gte: start, $lte: end } });
  const orders = allOrders.filter(o => o.status !== 'cancelled');

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
      const unitPrice = priceForBranch(entry.item, order.branch);
      if (itemMap.has(key)) {
        itemMap.get(key).qty   += entry.quantity;
        itemMap.get(key).total += unitPrice * entry.quantity;
      } else {
        itemMap.set(key, {
          name:  key,
          qty:   entry.quantity,
          total: unitPrice * entry.quantity
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
    day.orders.push(order);

    if (order.status === 'cancelled') return;

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
      const unitPrice = priceForBranch(entry.item, order.branch);
      if (day.itemMap.has(key)) {
        day.itemMap.get(key).qty   += entry.quantity;
        day.itemMap.get(key).total += unitPrice * entry.quantity;
      } else {
        day.itemMap.set(key, {
          name:  key,
          qty:   entry.quantity,
          total: unitPrice * entry.quantity
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
    orders:       []
  }));

  return [...liveHistory, ...archivedHistory].sort((a, b) => b.date.localeCompare(a.date));
}

//  LOGIN ENDPOINTS
app.post('/api/login/manager', loginLimiter, async (req, res) => {
  const { password } = req.body;
  let settings = await KioskSettings.findOne();
  if (!settings) { settings = new KioskSettings(); await settings.save(); }
  if (password === settings.managerPassword) {
    return res.send({ success: true, role: 'Manager' });
  }
  res.status(401).send({ success: false, message: 'Incorrect manager password' });
});

app.post('/api/login/staff', loginLimiter, async (req, res) => {
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

// DELETE — permanently wipes ALL staff accounts across every branch.
// Must be declared BEFORE '/api/staff/:id' or Express matches "all" as an :id.
app.delete('/api/staff/all', async (req, res) => {
  try {
    const result = await Staff.deleteMany({});
    console.log(`Cleared ALL staff: ${result.deletedCount} deleted`);
    res.send({ message: `Cleared ${result.deletedCount} staff members` });
  } catch (err) {
    console.error('Failed to clear all staff:', err);
    res.status(500).send({ error: 'Failed to clear all staff' });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  const member = await Staff.findByIdAndDelete(req.params.id);
  if (!member) return res.status(404).send({ error: 'Staff not found' });
  res.send({ message: 'Staff deleted' });
});

// ══════════════════════════════════════════
//  ORDER ENDPOINTS
// ══════════════════════════════════════════

app.get('/api/orders/today', async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // If the Manager reset the dashboard earlier today, only orders placed
  // AFTER that reset count as "today" for live dashboard purposes. A
  // reset from a previous day is ignored — every new calendar day starts
  // fresh regardless of when the last reset happened.
  let effectiveStart = startOfDay;
  const settings = await KioskSettings.findOne();
  if (settings?.lastDashboardResetAt && settings.lastDashboardResetAt > startOfDay) {
    effectiveStart = settings.lastDashboardResetAt;
  }

  const filter = { timestamp: { $gte: effectiveStart } };
  if (req.query.branch) filter.branch = req.query.branch;
  const orders = await Order.find(filter).sort({ timestamp: -1 });
  res.send(orders);
});

app.get('/api/orders/history', async (req, res) => {
  const orders = await Order.find().sort({ timestamp: 1 });
  res.send(await getMergedDailyHistory(orders));
});

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

  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales:', err);
  }

  res.status(201).send(order);
});

app.patch('/api/orders/:id/cancel', async (req, res) => {
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status: 'cancelled' },
    { new: true }
  );
  if (!order) return res.status(404).send({ error: 'Order not found' });

  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales after cancel:', err);
  }

  console.log(`Order ${order.displayId || order._id} cancelled`);
  res.send(order);
});

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

app.delete('/api/orders/all', async (req, res) => {
  try {
    const result = await Order.deleteMany({});
    await DailySales.deleteMany({});
    console.log(`Cleared ALL orders: ${result.deletedCount} deleted, plus all daily summaries`);
    res.send({ message: `Cleared ${result.deletedCount} orders and all sales history` });
  } catch (err) {
    console.error('Failed to clear all orders:', err);
    res.status(500).send({ error: 'Failed to clear all orders' });
  }
});

// PATCH — soft-resets the "Today" view on the Manager Dashboard AND every
// Employee Dashboard, without deleting anything. It just moves a marker
// (KioskSettings.lastDashboardResetAt) forward to "now"; GET /api/orders/today
// then only returns orders placed after that marker, so today's live sales
// widgets go back to zero. The actual Order documents are left completely
// alone, so the Transactions tab and Sales History tab (which query the
// Order collection directly, not this marker) keep showing every order
// placed today, before and after the reset, permanently.
app.patch('/api/dashboard/reset', async (req, res) => {
  let settings = await KioskSettings.findOne();
  if (!settings) settings = new KioskSettings();
  settings.lastDashboardResetAt = new Date();
  await settings.save();
  console.log(`Dashboard reset at ${settings.lastDashboardResetAt.toISOString()}`);
  res.send({ message: 'Dashboard reset.', resetAt: settings.lastDashboardResetAt });
});

// ══════════════════════════════════════════
//  ONE-TIME MIGRATION — backfill displayId for existing orders
//  that were created before branch order numbering existed.
//  GATED behind ADMIN_KEY — see requireAdminKey() above. Call with header
//  x-admin-key: <your ADMIN_KEY>. Remove this route entirely once you've
//  run it and confirmed the response.
// ══════════════════════════════════════════
app.post('/api/migrate/branch-order-numbers', requireAdminKey, async (req, res) => {
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
//  GATED behind ADMIN_KEY. Call with header x-admin-key: <your ADMIN_KEY>.
//  Remove this route entirely once you've run it and confirmed the response.
// ══════════════════════════════════════════
app.post('/api/migrate/add-variant-groups', requireAdminKey, async (req, res) => {
  const opt = (label, priceDelta = 0) => ({ label, priceDelta });

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

  const corndogGroups = [
    {
      name: 'Extras', type: 'multi', required: false,
      options: [opt('Extra Cheese Dip', 15)]
    }
  ];

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

app.get('/api/dailysales', async (req, res) => {
  const rows = await DailySales.find().sort({ date: -1 });
  res.send(rows);
});

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

app.get('/api/backup', async (req, res) => {
  const [orders, menu, staff] = await Promise.all([
    Order.find().sort({ timestamp: 1 }),
    MenuItem.find(),
    Staff.find()
  ]);

  // Sheet 1 — Orders: one row per item line within each order
  const orderRows = [];
  orders.forEach(order => {
    const date = new Date(order.timestamp)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const time = new Date(order.timestamp)
      .toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
    order.items.forEach(entry => {
      const unitPrice = priceForBranch(entry.item, order.branch);
      orderRows.push({
        'Date':             date,
        'Time':             time,
        'Order ID':         order.displayId || order._id.toString(),
        'Branch':           order.branch,
        'Employee':         order.staffName,
        'Item Name':        entry.item.name,
        'Options':          (entry.selectedOptions || []).map(o => `${o.groupName}: ${o.label}${o.priceDelta ? ' (+₱' + o.priceDelta + ')' : ''}`).join(', '),
        'Category':         entry.item.category,
        'Unit Price':       unitPrice,
        'Quantity':         entry.quantity,
        'Subtotal':         unitPrice * entry.quantity,
        'Order Total':      order.total,
        'Transaction Mode': order.transactionMode,
        'Payment Mode':     order.paymentMode,
        'Status':           order.status || 'completed'
      });
    });
  });

  // Sheet 2 — Daily Summary
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

  // Sheet 3 — Menu Items (one column per branch price)
  const menuRows = menu.map(item => {
    const row = {
      'Name':        item.name,
      'Category':    item.category,
      'Description': item.description,
      'Image':       item.image
    };
    (item.branchPricing || []).forEach(bp => {
      row[bp.branch] = bp.price;
    });
    return row;
  });

  // Sheet 4 — Staff (password excluded from export)
  const staffRows = staff.map(s => ({
    'Staff Code': s.staffCode,
    'Name':       s.name,
    'branch':     s.branch,
  }));

  res.send({ orderRows, dailySummaryRows, menuRows, staffRows });
  console.log('Full backup exported');
});

// ══════════════════════════════════════════
//  SEED DATA
//  NOTE: uses branchPricing (per-branch array) to match the current
//  MenuItemSchema. All three branches are seeded at the same starting
//  price — adjust per branch afterward from the Menu tab as needed.
// ══════════════════════════════════════════

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

// Builds the same starting price for all three branches — edit per
// branch from the Manager Panel's Menu tab after seeding if needed.
const allBranches = (price) => [
  { branch: 'Harrison Bazaar', price },
  { branch: 'Pines Arcade',    price },
  { branch: 'Porta Vaga',      price }
];

const menuSeedData = [
  { name: 'Wings & Rice 2pcs', branchPricing: allBranches(90), category: 'Wings & Rice', description: '2 pcs chicken wings with steamed rice', image: 'wings-rice.jpg', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice 3pcs', branchPricing: allBranches(110), category: 'Wings & Rice', description: '3 pcs chicken wings with steamed rice', image: 'wings-rice.jpg', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 2pcs', branchPricing: allBranches(100), category: 'Wings & Fries', description: '2 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 3pcs', branchPricing: allBranches(120), category: 'Wings & Fries', description: '3 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 4pcs', branchPricing: allBranches(125), category: 'Wings & Fries', description: '4 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Fries 5pcs', branchPricing: allBranches(140), category: 'Wings & Fries', description: '5 pcs chicken wings with fries', image: 'wingsfries.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Gravy 2pcs', branchPricing: allBranches(80), category: 'Wings & Gravy', description: '2 pcs chicken wings with rice and gravy', image: 'wings-gravy.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Gravy 3pcs', branchPricing: allBranches(90), category: 'Wings & Gravy', description: '3 pcs chicken wings with rice and gravy', image: 'wings-gravy2.png', variantGroups: chickenVariantGroups },
  { name: 'Wings & Rice w/ Drinks', branchPricing: allBranches(175), category: 'Wings & Drinks', description: 'Chicken wings with plain rice and drinks', image: 'wings-rice-drinks.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 1', branchPricing: allBranches(180), category: 'Combos', description: '6 pcs chicken only (2 flavor of choice)', image: 'combo1.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 2', branchPricing: allBranches(240), category: 'Combos', description: '8 pcs chicken only (flavor of choice)', image: 'combo2.png', variantGroups: chickenVariantGroups },
  { name: 'Combo 3', branchPricing: allBranches(154), category: 'Combos', description: '2 pcs chicken with cheese hotdog', image: 'combo2.png', variantGroups: chickenVariantGroups },
  { name: 'Fries Small', branchPricing: allBranches(50), category: 'Fries', description: 'Small fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Fries Medium', branchPricing: allBranches(60), category: 'Fries', description: 'Medium fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Fries Large', branchPricing: allBranches(80), category: 'Fries', description: 'Large fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg', variantGroups: friesVariantGroups },
  { name: 'Mozzarella Corndog', branchPricing: allBranches(100), category: 'Corndog', description: 'Chut Chut style mozzarella corndog', image: 'corndog.jpg', variantGroups: corndogVariantGroups },
  { name: 'Cheese Hotdog Corndog', branchPricing: allBranches(85), category: 'Corndog', description: 'Chut Chut style cheese hotdog corndog', image: 'corndog.jpg', variantGroups: corndogVariantGroups },
  { name: 'Cone Twirl Vanilla', branchPricing: allBranches(25), category: 'Chillers', description: 'Soft serve vanilla cone twirl', image: 'vanilla.jpg', variantGroups: chillersVariantGroups },
  { name: 'Cone Twirl Chocolate', branchPricing: allBranches(25), category: 'Chillers', description: 'Soft serve chocolate cone twirl', image: 'chocolate.jpg', variantGroups: chillersVariantGroups },
  { name: 'Cone Twirl Mix', branchPricing: allBranches(25), category: 'Chillers', description: 'Soft serve vanilla & chocolate mix', image: 'mix.jpg', variantGroups: chillersVariantGroups },
  { name: 'Strawberry Sundae', branchPricing: allBranches(40), category: 'Chillers', description: 'Creamy strawberry sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Blueberry Sundae', branchPricing: allBranches(40), category: 'Chillers', description: 'Creamy blueberry sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Caramel Sundae', branchPricing: allBranches(40), category: 'Chillers', description: 'Rich caramel sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Crimson Sundae', branchPricing: allBranches(40), category: 'Chillers', description: 'Crimson flavor sundae twist', image: 'sundaetwist.png', variantGroups: chillersVariantGroups },
  { name: 'Lemon Sundae', branchPricing: allBranches(40), category: 'Chillers', description: 'Refreshing lemon sundae twist', image: 'lemonsundae.png', variantGroups: chillersVariantGroups },
  { name: 'Giant Twirl', branchPricing: allBranches(35), category: 'Chillers', description: 'Soft serve cone — Chocolate, Vanilla, or Mix', image: 'giantwirl.png', variantGroups: [{ name: 'Flavor', type: 'single', required: true, options: [opt('Chocolate'), opt('Vanilla'), opt('Mix')] }] },
  { name: 'Soda Float 7UP', branchPricing: allBranches(50), category: 'Chillers', description: '7UP soda float with soft serve', image: '7up.jpg', variantGroups: chillersVariantGroups },
  { name: 'Soda Float Coke', branchPricing: allBranches(50), category: 'Chillers', description: 'Coke soda float with soft serve', image: 'coke.jpg', variantGroups: chillersVariantGroups },
  { name: 'Soda Float Royal', branchPricing: allBranches(50), category: 'Chillers', description: 'Royal soda float with soft serve', image: 'royal.jpg', variantGroups: chillersVariantGroups },
  { name: 'Chocolate Macchiato', branchPricing: allBranches(55), category: 'Chillers', description: 'Chut Chut premium chocolate macchiato', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: 'Caramel Macchiato', branchPricing: allBranches(55), category: 'Chillers', description: 'Iced caramel macchiato', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: 'French Vanilla', branchPricing: allBranches(55), category: 'Chillers', description: 'Chilled iced french vanilla', image: 'icedcoffee.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Choco Crunkies", branchPricing: allBranches(50), category: 'Chillers', description: 'Sundae overload with toppings', image: 'choco.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Caramel Nut Crunch", branchPricing: allBranches(50), category: 'Chillers', description: 'Rocky road sundae with toppings', image: 'caramel.png', variantGroups: chillersVariantGroups },
  { name: "Sundae's Best Strawberry Crunch", branchPricing: allBranches(50), category: 'Chillers', description: 'Graham pampig sundae with toppings', image: 'strawberry.png', variantGroups: chillersVariantGroups },
];

const staffSeedData = [
  { staffCode: 'EMP001', name: 'Juan Dela Cruz', contact: '09123456789', status: 'Active', dateAdded: '2026-06-01', password: 'juan2024' },
  { staffCode: 'EMP002', name: 'Maria Santos', contact: '09987654321', status: 'Active', dateAdded: '2026-06-01', password: 'maria2024' },
];

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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('image files')) {
    return res.status(400).send({ error: err.message });
  }
  next(err);
});

// ── SEED — GATED behind ADMIN_KEY. Call with header x-admin-key: <your ADMIN_KEY>.
app.post('/api/seed', requireAdminKey, async (req, res) => {
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

// ── CORS ERROR HANDLER ──
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).send({ error: 'Not allowed by CORS' });
  }
  next(err);
});

// ── START SERVER ──
app.listen(3000, () => {
  console.log('Chut Chut server is running on port 3000');
});
