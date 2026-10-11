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

const queryClient = new QueryClient();
export default function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider>
    <Toaster /><Sonner /><HashRouter>
      <div className="bg-primary text-primary-foreground text-center text-xs py-2 px-3">
        Fictional business · Memory only · No cloud connection · Reload resets
      </div>
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
