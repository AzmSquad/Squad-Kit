/** The squad-kit mark as an icon, in the color around it: the Squad lead's sign in the sidebar and on its buttons. */
export function LeadMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={`lucide ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="3.5" cy="12" r="1.7" fill="currentColor" fillOpacity="0.35" />
      <circle cx="8" cy="12" r="1.7" fill="currentColor" fillOpacity="0.65" />
      <circle cx="12.5" cy="12" r="1.7" fill="currentColor" />
      <path d="M16 6.5 21.5 12 16 17.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
