import { channels } from "@/lib/channels";
import { AppShell } from "@/components/AppShell";
import { dueCount } from "@/lib/reminders";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [list, due] = await Promise.all([channels(), dueCount()]);
  return (
    <AppShell channels={list} dueReminders={due}>
      {children}
    </AppShell>
  );
}
