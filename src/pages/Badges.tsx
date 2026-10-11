import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getBadges,
  getStreakData,
  getStreakStatus,
  type StreakData,
  type StreakStatus,
} from "@/lib/storage";
import BottomNav from "@/components/BottomNav";
import UseFreezeDialog from "@/components/UseFreezeDialog";
import { toast } from "@/hooks/use-toast";

const Badges = () => {
  const { t } = useTranslation();
  const badges = getBadges();
  const [streak, setStreak] = useState<StreakData>(getStreakData());
  const [streakStatus, setStreakStatus] = useState<StreakStatus>(getStreakStatus());
  const [freezeDialogOpen, setFreezeDialogOpen] = useState(false);
  const earned = badges.filter(b => b.earnedAt);
  const locked = badges.filter(b => !b.earnedAt);
  const flameRed = streakStatus === "at_risk" || streakStatus === "recoverable";

  const handleFreezeClick = () => {
    if (streakStatus === "none") {
      toast({
        title: t("badges.freezeNoStreakTitle"),
        description: t("badges.freezeNoStreakDesc"),
      });
      return;
    }
    if (streakStatus === "lost") {
      toast({
        title: t("badges.freezeLostTitle"),
        description: t("badges.freezeLostDesc"),
      });
      return;
    }
    if (streak.freezesAvailable <= 0) {
      toast({
        title: t("badges.freezeNoneTitle"),
        description: t("badges.freezeNoneDesc"),
      });
      return;
    }
    setFreezeDialogOpen(true);
  };

  const handleFreezeUsed = (s: StreakData) => {
    setStreak(s);
    setStreakStatus(getStreakStatus());
  };

  const renderBadge = (badge: typeof badges[number], isLocked: boolean) => {
    const name = t(`badges.items.${badge.id}.name`, { defaultValue: badge.id });
    const description = t(`badges.items.${badge.id}.description`, { defaultValue: "" });
    return (
      <div
        key={badge.id}
        className={
          isLocked
            ? "bg-muted rounded-xl p-4 text-center opacity-50"
            : "bg-card rounded-xl p-4 text-center shadow-sm shadow-black/5"
        }
      >
        <div className={`text-3xl mb-2 ${isLocked ? "grayscale" : ""}`}>{badge.icon}</div>
        <div className={`text-xs font-bold ${isLocked ? "text-muted-foreground" : "text-foreground"}`}>{name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-background pb-24">
      <div className="px-6 pt-8 pb-4">
        <h1 className="text-2xl font-extrabold text-foreground">{t("badges.title")}</h1>
      </div>

      <div className="px-6 mb-6">
        <div
          className={`rounded-2xl p-6 text-center ${
            flameRed
              ? "bg-gradient-to-br from-destructive/20 to-destructive/5 ring-2 ring-destructive/30"
              : "bg-gradient-to-br from-streak/20 to-streak/5"
          }`}
        >
          <div className={`text-5xl mb-2 ${streak.currentStreak > 0 ? "animate-streak-pulse" : ""}`}>
            {flameRed ? "🥶" : "🔥"}
          </div>
          <div className={`text-4xl font-extrabold ${flameRed ? "text-destructive" : "text-streak-foreground"}`}>
            {streak.currentStreak}
          </div>
          <div className={`text-sm font-medium ${flameRed ? "text-destructive/80" : "text-streak-foreground/70"}`}>
            {t("badges.dayStreak")}
          </div>

          {flameRed && (
            <div className="mt-3 text-xs font-medium text-destructive">
              ⚠️ {streakStatus === "at_risk" ? t("badges.streakAtRisk") : t("badges.streakRecoverable")}
            </div>
          )}

          <div className="flex justify-center gap-6 mt-4 text-sm">
            <div>
              <div className="font-bold text-streak-foreground">{streak.longestStreak}</div>
              <div className="text-streak-foreground/60">{t("badges.best")}</div>
            </div>
            <div>
              <div className="font-bold text-streak-foreground">{streak.totalEntries}</div>
              <div className="text-streak-foreground/60">{t("badges.total")}</div>
            </div>
            <button
              onClick={handleFreezeClick}
              className="active:scale-95 transition-transform rounded-lg px-2 -mx-2 hover:bg-streak/10"
              aria-label={t("badges.freezes")}
            >
              <div className="font-bold text-streak-foreground">🧊 {streak.freezesAvailable}</div>
              <div className="text-streak-foreground/60">{t("badges.freezes")}</div>
            </button>
          </div>
        </div>
      </div>

      {earned.length > 0 && (
        <div className="px-6 mb-6">
          <h2 className="text-lg font-bold text-foreground mb-3">{t("badges.earned")} ({earned.length})</h2>
          <div className="grid grid-cols-3 gap-3">
            {earned.map((b) => renderBadge(b, false))}
          </div>
        </div>
      )}

      {locked.length > 0 && (
        <div className="px-6 mb-6">
          <h2 className="text-lg font-bold text-muted-foreground mb-3">{t("badges.locked")} ({locked.length})</h2>
          <div className="grid grid-cols-3 gap-3">
            {locked.map((b) => renderBadge(b, true))}
          </div>
        </div>
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

export default Badges;
