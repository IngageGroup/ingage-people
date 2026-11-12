export default function PageHeader({
  title,
  children,
  aside,
}: {
  title: string;
  children?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl mb-2" style={{ letterSpacing: "var(--ls-tight)" }}>
          {title}
        </h1>
        {children && (
          <p style={{ color: "var(--text-muted)", lineHeight: "var(--lh-body)" }}>{children}</p>
        )}
      </div>
      {aside}
    </div>
  );
}
