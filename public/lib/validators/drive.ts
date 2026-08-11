import { z } from "zod";

export const driveFileIdSchema = z.string().min(1);
export const driveSearchSchema = z.object({
  query: z.string().min(1),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const drivePaginationSchema = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

export type DriveSearchInput = z.infer<typeof driveSearchSchema>;
