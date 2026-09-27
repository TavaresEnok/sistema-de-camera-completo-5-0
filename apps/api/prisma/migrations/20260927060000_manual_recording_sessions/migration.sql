CREATE TABLE "ManualRecordingSession" (
  "cameraId" TEXT PRIMARY KEY REFERENCES "Camera"("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "segmentSeconds" INTEGER NOT NULL,
  "owner" TEXT,
  "leaseUntil" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ManualRecordingSession_expiresAt_idx" ON "ManualRecordingSession" ("expiresAt");
