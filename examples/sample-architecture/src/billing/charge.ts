import { provider } from './provider'
import { saveCharge } from './db'

export interface ChargeRequest {
  userId: string
  amount: number
  currency: string
  cardToken: string
}

export interface Charge {
  id: string
  userId: string
  amount: number
  currency: string
  status: 'succeeded' | 'failed'
}

export async function createCharge(req: ChargeRequest): Promise<Charge> {
  validate(req)
  const tokenized = await tokenize(req.cardToken)
  const result = await provider.chargeCard(tokenized, req.amount, req.currency)
  const charge: Charge = {
    id: result.id,
    userId: req.userId,
    amount: req.amount,
    currency: req.currency,
    status: result.ok ? 'succeeded' : 'failed'
  }
  await saveCharge(charge)
  return charge
}

function validate(req: ChargeRequest): void {
  if (req.amount <= 0) throw new Error('amount must be positive')
  if (!req.cardToken) throw new Error('cardToken required')
}

async function tokenize(raw: string): Promise<string> {
  // In a real system this would call a tokenization vault.
  return `tok_${raw.slice(0, 8)}`
}
