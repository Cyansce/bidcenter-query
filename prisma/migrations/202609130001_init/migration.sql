-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "noticeType" INTEGER NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    "budgetYuan" TEXT,
    "budgetRaw" TEXT,
    "procurementMethod" TEXT,
    "fileDeadline" DATETIME,
    "bidDeadline" DATETIME,
    "deadlineEvidence" TEXT NOT NULL DEFAULT '{}',
    "listedDeadlineRaw" TEXT,
    "expectedPurchaseRaw" TEXT,
    "bodyText" TEXT NOT NULL DEFAULT '',
    "bodyHtml" TEXT NOT NULL DEFAULT '',
    "contactsJson" TEXT NOT NULL DEFAULT '[]',
    "buyer" TEXT,
    "agency" TEXT,
    "projectNumber" TEXT,
    "relevance" TEXT NOT NULL DEFAULT 'REVIEW',
    "followUpStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "accessLevel" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "detailStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "detailError" TEXT,
    "detailFetchedAt" DATETIME,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "duplicateGroup" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "QueryMatch" (
    "projectId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("projectId", "query"),
    CONSTRAINT "QueryMatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CollectionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleKey" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queriesJson" TEXT NOT NULL,
    "fromDate" DATETIME NOT NULL,
    "toDate" DATETIME NOT NULL,
    "queryIndex" INTEGER NOT NULL DEFAULT 0,
    "page" INTEGER NOT NULL DEFAULT 1,
    "seen" INTEGER NOT NULL DEFAULT 0,
    "saved" INTEGER NOT NULL DEFAULT 0,
    "restricted" INTEGER NOT NULL DEFAULT 0,
    "failedDetails" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_sourceId_key" ON "Project"("sourceId");

-- CreateIndex
CREATE INDEX "Project_publishedAt_id_idx" ON "Project"("publishedAt", "id");

-- CreateIndex
CREATE INDEX "Project_region_noticeType_idx" ON "Project"("region", "noticeType");

-- CreateIndex
CREATE INDEX "Project_relevance_followUpStatus_idx" ON "Project"("relevance", "followUpStatus");

-- CreateIndex
CREATE INDEX "Project_duplicateGroup_idx" ON "Project"("duplicateGroup");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRevision_projectId_hash_key" ON "ProjectRevision"("projectId", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_scheduleKey_key" ON "CollectionRun"("scheduleKey");

-- CreateIndex
CREATE INDEX "CollectionRun_status_createdAt_idx" ON "CollectionRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

