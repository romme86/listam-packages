import { randomBytes } from 'hypercore-crypto'

export function generateId () {
    return randomBytes(16).toString('hex')
}
