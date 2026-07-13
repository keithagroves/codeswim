// Issues the short-lived session tokens handed back after login.

export interface TokenClaims {
  sub: string
  exp: number
}

export function issueToken(claims: TokenClaims): string {
  // Demo stub — a real implementation would sign with a secret (HS256).
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `demo.${body}.unsigned`
}
