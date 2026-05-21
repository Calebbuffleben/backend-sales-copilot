-- LLMFeedbackService persists LLM ingress as FeedbackType llm_insight (see llm-feedback.service.ts).
-- Enum value existed in Prisma schema but was never ALTER TYPE'd on Postgres; deploy migrate to fix 22P02.

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'llm_insight';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
