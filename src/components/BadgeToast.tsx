import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Badge } from "@/lib/storage";

interface BadgeToastProps {
  badges: Badge[];
  onClose: () => void;
}

const BadgeToast = ({ badges, onClose }: BadgeToastProps) => {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const first = badges[0];
  const name = t(`badges.items.${first.id}.name`, { defaultValue: first.id });
  const description = t(`badges.items.${first.id}.description`, { defaultValue: "" });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card rounded-2xl p-8 mx-6 shadow-xl text-center animate-badge-pop max-w-xs" onClick={(e) => e.stopPropagation()}>
        <div className="text-6xl mb-4">{first.icon}</div>
        <h3 className="text-xl font-extrabold text-foreground mb-1">{t("badges.badgeEarned")}</h3>
        <p className="text-lg font-bold text-primary">{name}</p>
        <p className="text-muted-foreground text-sm mt-1">{description}</p>
        {badges.length > 1 && (
          <p className="text-muted-foreground text-xs mt-3">
            {t("badges.moreBadges", { count: badges.length - 1 })}
          </p>
        )}
      </div>
    </div>
  );
};

export default BadgeToast;
