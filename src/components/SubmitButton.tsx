"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  className = "",
  ...rest
}: { children: React.ReactNode; className?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  const { pending } = useFormStatus();
  return (
    <button {...rest} disabled={pending || rest.disabled} className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60 ${className}`}>
      {pending ? "Working…" : children}
    </button>
  );
}
