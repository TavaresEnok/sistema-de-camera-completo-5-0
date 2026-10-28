-- Preferências do aviso na tela; preserva gravação, permissões e som já escolhido.
ALTER TABLE "Camera" ADD COLUMN "noticeSound" TEXT NOT NULL DEFAULT 'attention';
ALTER TABLE "Camera" ADD COLUMN "noticeDurationSeconds" INTEGER NOT NULL DEFAULT 10;
