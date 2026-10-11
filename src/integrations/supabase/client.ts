// Disconnected showcase adapter. There is no SDK, URL, credential, session
// store or network implementation, and no environment switch to restore one.
const denied = { message: 'Cloud access is unavailable in this fictional showcase.', code: 'SHOWCASE_OFFLINE' };
// Match the retained dynamic query facade for legacy call sites; runtime data
// is always null, as enforced below and by the adapter regression checks.
type OfflineResult = { data: any; error: typeof denied; count: null };
interface OfflineQuery extends PromiseLike<OfflineResult> {
  select(...args: unknown[]): OfflineQuery;
  eq(...args: unknown[]): OfflineQuery;
  upsert(...args: unknown[]): OfflineQuery;
  update(...args: unknown[]): OfflineQuery;
  delete(...args: unknown[]): OfflineQuery;
  maybeSingle(...args: unknown[]): OfflineQuery;
  single(...args: unknown[]): OfflineQuery;
}
function query(): OfflineQuery {
  return new Proxy({}, { get(_target, key) {
    if (key === 'then') return (resolve: (value: unknown) => void) => resolve({ data: null, error: denied, count: null });
    return () => query();
  }}) as OfflineQuery;
}
export const supabase = {
  auth: {
    async getUser() { return { data: { user: null }, error: null }; },
    async getSession() { return { data: { session: null }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from: (_table: string) => query(),
  functions: { async invoke() { return { data: null, error: denied }; } },
};
