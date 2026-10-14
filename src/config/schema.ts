import { z } from "zod";

const durationSchema = z.union([z.string().regex(/^\d+(?:\.\d+)?(?:ms|s|m)$/), z.number().nonnegative()]);

const latencySchema = z.union([
  durationSchema,
  z
    .object({
      distribution: z.literal("fixed"),
      value: durationSchema,
    })
    .strict(),
  z
    .object({
      distribution: z.literal("uniform"),
      min: durationSchema,
      max: durationSchema,
    })
    .strict(),
  z
    .object({
      distribution: z.literal("normal"),
      mean: durationSchema,
      stddev: durationSchema,
      max: durationSchema.optional(),
    })
    .strict(),
]);

const errorSchema = z
  .object({
    type: z.string().default("api_error"),
    code: z.string().nullable().default(null),
    message: z.string(),
    param: z.string().nullable().default(null),
  })
  .strict();

const responseSchema = z
  .object({
    status: z.number().int().min(100).max(599).default(200),
    headers: z.record(z.string(), z.string()).default({}),
    latency: latencySchema.optional(),
    text: z.string().optional(),
    random: z
      .array(
        z
          .object({
            text: z.string(),
            weight: z.number().positive().default(1),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    token_mode: z.enum(["reported", "padded"]).default("reported"),
    error: errorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.text !== undefined && value.random !== undefined) {
      context.addIssue({ code: "custom", message: "text and random cannot both be set" });
    }
  });

const textMatchSchema = z
  .object({
    contains: z.array(z.string()).min(1).optional(),
    equals: z.string().optional(),
    regex: z.string().optional(),
    mode: z.enum(["any", "all"]).default("any"),
    case_sensitive: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contains === undefined && value.equals === undefined && value.regex === undefined) {
      context.addIssue({ code: "custom", message: "one of contains, equals, or regex is required" });
    }
    if (value.regex !== undefined) {
      try {
        new RegExp(value.regex, value.case_sensitive ? "" : "i");
      } catch (error) {
        context.addIssue({ code: "custom", message: `invalid regex: ${String(error)}` });
      }
    }
  });

const matchSchema = z
  .object({
    text: textMatchSchema.optional(),
    roles: z.array(z.string()).min(1).optional(),
    model: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    id: z.string().min(1),
    priority: z.number().int().default(0),
    match: matchSchema.default({}),
    response: responseSchema,
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    server: z
      .object({
        api_key: z.string().min(1).optional(),
        seed: z.union([z.string(), z.number()]).optional(),
        max_body_bytes: z.number().int().positive().default(1_048_576),
      })
      .strict()
      .prefault({}),
    defaults: z
      .object({
        model: z.string().min(1).default("ani-1"),
        latency: latencySchema.optional(),
        response: responseSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    rules: z.array(ruleSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, rule] of value.rules.entries()) {
      if (ids.has(rule.id)) {
        context.addIssue({ code: "custom", path: ["rules", index, "id"], message: "duplicate rule id" });
      }
      ids.add(rule.id);
    }
  });

export type AniConfig = z.infer<typeof configSchema>;
export type Rule = AniConfig["rules"][number];
export type ResponseSpec = Rule["response"];
export type LatencySpec = NonNullable<ResponseSpec["latency"]>;
