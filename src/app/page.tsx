import { connection } from "next/server";
import PageHeader from "@/components/PageHeader";
import { chatTopics, exampleQuestions, m365Enabled } from "@/lib/chat-topics";
import ChatPanel from "./ChatPanel";

export default async function ChatPage() {
  // Read M365_TOOLS when the page is requested, not when the image is built.
  await connection();
  const scope = { topics: chatTopics(), examples: exampleQuestions(), m365: m365Enabled() };
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
      <PageHeader title="Ask a Question">
        {scope.m365
          ? "Get answers about Ingage policies and your own work, with a link to the handbook section, file, mail, or Teams message each answer comes from."
          : "Get answers about Ingage policies and benefits, with a link to the handbook section each answer comes from."}
      </PageHeader>
      <div className="flex-1">
        <ChatPanel scope={scope} />
      </div>
    </div>
  );
}
