-- Additive: existing cameras keep their previous (medium) behavior.
ALTER TABLE "Camera" ADD COLUMN "motionSensitivity" TEXT NOT NULL DEFAULT 'media';
