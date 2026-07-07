import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as XLSX from 'xlsx';

export interface MenuItem {
  _id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  image: string;
}

export interface CartItem {
  item: MenuItem;
  quantity: number;
}

export interface CompletedOrder {
  _id: string;
  items: CartItem[];
  total: number;
  transactionMode: string;
  paymentMode: string;
  timestamp: Date;
}

export interface Staff {
  _id: string;
  staffCode: string;
  name: string;
  contact: string;
  status: 'Active' | 'Inactive';
  dateAdded: string;
  password: string;
}

export interface KioskSettings {
  _id?: string;
  kioskName: string;
  transactionModes: string[];
  paymentModes: string[];
  managerPassword: string;
}

// One entry per day returned by GET /api/orders/history
// Computed live from raw orders grouped by PH timezone date
export interface OrderHistoryDay {
  date: string;                 // "YYYY-MM-DD"
  totalSales: number;
  totalOrders: number;
  transactions: { dineIn: number; takeOut: number; grab: number };
  payments:     { cash: number; online: number; grab: number };
  topItems:     { name: string; qty: number; total: number }[];
  orders:       CompletedOrder[]; // individual orders for that day
}

// Shape returned by GET /api/backup
export interface BackupPayload {
  orderRows:        Record<string, any>[];
  dailySummaryRows: Record<string, any>[];
  menuRows:         Record<string, any>[];
  staffRows:        Record<string, any>[];
}

@Injectable({
  providedIn: 'root'
})
export class CartServices {

  private http = inject(HttpClient);
  private api = 'http://localhost:3000/api';

  // ── SETTINGS ──
  kioskSettings = signal<KioskSettings>({
    kioskName: 'Chut Chut',
    transactionModes: ['Dine In', 'Take Out', 'Grab'],
    paymentModes: ['Cash', 'Online Payment', 'Grab'],
    managerPassword: 'admin2024'
  });

  // ── MENU ITEMS ──
  menuItems = signal<MenuItem[]>([]);

  // ── CART ──
  cartItems = signal<CartItem[]>([]);

  cartTotal = computed(() =>
    this.cartItems().reduce((sum, e) => sum + e.item.price * e.quantity, 0)
  );

  cartCount = computed(() =>
    this.cartItems().reduce((sum, e) => sum + e.quantity, 0)
  );

  // ── ORDER STATE ──
  transactionMode = signal<string>('');
  paymentMode     = signal<string>('');

  // ── TODAY'S COMPLETED ORDERS ──
  completedOrders = signal<CompletedOrder[]>([]);

  todaySales = computed(() =>
    this.completedOrders().reduce((sum, o) => sum + o.total, 0)
  );

  todayOrderCount = computed(() => this.completedOrders().length);

  // ── STAFF ──
  staffList    = signal<Staff[]>([]);
  currentStaff = signal<Staff | null>(null);

  // ── SALES HISTORY (all past days, computed live from DB orders) ──
  salesHistory = signal<OrderHistoryDay[]>([]);

  // ── EXPORT STATE ──
  exportLoading = signal<boolean>(false);

  // ══════════════════════════════════════════
  //  LOAD FROM DB
  // ══════════════════════════════════════════

  loadMenuItems(): void {
    this.http.get<MenuItem[]>(`${this.api}/menu`).subscribe(items => {
      this.menuItems.set(items);
    });
  }

  loadStaff(): void {
    this.http.get<Staff[]>(`${this.api}/staff`).subscribe(staff => {
      this.staffList.set(staff);
    });
  }

  loadTodayOrders(): void {
    this.http.get<CompletedOrder[]>(`${this.api}/orders/today`).subscribe(orders => {
      this.completedOrders.set(orders);
    });
  }

  loadSettings(): void {
    this.http.get<KioskSettings>(`${this.api}/settings`).subscribe(settings => {
      this.kioskSettings.set(settings);
    });
  }

  // Fetches all orders from DB grouped by date — powers the Sales History tab
  loadOrdersHistory(): void {
    this.http.get<OrderHistoryDay[]>(`${this.api}/orders/history`).subscribe(history => {
      this.salesHistory.set(history);
    });
  }

  // ══════════════════════════════════════════
  //  CART METHODS
  // ══════════════════════════════════════════

  addToCart(item: MenuItem): void {
    const current  = this.cartItems();
    const existing = current.find(e => e.item._id === item._id);
    if (existing) {
      this.cartItems.set(
        current.map(e => e.item._id === item._id
          ? { ...e, quantity: e.quantity + 1 }
          : e
        )
      );
    } else {
      this.cartItems.set([...current, { item, quantity: 1 }]);
    }
  }

  removeFromCart(itemId: string): void {
    this.cartItems.set(this.cartItems().filter(e => e.item._id !== itemId));
  }

  clearCart(): void {
    this.cartItems.set([]);
  }

  // ══════════════════════════════════════════
  //  ORDER METHODS
  // ══════════════════════════════════════════

