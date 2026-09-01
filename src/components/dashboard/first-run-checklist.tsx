'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, MessageSquare, Users, Radio } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

/**
 * What a brand-new account sees instead of four zeros.
 *
 * A fresh dashboard is honest but useless: "0", "0", "₹0", "0", three
 * "No change vs yesterday" captions and a flat chart. It reads as broken
 * software rather than an empty one, and it says nothing about what to do
 * next — which for a first-time operator is the only question they have.
 *
 * Disappears on its own the moment all three steps are done. Deliberately
 * NOT dismissible: there is nothing to dismiss once it is satisfied, and a
 * dismissed-but-incomplete setup is how someone ends up wondering for a week
 * why no messages arrive.
 */
export function FirstRunChecklist() {
  const t = useTranslations('Dashboard.firstRun')
  const { accountId } = useAuth()
  const [state, setState] = useState<{
    whatsapp: boolean
    contacts: boolean
    messages: boolean
  } | null>(null)

  useEffect(() => {
    if (!accountId) return
    const supabase = createClient()
    let cancelled = false

    ;(async () => {
      // `head: true` — we want the counts, never the rows.
      const [config, contacts, messages] = await Promise.all([
        supabase
          .from('whatsapp_config')
          .select('status', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('status', 'connected'),
        supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId),
        // `messages` carries no account_id — RLS scopes it through
        // `conversations`, so this count is already limited to the caller's
        // account. Outbound is sender_type, not a `direction` column:
        // 'customer' is inbound, 'agent'/'bot' are ours.
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .in('sender_type', ['agent', 'bot']),
      ])

      if (cancelled) return
      setState({
        whatsapp: (config.count ?? 0) > 0,
        contacts: (contacts.count ?? 0) > 0,
        messages: (messages.count ?? 0) > 0,
      })
    })().catch(() => {
      // A failed count must not replace the dashboard with a broken banner —
      // staying null renders nothing, exactly as before this component existed.
      if (!cancelled) setState(null)
    })

    return () => {
      cancelled = true
    }
  }, [accountId])

  if (!state) return null
  if (state.whatsapp && state.contacts && state.messages) return null

  const steps = [
    {
      done: state.whatsapp,
      icon: MessageSquare,
      href: '/settings',
      label: t('connectWhatsapp'),
      hint: t('connectWhatsappHint'),
    },
    {
      done: state.contacts,
      icon: Users,
      href: '/contacts',
      label: t('addContacts'),
      hint: t('addContactsHint'),
    },
    {
      done: state.messages,
      icon: Radio,
      href: '/broadcasts/new',
      label: t('sendFirst'),
      hint: t('sendFirstHint'),
    },
  ]

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>

      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {steps.map((step) => {
          const Icon = step.done ? Check : step.icon
          return (
            <li key={step.href}>
              <Link
                href={step.href}
                aria-current={step.done ? undefined : 'step'}
                className={cn(
                  'flex h-full items-start gap-3 rounded-lg border p-3 transition-colors',
                  step.done
                    ? 'border-border bg-muted/40'
                    : 'border-border hover:border-primary/50 hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full',
                    step.done
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      step.done
                        ? 'text-muted-foreground line-through'
                        : 'text-foreground',
                    )}
                  >
                    {step.label}
                  </span>
                  {!step.done && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {step.hint}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
