import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useStreakFreeze,
  getStreakData,
  getStreakStatus,
  syncStatsToCloud,
  getBadges,
  type StreakData,
  type StreakStatus,
} from "@/lib/storage";
import { toast } from "@/hooks/use-toast";

interface UseFreezeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUsed?: (streak: StreakData) => void;
}

const descKeyFor = (status: StreakStatus): string => {
  switch (status) {
    case "safe":
      return "badges.freezeDialogDescSafe";
    case "at_risk":
      return "badges.freezeDialogDescAtRisk";
    case "recoverable":
      return "badges.freezeDialogDescRecoverable";
    default:
      return "badges.freezeDialogDescAtRisk";
  }
};

const toastKeyFor = (status: StreakStatus): string => {
  switch (status) {
    case "safe":
      return "badges.freezeUsedToastSafe";
    case "recoverable":
      return "badges.freezeUsedToastRecoverable";
    case "at_risk":
    default:
      return "badges.freezeUsedToastAtRisk";
  }
};

const UseFreezeDialog = ({ open, onOpenChange, onUsed }: UseFreezeDialogProps) => {
  const { t } = useTranslation();
  const streak = getStreakData();
  const status = getStreakStatus();
  const remaining = Math.max(0, streak.freezesAvailable - 1);

  const handleConfirm = () => {
    const result = useStreakFreeze();
    if (result) {
      toast({ description: t(toastKeyFor(result.status)) });
      syncStatsToCloud(result.streak, getBadges());
      onUsed?.(result.streak);
    }
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <span className="mr-2">🧊</span>
            {t("badges.freezeDialogTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(descKeyFor(status), {
              streak: streak.currentStreak,
              remaining,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("badges.freezeCancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            {t("badges.freezeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default UseFreezeDialog;
