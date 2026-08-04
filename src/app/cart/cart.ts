import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartServices, MenuItem, SelectedOption, unitPrice, priceForBranch } from '../cart-services';

@Component({
  selector: 'app-cart',
  imports: [RouterLink],
  templateUrl: './cart.html',
  styleUrl: './cart.css'
})
export class CartComponent {
  cartService = inject(CartServices);
  orderPlaced = signal(false);
  priceForBranch = priceForBranch;

  lineUnitPrice(entry: { item: MenuItem; selectedOptions: SelectedOption[] }): number {
    return unitPrice(entry.item, entry.selectedOptions, this.cartService.getKioskBranch());
  }

  lineTotal(entry: { item: MenuItem; quantity: number; selectedOptions: SelectedOption[] }): number {
    return this.lineUnitPrice(entry) * entry.quantity;
  }

  placeOrder(): void {
    this.orderPlaced.set(true);
    this.cartService.clearCart();
  }
}
