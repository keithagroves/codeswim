import { findUser, verifyPassword } from './users'
import { issueToken } from './jwt'

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResult {
  token: string
  expiresAt: number
}

export async function login(req: LoginRequest): Promise<LoginResult> {
  const user = await findUser(req.email)
  if (!user) throw new Error('invalid credentials')
  const ok = await verifyPassword(req.password, user.passwordHash)
  if (!ok) throw new Error('invalid credentials')
  const expiresAt = Date.now() + 60 * 60 * 1000
  const token = issueToken({ sub: user.id, exp: Math.floor(expiresAt / 1000) })
  return { token, expiresAt }
}
