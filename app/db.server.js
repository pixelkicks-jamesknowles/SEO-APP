import { PrismaClient } from "@prisma/client";

// Singleton across dev hot-reloads (mirrors pixelify-admin).
const prisma = global.prismaGlobal ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") global.prismaGlobal = prisma;

export default prisma;
