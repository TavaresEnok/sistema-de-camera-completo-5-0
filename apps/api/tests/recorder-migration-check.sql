BEGIN;
INSERT INTO "CameraGroup" (id, name, "updatedAt") VALUES ('recorder-test-group', 'Teste isolado', now());
INSERT INTO "Recorder" (id, name, ip, username, "passwordEncrypted", "groupId", "updatedAt")
VALUES ('recorder-test', 'Teste isolado', '192.0.2.1', 'test', 'not-a-production-secret', 'recorder-test-group', now());
INSERT INTO "Camera" (id, name, ip, username, "passwordEncrypted", "updatedAt", "recorderId", channel)
VALUES ('recorder-test-camera', 'Teste isolado', '192.0.2.1', 'test', 'not-a-production-secret', now(), 'recorder-test', 1);
DO $$ BEGIN
  BEGIN
    INSERT INTO "Camera" (id, name, ip, username, "passwordEncrypted", "updatedAt", "recorderId", channel)
    VALUES ('recorder-test-duplicate', 'Duplicado', '192.0.2.1', 'test', 'test', now(), 'recorder-test', 1);
    RAISE EXCEPTION 'O banco aceitou canal duplicado';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM "Recorder" WHERE id = 'recorder-test';
    RAISE EXCEPTION 'O banco permitiu remover um gravador com canais';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
