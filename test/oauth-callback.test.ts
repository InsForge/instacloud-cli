import { expect, it } from 'vitest'
import { browserOauth } from '../src/commands/auth.js'

it('renders OAuth errors as text without changing the rejected error', async () => {
  const error = '<img src=x onerror="alert(1)"> &lt;script&gt; & failure'
  let response!: Promise<Response>
  const login = browserOauth('https://test.invalid', 'github', (authorizeUrl) => {
    const authorize = new URL(authorizeUrl)
    const callback = new URL(authorize.searchParams.get('redirect')!)
    callback.searchParams.set('error', error)
    response = fetch(callback)
    return true
  })
  await expect(login).rejects.toThrow(`oauth failed: ${error}`)
  const page = await response
  expect(page.status).toBe(400)
  expect(page.headers.get('content-type')).toBe('text/html')
  const html = await page.text()
  expect(html).toContain('&lt;img src=x onerror="alert(1)"&gt; &amp;lt;script&amp;gt; &amp; failure')
  expect(html).not.toContain('<img')
})

it('still completes login for a callback with a matching state', async () => {
  let response!: Promise<Response>
  const login = browserOauth('https://test.invalid', 'github', (authorizeUrl) => {
    const authorize = new URL(authorizeUrl)
    const callback = new URL(authorize.searchParams.get('redirect')!)
    callback.searchParams.set('token', 'test-token')
    callback.searchParams.set('state', authorize.searchParams.get('state')!)
    response = fetch(callback)
    return true
  })
  await expect(login).resolves.toBe('test-token')
  const page = await response
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('✓ Login complete')
})
