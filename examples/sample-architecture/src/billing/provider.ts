// Thin client for the external payment provider. Everything network-facing
// for billing goes through here so the rest of the subsystem stays testable.

export interface ProviderCharge {
  id: string
  status: 'succeeded' | 'failed'
}

export interface ProviderRefund {
  id: string
  amount: number
}

export const provider = {
  async chargeCard(token: string, amount: number, currency: string): Promise<ProviderCharge> {
    void token
    void currency
    // Demo stub — a real integration would call the provider's API here.
    return { id: `ch_${Date.now()}`, status: amount > 0 ? 'succeeded' : 'failed' }
  },

  async refundCharge(chargeId: string, amount?: number): Promise<ProviderRefund> {
    void chargeId
    return { id: `re_${Date.now()}`, amount: amount ?? 0 }
  }
}
