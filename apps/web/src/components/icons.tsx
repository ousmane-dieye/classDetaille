import type { ReactElement, SVGProps } from 'react';

/** Icônes trait fin 1,8 px (UX § 4.4) : décoratives, toujours ignorées des lecteurs d’écran. */
function base(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

export function AlertIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

export function SendIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  );
}
