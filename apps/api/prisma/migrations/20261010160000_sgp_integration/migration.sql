ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "integrationGroupId" TEXT, ADD COLUMN "integrationSuspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Camera" ADD COLUMN "integrationEnabledBeforeBlock" BOOLEAN,
 ADD COLUMN "integrationRuntimePending" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "SgpIntegration" (
 "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
 "keyHash" TEXT, "keyPrefix" TEXT, "statusMap" JSONB NOT NULL,
 "utcOffsetMinutes" INTEGER NOT NULL DEFAULT -180, "planIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "lastReceivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "SgpCustomer" (
 "id" TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES "SgpIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "externalCustomerId" TEXT NOT NULL, "groupId" TEXT NOT NULL UNIQUE REFERENCES "CameraGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "state" TEXT NOT NULL DEFAULT 'SUSPENDED', "archivedAt" TIMESTAMP(3), "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("integrationId", "externalCustomerId"), CHECK ("state" IN ('ACTIVE','SUSPENDED','ARCHIVED'))
);
CREATE TABLE "SgpService" (
 "id" TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES "SgpIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerId" TEXT NOT NULL REFERENCES "SgpCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "externalServiceId" TEXT NOT NULL, "externalContractId" TEXT NOT NULL,
 "state" TEXT NOT NULL, "sourceAt" TIMESTAMP(3) NOT NULL, "sourceOrder" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("integrationId", "externalServiceId"), CHECK ("state" IN ('ACTIVE','SUSPENDED','ARCHIVED'))
);
CREATE TABLE "SgpOperation" (
 "id" TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES "SgpIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerId" TEXT NOT NULL REFERENCES "SgpCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "dedupeKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("integrationId", "dedupeKey"), CHECK ("state" IN ('PENDING','COMPLETE','IGNORED'))
);
CREATE INDEX "SgpOperation_state_nextAttemptAt_idx" ON "SgpOperation"("state", "nextAttemptAt");
CREATE INDEX "SgpService_customerId_idx" ON "SgpService"("customerId");
CREATE TABLE "MediaReaderIdentity" (
 "protocol" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, "cameraId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("protocol", "sessionId")
);
CREATE INDEX "MediaReaderIdentity_userId_idx" ON "MediaReaderIdentity"("userId");
