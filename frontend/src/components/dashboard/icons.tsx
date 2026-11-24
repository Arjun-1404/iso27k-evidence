// A handful of small line icons, drawn here so the dashboard needs no icon library. Each is decorative (aria-hidden): the
// words next to it carry the meaning, so an icon is never the only way to tell what something is.

import type { SVGProps } from "react";

function Icon({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const ClockIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const XCircleIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></Icon>;
export const CheckCircleIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16 9.5" /></Icon>;
export const InboxIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M5.5 5h13L21 13v6H3v-6z" /></Icon>;
export const UploadIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>;
