"use client"

import { Toaster as Sonner, ToasterProps } from "sonner"
import { useTheme } from "@/components/lia/theme-provider"

/**
 * Sonner Toaster — follows Lia theme (classic/quiet = light, wow = dark).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()
  const sonnerTheme = theme === "wow" ? "dark" : "light"

  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
