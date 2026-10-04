BEGIN;

CREATE TABLE "_CameraMemberships" (
  "A" TEXT NOT NULL REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "B" TEXT NOT NULL REFERENCES "CameraGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "_CameraMemberships_AB_unique" ON "_CameraMemberships"("A", "B");
CREATE INDEX "_CameraMemberships_B_index" ON "_CameraMemberships"("B");

-- Preserve every existing primary group, including private cameras' contracts.
INSERT INTO "_CameraMemberships" ("A", "B")
SELECT "id", "groupId" FROM "Camera" WHERE "groupId" IS NOT NULL;

CREATE FUNCTION camera_membership_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize even concurrent requests through different API replicas.
  PERFORM 1 FROM "Camera" WHERE "id" = NEW."A" FOR UPDATE;
  IF TG_OP = 'UPDATE' AND OLD."A" = NEW."A" THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "_CameraMemberships" WHERE "A" = NEW."A" AND "B" = NEW."B")
     AND (SELECT count(*) FROM "_CameraMemberships" WHERE "A" = NEW."A") >= 4 THEN
    RAISE EXCEPTION 'Cada câmera pode pertencer a até 4 grupos.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER camera_membership_limit BEFORE INSERT OR UPDATE ON "_CameraMemberships"
FOR EACH ROW EXECUTE FUNCTION camera_membership_limit();

-- Legacy camera create/edit endpoints still choose one primary retention group.
CREATE FUNCTION camera_primary_group_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."groupId" IS DISTINCT FROM NEW."groupId" THEN
    DELETE FROM "_CameraMemberships" WHERE "A" = NEW."id" AND "B" = OLD."groupId";
  END IF;
  IF NEW."groupId" IS NOT NULL THEN
    INSERT INTO "_CameraMemberships" ("A", "B") VALUES (NEW."id", NEW."groupId") ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER camera_primary_group_membership AFTER INSERT OR UPDATE OF "groupId" ON "Camera"
FOR EACH ROW EXECUTE FUNCTION camera_primary_group_membership();

COMMIT;
