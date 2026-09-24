import { describe, it, expect } from 'vitest'
import { needsForward } from './forward-webhook'

const ours = new Set(['PN_OURS'])
const ourWaba = new Set(['WABA_OURS'])
const msg = (waba: string, pn: string) => ({
  entry: [{ id: waba, changes: [{ value: { metadata: { phone_number_id: pn } } }] }],
})

describe('needsForward', () => {
  it('keeps events for our own number', () => {
    expect(needsForward(msg('WABA_OURS', 'PN_OURS'), ours, ourWaba)).toBe(false)
  })
  it('forwards events for a number we do not own', () => {
    expect(needsForward(msg('WABA_X', 'PN_PINZO'), ours, ourWaba)).toBe(true)
  })
  it('routes number-less events (templates, quality) by WABA', () => {
    const tpl = (waba: string) => ({ entry: [{ id: waba, changes: [{ value: {} }] }] })
    expect(needsForward(tpl('WABA_OURS'), ours, ourWaba)).toBe(false)
    expect(needsForward(tpl('WABA_PINZO'), ours, ourWaba)).toBe(true)
  })
  it('forwards a mixed batch whole', () => {
    const mixed = { entry: [...msg('WABA_OURS', 'PN_OURS').entry, ...msg('WABA_X', 'PN_PINZO').entry] }
    expect(needsForward(mixed, ours, ourWaba)).toBe(true)
  })
})
