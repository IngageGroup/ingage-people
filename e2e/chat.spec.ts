import { expect, type Page, type Route, test } from "@playwright/test";
import { type ChatEvent, encodeChatEvent } from "@/lib/chat-protocol";

// /api/chat is mocked: these tests cover the UI against the wire format in
// src/lib/chat-protocol.ts, not retrieval or the model.

const HANDBOOK = { title: "Ingage Employee Handbook", lastUpdated: "2026-10-01" };

const ANSWERED: ChatEvent[] = [
  { type: "delta", text: "Each employee has an annual " },
  { type: "delta", text: "training budget of $2,000. [1]" },
  {
    type: "citation",
    citation: {
      id: "p1",
      sectionPath: ["Benefits", "Training Budget"],
      quote: "Every full-time employee receives a $2,000 training budget each calendar year.",
      documentTitle: "Ingage Employee Handbook",
      url: "https://example.sharepoint.com/sites/Hive/Handbook.pdf#page=12",
      page: 12,
    },
  },
  { type: "done", outcome: "answered", sources: [HANDBOOK] },
];

const DONT_KNOW: ChatEvent[] = [
  { type: "delta", text: "I couldn't find that in the handbook. Please contact HR." },
  { type: "done", outcome: "dont-know", sources: [HANDBOOK] },
];

const OFF_TOPIC: ChatEvent[] = [
  { type: "delta", text: "I can only help with questions about working at Ingage." },
  { type: "done", outcome: "off-topic", sources: [] },
];

function ndjson(events: ChatEvent[]): string {
  return events.map(encodeChatEvent).join("");
}

async function mockChat(page: Page, respond: (route: Route, callIndex: number) => Promise<void>) {
  let calls = 0;
  await page.route("**/api/chat", (route) => respond(route, calls++));
}

function fulfillEvents(route: Route, events: ChatEvent[]) {
  return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson(events) });
}

/** The page's Ask button, not the sidebar item of the same name. */
function askButton(page: Page) {
  return page.getByRole("main").getByRole("button", { name: "Ask", exact: true });
}

async function askQuestion(page: Page, question: string) {
  await page.getByLabel("Your question").fill(question);
  await askButton(page).click();
}

test.describe("Chat", () => {
  test("shows topics and example questions before the first question", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Ask About Working at Ingage")).toBeVisible();
    await expect(page.getByRole("button", { name: "How do I request PTO?" })).toBeVisible();
    await expect(page.getByText("HR is the authority")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "erin.roberts@revisioncollective.com" }),
    ).toHaveAttribute("href", "mailto:erin.roberts@revisioncollective.com");
  });

  test("answers with a citation that expands to the quoted passage", async ({ page }) => {
    await mockChat(page, (route) => fulfillEvents(route, ANSWERED));
    await page.goto("/");
    await page.getByRole("button", { name: "How much is my annual training budget?" }).click();

    await expect(page.getByText("training budget of $2,000.")).toBeVisible();
    await expect(
      page.getByText("Ingage Employee Handbook last updated October 1, 2026."),
    ).toBeVisible();

    const chip = page.getByRole("button", { name: /Benefits › Training Budget/ });
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("receives a $2,000 training budget each calendar year"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open in Ingage Employee Handbook" }),
    ).toHaveAttribute("href", "https://example.sharepoint.com/sites/Hive/Handbook.pdf#page=12");
  });

  test("shows a loading state until the answer arrives", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockChat(page, async (route) => {
      await gate;
      await fulfillEvents(route, ANSWERED);
    });
    await page.goto("/");
    await askQuestion(page, "What is the training budget?");
    await expect(page.getByRole("status")).toHaveText("Searching…");
    await expect(askButton(page)).toBeDisabled();
    release();
    await expect(page.getByText("training budget of $2,000.")).toBeVisible();
    await expect(askButton(page)).toBeEnabled();
  });

  test("says it doesn't know, without citations", async ({ page }) => {
    await mockChat(page, (route) => fulfillEvents(route, DONT_KNOW));
    await page.goto("/");
    await page.getByLabel("Your question").fill("What is my manager's phone number?");
    await page.getByLabel("Your question").press("Enter");
    await expect(page.getByText("Please contact HR.")).toBeVisible();
    await expect(page.getByText("Sources")).toBeHidden();
  });

  test("politely refuses an off-topic question", async ({ page }) => {
    await mockChat(page, (route) => fulfillEvents(route, OFF_TOPIC));
    await page.goto("/");
    await askQuestion(page, "Tell me the history of space travel");
    await expect(
      page.getByText("I can only help with questions about working at Ingage."),
    ).toBeVisible();
    await expect(page.getByText("last updated")).toBeHidden();
  });

  test("shows an error with a reference and retries", async ({ page }) => {
    await mockChat(page, (route, call) =>
      call === 0
        ? fulfillEvents(route, [
            { type: "delta", text: "Each employee" },
            { type: "error", error: "The answer service failed.", correlationId: "abc12345" },
          ])
        : fulfillEvents(route, ANSWERED),
    );
    await page.goto("/");
    await askQuestion(page, "What is the training budget?");
    await expect(page.getByText("Could not get an answer.")).toBeVisible();
    await expect(page.getByText("The answer service failed. (Reference: abc12345)")).toBeVisible();

    await page.getByRole("button", { name: "Try Again" }).click();
    await expect(page.getByText("training budget of $2,000.")).toBeVisible();
    await expect(page.getByText("Could not get an answer.")).toBeHidden();
    await expect(page.getByText("What is the training budget?")).toHaveCount(1);
  });

  test("shows the server's message when the request fails before streaming", async ({ page }) => {
    await mockChat(page, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "You've asked a lot of questions. Try again in a minute." }),
      }),
    );
    await page.goto("/");
    await askQuestion(page, "What is the training budget?");
    await expect(page.getByText("Try again in a minute.")).toBeVisible();
  });

  test("sends earlier turns with a follow-up question", async ({ page }) => {
    const bodies: unknown[] = [];
    await mockChat(page, (route) => {
      bodies.push(route.request().postDataJSON());
      return fulfillEvents(route, ANSWERED);
    });
    await page.goto("/");
    await askQuestion(page, "What is the training budget?");
    await expect(page.getByText("training budget of $2,000.")).toBeVisible();
    await askQuestion(page, "Does it roll over?");
    await expect(page.getByText("Does it roll over?")).toBeVisible();
    await expect.poll(() => bodies.length).toBe(2);

    expect(bodies[0]).toEqual({ question: "What is the training budget?", history: [] });
    expect(bodies[1]).toEqual({
      question: "Does it roll over?",
      history: [
        { role: "user", content: "What is the training budget?" },
        {
          role: "assistant",
          content: "Each employee has an annual training budget of $2,000. [1]",
        },
      ],
    });
  });

  test("asks for a question instead of sending an empty one", async ({ page }) => {
    let called = false;
    await mockChat(page, (route) => {
      called = true;
      return fulfillEvents(route, ANSWERED);
    });
    await page.goto("/");
    await askButton(page).click();
    await expect(page.getByText("Type a question first.")).toBeVisible();
    expect(called).toBe(false);
  });

  test("New Chat clears the conversation, and a reload does too", async ({ page }) => {
    await mockChat(page, (route) => fulfillEvents(route, ANSWERED));
    await page.goto("/");
    await askQuestion(page, "What is the training budget?");
    await expect(page.getByText("training budget of $2,000.")).toBeVisible();

    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Ask About Working at Ingage")).toBeVisible();

    await askQuestion(page, "What is the training budget?");
    await expect(page.getByText("training budget of $2,000.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Ask About Working at Ingage")).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  });
});
