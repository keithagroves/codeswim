// User lookup + password verification against the user database.

export interface User {
  id: string
  email: string
  passwordHash: string
}

const users: User[] = [
  { id: 'u_1', email: 'demo@example.com', passwordHash: 'hash:swordfish' }
]

export async function findUser(email: string): Promise<User | undefined> {
  return users.find((u) => u.email === email)
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  // Demo stub — a real implementation would use bcrypt/argon2.
  return passwordHash === `hash:${password}`
}
