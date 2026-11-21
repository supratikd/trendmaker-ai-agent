import { z } from "zod";

export function validateStructuredData<T>(
  value: unknown,
  schema: z.ZodType<T>,
  source: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    throw new Error(`${source} returned invalid data: ${details}`);
  }
  return result.data;
}

export function parseStructuredJson<T>(
  text: string,
  schema: z.ZodType<T>,
  source: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${source} returned invalid JSON.`, { cause: error });
  }
  return validateStructuredData(value, schema, source);
}
