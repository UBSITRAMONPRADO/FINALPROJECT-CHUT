import { Component, inject, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartServices, MenuItem } from '../cart-services';
import { MenuItemCardComponent } from '../menu-item-cart/menu-item-cart';


@Component({
  selector: 'app-menu',
  imports: [MenuItemCardComponent, RouterLink],
  templateUrl: './menu.html',
  styleUrl: './menu.css'
})
export class MenuComponent {
  cartService = inject(CartServices);

  categories = ['All', 'Chillers', 'Combos', 'Corndog', 'Fries', 'Wings & Drinks', 'Wings & Fries', 'Wings & Gravy', 'Wings & Rice'];
  selectedCategory = signal('All');

  filteredItems = computed(() => {
    const cat = this.selectedCategory();
    if (cat === 'All') return this.cartService.menuItems();
    return this.cartService.menuItems().filter(item => item.category === cat);
  });

  selectCategory(cat: string): void {
    this.selectedCategory.set(cat);
  }

  handleAddToCart(item: MenuItem): void {
    this.cartService.addToCart(item);
  }
}