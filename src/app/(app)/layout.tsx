import { channels } from "@/lib/channels";
import { AppShell } from "@/components/AppShell";
import { dueCount } from "@/lib/reminders";
import { suggestionCount } from "@/lib/people";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [list, due, suggested] = await Promise.all([channels(), dueCount(), suggestionCount()]);
  return (
    <AppShell channels={list} dueReminders={due} peopleSuggestions={suggested}>
      {children}
    </AppShell>
  );
}
