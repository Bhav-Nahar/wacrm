"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

// Root: primary token when checked or indeterminate (responds to the active
// color theme), input border when unchecked. Mirrors switch.tsx conventions.
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // Border is muted-foreground, NOT `border-input`. In light mode
        // `--input` is oklch(0.922) against a white card — roughly 1.2:1,
        // where WCAG 1.4.11 wants 3:1 for the boundary of a control you have
        // to find and click. At 16px that read as a faint divider rather than
        // a checkbox: the contacts table looked like it had an empty column.
        // A text input can get away with it (it is large and has a label);
        // a bare 16px square cannot.
        // `inline-flex`, not the default: Base UI renders the root as a
        // <span>, which is `display: inline` — and width/height do not apply
        // to inline boxes, so `size-4` was silently ignored and the control
        // collapsed to a ~2px sliver. It only looked right where a flex
        // parent happened to blockify it, which is why the settings panels
        // were fine and the contacts table appeared to have an empty column.
        // Setting the display here means the control no longer depends on
        // what its parent happens to be.
        "peer inline-flex size-4 shrink-0 items-center justify-center cursor-pointer rounded-[4px] border border-muted-foreground/70 bg-card shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground",
        "data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {props.indeterminate ? (
          <Minus className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
