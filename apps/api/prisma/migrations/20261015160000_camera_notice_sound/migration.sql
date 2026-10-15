-- O som é uma preferência do alerta desta câmera. O navegador continua sendo
-- quem o reproduz, então não há impacto em vídeo, gravação ou processamento.
ALTER TABLE "Camera" ADD COLUMN "noticeSoundEnabled" BOOLEAN NOT NULL DEFAULT false;
