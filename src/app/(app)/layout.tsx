import Link from "next/link";
import { NavLink } from "@/components/NavLink";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex items-center gap-3 py-5 sm:gap-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          ISA
        </Link>
        <nav className="flex min-w-0 gap-1 overflow-x-auto text-sm">
          <NavLink href="/">Channels</NavLink>
          <NavLink href="/projects">Projects</NavLink>
          <NavLink href="/connections">Connections</NavLink>
          <NavLink href="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="flex-1 pb-16">{children}</main>
    </div>
  );
}
