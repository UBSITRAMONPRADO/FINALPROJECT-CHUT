import { Routes } from '@angular/router';
import { LandingComponent } from './landing/landing';
import { DashboardComponent } from './dashboard/dashboard';
import { ManagerPanelComponent } from './manager-panel/manager-panel';

export const routes: Routes = [
  { path: 'dashboard', component: DashboardComponent },
  { path: 'manager-panel', component: ManagerPanelComponent },
  { path: '', component: LandingComponent },
];