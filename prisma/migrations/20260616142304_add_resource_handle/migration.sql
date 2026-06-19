-- CreateTable
CREATE TABLE "ResourceHandle" (
    "shopDomain" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceHandle_pkey" PRIMARY KEY ("shopDomain","resourceId")
);
