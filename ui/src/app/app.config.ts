import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { apiBaseInterceptor } from './core/module-context';
import { demoInterceptor } from './core/demo-interceptor';
import { provideCharts } from './shared/charts/echarts-setup';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch(), withInterceptors([apiBaseInterceptor, demoInterceptor])),
    provideCharts(),
  ],
};
