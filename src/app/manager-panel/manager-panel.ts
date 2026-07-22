import { Component, inject, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CartServices, MenuItem, Staff, OrderHistoryDay, SelectedOption, VariantGroup, optionsKey } from '../cart-services';

type HistoryView = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Component({
  selector: 'app-manager-panel',
  imports: [CommonModule],
  templateUrl: './manager-panel.html',
  styleUrl: './manager-panel.css'
})
export class ManagerPanelComponent implements OnDestroy {
  router      = inject(Router);
  cartService = inject(CartServices);

  activeTab  = signal<string>('dashboard');
  successMsg = signal('');
  imageUploading = signal(false);
  allTransactionModes = ['Dine In', 'Take Out', 'Grab'];
  allPaymentModes     = ['Cash', 'Gcash/Maya'];
  
  branches = ['Harrison Bazaar', 'Pines Arcade', 'Porta Vaga'];
  expandedBranch = signal<string | null>(this.branches[0]); // first branch open by default

  toggleBranch(branch: string): void {
    this.expandedBranch.set(this.expandedBranch() === branch ? null : branch);
  }

  transactionsByBranch = computed(() => {
    const days = [...this.cartService.salesHistory()].sort((a, b) => b.date.localeCompare(a.date));
    const flat: Array<{ date: string; order: any }> = [];
    for (const d of days) {
      for (const order of d.orders) flat.push({ date: d.date, order });
    }

    return this.branches.map(branch => {
      const entries = flat.filter(e => (e.order.branch ?? 'Unknown') === branch);
      return {
        branch,
        entries,
        totalOrders: entries.length,
        totalSales: entries.reduce((sum, e) => sum + e.order.total, 0)
      };
    });
  });
  // ── PASSWORD MANAGEMENT ──
  newManagerPassword = signal('');

  // ── MENU MANAGEMENT ──
  showMenuForm  = signal(false);
  editingItem   = signal<MenuItem | null>(null);
  newItem       = signal<Partial<MenuItem>>({ name: '', price: 0, category: '', description: '', image: '', variantGroups: [] });

  // ── STAFF MANAGEMENT ──
  showStaffForm  = signal(false);
  editingStaff   = signal<Staff | null>(null);
  newStaff       = signal<Partial<Staff>>({ staffCode: '', name: '', branch: 'Harrison Bazaar', password: '' });

  // ── SALES HISTORY — which day is expanded (legacy, kept for compatibility) ──
  expandedDate = signal<string | null>(null);

  // ── SALES HISTORY — grouping view (daily/weekly/monthly/yearly) ──
  historyView   = signal<HistoryView>('daily');
  expandedGroup = signal<string | null>(null);

  // ── CATEGORY COLOR CODING (matches the Employee Dashboard POS redesign) ──
  categoryColor(cat: string): string {
    if (cat.includes('Wings'))    return '#CC0000';
    if (cat.includes('Fries'))    return '#FFC200';
    if (cat.includes('Corndog'))  return '#E8792F';
    if (cat.includes('Chillers')) return '#2E9BCC';
    if (cat.includes('Combos'))   return '#7C3AED';
    return '#1A1A1A'; // "All" / unmatched
  }

  lightBg(cat: string): string {
    return `${this.categoryColor(cat)}14`;
  }

  optionsKey = optionsKey; // exposed for the template's @for track expressions

  // Formats a cart line's selected options for display, e.g. "Honey Butter, Hot".
  formatOptions(options: SelectedOption[]): string {
    return options.map(o => o.label).join(', ');
  }

