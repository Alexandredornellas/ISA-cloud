import { channels } from "@/lib/channels";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell channels={await channels()}>{children}</AppShell>;
}
