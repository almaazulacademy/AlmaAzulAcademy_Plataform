import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[-0.01em] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lake focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-ink px-6 py-3.5 text-white shadow-sm hover:-translate-y-0.5 hover:bg-forest hover:shadow-lg",
        light:
          "bg-white px-6 py-3.5 text-ink shadow-sm hover:-translate-y-0.5 hover:bg-paper hover:shadow-lg",
        outline:
          "border border-ink/20 bg-transparent px-6 py-3.5 text-ink hover:border-ink hover:bg-ink hover:text-white",
        ghost: "px-4 py-2 text-ink hover:bg-ink/5",
      },
      size: {
        default: "h-12",
        sm: "h-10 px-4 py-2",
        lg: "h-14 px-7 text-base",
        icon: "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
