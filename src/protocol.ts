import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EntryType = string | null | JsonValue[] | { [key: string]: JsonValue };

export const PROTOCOL_LIMITS = {
  maxBodyBytes: 1_048_576,
  maxStateBytes: 262_144,
  maxQuestions: 64,
  maxQuestionNameChars: 128,
  maxInstructionsChars: 4_096,
  maxCriterionChars: 1_024,
  maxOptionChars: 256,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  maxModelChars: 128,
} as const;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const entrySchema: z.ZodType<EntryType> = z.union([
  z.string(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]);

function boundedEntry(maxBytes: number, message: string): z.ZodType<EntryType> {
  return entrySchema.refine((value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength <= maxBytes;
  }, message);
}

const instructionsSchema = boundedEntry(
  PROTOCOL_LIMITS.maxInstructionsChars,
  "instructions exceeds 4096 bytes",
);
const criterionSchema = boundedEntry(
  PROTOCOL_LIMITS.maxCriterionChars,
  "criterion exceeds 1024 bytes",
);

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema.optional(),
  criteria: z
    .object({
      true: criterionSchema.optional(),
      false: criterionSchema.optional(),
    })
    .nullable()
    .optional(),
});

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema.optional(),
  criteria: z
    .record(
      z.string().min(1).max(PROTOCOL_LIMITS.maxOptionChars),
      criterionSchema,
    )
    .refine(
      (options) => {
        const count = Object.keys(options).length;
        return count >= 1 && count <= PROTOCOL_LIMITS.maxChoiceOptions;
      },
      { message: "choice criteria needs 1..255 options" },
    ),
});

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: instructionsSchema.optional(),
  criteria: z
    .array(criterionSchema)
    .min(PROTOCOL_LIMITS.minScoreLevels)
    .max(PROTOCOL_LIMITS.maxScoreLevels),
});

export const questionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const systemOneRequestSchema = z.object({
  model: z.string().min(1).max(PROTOCOL_LIMITS.maxModelChars).optional(),
  state: entrySchema,
  questions: z
    .record(z.string().min(1).max(PROTOCOL_LIMITS.maxQuestionNameChars), questionSchema)
    .refine(
      (questions) => {
        const count = Object.keys(questions).length;
        return count >= 1 && count <= PROTOCOL_LIMITS.maxQuestions;
      },
      { message: "questions needs 1..64 entries" },
    ),
});

export type NoulQuestion = z.infer<typeof noulQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof scoreQuestionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>;

const probabilitySchema = z.number().min(0).max(1);

export const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: probabilitySchema,
});

export const choiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities: z.record(z.string().min(1), probabilitySchema),
    confidence: probabilitySchema,
  })
  .superRefine((answer, ctx) => {
    const count = Object.keys(answer.probabilities).length;
    if (count < 1 || count > PROTOCOL_LIMITS.maxChoiceOptions) {
      ctx.addIssue({ code: "custom", message: "choice probabilities needs 1..255 entries" });
    }
    if (!(answer.choice in answer.probabilities)) {
      ctx.addIssue({ code: "custom", message: "choice is missing from probabilities" });
    }
  });

export const scoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number().min(0),
    legend: z.record(z.string().regex(/^(0|[1-9]\d*)$/), entrySchema),
    probabilities: z.record(z.string().regex(/^(0|[1-9]\d*)$/), probabilitySchema),
    confidence: probabilitySchema,
  })
  .superRefine((answer, ctx) => {
    const legendKeys = Object.keys(answer.legend);
    const probabilityKeys = Object.keys(answer.probabilities);
    if (
      legendKeys.length < PROTOCOL_LIMITS.minScoreLevels ||
      legendKeys.length > PROTOCOL_LIMITS.maxScoreLevels
    ) {
      ctx.addIssue({ code: "custom", message: "score legend needs 2..10 entries" });
    }
    if (
      legendKeys.length !== probabilityKeys.length ||
      legendKeys.some((key) => !(key in answer.probabilities))
    ) {
      ctx.addIssue({ code: "custom", message: "score legend and probabilities must have identical keys" });
    }
    if (legendKeys.some((key, index) => key !== String(index))) {
      ctx.addIssue({ code: "custom", message: "score keys must be contiguous from zero" });
    }
    if (legendKeys.length > 0 && answer.score > legendKeys.length - 1) {
      ctx.addIssue({ code: "custom", message: "score exceeds the legend range" });
    }
  });

export const answerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const systemOneResponseSchema = z.object({
  model: z.string().min(1).max(PROTOCOL_LIMITS.maxModelChars),
  answers: z
    .record(z.string().min(1).max(PROTOCOL_LIMITS.maxQuestionNameChars), answerSchema)
    .refine((answers) => Object.keys(answers).length <= PROTOCOL_LIMITS.maxQuestions),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export type NoulAnswer = z.infer<typeof noulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

export interface GatewayError {
  error: {
    type: string;
    message: string;
    details?: JsonValue;
  };
}

export function errorBody(type: string, message: string, details?: JsonValue): GatewayError {
  return { error: { type, message, ...(details === undefined ? {} : { details }) } };
}

export function serializedBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
