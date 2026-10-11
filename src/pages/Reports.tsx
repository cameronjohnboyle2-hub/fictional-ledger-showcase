import { useState, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { km, enUS } from "date-fns/locale";
import {
  getEntries,
  formatCurrency,
  formatDisplayAmount,
  recordReportsView,
  checkAndAwardBadges,
  getStreakData,
  getTransactionsForDate,
  updateTransaction,
  deleteTransaction,
  addTransaction,
  getLocalDateString,
  sanitizeAmount,
  getMaxAmount,
  getCurrencyCodeLabel,
  getProfile,
  syncEntryToCloud,
  syncStatsToCloud,
  getBadges,
  getDailyDisplayTotals,
  sumTransactionsInDisplay,
  type DailyEntry,
  type Badge,
  type Transaction,
  type TransactionType,
} from "@/lib/storage";
import BadgeToast from "@/components/BadgeToast";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import BottomNav from "@/components/BottomNav";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Pencil, Trash2, CalendarIcon, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import ExportDataDialog from "@/components/ExportDataDialog";

type TimeRange = "7d" | "30d" | "90d" | "12m" | "custom";
type Aggregation = "day" | "week" | "month";

function getStartDate(range: Exclude<TimeRange, "custom">): Date {
  const now = new Date();
  switch (range) {
    case "7d": return new Date(now.getTime() - 7 * 86400000);
    case "30d": return new Date(now.getTime() - 30 * 86400000);
    case "90d": return new Date(now.getTime() - 90 * 86400000);
    case "12m": return new Date(now.getTime() - 365 * 86400000);
  }
}

function getWeekKey(date: string): string {
  const d = new Date(date + "T00:00:00");
  const startOfWeek = new Date(d);
  startOfWeek.setDate(d.getDate() - d.getDay());
  return startOfWeek.toISOString().split("T")[0];
}

function getMonthKey(date: string): string {
  return date.substring(0, 7);
}

type ConvertedEntry = { date: string; income: number; expenses: number };

function aggregateEntries(entries: ConvertedEntry[], agg: Aggregation) {
  const grouped: Record<string, { income: number; expenses: number; profit: number }> = {};

  entries.forEach((e) => {
    const key =
      agg === "day" ? e.date :
      agg === "week" ? getWeekKey(e.date) :
      getMonthKey(e.date);

    if (!grouped[key]) grouped[key] = { income: 0, expenses: 0, profit: 0 };
    grouped[key].income += e.income;
    grouped[key].expenses += e.expenses;
    grouped[key].profit += e.income - e.expenses;
  });

  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, data]) => ({
      label:
        agg === "month"
          ? new Date(key + "-01T00:00:00").toLocaleDateString(
              i18n.language === "km" ? "km-KH" : "en-US",
              { month: "short", year: "numeric" }
            )
          : key.substring(5),
      ...data,
    }));
}

