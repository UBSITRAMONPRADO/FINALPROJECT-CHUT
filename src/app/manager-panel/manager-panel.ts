import { Component, inject, signal, computed, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { CartServices, MenuItem, Staff, OrderHistoryDay } from '../cart-services';

type HistoryView = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Component({
  selector: 'app-manager-panel',
  imports: [],
  templateUrl: './manager-panel.html',
  styleUrl: './manager-panel.css'
})
export class ManagerPanelComponent implements OnDestroy {
  router      = inject(Router);
  cartService = inject(CartServices);

  activeTab  = signal<string>('dashboard');
  successMsg = signal('');

  allTransactionModes = ['Dine In', 'Take Out', 'Grab'];
  allPaymentModes     = ['Cash', 'Gcash/Maya'];

  // ── PASSWORD MANAGEMENT ──
  newManagerPassword = signal('');

  // ── MENU MANAGEMENT ──
  showMenuForm  = signal(false);
  editingItem   = signal<MenuItem | null>(null);
  newItem       = signal<Partial<MenuItem>>({ name: '', price: 0, category: '', description: '', image: '' });

  // ── STAFF MANAGEMENT ──
  showStaffForm  = signal(false);
  editingStaff   = signal<Staff | null>(null);
  newStaff       = signal<Partial<Staff>>({ staffCode: '', name: '', contact: '', status: 'Active', dateAdded: '', password: '' });

  // ── SALES HISTORY — which day is expanded (legacy, kept for compatibility) ──
  expandedDate = signal<string | null>(null);

  // ── SALES HISTORY — grouping view (daily/weekly/monthly/yearly) ──
  historyView   = signal<HistoryView>('daily');
  expandedGroup = signal<string | null>(null);

  // ── SALES COMPUTED (today) ──
  itemSales = computed(() => {
    const orders = this.cartService.completedOrders();
    const map    = new Map<string, { name: string; qty: number; total: number; image: string }>();
    orders.forEach(order => {
      order.items.forEach(entry => {
        const existing = map.get(entry.item.name);
        if (existing) {
          existing.qty   += entry.quantity;
          existing.total += entry.item.price * entry.quantity;
        } else {
          map.set(entry.item.name, {
            name:  entry.item.name,
            qty:   entry.quantity,
            total: entry.item.price * entry.quantity,
            image: entry.item.image
          });
        }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty);
  });

  transactionBreakdown = computed(() => {
    const orders = this.cartService.completedOrders();
    return {
      dineIn:  orders.filter(o => o.transactionMode === 'Dine In').length,
      takeOut: orders.filter(o => o.transactionMode === 'Take Out').length,
      grab:    orders.filter(o => o.transactionMode === 'Grab').length
    };
  });

  paymentBreakdown = computed(() => {
    const orders = this.cartService.completedOrders();
    return {
      cash:   orders.filter(o => o.paymentMode === 'Cash').length,
      gcashmaya: orders.filter(o => o.paymentMode === 'Gcash/Maya').length,
    };
  });

  // ── GROUPED SALES HISTORY (daily/weekly/monthly/yearly) ──
  groupedHistory = computed(() => {
    const days = this.cartService.salesHistory();
    const view = this.historyView();

    if (view === 'daily') {
      return days.map(d => ({
        key: d.date,
        label: this.formatDayLabel(d.date),
        totalSales: d.totalSales,
        totalOrders: d.totalOrders,
        transactions: d.transactions,
        payments: d.payments,
        orders: d.orders,
        days: [d]
      }));
    }

    const groups = new Map<string, any>();

    for (const d of days) {
      const key = view === 'weekly'  ? this.weekKey(d.date)
                : view === 'monthly' ? this.monthKey(d.date)
                : this.yearKey(d.date);

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: '',
          totalSales: 0,
          totalOrders: 0,
          transactions: { dineIn: 0, takeOut: 0, grab: 0 },
          payments: { cash: 0, online: 0, grab: 0 },
          orders: [] as any[],
          days: [] as OrderHistoryDay[]
        });
      }
      const g = groups.get(key);
      g.totalSales  += d.totalSales;
      g.totalOrders += d.totalOrders;
      g.transactions.dineIn  += d.transactions.dineIn;
      g.transactions.takeOut += d.transactions.takeOut;
      g.transactions.grab    += d.transactions.grab;
      g.payments.cash   += d.payments.cash;
      g.payments.online += d.payments.online;
      g.payments.grab   += d.payments.grab;
      g.orders.push(...d.orders);
      g.days.push(d);
    }

    const result = Array.from(groups.values());
    result.forEach(g => {
      g.label = view === 'weekly'  ? this.weekLabel(g.days)
              : view === 'monthly' ? this.monthLabel(g.key)
              : g.key; // yearly: key is already "2026"
    });

    result.sort((a, b) => b.key.localeCompare(a.key)); // newest first
    return result;
  });

  // ── POLLING — re-fetch today's orders AND sales history every 30s
  // to pick up employee transactions and any resets triggered from
  // the Employee Dashboard (a separate session, so this is the only
  // way this panel can find out about them). ──
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cartService.loadMenuItems();
    this.cartService.loadStaff();
    this.cartService.loadTodayOrders();
    this.cartService.loadSettings();
    this.cartService.loadOrdersHistory(); // loads all-time history grouped by date

    this.pollInterval = setInterval(() => {
      this.cartService.loadTodayOrders();
      this.cartService.loadOrdersHistory();
    }, 30000);
  }

  ngOnDestroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  // ── SETTINGS METHODS ──
  isTransactionEnabled(mode: string): boolean {
    return this.cartService.kioskSettings().transactionModes.includes(mode);
  }

  isPaymentEnabled(mode: string): boolean {
    return this.cartService.kioskSettings().paymentModes.includes(mode);
  }

  toggleTransaction(mode: string): void {
    this.cartService.toggleTransactionMode(mode);
    this.showSuccess(`Transaction mode "${mode}" updated!`);
  }

  togglePayment(mode: string): void {
    this.cartService.togglePaymentMode(mode);
    this.showSuccess(`Payment mode "${mode}" updated!`);
  }

  saveManagerPassword(): void {
    if (!this.newManagerPassword().trim()) return;
    this.cartService.updateSettings({ managerPassword: this.newManagerPassword() });
    this.newManagerPassword.set('');
    this.showSuccess('Manager password updated!');
  }

  resetSales(): void {
    // Refresh Sales History as soon as the reset actually completes on
    // the server, instead of waiting for the next 30s poll — this only
    // helps when the Manager is the one clicking Reset; if an Employee
    // resets from their own dashboard, the poll above is what catches it.
    this.cartService.resetDailySales(() => {
      this.cartService.loadOrdersHistory();
    });
    this.showSuccess('Today\'s sales have been reset!');
  }

  showSuccess(msg: string): void {
    this.successMsg.set(msg);
    setTimeout(() => this.successMsg.set(''), 3000);
  }

  // ── BACKUP EXPORT ──
  exportBackup(): void {
    this.cartService.exportBackup();
  }

  // ── HISTORY (legacy single-day toggle, still used if needed) ──
  toggleDay(date: string): void {
    this.expandedDate.set(this.expandedDate() === date ? null : date);
  }

  refreshHistory(): void {
    this.cartService.loadOrdersHistory();
    this.showSuccess('Sales history refreshed!');
  }

  // ── HISTORY VIEW SWITCHING (daily/weekly/monthly/yearly) ──
  setHistoryView(view: HistoryView): void {
    this.historyView.set(view);
    this.expandedGroup.set(null);
  }

  toggleGroup(key: string): void {
    this.expandedGroup.set(this.expandedGroup() === key ? null : key);
  }

  // ── date helpers ──
  private formatDayLabel(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }

  private weekKey(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00');
    const target = new Date(d.valueOf());
    const dayNr = (d.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
      target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    const weekNum = 1 + Math.round((firstThursday - target.valueOf()) / (7 * 24 * 3600 * 1000));
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  private monthKey(dateStr: string): string {
    return dateStr.slice(0, 7); // "YYYY-MM"
  }

  private yearKey(dateStr: string): string {
    return dateStr.slice(0, 4); // "YYYY"
  }

  private weekLabel(days: OrderHistoryDay[]): string {
    const dates = [...days].map(d => d.date).sort();
    const start = new Date(dates[0] + 'T00:00:00');
    const end   = new Date(dates[dates.length - 1] + 'T00:00:00');
    const fmt = (d: Date) => d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
    return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
  }

  private monthLabel(key: string): string {
    const [year, month] = key.split('-');
    const d = new Date(+year, +month - 1, 1);
    return d.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  }

  // ── MENU METHODS ──
  startAddItem(): void {
    this.newItem.set({ name: '', price: 0, category: '', description: '', image: '' });
    this.editingItem.set(null);
    this.showMenuForm.set(true);
  }

  startEditItem(item: MenuItem): void {
    this.editingItem.set(item);
    this.newItem.set({ ...item });
    this.showMenuForm.set(true);
  }

  saveItem(): void {
    const item = this.newItem();
    if (!item.name || !item.price || !item.category) return;
    if (this.editingItem()) {
      this.cartService.updateMenuItem({ ...this.editingItem()!, ...item } as MenuItem);
      this.showSuccess('Item updated!');
    } else {
      this.cartService.addMenuItem(item as Omit<MenuItem, '_id'>);
      this.showSuccess('Item added!');
    }
    this.showMenuForm.set(false);
    this.editingItem.set(null);
  }

  deleteItem(itemId: string): void {
    this.cartService.deleteMenuItem(itemId);
    this.showSuccess('Item deleted!');
  }

  cancelMenuForm(): void {
    this.showMenuForm.set(false);
    this.editingItem.set(null);
  }

  updateNewItem(field: string, value: string | number): void {
    this.newItem.set({ ...this.newItem(), [field]: value });
  }

  // ── STAFF METHODS ──
  startAddStaff(): void {
    this.newStaff.set({ staffCode: '', name: '', contact: '', status: 'Active', dateAdded: '', password: '' });
    this.editingStaff.set(null);
    this.showStaffForm.set(true);
  }

  startEditStaff(staff: Staff): void {
    this.editingStaff.set(staff);
    this.newStaff.set({ ...staff });
    this.showStaffForm.set(true);
  }

  saveStaff(): void {
    const staff = this.newStaff();
    if (!staff.staffCode || !staff.name || !staff.password) return;
    if (this.editingStaff()) {
      this.cartService.updateStaff({ ...this.editingStaff()!, ...staff } as Staff);
      this.showSuccess('Staff updated!');
    } else {
      this.cartService.addStaff(staff as Omit<Staff, '_id'>);
      this.showSuccess('Staff added!');
    }
    this.showStaffForm.set(false);
    this.editingStaff.set(null);
  }

  cancelStaffForm(): void {
    this.showStaffForm.set(false);
    this.editingStaff.set(null);
  }

  updateNewStaff(field: string, value: string): void {
    this.newStaff.set({ ...this.newStaff(), [field]: value });
  }

  logout(): void {
    this.router.navigate(['/']);
  }
}
