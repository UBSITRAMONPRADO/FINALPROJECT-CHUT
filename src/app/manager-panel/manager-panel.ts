import { Component, inject, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {CartServices, MenuItem, Staff, OrderHistoryDay, SelectedOption, VariantGroup, BranchPricing, optionsKey,
        priceForBranch } from '../cart-services';

type HistoryView = 'daily' | 'weekly' | 'monthly' | 'yearly';
type BestSellerView = 'alltime' | 'yearly' | 'monthly' | 'weekly' | 'custom';

@Component({
  selector: 'app-manager-panel',
  imports: [CommonModule],
  templateUrl: './manager-panel.html',
  styleUrl: './manager-panel.css'
})
export class ManagerPanelComponent implements OnDestroy {
 defaultBranchPricing(): BranchPricing[] {
    return this.branches.map(branch => ({ branch, price: 0 }));
}
  router      = inject(Router);
  cartService = inject(CartServices);

  activeTab  = signal<string>('dashboard');
  successMsg = signal('');
  errorMsg   = signal('');
  imageUploading = signal(false);
  allTransactionModes = ['Dine In', 'Take Out', 'Grab'];
  allPaymentModes     = ['Cash', 'Gcash','Grabpay'];
  
  branches = ['Harrison Bazaar', 'Pines Arcade', 'Porta Vaga'];
  expandedBranch = signal<string | null>(this.branches[0]); // first branch open by default

  getBranchPrice(branch: string): number {
  return (this.newItem().branchPricing ?? []).find(bp => bp.branch === branch)?.price ?? 0;
  }

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
  newItem       = signal<Partial<MenuItem>>({ name: '', category: '', description: '', image: '', variantGroups: [], branchPricing: this.defaultBranchPricing() });

//— branch sub-tabs ──
activeMenuBranch = signal<string>(this.branches[0]);
menuSearchQuery = signal<string>('');

  setMenuBranch(branch: string): void {
    this.activeMenuBranch.set(branch);
  }

  menuItemsForActiveBranch = computed(() => {
    const query = this.menuSearchQuery().trim().toLowerCase();
    let items = this.cartService.menuItems();
    if (query) {
      items = items.filter(item =>
        item.name.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query)
      );
    }
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  });
  // ── STAFF MANAGEMENT ──
  showStaffForm  = signal(false);
  editingStaff   = signal<Staff | null>(null);
  newStaff       = signal<Partial<Staff>>({ staffCode: '', name: '', branch: 'Harrison Bazaar', password: '' });

  // ── SALES HISTORY — which day is expanded (legacy, kept for compatibility) ──
  expandedDate = signal<string | null>(null);

  // ── SALES HISTORY — grouping view (daily/weekly/monthly/yearly) ──
  historyView   = signal<HistoryView>('daily');
  expandedGroup = signal<string | null>(null);

  // ── BEST SELLER — which period is selected on the Best Seller tab ──
  bestSellerView = signal<BestSellerView>('alltime');

  setBestSellerView(view: BestSellerView): void {
    this.bestSellerView.set(view);
  }

  // ── BEST SELLER — custom date range (used only when bestSellerView === 'custom') ──
  customStartDate = signal<string>('');
  customEndDate   = signal<string>('');

  setCustomStartDate(date: string): void {
    this.customStartDate.set(date);
  }

  setCustomEndDate(date: string): void {
    this.customEndDate.set(date);
  }

  // ── CATEGORY COLOR CODING (matches the Employee Dashboard POS redesign) ──
  categoryColor(cat: string): string {
    if (cat.includes('Wings'))    return '#CC0000';
    if (cat.includes('Fries'))    return '#FFC200';
    if (cat.includes('Corndog'))  return '#E8792F';
    if (cat.includes('Chillers')) return '#2E9BCC';
    if (cat.includes('Combos'))   return '#ed903a';
    if (cat.includes('Bilo Bilo & Mais')) return '#c33aed';
    if (cat.includes('Coat'))   return '#138b4f';
    return '#1A1A1A'; // "All" / unmatched
  }

  lightBg(cat: string): string {
    return `${this.categoryColor(cat)}14`;
  }

  optionsKey = optionsKey; // exposed for the template's @for track expressions
  priceForBranch = priceForBranch;


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
      const linePrice = priceForBranch(entry.item, order.branch);
      const existing = map.get(entry.item.name);
      if (existing) {
        existing.qty   += entry.quantity;
        existing.total += linePrice * entry.quantity;
      } else {
        map.set(entry.item.name, {
          name:  entry.item.name,
          qty:   entry.quantity,
          total: linePrice * entry.quantity,
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
      cash:      orders.filter(o => o.paymentMode === 'Cash').length,
      gcash: orders.filter(o => o.paymentMode === 'Gcash' || o.paymentMode === 'Online Payment').length,
      grabpay:   orders.filter(o => o.paymentMode === 'Grabpay').length,
    };
  });

  // ── NEW: peso totals for the enhanced breakdown cards ──
  transactionTotals = computed(() => {
    const orders = this.cartService.completedOrders().filter(o => o.status !== 'cancelled');
    const dineInOrders  = orders.filter(o => o.transactionMode === 'Dine In');
    const takeOutOrders = orders.filter(o => o.transactionMode === 'Take Out');
    const grabOrders    = orders.filter(o => o.transactionMode === 'Grab');
    const dineIn  = dineInOrders.reduce((sum, o) => sum + o.total, 0);
    const takeOut = takeOutOrders.reduce((sum, o) => sum + o.total, 0);
    const grab    = grabOrders.reduce((sum, o) => sum + o.total, 0);
    return {
      dineIn,  dineInCount:  dineInOrders.length,
      takeOut, takeOutCount: takeOutOrders.length,
      grab,    grabCount:    grabOrders.length,
      total: dineIn + takeOut + grab,
      totalCount: dineInOrders.length + takeOutOrders.length + grabOrders.length
    };
  });

  paymentTotals = computed(() => {
    const orders = this.cartService.completedOrders().filter(o => o.status !== 'cancelled');
    const cashOrders    = orders.filter(o => o.paymentMode === 'Cash');
    const gcashOrders   = orders.filter(o => o.paymentMode === 'Gcash/Maya' || o.paymentMode === 'Online Payment');
    const grabpayOrders = orders.filter(o => o.paymentMode === 'Grabpay');
    const cash    = cashOrders.reduce((sum, o) => sum + o.total, 0);
    const gcash   = gcashOrders.reduce((sum, o) => sum + o.total, 0);
    const grabpay = grabpayOrders.reduce((sum, o) => sum + o.total, 0);
    return {
      cash,    cashCount:    cashOrders.length,
      gcash,   gcashCount:   gcashOrders.length,
      grabpay, grabpayCount: grabpayOrders.length,
      total: cash + gcash + grabpay,
      totalCount: cashOrders.length + gcashOrders.length + grabpayOrders.length
    };
  });

  orderLabel(count: number): string {
    return count === 1 ? '1 order' : `${count} orders`;
  }

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

  // ── BEST SELLER — date-range filter shared by the ranked list, branch
  // performance bars, and growth comparison below, so they all agree on
  // what "this period" means for the selected view. ──
  private filteredDaysForBestSeller(view: BestSellerView, days: OrderHistoryDay[]): OrderHistoryDay[] {
    if (view === 'yearly') {
      const year = String(new Date().getFullYear());
      return days.filter(d => d.date.startsWith(year));
    } else if (view === 'monthly') {
      const monthKey = this.toDateStr(new Date()).slice(0, 7); // "YYYY-MM"
      return days.filter(d => d.date.startsWith(monthKey));
    } else if (view === 'weekly') {
      const currentWeekKey = this.weekKey(this.toDateStr(new Date()));
      return days.filter(d => this.weekKey(d.date) === currentWeekKey);
    } else if (view === 'custom') {
      const start = this.customStartDate();
      const end = this.customEndDate();
      return days.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    return days; // 'alltime' — no filter
  }

  filteredBestSellerDays = computed(() =>
    this.filteredDaysForBestSeller(this.bestSellerView(), this.cartService.salesHistory())
  );

  // ── BEST SELLERS — ranked by quantity sold for the selected period
  // (alltime / yearly / monthly / weekly / custom), with the branches
  // each item sold at. Cancelled orders are already excluded server-side,
  // so no extra filtering is needed here. ──
  bestSellers = computed(() => {
    const days = this.filteredBestSellerDays();
    const tally = new Map<string, { name: string; qty: number; branches: Set<string> }>();

    days.forEach(d => {
      d.orders.forEach(order => {
        order.items.forEach((entry: any) => {
          const key = entry.item.name;
          const row = tally.get(key) ?? { name: entry.item.name, qty: 0, branches: new Set<string>() };
          row.qty += entry.quantity;
          row.branches.add(order.branch ?? 'Unknown');
          tally.set(key, row);
        });
      });
    });

    return Array.from(tally.values())
      .map(r => ({ name: r.name, qty: r.qty, branches: Array.from(r.branches) }))
      .sort((a, b) => b.qty - a.qty);
  });

  // Total units sold across all items in the selected period.
  bestSellerTotalQty = computed(() => this.bestSellers().reduce((sum, i) => sum + i.qty, 0));

  // Units sold per branch in the selected period (any item, not just the top seller).
  bestSellerBranchTally = computed(() => {
    const map = new Map<string, number>();
    this.filteredBestSellerDays().forEach(d => {
      d.orders.forEach((order: any) => {
        const branch = order.branch ?? 'Unknown';
        const qty = order.items.reduce((s: number, e: any) => s + e.quantity, 0);
        map.set(branch, (map.get(branch) ?? 0) + qty);
      });
    });
    return map;
  });

  // Branch performance bars — each branch's share of units sold this period.
  branchPerformance = computed(() => {
    const tally = this.bestSellerBranchTally();
    const total = Array.from(tally.values()).reduce((sum, v) => sum + v, 0);
    return this.branches
      .map(branch => {
        const qty = tally.get(branch) ?? 0;
        return { branch, qty, percent: total > 0 ? Math.round((qty / total) * 100) : 0 };
      })
      .sort((a, b) => b.qty - a.qty);
  });

  bestSellerBestBranch = computed(() => {
    const perf = this.branchPerformance();
    return perf.length > 0 && perf[0].qty > 0 ? perf[0].branch : '—';
  });

  // Growth — compares total units sold in the current period against the
  // immediately preceding period of equal length. For 'alltime' (which has
  // no natural "previous" period), it compares the trailing 30 days against
  // the 30 days before that instead.
  bestSellerGrowth = computed((): { percent: number | null; label: string } | null => {
    const allDays = [...this.cartService.salesHistory()].sort((a, b) => a.date.localeCompare(b.date));
    if (allDays.length < 2) return null;

    const current = this.filteredBestSellerDays();
    if (current.length === 0) return null;

    let currentDates: string[];
    let label: string;

    if (this.bestSellerView() === 'alltime') {
      currentDates = allDays.map(d => d.date).slice(-30);
      label = 'vs previous 30 days';
    } else {
      currentDates = current.map(d => d.date).sort();
      label = 'vs previous period';
    }

    const rangeLen = currentDates.length;
    const earliestCurrent = currentDates[0];
    const priorDates = allDays.filter(d => d.date < earliestCurrent).slice(-rangeLen).map(d => d.date);

    const sumQty = (dates: string[]) => {
      const set = new Set(dates);
      return allDays
        .filter(d => set.has(d.date))
        .reduce((sum, d) => sum + d.orders.reduce((s: number, o: any) =>
          s + o.items.reduce((si: number, e: any) => si + e.quantity, 0), 0), 0);
    };

    const currentQty = sumQty(currentDates);
    const priorQty = sumQty(priorDates);

    if (priorDates.length === 0 || priorQty === 0) return { percent: null, label };

    const percent = Math.round(((currentQty - priorQty) / priorQty) * 100);
    return { percent, label };
  });

  // Looks up the current menu image for a best-seller row by item name.
  bestSellerImage(name: string): string {
    const item = this.cartService.menuItems().find(i => i.name === name);
    return item?.image || 'chutchut.jpg';
  }

  // Sales trend for the #1 best seller — last 7 days, oldest to newest.
  topSellerTrend = computed(() => {
    const w = 400, h = 140, padding = 24;
    const top = this.bestSellers()[0];
    const empty = { points: [] as any[], linePath: '', areaPath: '', labels: [] as any[], w, h };
    if (!top) return empty;

    const days = [...this.cartService.salesHistory()].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
    if (days.length === 0) return empty;

    const qtyPerDay = days.map(d => {
      let qty = 0;
      d.orders.forEach((o: any) => o.items.forEach((e: any) => { if (e.item.name === top.name) qty += e.quantity; }));
      return { date: d.date, qty };
    });

    const maxQty = Math.max(1, ...qtyPerDay.map(d => d.qty));
    const stepX = qtyPerDay.length > 1 ? (w - padding * 2) / (qtyPerDay.length - 1) : 0;

    const points = qtyPerDay.map((d, i) => ({
      x: padding + i * stepX,
      y: h - padding - (d.qty / maxQty) * (h - padding * 2),
      date: d.date,
      qty: d.qty
    }));

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${h - padding} L ${points[0].x.toFixed(1)} ${h - padding} Z`;

    const labels = points.map(p => ({
      date: p.date,
      short: new Date(p.date + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short' })
    }));

    return { points, linePath, areaPath, labels, w, h };
  });

  // Exports the currently displayed best-seller ranking as a CSV.
  exportBestSellers(): void {
    const rows = this.bestSellers();
    const header = 'Rank,Name,Quantity Sold,Branches\n';
    const body = rows.map((r, i) => `${i + 1},"${r.name}",${r.qty},"${r.branches.join('; ')}"`).join('\n');
    const csv = header + body;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `best-sellers-${this.bestSellerView()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

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

  // ── DANGER ZONE — bulk-clear actions (Settings tab). Both are
  // permanent and affect every branch, so each is gated behind a
  // native confirm() prompt before touching the backend. ──
  clearAllOrders(): void {
    const confirmed = confirm(
      'This will permanently delete ALL orders and sales history for every branch. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    this.cartService.clearAllOrders(
      () => {
        this.cartService.loadTodayOrders();
        this.cartService.loadOrdersHistory();
        this.showSuccess('All orders and transactions cleared.');
      },
      (err) => {
        const detail = err?.error?.message || err?.message || `HTTP ${err?.status ?? 'error'}`;
        this.showError(`Clear orders failed — ${detail}`);
      }
    );
  }

  clearAllStaff(): void {
    const confirmed = confirm(
      'This will permanently delete ALL staff accounts for every branch. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    this.cartService.clearAllStaff(
      () => this.showSuccess('All staff accounts cleared.'),
      (err) => {
        const detail = err?.error?.message || err?.message || `HTTP ${err?.status ?? 'error'}`;
        this.showError(`Clear staff failed — ${detail}`);
      }
    );
  }

  showSuccess(msg: string): void {
    this.successMsg.set(msg);
    setTimeout(() => this.successMsg.set(''), 3000);
  }

  showError(msg: string): void {
    this.errorMsg.set(msg);
    setTimeout(() => this.errorMsg.set(''), 4000);
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
      this.newItem.set({ name: '', category: '', description: '', image: '', variantGroups: [], branchPricing: this.defaultBranchPricing() });
      this.editingItem.set(null);
      this.showMenuForm.set(true);
    }

      startEditItem(item: MenuItem): void {
      this.editingItem.set(item);
      const existingPricing = item.branchPricing ?? [];
      const branchPricing = this.branches.map(branch => {
        const found = existingPricing.find(bp => bp.branch === branch);
        return found ? { ...found } : { branch, price: 0 };
      });

      // Deep-clone variantGroups so editing the form doesn't mutate the
      // original item (or another row sharing the same object reference)
      // before Save is actually clicked.
      this.newItem.set({
        ...item,
        branchPricing,
        variantGroups: (item.variantGroups ?? []).map(g => ({
          ...g,
          options: g.options.map(o => ({ ...o }))
        }))
      });
      this.showMenuForm.set(true);
    }

      saveItem(): void {
        // ── FIX: block Save while an image upload is still in flight.
        // Previously nothing checked imageUploading(), so picking a photo
        // and clicking Save right away would save the item with
        // image: '' — the upload's result arrived a moment later into a
        // signal nothing read anymore. ──
        if (this.imageUploading()) {
          this.showError('Please wait for the image to finish uploading.');
          return;
        }

        const item = this.newItem();

        // Each check reports exactly why nothing was saved, instead of
        // silently doing nothing — this was previously a bare `return`,
        // which is what made Save look broken when a field was missing.
        if (!item.name?.trim()) {
          this.showError('Please enter an item name.');
          return;
        }
        if (!item.category) {
          this.showError('Please select a category.');
          return;
        }
        const hasValidBranch = (item.branchPricing ?? []).some(bp => bp.price > 0);
        if (!hasValidBranch) {
          this.showError('Please set a price greater than ₱0 for at least one branch.');
          return;
        }

    // Drop groups/options left blank in the editor rather than saving
    // empty placeholders.
    const cleanedGroups = (item.variantGroups ?? [])
      .filter(g => g.name.trim().length > 0)
      .map(g => ({ ...g, options: g.options.filter(o => o.label.trim().length > 0) }));

    const finalItem = { ...item, variantGroups: cleanedGroups };

    // The form only closes and shows a success message once the backend
    // actually confirms the save — if the request fails (e.g. a rejected
    // POST), the form stays open with the entered data intact and the
    // real error is shown, instead of quietly discarding the input.
    const onSaved = (msg: string) => {
      this.showSuccess(msg);
      this.showMenuForm.set(false);
      this.editingItem.set(null);
    };
    const onFailed = (err: any) => {
      const detail = err?.error?.message || err?.message || `HTTP ${err?.status ?? 'error'}`;
      this.showError(`Save failed — ${detail}`);
    };

    if (this.editingItem()) {
      this.cartService.updateMenuItem(
        { ...this.editingItem()!, ...finalItem } as MenuItem,
        () => onSaved('Item updated!'),
        onFailed
      );
    } else {
      this.cartService.addMenuItem(
        finalItem as Omit<MenuItem, '_id'>,
        () => onSaved('Item added!'),
        onFailed
      );
    }
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
        this.updateNewItem('image', result.url); // no more prepending the Render base URL — Cloudinary already returns a full URL
        this.imageUploading.set(false);
      },
      error: (err) => {
        // ── FIX: this used to call showSuccess() on failure, so a failed
        // upload displayed as a green "success" toast and was easy to
        // miss. Now it correctly surfaces as an error. ──
        console.error('Image upload failed:', err);
        this.imageUploading.set(false);
        this.showError('Image upload failed — try a different file.');
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

  updateBranchPrice(branch: string, price: number): void {
  const branchPricing = (this.newItem().branchPricing ?? []).map(bp =>
    bp.branch === branch ? { ...bp, price } : bp
  );
  this.newItem.set({ ...this.newItem(), branchPricing });
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
  sessionStorage.removeItem('isManager'); // NEW
  this.router.navigate(['/']);
  }
}