  // ── SALES COMPUTED (today) — cancelled orders excluded from every total ──
  itemSales = computed(() => {
    const orders = this.cartService.completedOrders().filter(o => o.status !== 'cancelled');
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

  // "Orders Breakdown" list — pending/completed orders only.
  allOrdersIndexed = computed(() =>
    this.cartService.completedOrders()
      .filter(o => o.status !== 'cancelled')
      .map((order, i) => ({ order, index: i + 1 }))
  );

  // Cancelled orders — shown in their own section, kept for the record
  // but excluded from every sales figure above.
  cancelledOrdersIndexed = computed(() =>
    this.cartService.completedOrders()
      .filter(o => o.status === 'cancelled')
      .map((order, i) => ({ order, index: i + 1 }))
  );

  transactionBreakdown = computed(() => {
    const orders = this.cartService.completedOrders().filter(o => o.status !== 'cancelled');
    return {
      dineIn:  orders.filter(o => o.transactionMode === 'Dine In').length,
      takeOut: orders.filter(o => o.transactionMode === 'Take Out').length,
      grab:    orders.filter(o => o.transactionMode === 'Grab').length
    };
  });

  paymentBreakdown = computed(() => {
    const orders = this.cartService.completedOrders().filter(o => o.status !== 'cancelled');
    return {
      cash:   orders.filter(o => o.paymentMode === 'Cash').length,
      gcashmaya: orders.filter(o => o.paymentMode === 'Gcash/Maya' || o.paymentMode === 'Online Payment').length,
    };
  });

  // ── CANCEL / UNCANCEL — backend-persisted via order.status ──
  cancelOrder(orderId: string): void {
    this.cartService.cancelOrder(orderId);
    this.showSuccess('Order cancelled.');
  }

  uncancelOrder(orderId: string): void {
    this.cartService.uncancelOrder(orderId);
    this.showSuccess('Order restored.');
  }

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

  // ── SALES HISTORY OVERVIEW — powers the stat cards, charts, and
  // transactions table at the top of the Sales History tab. These are
  // deliberately based on the FULL loaded history (cartService.salesHistory()),
  // not the daily/weekly/monthly/yearly toggle below, so the summary stays
  // stable while someone browses through different groupings. Cancelled
  // orders are already excluded server-side (see server.js groupOrdersByDate),
  // so no extra filtering is needed here. ──

  historyTotals = computed(() => {
    const days = this.cartService.salesHistory();
    return {
      totalSales:  days.reduce((sum, d) => sum + d.totalSales, 0),
      totalOrders: days.reduce((sum, d) => sum + d.totalOrders, 0)
    };
  });

  historyAvgOrder = computed(() => {
    const { totalSales, totalOrders } = this.historyTotals();
    return totalOrders > 0 ? totalSales / totalOrders : 0;
  });

  // Unique menu items that appear across every order in the loaded history.
  historyItemsSold = computed(() => {
    const days = this.cartService.salesHistory();
    const names = new Set<string>();
    days.forEach(d => d.orders.forEach(o => o.items.forEach(entry => names.add(entry.item.name))));
    return names.size;
  });

  historyTransactionTotals = computed(() => {
    const days = this.cartService.salesHistory();
    return {
      dineIn:  days.reduce((sum, d) => sum + d.transactions.dineIn, 0),
      takeOut: days.reduce((sum, d) => sum + d.transactions.takeOut, 0),
      grab:    days.reduce((sum, d) => sum + d.transactions.grab, 0)
    };
  });

  donutPercents = computed(() => {
    const t = this.historyTransactionTotals();
    const total = t.dineIn + t.takeOut + t.grab;
    if (total === 0) return { dineIn: 0, takeOut: 0, grab: 0 };
    return {
      dineIn:  Math.round((t.dineIn  / total) * 100),
      takeOut: Math.round((t.takeOut / total) * 100),
      grab:    Math.round((t.grab    / total) * 100)
    };
  });

  donutGradient = computed(() => {
    const t = this.historyTransactionTotals();
    const total = t.dineIn + t.takeOut + t.grab;
    if (total === 0) return 'conic-gradient(#f0ebe0 0% 100%)';
    const p1 = (t.dineIn / total) * 100;
    const p2 = p1 + (t.takeOut / total) * 100;
    return `conic-gradient(#CC0000 0% ${p1}%, #FFC200 ${p1}% ${p2}%, #1a1a1a ${p2}% 100%)`;
  });

  historyDateRangeLabel = computed(() => {
    const days = [...this.cartService.salesHistory()].sort((a, b) => a.date.localeCompare(b.date));
    if (days.length === 0) return 'No data yet';
    const fmt = (dateStr: string) => new Date(dateStr + 'T00:00:00')
      .toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    if (days.length === 1) return fmt(days[0].date);
    return `${fmt(days[0].date)} – ${fmt(days[days.length - 1].date)}`;
  });

  // Sales Trend line chart — last 14 days, oldest to newest.
  trendChartData = computed(() => {
    const w = 560, h = 200, padding = 28;
    const days = [...this.cartService.salesHistory()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);

    if (days.length === 0) {
      return { points: [] as any[], linePath: '', areaPath: '', labels: [] as any[], w, h };
    }

    const maxSales = Math.max(1, ...days.map(d => d.totalSales));
    const stepX = days.length > 1 ? (w - padding * 2) / (days.length - 1) : 0;

    const points = days.map((d, i) => ({
      x: padding + i * stepX,
      y: h - padding - (d.totalSales / maxSales) * (h - padding * 2),
      date: d.date,
      sales: d.totalSales
    }));

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${h - padding} L ${points[0].x.toFixed(1)} ${h - padding} Z`;

    const labels = points.map(p => ({
      date: p.date,
      short: new Date(p.date + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
    }));

    return { points, linePath, areaPath, labels, w, h };
  });

  // Most recent orders across all loaded history, newest first.
  recentTransactions = computed(() => {
    const days = [...this.cartService.salesHistory()].sort((a, b) => b.date.localeCompare(a.date));
    const flat: Array<{ date: string; order: any }> = [];
    for (const d of days) {
      for (const order of d.orders) flat.push({ date: d.date, order });
    }
    return flat.slice(0, 10);
  });

  itemsSummary(order: any): string {
    if (!order?.items?.length) return '—';
    return order.items.map((entry: any) => `${entry.item.name} x${entry.quantity}`).join(', ');
  }

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
    this.newItem.set({ name: '', price: 0, category: '', description: '', image: '', variantGroups: [] });
    this.editingItem.set(null);
    this.showMenuForm.set(true);
  }

  startEditItem(item: MenuItem): void {
    this.editingItem.set(item);
    // Deep-clone variantGroups so editing the form doesn't mutate the
    // original item (or another row sharing the same object reference)
    // before Save is actually clicked.
    this.newItem.set({
      ...item,
      variantGroups: (item.variantGroups ?? []).map(g => ({
        ...g,
        options: g.options.map(o => ({ ...o }))
      }))
    });
    this.showMenuForm.set(true);
  }

  saveItem(): void {
    const item = this.newItem();
    if (!item.name || !item.price || !item.category) return;

    // Drop groups/options left blank in the editor rather than saving
    // empty placeholders.
    const cleanedGroups = (item.variantGroups ?? [])
      .filter(g => g.name.trim().length > 0)
      .map(g => ({ ...g, options: g.options.filter(o => o.label.trim().length > 0) }));

    const finalItem = { ...item, variantGroups: cleanedGroups };

    if (this.editingItem()) {
      this.cartService.updateMenuItem({ ...this.editingItem()!, ...finalItem } as MenuItem);
      this.showSuccess('Item updated!');
    } else {
      this.cartService.addMenuItem(finalItem as Omit<MenuItem, '_id'>);
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
  
  onImageFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.imageUploading.set(true);
    this.cartService.uploadImage(file).subscribe({
      next: (result) => {
        // Store the full URL so <img [src]> resolves correctly even though
        // the Angular app and the upload server run on different origins.
        this.updateNewItem('image', `http://localhost:3000${result.url}`);
        this.imageUploading.set(false);
      },
      error: (err) => {
        console.error('Image upload failed:', err);
        this.imageUploading.set(false);
        this.showSuccess('Image upload failed — try a different file.');
      }
    });
    input.value = ''; // allows re-selecting the same file later if needed
  }

