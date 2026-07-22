/**
 * GET /auth/callback
 * Handles the redirect after a BAM clicks the magic link in their email.
 * PKCE flow: Supabase redirects here with ?code=... → we exchange it for
 * a session, then redirect to the portal.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const code = searchParams.get('code')

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet) => {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          }
        }
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Check if first login → onboarding, otherwise → dashboard
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: bam } = await supabase
          .from('bams')
          .select('first_name, street, bank_name')
          .eq('auth_user_id', user.id)
          .single()

        // If personal/banking info is missing, this is a first login → onboarding
        if (!bam || !bam.street || !bam.bank_name) {
          return NextResponse.redirect(new URL('/portal/onboarding', origin))
        }
      }
      return NextResponse.redirect(new URL('/portal/dashboard', origin))
    }
  }

  // Fallback: code missing or exchange failed
  return NextResponse.redirect(new URL('/portal/login?error=link_expired', origin))
}
