import { badRequest } from './errors.ts'

/** Parse a JSON object body or throw a 400 with the reason. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw badRequest('Request body must be JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object')
  return body as Record<string, unknown>
}

export function parseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('"name" must be a non-empty string')
  const name = value.trim()
  if (name.length > 200) throw badRequest('"name" must be at most 200 characters')
  return name
}
