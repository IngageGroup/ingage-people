import { Card, FeatureIcon, type IconName } from "@ingagegroup/ingage-react";

export default function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card padding={48} className="flex flex-col items-center text-center gap-3">
      <FeatureIcon name={icon} />
      <h2 className="text-lg">{title}</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-caption)" }}>{children}</p>
      {action}
    </Card>
  );
}
