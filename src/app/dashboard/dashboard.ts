import { Component, inject, signal, computed, ViewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { CartServices, MenuItem, CartItem, SelectedOption, VariantGroup, optionsKey, unitPrice } from '../cart-services';

interface Flyer {
  id: string;
  image: string;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  active: boolean;
}

@Component({
  selector: 'app-dashboard',
  imports: [],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent {
  router      = inject(Router);
  cartService = inject(CartServices);

  activeTab = signal<string>('sales');

  // ── ON DUTY ──
  currentStaff = computed(() => this.cartService.currentStaff());

  // ── NEW ORDER ──
  orderStep            = signal<number>(1);
  selectedTransaction  = signal<string>('');
  selectedPayment      = signal<string>('');
  categories = ['All', 'Chillers', 'Combos', 'Corndog', 'Fries', 'Wings & Drinks', 'Wings & Fries', 'Wings & Gravy', 'Wings & Rice'];
  selectedCategory = signal('All');

  filteredItems = computed(() => {
    const cat = this.selectedCategory();
    if (cat === 'All') return this.cartService.menuItems();
    return this.cartService.menuItems().filter(item => item.category === cat);
  });

  // ── CHECKOUT DRAWER — INLINE VARIANT EDITING ──
  // Tracks which cart line's "Special instructions" textarea is open,
  // keyed by item._id + optionsKey (so two lines of the same item with
  // different options don't share a state).
  openInstructionsKey = signal<string | null>(null);

  private instructionsKeyFor(entry: CartItem): string {
    return `${entry.item._id}::${optionsKey(entry.selectedOptions)}`;
  }

  isInstructionsOpen(entry: CartItem): boolean {
    return this.openInstructionsKey() === this.instructionsKeyFor(entry);
  }

  toggleInstructions(entry: CartItem): void {
    const key = this.instructionsKeyFor(entry);
    this.openInstructionsKey.set(this.isInstructionsOpen(entry) ? null : key);
  }

  updateLineInstructions(entry: CartItem, value: string): void {
    this.cartService.updateCartLineInstructions(entry.item._id, entry.selectedOptions, value);
  }

  // Is this option currently selected on this specific cart line?
  isCartLineOptionSelected(entry: CartItem, groupName: string, label: string): boolean {
    return entry.selectedOptions.some(o => o.groupName === groupName && o.label === label);
  }

  // Tapping a chip directly on a cart line — single groups swap the pick,
  // multi groups toggle it. Quantity is preserved; if the resulting combo
  // matches another existing line, they merge (handled by the service).
  toggleCartLineOption(entry: CartItem, group: VariantGroup, label: string): void {
    const currentLabels = entry.selectedOptions
      .filter(o => o.groupName === group.name)
      .map(o => o.label);

    const nextLabels = group.type === 'single'
      ? [label]
      : currentLabels.includes(label)
        ? currentLabels.filter(l => l !== label)
        : [...currentLabels, label];

    const otherOptions = entry.selectedOptions.filter(o => o.groupName !== group.name);
    const newGroupOptions: SelectedOption[] = nextLabels.map(l => {
      const opt = group.options.find(o => o.label === l);
      return { groupName: group.name, label: l, priceDelta: opt?.priceDelta ?? 0 };
    });

    this.cartService.updateCartLineOptions(
      entry.item._id,
      entry.selectedOptions,
      [...otherOptions, ...newGroupOptions],
      entry.quantity
    );
  }
  
  // ── POS UI STATE (New Order — step 2) ──
  drawerOpen    = signal(false);
  orderComplete = signal(false);
  flyers        = signal<Flyer[]>([]);
  dockPulse     = signal(false);

  @ViewChild('dockRef') dockRef?: ElementRef<HTMLElement>;

  // ── VARIANT PICKER (Shopee-style, multi-group: Sauce, Spice Level,
  // Extras, etc.) — opens instead of an instant add whenever the tapped
  // item has variantGroups. Also reused for editing an existing cart line. ──
  variantPickerItem = signal<MenuItem | null>(null);
  variantQty        = signal<number>(1);

  // Per-group selections while the sheet is open: groupName -> chosen labels.
  // 'single' groups hold at most one label; 'multi' groups hold zero or more.
  pickerSelections = signal<Record<string, string[]>>({});

  // Set only when the picker was opened via "Edit" on an existing cart line —
  // holds that line's original selections so we know what to replace on save.
  private editingLineOldOptions: SelectedOption[] | null = null;

  // All required groups must have a selection before "Add to Cart" is enabled.
  pickerCanConfirm = computed(() => {
    const item = this.variantPickerItem();
    if (!item?.variantGroups) return true;
    const sel = this.pickerSelections();
    return item.variantGroups
      .filter(g => g.required)
      .every(g => (sel[g.name] ?? []).length > 0);
  });

  // Live unit price shown on the confirm button as selections change.
  pickerUnitPrice = computed(() => {
    const item = this.variantPickerItem();
    if (!item) return 0;
    return unitPrice(item, this.buildSelectedOptions(item));
  });

  // ── MENU MANAGEMENT ──
  showMenuForm = signal(false);
  editingItem  = signal<MenuItem | null>(null);
  newItem      = signal<Partial<MenuItem>>({ name: '', price: 0, category: '', description: '', image: '' });

  // ── SALES COMPUTED (cancelled orders excluded from every total) ──
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

  // ── ORDERS LIST ──
  // "Done" is a lightweight client-side flag (not persisted).
  // "Cancelled" is backend-persisted via order.status — see cart-services.ts.
  doneOrderIds = signal<Set<string>>(new Set());

  private allOrdersIndexed = computed(() =>
    this.cartService.completedOrders().map((order, i) => ({ order, index: i + 1 }))
  );

  pendingOrders = computed(() =>
    this.allOrdersIndexed().filter(entry =>
      !this.doneOrderIds().has(entry.order._id) && entry.order.status !== 'cancelled'
    )
  );

  doneOrders = computed(() =>
    this.allOrdersIndexed().filter(entry => this.doneOrderIds().has(entry.order._id))
  );

  cancelledOrders = computed(() =>
    this.allOrdersIndexed().filter(entry => entry.order.status === 'cancelled')
  );

  markOrderDone(orderId: string): void {
    const updated = new Set(this.doneOrderIds());
    updated.add(orderId);
    this.doneOrderIds.set(updated);
  }

  undoOrderDone(orderId: string): void {
    const updated = new Set(this.doneOrderIds());
    updated.delete(orderId);
    this.doneOrderIds.set(updated);
  }

  markOrderCancelled(orderId: string): void {
    this.cartService.cancelOrder(orderId);
  }

  undoOrderCancelled(orderId: string): void {
    this.cartService.uncancelOrder(orderId);
  }

  // ── INIT ──
  constructor() {
    this.cartService.loadMenuItems();
    this.cartService.loadTodayOrders();
    this.cartService.loadSettings();
    // Note: loadStaff() removed — staff management is manager-only
  }

  // ── CATEGORY COLOR CODING (used across chips, cards, and the flying icon) ──
  categoryColor(cat: string): string {
    if (cat.includes('Wings'))   return '#CC0000';
    if (cat.includes('Fries'))   return '#FFC200';
    if (cat.includes('Corndog')) return '#E8792F';
    if (cat.includes('Chillers')) return '#2E9BCC';
    if (cat.includes('Combos'))  return '#7C3AED';
    return '#1A1A1A'; // "All"
  }

  lightBg(cat: string): string {
    return `${this.categoryColor(cat)}14`;
  }

  optionsKey = optionsKey; // exposed for the template's @for track expressions

  // ── NEW ORDER METHODS ──
  selectTransaction(mode: string): void {
    this.selectedTransaction.set(mode);
    this.orderStep.set(2);
  }

  // Tapping "+" on the grid. Items with variant groups open the picker
  // sheet instead of adding instantly; everything else keeps the fast,
  // uninterrupted add-and-fly behavior.
  addItemToOrder(item: MenuItem, event: MouseEvent): void {
    if (item.variantGroups && item.variantGroups.length > 0) {
      this.openVariantPicker(item);
      return;
    }
    this.flyAndAdd(item, event.currentTarget as HTMLElement, [], 1);
  }

  // Shared by both the instant-add path and the variant picker's "Add to
  // Cart" confirm — animates the item flying into the dock, then adds it.
  // Falls back to a bottom-center landing point if the dock hasn't
  // rendered yet (i.e. this is the very first item added).
  private flyAndAdd(item: MenuItem, originEl: HTMLElement, selectedOptions: SelectedOption[], qty: number): void {
    const btnRect = originEl.getBoundingClientRect();
    const dockEl = this.dockRef?.nativeElement;

    let endX: number, endY: number;
    if (dockEl) {
      const dockRect = dockEl.getBoundingClientRect();
      endX = dockRect.left + 30;
      endY = dockRect.top + 22;
    } else {
      endX = window.innerWidth / 2;
      endY = window.innerHeight - 56;
    }

    const startX = btnRect.left + btnRect.width / 2 - 20;
    const startY = btnRect.top + btnRect.height / 2 - 20;
    const id = `${item._id}-${Date.now()}`;

    const flyer: Flyer = {
      id,
      image: item.image,
      startX,
      startY,
      dx: endX - startX - 20,
      dy: endY - startY - 20,
      active: false
    };
    this.flyers.set([...this.flyers(), flyer]);

    // Flip to "active" a tick later so the browser registers the start
    // position first, letting the CSS transition animate to the end point.
    setTimeout(() => {
      this.flyers.set(this.flyers().map(f => f.id === id ? { ...f, active: true } : f));
    }, 20);

    setTimeout(() => {
      this.flyers.set(this.flyers().filter(f => f.id !== id));
      this.dockPulse.set(true);
      setTimeout(() => this.dockPulse.set(false), 260);
    }, 520);

    this.cartService.addToCart(item, selectedOptions, qty);
  }

  // ── VARIANT PICKER METHODS ──

  // Opens the picker for a fresh add (from the grid) when existingEntry is
  // omitted, or pre-filled for editing when called from a cart line's
  // "Edit" button.
  openVariantPicker(item: MenuItem, existingEntry?: CartItem): void {
    this.variantPickerItem.set(item);
    this.variantQty.set(existingEntry?.quantity ?? 1);
    this.editingLineOldOptions = existingEntry ? existingEntry.selectedOptions : null;

    const initial: Record<string, string[]> = {};
    for (const group of item.variantGroups ?? []) {
      if (existingEntry) {
        initial[group.name] = existingEntry.selectedOptions
          .filter(o => o.groupName === group.name)
          .map(o => o.label);
      } else if (group.required && group.type === 'single' && group.options.length > 0) {
        initial[group.name] = [group.options[0].label]; // default to first choice
      } else {
        initial[group.name] = [];
      }
    }
    this.pickerSelections.set(initial);
  }

  closeVariantPicker(): void {
    this.variantPickerItem.set(null);
    this.editingLineOldOptions = null;
  }

  isOptionSelected(groupName: string, label: string): boolean {
    return (this.pickerSelections()[groupName] ?? []).includes(label);
  }

  toggleGroupOption(group: VariantGroup, label: string): void {
    const current = this.pickerSelections()[group.name] ?? [];
    let next: string[];
    if (group.type === 'single') {
      next = [label];
    } else {
      next = current.includes(label) ? current.filter(l => l !== label) : [...current, label];
    }
    this.pickerSelections.set({ ...this.pickerSelections(), [group.name]: next });
  }

  incrementVariantQty(): void {
    this.variantQty.set(this.variantQty() + 1);
  }

  decrementVariantQty(): void {
    this.variantQty.set(Math.max(1, this.variantQty() - 1));
  }

  private buildSelectedOptions(item: MenuItem): SelectedOption[] {
    const sel = this.pickerSelections();
    const result: SelectedOption[] = [];
    for (const group of item.variantGroups ?? []) {
      for (const label of sel[group.name] ?? []) {
        const opt = group.options.find(o => o.label === label);
        result.push({ groupName: group.name, label, priceDelta: opt?.priceDelta ?? 0 });
      }
    }
    return result;
  }

  confirmVariantAdd(event: MouseEvent): void {
    const item = this.variantPickerItem();
    if (!item || !this.pickerCanConfirm()) return;

    const selectedOptions = this.buildSelectedOptions(item);

    if (this.editingLineOldOptions) {
      // Editing an existing line — replace its selections/qty in place
      // rather than adding a new stacked entry.
      this.cartService.updateCartLineOptions(item._id, this.editingLineOldOptions, selectedOptions, this.variantQty());
      this.closeVariantPicker();
      return;
    }

    this.flyAndAdd(item, event.currentTarget as HTMLElement, selectedOptions, this.variantQty());
    this.closeVariantPicker();
  }

  // ── CART LINE ACTIONS (from the checkout drawer) ──
  editCartLine(entry: CartItem): void {
    this.openVariantPicker(entry.item, entry);
  }

  removeCartLine(entry: CartItem): void {
    this.cartService.removeFromCart(entry.item._id, entry.selectedOptions);
  }

  lineUnitPrice(entry: CartItem): number {
    return unitPrice(entry.item, entry.selectedOptions);
  }

  formatOptions(options: SelectedOption[]): string {
  return options.map(o => o.label).join(', ');
  }

  openDrawer(): void {
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  selectPayment(mode: string): void {
    if (!this.currentStaff()) {
      this.router.navigate(['/']);
      return;
    }
    this.selectedPayment.set(mode);
    this.cartService.transactionMode.set(this.selectedTransaction());
    this.cartService.paymentMode.set(mode);
    this.cartService.placeOrder();
    this.orderComplete.set(true);
  }

  newOrder(): void {
    this.selectedTransaction.set('');
    this.selectedPayment.set('');
    this.orderStep.set(1);
    this.selectedCategory.set('All');
    this.drawerOpen.set(false);
    this.orderComplete.set(false);
  }

  newOrderFromSuccess(): void {
    this.newOrder();
  }

  seeOrderFromSuccess(): void {
    this.newOrder();
    this.activeTab.set('orders');
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
    } else {
      this.cartService.addMenuItem(item as Omit<MenuItem, '_id'>);
    }
    this.showMenuForm.set(false);
    this.editingItem.set(null);
  }

  deleteItem(itemId: string): void {
    this.cartService.deleteMenuItem(itemId);
  }

  cancelMenuForm(): void {
    this.showMenuForm.set(false);
    this.editingItem.set(null);
  }

  updateNewItem(field: string, value: string | number): void {
    this.newItem.set({ ...this.newItem(), [field]: value });
  }

  logout(): void {
    this.cartService.logoutStaff();
    this.router.navigate(['/']);
  }
}
