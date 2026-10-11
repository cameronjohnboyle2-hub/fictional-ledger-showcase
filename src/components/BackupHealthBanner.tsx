// The showcase has no cloud backup. Never display a false success badge.
export function BackupHealthBadge() {
  return <span className="text-[11px] text-muted-foreground">Memory only</span>;
}
export default function BackupHealthBanner() { return null; }
