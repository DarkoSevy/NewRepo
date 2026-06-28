import { z } from "zod";
import { TaskStatus, Priority } from "@prisma/client";

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(255),
  description: z.string().optional(),
  assigneeId: z.string().cuid().optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  dueDate: z.string().datetime().optional(),
  labelIds: z.array(z.string().cuid()).optional(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  position: z.number().optional(),
});

export const moveTaskSchema = z.object({
  status: z.nativeEnum(TaskStatus),
  position: z.number(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
