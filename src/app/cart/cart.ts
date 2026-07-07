import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartServices } from '../cart-services';

@Component({
  selector: 'app-cart',
  imports: [RouterLink],
  templateUrl: './cart.html',
  styleUrl: './cart.css'
})
export class CartComponent {
  cartService = inject(CartServices);
  orderPlaced = signal(false);

  placeOrder(): void {
    this.orderPlaced.set(true);
    this.cartService.clearCart();
  }
}