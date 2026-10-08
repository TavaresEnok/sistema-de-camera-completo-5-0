-- Avisos independentes desligados por padrão; preserva gravações e alertas existentes.
ALTER TABLE "Camera" ADD COLUMN "objectNoticeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Camera" ADD COLUMN "objectNoticeClasses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