  // ── VARIANT GROUP EDITOR (Menu form) ──
  // A menu item can have multiple variant groups (Sauce, Spice Level,
  // Extras...), each either 'single' choice (radio) or 'multi' choice
  // (checkboxes), optionally required, with options that can each carry
  // a price add-on (priceDelta). This mirrors MenuItem.variantGroups
  // exactly, so items created here work directly with the Employee
  // Dashboard's variant picker.

  addVariantGroup(): void {
    const groups: VariantGroup[] = [...(this.newItem().variantGroups ?? [])];
    groups.push({ name: '', type: 'single', required: false, options: [] });
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  removeVariantGroup(groupIndex: number): void {
    const groups = (this.newItem().variantGroups ?? []).filter((_, i) => i !== groupIndex);
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  updateGroupName(groupIndex: number, value: string): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    groups[groupIndex] = { ...groups[groupIndex], name: value };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  updateGroupType(groupIndex: number, value: string): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    groups[groupIndex] = { ...groups[groupIndex], type: value as 'single' | 'multi' };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  toggleGroupRequired(groupIndex: number): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    groups[groupIndex] = { ...groups[groupIndex], required: !groups[groupIndex].required };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  addVariantOption(groupIndex: number): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    const options = [...groups[groupIndex].options, { label: '', priceDelta: 0 }];
    groups[groupIndex] = { ...groups[groupIndex], options };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  removeVariantOption(groupIndex: number, optionIndex: number): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    const options = groups[groupIndex].options.filter((_, i) => i !== optionIndex);
    groups[groupIndex] = { ...groups[groupIndex], options };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  updateOptionLabel(groupIndex: number, optionIndex: number, value: string): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    const options = [...groups[groupIndex].options];
    options[optionIndex] = { ...options[optionIndex], label: value };
    groups[groupIndex] = { ...groups[groupIndex], options };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  updateOptionPriceDelta(groupIndex: number, optionIndex: number, value: number): void {
    const groups = [...(this.newItem().variantGroups ?? [])];
    const options = [...groups[groupIndex].options];
    options[optionIndex] = { ...options[optionIndex], priceDelta: value };
    groups[groupIndex] = { ...groups[groupIndex], options };
    this.newItem.set({ ...this.newItem(), variantGroups: groups });
  }

  // ── STAFF METHODS ──
  startAddStaff(): void {
    this.newStaff.set({ staffCode: '', name: '', branch: 'Harrison Bazaar', password: '' });
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
