import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app';
import { inject } from '@vercel/analytics';

// Initialize Vercel Analytics
inject();

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
