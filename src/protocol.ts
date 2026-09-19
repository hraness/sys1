import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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

const instructionsSchema = z.string().max(PROTOCOL_LIMITS.maxInstructionsChars);

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema.optional(),
  criteria: z
    .object({
      true: z.string().max(PROTOCOL_LIMITS.maxCriterionChars).optional(),
      false: z.string().max(PROTOCOL_LIMITS.maxCriterionChars).optional(),
    })
    .optional(),
});

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema.optional(),
  criteria: z
    .record(
      z.string().min(1).max(PROTOCOL_LIMITS.maxOptionChars),
      z.string().max(PROTOCOL_LIMITS.maxCriterionChars).nullable(),
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
    .array(z.string().max(PROTOCOL_LIMITS.maxCriterionChars))
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
  state: jsonValueSchema,
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