const Reports = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<TimeRange>("30d");
  const [agg, setAgg] = useState<Aggregation>("day");
  const [newBadges, setNewBadges] = useState<Badge[]>([]);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [openTxns, setOpenTxns] = useState<Transaction[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);


  // Custom range state — defaults to the last 30 days
  const [customFrom, setCustomFrom] = useState<Date>(() => new Date(Date.now() - 30 * 86400000));
  const [customTo, setCustomTo] = useState<Date>(() => new Date());
  const [fromPickerOpen, setFromPickerOpen] = useState(false);
  const [toPickerOpen, setToPickerOpen] = useState(false);

  useEffect(() => {
    // Track that the user opened reports — for the Auditor badge
    recordReportsView();
    const earned = checkAndAwardBadges(getStreakData(), {});
    if (earned.length > 0) setNewBadges(earned);
    // Persist habit-tracking (Auditor count) + any new badges to the cloud
    syncStatsToCloud(getStreakData(), getBadges());
  }, []);

  const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
    { value: "7d", label: t("reports.range7d") },
    { value: "30d", label: t("reports.range30d") },
    { value: "90d", label: t("reports.range90d") },
    { value: "12m", label: t("reports.range12m") },
    { value: "custom", label: t("reports.rangeCustom") },
  ];

  const AGG_OPTIONS: { value: Aggregation; label: string }[] = [
    { value: "day", label: t("reports.aggDay") },
    { value: "week", label: t("reports.aggWeek") },
    { value: "month", label: t("reports.aggMonth") },
  ];

  // Compute the [start, end] window for filtering entries.
  // Returns nulls to mean "unbounded".
  const { startDate, endDate } = useMemo(() => {
    if (range === "custom") {
      const from = new Date(customFrom);
      from.setHours(0, 0, 0, 0);
      const to = new Date(customTo);
      to.setHours(23, 59, 59, 999);
      return { startDate: from, endDate: to };
    }
    return { startDate: getStartDate(range), endDate: null as Date | null };
  }, [range, customFrom, customTo]);

  const inRange = (dateStr: string) => {
    // Month aggregation shows all history so users can see every past month
    // regardless of the selected range.
    if (agg === "month") return true;
    const d = new Date(dateStr + "T00:00:00");
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  };

  const chartData = useMemo(() => {
    const allEntries = getEntries();
    const filtered = allEntries
      .filter((e) => inRange(e.date))
      .map((e) => {
        const t = getDailyDisplayTotals(e);
        return { date: e.date, income: t.income, expenses: t.expenses };
      });
    return aggregateEntries(filtered, agg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, agg, customFrom, customTo, refreshKey]);

  // Daily detail list (always grouped by day regardless of chart aggregation)
  const dailyList = useMemo(() => {
    const allEntries = getEntries();
    return allEntries
      .filter((e) => inRange(e.date))
      .map((e) => {
        const t = getDailyDisplayTotals(e);
        return { date: e.date, income: t.income, expenses: t.expenses };
      })
      .filter((e) => e.income > 0 || e.expenses > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, agg, customFrom, customTo, refreshKey]);

  // Monthly breakdown (used when agg === "month")
  const monthlyList = useMemo(() => {
    const grouped: Record<string, { income: number; expenses: number }> = {};
    dailyList.forEach((e) => {
      const key = e.date.substring(0, 7);
      if (!grouped[key]) grouped[key] = { income: 0, expenses: 0 };
      grouped[key].income += e.income;
      grouped[key].expenses += e.expenses;
    });
    return Object.entries(grouped)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, v]) => ({ month, ...v }));
  }, [dailyList]);

  const formatMonthLabel = (monthKey: string) => {
    const d = new Date(monthKey + "-01T00:00:00");
    return d.toLocaleDateString(i18n.language === "km" ? "km-KH" : "en-US", {
      month: "long",
      year: "numeric",
    });
  };

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, d) => ({
        income: acc.income + d.income,
        expenses: acc.expenses + d.expenses,
        profit: acc.profit + d.profit,
      }),
      { income: 0, expenses: 0, profit: 0 }
    );
  }, [chartData]);

  const formatDayLabel = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(i18n.language === "km" ? "km-KH" : "en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  const openDay = (date: string) => {
    setOpenDate(date);
    setOpenTxns(getTransactionsForDate(date));
  };

  const dayTotals = useMemo(() => sumTransactionsInDisplay(openTxns), [openTxns]);

  // Edit / delete transaction dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogType, setDialogType] = useState<TransactionType>("income");
  const [dialogAmount, setDialogAmount] = useState("");
  const [dialogNote, setDialogNote] = useState("");
  const [dialogDate, setDialogDate] = useState<string>("");
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCurrency, setEditingCurrency] = useState<"USD" | "KHR" | null>(null);
  const savingRef = useRef(false);
  const maxAmount = getMaxAmount();
  const currencyCode = getCurrencyCodeLabel();

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(i18n.language === "km" ? "km-KH" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  };

  const openEditDialog = (txn: Transaction) => {
    setDialogType(txn.type);
    setDialogAmount(String(txn.amount));
    setDialogNote(txn.note || "");
    setDialogDate(txn.date);
    setEditingId(txn.id);
    setEditingCurrency(txn.currency ?? null);
    setDialogOpen(true);
  };

  const sanitizeInputString = (raw: string): string => {
    let cleaned = raw.replace(/[^\d.]/g, "");
    const firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    }
    const n = parseFloat(cleaned);
    if (Number.isFinite(n) && n > maxAmount) return String(maxAmount);
    return cleaned;
  };

  const handleSaveDialog = () => {
    if (savingRef.current) return;
    const amount = sanitizeAmount(parseFloat(dialogAmount) || 0);
    if (amount <= 0) return;
    savingRef.current = true;
    try {
      if (editingId) {
        const existing = openTxns.find((t) => t.id === editingId);
        if (existing && existing.date !== dialogDate) {
          // Date changed — move by delete + re-add
          deleteTransaction(editingId);
          addTransaction(dialogType, amount, dialogNote.trim() || undefined, dialogDate);
          if (existing.date !== dialogDate) {
            const entry = getEntries().find((e) => e.date === existing.date);
            if (entry) syncEntryToCloud(entry);
          }
        } else {
          updateTransaction(editingId, amount, dialogNote.trim() || undefined);
        }
      }
      // Refresh the sheet
      if (openDate) setOpenTxns(getTransactionsForDate(openDate));
      setRefreshKey((k) => k + 1);
      setDialogOpen(false);
    } finally {
      setTimeout(() => { savingRef.current = false; }, 300);
    }
  };

  const openDeleteDialog = (id: string) => {
    setDeleteTargetId(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (deleteTargetId) {
      deleteTransaction(deleteTargetId);
      if (openDate) setOpenTxns(getTransactionsForDate(openDate));
      setRefreshKey((k) => k + 1);
    }
    setDeleteDialogOpen(false);
    setDeleteTargetId(null);
    setDialogOpen(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background pb-24">
      <div className="px-6 pt-8 pb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-foreground">{t("reports.title")}</h1>
        <Button
          variant="outline"
          size="sm"
          className="rounded-lg font-semibold"
          onClick={() => setExportOpen(true)}
        >
          <Download className="w-4 h-4 mr-1.5" />
          {t("reports.exportButton")}
        </Button>
      </div>

      <ExportDataDialog open={exportOpen} onOpenChange={setExportOpen} />



      <div className="px-6 mb-4">
        <div className="flex flex-wrap gap-2">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className={`flex-1 min-w-[64px] py-2 rounded-lg text-sm font-semibold transition-colors active:scale-[0.97] ${
                range === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">{t("reports.customFrom")}</Label>
              <Popover open={fromPickerOpen} onOpenChange={setFromPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn("w-full h-10 justify-start text-left font-medium rounded-lg text-xs")}
                  >
                    <CalendarIcon className="w-3.5 h-3.5 mr-1.5" />
                    {formatDayLabel(getLocalDateString(customFrom))}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    locale={i18n.language === "km" ? km : enUS}
                    selected={customFrom}
                    onSelect={(d) => {
                      if (d) {
                        setCustomFrom(d);
                        if (d > customTo) setCustomTo(d);
                        setFromPickerOpen(false);
                      }
                    }}
                    disabled={(d) => d > new Date()}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">{t("reports.customTo")}</Label>
              <Popover open={toPickerOpen} onOpenChange={setToPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn("w-full h-10 justify-start text-left font-medium rounded-lg text-xs")}
                  >
                    <CalendarIcon className="w-3.5 h-3.5 mr-1.5" />
                    {formatDayLabel(getLocalDateString(customTo))}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    locale={i18n.language === "km" ? km : enUS}
                    selected={customTo}
                    onSelect={(d) => {
                      if (d) {
                        setCustomTo(d);
                        if (d < customFrom) setCustomFrom(d);
                        setToPickerOpen(false);
                      }
                    }}
                    disabled={(d) => d > new Date() || d < customFrom}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 mb-6">
        <div className="flex gap-2">
          {AGG_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setAgg(opt.value)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors active:scale-[0.97] ${
                agg === opt.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 mb-6 grid grid-cols-3 gap-3">
        <div className="bg-card rounded-xl p-3 text-center shadow-sm shadow-black/5">
          <div className="text-xs text-muted-foreground mb-1">{t("reports.income")}</div>
          <div className="text-sm font-bold text-success">{formatDisplayAmount(totals.income)}</div>
        </div>
        <div className="bg-card rounded-xl p-3 text-center shadow-sm shadow-black/5">
          <div className="text-xs text-muted-foreground mb-1">{t("reports.expenses")}</div>
          <div className="text-sm font-bold text-destructive">{formatDisplayAmount(totals.expenses)}</div>
        </div>
        <div className="bg-card rounded-xl p-3 text-center shadow-sm shadow-black/5">
          <div className="text-xs text-muted-foreground mb-1">{t("reports.profit")}</div>
          <div className={`text-sm font-bold ${totals.profit >= 0 ? "text-success" : "text-destructive"}`}>
            {formatDisplayAmount(totals.profit)}
          </div>
        </div>
      </div>

      <div className="px-6 flex-1 space-y-5">
        <div className="bg-card rounded-2xl p-4 shadow-sm shadow-black/5 animate-fade-up">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "hsl(160 10% 50%)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(160 10% 50%)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: "12px",
                    border: "none",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                    fontSize: "13px",
                  }}
                  formatter={(value: number) => formatDisplayAmount(value)}
                />
                <Legend wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} />
                <Bar isAnimationActive={false} dataKey="income" name={t("reports.income")} fill="hsl(152 55% 48%)" radius={[4, 4, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="expenses" name={t("reports.expenses")} fill="hsl(0 72% 55%)" radius={[4, 4, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="profit" name={t("reports.profit")} fill="hsl(38 90% 55%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex flex-col items-center justify-center text-center">
              <div className="text-4xl mb-3">📊</div>
              <p className="text-muted-foreground font-medium">{t("reports.noData")}</p>
              <p className="text-muted-foreground text-sm">{t("reports.noDataSub")}</p>
            </div>
          )}
        </div>

        {/* Breakdown — monthly rows when agg=month, daily rows otherwise */}
        {agg === "month" && monthlyList.length > 0 && (
          <div className="bg-card rounded-2xl shadow-sm shadow-black/5 overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h2 className="font-bold text-sm">{t("reports.aggMonth")}</h2>
            </div>
            <ul className="divide-y divide-border">
              {monthlyList.map((m) => {
                const profit = m.income - m.expenses;
                return (
                  <li key={m.month} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">{formatMonthLabel(m.month)}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        <span className="text-success">+{formatDisplayAmount(m.income)}</span>
                        {" · "}
                        <span className="text-destructive">-{formatDisplayAmount(m.expenses)}</span>
                      </div>
                    </div>
                    <div className={`text-sm font-bold whitespace-nowrap ${profit >= 0 ? "text-success" : "text-destructive"}`}>
                      {formatDisplayAmount(profit)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {agg !== "month" && dailyList.length > 0 && (
          <div className="bg-card rounded-2xl shadow-sm shadow-black/5 overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h2 className="font-bold text-sm">{t("reports.dailyBreakdown")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("reports.tapDayHint")}</p>
            </div>
            <ul className="divide-y divide-border">
              {dailyList.map((e) => {
                const profit = e.income - e.expenses;
                return (
                  <li key={e.date}>
                    <button
                      onClick={() => openDay(e.date)}
                      className="w-full text-left px-4 py-3 active:bg-muted/50 transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{formatDayLabel(e.date)}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          <span className="text-success">+{formatDisplayAmount(e.income)}</span>
                          {" · "}
                          <span className="text-destructive">-{formatDisplayAmount(e.expenses)}</span>
                        </div>
                      </div>
                      <div className={`text-sm font-bold whitespace-nowrap ${profit >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatDisplayAmount(profit)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* Day detail sheet */}
      <Sheet open={openDate !== null} onOpenChange={(o) => { if (!o) setOpenDate(null); }}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
          <SheetHeader>
            <SheetTitle>{openDate ? formatDayLabel(openDate) : ""}</SheetTitle>
          </SheetHeader>
          {openTxns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">{t("reports.noTxnsForDay")}</p>
          ) : (
            <>
              <div className="mt-4 rounded-2xl border border-border overflow-hidden bg-card">
                <div className="grid grid-cols-[48px_1fr_1fr] bg-muted/50">
                  <div></div>
                  <div className="py-3 text-center font-bold text-sm">{t("reports.income")} 💰</div>
                  <div className="py-3 text-center font-bold text-sm">{t("reports.expenses")} 💸</div>
                </div>
                {openTxns.map((txn, i) => (
                  <div
                    key={txn.id}
                    className="border-t border-border"
                  >
                    <div className="grid grid-cols-[48px_1fr_1fr]">
                      <div className="py-3 text-center text-sm font-bold text-muted-foreground">#{i + 1}</div>
                      <div className="py-3 px-2">
                        <div className={`font-semibold text-center text-sm ${txn.type === "income" ? "" : "opacity-30"}`}>
                          {txn.type === "income" ? formatCurrency(txn.amount, { entryCurrency: txn.currency }) : "—"}
                        </div>
                        {txn.type === "income" && txn.note && (
                          <div className="text-[11px] text-muted-foreground text-center truncate mt-0.5">{txn.note}</div>
                        )}
                      </div>
                      <div className="py-3 px-2">
                        <div className={`font-semibold text-center text-sm ${txn.type === "expense" ? "" : "opacity-30"}`}>
                          {txn.type === "expense" ? formatCurrency(txn.amount, { entryCurrency: txn.currency }) : "—"}
                        </div>
                        {txn.type === "expense" && txn.note && (
                          <div className="text-[11px] text-muted-foreground text-center truncate mt-0.5">{txn.note}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 px-4 pb-2">
                      <button
                        onClick={() => openEditDialog(txn)}
                        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground active:scale-[0.95] transition-transform"
                      >
                        <Pencil className="w-3.5 h-3.5" /> {t("home.edit")}
                      </button>
                      <button
                        onClick={() => openDeleteDialog(txn.id)}
                        className="flex items-center gap-1 text-xs font-medium text-destructive/80 hover:text-destructive active:scale-[0.95] transition-transform"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> {t("home.delete")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                {[
                  { emoji: "💰", label: t("reports.income"), value: dayTotals.income },
                  { emoji: "💸", label: t("reports.expenses"), value: dayTotals.expenses },
                  { emoji: "🐷", label: t("reports.profit"), value: dayTotals.profit },
                ].map((it, i) => (
                  <div key={i} className="bg-card border border-border rounded-2xl p-3 text-center">
                    <div className="text-2xl">{it.emoji}</div>
                    <div className="text-xs text-muted-foreground mt-1">{it.label}</div>
                    <div className="text-base font-extrabold mt-1">{formatDisplayAmount(it.value)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit transaction dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle className="text-center text-2xl">
              {t("home.edit")} {dialogType === "income" ? t("home.txnIncome") : t("home.txnExpense")}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <Label htmlFor="txn-amount" className="sr-only">{t("home.amount")}</Label>
            <div className="relative">
              <Input
                id="txn-amount"
                type="number"
                inputMode="decimal"
                min="0"
                max={maxAmount}
                step="0.01"
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
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn("w-full h-12 justify-start text-left font-medium rounded-2xl")}
                >
                  <CalendarIcon className="w-4 h-4 mr-2" />
                  {formatDate(dialogDate)}
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
            <Button
              variant="ghost"
              onClick={() => { const id = editingId; if (id) openDeleteDialog(id); }}
              className="text-destructive"
            >
              <Trash2 className="w-4 h-4 mr-1" />{t("home.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="rounded-3xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">
              {t("home.delete")}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-center text-muted-foreground text-sm py-2">
            {t("home.confirmDelete")}
          </p>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button
              onClick={confirmDelete}
              className="w-full h-12 rounded-2xl text-base font-bold bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t("home.delete")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              className="w-full h-12 rounded-2xl text-base font-semibold"
            >
              {t("home.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {newBadges.length > 0 && (
        <BadgeToast badges={newBadges} onClose={() => setNewBadges([])} />
      )}

      <BottomNav />
    </div>
  );
};

export default Reports;