  placeOrder(): void {
    const order = {
      items:           this.cartItems(),
      total:           this.cartTotal(),
      transactionMode: this.transactionMode(),
      paymentMode:     this.paymentMode(),
      timestamp:       new Date()
    };
    this.http.post<CompletedOrder>(`${this.api}/orders`, order).subscribe(saved => {
      this.completedOrders.set([...this.completedOrders(), saved]);
      this.clearCart();
    });
  }

  // Clears today's orders only — past days remain in DB
  resetDailySales(onComplete?: () => void): void {
    this.http.delete(`${this.api}/orders/reset`).subscribe(() => {
      this.completedOrders.set([]);
      if (onComplete) onComplete();
    });
  }
  // ══════════════════════════════════════════
  //  MENU ITEM METHODS
  // ══════════════════════════════════════════

  addMenuItem(item: Omit<MenuItem, '_id'>): void {
    this.http.post<MenuItem>(`${this.api}/menu`, item).subscribe(saved => {
      this.menuItems.set([...this.menuItems(), saved]);
    });
  }

  updateMenuItem(item: MenuItem): void {
    this.http.put<MenuItem>(`${this.api}/menu/${item._id}`, item).subscribe(updated => {
      this.menuItems.set(this.menuItems().map(m => m._id === updated._id ? updated : m));
    });
  }

  deleteMenuItem(itemId: string): void {
    this.http.delete(`${this.api}/menu/${itemId}`).subscribe(() => {
      this.menuItems.set(this.menuItems().filter(m => m._id !== itemId));
    });
  }

  // ══════════════════════════════════════════
  //  SETTINGS METHODS
  // ══════════════════════════════════════════

  updateSettings(newSettings: Partial<KioskSettings>): void {
    const merged = { ...this.kioskSettings(), ...newSettings };
    this.http.put<KioskSettings>(`${this.api}/settings`, merged).subscribe(saved => {
      this.kioskSettings.set(saved);
    });
  }

  toggleTransactionMode(mode: string): void {
    const current = this.kioskSettings().transactionModes;
    const updated = current.includes(mode)
      ? current.filter(m => m !== mode)
      : [...current, mode];
    this.updateSettings({ transactionModes: updated });
  }

  togglePaymentMode(mode: string): void {
    const current = this.kioskSettings().paymentModes;
    const updated = current.includes(mode)
      ? current.filter(m => m !== mode)
      : [...current, mode];
    this.updateSettings({ paymentModes: updated });
  }

  // ══════════════════════════════════════════
  //  STAFF METHODS
  // ══════════════════════════════════════════

  addStaff(staff: Omit<Staff, '_id'>): void {
    this.http.post<Staff>(`${this.api}/staff`, staff).subscribe(saved => {
      this.staffList.set([...this.staffList(), saved]);
    });
  }

  updateStaff(staff: Staff): void {
    this.http.put<Staff>(`${this.api}/staff/${staff._id}`, staff).subscribe(saved => {
      this.staffList.set(this.staffList().map(s => s._id === saved._id ? saved : s));
    });
  }

  removeStaff(staffId: string): void {
    this.http.delete(`${this.api}/staff/${staffId}`).subscribe(() => {
      this.staffList.set(this.staffList().filter(s => s._id !== staffId));
    });
  }


  //  SESSION METHODS
  setCurrentStaff(staff: Staff): void {
    this.currentStaff.set(staff);
  }

  logoutStaff(): void {
    this.currentStaff.set(null);
  }

  //  BACKUP EXPORT 
  //  Fetches all data, builds a 4-sheet Exce

  exportBackup(): void {
    this.exportLoading.set(true);

    this.http.get<BackupPayload>(`${this.api}/backup`).subscribe({
      next: (data) => {
        const wb = XLSX.utils.book_new();

        // Sheet 1 — Daily Summary (first so it opens by default)
        const wsSummary = XLSX.utils.json_to_sheet(data.dailySummaryRows);
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Daily Summary');

        // Sheet 2 — All Orders (flat, one row per item)
        const wsOrders = XLSX.utils.json_to_sheet(data.orderRows);
        XLSX.utils.book_append_sheet(wb, wsOrders, 'Orders');

        // Sheet 3 — Menu Items
        const wsMenu = XLSX.utils.json_to_sheet(data.menuRows);
        XLSX.utils.book_append_sheet(wb, wsMenu, 'Menu Items');

        // Sheet 4 — Staff
        const wsStaff = XLSX.utils.json_to_sheet(data.staffRows);
        XLSX.utils.book_append_sheet(wb, wsStaff, 'Staff');

        // Generate filename with today's date
        const today = new Date().toLocaleDateString('en-CA');
        XLSX.writeFile(wb, `ChutChut_Backup_${today}.xlsx`);

        this.exportLoading.set(false);
      },
      error: (err) => {
        console.error('Backup export failed:', err);
        this.exportLoading.set(false);
      }
    });
  }
}