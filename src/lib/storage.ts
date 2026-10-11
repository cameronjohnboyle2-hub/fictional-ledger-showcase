// Storage utilities — hybrid: localStorage for offline + Supabase for sync
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import i18n from "@/i18n";

export interface DailyEntry {
  date: string; // YYYY-MM-DD
  income: number;
  expenses: number;
  createdAt: string;
  updatedAt?: string; // Last edit timestamp
  editCount?: number; // How many times this entry has been edited
}

export type AppLanguage = 'en' | 'km';

export interface UserProfile {
  phoneNumber: string;
  pin: string;
  firstName: string;
  currency: 'USD' | 'KHR';
  language: AppLanguage;
  workEndTime: string;
  syncOnWifiOnly: boolean;
  setupComplete: boolean;
  installedAt?: string; // ISO date when user first set up
  /** True when local profile settings haven't yet been accepted by the cloud. */
  settingsPendingSync?: boolean;
  /** True when a local currency change hasn't yet been pushed to the cloud. */
  currencyPendingSync?: boolean;
}

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  lastEntryDate: string | null;
  lastBrokenStreakDate: string | null; // Date streak was broken (for Comeback badge)
  freezesAvailable: number;
  freezesUsed: number;
  totalEntries: number;
}

export interface Badge {
  id: string;
  icon: string;
  earnedAt: string | null;
}

// Tracks habit-style badge progress that can't be derived from entries alone
export interface HabitTracking {
  // Punctual Pro: consecutive days logging within 30min of work end time
  punctualStreak: number;
  lastPunctualDate: string | null;
  // Closing Shop: consecutive days logging between 5pm-9pm
  closingShopStreak: number;
  lastClosingShopDate: string | null;
  // Weekend Warrior: consecutive weekends with both Sat & Sun logged
  weekendsCompleted: number;
  lastWeekendKey: string | null; // YYYY-Www
  weekendSatLogged: string | null; // last Sat date logged
  weekendSunLogged: string | null; // last Sun date logged
  // Auditor: how many times reports/history opened
  reportsViewCount: number;
  // Seasons: which calendar seasons have at least one entry
  seasonsLogged: { spring: boolean; summer: boolean; fall: boolean; winter: boolean };
}

const KEYS = {
  PROFILE: 'biz_profile',
  ENTRIES: 'biz_entries',
  STREAK: 'biz_streak',
  BADGES: 'biz_badges',
  HABITS: 'biz_habits',
  LOGGED_IN: 'biz_logged_in',
  SYNC_QUEUE: 'biz_sync_queue',
  BONUS_FREEZES: 'biz_bonus_freezes_granted',
  TRANSACTIONS: 'biz_transactions',
  TXN_MIGRATED: 'biz_txn_migrated',
  SYNC_STATUS: 'biz_sync_status',
  DATA_OWNER: 'biz_data_owner',
};

export interface SyncStatus {
  lastSyncAt: string | null;       // ISO timestamp of last successful sync
  lastEntriesRestored: number;     // # of daily logs restored on last restore
  lastTransactionsRestored: number;
  pendingOps: number;              // queued operations not yet flushed
  lastConfirmedSyncAt: string | null; // last time the cloud ACCEPTED a write
  consecutiveFailures: number;     // consecutive failed flush attempts
}

export type BackupHealth = 'ok' | 'pending' | 'at-risk';

const withTimeout = <T,>(promise: PromiseLike<T>, ms = 7000): Promise<T> =>
  Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('cloud-timeout')), ms)),
  ]);

export function getSyncStatus(): SyncStatus {
  try {
    const raw = localStorage.getItem(KEYS.SYNC_STATUS);
    const parsed = raw ? JSON.parse(raw) : {};
    const profile = getProfile();
    const queue = readSyncQueueSafe();
    const hasQueuedProfile = queue.some((op) => {
      return !!op && typeof op === 'object' && (op as { kind?: unknown }).kind === 'profile_settings';
    });
    const pendingProfileOps = !hasQueuedProfile && (profile?.settingsPendingSync || profile?.currencyPendingSync) ? 1 : 0;
    return {
      lastSyncAt: parsed.lastSyncAt ?? null,
      lastEntriesRestored: parsed.lastEntriesRestored ?? 0,
      lastTransactionsRestored: parsed.lastTransactionsRestored ?? 0,
      pendingOps: queue.length + pendingProfileOps,
      lastConfirmedSyncAt: parsed.lastConfirmedSyncAt ?? null,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
    };
  } catch {
    return {
      lastSyncAt: null,
      lastEntriesRestored: 0,
      lastTransactionsRestored: 0,
      pendingOps: 0,
      lastConfirmedSyncAt: null,
      consecutiveFailures: 0,
    };
  }
}

/**
 * Classify how safe the user's data is right now.
 * - ok:      nothing waiting, and the cloud confirmed a write recently
 * - pending: items queued, but uploads are still working
 * - at-risk: uploads keep failing, or nothing has reached the cloud in 24h
 *            while there is unsynced local work
 */
export function getBackupHealth(): BackupHealth {
  const status = getSyncStatus();
  const hasLocalData = (() => {
    try { return getTransactions().length > 0 || getEntries().length > 0; } catch { return false; }
  })();
  if (!hasLocalData) return 'ok';

  const confirmedAt = status.lastConfirmedSyncAt ? Date.parse(status.lastConfirmedSyncAt) : NaN;
  const ageMs = Number.isFinite(confirmedAt) ? Date.now() - confirmedAt : Infinity;
  const staleDay = ageMs > 24 * 60 * 60 * 1000;

  if (status.consecutiveFailures >= 3) return 'at-risk';
  if (status.pendingOps > 0 && staleDay) return 'at-risk';
  if (!status.lastConfirmedSyncAt && status.pendingOps > 0) return 'at-risk';
  if (status.pendingOps > 0) return 'pending';
  return 'ok';
}

export const SYNC_STATUS_EVENT = 'biz:sync-status';

function emitSyncStatusChanged(): void {
  try { window.dispatchEvent(new Event(SYNC_STATUS_EVENT)); } catch { /* noop */ }
}

