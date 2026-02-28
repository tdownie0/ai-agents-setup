import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function Auth() {
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const handleLogin = async (type: 'LOGIN' | 'SIGNUP') => {
    setLoading(true)
    const { error } = type === 'LOGIN' 
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })

    if (error) alert(error.message)
    else alert(type === 'LOGIN' ? "Logged in!" : "Check your email for confirmation!")
    setLoading(false)
  }

  return (
    <Card className="w-[350px] mx-auto mt-10">
      <CardHeader><CardTitle>Authentication</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <Input type="email" placeholder="Email" onChange={e => setEmail(e.target.value)} />
        <Input type="password" placeholder="Password" onChange={e => setPassword(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={() => handleLogin('LOGIN')} disabled={loading}>Login</Button>
          <Button variant="outline" onClick={() => handleLogin('SIGNUP')} disabled={loading}>Sign Up</Button>
        </div>
      </CardContent>
    </Card>
  )
}
