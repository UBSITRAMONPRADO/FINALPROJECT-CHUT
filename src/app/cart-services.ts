import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as XLSX from 'xlsx';
import { Observable } from 'rxjs';

export interface VariantOption {
  label: string;
  priceDelta: number; // added to unit price when this option is selected
}

export interface VariantGroup {
  name: string;               // "Sauce", "Spice Level", "Extras"
  type: 'single' | 'multi';   // single = radio (exactly one), multi = checkboxes (zero or more)
  required: boolean;
  options: VariantOption[];
}

export interface BranchPricing {
  branch: string;
  price: number;
}

export interface Category {
  name: string;
  color: string;
}

export interface MenuItem {
  _id: string;
  name: string;
  category: string;
  description: string;
  image: string;
  variantGroups: VariantGroup[];
  branchPricing: BranchPricing[]; // replaces the old single `price: number`
}

export function priceForBranch(item: MenuItem, branch: string): number {
  return item.branchPricing?.find(bp => bp.branch === branch)?.price ?? 0;
}

export function isAvailableAtBranch(item: MenuItem, branch: string): boolean {
  return item.branchPricing?.some(bp => bp.branch === branch && bp.price) ?? false;
}

export interface SelectedOption {
  groupName: string;
  label: string;
  priceDelta: number;
}

export interface CartItem {
  item: MenuItem;
  quantity: number;
  selectedOptions: SelectedOption[]; // one entry per chosen option, across all groups
  specialInstructions?: string;      // free-text note for this line (e.g. "no ice")
}

// Two cart lines are the "same line" only if they're the same item AND the
// same exact combination of selected options — this is what makes
// "Wings & Fries 3pcs (Honey Butter, Hot)" and "...( Cheese, Mild)" stay
// as separate rows instead of merging.
export function optionsKey(selectedOptions: SelectedOption[]): string {
  return [...selectedOptions]
    .sort((a, b) => (a.groupName + a.label).localeCompare(b.groupName + b.label))
    .map(o => `${o.groupName}:${o.label}`)
    .join('|');
}

export function unitPrice(item: MenuItem, selectedOptions: SelectedOption[], branch: string): number {
  return priceForBranch(item, branch) + selectedOptions.reduce((sum, o) => sum + o.priceDelta, 0);
}

export interface CompletedOrder {
  _id: string;
  items: CartItem[];
  total: number;
  transactionMode: string;
  paymentMode: string;
  timestamp: Date;
  branch: string;
  staffname: string;
  staffid: string;
  status?: 'completed' | 'cancelled';
  displayId?: string;
}

export interface Staff {
  _id: string;
  staffCode: string;
  name: string;
  branch: 'Harrison Bazaar' | 'Pines Arcade' | 'Porta Vaga';
  password: string;
}

export interface KioskSettings {
  _id?: string;
  kioskName: string;
  transactionModes: string[];
  paymentModes: string[];
  managerPassword: string;
  categories: Category[];
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
getKioskBranch(): string {
throw new Error('Method not implemented.');
}

  private http = inject(HttpClient);
  private api = 'https://finalproject-chut-2.onrender.com/api';

  // ── SETTINGS ──
kioskSettings = signal<KioskSettings>({
  kioskName: 'Chut Chut',
  transactionModes: ['Dine In', 'Take Out', 'Grab'],
  paymentModes: ['Cash', 'Online Payment', 'Grab'],
  managerPassword: 'admin2024',
  categories: [
    { name: 'Bilo Bilo & Mais', color: '#c33aed' },
    { name: 'Chillers',         color: '#2E9BCC' },
    { name: 'Combos',           color: '#7C3AED' },
    { name: 'Corndog',          color: '#E8792F' },
    { name: 'Fries',            color: '#FFC200' },
    { name: 'Wings & Drinks',   color: '#CC0000' },
    { name: 'Wings & Fries',    color: '#CC0000' },
    { name: 'Wings & Gravy',    color: '#CC0000' },
    { name: 'Wings & Rice',     color: '#CC0000' }
  ]
});
  // ── MENU ITEMS ──
  menuItems = signal<MenuItem[]>([]);

