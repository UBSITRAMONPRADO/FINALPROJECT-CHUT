import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CartServices } from './cart-services';

export const staffAuthGuard: CanActivateFn = () => {
  const cartService = inject(CartServices);
  const router = inject(Router);

  if (cartService.currentStaff()) {
    return true;
  }
  router.navigate(['/']);
  return false;
};

export const managerAuthGuard: CanActivateFn = () => {
  const router = inject(Router);

  if (sessionStorage.getItem('isManager') === 'true') {
    return true;
  }
  router.navigate(['/']);
  return false;
};