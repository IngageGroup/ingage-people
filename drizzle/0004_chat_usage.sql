CREATE TYPE "public"."chat_usage_window" AS ENUM('minute', 'day');--> statement-breakpoint
CREATE TABLE "chat_usage" (
	"user_email" text NOT NULL,
	"window" "chat_usage_window" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "chat_usage_user_email_window_window_start_pk" PRIMARY KEY("user_email","window","window_start")
);
