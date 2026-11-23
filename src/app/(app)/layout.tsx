import { channels } from "@/lib/channels";
import { AppShell } from "@/components/AppShell";
import { dueCount } from "@/lib/reminders";
import { suggestionCount } from "@/lib/people";
import { intakeCounts } from "@/lib/intake";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [list, due, suggested, intake] = await Promise.all([channels(), dueCount(), suggestionCount(), intakeCounts()]);
  return (
    <AppShell channels={list} dueReminders={due} peopleSuggestions={suggested} intake={intake.needs_you}>
      {children}
    </AppShell>
  );
}
