CREATE TABLE "chat_citation_counts" (
	"day" date NOT NULL,
	"topic" text NOT NULL,
	"section" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "chat_citation_counts_day_topic_section_pk" PRIMARY KEY("day","topic","section")
);
--> statement-breakpoint
CREATE TABLE "chat_outcome_counts" (
	"day" date NOT NULL,
	"topic" text NOT NULL,
	"outcome" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "chat_outcome_counts_day_topic_outcome_pk" PRIMARY KEY("day","topic","outcome")
);
