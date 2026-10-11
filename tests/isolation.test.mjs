import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
function load(relative, bindings = {}) {
  const compiledModule = {exports:{}};
  const text = ts.transpileModule(readFileSync(resolve(root, relative), 'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  runInNewContext(text, {module:compiledModule,exports:compiledModule.exports,...bindings});
  return compiledModule.exports;
}
const { MemoryStorage, activateShowcaseStorage, seedFictionalData } = load('src/showcase/bootstrap.ts');
const { supabase } = load('src/integrations/supabase/client.ts');
const { csvCell } = load('src/showcase/csv.ts');

function fictionalLedger() {
  const store = new MemoryStorage();
  seedFictionalData(store, new Date('2026-10-10T12:00:00Z'));
  const ledger = load('src/lib/storage.ts', {
    localStorage:store,
    require(id) {
      if (id === '@/integrations/supabase/client') return {supabase};
      if (id === '@/i18n') return {default:{t:key=>key}};
      throw new Error(`Unexpected dependency: ${id}`);
    },
    setTimeout(callback, ms) { const timer = setTimeout(callback,ms); timer.unref(); return timer; },
    clearTimeout,
  });
  return {store,ledger};
}

function dailyTotals(ledger,date) {
  const entry = ledger.getEntries().find(row=>row.date===date);
  assert.ok(entry,`Missing fictional daily entry ${date}`);
  return ledger.getDailyDisplayTotals(entry);
}

test('real ledger mutations recompute daily totals and preserve unrelated invented records', () => {
  const {store,ledger} = fictionalLedger(), date = '2026-10-10';
  const unrelated = ledger.getTransactionsForDate('2026-10-09');
  const added = ledger.addTransaction('income',12500,'  Fictional extra sale  ',date);
  assert.equal(added.note,'Fictional extra sale'); assert.equal(added.currency,'KHR');
  assert.equal(dailyTotals(ledger,date).income,172500);
  assert.equal(ledger.updateTransaction(added.id,20000,'Revised fictional sale').amount,20000);
  assert.equal(dailyTotals(ledger,date).income,180000);
  ledger.deleteTransaction(added.id);
  assert.equal(dailyTotals(ledger,date).income,160000);
  assert.equal(JSON.stringify(ledger.getTransactionsForDate('2026-10-09')),JSON.stringify(unrelated));
  const before = store.getItem('biz_transactions');
  assert.equal(ledger.updateTransaction('missing',10),null);
  ledger.deleteTransaction('missing'); assert.equal(store.getItem('biz_transactions'),before);
});

test('real display conversion preserves native rows across KHR/USD switching', () => {
  const {store,ledger} = fictionalLedger(), date='2026-10-10';
  const before = store.getItem('biz_transactions');
  const profile = ledger.getProfile(); ledger.recordCurrencySwitch('KHR',4000);
  ledger.saveProfile({...profile,currency:'USD'});
  assert.equal(dailyTotals(ledger,date).income,40);
  assert.equal(dailyTotals(ledger,date).expenses,11.25);
  assert.equal(store.getItem('biz_transactions'),before);
  const usd = ledger.addTransaction('income',2.5,'Fictional USD sale',date);
  assert.equal(usd.currency,'USD'); assert.equal(dailyTotals(ledger,date).income,42.5);
  ledger.recordCurrencySwitch('USD',4000); ledger.saveProfile({...profile,currency:'KHR'});
  assert.equal(dailyTotals(ledger,date).income,170000);
});

test('real amount sanitization rejects invalid values and bounds fictional inputs', () => {
  const {ledger} = fictionalLedger();
  for (const value of [NaN,Infinity,-1]) assert.equal(ledger.sanitizeAmount(value),0);
  assert.equal(ledger.sanitizeAmount(1.239),1.24);
  assert.equal(ledger.sanitizeAmount(ledger.MAX_AMOUNT_KHR+1),ledger.MAX_AMOUNT_KHR);
});

test('bootstrap never reads existing browser storage and seeds only invented data', () => {
  let reads = 0;
  const host = {};
  Object.defineProperty(host, 'localStorage', {configurable:true,get(){ reads++; throw new Error('private storage must not be read'); }});
  const store = activateShowcaseStorage(host, new Date('2026-10-10T12:00:00Z'));
  assert.equal(reads, 0);
  assert.equal(host.localStorage, store);
  const profile = JSON.parse(store.getItem('biz_profile'));
  assert.equal(profile.phoneNumber, ''); assert.equal(profile.pin, '');
  assert.equal(profile.firstName, 'Demo Vendor');
  assert.equal(JSON.parse(store.getItem('biz_transactions')).length, 28);
});

test('unsupported storage isolation fails instead of falling back to real storage', () => {
  const host = {};
  Object.defineProperty(host, 'localStorage', {configurable:false,value:{private:'do not read'}});
  assert.throws(() => activateShowcaseStorage(host));
});

test('fictional ledgers are deterministic and isolated between sessions', () => {
  const now = new Date('2026-10-10T12:00:00Z'), first = new MemoryStorage(), second = new MemoryStorage();
  seedFictionalData(first, now); seedFictionalData(second, now);
  assert.equal(first.getItem('biz_transactions'),second.getItem('biz_transactions'));
  first.setItem('biz_transactions','[]');
  assert.equal(JSON.parse(second.getItem('biz_transactions')).length,28);
});

test('invented daily totals match their transaction rows', () => {
  const store = new MemoryStorage(); seedFictionalData(store,new Date('2026-10-10T12:00:00Z'));
  const entries = JSON.parse(store.getItem('biz_entries')), transactions = JSON.parse(store.getItem('biz_transactions'));
  for (const row of entries) {
    const daily = transactions.filter(t => t.date === row.date);
    assert.equal(daily.filter(t=>t.type==='income').reduce((sum,t)=>sum+t.amount,0),row.income);
    assert.equal(daily.filter(t=>t.type==='expense').reduce((sum,t)=>sum+t.amount,0),row.expenses);
  }
});

test('backend adapter exposes no user/session and denies every query/write/function', async () => {
  assert.equal((await supabase.auth.getUser()).data.user,null);
  assert.equal((await supabase.auth.getSession()).data.session,null);
  for (const operation of [
    supabase.from('profiles').select('*').eq('user_id','invented').maybeSingle(),
    supabase.from('transactions').upsert({id:'invented'}),
    supabase.from('profiles').delete().eq('user_id','invented'),
    supabase.functions.invoke('reset-pin',{body:{}}),
  ]) {
    const result = await operation;
    assert.equal(result.data,null); assert.equal(result.error.code,'SHOWCASE_OFFLINE');
  }
});

test('CSV escapes multiline text/quotes and neutralizes text formulas', () => {
  assert.equal(csvCell('a,"b"\nc'),'"a,""b""\nc"');
  for (const text of ['=2+2','  +CMD','\t@SUM(A1)','-not-a-number']) assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell(-12.5),'"-12.5"');
});

test('selected source and production entry exclude SDK, native, auth/admin routes and network implementations', () => {
  const files = [];
  function walk(directory) { for(const entry of readdirSync(directory,{withFileTypes:true})) {
    const path = resolve(directory,entry.name); if(entry.isDirectory()) walk(path); else files.push(path);
  }}
  walk(resolve(root,'src'));
  const text = files.map(path=>readFileSync(path,'utf8')).join('\n');
  assert.doesNotMatch(text, /@supabase\/supabase-js|@capacitor|fetch\s*\(|XMLHttpRequest|WebSocket|\.supabase\.(?:co|in)|import\.meta\.env/);
  const app = readFileSync(resolve(root,'src/App.tsx'),'utf8');
  assert.doesNotMatch(app, /Admin|Login|ForgotPin|Onboarding|DeleteAccount/);
  const html = readFileSync(resolve(root,'index.html'),'utf8');
  assert.match(html, /connect-src 'none'/);
});