  // ── CART ──
  cartItems = signal<CartItem[]>([]);

 cartTotal = computed(() => {
  const branch = this.currentStaff()?.branch ?? this.kioskBranch();
  return this.cartItems().reduce(
    (sum, e) => sum + unitPrice(e.item, e.selectedOptions, branch) * e.quantity,
    0
  );
});

  cartCount = computed(() =>
    this.cartItems().reduce((sum, e) => sum + e.quantity, 0)
  );

  // ── ORDER STATE ──
  transactionMode = signal<string>('');
  paymentMode     = signal<string>('');

  // ── TODAY'S COMPLETED ORDERS ──
  completedOrders = signal<CompletedOrder[]>([]);

  // Cancelled orders are kept in `completedOrders` (for display in the
  // Cancelled Orders list) but excluded from every sales total below.
  todaySales = computed(() =>
    this.completedOrders()
      .filter(o => o.status !== 'cancelled')
      .reduce((sum, o) => sum + o.total, 0)
  );

  todayOrderCount = computed(() =>
    this.completedOrders().filter(o => o.status !== 'cancelled').length
  );

  // ── STAFF ──
  staffList    = signal<Staff[]>([]);
  currentStaff = signal<Staff | null>(null);

  // Returns the kiosk's active branch when no staff is logged in.
  // Falls back to the first known staff branch or a sensible default.
  private kioskBranch(): Staff['branch'] | string {
    return this.staffList()[0]?.branch ?? 'Harrison Bazaar';
  }

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
    const branch = this.currentStaff()?.branch;
    const url = branch
      ? `${this.api}/orders/today?branch=${encodeURIComponent(branch)}`
      : `${this.api}/orders/today`;
    this.http.get<CompletedOrder[]>(url).subscribe(orders => {
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

  // A cart line is identified by item._id + its exact combination of
  // selected options — see optionsKey() above.
  private sameLine(e: CartItem, itemId: string, selectedOptions: SelectedOption[]): boolean {
    return e.item._id === itemId && optionsKey(e.selectedOptions) === optionsKey(selectedOptions);
  }

  addToCart(item: MenuItem, selectedOptions: SelectedOption[] = [], qty: number = 1): void {
    const current  = this.cartItems();
    const existing = current.find(e => this.sameLine(e, item._id, selectedOptions));
    if (existing) {
      this.cartItems.set(
        current.map(e => this.sameLine(e, item._id, selectedOptions)
          ? { ...e, quantity: e.quantity + qty }
          : e
        )
      );
    } else {
      this.cartItems.set([...current, { item, quantity: qty, selectedOptions }]);
    }
  }

  // Replaces an existing line's option selections in place — used by both
  // the full variant-picker sheet ("Edit") AND the inline chip toggles in
  // the checkout drawer. If the new selection combo already matches
  // another existing line, the two merge (quantities add); otherwise this
  // line's own combination is updated. specialInstructions carries over
  // from the original line unless a new value is explicitly passed.
  updateCartLineOptions(
    itemId: string,
    oldOptions: SelectedOption[],
    newOptions: SelectedOption[],
    qty: number,
    specialInstructions?: string
  ): void {
    const current = this.cartItems();
    const withoutOld = current.filter(e => !this.sameLine(e, itemId, oldOptions));
    const matchIdx = withoutOld.findIndex(e => this.sameLine(e, itemId, newOptions));

    if (matchIdx >= 0) {
      this.cartItems.set(
        withoutOld.map((e, i) => i === matchIdx ? { ...e, quantity: e.quantity + qty } : e)
      );
    } else {
      const original = current.find(e => this.sameLine(e, itemId, oldOptions));
      if (!original) return;
      this.cartItems.set([...withoutOld, {
        item: original.item,
        quantity: qty,
        selectedOptions: newOptions,
        specialInstructions: specialInstructions ?? original.specialInstructions
      }]);
    }
  }

  // Updates just the free-text note on a cart line — used by the "Special
  // instructions" field in the checkout drawer.
  updateCartLineInstructions(itemId: string, selectedOptions: SelectedOption[], instructions: string): void {
    this.cartItems.set(
      this.cartItems().map(e =>
        this.sameLine(e, itemId, selectedOptions) ? { ...e, specialInstructions: instructions } : e
      )
    );
  }

  // Reduces a cart line's quantity by 1; removes the line entirely once it
  // hits 0. Used by the "−" stepper in the checkout drawer.
  decrementCartItem(itemId: string, selectedOptions: SelectedOption[] = []): void {
    const current  = this.cartItems();
    const existing = current.find(e => this.sameLine(e, itemId, selectedOptions));
    if (!existing) return;

    if (existing.quantity <= 1) {
      this.cartItems.set(current.filter(e => !this.sameLine(e, itemId, selectedOptions)));
    } else {
      this.cartItems.set(
        current.map(e => this.sameLine(e, itemId, selectedOptions) ? { ...e, quantity: e.quantity - 1 } : e)
      );
    }
  }

  // Removes an entire line regardless of quantity — used by the drawer's
  // "Remove" link (distinct from the "−" stepper, which only removes 1).
  removeFromCart(itemId: string, selectedOptions: SelectedOption[] = []): void {
    this.cartItems.set(this.cartItems().filter(e => !this.sameLine(e, itemId, selectedOptions)));
  }

  clearCart(): void {
    this.cartItems.set([]);
  }

  // ══════════════════════════════════════════
  //  ORDER METHODS
  // ══════════════════════════════════════════
  placeOrder(): void {
    const staff = this.currentStaff();
    if (!staff) {
      console.error('Cannot place order: no staff logged in.');
      return;
    }
    const order = {
      items:           this.cartItems(),
      total:           this.cartTotal(),
      transactionMode: this.transactionMode(),
      paymentMode:     this.paymentMode(),
      timestamp:       new Date(),
      branch:          staff.branch,
      staffName:       staff.name,
      staffId:         staff._id
    };
    this.http.post<CompletedOrder>(`${this.api}/orders`, order).subscribe(saved => {
      this.completedOrders.set([...this.completedOrders(), saved]);
      this.clearCart();
    });
  }

  // Soft-resets the live "Today" view on the Manager Dashboard and every
  // unaffected, both before and after the reset.
 resetDailySales(onComplete?: () => void): void {
    this.http.delete(`${this.api}/orders/reset`).subscribe(() => {
      this.completedOrders.set([]); // instant local feedback; server truth confirmed on next poll
      if (onComplete) onComplete();
    });
  }

  // Permanently deletes EVERY order across every branch and date — unlike
  // resetDailySales() above, which only clears today. Requires a matching
  // `DELETE /api/orders/all` route on the backend (see server.js note).
  clearAllOrders(onComplete?: () => void, onError?: (err: any) => void): void {
    this.http.delete(`${this.api}/orders/all`).subscribe({
      next: () => {
        this.completedOrders.set([]);
        this.salesHistory.set([]);
        if (onComplete) onComplete();
      },
      error: (err) => {
        console.error('Clear all orders failed:', err);
        if (onError) onError(err);
      }
    });
  }

  // ══════════════════════════════════════════
  //  CANCEL / UNCANCEL ORDER
  //  Soft-cancels an order on the backend — it stays in the DB and in
  //  `completedOrders` (so it still shows up in the Cancelled Orders list)
  //  but is excluded from every sales total via `status`.
  // ══════════════════════════════════════════

  cancelOrder(orderId: string): void {
    this.http.patch<CompletedOrder>(`${this.api}/orders/${orderId}/cancel`, {}).subscribe(updated => {
      this.completedOrders.set(
        this.completedOrders().map(o => o._id === updated._id ? updated : o)
      );
    });
  }

  uncancelOrder(orderId: string): void {
    this.http.patch<CompletedOrder>(`${this.api}/orders/${orderId}/uncancel`, {}).subscribe(updated => {
      this.completedOrders.set(
        this.completedOrders().map(o => o._id === updated._id ? updated : o)
      );
    });
  }

  // ══════════════════════════════════════════
  //  IMAGE UPLOAD
  // ══════════════════════════════════════════

  uploadImage(file: File): Observable<{ filename: string; url: string }> {
    const formData = new FormData();
    formData.append('image', file);
    return this.http.post<{ filename: string; url: string }>(`${this.api}/upload`, formData);
  }

  // ══════════════════════════════════════════
  //  MENU ITEM METHODS
  // ══════════════════════════════════════════

  // onSuccess/onError let the caller know whether the save actually
  // persisted, instead of assuming success the moment the request is
  // fired — previously nothing surfaced a failed POST, so a rejected
  // save (e.g. backend validation error) looked identical to a working
  // one from the Manager Panel's point of view.
  addMenuItem(item: Omit<MenuItem, '_id'>, onSuccess?: () => void, onError?: (err: any) => void): void {
    this.http.post<MenuItem>(`${this.api}/menu`, item).subscribe({
      next: (saved) => {
        this.menuItems.set([...this.menuItems(), saved]);
        if (onSuccess) onSuccess();
      },
      error: (err) => {
        console.error('Add menu item failed:', err);
        if (onError) onError(err);
      }
    });
  }

  updateMenuItem(item: MenuItem, onSuccess?: () => void, onError?: (err: any) => void): void {
    this.http.put<MenuItem>(`${this.api}/menu/${item._id}`, item).subscribe({
      next: (updated) => {
        this.menuItems.set(this.menuItems().map(m => m._id === updated._id ? updated : m));
        if (onSuccess) onSuccess();
      },
      error: (err) => {
        console.error('Update menu item failed:', err);
        if (onError) onError(err);
      }
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

  addCategory(name: string, color: string, onSuccess?: () => void, onError?: (err: any) => void): void {
    this.http.post<KioskSettings>(`${this.api}/settings/categories`, { name, color }).subscribe({
      next: (saved) => {
        this.kioskSettings.set(saved);
        if (onSuccess) onSuccess();
      },
      error: (err) => {
        console.error('Add category failed:', err);
        if (onError) onError(err);
      }
      });
  }

  // Renaming cascades: the backend updates every MenuItem using the old
  // category name, so we mirror that locally too instead of waiting on a
  // full loadMenuItems() round trip.
  updateCategory(
    oldName: string,
    changes: { name?: string; color?: string },
    onSuccess?: (itemsUpdated: number) => void,
    onError?: (err: any) => void
  ): void {
    this.http.put<{ settings: KioskSettings; itemsUpdated: number }>(
      `${this.api}/settings/categories/${encodeURIComponent(oldName)}`,
      changes
    ).subscribe({
      next: (res) => {
        this.kioskSettings.set(res.settings);
        if (changes.name && changes.name !== oldName) {
          this.menuItems.set(
            this.menuItems().map(m => m.category === oldName ? { ...m, category: changes.name! } : m)
          );
        }
        if (onSuccess) onSuccess(res.itemsUpdated);
      },
      error: (err) => {
        console.error('Update category failed:', err);
        if (onError) onError(err);
      }
    });
  }

  // Deleting a category does NOT touch existing menu items server-side —
  // affectedItems tells the caller how many items are now on an
  // unlisted category, so the Manager Panel can warn about it.
  deleteCategory(
    name: string,
    onSuccess?: (affectedItems: number) => void,
    onError?: (err: any) => void
  ): void {
    this.http.delete<{ settings: KioskSettings; affectedItems: number }>(
      `${this.api}/settings/categories/${encodeURIComponent(name)}`
    ).subscribe({
      next: (res) => {
        this.kioskSettings.set(res.settings);
        if (onSuccess) onSuccess(res.affectedItems);
      },
      error: (err) => {
        console.error('Delete category failed:', err);
        if (onError) onError(err);
      }
    });
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

  // Permanently deletes EVERY staff account across every branch. Requires
  // a matching `DELETE /api/staff/all` route on the backend (see
  // server.js note).
  clearAllStaff(onComplete?: () => void, onError?: (err: any) => void): void {
    this.http.delete(`${this.api}/staff/all`).subscribe({
      next: () => {
        this.staffList.set([]);
        if (onComplete) onComplete();
      },
      error: (err) => {
        console.error('Clear all staff failed:', err);
        if (onError) onError(err);
      }
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
  //  Fetches all data, builds a 4-sheet Excel

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
