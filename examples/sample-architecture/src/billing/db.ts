// Persistence for the billing subsystem. In the demo this is an in-memory
// store; the shape matches what a real repository layer would expose.

import type { Charge } from './charge'

export interface RefundRecord {
  id: string
  chargeId: string
  amount: number
  reason: string
}

const charges: Charge[] = []
const refunds: RefundRecord[] = []

export async function saveCharge(charge: Charge): Promise<void> {
  charges.push(charge)
}

export async function saveRefund(refund: RefundRecord): Promise<void> {
  refunds.push(refund)
}
