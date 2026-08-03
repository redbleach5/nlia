/**
 * Button — single button component with variants.
 * Clay & Cream aesthetic (Anthropic-inspired).
 *
 * Variants:
 *   - primary (clay): solid clay button, white text
 *   - secondary: cream surface with hairline border
 *   - ghost: transparent, hover cream surface
 *   - outline: border-only, clay text
 *   - danger: muted red background, white text
 *
 * Sizes:
 *   - sm: 26px · 12px text
 *   - md: 32px · 13px text
 *   - lg: 40px · 14px text
 *   - icon: 32x32 square
 */

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "btn-ember border-transparent",
  secondary:
    "bg-[var(--color-surface)] text-[var(--color-fg-ink)] hover:bg-[var(--color-surface-2)] border-[var(--color-border)]",
  ghost:
    "bg-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-ink)] hover:bg-[var(--color-surface-2)] border-transparent",
  outline:
    "bg-transparent text-[var(--color-ember-deep)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-ember)]",
  danger:
    "bg-[var(--color-danger)] text-white hover:opacity-90 border-transparent",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-[26px] px-2.5 text-xs gap-1.5 rounded-[var(--radius-sm)]",
  md: "h-8 px-3.5 text-[13px] gap-1.5 rounded-[var(--radius-sm)]",
  lg: "h-10 px-5 text-sm gap-2 rounded-[var(--radius-md)]",
  icon: "h-8 w-8 p-0 rounded-[var(--radius-sm)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", children, ...rest }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-medium rounded-[var(--radius-sm)] border transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  ),
);
Button.displayName = "Button";
