import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getConnectStartConfig } from '@/lib/whatsapp/embedded-signup'

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json(getConnectStartConfig(), { status: 200 })
  } catch (error) {
    console.error('Error in GET /api/whatsapp/connect-url:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
