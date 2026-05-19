ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cost_source" text NOT NULL DEFAULT 'unavailable';--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cost_metadata" jsonb;--> statement-breakpoint
UPDATE "cost_events"
SET "cost_source" = CASE
  WHEN "cost_cents" > 0 THEN 'reported'
  WHEN "billing_type" = 'metered_api' AND ("input_tokens" > 0 OR "cached_input_tokens" > 0 OR "output_tokens" > 0) THEN 'unavailable'
  ELSE 'unavailable'
END
WHERE "cost_source" = 'unavailable';
