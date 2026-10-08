-- Preferência visual. Padrão sem texto no grid; não muda detecção/gravação.
ALTER TABLE "Camera" ADD COLUMN "showDetectorPercentage" BOOLEAN NOT NULL DEFAULT false;
