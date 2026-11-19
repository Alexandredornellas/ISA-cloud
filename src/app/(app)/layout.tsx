import Link from "next/link";
import { NavLink } from "@/components/NavLink";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex items-center gap-6 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          ISA
        </Link>
        <nav className="flex gap-1 text-sm">
          <NavLink href="/">Inbox</NavLink>
          <NavLink href="/projects">Projects</NavLink>
          <NavLink href="/connections">Connections</NavLink>
        </nav>
      </header>
      <main className="flex-1 pb-16">{children}</main>
    </div>
  );
}
