import { z } from 'zod';

export const META_KEY_RE = /^[A-Za-z0-9_]+$/;

const MetaSchema = z
  .record(z.string())
  .refine((m) => Object.keys(m).every((k) => META_KEY_RE.test(k)), {
    message: 'meta keys must match [A-Za-z0-9_]+',
  })
  .default({});

export const SubmitJobBodySchema = z
  .object({
    session_id: z.string().min(1).optional(),
    session_label: z.string().min(1).optional(),
    /** Pool: attached sessions labelled `<pool>` or `<pool>-<n>` (least-busy healthy one). */
    pool: z.string().min(1).optional(),
    spawn_if_missing: z.boolean().default(false),
    spawn_opts: z
      .object({
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
      })
      .optional(),
    content: z.string().min(1),
    meta: MetaSchema,
    ttl_sec: z.number().int().positive().optional(),
    priority: z.enum(['high', 'normal', 'low']).default('normal'),
    client_ref: z.string().min(1).max(255).optional(),
    mode: z.enum(['serial', 'fire-and-forget']).default('serial'),
  })
  .refine(
    (b) => [b.session_id, b.session_label, b.pool].filter(Boolean).length === 1,
    {
      message: 'exactly one of session_id, session_label or pool is required',
      path: ['session_id'],
    },
  );

export type SubmitJobBody = z.infer<typeof SubmitJobBodySchema>;

export const ListJobsQuerySchema = z.object({
  status: z.string().optional(),
  session_id: z.string().optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

export const ListSessionsQuerySchema = z.object({
  status: z.enum(['attached', 'detached']).optional(),
  label: z.string().optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const SpawnSessionBodySchema = z.object({
  label: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});
export type SpawnSessionBody = z.infer<typeof SpawnSessionBodySchema>;

export const WaitQuerySchema = z.object({
  timeout: z.coerce.number().int().positive().max(3600).default(60),
});
export type WaitQuery = z.infer<typeof WaitQuerySchema>;

export const CommentBodySchema = z.object({
  note: z.string().min(1),
});
export type CommentBody = z.infer<typeof CommentBodySchema>;

export const JobIdParamSchema = z.object({
  id: z.string().min(1),
});

export const SessionIdParamSchema = z.object({
  id: z.string().min(1),
});

export const AuthCodeBodySchema = z.object({
  code: z.string().min(1).max(2048),
});
export type AuthCodeBody = z.infer<typeof AuthCodeBodySchema>;

export const FleetLabelParamSchema = z.object({
  label: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
});
