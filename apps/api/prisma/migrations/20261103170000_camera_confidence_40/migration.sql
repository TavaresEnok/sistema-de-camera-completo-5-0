BEGIN;
ALTER TABLE "Camera" DROP CONSTRAINT "Camera_aiConfidence_range";
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_aiConfidence_range" CHECK ("aiConfidence" BETWEEN 40 AND 90);
COMMIT;
