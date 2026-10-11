import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { km, enUS } from "date-fns/locale";
import {
  syncEntryToCloud,
  syncStatsToCloud,
  getTodayString,
  updateStreak,
  getStreakData,
  getStreakStatus,
  checkAndAwardBadges,
  getBadges,
  getProfile,
  refreshProfileFromCloud,
  updateHabitTracking,
  grantBadgeBonusFreezes,
  formatCurrency,
  formatDisplayAmount,
  getCurrencyCodeLabel,
  sanitizeAmount,
  getMaxAmount,
  getEntryForDate,
  getTransactionsForDate,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  sumTransactionsInDisplay,
  type StreakData,
  type StreakStatus,
  type Badge,
  type Transaction,
  type TransactionType,
} from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import BottomNav from "@/components/BottomNav";
import BackupHealthBanner, { BackupHealthBadge } from "@/components/BackupHealthBanner";

import BadgeToast from "@/components/BadgeToast";
import UseFreezeDialog from "@/components/UseFreezeDialog";
import { toast } from "@/hooks/use-toast";
import { Plus, Minus, Pencil, Trash2, ChevronLeft, ChevronRight, CalendarIcon } from "lucide-react";
import { addDaysLocal, getLocalDateString } from "@/lib/storage";
import { cn } from "@/lib/utils";

