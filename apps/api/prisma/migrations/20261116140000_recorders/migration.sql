CREATE TABLE "Recorder" (
 "id" TEXT NOT NULL, "name" TEXT NOT NULL, "ip" TEXT NOT NULL,
 "rtspPort" INTEGER NOT NULL DEFAULT 554, "httpPort" INTEGER NOT NULL DEFAULT 80,
 "onvifPort" INTEGER, "username" TEXT NOT NULL, "passwordEncrypted" TEXT NOT NULL,
 "manufacturer" TEXT NOT NULL DEFAULT 'generic', "groupId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "Recorder_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Camera" ADD COLUMN "recorderId" TEXT;
CREATE INDEX "Recorder_groupId_idx" ON "Recorder"("groupId");
CREATE UNIQUE INDEX "Camera_recorderId_channel_key" ON "Camera"("recorderId", "channel");
ALTER TABLE "Recorder" ADD CONSTRAINT "Recorder_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CameraGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_recorderId_fkey" FOREIGN KEY ("recorderId") REFERENCES "Recorder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
