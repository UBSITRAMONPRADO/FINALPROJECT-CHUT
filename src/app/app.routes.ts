import { Routes } from '@angular/router';
import { LandingComponent } from './landing/landing';
import { DashboardComponent } from './dashboard/dashboard';
import { ManagerPanelComponent } from './manager-panel/manager-panel';
import { staffAuthGuard, managerAuthGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [staffAuthGuard] },
  { path: 'manager-panel', component: ManagerPanelComponent, canActivate: [managerAuthGuard] },
];