function readSyncQueueSafe(): unknown[] {
  try {
    const raw = localStorage.getItem('biz_sync_queue');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function patchSyncStatus(patch: Partial<Omit<SyncStatus, 'pendingOps'>>): void {
  try {
    const current = getSyncStatus();
    const next = { ...current, ...patch };
    localStorage.setItem(KEYS.SYNC_STATUS, JSON.stringify({
      lastSyncAt: next.lastSyncAt,
      lastEntriesRestored: next.lastEntriesRestored,
      lastTransactionsRestored: next.lastTransactionsRestored,
      lastConfirmedSyncAt: next.lastConfirmedSyncAt,
      consecutiveFailures: next.consecutiveFailures,
    }));
    emitSyncStatusChanged();
  } catch { /* noop */ }
}


// ===== Transactions (per-event log) =====
export type TransactionType = 'income' | 'expense';

export interface Transaction {
  id: string;
  date: string;          // YYYY-MM-DD (local)
  type: TransactionType;
  amount: number;
  note?: string;          // optional description
  createdAt: string;     // ISO
  /**
   * Currency the amount was entered in. Stamped at creation from the
   * user's active profile currency. Optional for backward-compat with
   * legacy transactions created before this field existed — those are
   * interpreted as the `legacyCurrency` in the local rates table.
   */
  currency?: 'USD' | 'KHR';
}

// ===== Currency conversion (display-only, device-local) =====
export interface CurrencyRates {
  /** Currency of all pre-first-switch entries. Set once, never overwritten. */
  legacyCurrency: 'USD' | 'KHR' | null;
  /** Most recent user-entered rate: how many riels equal $1 USD. */
  khrPerUsd: number | null;
  updatedAt: string | null;
}

const CURRENCY_RATES_KEY = 'biz_currency_rates';

function saveCurrencyRates(rates: CurrencyRates): void {
  localStorage.setItem(CURRENCY_RATES_KEY, JSON.stringify(rates));
}

export function getCurrencyRates(): CurrencyRates {
  try {
    const raw = localStorage.getItem(CURRENCY_RATES_KEY);
    if (!raw) return { legacyCurrency: null, khrPerUsd: null, updatedAt: null };
    const p = JSON.parse(raw);
    return {
      legacyCurrency: p.legacyCurrency === 'USD' || p.legacyCurrency === 'KHR' ? p.legacyCurrency : null,
      khrPerUsd: typeof p.khrPerUsd === 'number' && p.khrPerUsd > 0 ? p.khrPerUsd : null,
      updatedAt: p.updatedAt ?? null,
    };
  } catch {
    return { legacyCurrency: null, khrPerUsd: null, updatedAt: null };
  }
}

/**
 * Persist a currency switch. Latches `legacyCurrency` to `previousCurrency`
 * on the very first switch, then always overwrites the rate with the most
 * recent user-provided value.
 */
export function recordCurrencySwitch(previousCurrency: 'USD' | 'KHR', khrPerUsd: number): void {
  if (!(khrPerUsd > 0)) return;
  const current = getCurrencyRates();
  const legacyCurrency = current.legacyCurrency ?? previousCurrency;
  saveCurrencyRates({
    legacyCurrency,
    khrPerUsd,
    updatedAt: new Date().toISOString(),
  });
}

/** Push the current local currency rates to the user's profile row. */
export async function pushCurrencyRatesToCloud(): Promise<void> {
  await pushProfileSettingsToCloud();
}

/**
 * Pull the currency rate + legacy currency stamp from the user's profile row.
 * Only hydrates local state when the local rate is missing, so a device where
 * the user just typed a fresh rate isn't overwritten by an older cloud value.
 */
export async function restoreCurrencyRatesFromCloud(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('profiles')
      .select('khr_per_usd, legacy_currency')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!data) return;
    const rate = (data as { khr_per_usd?: number | null }).khr_per_usd;
    const legacy = (data as { legacy_currency?: string | null }).legacy_currency;
    const current = getCurrencyRates();
    if (current.khrPerUsd == null && typeof rate === 'number' && rate > 0) {
      saveCurrencyRates({
        legacyCurrency: legacy === 'USD' || legacy === 'KHR' ? legacy : current.legacyCurrency,
        khrPerUsd: rate,
        updatedAt: new Date().toISOString(),
      });
    } else if (current.legacyCurrency == null && (legacy === 'USD' || legacy === 'KHR')) {
      saveCurrencyRates({
        ...current,
        legacyCurrency: legacy,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch { /* noop */ }
}

/** Convert an amount from one currency to another using the stored rate. */
export function convertAmount(amount: number, from: 'USD' | 'KHR', to: 'USD' | 'KHR'): number {
  if (from === to || !Number.isFinite(amount)) return amount;
  const rate = getCurrencyRates().khrPerUsd;
  if (!rate || rate <= 0) return amount; // no rate — display raw
  return from === 'USD' ? amount * rate : amount / rate;
}

/** Effective native currency for an entry/transaction (falls back to legacy). */
function nativeCurrencyOf(explicit: 'USD' | 'KHR' | undefined): 'USD' | 'KHR' {
  if (explicit) return explicit;
  const rates = getCurrencyRates();
  if (rates.legacyCurrency) return rates.legacyCurrency;
  return getProfile()?.currency || 'USD';
}

export function getTransactions(): Transaction[] {
  const raw = localStorage.getItem(KEYS.TRANSACTIONS);
  return raw ? JSON.parse(raw) : [];
}

function writeTransactions(txns: Transaction[]): void {
  localStorage.setItem(KEYS.TRANSACTIONS, JSON.stringify(txns));
}

export function getTransactionsForDate(date: string): Transaction[] {
  return getTransactions()
    .filter(t => t.date === date)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Recompute the DailyEntry totals for `date` from its transactions and persist
 * via saveEntry(). Keeps streaks/badges/cloud sync working off the aggregate.
 */
function recomputeDailyEntry(date: string) {
  const txns = getTransactionsForDate(date);
  const income = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  return saveEntry({
    date,
    income,
    expenses,
    createdAt: txns[0]?.createdAt || new Date().toISOString(),
  });
}

export function addTransaction(type: TransactionType, amount: number, note: string = '', date: string = getTodayString()): Transaction {
  const activeCurrency = getProfile()?.currency || 'USD';
  const txn: Transaction = {
    id: uid(),
    date,
    type,
    amount: sanitizeAmount(amount),
    note: note.trim() || undefined,
    createdAt: new Date().toISOString(),
    currency: activeCurrency,
  };
  const all = getTransactions();
  all.push(txn);
  writeTransactions(all);
  recomputeDailyEntry(date);
  syncTransactionToCloud(txn);
  return txn;
}

export function updateTransaction(id: string, amount: number, note?: string): Transaction | null {
  const all = getTransactions();
  const idx = all.findIndex(t => t.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], amount: sanitizeAmount(amount) };
  if (note !== undefined) {
    all[idx].note = note.trim() || undefined;
  }
  writeTransactions(all);
  recomputeDailyEntry(all[idx].date);
  syncTransactionToCloud(all[idx]);
  return all[idx];
}

export function deleteTransaction(id: string): void {
  const all = getTransactions();
  const txn = all.find(t => t.id === id);
  if (!txn) return;
  writeTransactions(all.filter(t => t.id !== id));
  recomputeDailyEntry(txn.date);
  deleteTransactionFromCloud(id);
}

/**
 * One-time migration: turn each existing DailyEntry into 1 income + 1 expense
 * transaction (whichever amounts are > 0). Idempotent via TXN_MIGRATED flag.
 */
export function migrateEntriesToTransactions(): void {
  if (localStorage.getItem(KEYS.TXN_MIGRATED) === 'true') return;
  const entries = getEntries();
  const existing = getTransactions();
  if (existing.length > 0 || entries.length === 0) {
    localStorage.setItem(KEYS.TXN_MIGRATED, 'true');
    return;
  }
  const generated: Transaction[] = [];
  for (const e of entries) {
    const base = e.createdAt || new Date(e.date + 'T12:00:00').toISOString();
    if (e.income > 0) {
      generated.push({ id: uid(), date: e.date, type: 'income', amount: e.income, createdAt: base });
    }
    if (e.expenses > 0) {
      generated.push({ id: uid(), date: e.date, type: 'expense', amount: e.expenses, createdAt: base });
    }
  }
  writeTransactions(generated);
  localStorage.setItem(KEYS.TXN_MIGRATED, 'true');
}

// ===== Validation & input safety =====
/** Cap on a single day's income or expenses. KHR cap scales by ~4000. */
export const MAX_AMOUNT_USD = 1_000_000;
export const MAX_AMOUNT_KHR = 4_000_000_000;

export function getMaxAmount(): number {
  const profile = getProfile();
  return profile?.currency === 'KHR' ? MAX_AMOUNT_KHR : MAX_AMOUNT_USD;
}

/**
 * Sanitize a numeric money value: rejects NaN/Infinity/negatives,
 * clamps to MAX_AMOUNT, and rounds away noise.
 */
export function sanitizeAmount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const max = getMaxAmount();
  if (value > max) return max;
  // Round to 2 decimals to avoid floating-point garbage
  return Math.round(value * 100) / 100;
}

/** Previous phone normalizer, kept so existing +855-format accounts can still sign in. */
function legacyNormalizePhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

/** Strip non-digits, Cambodia country code, and leading 0s to canonicalize phone-as-identity. */
export function normalizePhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  const withoutCountryCode = digits.startsWith('855') && digits.length > 8
    ? digits.slice(3)
    : digits;
  return withoutCountryCode.replace(/^0+/, '');
}

/** Build the synthetic auth email from a phone number, consistently. */
export function phoneToAuthEmail(phone: string): string {
  return `${normalizePhone(phone)}@biztrack.local`;
}

/** Login candidates for accounts created before +855 phone canonicalization was fixed. */
export function phoneToAuthEmailCandidates(phone: string): string[] {
  const canonical = normalizePhone(phone);
  const legacy = legacyNormalizePhone(phone);
  const candidates = [canonical, legacy];
  if (canonical) candidates.push(`855${canonical}`);
  return Array.from(new Set(candidates.filter(Boolean).map(p => `${p}@biztrack.local`)));
}

// ===== Local-date helpers (timezone-safe) =====
/** YYYY-MM-DD in the user's LOCAL timezone — never UTC. */
export function getLocalDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add (or subtract) whole days to a YYYY-MM-DD string in local time. */
export function addDaysLocal(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return getLocalDateString(dt);
}

// Profile (localStorage only — lightweight settings)
export function getProfile(): UserProfile | null {
  const data = localStorage.getItem(KEYS.PROFILE);
  return data ? JSON.parse(data) : null;
}

export function saveProfile(profile: UserProfile): void {
  // Stamp install date the first time we save a profile
  if (!profile.installedAt) {
    profile.installedAt = new Date().toISOString();
  }
  localStorage.setItem(KEYS.PROFILE, JSON.stringify(profile));
}

export type ProfileSettingsSaveResult =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'no-session' | 'denied' | 'error' };

/**
 * Push all user profile settings in one durable write. This is used for the
 * Settings screen and for retries after a timeout/offline save.
 */
export async function pushProfileSettingsToCloud(): Promise<ProfileSettingsSaveResult> {
  const profile = getProfile();
  if (!profile) return { ok: false, reason: 'no-session' };

  const op: SyncOp = { kind: 'profile_settings', profile: buildProfileSettingsSyncPayload(profile) };
  enqueueSyncOp(op);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const { data: { user } } = await withTimeout(supabase.auth.getUser(), 4000);
    if (!user) return { ok: false, reason: 'no-session' };
    await withTimeout(executeSyncOp(op, user.id), 6000);
    removeQueuedProfileSettings();
    applySyncedProfilePayload(op.profile);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Retry any profile/settings change that was saved locally but not accepted by the cloud yet. */
export async function retryPendingProfileSync(): Promise<void> {
  const profile = getProfile();
  if (!profile?.settingsPendingSync && !profile?.currencyPendingSync) return;
  await pushProfileSettingsToCloud();
}

export function isLoggedIn(): boolean {
  return localStorage.getItem(KEYS.LOGGED_IN) === 'true';
}

export function setLoggedIn(value: boolean): void {
  localStorage.setItem(KEYS.LOGGED_IN, value ? 'true' : 'false');
}

// ---- Account ownership of local data -------------------------------------
// Local storage is shared by everyone who signs in on this device. Tagging it
// with the owning account id lets us wipe another account's ledger before a
// different user's data is shown, merged, or uploaded to the wrong account.

export function getLocalDataOwner(): string | null {
  try { return localStorage.getItem(KEYS.DATA_OWNER); } catch { return null; }
}

export function setLocalDataOwner(userId: string): void {
  try { localStorage.setItem(KEYS.DATA_OWNER, userId); } catch { /* noop */ }
}

/** True when local data is known to belong to a different account. */
export function localDataBelongsToOtherAccount(userId: string): boolean {
  const owner = getLocalDataOwner();
  return !!owner && owner !== userId;
}

// A wipe must never be the last copy of anyone's ledger: before clearing we
// snapshot the ledger into an archive key that survives the wipe and can be
// restored if the wipe turns out to have been a false positive.
export const LEDGER_ARCHIVE_KEY = 'biz_ledger_archive';
const MAX_ARCHIVES = 3;

export type LedgerArchive = {
  savedAt: string;
  owner: string | null;
  reason: string;
  entries: DailyEntry[];
  transactions: Transaction[];
  streak: string | null;
  badges: string | null;
  habits: string | null;
  bonusFreezes: string | null;
  profile: string | null;
};

function readArchives(): LedgerArchive[] {
  try {
    const raw = localStorage.getItem(LEDGER_ARCHIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Snapshot the current local ledger so a wipe can never be the final word. */
export function archiveLocalLedger(reason: string): void {
  try {
    const entries = getEntries();
    const transactions = getTransactions();
    if (entries.length === 0 && transactions.length === 0) return;
    const archive: LedgerArchive = {
      savedAt: new Date().toISOString(),
      owner: getLocalDataOwner(),
      reason,
      entries,
      transactions,
      streak: localStorage.getItem(KEYS.STREAK),
      badges: localStorage.getItem(KEYS.BADGES),
      habits: localStorage.getItem(KEYS.HABITS),
      bonusFreezes: localStorage.getItem(KEYS.BONUS_FREEZES),
      profile: localStorage.getItem(KEYS.PROFILE),
    };
    const next = [archive, ...readArchives()].slice(0, MAX_ARCHIVES);
    localStorage.setItem(LEDGER_ARCHIVE_KEY, JSON.stringify(next));
  } catch { /* noop */ }
}

function wipeLocalAppData(): void {
  // The chosen UI language is a device preference, not ledger data.
  // The archive is our safety net and must outlive the wipe.
  const PRESERVE = new Set(['biz_language', LEDGER_ARCHIVE_KEY]);
  try {
    Object.values(KEYS).forEach(k => { if (!PRESERVE.has(k)) localStorage.removeItem(k); });
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('biz_') && !PRESERVE.has(k)) localStorage.removeItem(k);
    }
  } catch { /* noop */ }
}

/**
 * Clear the device for a brand-new signup. The previous ledger is archived
 * first, so a mis-detected "new account" can never destroy real history.
 */
export function resetLocalDataForNewAccount(userId: string): void {
  archiveLocalLedger('new-account-signup');
  wipeLocalAppData();
  setLocalDataOwner(userId);
}

/**
 * Called right after sign-in. Wipes local data when it belongs to a different
 * account; otherwise adopts the device for this account.
 */
export function prepareLocalDataForAccount(userId: string): { wiped: boolean } {
  const wiped = localDataBelongsToOtherAccount(userId);
  if (wiped) {
    archiveLocalLedger('account-switch');
    wipeLocalAppData();
  }
  setLocalDataOwner(userId);
  return { wiped };
}

/**
 * Self-heal: if this account has an empty local ledger but the device holds an
 * archived ledger that is either untagged or tagged to this same account, put
 * it back and queue it for upload. Covers the case where a wipe fired on a
 * false "new account" detection.
 */
export function recoverArchivedLedgerIfEmpty(userId: string): { recovered: boolean; entries: number; transactions: number } {
  const none = { recovered: false, entries: 0, transactions: 0 };
  try {
    if (getEntries().length > 0 || getTransactions().length > 0) return none;
    const archives = readArchives();
    const archive = archives.find(a => !a.owner || a.owner === userId);
    if (!archive) return none;

    persistEntries(archive.entries || []);
    writeTransactions(archive.transactions || []);
    if (archive.streak) localStorage.setItem(KEYS.STREAK, archive.streak);
    if (archive.badges) localStorage.setItem(KEYS.BADGES, archive.badges);
    if (archive.habits) localStorage.setItem(KEYS.HABITS, archive.habits);
    if (archive.bonusFreezes) localStorage.setItem(KEYS.BONUS_FREEZES, archive.bonusFreezes);
    localStorage.setItem(KEYS.TXN_MIGRATED, 'true');
    setLocalDataOwner(userId);

    for (const entry of archive.entries || []) enqueueSyncOp({ kind: 'entry', entry });
    for (const txn of archive.transactions || []) enqueueSyncOp({ kind: 'txn_upsert', txn });
    void flushSyncQueue();

    return { recovered: true, entries: (archive.entries || []).length, transactions: (archive.transactions || []).length };
  } catch { return none; }
}


// Entries — local
export function getEntries(): DailyEntry[] {
  const data = localStorage.getItem(KEYS.ENTRIES);
  return data ? JSON.parse(data) : [];
}

export function saveEntry(rawEntry: DailyEntry): { entry: DailyEntry; isEdit: boolean; secondsSinceCreate: number } {
  // Sanitize: clamp negatives/Infinity/NaN and cap at MAX_AMOUNT
  const entry: DailyEntry = {
    ...rawEntry,
    income: sanitizeAmount(rawEntry.income),
    expenses: sanitizeAmount(rawEntry.expenses),
  };
  const entries = getEntries();
  const existingIndex = entries.findIndex(e => e.date === entry.date);
  const now = new Date().toISOString();
  let isEdit = false;
  let secondsSinceCreate = 0;

  if (existingIndex >= 0) {
    isEdit = true;
    const existing = entries[existingIndex];
    secondsSinceCreate = (Date.now() - new Date(existing.createdAt).getTime()) / 1000;
    entries[existingIndex] = {
      ...entry,
      createdAt: existing.createdAt, // preserve original creation time
      updatedAt: now,
      editCount: (existing.editCount || 0) + 1,
    };
  } else {
    entries.push({
      ...entry,
      createdAt: entry.createdAt || now,
      updatedAt: now,
      editCount: 0,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  localStorage.setItem(KEYS.ENTRIES, JSON.stringify(entries));
  return { entry: entries.find(e => e.date === entry.date)!, isEdit, secondsSinceCreate };
}

export function getEntryForDate(date: string): DailyEntry | undefined {
  return getEntries().find(e => e.date === date);
}

// ===== Sync queue (retry on failure) =====
type SyncOp =
  | { kind: 'profile_settings'; profile: ProfileSettingsSyncPayload }
  | { kind: 'entry'; entry: DailyEntry }
  | { kind: 'stats'; streak: StreakData; badges: Badge[] }
  | { kind: 'txn_upsert'; txn: Transaction }
  | { kind: 'txn_delete'; id: string };

type ProfileSettingsSyncPayload = {
  phoneNumber: string;
  firstName: string;
  currency: 'USD' | 'KHR';
  language: AppLanguage;
  workEndTime: string;
  syncOnWifiOnly: boolean;
  settingsPendingSync?: boolean;
  currencyPendingSync?: boolean;
  rates: CurrencyRates;
};

function buildProfileSettingsSyncPayload(profile: UserProfile): ProfileSettingsSyncPayload {
  return {
    phoneNumber: profile.phoneNumber,
    firstName: profile.firstName,
    currency: profile.currency,
    language: profile.language,
    workEndTime: profile.workEndTime,
    syncOnWifiOnly: profile.syncOnWifiOnly,
    settingsPendingSync: profile.settingsPendingSync === true,
    currencyPendingSync: profile.currencyPendingSync === true,
    rates: getCurrencyRates(),
  };
}

function applySyncedProfilePayload(payload: ProfileSettingsSyncPayload): void {
  const latest = getProfile();
  if (latest) {
    saveProfile({
      ...latest,
      phoneNumber: payload.phoneNumber,
      firstName: payload.firstName,
      currency: payload.currency,
      language: payload.language,
      workEndTime: payload.workEndTime,
      syncOnWifiOnly: payload.syncOnWifiOnly,
      settingsPendingSync: false,
      currencyPendingSync: false,
    });
  }
  if (payload.rates.khrPerUsd != null || payload.rates.legacyCurrency != null) {
    saveCurrencyRates({ ...payload.rates, updatedAt: payload.rates.updatedAt ?? new Date().toISOString() });
  }
  patchSyncStatus({ lastSyncAt: new Date().toISOString() });
}

function applyPendingProfilePayloadLocally(payload: ProfileSettingsSyncPayload): void {
  const latest = getProfile();
  if (latest) {
    saveProfile({
      ...latest,
      phoneNumber: payload.phoneNumber,
      firstName: payload.firstName,
      currency: payload.currency,
      language: payload.language,
      workEndTime: payload.workEndTime,
      syncOnWifiOnly: payload.syncOnWifiOnly,
      settingsPendingSync: payload.settingsPendingSync ?? true,
      currencyPendingSync: payload.currencyPendingSync ?? false,
    });
  }
  if (payload.rates.khrPerUsd != null || payload.rates.legacyCurrency != null) {
    saveCurrencyRates({ ...payload.rates, updatedAt: payload.rates.updatedAt ?? new Date().toISOString() });
  }
}

function removeQueuedProfileSettings(): void {
  writeSyncQueue(readSyncQueue().filter(op => op.kind !== 'profile_settings'));
}

function readSyncQueue(): SyncOp[] {
  try {
    const raw = localStorage.getItem(KEYS.SYNC_QUEUE);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeSyncQueue(ops: SyncOp[]): void {
  // This queue is the user's unsynced financial ledger. Never truncate it:
  // dropping older operations to enforce an arbitrary cap can permanently
  // discard records after local storage is cleared during logout.
  localStorage.setItem(KEYS.SYNC_QUEUE, JSON.stringify(ops));
}

function hasSameEntryValues(a: DailyEntry, b: DailyEntry): boolean {
  return a.date === b.date && a.income === b.income && a.expenses === b.expenses;
}

function persistEntries(entries: DailyEntry[]): void {
  localStorage.setItem(KEYS.ENTRIES, JSON.stringify(entries.sort((a, b) => b.date.localeCompare(a.date))));
}

function entryFromTransactionTotals(date: string, txns: Transaction[]): DailyEntry {
  const income = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  return {
    date,
    income,
    expenses,
    createdAt: txns[0]?.createdAt || new Date(date + 'T12:00:00').toISOString(),
    updatedAt: txns[txns.length - 1]?.createdAt,
  };
}

function mergeEntriesPreferNewest(existingEntries: DailyEntry[], incomingEntries: DailyEntry[]): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>();
  for (const entry of existingEntries) byDate.set(entry.date, entry);
  for (const entry of incomingEntries) {
    const current = byDate.get(entry.date);
    if (!current) {
      byDate.set(entry.date, entry);
      continue;
    }
    const currentUpdated = new Date(current.updatedAt || current.createdAt || 0).getTime();
    const entryUpdated = new Date(entry.updatedAt || entry.createdAt || 0).getTime();
    if (entryUpdated >= currentUpdated) byDate.set(entry.date, entry);
  }
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

function queueMissingEntriesForCloud(previousLocal: DailyEntry[], mergedEntries: DailyEntry[]): void {
  for (const entry of mergedEntries) {
    const previous = previousLocal.find(e => e.date === entry.date);
    if (!previous || !hasSameEntryValues(previous, entry)) {
      enqueueSyncOp({ kind: 'entry', entry });
    }
  }
}

function enqueueSyncOp(op: SyncOp): void {
  const queue = readSyncQueue();
  if (op.kind === 'profile_settings') {
    const filtered: SyncOp[] = queue.filter(q => q.kind !== 'profile_settings');
    filtered.push(op);
    writeSyncQueue(filtered);
  } else if (op.kind === 'entry') {
    const entryDate = op.entry.date;
    const filtered = queue.filter(q => !(q.kind === 'entry' && q.entry.date === entryDate));
    filtered.push(op);
    writeSyncQueue(filtered);
  } else if (op.kind === 'stats') {
    const filtered: SyncOp[] = queue.filter(q => q.kind !== 'stats');
    filtered.push(op);
    writeSyncQueue(filtered);
  } else if (op.kind === 'txn_upsert') {
    const id = op.txn.id;
    const filtered = queue.filter(q => !((q.kind === 'txn_upsert' && q.txn.id === id) || (q.kind === 'txn_delete' && q.id === id)));
    filtered.push(op);
    writeSyncQueue(filtered);
  } else {
    const id = op.id;
    const filtered = queue.filter(q => !((q.kind === 'txn_upsert' && q.txn.id === id) || (q.kind === 'txn_delete' && q.id === id)));
    filtered.push(op);
    writeSyncQueue(filtered);
  }
}

function syncOpKey(op: SyncOp): string {
  if (op.kind === 'entry') return `entry:${op.entry.date}`;
  if (op.kind === 'txn_upsert') return `txn:${op.txn.id}`;
  if (op.kind === 'txn_delete') return `txn:${op.id}`;
  return op.kind;
}

function removeCompletedSyncOp(completed: SyncOp): void {
  const completedKey = syncOpKey(completed);
  const completedValue = JSON.stringify(completed);
  const current = readSyncQueue();
  writeSyncQueue(current.filter(op => {
    if (syncOpKey(op) !== completedKey) return true;
    // A newer local edit may have replaced this operation while its request
    // was in flight. Remove only the exact version accepted by the cloud.
    return JSON.stringify(op) !== completedValue;
  }));
}

async function executeSyncOp(op: SyncOp, userId: string): Promise<void> {
  if (op.kind === 'profile_settings') {
    const settings = {
      currency: op.profile.currency,
      language: op.profile.language,
      work_end_time: op.profile.workEndTime,
      sync_on_wifi_only: op.profile.syncOnWifiOnly,
      khr_per_usd: op.profile.rates.khrPerUsd,
      legacy_currency: op.profile.rates.legacyCurrency,
    };
    if (op.profile.phoneNumber) {
      // Full upsert — safe to write identity fields too.
      const { error } = await supabase
        .from('profiles')
        .upsert(
          {
            user_id: userId,
            phone_number: op.profile.phoneNumber,
            ...(op.profile.firstName ? { first_name: op.profile.firstName } : {}),
            ...settings,
          },
          { onConflict: 'user_id' },
        );
      if (error) throw error;
    } else {
      // Local profile was rebuilt without identity fields (cleared storage) —
      // update settings only so we never clobber phone/name in the cloud.
      const { error } = await supabase
        .from('profiles')
        .update(settings)
        .eq('user_id', userId);
      if (error) throw error;
    }
  } else if (op.kind === 'entry') {
    // NOTE: never stamp `currency` here. A daily aggregate can cover dates
    // recorded long before the user switched currencies; writing the *current*
    // profile currency onto historical rows makes those days display without
    // conversion (e.g. ៛50 instead of ៛200,000) and looks like lost data.
    // Per-transaction rows carry the authoritative currency instead.
    const { error } = await supabase
      .from('daily_entries')
      .upsert(
        {
          user_id: userId,
          date: op.entry.date,
          income: op.entry.income,
          expenses: op.entry.expenses,
        },
        { onConflict: 'user_id,date' }
      );
    if (error) throw error;
  } else if (op.kind === 'stats') {
    const entries = getEntries();
    const cutoff7 = addDaysLocal(getLocalDateString(), -7);
    const cutoff14 = addDaysLocal(getLocalDateString(), -14);
    const cutoff30 = addDaysLocal(getLocalDateString(), -30);
    const earnedBadges = op.badges
      .filter(b => b.earnedAt)
      .map(b => ({ id: b.id, icon: b.icon, earnedAt: b.earnedAt }));
    const bonusGranted = parseInt(localStorage.getItem(KEYS.BONUS_FREEZES) || '0', 10);
    const habits = getHabitTracking();
    const { error } = await supabase
      .from('user_stats')
      .upsert(
        {
          user_id: userId,
          total_entries: op.streak.totalEntries,
          current_streak: op.streak.currentStreak,
          longest_streak: op.streak.longestStreak,
          entries_last_7_days: entries.filter(e => e.date >= cutoff7).length,
          entries_last_14_days: entries.filter(e => e.date >= cutoff14).length,
          entries_last_30_days: entries.filter(e => e.date >= cutoff30).length,
          badges_earned: earnedBadges,
          last_entry_date: op.streak.lastEntryDate,
          freezes_available: op.streak.freezesAvailable,
          freezes_used: op.streak.freezesUsed,
          last_broken_streak_date: op.streak.lastBrokenStreakDate,
          bonus_freezes_granted: bonusGranted,
          habit_tracking: habits as unknown as Json,
        },
        { onConflict: 'user_id' }
      );
    if (error) throw error;
  } else if (op.kind === 'txn_upsert') {
    const { error } = await supabase
      .from('transactions')
      .upsert(
        {
          id: op.txn.id,
          user_id: userId,
          date: op.txn.date,
          type: op.txn.type,
          amount: op.txn.amount,
          note: op.txn.note ?? null,
          created_at: op.txn.createdAt,
          currency: op.txn.currency ?? null,
        },
        { onConflict: 'id' }
      );
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', op.id)
      .eq('user_id', userId);
    if (error) throw error;
  }
}

let flushing = false;
/** Drain the sync queue. Safe to call repeatedly; serializes itself. */
export async function flushSyncQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Guarantee the backend has an identity row to attach writes to —
    // without it every upload fails silently forever.
    await ensureCloudProfileExists();
    // Process one snapshot once. A permanently invalid operation must remain
    // available for retry, but it must never block unrelated later records.
    const queue = readSyncQueue();
    const initial = queue.length;
    let drained = 0;
    let failed = false;
    for (const op of queue) {
      try {
        if (op.kind === 'profile_settings') applyPendingProfilePayloadLocally(op.profile);
        await executeSyncOp(op, user.id);
        if (op.kind === 'profile_settings') applySyncedProfilePayload(op.profile);
        removeCompletedSyncOp(op);
        drained++;
      } catch {
        // Keep this operation for retry, but continue so one malformed or
        // rejected record cannot strand the user's entire later history.
        failed = true;
      }
    }
    const now = new Date().toISOString();
    if (drained > 0) {
      patchSyncStatus({ lastSyncAt: now, lastConfirmedSyncAt: now, consecutiveFailures: 0 });
      void stampLastSyncedAt(user.id);
    } else if (failed) {
      patchSyncStatus({ consecutiveFailures: getSyncStatus().consecutiveFailures + 1 });
    } else if (initial === 0) {
      // Nothing queued — everything local is already in the cloud.
      patchSyncStatus({ lastSyncAt: now, lastConfirmedSyncAt: now, consecutiveFailures: 0 });
      void stampLastSyncedAt(user.id);
    }
  } finally {
    flushing = false;
  }
}

// ===== One-time full resync =====
// Historically the app only uploaded what was sitting in the pending queue.
// If a write failed and the queue was cleared (or the profile row was missing
// so every write was rejected), that history was never retried. This pushes
// EVERYTHING on the device to the cloud once, idempotently.
const FULL_RESYNC_KEY = 'biz_full_resync_v1';
const RESYNC_CHUNK = 100;

export interface FullResyncResult {
  ran: boolean;
  ok: boolean;
  entries: number;
  transactions: number;
}

/** Record the moment the cloud last accepted a write for this account. */
async function stampLastSyncedAt(userId: string): Promise<void> {
  try {
    await withTimeout(
      supabase.from('profiles').update({ last_synced_at: new Date().toISOString() }).eq('user_id', userId)
    );
  } catch { /* best-effort */ }
}

export function hasCompletedFullResync(): boolean {
  try { return localStorage.getItem(FULL_RESYNC_KEY) === 'done'; } catch { return false; }
}

/**
 * Upload every local daily entry and transaction. Idempotent upserts, so
 * re-running never duplicates and never deletes anything locally.
 * Anything that fails falls back into the normal retry queue.
 */
export async function runFullResync(force = false): Promise<FullResyncResult> {
  const empty: FullResyncResult = { ran: false, ok: true, entries: 0, transactions: 0 };
  try {
    if (!force && hasCompletedFullResync()) return empty;

    const { data: { user } } = await withTimeout(supabase.auth.getUser());
    if (!user) return empty;
    // Refuse to bulk-upload a ledger that belongs to another account.
    if (localDataBelongsToOtherAccount(user.id)) return empty;
    const hasProfile = await ensureCloudProfileExists();
    if (!hasProfile) return { ...empty, ran: true, ok: false };

    const entries = getEntries();
    const transactions = getTransactions();
    if (entries.length === 0 && transactions.length === 0) {
      try { localStorage.setItem(FULL_RESYNC_KEY, 'done'); } catch { /* noop */ }
      await stampLastSyncedAt(user.id);
      return { ran: true, ok: true, entries: 0, transactions: 0 };
    }

    let ok = true;
    let entriesUploaded = 0;
    let txnsUploaded = 0;

    for (let i = 0; i < entries.length; i += RESYNC_CHUNK) {
      const chunk = entries.slice(i, i + RESYNC_CHUNK);
      try {
        const { error } = await withTimeout(
          supabase.from('daily_entries').upsert(
            // Deliberately no `currency`: these are historical aggregates and
            // stamping today's profile currency on them breaks conversion.
            chunk.map(e => ({
              user_id: user.id,
              date: e.date,
              income: e.income,
              expenses: e.expenses,
            })),
            { onConflict: 'user_id,date' },
          ),
          15000,
        );
        if (error) throw error;
        entriesUploaded += chunk.length;
      } catch {
        ok = false;
        chunk.forEach(entry => enqueueSyncOp({ kind: 'entry', entry }));
      }
    }

    for (let i = 0; i < transactions.length; i += RESYNC_CHUNK) {
      const chunk = transactions.slice(i, i + RESYNC_CHUNK);
      try {
        const { error } = await withTimeout(
          supabase.from('transactions').upsert(
            chunk.map(t => ({
              id: t.id,
              user_id: user.id,
              date: t.date,
              type: t.type,
              amount: t.amount,
              note: t.note ?? null,
              created_at: t.createdAt,
              currency: t.currency ?? null,
            })),
            { onConflict: 'id' },
          ),
          15000,
        );
        if (error) throw error;
        txnsUploaded += chunk.length;
      } catch {
        ok = false;
        chunk.forEach(txn => enqueueSyncOp({ kind: 'txn_upsert', txn }));
      }
    }

    if (ok) {
      try { localStorage.setItem(FULL_RESYNC_KEY, 'done'); } catch { /* noop */ }
      const now = new Date().toISOString();
      patchSyncStatus({ lastSyncAt: now, lastConfirmedSyncAt: now, consecutiveFailures: 0 });
      await stampLastSyncedAt(user.id);
    } else {
      emitSyncStatusChanged();
      void flushSyncQueue();
    }

    return { ran: true, ok, entries: entriesUploaded, transactions: txnsUploaded };
  } catch {
    return { ...empty, ran: true, ok: false };
  }
}

/**
 * Make sure a profile row exists in the backend for the signed-in account.
 * A missing row means every sync write silently goes nowhere — this is the
 * failure mode that stranded users' data locally. Cheap, idempotent, safe to
 * call on every flush.
 */
let profileEnsuredForUser: string | null = null;
export async function ensureCloudProfileExists(): Promise<boolean> {
  try {
    const { data: { user } } = await withTimeout(supabase.auth.getUser());
    if (!user) return false;
    if (profileEnsuredForUser === user.id) return true;

    const { data, error } = await withTimeout(
      supabase.from('profiles').select('user_id').eq('user_id', user.id).maybeSingle()
    );
    if (error) return false;
    if (data) {
      profileEnsuredForUser = user.id;
      return true;
    }

    // No row — rebuild it from the local profile, falling back to the phone
    // number encoded in the auth account's email.
    const local = getProfile();
    const emailPhone = (user.email || '').split('@')[0] || '';
    const phone = local?.phoneNumber || emailPhone;
    if (!phone) return false;
    const rates = getCurrencyRates();
    const { error: insertError } = await withTimeout(
      supabase.from('profiles').upsert({
        user_id: user.id,
        phone_number: phone,
        first_name: local?.firstName || null,
        currency: local?.currency ?? 'USD',
        language: local?.language ?? 'en',
        work_end_time: local?.workEndTime ?? '17:00',
        sync_on_wifi_only: local?.syncOnWifiOnly ?? true,
        khr_per_usd: rates.khrPerUsd,
        legacy_currency: rates.legacyCurrency,
      }, { onConflict: 'user_id' })
    );
    if (insertError) return false;
    profileEnsuredForUser = user.id;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the browser to exempt this app's storage from automatic eviction.
 * Reduces surprise data loss on iOS/Android when storage is reclaimed.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (localStorage.getItem('biz_persist_requested') === 'true') return;
    const storage = navigator.storage as StorageManager | undefined;
    if (!storage || typeof storage.persist !== 'function') return;
    if (typeof storage.persisted === 'function' && await storage.persisted()) {
      localStorage.setItem('biz_persist_requested', 'true');
      return;
    }
    await storage.persist();
    localStorage.setItem('biz_persist_requested', 'true');
  } catch { /* noop */ }
}


// Wire up automatic flushes
if (typeof window !== 'undefined') {
  const retryAllPendingSync = () => {
    void flushSyncQueue().then(() => runFullResync());
    void retryPendingProfileSync();
  };
  window.addEventListener('online', retryAllPendingSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      retryAllPendingSync();
    }
  });
  setTimeout(retryAllPendingSync, 0);
  // Periodic background retry every 60s
  setInterval(retryAllPendingSync, 60_000);
}

/** Queue an entry write and try to flush immediately. */
export async function syncEntryToCloud(entry: DailyEntry): Promise<void> {
  enqueueSyncOp({ kind: 'entry', entry });
  await flushSyncQueue();
}

/** Queue a stats write and try to flush immediately. */
export async function syncStatsToCloud(streak: StreakData, badges: Badge[]): Promise<void> {
  enqueueSyncOp({ kind: 'stats', streak, badges });
  await flushSyncQueue();
}

/** Queue a transaction upsert and try to flush immediately. */
export async function syncTransactionToCloud(txn: Transaction): Promise<void> {
  enqueueSyncOp({ kind: 'txn_upsert', txn });
  await flushSyncQueue();
}

/** Queue a transaction delete and try to flush immediately. */
export async function deleteTransactionFromCloud(id: string): Promise<void> {
  enqueueSyncOp({ kind: 'txn_delete', id });
  await flushSyncQueue();
}

/**
 * Pull all of the user's transactions from the cloud and overwrite the local
 * store. Also rebuilds the daily entry aggregates from those transactions.
 * Used after sign-in to restore granular line items + notes on a fresh device.
 */
export async function restoreTransactionsFromCloud(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from('transactions')
    .select('id,date,type,amount,note,created_at,currency')
    .eq('user_id', user.id);
  if (error || !data) return;
  if (data.length === 0) {
    // Cloud empty — push whatever we have locally so the line items don't get
    // lost on the next logout. (Idempotent upsert by id.)
    // Skipped when the local ledger belongs to a different account.
    if (localDataBelongsToOtherAccount(user.id)) return;
    const local = getTransactions();
    for (const t of local) enqueueSyncOp({ kind: 'txn_upsert', txn: t });
    flushSyncQueue();
    return;
  }
  const restored: Transaction[] = data.map((r) => {
    const cur = (r as { currency?: string | null }).currency;
    return {
      id: r.id as string,
      date: r.date as string,
      type: r.type as TransactionType,
      amount: Number(r.amount),
      note: (r.note as string | null) ?? undefined,
      createdAt: r.created_at as string,
      currency: cur === 'USD' || cur === 'KHR' ? cur : undefined,
    };
  });
  const byId = new Map<string, Transaction>();
  for (const t of getTransactions()) byId.set(t.id, t);
  for (const t of restored) byId.set(t.id, t);
  const mergedTransactions = Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  writeTransactions(mergedTransactions);
  // Mark migration as done so we don't re-seed from daily_entries.
  localStorage.setItem(KEYS.TXN_MIGRATED, 'true');
  // Fill gaps only: daily_entries are the source of truth for historical logs.
  // Transactions may be partial for legacy users, so never overwrite an existing day here.
  const existingEntries = getEntries();
  const existingDates = new Set(existingEntries.map(e => e.date));
  const derivedEntries = Array.from(new Set(mergedTransactions.map(t => t.date)))
    .filter(date => !existingDates.has(date))
    .map(date => entryFromTransactionTotals(date, mergedTransactions.filter(t => t.date === date)));
  if (derivedEntries.length > 0) {
    const mergedEntries = mergeEntriesPreferNewest(existingEntries, derivedEntries);
    persistEntries(mergedEntries);
    queueMissingEntriesForCloud(existingEntries, mergedEntries);
    flushSyncQueue();
  }

  // Backfill placeholder transactions for legacy days: any cloud daily_entries
  // day with no corresponding line items becomes 1 income and/or 1 expense
  // placeholder, so those days can be edited in Reports instead of showing
  // "no transactions". Stamped in the entry's original currency.
  try {
    const { data: cloudEntries } = await supabase
      .from('daily_entries')
      .select('date,income,expenses,currency,created_at')
      .eq('user_id', user.id);
    if (cloudEntries && cloudEntries.length > 0) {
      const txnsByDate = new Map<string, Transaction[]>();
      for (const t of mergedTransactions) {
        const arr = txnsByDate.get(t.date) || [];
        arr.push(t);
        txnsByDate.set(t.date, arr);
      }
      const profile = getProfile();
      const legacyNote = profile?.language === 'km' ? 'សរុបចាស់' : 'Legacy total';
      const placeholders: Transaction[] = [];
      for (const e of cloudEntries) {
        const date = e.date as string;
        const income = Number(e.income) || 0;
        const expenses = Number(e.expenses) || 0;
        if (income <= 0 && expenses <= 0) continue;
        const existing = txnsByDate.get(date) || [];
        const hasIncomeTxn = existing.some(t => t.type === 'income');
        const hasExpenseTxn = existing.some(t => t.type === 'expense');
        // Legacy days have no per-transaction data, so their true currency is
        // the pre-switch (legacy) currency — NOT whatever the profile uses
        // today, and not the aggregate's `currency` stamp, which older builds
        // wrote with the current profile currency during a resync.
        const cur: 'USD' | 'KHR' = nativeCurrencyOf(undefined);
        const base = (e.created_at as string) || new Date(date + 'T12:00:00').toISOString();
        if (income > 0 && !hasIncomeTxn) {
          placeholders.push({ id: uid(), date, type: 'income', amount: income, note: legacyNote, createdAt: base, currency: cur });
        }
        if (expenses > 0 && !hasExpenseTxn) {
          placeholders.push({ id: uid(), date, type: 'expense', amount: expenses, note: legacyNote, createdAt: base, currency: cur });
        }
      }
      if (placeholders.length > 0) {
        const all = getTransactions();
        for (const t of placeholders) all.push(t);
        writeTransactions(all.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)));
        for (const t of placeholders) enqueueSyncOp({ kind: 'txn_upsert', txn: t });
        flushSyncQueue();
      }
    }
  } catch { /* noop — backfill is best-effort */ }

  patchSyncStatus({
    lastSyncAt: new Date().toISOString(),
    lastTransactionsRestored: mergedTransactions.length,
  });
}

/**
 * One-time repair for devices that ran the earlier "Sync now / Fix now" flow.
 * That flow stamped historical daily aggregates with the *current* profile
 * currency, so the generated "Legacy total" placeholders were mislabelled and
 * their amounts stopped being converted — a KHR user's older USD history
 * suddenly displayed as tiny riel figures, i.e. "my data is gone".
 * Clearing the stamp restores the legacy-currency fallback used before.
 */
const LEGACY_CURRENCY_REPAIR_KEY = 'biz_legacy_currency_repair_v1';
export function repairLegacyPlaceholderCurrency(): void {
  try {
    if (localStorage.getItem(LEGACY_CURRENCY_REPAIR_KEY) === 'done') return;
    const legacy = getCurrencyRates().legacyCurrency;
    const txns = getTransactions();
    let changed = false;
    const fixed = txns.map(t => {
      const isPlaceholder = t.note === 'Legacy total' || t.note === 'សរុបចាស់';
      if (!isPlaceholder || !t.currency) return t;
      if (legacy && t.currency === legacy) return t;
      changed = true;
      const { currency: _drop, ...rest } = t;
      return rest as Transaction;
    });
    if (changed) {
      writeTransactions(fixed);
      for (const t of fixed) {
        if (t.note === 'Legacy total' || t.note === 'សរុបចាស់') enqueueSyncOp({ kind: 'txn_upsert', txn: t });
      }
      void flushSyncQueue();
    }
    localStorage.setItem(LEGACY_CURRENCY_REPAIR_KEY, 'done');
  } catch { /* noop */ }
}


/**
 * Pull the user's streak, badges, freeze inventory, and habit-tracking from
 * the cloud and write them back into localStorage. Lets things like the
 * streak count, earned badges, Auditor progress, weekend warrior counter,
 * and remaining streak freezes survive a log out / log back in cycle.
 */
export async function restoreStatsFromCloud(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from('user_stats')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !data) return;

  // Streak
  const streak: StreakData = {
    currentStreak: data.current_streak ?? 0,
    longestStreak: data.longest_streak ?? 0,
    lastEntryDate: data.last_entry_date ?? null,
    lastBrokenStreakDate: data.last_broken_streak_date ?? null,
    freezesAvailable: data.freezes_available ?? 1,
    freezesUsed: data.freezes_used ?? 0,
    totalEntries: data.total_entries ?? 0,
  };
  localStorage.setItem(KEYS.STREAK, JSON.stringify(streak));

  // Badges — merge earned timestamps into the canonical definitions
  const earned = (Array.isArray(data.badges_earned) ? data.badges_earned : []) as Array<{ id: string; earnedAt: string | null }>;
  const merged = BADGE_DEFINITIONS.map(def => {
    const hit = earned.find(b => b && b.id === def.id);
    return hit ? { ...def, earnedAt: hit.earnedAt } : { ...def };
  });
  localStorage.setItem(KEYS.BADGES, JSON.stringify(merged));

  // Bonus-freeze grant counter (so we don't re-grant freezes already given)
  localStorage.setItem(KEYS.BONUS_FREEZES, String(data.bonus_freezes_granted ?? 0));

  // Habits
  if (data.habit_tracking && typeof data.habit_tracking === 'object' && !Array.isArray(data.habit_tracking)) {
    const h = data.habit_tracking as Record<string, unknown>;
    if (Object.keys(h).length > 0) {
      localStorage.setItem(KEYS.HABITS, JSON.stringify(h));
    }
  }
}

// Streak
export function getStreakData(): StreakData {
  const data = localStorage.getItem(KEYS.STREAK);
  if (data) {
    const parsed = JSON.parse(data);
    return { lastBrokenStreakDate: null, ...parsed };
  }
  return {
    currentStreak: 0,
    longestStreak: 0,
    lastEntryDate: null,
    lastBrokenStreakDate: null,
    freezesAvailable: 1,
    freezesUsed: 0,
    totalEntries: 0,
  };
}

// Cap on stockpiled streak freezes
export const MAX_FREEZES = 3;
// Award 1 bonus freeze for every N badges earned
export const BADGES_PER_BONUS_FREEZE = 5;

export type StreakStatus = 'none' | 'safe' | 'at_risk' | 'recoverable' | 'lost';

/**
 * Determine the current health of the user's streak.
 * Days are 24h calendar days starting at local midnight.
 *   - none:        no streak yet
 *   - safe:        already logged today
 *   - at_risk:     last entry was yesterday — today still open, flame should warn
 *   - recoverable: last entry was 2 days ago — streak technically broken but a
 *                  freeze can save it
 *   - lost:        gap of 3+ days — freeze can no longer help
 */
export function getStreakStatus(now: Date = new Date()): StreakStatus {
  const streak = getStreakData();
  if (streak.currentStreak <= 0 || !streak.lastEntryDate) return 'none';

  const todayStr = getLocalDateString(now);
  if (streak.lastEntryDate === todayStr) return 'safe';

  // Calculate full-day gap based on local calendar dates
  const last = new Date(streak.lastEntryDate + 'T00:00:00').getTime();
  const today = new Date(todayStr + 'T00:00:00').getTime();
  const gap = Math.round((today - last) / 86400000);

  if (gap === 1) return 'at_risk';
  if (gap === 2) return 'recoverable';
  return 'lost';
}

export function updateStreak(entryDate: string): { streak: StreakData; brokenComeback: boolean } {
  const streak = getStreakData();
  const today = entryDate;
  const yesterday = addDaysLocal(today, -1);
  let brokenComeback = false;

  if (streak.lastEntryDate === today) {
    return { streak, brokenComeback };
  }

  if (streak.lastEntryDate === yesterday) {
    streak.currentStreak += 1;
  } else if (streak.lastEntryDate) {
    // Streak broke — but if we logged today after a break, that's a Comeback.
    // (Freezes are now user-controlled, so we no longer auto-consume them here.)
    if (streak.currentStreak > 0) {
      streak.lastBrokenStreakDate = streak.lastEntryDate;
      brokenComeback = true;
    }
    streak.currentStreak = 1;
  } else {
    streak.currentStreak = 1;
  }

  streak.lastEntryDate = today;
  streak.totalEntries += 1;
  streak.longestStreak = Math.max(streak.longestStreak, streak.currentStreak);

  // Earn 1 freeze every 7 consecutive streak days, capped at MAX_FREEZES
  if (
    streak.currentStreak > 0 &&
    streak.currentStreak % 7 === 0 &&
    streak.freezesAvailable < MAX_FREEZES
  ) {
    streak.freezesAvailable = Math.min(MAX_FREEZES, streak.freezesAvailable + 1);
  }

  localStorage.setItem(KEYS.STREAK, JSON.stringify(streak));
  return { streak, brokenComeback };
}

/**
 * Manually use a streak freeze. Valid in three scenarios:
 *   - safe (proactive):  protects tomorrow — user knows they'll miss it
 *   - at_risk:           protects today before midnight
 *   - recoverable:       restores a streak broken by missing exactly 1 day
 *
 * Invalid when:
 *   - no freezes available
 *   - no active streak
 *   - streak is fully lost (gap >= 3 days)
 *
 * In all valid cases the freeze advances `lastEntryDate` to today and bumps
 * the streak by 1, so the user gets credit for the day the freeze covers.
 * Returns the new streak data, or null if not applicable.
 */
export function useStreakFreeze(): { streak: StreakData; status: StreakStatus } | null {
  const status = getStreakStatus();
  if (status === 'none' || status === 'lost') return null;

  const streak = getStreakData();
  if (streak.freezesAvailable <= 0) return null;

  const today = getTodayString();

  streak.freezesAvailable -= 1;
  streak.freezesUsed += 1;

  if (status === 'safe') {
    // Proactive freeze — already logged today, freeze covers tomorrow.
    // Advance lastEntryDate to tomorrow so tomorrow won't count as a gap.
    const tomorrow = addDaysLocal(today, 1);
    streak.lastEntryDate = tomorrow;
    streak.currentStreak += 1;
  } else {
    // at_risk or recoverable — freeze covers today, keeping streak alive.
    streak.lastEntryDate = today;
    streak.currentStreak += 1;
  }

  streak.longestStreak = Math.max(streak.longestStreak, streak.currentStreak);

  localStorage.setItem(KEYS.STREAK, JSON.stringify(streak));
  return { streak, status };
}

/**
 * Grant bonus freezes based on total badges earned.
 * One bonus freeze per BADGES_PER_BONUS_FREEZE badges, capped at MAX_FREEZES.
 * Idempotent: tracks how many bonus freezes have been granted so far.
 */
const BONUS_FREEZES_GRANTED_KEY = KEYS.BONUS_FREEZES;
export function grantBadgeBonusFreezes(badges: Badge[]): StreakData {
  const earnedCount = badges.filter(b => b.earnedAt).length;
  const eligible = Math.floor(earnedCount / BADGES_PER_BONUS_FREEZE);
  const alreadyGranted = parseInt(localStorage.getItem(BONUS_FREEZES_GRANTED_KEY) || '0', 10);
  const streak = getStreakData();

  if (eligible > alreadyGranted) {
    const toGrant = eligible - alreadyGranted;
    const before = streak.freezesAvailable;
    streak.freezesAvailable = Math.min(MAX_FREEZES, streak.freezesAvailable + toGrant);
    const actuallyGranted = streak.freezesAvailable - before;
    // Record all eligible (even if capped) so we don't keep retrying capped grants
    localStorage.setItem(BONUS_FREEZES_GRANTED_KEY, String(eligible));
    if (actuallyGranted > 0) {
      localStorage.setItem(KEYS.STREAK, JSON.stringify(streak));
    }
  }
  return streak;
}

// Habit tracking
export function getHabitTracking(): HabitTracking {
  const data = localStorage.getItem(KEYS.HABITS);
  if (data) {
    const parsed = JSON.parse(data);
    return {
      punctualStreak: 0,
      lastPunctualDate: null,
      closingShopStreak: 0,
      lastClosingShopDate: null,
      weekendsCompleted: 0,
      lastWeekendKey: null,
      weekendSatLogged: null,
      weekendSunLogged: null,
      reportsViewCount: 0,
      seasonsLogged: { spring: false, summer: false, fall: false, winter: false },
      ...parsed,
    };
  }
  return {
    punctualStreak: 0,
    lastPunctualDate: null,
    closingShopStreak: 0,
    lastClosingShopDate: null,
    weekendsCompleted: 0,
    lastWeekendKey: null,
    weekendSatLogged: null,
    weekendSunLogged: null,
    reportsViewCount: 0,
    seasonsLogged: { spring: false, summer: false, fall: false, winter: false },
  };
}

function saveHabitTracking(h: HabitTracking): void {
  localStorage.setItem(KEYS.HABITS, JSON.stringify(h));
}

export function recordReportsView(): HabitTracking {
  const h = getHabitTracking();
  h.reportsViewCount += 1;
  saveHabitTracking(h);
  return h;
}

function getSeason(date: Date): 'spring' | 'summer' | 'fall' | 'winter' {
  const m = date.getMonth(); // 0-11
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'fall';
  return 'winter';
}

function getISOWeekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Update habit tracking based on a new entry being logged right now.
 * Returns the updated tracking + flags for one-shot badge unlocks.
 */
export function updateHabitTracking(entry: DailyEntry, profile: UserProfile | null): {
  habits: HabitTracking;
  earlyBird: boolean;
  turnOfMonth: boolean;
} {
  const h = getHabitTracking();
  const now = new Date();
  const hourNow = now.getHours();
  const minuteNow = now.getMinutes();
  const todayStr = getLocalDateString(now);
  const yesterdayStr = addDaysLocal(todayStr, -1);

  // --- Punctual Pro: within 30 min of work end time ---
  if (profile?.workEndTime) {
    const [endH, endM] = profile.workEndTime.split(':').map(Number);
    const endMin = endH * 60 + endM;
    const nowMin = hourNow * 60 + minuteNow;
    const diff = Math.abs(nowMin - endMin);
    if (diff <= 30 && entry.date === todayStr) {
      if (h.lastPunctualDate === yesterdayStr) h.punctualStreak += 1;
      else if (h.lastPunctualDate !== todayStr) h.punctualStreak = 1;
      h.lastPunctualDate = todayStr;
    }
  }

  // --- Closing Shop: 5pm-9pm log ---
  if (hourNow >= 17 && hourNow < 21 && entry.date === todayStr) {
    if (h.lastClosingShopDate === yesterdayStr) h.closingShopStreak += 1;
    else if (h.lastClosingShopDate !== todayStr) h.closingShopStreak = 1;
    h.lastClosingShopDate = todayStr;
  }

  // --- Early Bird: logging today's data between 6am-9am ---
  const earlyBird = hourNow >= 6 && hourNow < 9 && entry.date === todayStr;

  // --- Weekend Warrior: log Sat & Sun in same weekend ---
  const entryDate = new Date(entry.date + 'T00:00:00');
  const dow = entryDate.getDay(); // 0=Sun, 6=Sat
  if (dow === 6) h.weekendSatLogged = entry.date;
  if (dow === 0) h.weekendSunLogged = entry.date;
  if (h.weekendSatLogged && h.weekendSunLogged) {
    const sat = new Date(h.weekendSatLogged + 'T00:00:00');
    const sun = new Date(h.weekendSunLogged + 'T00:00:00');
    // Same weekend if Sun is exactly 1 day after Sat
    if ((sun.getTime() - sat.getTime()) === 86400000) {
      const weekKey = getISOWeekKey(sat);
      if (h.lastWeekendKey !== weekKey) {
        // Check if previous tracked weekend was the immediately prior week
        if (h.lastWeekendKey) {
          const prevSat = new Date(sat.getTime() - 7 * 86400000);
          if (getISOWeekKey(prevSat) === h.lastWeekendKey) {
            h.weekendsCompleted += 1;
          } else {
            h.weekendsCompleted = 1;
          }
        } else {
          h.weekendsCompleted = 1;
        }
        h.lastWeekendKey = weekKey;
      }
    }
  }

  // --- Turn of the Month: entry on last day of month + entry on first day of next month ---
  let turnOfMonth = false;
  const entryYear = entryDate.getFullYear();
  const entryMonth = entryDate.getMonth();
  const lastDayOfMonth = new Date(entryYear, entryMonth + 1, 0).getDate();
  if (entryDate.getDate() === 1) {
    // First of month — check if last day of prev month was logged
    const prevMonth = new Date(entryYear, entryMonth, 0); // last day of prev month
    const prevStr = getLocalDateString(prevMonth);
    if (getEntryForDate(prevStr)) turnOfMonth = true;
  } else if (entryDate.getDate() === lastDayOfMonth) {
    // Last day — check if first of next month is already logged (rare but possible)
    const nextFirst = getLocalDateString(new Date(entryYear, entryMonth + 1, 1));
    if (getEntryForDate(nextFirst)) turnOfMonth = true;
  }

  // --- Four Seasons ---
  const season = getSeason(entryDate);
  h.seasonsLogged[season] = true;

  saveHabitTracking(h);
  return { habits: h, earlyBird, turnOfMonth };
}

// Badges
// Each badge has only an id + icon stored. Names/descriptions come from i18n.
export const BADGE_DEFINITIONS: Badge[] = [
  // Original
  { id: 'first_entry', icon: '🌱', earnedAt: null },
  { id: 'streak_3', icon: '🔥', earnedAt: null },
  { id: 'streak_7', icon: '⭐', earnedAt: null },
  { id: 'streak_14', icon: '🏆', earnedAt: null },
  { id: 'streak_30', icon: '👑', earnedAt: null },
  { id: 'entries_10', icon: '📊', earnedAt: null },
  { id: 'entries_30', icon: '💪', earnedAt: null },
  { id: 'entries_100', icon: '🎯', earnedAt: null },
  { id: 'first_profit', icon: '💚', earnedAt: null },
  { id: 'freeze_used', icon: '🧊', earnedAt: null },
  // Habit & Routine
  { id: 'punctual_pro', icon: '⏰', earnedAt: null },
  { id: 'closing_shop', icon: '🌆', earnedAt: null },
  { id: 'early_bird', icon: '🐦', earnedAt: null },
  { id: 'weekend_warrior', icon: '🛡️', earnedAt: null },
  { id: 'turn_of_month', icon: '📅', earnedAt: null },
  // Resilience & Growth
  { id: 'comeback', icon: '💫', earnedAt: null },
  { id: 'honest_day', icon: '🔍', earnedAt: null },
  { id: 'auditor', icon: '📖', earnedAt: null },
  // Data Integrity
  { id: 'splitter', icon: '✂️', earnedAt: null },
  { id: 'swift_corrector', icon: '⚡', earnedAt: null },
  // Long-Term Engagement
  { id: 'four_seasons', icon: '🍂', earnedAt: null },
  { id: 'centurion', icon: '💯', earnedAt: null },
  // Bonus extras
  { id: 'profit_streak_7', icon: '📈', earnedAt: null },
  { id: 'big_day', icon: '🎉', earnedAt: null },
  { id: 'bounce_back', icon: '🌈', earnedAt: null },
];

export function getBadges(): Badge[] {
  const data = localStorage.getItem(KEYS.BADGES);
  if (data) {
    // Merge stored progress with current definitions (so new badges show as locked)
    const stored: Badge[] = JSON.parse(data);
    return BADGE_DEFINITIONS.map(def => {
      const found = stored.find(b => b.id === def.id);
      return found ? { ...def, earnedAt: found.earnedAt } : { ...def };
    });
  }
  return BADGE_DEFINITIONS.map(b => ({ ...b }));
}

interface AwardContext {
  entry?: DailyEntry;
  isEdit?: boolean;
  secondsSinceCreate?: number;
  earlyBird?: boolean;
  turnOfMonth?: boolean;
  brokenComeback?: boolean;
}

export function checkAndAwardBadges(
  streak: StreakData,
  context: AwardContext = {}
): Badge[] {
  const badges = getBadges();
  const habits = getHabitTracking();
  const profile = getProfile();
  const entries = getEntries();
  const newlyEarned: Badge[] = [];
  const now = new Date().toISOString();

  const tryAward = (id: string) => {
    const badge = badges.find(b => b.id === id);
    if (badge && !badge.earnedAt) {
      badge.earnedAt = now;
      newlyEarned.push(badge);
    }
  };

  const { entry, isEdit, secondsSinceCreate, earlyBird, turnOfMonth, brokenComeback } = context;

  // Original
  if (streak.totalEntries >= 1) tryAward('first_entry');
  if (streak.currentStreak >= 3) tryAward('streak_3');
  if (streak.currentStreak >= 7) tryAward('streak_7');
  if (streak.currentStreak >= 14) tryAward('streak_14');
  if (streak.currentStreak >= 30) tryAward('streak_30');
  if (streak.totalEntries >= 10) tryAward('entries_10');
  if (streak.totalEntries >= 30) tryAward('entries_30');
  if (streak.totalEntries >= 100) tryAward('entries_100');
  if (streak.freezesUsed > 0) tryAward('freeze_used');
  if (entry && entry.income > entry.expenses) tryAward('first_profit');

  // Habit & Routine
  if (habits.punctualStreak >= 7) tryAward('punctual_pro');
  if (habits.closingShopStreak >= 5) tryAward('closing_shop');
  if (earlyBird) tryAward('early_bird');
  if (habits.weekendsCompleted >= 3) tryAward('weekend_warrior');
  if (turnOfMonth) tryAward('turn_of_month');

  // Resilience & Growth
  if (brokenComeback) tryAward('comeback');
  if (entry && entry.income === 0 && entry.expenses === 0) tryAward('honest_day');
  if (entry && (entry.income - entry.expenses) < 0) tryAward('honest_day');
  if (habits.reportsViewCount >= 5) tryAward('auditor');

  // Data Integrity
  if (entry && entry.income > 0 && entry.expenses > 0) tryAward('splitter');
  if (isEdit && (secondsSinceCreate ?? Infinity) <= 600) tryAward('swift_corrector');

  // Long-Term Engagement
  const s = habits.seasonsLogged;
  if (s.spring && s.summer && s.fall && s.winter) tryAward('four_seasons');
  if (profile?.installedAt) {
    const daysSince = (Date.now() - new Date(profile.installedAt).getTime()) / 86400000;
    if (daysSince >= 100) tryAward('centurion');
  }

  // Bonus extras
  // Profit streak: last 7 entries (consecutive dates) all profitable
  if (entries.length >= 7) {
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    let profitableConsecutive = 0;
    let prevDate: string | null = null;
    for (const e of sorted) {
      if (prevDate) {
        const gap = (new Date(prevDate).getTime() - new Date(e.date).getTime()) / 86400000;
        if (gap !== 1) break;
      }
      if (e.income - e.expenses > 0) profitableConsecutive += 1;
      else break;
      prevDate = e.date;
      if (profitableConsecutive >= 7) break;
    }
    if (profitableConsecutive >= 7) tryAward('profit_streak_7');
  }

  // Big Day: today's income > 2x average of previous entries
  if (entry && entries.length >= 4) {
    const previous = entries.filter(e => e.date !== entry.date);
    if (previous.length > 0) {
      const avg = previous.reduce((s, e) => s + e.income, 0) / previous.length;
      if (avg > 0 && entry.income > avg * 2) tryAward('big_day');
    }
  }

  // Bounce Back: today profitable AND most recent prior entry was a loss
  if (entry && (entry.income - entry.expenses) > 0) {
    const priors = entries
      .filter(e => e.date < entry.date)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (priors.length > 0 && (priors[0].income - priors[0].expenses) < 0) {
      tryAward('bounce_back');
    }
  }

  localStorage.setItem(KEYS.BADGES, JSON.stringify(badges));
  return newlyEarned;
}

// Format helpers
export function getCurrencyCodeLabel(): string {
  const profile = getProfile();
  const currency = profile?.currency || 'USD';
  return currency === 'KHR'
    ? i18n.t('common.currencyCodeKHR')
    : i18n.t('common.currencyCodeUSD');
}

/**
 * Format an amount for display in the user's current profile currency.
 *
 * If `opts.entryCurrency` is provided, `amount` is interpreted as being in
 * that currency and converted to the display currency using the stored
 * exchange rate. When omitted, we fall back to `legacyCurrency` (i.e. the
 * currency that was active before the user's first-ever switch), or the
 * current display currency if no switch has ever happened.
 */
export function formatCurrency(
  amount: number,
  opts?: { entryCurrency?: 'USD' | 'KHR' },
): string {
  const profile = getProfile();
  const display = profile?.currency || 'USD';
  const from = nativeCurrencyOf(opts?.entryCurrency);
  const converted = convertAmount(amount, from, display);
  const code = getCurrencyCodeLabel();
  if (display === 'KHR') {
    return `៛${Math.round(converted).toLocaleString('en-US')} ${code}`;
  }
  return `$${converted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

/**
 * Format a value that is ALREADY in the current display currency — no
 * conversion. Use this for totals produced by sumTransactionsInDisplay /
 * getDailyDisplayTotals, which have already been converted.
 */
export function formatDisplayAmount(amount: number): string {
  const display = getProfile()?.currency || 'USD';
  const code = getCurrencyCodeLabel();
  if (display === 'KHR') {
    return `៛${Math.round(amount).toLocaleString('en-US')} ${code}`;
  }
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

/**
 * Convert-then-sum a list of transactions into the current display currency.
 * Each transaction is converted individually from its native currency so
 * days that mix USD-native and KHR-native entries total correctly.
 */
export function sumTransactionsInDisplay(
  txns: Transaction[],
): { income: number; expenses: number; profit: number } {
  const display = getProfile()?.currency || 'USD';
  let income = 0;
  let expenses = 0;
  for (const t of txns) {
    const from = nativeCurrencyOf(t.currency);
    const v = convertAmount(t.amount, from, display);
    if (t.type === 'income') income += v; else expenses += v;
  }
  return { income, expenses, profit: income - expenses };
}

/**
 * Display-currency totals for a given daily entry. Prefers per-transaction
 * data when available (so mixed-currency days total correctly); falls back
 * to converting the stored aggregate using `legacyCurrency` for legacy
 * entries with no transaction rows.
 */
export function getDailyDisplayTotals(entry: DailyEntry): { income: number; expenses: number; profit: number } {
  const txns = getTransactionsForDate(entry.date);
  if (txns.length > 0) return sumTransactionsInDisplay(txns);
  const display = getProfile()?.currency || 'USD';
  const from = nativeCurrencyOf(undefined);
  const income = convertAmount(entry.income, from, display);
  const expenses = convertAmount(entry.expenses, from, display);
  return { income, expenses, profit: income - expenses };
}

export function getTodayString(): string {
  return getLocalDateString();
}

/**
 * Update the user's currency in profile + cloud (best-effort).
 * Historical entries are NOT re-converted; their numeric values are reinterpreted.
 *
 * Returns an outcome so callers can show an accurate toast and know whether
 * the cloud actually accepted the write.
 */
export type CurrencySaveResult =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'no-session' | 'denied' | 'no-row' | 'error' };

export async function setProfileCurrency(currency: 'USD' | 'KHR'): Promise<CurrencySaveResult> {
  const profile = getProfile();
  if (!profile) return { ok: false, reason: 'no-session' };
  // Atomically write the new currency AND mark it pending so a concurrent
  // refreshProfileFromCloud cannot clobber it during the network round-trip.
  saveProfile({ ...profile, currency, settingsPendingSync: true, currencyPendingSync: true });
  const result = await pushProfileSettingsToCloud();
  return result.ok ? { ok: true } : result;
}

/**
 * Retry pushing a locally-changed currency to the cloud. Safe to call on
 * app focus / online events.
 */
export async function retryPendingCurrencySync(): Promise<void> {
  await retryPendingProfileSync();
}

/**
 * Pull the user's settings (currency, language, firstName, workEndTime,
 * syncOnWifiOnly) from the cloud and merge them into the local profile.
 * Cloud is the source of truth for these — this guards against a stale
 * localStorage profile after re-install, logout/login, or a failed save.
 */
export async function refreshProfileFromCloud(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: cloud, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .single();
    if (error || !cloud) return;
    // If the local profile is missing (cleared storage, webview eviction,
    // fresh device), REBUILD it from the cloud instead of bailing out —
    // otherwise the user is stuck with no profile and Settings can't save.
    const local: UserProfile = getProfile() ?? {
      phoneNumber: (cloud as { phone_number?: string }).phone_number ?? '',
      pin: '',
      firstName: (cloud as { first_name?: string }).first_name ?? '',
      currency: (cloud as { currency?: string }).currency === 'KHR' ? 'KHR' : 'USD',
      language: (cloud as { language?: string }).language === 'km' ? 'km' : 'en',
      workEndTime: (cloud as { work_end_time?: string }).work_end_time ?? '17:00',
      syncOnWifiOnly: true,
      setupComplete: true,
    };
    const cloudCurrency = (cloud as { currency?: string }).currency === 'KHR' ? 'KHR' : 'USD';
    const cloudLanguage = (cloud as { language?: string }).language === 'km' ? 'km' : 'en';
    // Only let local override cloud when there's an explicit unsynced
    // pending change. Otherwise trust cloud — this is the post-login /
    // post-reinstall restore path and must not perpetuate a stale local
    // value that never reached the cloud.
    const localWinsSettings = local.settingsPendingSync === true;
    const localWinsCurrency = local.currencyPendingSync === true || localWinsSettings;
    const merged: UserProfile = {
      ...local,
      firstName: localWinsSettings ? local.firstName : ((cloud as { first_name?: string }).first_name ?? local.firstName),
      phoneNumber: localWinsSettings ? local.phoneNumber : ((cloud as { phone_number?: string }).phone_number ?? local.phoneNumber),
      currency: localWinsCurrency ? local.currency : cloudCurrency,
      language: localWinsSettings ? local.language : cloudLanguage,
      workEndTime: localWinsSettings ? local.workEndTime : ((cloud as { work_end_time?: string }).work_end_time ?? local.workEndTime),
      syncOnWifiOnly: localWinsSettings ? local.syncOnWifiOnly : ((cloud as { sync_on_wifi_only?: boolean }).sync_on_wifi_only ?? local.syncOnWifiOnly),
      settingsPendingSync: localWinsSettings,
      currencyPendingSync: localWinsCurrency ? true : false,
    };
    saveProfile(merged);
    if (localWinsSettings || localWinsCurrency) {
      void retryPendingProfileSync();
    }
  } catch { /* noop — local profile remains */ }
}

/**
 * Pull all of the user's daily entries from the cloud and write them into
 * localStorage. This is the source of truth for the home chart and totals,
 * especially for accounts created before per-transaction sync existed.
 */
export async function restoreEntriesFromCloud(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from('daily_entries')
    .select('date,income,expenses,created_at,updated_at')
    .eq('user_id', user.id);
  if (error || !data) return;
  if (data.length === 0) {
    // Never push another account's leftover ledger into this account.
    if (localDataBelongsToOtherAccount(user.id)) return;
    const localEntries = getEntries();
    for (const entry of localEntries) enqueueSyncOp({ kind: 'entry', entry });
    flushSyncQueue();
    return;
  }

  const cloud: DailyEntry[] = data.map((r) => ({
    date: r.date as string,
    income: Number(r.income) || 0,
    expenses: Number(r.expenses) || 0,
    createdAt: (r.created_at as string) || new Date().toISOString(),
    updatedAt: (r.updated_at as string) || undefined,
  }));

  // Merge every known daily log; the newest copy wins if the same date exists locally and in cloud.
  const local = getEntries();
  const merged = mergeEntriesPreferNewest(local, cloud);
  persistEntries(merged);
  queueMissingEntriesForCloud(local, merged);
  flushSyncQueue();
  patchSyncStatus({
    lastSyncAt: new Date().toISOString(),
    lastEntriesRestored: merged.length,
  });
}

export type LogoutResult = { ok: true } | { ok: false; reason: 'not-authenticated' | 'backup-failed' };

/** Upload and verify a complete local ledger before allowing destructive logout. */
async function backupAndVerifyBeforeLogout(): Promise<boolean> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return false;
  // Local data belongs to a different account: nothing of this user's to back
  // up, and uploading it would contaminate their cloud history.
  if (localDataBelongsToOtherAccount(user.id)) return true;



  const profile = getProfile();
  if (profile?.phoneNumber) {
    const rates = getCurrencyRates();
    const { error } = await supabase.from('profiles').upsert({
      user_id: user.id,
      phone_number: profile.phoneNumber,
      first_name: profile.firstName || null,
      currency: profile.currency,
      language: profile.language,
      work_end_time: profile.workEndTime,
      sync_on_wifi_only: profile.syncOnWifiOnly,
      khr_per_usd: rates.khrPerUsd,
      legacy_currency: rates.legacyCurrency,
    }, { onConflict: 'user_id' });
    if (error) return false;
  }

  const entries = getEntries();
  if (entries.length > 0) {
    const { error } = await supabase.from('daily_entries').upsert(entries.map(entry => ({
      user_id: user.id,
      date: entry.date,
      income: entry.income,
      expenses: entry.expenses,
      
    })), { onConflict: 'user_id,date' });
    if (error) return false;
  }

  const transactions = getTransactions();
  for (let start = 0; start < transactions.length; start += 200) {
    const batch = transactions.slice(start, start + 200);
    const { error } = await supabase.from('transactions').upsert(batch.map(txn => ({
      id: txn.id,
      user_id: user.id,
      date: txn.date,
      type: txn.type,
      amount: txn.amount,
      note: txn.note ?? null,
      created_at: txn.createdAt,
      currency: txn.currency ?? null,
    })), { onConflict: 'id' });
    if (error) return false;
  }

  const streak = getStreakData();
  const badges = getBadges();
  const habits = getHabitTracking();
  const { error: statsError } = await supabase.from('user_stats').upsert({
    user_id: user.id,
    total_entries: streak.totalEntries,
    current_streak: streak.currentStreak,
    longest_streak: streak.longestStreak,
    last_entry_date: streak.lastEntryDate,
    freezes_available: streak.freezesAvailable,
    freezes_used: streak.freezesUsed,
    last_broken_streak_date: streak.lastBrokenStreakDate,
    bonus_freezes_granted: parseInt(localStorage.getItem(KEYS.BONUS_FREEZES) || '0', 10),
    badges_earned: badges.filter(b => b.earnedAt).map(b => ({ id: b.id, icon: b.icon, earnedAt: b.earnedAt })),
    habit_tracking: habits as unknown as Json,
  }, { onConflict: 'user_id' });
  if (statsError) return false;

  const [{ count: entryCount, error: entryCheckError }, { count: txnCount, error: txnCheckError }] = await Promise.all([
    supabase.from('daily_entries').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
  ]);
  return !entryCheckError && !txnCheckError && (entryCount ?? 0) >= entries.length && (txnCount ?? 0) >= transactions.length;
}

/**
 * Logout is destructive, so it is allowed only after a complete local backup
 * has been uploaded and its record counts have been verified in the cloud.
 */
export async function logout(): Promise<LogoutResult> {
  let verified = false;
  try {
    verified = await backupAndVerifyBeforeLogout();
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'backup-failed' };

  const { error } = await supabase.auth.signOut();
  if (error) return { ok: false, reason: 'not-authenticated' };

  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('biz_')) localStorage.removeItem(k);
  }
  return { ok: true };
}
