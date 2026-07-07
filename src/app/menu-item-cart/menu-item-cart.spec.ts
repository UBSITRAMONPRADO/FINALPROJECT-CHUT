import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MenuItemCart } from './menu-item-cart';

describe('MenuItemCart', () => {
  let component: MenuItemCart;
  let fixture: ComponentFixture<MenuItemCart>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MenuItemCart],
    }).compileComponents();

    fixture = TestBed.createComponent(MenuItemCart);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
