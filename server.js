require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONNECT TO MONGODB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const MenuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  price:       { type: Number, required: true },
  category:    { type: String, required: true },
  description: { type: String, default: '' },
  image:       { type: String, default: '' }
});
const MenuItem = mongoose.model('MenuItem', MenuItemSchema);

const StaffSchema = new mongoose.Schema({
  staffCode: { type: String, required: true, unique: true },
  name:      { type: String, required: true },
  contact:   { type: String, default: '' },
  status:    { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  dateAdded: { type: String, default: '' },
  password:  { type: String, required: true }
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
      quantity: Number
    }
  ],
  total:           { type: Number, required: true },
  transactionMode: { type: String, default: '' },
  paymentMode:     { type: String, default: '' },
  timestamp:       { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', OrderSchema);

const KioskSettingsSchema = new mongoose.Schema({
  kioskName:        { type: String, default: 'Chut Chut' },
  transactionModes: { type: [String], default: ['Dine In', 'Take Out', 'Grab'] },
  paymentModes:     { type: [String], default: ['Cash', 'Online Payment', 'Grab'] },
  managerPassword:  { type: String, default: 'admin2024' }
});
const KioskSettings = mongoose.model('KioskSettings', KioskSettingsSchema);

// ══════════════════════════════════════════
//  DAILY SALES — persisted per-day summary
//  Written to the DB (not just computed live) so the
//  `dailysales` collection actually has data, and so a
//  day's totals survive even after its raw orders are
//  wiped by a reset.
// ══════════════════════════════════════════

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

// Returns the UTC start/end instants that correspond to midnight-to-midnight
// in Asia/Manila for whatever date `refDate` falls on. Manila is UTC+8 with
// no DST, so this is a fixed offset — safe to hardcode.
function getManilaDayBounds(refDate = new Date()) {
  const dateStr = refDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // "YYYY-MM-DD"
  const start = new Date(`${dateStr}T00:00:00+08:00`);
  const end   = new Date(`${dateStr}T23:59:59.999+08:00`);
  return { dateStr, start, end };
}

// Recomputes one day's summary straight from the Orders collection
async function upsertDailySales(refDate = new Date()) {
  const { dateStr, start, end } = getManilaDayBounds(refDate);
  const orders = await Order.find({ timestamp: { $gte: start, $lte: end } });

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
    day.totalSales  += order.total;
    day.totalOrders += 1;
    day.orders.push(order);

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

// Merges live-computed history (from whatever is still in `orders`) with
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

// GET today's orders — used by both dashboard and manager live view
app.get('/api/orders/today', async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const orders = await Order.find({ timestamp: { $gte: startOfDay } }).sort({ timestamp: -1 });
  res.send(orders);
});

// GET all orders grouped by date — used by Sales History tab
// Returns one entry per day with totals, breakdowns, top items, and raw orders.
// Days whose orders were wiped by a reset are filled in from `dailysales`.
app.get('/api/orders/history', async (req, res) => {
  const orders = await Order.find().sort({ timestamp: 1 });
  res.send(await getMergedDailyHistory(orders));
});

// POST a new order
app.post('/api/orders', async (req, res) => {
  const order = new Order(req.body);
  await order.save();
  console.log('New order — ₱' + order.total);

  // Keep today's row in `dailysales` in sync with the new order
  try {
    await upsertDailySales(order.timestamp);
  } catch (err) {
    console.error('Failed to upsert dailysales:', err);
  }

  res.status(201).send(order);
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


//  DAILY SALES ENDPOINTS
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

//  KIOSK SETTINGS ENDPOINTS
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
      orderRows.push({
        'Date':             date,
        'Time':             time,
        'Order ID':         order._id.toString(),
        'Item Name':        entry.item.name,
        'Category':         entry.item.category,
        'Unit Price':       entry.item.price,
        'Quantity':         entry.quantity,
        'Subtotal':         entry.item.price * entry.quantity,
        'Order Total':      order.total,
        'Transaction Mode': order.transactionMode,
        'Payment Mode':     order.paymentMode
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
    'Grab Pay':       day.payments.grab
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
    'Contact':    s.contact,
    'Status':     s.status,
    'Date Added': s.dateAdded
  }));

  res.send({ orderRows, dailySummaryRows, menuRows, staffRows });
  console.log('Full backup exported');
});


const menuSeedData = [
  { name: 'Wings & Rice 2pcs', price: 90, category: 'Wings & Rice', description: '2 pcs chicken wings with steamed rice', image: 'wings-rice.jpg' },
  { name: 'Wings & Rice 3pcs', price: 110, category: 'Wings & Rice', description: '3 pcs chicken wings with steamed rice', image: 'wings-rice.jpg' },
  { name: 'Wings & Fries 2pcs', price: 100, category: 'Wings & Fries', description: '2 pcs chicken wings with fries', image: 'wingsfries.png' },
  { name: 'Wings & Fries 3pcs', price: 120, category: 'Wings & Fries', description: '3 pcs chicken wings with fries', image: 'wingsfries.png' },
  { name: 'Wings & Fries 4pcs', price: 125, category: 'Wings & Fries', description: '4 pcs chicken wings with fries', image: 'wingsfries.png' },
  { name: 'Wings & Fries 5pcs', price: 140, category: 'Wings & Fries', description: '5 pcs chicken wings with fries', image: 'wingsfries.png' },
  { name: 'Wings & Rice w/ Gravy 2pcs', price: 80, category: 'Wings & Gravy', description: '2 pcs chicken wings with rice and gravy', image: 'wings-gravy.png' },
  { name: 'Wings & Rice w/ Gravy 3pcs', price: 90, category: 'Wings & Gravy', description: '3 pcs chicken wings with rice and gravy', image: 'wings-gravy2.png' },
  { name: 'Wings & Rice w/ Drinks', price: 175, category: 'Wings & Drinks', description: 'Chicken wings with plain rice and drinks', image: 'wings-rice-drinks.png' },
  { name: 'Combo 1', price: 180, category: 'Combos', description: '6 pcs chicken only (2 flavor of choice)', image: 'combo1.png' },
  { name: 'Combo 2', price: 240, category: 'Combos', description: '8 pcs chicken only (flavor of choice)', image: 'combo2.png' },
  { name: 'Combo 3', price: 154, category: 'Combos', description: '2 pcs chicken with cheese hotdog', image: 'combo2.png' },
  { name: 'Fries Small', price: 50, category: 'Fries', description: 'Small fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg' },
  { name: 'Fries Medium', price: 60, category: 'Fries', description: 'Medium fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg' },
  { name: 'Fries Large', price: 80, category: 'Fries', description: 'Large fries — Cheese, Sour Cream, or BBQ', image: 'fries.jpg' },
  { name: 'Mozzarella Corndog', price: 100, category: 'Corndog', description: 'Chut Chut style mozzarella corndog', image: 'corndog.jpg' },
  { name: 'Cheese Hotdog Corndog', price: 85, category: 'Corndog', description: 'Chut Chut style cheese hotdog corndog', image: 'corndog.jpg' },
  { name: 'Cone Twirl Vanilla', price: 25, category: 'Chillers', description: 'Soft serve vanilla cone twirl', image: 'vanilla.jpg' },
  { name: 'Cone Twirl Chocolate', price: 25, category: 'Chillers', description: 'Soft serve chocolate cone twirl', image: 'chocolate.jpg' },
  { name: 'Cone Twirl Mix', price: 25, category: 'Chillers', description: 'Soft serve vanilla & chocolate mix', image: 'mix.jpg' },
  { name: 'Strawberry Sundae', price: 40, category: 'Chillers', description: 'Creamy strawberry sundae twist', image: 'sundaetwist.png' },
  { name: 'Blueberry Sundae', price: 40, category: 'Chillers', description: 'Creamy blueberry sundae twist', image: 'sundaetwist.png' },
  { name: 'Caramel Sundae', price: 40, category: 'Chillers', description: 'Rich caramel sundae twist', image: 'sundaetwist.png' },
  { name: 'Crimson Sundae', price: 40, category: 'Chillers', description: 'Crimson flavor sundae twist', image: 'sundaetwist.png' },
  { name: 'Lemon Sundae', price: 40, category: 'Chillers', description: 'Refreshing lemon sundae twist', image: 'lemonsundae.png' },
  { name: 'Giant Twirl Chocolate', price: 35, category: 'Chillers', description: 'Large chocolate soft serve cone', image: 'giantwirl.png' },
  { name: 'Giant Twirl Vanilla', price: 35, category: 'Chillers', description: 'Large vanilla soft serve cone', image: 'giantwirl.png' },
  { name: 'Giant Twirl Mix', price: 35, category: 'Chillers', description: 'Large vanilla & chocolate mix cone', image: 'giantwirl.png' },
  { name: 'Soda Float 7UP', price: 50, category: 'Chillers', description: '7UP soda float with soft serve', image: '7up.jpg' },
  { name: 'Soda Float Coke', price: 50, category: 'Chillers', description: 'Coke soda float with soft serve', image: 'coke.jpg' },
  { name: 'Soda Float Royal', price: 50, category: 'Chillers', description: 'Royal soda float with soft serve', image: 'royal.jpg' },
  { name: 'Chocolate Macchiato', price: 55, category: 'Chillers', description: 'Chut Chut premium chocolate macchiato', image: 'icedcoffee.png' },
  { name: 'Caramel Macchiato', price: 55, category: 'Chillers', description: 'Iced caramel macchiato', image: 'icedcoffee.png' },
  { name: 'French Vanilla', price: 55, category: 'Chillers', description: 'Chilled iced french vanilla', image: 'icedcoffee.png' },
  { name: "Sundae's Best Choco Crunkies", price: 50, category: 'Chillers', description: 'Sundae overload with toppings', image: 'choco.png' },
  { name: "Sundae's Best Caramel Nut Crunch", price: 50, category: 'Chillers', description: 'Rocky road sundae with toppings', image: 'caramel.png' },
  { name: "Sundae's Best Strawberry Crunch", price: 50, category: 'Chillers', description: 'Graham pampig sundae with toppings', image: 'strawberry.png' },
];

const staffSeedData = [
  { staffCode: 'EMP001', name: 'Juan Dela Cruz', contact: '09123456789', status: 'Active', dateAdded: '2026-06-01', password: 'juan2024' },
  { staffCode: 'EMP002', name: 'Maria Santos', contact: '09987654321', status: 'Active', dateAdded: '2026-06-01', password: 'maria2024' },
];

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