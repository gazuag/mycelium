interface OnlineNameProps {
  children: React.ReactNode;
  online?: boolean;
  className?: string;
}

export function OnlineName({ children, online = false, className }: OnlineNameProps) {
  return (
    <span className={className ? `online-name ${className}` : 'online-name'}>
      {online ? <span className="online-name-dot" role="img" aria-label="Online" title="Online" /> : null}
      {children}
    </span>
  );
}
