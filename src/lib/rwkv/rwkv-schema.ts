import { z } from "zod";

const emptyToUndefined = (v: unknown) =>
  v === "" || v === undefined ? undefined : v;

export const rwkvHttpUrlSchema = z.string().url();

export const rwkvPasswordSchema = z.string().min(1);

/** 仅校验上游 URL；password 可为空（无鉴权网关不写 password 字段） */
export const rwkvResolvedUrlSchema = z.object({
  url: rwkvHttpUrlSchema,
});

/** callUpstreamStream 入参（采样参数由 rwkv-config 内 RWKV_CALL_PARAMS 提供） */
export const upstreamStreamRequestSchema = z.object({
  contents: z.array(z.string()).min(1),
  password: z.preprocess(emptyToUndefined, rwkvPasswordSchema.optional()),
  upstreamUrl: z.preprocess(emptyToUndefined, rwkvHttpUrlSchema.optional()),
});

export type ValidatedUpstreamStreamRequest = z.infer<typeof upstreamStreamRequestSchema>;
