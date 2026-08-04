import { Component, inject, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartServices, MenuItem, unitPrice, priceForBranch } from '../cart-services';
import { MenuItemCardComponent } from '../menu-item-cart/menu-item-cart';


@Component({
  selector: 'app-menu',
  imports: [MenuItemCardComponent, RouterLink],
  templateUrl: './menu.html',
  styleUrl: './menu.css'
})
export class MenuComponent {
  cartService = inject(CartServices);

  // ── KIOSK BRANCH — this kiosk/tablet is physically stationed at one
  // branch. Change this single value per device/build before deploying;
  // it drives every price shown and which items appear on this screen. ──
  branch = 'Harrison Bazaar';

  categories = ['All', 'Chillers', 'Combos', 'Corndog', 'Fries', 'Wings & Drinks', 'Wings & Fries', 'Wings & Gravy', 'Wings & Rice'];
  selectedCategory = signal('All');

  filteredItems = computed(() => {
    const cat = this.selectedCategory();
    const available = this.cartService.menuItems();
    return cat === 'All' ? available : available.filter(item => item.category === cat);
  });

  priceForBranch = priceForBranch;
  
  selectCategory(cat: string): void {
    this.selectedCategory.set(cat);
  }

  handleAddToCart(item: MenuItem): void {
    this.cartService.addToCart(item);
  }

  lineTotal(entry: { item: MenuItem; quantity: number; selectedOptions: any[] }): number {
    return unitPrice(entry.item, entry.selectedOptions, this.branch) * entry.quantity;
  }
}
