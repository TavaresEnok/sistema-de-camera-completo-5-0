-- Contagem de passagem (linha com uso "contagem"). Somente ADITIVA:
-- uma coluna opcional em "Camera" e uma tabela nova. Nada existente muda.
BEGIN;

ALTER TABLE "Camera" ADD COLUMN "countingFps" INTEGER;
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_countingFps_options" CHECK ("countingFps" IS NULL OR "countingFps" IN (5, 8, 12));

CREATE TABLE "PassageCount" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "lineName" TEXT NOT NULL,
    "classLabel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "minuteStart" TIMESTAMP(3) NOT NULL,
    "session" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassageCount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PassageCount_direction_check" CHECK ("direction" IN ('in', 'out')),
    CONSTRAINT "PassageCount_count_check" CHECK ("count" >= 0)
);

CREATE UNIQUE INDEX "PassageCount_minute_session_key" ON "PassageCount"("cameraId", "lineId", "classLabel", "direction", "minuteStart", "session");
CREATE INDEX "PassageCount_cameraId_minuteStart_idx" ON "PassageCount"("cameraId", "minuteStart");
CREATE INDEX "PassageCount_minuteStart_idx" ON "PassageCount"("minuteStart");

ALTER TABLE "PassageCount" ADD CONSTRAINT "PassageCount_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