const Home = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const today = getTodayString();
  const maxAmount = getMaxAmount();

  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isToday = selectedDate === today;
  const [txns, setTxns] = useState<Transaction[]>(() => getTransactionsForDate(today));
  const [streak, setStreak] = useState<StreakData>(getStreakData());
  const [streakStatus, setStreakStatus] = useState<StreakStatus>(getStreakStatus());
  const [newBadges, setNewBadges] = useState<Badge[]>([]);
  const [freezeDialogOpen, setFreezeDialogOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  // Add/edit transaction dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogType, setDialogType] = useState<TransactionType>("income");
  const [dialogAmount, setDialogAmount] = useState("");
  const [dialogNote, setDialogNote] = useState("");
  const [dialogDate, setDialogDate] = useState<string>(today);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCurrency, setEditingCurrency] = useState<"USD" | "KHR" | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    setStreakStatus(getStreakStatus());
  }, [today]);

  // Pull latest settings (currency, language) from cloud on mount so a
  // re-login or stale local profile can't show the wrong currency symbol.
  const [, forceRender] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const before = getProfile();
      await refreshProfileFromCloud();
      const after = getProfile();
      if (!cancelled && before?.currency !== after?.currency) {
        forceRender(n => n + 1);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setTxns(getTransactionsForDate(selectedDate));
  }, [selectedDate]);

  const refresh = () => {
    setTxns(getTransactionsForDate(selectedDate));
  };

  const totals = useMemo(() => sumTransactionsInDisplay(txns), [txns]);

  const currencyCode = getCurrencyCodeLabel();

  const sanitizeInputString = (raw: string): string => {
    // Accept comma as decimal separator (Khmer/EU keyboards) and normalize to '.'
    let cleaned = (raw || "").replace(/,/g, ".").replace(/[^\d.]/g, "");
    const firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    }
    const n = parseFloat(cleaned);
    if (Number.isFinite(n) && n > maxAmount) return String(maxAmount);
    return cleaned;
  };

  const openAdd = (type: TransactionType) => {
    setDialogType(type);
    setDialogAmount("");
    setDialogNote("");
    setDialogDate(selectedDate);
    setEditingId(null);
    setEditingCurrency(null);
    setDialogOpen(true);
  };

  const openEdit = (txn: Transaction) => {
    setDialogType(txn.type);
    setDialogAmount(String(txn.amount));
    setDialogNote(txn.note || "");
    setDialogDate(txn.date);
    setEditingId(txn.id);
    setEditingCurrency(txn.currency ?? null);
    setDialogOpen(true);
  };

  const commitPipeline = (date: string) => {
    // Sync the (recomputed) daily entry to cloud regardless of date.
    const entry = getEntryForDate(date);
    if (entry) syncEntryToCloud(entry);

    // Streak/badges/habit pipeline only fires for TODAY — editing past
    // days shouldn't retroactively change streaks.
    if (date !== today) return;

    const { streak: updatedStreak, brokenComeback } = updateStreak(today);
    setStreak(updatedStreak);

    const { earlyBird, turnOfMonth } = updateHabitTracking(entry!, getProfile());
    const earned = checkAndAwardBadges(updatedStreak, {
      entry: entry!,
      isEdit: false,
      secondsSinceCreate: 0,
      earlyBird,
      turnOfMonth,
      brokenComeback,
    });
    if (earned.length > 0) setNewBadges(earned);

    const afterBonus = grantBadgeBonusFreezes(getBadges());
    setStreak(afterBonus);
    setStreakStatus(getStreakStatus());

    syncStatsToCloud(afterBonus, getBadges());
  };

  const handleSaveDialog = () => {
    if (savingRef.current) return;
    const amount = sanitizeAmount(parseFloat(dialogAmount) || 0);
    if (amount <= 0) return;
    savingRef.current = true;
    try {
      let affectedDate = dialogDate;
      if (editingId) {
        const existing = txns.find(t => t.id === editingId);
        if (existing && existing.date !== dialogDate) {
          // Date changed — move the transaction by deleting and re-adding
          deleteTransaction(editingId);
          addTransaction(dialogType, amount, dialogNote.trim() || undefined, dialogDate);
          if (existing.date !== dialogDate) commitPipeline(existing.date);
        } else {
          updateTransaction(editingId, amount, dialogNote.trim() || undefined);
          affectedDate = existing?.date || dialogDate;
        }
      } else {
        addTransaction(dialogType, amount, dialogNote.trim() || undefined, dialogDate);
      }
      // Jump the page to the date we just saved into so user sees it
      setSelectedDate(affectedDate);
      setTxns(getTransactionsForDate(affectedDate));
      commitPipeline(affectedDate);
      setDialogOpen(false);
    } finally {
      setTimeout(() => { savingRef.current = false; }, 300);
    }
  };

  const handleDelete = (id: string) => {
    if (!confirm(t("home.confirmDelete"))) return;
    deleteTransaction(id);
    refresh();
    commitPipeline(selectedDate);
  };

  const handleFreezeBannerClick = () => {
    if (streakStatus === "none") {
      toast({ title: t("badges.freezeNoStreakTitle"), description: t("badges.freezeNoStreakDesc") });
      return;
    }
    if (streakStatus === "lost") {
      toast({ title: t("badges.freezeLostTitle"), description: t("badges.freezeLostDesc") });
      return;
    }
    setFreezeDialogOpen(true);
  };

  const handleFreezeUsed = (s: StreakData) => {
    setStreak(s);
    setStreakStatus(getStreakStatus());
  };

  const flameRed = streakStatus === "at_risk" || streakStatus === "recoverable";

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    const locale = i18n.language === "km" ? "km-KH" : "en-US";
    return d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const locale = i18n.language === "km" ? "km-KH" : "en-US";
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div className="min-h-screen flex flex-col bg-background pb-24">
      <div className="px-6 pt-8 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-foreground">
              {isToday ? t("home.today") : formatDate(selectedDate).split(",")[0]}
            </h1>
            <p className="text-muted-foreground text-sm">{formatDate(selectedDate)}</p>
            <div className="mt-2">
              <BackupHealthBadge />
            </div>
          </div>
          <button
            onClick={() => navigate("/badges")}
            className={`flex items-center gap-2 px-4 py-2 rounded-full active:scale-[0.97] transition-transform ${
              flameRed ? "bg-destructive/15 ring-2 ring-destructive/40" : "bg-streak/10"
            }`}
          >
            <span className={`text-2xl ${streak.currentStreak > 0 ? "animate-streak-pulse" : ""}`}>
              {flameRed ? "🥶" : "🔥"}
            </span>
            <span className={`font-bold ${flameRed ? "text-destructive" : "text-streak-foreground"}`}>
              {streak.currentStreak}
            </span>
          </button>
        </div>
      </div>

      <BackupHealthBanner />



      {/* Date navigator: jump to previous/next day to edit past entries */}
      <div className="px-6 mb-4">
        <div className="flex items-center justify-between bg-muted/50 rounded-full p-1 gap-2">
          <button
            onClick={() => setSelectedDate(addDaysLocal(selectedDate, -1))}
            className="h-9 w-9 flex items-center justify-center rounded-full hover:bg-muted active:scale-[0.95] transition-transform"
            aria-label="Previous day"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => setSelectedDate(today)}
            disabled={isToday}
            className="flex-1 text-sm font-semibold text-center disabled:opacity-80 truncate"
          >
            {isToday ? formatDate(today) : `${formatDate(selectedDate)} • ${t("home.today")} ↩`}
          </button>
          <button
            onClick={() => !isToday && setSelectedDate(addDaysLocal(selectedDate, 1))}
            disabled={isToday}
            className="h-9 w-9 flex items-center justify-center rounded-full hover:bg-muted active:scale-[0.95] transition-transform disabled:opacity-40"
            aria-label="Next day"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>



      {flameRed && (
        <div className="px-6 mb-3">
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-2 text-sm text-destructive font-medium text-center">
            ⚠️ {streakStatus === "at_risk" ? t("badges.streakAtRisk") : t("badges.streakRecoverable")}
          </div>
        </div>
      )}

      {streak.freezesAvailable > 0 && (
        <div className="px-6 mb-4">
          <button
            onClick={handleFreezeBannerClick}
            className="w-full bg-streak/10 border border-streak/20 rounded-lg px-4 py-2 flex items-center gap-2 text-sm active:scale-[0.99] transition-transform"
          >
            <span>🧊</span>
            <span className="text-streak-foreground font-medium">
              {t("home.freezesAvailable", { count: streak.freezesAvailable })}
            </span>
          </button>
        </div>
      )}

      <div className="px-6 flex-1 space-y-5">
        {/* Main card */}
        <div className="bg-card rounded-3xl p-5 shadow-sm shadow-black/5 space-y-5 animate-fade-up">
          {/* Totals row */}
          <div className="grid grid-cols-3 gap-2 pb-4 border-b border-border/60">
            {[
              { emoji: "💰", label: t("home.income"), value: totals.income, color: "text-foreground" },
              { emoji: "💸", label: t("home.expenses"), value: totals.expenses, color: "text-foreground" },
              { emoji: "🐷", label: t("home.profit"), value: totals.profit, color: totals.profit >= 0 ? "text-foreground" : "text-destructive" },
            ].map((it, idx) => (
              <div key={idx} className={`text-center ${idx === 1 ? "border-x border-border/60" : ""}`}>
                <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground mb-1">
                  <span>{it.emoji}</span><span className="truncate">{it.label}</span>
                </div>
                <div className="flex items-baseline justify-center gap-1 flex-wrap">
                  <span className={`text-lg font-extrabold ${it.color}`}>{formatDisplayAmount(it.value)}</span>
                  <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{currencyCode}</span>
                </div>
              </div>
            ))}
          </div>

          {/* See log pill */}
          <div className="flex justify-center">
            <button
              onClick={() => setLogOpen(true)}
              className="bg-muted text-muted-foreground hover:bg-muted/80 px-5 py-2 rounded-full text-sm font-medium active:scale-[0.97] transition-transform"
            >
              {t("home.viewTodayLog")}
            </button>
          </div>

          {/* Stacked add buttons */}
          <div className="space-y-3">
            <Button
              onClick={() => openAdd("income")}
              className="w-full h-16 rounded-2xl text-lg font-bold bg-success hover:bg-success/90 text-success-foreground active:scale-[0.99] transition-transform"
            >
              <span className="text-2xl mr-1">💰</span>
              {t("home.addIncome")}
            </Button>
            <Button
              onClick={() => openAdd("expense")}
              className="w-full h-16 rounded-2xl text-lg font-bold bg-success hover:bg-success/90 text-success-foreground active:scale-[0.99] transition-transform"
            >
              <span className="text-2xl mr-1">💸</span>
              {t("home.addExpense")}
            </Button>
          </div>
        </div>
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle className="text-center text-2xl">
              {editingId ? `${t("home.edit")} ` : ""}{dialogType === "income" ? t("home.addIncome") : t("home.addExpense")}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <Label htmlFor="txn-amount" className="sr-only">{t("home.amount")}</Label>
            <div className="relative">
              <Input
                id="txn-amount"
                type="text"
                inputMode="decimal"
                pattern="[0-9]*[.,]?[0-9]*"
                autoFocus
                placeholder="0"
                value={dialogAmount}
                onChange={(e) => setDialogAmount(sanitizeInputString(e.target.value))}
                className="h-16 text-2xl text-center font-bold rounded-2xl pr-16"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {editingCurrency
                  ? (editingCurrency === "KHR" ? t("common.currencyCodeKHR") : t("common.currencyCodeUSD"))
                  : currencyCode}
              </span>
            </div>
            {editingCurrency && editingCurrency !== (getProfile()?.currency || "USD") && (
              <p className="text-[11px] text-muted-foreground text-center italic">
                {t("home.editingInNativeCurrency", { currency: editingCurrency === "KHR" ? t("common.currencyCodeKHR") : t("common.currencyCodeUSD") })}
              </p>
            )}
            <Textarea
              id="txn-note"
              placeholder={t("home.notePlaceholder")}
              value={dialogNote}
              onChange={(e) => setDialogNote(e.target.value)}
              className="min-h-[80px] rounded-2xl text-sm"
            />
            {/* Date picker — defaults to selected day, lets user backdate */}
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "w-full h-12 justify-start text-left font-medium rounded-2xl",
                  )}
                >
                  <CalendarIcon className="w-4 h-4 mr-2" />
                  {dialogDate === today ? t("home.today") : ""}{dialogDate === today ? " · " : ""}{formatDate(dialogDate)}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  locale={i18n.language === "km" ? km : enUS}
                  selected={new Date(dialogDate + "T00:00:00")}
                  onSelect={(d) => {
                    if (d) {
                      setDialogDate(getLocalDateString(d));
                      setDatePickerOpen(false);
                    }
                  }}
                  disabled={(d) => d > new Date()}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button
              onClick={handleSaveDialog}
              disabled={!dialogAmount || parseFloat(dialogAmount) <= 0}
              className="w-full h-14 rounded-2xl text-lg font-bold bg-success hover:bg-success/90 text-success-foreground"
            >
              <span className="text-xl mr-1">💰</span>
              {t("home.save_short")}
            </Button>
            {editingId && (
              <Button variant="ghost" onClick={() => { const id = editingId; setDialogOpen(false); handleDelete(id); }} className="text-destructive">
                <Trash2 className="w-4 h-4 mr-1" />{t("home.delete")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Today's log sheet — numbered table */}
      <Sheet open={logOpen} onOpenChange={setLogOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
          <SheetHeader>
            <SheetTitle>{t("home.todayLogTitle")}</SheetTitle>
          </SheetHeader>
          {txns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">{t("home.noTransactionsToday")}</p>
          ) : (
            <>
              <div className="mt-4 rounded-2xl border border-border overflow-hidden bg-card">
                <div className="grid grid-cols-[48px_1fr_1fr] bg-muted/50">
                  <div></div>
                  <div className="py-3 text-center font-bold">{t("home.incomeCol")} 💰</div>
                  <div className="py-3 text-center font-bold">{t("home.expensesCol")} 💸</div>
                </div>
                {txns.map((txn, i) => (
                  <button
                    key={txn.id}
                    onClick={() => { setLogOpen(false); openEdit(txn); }}
                    className="w-full grid grid-cols-[48px_1fr_1fr] border-t border-border text-left active:bg-muted/40"
                  >
                    <div className="py-3 text-center text-sm font-bold text-muted-foreground">#{i + 1}</div>
                    <div className="py-3 px-2">
                      <div className={`font-semibold text-center ${txn.type === "income" ? "" : "opacity-40"}`}>
                        {txn.type === "income" ? formatCurrency(txn.amount, { entryCurrency: txn.currency }) : "—"}
                      </div>
                      {txn.note && (
                        <div className="text-[11px] text-muted-foreground text-center truncate mt-0.5">{txn.note}</div>
                      )}
                    </div>
                    <div className="py-3 px-2">
                      <div className={`font-semibold text-center ${txn.type === "expense" ? "" : "opacity-40"}`}>
                        {txn.type === "expense" ? formatCurrency(txn.amount, { entryCurrency: txn.currency }) : "—"}
                      </div>
                      {txn.note && (
                        <div className="text-[11px] text-muted-foreground text-center truncate mt-0.5">{txn.note}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                {[
                  { emoji: "💰", label: t("home.totalIncome"), value: totals.income },
                  { emoji: "💸", label: t("home.totalExpenses"), value: totals.expenses },
                  { emoji: "🐷", label: t("home.profit"), value: totals.profit },
                ].map((it, i) => (
                  <div key={i} className="bg-card border border-border rounded-2xl p-3 text-center">
                    <div className="text-2xl">{it.emoji}</div>
                    <div className="text-xs text-muted-foreground mt-1">{it.label}</div>
                    <div className="text-xl font-extrabold mt-1">{formatDisplayAmount(it.value)}</div>
                    <div className="text-xs font-bold text-muted-foreground">{currencyCode}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground text-center mt-3">{t("home.edit")} / {t("home.delete")}: tap a row</p>
            </>
          )}
        </SheetContent>
      </Sheet>

      {newBadges.length > 0 && (
        <BadgeToast badges={newBadges} onClose={() => setNewBadges([])} />
      )}

      <UseFreezeDialog
        open={freezeDialogOpen}
        onOpenChange={setFreezeDialogOpen}
        onUsed={handleFreezeUsed}
      />

      <BottomNav />
    </div>
  );
};

export default Home;
