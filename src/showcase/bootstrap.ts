export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

export function activateShowcaseStorage(host: object, now = new Date()): MemoryStorage {
  const memory = new MemoryStorage();
  Object.defineProperty(host, 'localStorage', {value: memory, configurable: true});
  seedFictionalData(memory, now);
  return memory;
}

export function seedFictionalData(memory: Storage, now: Date): void {
  const dateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  memory.setItem('biz_profile', JSON.stringify({firstName: 'Demo Vendor', phoneNumber: '', pin: '', currency: 'KHR', language: 'en', workEndTime: '18:00', syncOnWifiOnly: false, setupComplete: true}));
  memory.setItem('biz_language', 'en'); memory.setItem('biz_logged_in', 'true');
  memory.setItem('biz_txn_migrated', 'true');
  memory.setItem('biz_currency_rates', JSON.stringify({legacyCurrency: 'KHR', khrPerUsd: 4000, updatedAt: now.toISOString()}));
  const transactions: object[] = [], entries: object[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now); day.setDate(day.getDate()-i); day.setHours(12,0,0,0);
    const date = dateString(day), stamp = day.toISOString();
    const income = 160000 + (i % 4) * 20000, expenses = 45000 + (i % 3) * 5000;
    transactions.push({id:`fictional-income-${i}`, date, type:'income', amount:income, currency:'KHR', note:'Invented market sales', createdAt:stamp});
    transactions.push({id:`fictional-expense-${i}`, date, type:'expense', amount:expenses, currency:'KHR', note:'Invented supplies', createdAt:stamp});
    entries.push({date, income, expenses, createdAt:stamp, updatedAt:stamp, editCount:0});
  }
  memory.setItem('biz_transactions', JSON.stringify(transactions));
  memory.setItem('biz_entries', JSON.stringify(entries.reverse()));
  memory.setItem('biz_streak', JSON.stringify({currentStreak:14,longestStreak:14,lastEntryDate:dateString(now),lastBrokenStreakDate:null,freezesAvailable:2,freezesUsed:0,totalEntries:14}));
  memory.setItem('biz_badges', JSON.stringify([{id:'first_entry',icon:'🌱',earnedAt:now.toISOString()}]));
  memory.setItem('biz_sync_queue','[]'); memory.setItem('biz_bonus_freezes_granted','0');
}
