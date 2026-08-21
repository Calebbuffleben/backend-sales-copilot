-- Shrink FeedbackType to the values actually persisted on the Live path.

UPDATE "FeedbackEvent" SET "type" = 'llm_insight' WHERE "type" <> 'llm_insight';

CREATE TYPE "FeedbackType_new" AS ENUM ('llm_insight');

ALTER TABLE "FeedbackEvent"
  ALTER COLUMN "type" DROP DEFAULT,
  ALTER COLUMN "type" TYPE "FeedbackType_new"
  USING 'llm_insight'::"FeedbackType_new";

DROP TYPE "FeedbackType";
ALTER TYPE "FeedbackType_new" RENAME TO "FeedbackType";
