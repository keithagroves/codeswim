import { provider } from './provider'
import { saveRefund } from './db'

export interface RefundRequest {
  chargeId: string
  amount?: number
  reason?: string
}

export async function refund(req: RefundRequest): Promise<void> {
  const result = await provider.refundCharge(req.chargeId, req.amount)
  await saveRefund({
    id: result.id,
    chargeId: req.chargeId,
    amount: result.amount,
    reason: req.reason ?? 'unspecified'
  })
}
