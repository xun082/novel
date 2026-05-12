import { z } from "zod";

const emptyToUndefined = (v: unknown) =>
  v === "" || v === undefined ? undefined : v;

export const rwkvHttpUrlSchema = z.string().url();

export const rwkvPasswordSchema = z.string().min(1);

/** 仅校验上游 URL；password 可为空（无鉴权网关不写 password 字段） */
export const rwkvResolvedUrlSchema = z.object({
  url: rwkvHttpUrlSchema,
});

/** callUpstreamStream 入参（含可选的请求级覆盖） */
export const upstreamCallOptsSchema = z.object({
  contents: z.array(z.string()).min(1),
  maxTokens: z.number().positive().max(500_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  chunkSize: z.number().int().positive().max(10_000).optional(),
  stopTokens: z.array(z.union([z.number().int(), z.string()])).optional(),
  password: z.preprocess(emptyToUndefined, rwkvPasswordSchema.optional()),
  upstreamUrl: z.preprocess(emptyToUndefined, rwkvHttpUrlSchema.optional()),
});

export type ValidatedUpstreamCallOpts = z.infer<typeof upstreamCallOptsSchema>;
