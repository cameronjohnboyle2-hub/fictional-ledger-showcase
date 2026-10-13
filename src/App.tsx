import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import Home from './pages/Home';
import Reports from './pages/Reports';
import Badges from './pages/Badges';
import Settings from './showcase/Settings';
import './i18n';
import { useTranslation } from 'react-i18next';

const queryClient = new QueryClient();
export default function App() {
  const { t } = useTranslation();
  return <QueryClientProvider client={queryClient}><TooltipProvider>
    <Toaster /><Sonner /><HashRouter>
      <aside aria-label={t('showcase.title')} className="bg-primary text-primary-foreground py-3 px-4">
        <div className="mx-auto max-w-4xl space-y-1 text-sm">
          <p className="font-semibold">{t('showcase.title')}</p>
          <p>{t('showcase.scope')}</p>
          <p className="text-xs">{t('showcase.privacy')}</p>
          <a className="inline-block underline underline-offset-2" href="https://github.com/cameronjohnboyle2-hub/fictional-ledger-showcase/blob/Website/CASE_STUDY.md">{t('showcase.link')}</a>
        </div>
      </aside>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/badges" element={<Badges />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </HashRouter>
  </TooltipProvider></QueryClientProvider>;
}
