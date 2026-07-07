import { Component, Input, Output, EventEmitter } from '@angular/core';
import { MenuItem } from '../cart-services';

@Component({
  selector: 'app-menu-item-card',
  imports: [],
  templateUrl: './menu-item-cart.html',
  styleUrl: './menu-item-cart.css'
})
export class MenuItemCardComponent {
  @Input() item!: MenuItem;
  @Output() addToCart = new EventEmitter<MenuItem>();

  onAdd(): void {
    this.addToCart.emit(this.item);
  }
}