import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setStoredLanguage } from '@/i18n';
import { getProfile, saveProfile, recordCurrencySwitch } from '@/lib/storage';
import BottomNav from '@/components/BottomNav';

export default function Settings() {
  const { i18n } = useTranslation();
  const [currency, setCurrency] = useState(getProfile()?.currency || 'KHR');
  const changeCurrency = (next: 'KHR' | 'USD') => {
    const profile = getProfile(); if (!profile) return;
    // Fixed invented demonstration rate, not a current exchange-rate quote.
    recordCurrencySwitch(profile.currency, 4000);
    saveProfile({...profile, currency: next});
    setCurrency(next);
  };
  return <div className="max-w-md mx-auto p-5 pb-24 space-y-5">
    <h1 className="text-2xl font-bold">Demo settings</h1>
    <p>Invented business, data and exchange rate. Changes last only until reload.</p>
    <label className="block">Language <select className="border rounded p-2" value={i18n.language} onChange={e => setStoredLanguage(e.target.value as 'en' | 'km')}><option value="en">English</option><option value="km">ខ្មែរ</option></select></label>
    <label className="block">Display currency <select className="border rounded p-2" value={currency} onChange={e => changeCurrency(e.target.value as 'KHR' | 'USD')}><option value="KHR">KHR</option><option value="USD">USD</option></select></label>
    <p className="text-sm">No account, PIN, notification permission, upload, cloud sync or administrator endpoint exists in this showcase.</p>
    <button className="bg-primary text-primary-foreground rounded px-4 py-2" onClick={() => window.location.reload()}>Reset fictional demo</button>
    <BottomNav />
  </div>;
}
