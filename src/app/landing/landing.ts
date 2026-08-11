import { Component, signal, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { CartServices, Staff } from '../cart-services';

@Component({
  selector: 'app-landing',
  imports: [],
  templateUrl: './landing.html',
  styleUrl: './landing.css'
})
export class LandingComponent {
  private router = inject(Router);
  private http = inject(HttpClient);
  private cartService = inject(CartServices);
  private api = 'https://finalproject-chut-2.onrender.com/api';

  staffCode = signal('');
  password = signal('');
  error = signal('');
  loading = signal(false); // NEW — drives the button's "Logging in..." state
  showPassword = signal(false); // NEW — toggles the password field's visibility

  togglePasswordVisibility(): void {
    this.showPassword.set(!this.showPassword());
  }

  login(): void {
    if (this.loading()) return; // guard against double-submit while a request is in flight

    this.error.set('');
    const code = this.staffCode().trim();
    const pass = this.password();

    if (!pass) {
      this.error.set('Please enter your password.');
      return;
    }

    this.loading.set(true);

    if (!code) {
      // No staff code entered → attempt Manager login
      this.http.post<{ success: boolean; role: string; message?: string }>(
        `${this.api}/login/manager`,
        { password: pass }
      ).subscribe({
        next: (res) => {
          if (res.success) {
            this.router.navigate(['/manager-panel']);
          } else {
            this.loading.set(false);
          }
        },
        error: (err) => {
          this.error.set(err.error?.message || 'Incorrect manager password');
          this.loading.set(false);
        }
      });
    } else {
      // Staff code entered → attempt Employee login
      this.http.post<{ success: boolean; role: string; staff?: Staff; message?: string }>(
        `${this.api}/login/staff`,
        { staffCode: code, password: pass }
      ).subscribe({
        next: (res) => {
          if (res.success && res.staff) {
            this.cartService.setCurrentStaff(res.staff);
            this.router.navigate(['/dashboard']);
          } else {
            this.loading.set(false);
          }
        },
        error: (err) => {
          this.error.set(err.error?.message || 'Incorrect staff code or password');
          this.loading.set(false);
        }
      });
    }
    // Note: loading is intentionally left `true` on success — the page is
    // about to navigate away, so there's no need to reset it, and leaving
    // it true keeps the button showing "Logging in..." right up to the
    // route change instead of flickering back to normal for a split second.
  }
}
