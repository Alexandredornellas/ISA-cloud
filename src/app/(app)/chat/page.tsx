import { chatTranscript } from "@/lib/brain/chat";
import { ChatPanel } from "@/components/ChatPanel";
import { clearChatMessages } from "./actions";

export const dynamic = "force-dynamic";

export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const { ask } = await searchParams;
  const messages = await chatTranscript();
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Ask ISA</h1>
        {messages.length ? (
          <form action={clearChatMessages}>
            <button className="text-sm text-muted hover:text-ink">New chat</button>
          </form>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted">
        Correct a draft, move something to the right project, or tell ISA a rule. Changes wait in the inbox for your approval.
      </p>
      <ChatPanel messages={messages} initial={typeof ask === "string" ? ask : ""} />
    </div>
  );
}
