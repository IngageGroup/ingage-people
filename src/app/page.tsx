import PageHeader from "@/components/PageHeader";
import ChatPanel from "./ChatPanel";

export default function ChatPage() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
      <PageHeader title="Ask a Question">
        Get answers about Ingage policies and benefits, with a link to the handbook section each
        answer comes from.
      </PageHeader>
      <div className="flex-1">
        <ChatPanel />
      </div>
    </div>
  );
}
