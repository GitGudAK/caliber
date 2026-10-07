// The single gate every paid provider call goes through.
//
// A request is identified by requestHash(provider, endpoint, body), where body is the
// exact payload sent (base64 bytes included). The provider_requests table is the ledger:
//
//   completed  -> outputs already exist. Return the stored record; send() is NOT called.
//   submitted  -> a request with this exact body is in flight, or a previous run was
//                 interrupted after sending. Refuse: resending could pay twice. Resolve
//                 by hand (check the provider using providerRef, then fix the record).
//   failed     -> the previous attempt threw. Retrying is allowed: the record is moved
//                 back to 'submitted' and send() runs again. (A failure can happen after
//                 the provider accepted the job, so the caller should only retry after
//                 the user saw the error and asked to.)
//   (none)     -> record 'submitted', send(), record 'completed' with outputs.
import type { ProviderRequestRecord } from '../../shared/types.ts'
import type { Repository } from '../db/repository.ts'
import { requestHash } from '../providers/requestHash.ts'
import { errorMessage } from './runner.ts'

export interface PaidSendResult {
  providerRef: string | null
  response: unknown
  outputs: ProviderRequestRecord['outputs']
}

export interface PaidRequestOptions {
  repo: Repository
  provider: ProviderRequestRecord['provider']
  endpoint: string
  /** Exact body that will be sent; hashed (never stored). */
  body: unknown
  /** Body with base64 redacted; this is what gets stored in the ledger. */
  displayBody: unknown
  /**
   * Performs the paid call. Report the provider's id as soon as it is known via
   * onProviderRef, so an interrupted run leaves a traceable 'submitted' record.
   */
  send: (ctx: { hash: string; onProviderRef: (ref: string) => void }) => Promise<PaidSendResult>
}

export type PaidRequestResult = { cached: boolean; record: ProviderRequestRecord }

export class RequestInFlightError extends Error {
  constructor(readonly record: ProviderRequestRecord) {
    super(
      `A ${record.provider} request with this exact body (hash ${record.hash}) is already in flight or was interrupted ` +
        `(status 'submitted' since ${record.updatedAt}, provider ref ${record.providerRef ?? 'unknown'}). ` +
        `Not resending. Check the provider for that request, then update or remove the provider_requests row by hand.`,
    )
  }
}

export async function runPaidRequest(options: PaidRequestOptions): Promise<PaidRequestResult> {
  const { repo, provider, endpoint, body, displayBody, send } = options
  const hash = requestHash(provider, endpoint, body)

  const existing = repo.providerRequests.get(hash)
  if (existing?.status === 'completed') return { cached: true, record: existing }
  if (existing?.status === 'submitted') throw new RequestInFlightError(existing)

  const base = { hash, provider, endpoint, request: displayBody }
  let providerRef: string | null = null
  repo.providerRequests.put({ ...base, status: 'submitted', providerRef, response: null, outputs: {}, error: null })

  const onProviderRef = (ref: string) => {
    providerRef = ref
    repo.providerRequests.put({ ...base, status: 'submitted', providerRef, response: null, outputs: {}, error: null })
  }

  let result: PaidSendResult
  try {
    result = await send({ hash, onProviderRef })
  } catch (error) {
    repo.providerRequests.put({
      ...base,
      status: 'failed',
      providerRef,
      response: null,
      outputs: {},
      error: errorMessage(error),
    })
    throw error
  }

  const record = repo.providerRequests.put({
    ...base,
    status: 'completed',
    providerRef: result.providerRef ?? providerRef,
    response: result.response,
    outputs: result.outputs,
    error: null,
  })
  return { cached: false, record }
}
